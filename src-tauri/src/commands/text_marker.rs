//! Animated transparent text marks, using the existing font layout, PNG cache and FFmpeg.
use super::ai::AiJob;
use crate::{
    errors::{AppError, AppResult},
    media::{
        ffmpeg::FfmpegBackend,
        import::{ImportedMedia, import_one},
        text::{MarkerLine, TextSpec, marker_lines, text_key},
        tools::{FFMPEG_ENV, command, locate_tool},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    io::BufWriter,
    path::Path,
    process::Stdio,
    sync::atomic::Ordering,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    origin: String,
    spec: TextSpec,
    width: u32,
    height: u32,
    kind: String,
    color: String,
    opacity: f64,
    thickness: f64,
    seconds: f64,
    fps: f64,
    first_word: usize,
    last_word: usize,
}
impl Request {
    fn validate(&self) -> AppResult<()> {
        self.spec.validate()?;
        if self.origin.is_empty()
            || self.origin.len() > 512
            || !["highlighter", "strike"].contains(&self.kind.as_str())
            || self.color.len() != 7
            || !self.color.starts_with('#')
            || !self.color[1..].bytes().all(|c| c.is_ascii_hexdigit())
            || ![self.opacity, self.thickness, self.seconds, self.fps]
                .iter()
                .all(|x| x.is_finite())
            || !(0.0..=1.0).contains(&self.opacity)
            || !(0.02..=1.5).contains(&self.thickness)
            || !(1.0 / 240.0 - 1e-6..=2.05).contains(&self.seconds)
            || !(1.0..=240.0).contains(&self.fps)
            || self.first_word > self.last_word
            || self.last_word >= self.spec.content.split_whitespace().count()
        {
            return Err(AppError::InvalidInput(
                "Choose valid text mark settings and words".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    origin_key: String,
    video: ImportedMedia,
    still: ImportedMedia,
}
fn hash(value: &str) -> String {
    let mut h = DefaultHasher::new();
    value.hash(&mut h);
    format!("{:016x}", h.finish())
}
fn glyph_mask(r: &Request) -> AppResult<Option<Vec<u8>>> {
    if r.kind != "highlighter" {
        return Ok(None);
    }
    let mut plain = r.spec.clone();
    plain.backdrop = None;
    plain.shadow = None;
    plain.outline = None;
    plain.highlight = None;
    plain.color = "#FFFFFF".into();
    Ok(Some(
        crate::media::text::render(&plain, r.width, r.height)?
            .chunks_exact(4)
            .map(|p| p[3])
            .collect(),
    ))
}
fn pixels(lines: &[MarkerLine], r: &Request, progress: f32, ink: Option<&[u8]>) -> Vec<u8> {
    let (w, h) = (r.width as usize, r.height as usize);
    let mut out = vec![0_u8; w * h * 4];
    let rgb: [u8; 3] = [1, 3, 5].map(|i| u8::from_str_radix(&r.color[i..i + 2], 16).unwrap());
    let size = r.spec.font_size as f32;
    let pad = size * 0.04;
    let total: f32 = lines.iter().map(|l| l.x1 - l.x0 + pad * 2.0).sum();
    let mut remaining = total * progress.clamp(0.0, 1.0);
    for line in lines {
        let full = line.x1 - line.x0 + pad * 2.0;
        let painted = remaining.min(full).max(0.0);
        remaining -= full;
        if painted <= 0.0 {
            continue;
        }
        let x0 = line.x0 - pad;
        let x1 = x0 + painted;
        let half = (size * r.thickness as f32 * 0.5).max(0.5);
        let radius = if r.kind == "strike" {
            half.min(painted * 0.5)
        } else {
            (size * 0.045).min(half).min(painted * 0.5)
        };
        let cx = (x0 + x1) * 0.5;
        let hx = painted * 0.5;
        let a = (x0 - 1.0).floor().max(0.0) as usize;
        let b = (x1 + 1.0).ceil().min(w as f32).max(0.0) as usize;
        let top = (line.cy - half - 1.0).floor().max(0.0) as usize;
        let bottom = (line.cy + half + 1.0).ceil().min(h as f32).max(0.0) as usize;
        for y in top..bottom {
            for x in a..b {
                let dx = (x as f32 + 0.5 - cx).abs() - (hx - radius);
                let dy = (y as f32 + 0.5 - line.cy).abs() - (half - radius);
                let distance = dx.max(0.0).hypot(dy.max(0.0)) + dx.max(dy).min(0.0) - radius;
                let alpha =
                    ((0.5 - distance).clamp(0.0, 1.0) * r.opacity as f32 * 255.0).round() as u8;
                let i = (y * w + x) * 4;
                let alpha = if let Some(mask) = ink {
                    ((alpha as u16 * (255 - mask[y * w + x]) as u16) / 255) as u8
                } else {
                    alpha
                };
                if alpha > out[i + 3] {
                    out[i..i + 3].copy_from_slice(&rgb);
                    out[i + 3] = alpha;
                }
            }
        }
    }
    out
}
fn write_png(path: &Path, r: &Request, data: &[u8]) -> AppResult<()> {
    let temporary = path.with_extension("part");
    let result = (|| -> AppResult<()> {
        let mut encoder = png::Encoder::new(
            BufWriter::new(std::fs::File::create(&temporary)?),
            r.width,
            r.height,
        );
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let error = |e: png::EncodingError| AppError::InvalidInput(format!("text marker PNG: {e}"));
        let mut writer = encoder.write_header().map_err(error)?;
        writer.write_image_data(data).map_err(error)?;
        writer.finish().map_err(error)?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        std::fs::remove_file(temporary).ok();
    }
    result
}
fn encode_marker(
    dir: &Path,
    frames: usize,
    fps: f64,
    cancel: &std::sync::atomic::AtomicBool,
) -> AppResult<std::path::PathBuf> {
    let out = dir.join("animation.webm");
    let partial = dir.join("animation.part.webm");
    if !out.is_file() {
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV)?;
        let mut child = command(&ffmpeg)
            .args([
                "-v",
                "error",
                "-nostdin",
                "-y",
                "-filter_threads",
                "1",
                "-framerate",
                &fps.to_string(),
                "-start_number",
                "1",
                "-i",
            ])
            .arg(dir.join("frame-%04d.png"))
            .args([
                "-frames:v",
                &frames.to_string(),
                "-an",
                "-c:v",
                "libvpx-vp9",
                "-pix_fmt",
                "yuva420p",
                "-auto-alt-ref",
                "0",
                "-b:v",
                "0",
                "-crf",
                "18",
                "-deadline",
                "realtime",
                "-cpu-used",
                "6",
                "-row-mt",
                "1",
                "-threads",
                "2",
            ])
            .arg(&partial)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        let began = std::time::Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) || began.elapsed() > Duration::from_secs(120) {
                child.kill().ok();
                child.wait().ok();
                std::fs::remove_file(&partial).ok();
                return Err(if cancel.load(Ordering::Relaxed) {
                    AppError::Cancelled
                } else {
                    AppError::InvalidInput("Text mark encoding timed out".into())
                });
            }
            if let Some(status) = child.try_wait()? {
                if !status.success() {
                    std::fs::remove_file(&partial).ok();
                    return Err(AppError::InvalidInput(
                        "Could not encode the transparent text mark".into(),
                    ));
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        std::fs::rename(&partial, &out)?;
    }
    if cancel.load(Ordering::Relaxed) {
        return Err(AppError::Cancelled);
    }
    Ok(out)
}

#[tauri::command]
pub async fn prepare_text_marker(
    app: AppHandle,
    job: State<'_, AiJob>,
    request: Request,
) -> AppResult<Prepared> {
    request.validate()?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?;
    let thumbs = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?
        .join("thumbnails");
    let cancel = job.start()?;
    let scope = app.asset_protocol_scope();
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let r = request;
        let lines = marker_lines(&r.spec, r.width, r.height, r.first_word, r.last_word)?;
        let ink = glyph_mask(&r)?;
        let origin_key = hash(&r.origin);
        let sequence = hash(&format!(
            "marker-v2|{}|{}",
            text_key(&r.spec, r.width, r.height),
            serde_json::to_string(&r).unwrap_or_default()
        ));
        let dir = data
            .join("text-markers")
            .join(&origin_key)
            .join(&r.kind)
            .join(sequence);
        std::fs::create_dir_all(&dir)?;
        let fps = r.fps.min(30.0);
        let frames = ((r.seconds * fps - 1e-8).ceil() as usize).clamp(1, 62);
        for i in 1..=frames {
            if cancel.load(Ordering::Relaxed) {
                return Err(AppError::Cancelled);
            }
            let path = dir.join(format!("frame-{i:04}.png"));
            if !path.is_file() {
                write_png(
                    &path,
                    &r,
                    &pixels(&lines, &r, i as f32 / frames as f32, ink.as_deref()),
                )?;
            }
            events
                .emit(
                    "text-marker-progress",
                    serde_json::json!({"fraction":i as f64/frames as f64*0.7}),
                )
                .ok();
        }
        let out = encode_marker(&dir, frames, fps, &cancel)?;
        let still = dir.join(format!("frame-{frames:04}.png"));
        scope
            .allow_file(&out)
            .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        scope
            .allow_file(&still)
            .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        let backend = FfmpegBackend::locate()?;
        events
            .emit("text-marker-progress", serde_json::json!({"fraction":1.0}))
            .ok();
        Ok(Prepared {
            origin_key,
            video: import_one(&backend, &out, &thumbs)?,
            still: import_one(&backend, &still, &thumbs)?,
        })
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("Text marker task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        serde_json::from_value(serde_json::json!({"origin":"project:clip","spec":{"content":"one two three\nfour five","fontSize":32,"color":"#FFFFFF","x":0.5,"y":0.5},"width":640,"height":360,"kind":"highlighter","color":"#FFDD33","opacity":0.4,"thickness":0.7,"seconds":0.6,"fps":30,"firstWord":0,"lastWord":4})).unwrap()
    }
    #[test]
    fn marker_video_encodes_transparency_and_keeps_highlighter_off_glyphs() {
        use crate::media::MediaBackend;
        let Ok(ffmpeg) = locate_tool("ffmpeg", FFMPEG_ENV) else {
            eprintln!("SKIPPED: FFmpeg unavailable");
            return;
        };
        let r = request();
        let lines = marker_lines(&r.spec, r.width, r.height, 0, 4).unwrap();
        let ink = glyph_mask(&r).unwrap().unwrap();
        let full = pixels(&lines, &r, 1.0, Some(&ink));
        for (i, alpha) in ink.iter().enumerate() {
            if *alpha == 255 {
                assert_eq!(full[i * 4 + 3], 0);
            }
        }
        let dir = std::env::temp_dir().join(format!(
            "cutvii-marker-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        for i in 1..=3 {
            write_png(
                &dir.join(format!("frame-{i:04}.png")),
                &r,
                &pixels(&lines, &r, i as f32 / 3.0, Some(&ink)),
            )
            .unwrap();
        }
        let out = encode_marker(&dir, 3, 10.0, &std::sync::atomic::AtomicBool::new(false)).unwrap();
        let info = FfmpegBackend::locate().unwrap().probe(&out).unwrap();
        assert!(info.duration.unwrap() >= 0.29);
        assert!(info.alpha);
        let decoded = command(&ffmpeg)
            .args(["-v", "error", "-c:v", "libvpx-vp9", "-i"])
            .arg(&out)
            .args([
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "pipe:1",
            ])
            .output()
            .unwrap();
        assert!(decoded.status.success());
        assert_eq!(
            decoded.stdout.len(),
            r.width as usize * r.height as usize * 4
        );
        assert!(decoded.stdout.chunks_exact(4).any(|p| p[3] == 0));
        assert!(decoded.stdout.chunks_exact(4).any(|p| p[3] > 0));
        for i in 1..=3 {
            std::fs::remove_file(dir.join(format!("frame-{i:04}.png"))).unwrap();
        }
        std::fs::remove_file(out).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn marker_sweep_advances_without_redrawing_or_covering_the_whole_canvas() {
        let r = request();
        r.validate().unwrap();
        let lines = marker_lines(&r.spec, r.width, r.height, 0, 4).unwrap();
        assert_eq!(lines.len(), 2);
        let count = |p: f32| {
            pixels(&lines, &r, p, None)
                .chunks_exact(4)
                .filter(|p| p[3] > 0)
                .count()
        };
        assert_eq!(count(0.0), 0);
        assert!(count(0.25) > 0);
        assert!(count(0.25) < count(1.0));
        assert!(count(1.0) < 640 * 360 / 4);
        let selected = marker_lines(&r.spec, r.width, r.height, 1, 1).unwrap();
        assert_eq!(selected.len(), 1);
        assert!(selected[0].x1 - selected[0].x0 < lines[0].x1 - lines[0].x0);
        let mut strike = r.clone();
        strike.kind = "strike".into();
        strike.thickness = 0.08;
        assert!(
            pixels(&lines, &strike, 1.0, None)
                .chunks_exact(4)
                .filter(|p| p[3] > 0)
                .count()
                < count(1.0)
        );
    }
    #[test]
    fn invalid_marks_are_rejected() {
        let mut r = request();
        r.color = "#bad".into();
        assert!(r.validate().is_err());
        r = request();
        r.last_word = 8;
        assert!(r.validate().is_err());
        r = request();
        r.seconds = f64::NAN;
        assert!(r.validate().is_err());
    }
}
