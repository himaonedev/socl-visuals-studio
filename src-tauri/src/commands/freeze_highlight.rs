use super::{
    ai::AiJob,
    clip_tools::{allowed_source, derived_key},
};
use crate::{
    errors::{AppError, AppResult},
    media::{
        MediaBackend,
        ffmpeg::FfmpegBackend,
        freeze_highlight::{Settings, audio_filter, impact_filter, impact_source, stylize},
        import::{ImportedMedia, import_one},
        tools::{FFMPEG_ENV, command, locate_tool},
    },
};
use serde::{Deserialize, Serialize};
use std::{io::BufWriter, path::Path, process::Stdio};
use tauri::{AppHandle, Manager, State};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    path: String,
    time: f64,
    source_in: f64,
    source_out: f64,
    seconds: f64,
    speed: f64,
    keep_pitch: bool,
    reversed: bool,
    #[serde(default = "default_fps")]
    fps: f64,
    settings: Settings,
    clean: crate::project::AudioClean,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    image: ImportedMedia,
    audio: Option<ImportedMedia>,
    has_audio: bool,
    layers: Option<Layers>,
}

#[derive(Serialize)]
struct Layers {
    subject: ImportedMedia,
    overlay: ImportedMedia,
}

fn default_fps() -> f64 {
    30.0
}
fn checked(r: &Request) -> AppResult<()> {
    r.settings.validate()?;
    if !r.time.is_finite()
        || r.time < 0.0
        || !r.source_in.is_finite()
        || !r.source_out.is_finite()
        || r.source_in < 0.0
        || r.source_out <= r.source_in
        || !r.seconds.is_finite()
        || r.seconds < 0.2 - 1e-6
        || r.seconds
            > (if r.settings.playback == "moving" {
                120.0
            } else {
                15.0
            }) + 1e-6
        || !r.fps.is_finite()
        || r.fps <= 0.0
        || r.fps > 240.0
        || (r.settings.playback == "moving" && r.reversed)
        || !(0.1..=10.0).contains(&r.speed)
        || !r.clean.is_valid()
        || ((r.source_out - r.source_in) / r.speed - r.seconds).abs() > 0.02
    {
        return Err(AppError::InvalidInput(
            "choose a valid highlight range (Freeze: 0.2–15 s; Moving: 0.2–120 s, Forward only)"
                .into(),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_freeze_highlight(
    app: AppHandle,
    job: State<'_, AiJob>,
    request: Request,
) -> AppResult<Prepared> {
    checked(&request)?;
    let src = allowed_source(&app, &request.path)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?
        .join("freeze-highlights");
    let thumbs = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?
        .join("thumbnails");
    std::fs::create_dir_all(&dir)?;
    let background_key = if matches!(request.settings.style.as_str(), "outline" | "paper-outline")
        && request.settings.background_mode == "image"
    {
        let background = allowed_source(&app, &request.settings.background_image)?;
        derived_key(&background, "highlight-background-v1")?
    } else {
        String::new()
    };
    let key=derived_key(&src,&format!("freeze-highlight-v3-layers|{}|{background_key}",serde_json::to_string(&serde_json::json!({"time":request.time,"in":request.source_in,"out":request.source_out,"seconds":request.seconds,"speed":request.speed,"pitch":request.keep_pitch,"reverse":request.reversed,"settings":request.settings,"fps":request.fps,"clean":request.clean})).unwrap()))?;
    let layered = matches!(request.settings.style.as_str(), "outline" | "paper-outline")
        && request.settings.background_mode == "image";
    let moving = request.settings.playback == "moving" || layered;
    let subject_worker = if moving {
        Some(super::moving_highlight::worker(&app)?)
    } else if matches!(request.settings.style.as_str(), "outline" | "paper-outline") {
        let dev = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("assets/segmentation/freeze_style.py");
        let script = if dev.is_file() {
            dev
        } else {
            app.path()
                .resource_dir()
                .map_err(|e| AppError::InvalidInput(e.to_string()))?
                .join("assets/segmentation/freeze_style.py")
        };
        if !script.is_file() {
            return Err(AppError::InvalidInput(
                "subject style resources are missing".into(),
            ));
        }
        Some(script)
    } else {
        None
    };
    let cancel = job.start()?;
    let scope = app.asset_protocol_scope();
    let events = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let backend = FfmpegBackend::locate()?;
        let info = backend.probe(&src)?;
        let shape = backend.shape(&src)?;
        if !shape.has_video
            || request.time >= info.duration.unwrap_or(0.0)
            || request.source_out > info.duration.unwrap_or(0.0) + 0.05
        {
            return Err(AppError::InvalidInput(
                "the selected video range is unavailable".into(),
            ));
        }
        let scale = (1920.0
            / (info.width.unwrap_or(0).max(info.height.unwrap_or(0))).max(1) as f64)
            .min(1.0);
        let w = ((info.width.unwrap_or(0) as f64 * scale).round() as u32).max(2);
        let h = ((info.height.unwrap_or(0) as f64 * scale).round() as u32).max(2);
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV)?;
        let (w,h)=if moving {((w/2*2).max(2),(h/2*2).max(2))}else{(w,h)};
        let image = dir.join(format!("{key}.{}",if moving {"mp4"}else{"png"}));
        let subject_path = dir.join(format!("{key}-subject.webm"));
        let overlay_path = dir.join(format!("{key}-image.png"));
        if !image.is_file() || (layered && (!subject_path.is_file() || !overlay_path.is_file())) {
            if moving {
                let request=serde_json::json!({"source":src,"output":image,"ffmpeg":ffmpeg,
                    "freezeSource":request.settings.playback == "freeze",
                    "start":if request.settings.playback == "freeze" { request.time } else { request.source_in },"sourceSeconds":request.source_out-request.source_in,
                    "seconds":request.seconds,"speed":request.speed,"fps":request.fps.clamp(1.0,30.0),
                    "width":w,"height":h,"settings":request.settings,
                    "layers":if layered {Some(serde_json::json!({"subject":subject_path,"overlay":overlay_path}))} else {None}});
                super::moving_highlight::render(&events,subject_worker.as_ref().unwrap(),&image,&request,&cancel)?;
            } else {
            let frame = command(&ffmpeg)
                .args([
                    "-v",
                    "error",
                    "-nostdin",
                    "-ss",
                    &request.time.to_string(),
                    "-i",
                ])
                .arg(&src)
                .args([
                    "-frames:v",
                    "1",
                    "-an",
                    "-vf",
                    &format!("scale={w}:{h}"),
                    "-pix_fmt",
                    "rgb24",
                    "-f",
                    "rawvideo",
                    "-",
                ])
                .output()?;
            if !frame.status.success() {
                return Err(AppError::InvalidInput(
                    "could not read the freeze frame".into(),
                ));
            }
            let pixels = stylize(&frame.stdout, w, h, &request.settings)?;
            let temp = image.with_extension("part.png");
            let written = (|| -> AppResult<()> {
                let mut encoder =
                    png::Encoder::new(BufWriter::new(std::fs::File::create(&temp)?), w, h);
                encoder.set_color(png::ColorType::Rgb);
                encoder.set_depth(png::BitDepth::Eight);
                let fail =
                    |e: png::EncodingError| AppError::InvalidInput(format!("freeze image: {e}"));
                let mut writer = encoder.write_header().map_err(fail)?;
                writer.write_image_data(&pixels).map_err(fail)?;
                writer.finish().map_err(fail)?;
                Ok(())
            })();
            if let Err(e) = written {
                std::fs::remove_file(&temp).ok();
                return Err(e);
            }
            if let Some(script) = &subject_worker {
                if let Err(error) = render_subject(script, &temp, &request.settings, &cancel) {
                    std::fs::remove_file(&temp).ok();
                    return Err(error);
                }
            }
            std::fs::rename(temp, &image)?;
            }
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        let mode = &request.settings.audio;
        if matches!(mode.as_str(), "echo" | "reverb") && !shape.has_audio {
            return Err(AppError::InvalidInput(
                "this video has no audio; choose Original audio or Impact".into(),
            ));
        }
        let audio = if mode == "none" {
            None
        } else {
            let out = dir.join(format!("{key}.wav"));
            if !out.is_file() {
                let mut cmd = command(&ffmpeg);
                cmd.args(["-v", "error", "-y", "-nostdin"]);
                if mode == "impact" {
                    // A short, original synthesized accent: no downloaded or third-party sound file.
                    cmd.args([
                        "-f",
                        "lavfi",
                        "-i",
                        &impact_source(request.settings.audio_strength),
                    ]);
                } else {
                    cmd.args([
                        "-ss",
                        &request.source_in.to_string(),
                        "-t",
                        &(request.source_out - request.source_in).to_string(),
                        "-i",
                    ])
                    .arg(&src);
                }
                let chain = if mode == "impact" {
                    impact_filter(request.seconds)
                } else {
                    audio_filter(
                        &request.settings,
                        request.speed,
                        request.keep_pitch,
                        request.reversed,
                        request.seconds,
                        &request.clean,
                    )
                };
                let temp = out.with_extension("part.wav");
                let status = cmd
                    .args([
                        "-map",
                        "0:a:0",
                        "-vn",
                        "-af",
                        &chain,
                        "-ar",
                        "48000",
                        "-ac",
                        "2",
                        "-c:a",
                        "pcm_s16le",
                        "-f",
                        "wav",
                    ])
                    .arg(&temp)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()?;
                if !status.success() {
                    std::fs::remove_file(temp).ok();
                    return Err(AppError::InvalidInput(
                        "could not render Freeze Highlight audio".into(),
                    ));
                }
                std::fs::rename(temp, &out)?;
            }
            scope
                .allow_file(&out)
                .map_err(|e| AppError::InvalidInput(e.to_string()))?;
            Some(import_one(&backend, &out, &thumbs)?)
        };
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(AppError::Cancelled);
        }
        scope
            .allow_file(Path::new(&image))
            .map_err(|e| AppError::InvalidInput(e.to_string()))?;
        let layers = if layered {
            scope.allow_file(&subject_path).map_err(|e| AppError::InvalidInput(e.to_string()))?;
            scope.allow_file(&overlay_path).map_err(|e| AppError::InvalidInput(e.to_string()))?;
            Some(Layers { subject: import_one(&backend, &subject_path, &thumbs)?, overlay: import_one(&backend, &overlay_path, &thumbs)? })
        } else { None };
        Ok(Prepared {
            image: import_one(&backend, &image, &thumbs)?,
            audio,
            has_audio: shape.has_audio,
            layers,
        })
    })
    .await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("Freeze Highlight task failed: {e}")))?
}

fn render_subject(
    script: &Path,
    image: &Path,
    settings: &Settings,
    cancel: &std::sync::atomic::AtomicBool,
) -> AppResult<()> {
    use std::io::Write;
    let python = crate::media::tools::subject_python();
    let mut child = command(Path::new(&python))
        .arg(script)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            AppError::InvalidInput(format!("could not start local subject runtime: {e}"))
        })?;
    let request = serde_json::json!({"path":image,"style":settings.style,"paperColor":settings.paper_color,
        "outlineColor":settings.outline_color,"outlineWidth":settings.outline_width,"subjectZoom":settings.subject_zoom,
        "backgroundMode":settings.background_mode,"backgroundColor":settings.background_color,"backgroundImage":settings.background_image,
        "backgroundWidth":settings.background_width,"backgroundHeight":settings.background_height,
        "backgroundX":settings.background_x,"backgroundY":settings.background_y,
        "backgroundFit":settings.background_fit,"backgroundBase":settings.background_base,
        "intensity":settings.intensity,"opacity":settings.opacity});
    let sent = (|| -> std::io::Result<()> {
        let mut input = child.stdin.take().unwrap();
        writeln!(input, "{request}")
    })();
    if let Err(e) = sent {
        child.kill().ok();
        child.wait().ok();
        return Err(e.into());
    }
    let start = std::time::Instant::now();
    loop {
        if cancel.load(std::sync::atomic::Ordering::Relaxed)
            || start.elapsed() > std::time::Duration::from_secs(90)
        {
            #[cfg(windows)]
            {
                command(Path::new("taskkill.exe"))
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .ok();
            }
            child.kill().ok();
            child.wait().ok();
            return Err(if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                AppError::Cancelled
            } else {
                AppError::InvalidInput("subject style processing timed out".into())
            });
        }
        if child.try_wait()?.is_some() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let error=serde_json::from_slice::<serde_json::Value>(&output.stdout).ok().and_then(|v|v.get("error").and_then(|e|e.as_str()).map(str::to_owned))
            .unwrap_or_else(||"Subject cut-out failed. Check Python, MediaPipe, NumPy and OpenCV, or choose another frame.".into());
        return Err(AppError::InvalidInput(error));
    }
    Ok(())
}

#[cfg(test)]
mod duration_tests {
    use super::*;
    #[test]
    fn freeze_accepts_fifteen_seconds_and_keeps_moving_limit() {
        let mut r: Request = serde_json::from_value(serde_json::json!({
            "path":"test.mp4","time":2.0,"sourceIn":2.0,"sourceOut":17.0,"seconds":15.0,
            "speed":1.0,"keepPitch":true,"reversed":false,"fps":30.0,
            "clean":{"noise":0.0,"rumble":false},
            "settings":{"color":"#E9C847","darkColor":"#28262E","opacity":0.9,"spacing":6.0,"intensity":0.85,"audio":"none","audioStrength":0.45}
        })).unwrap();
        assert!(checked(&r).is_ok());
        r.seconds = 15.1;
        r.source_out = 17.1;
        assert!(checked(&r).is_err());
        r.settings.playback = "moving".into();
        r.seconds = 120.0;
        r.source_out = 122.0;
        assert!(checked(&r).is_ok());
    }
}
