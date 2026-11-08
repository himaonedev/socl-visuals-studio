//! Native bounded-memory facecam templates; no browser renderer or additional packages.
use super::{
    ai::AiJob,
    clip_tools::{allowed_source, derived_key},
};
use crate::{
    errors::{AppError, AppResult},
    media::{
        MediaBackend, MediaType,
        ffmpeg::FfmpegBackend,
        import::{ImportedMedia, import_one},
        tools::{FFMPEG_ENV, locate_tool},
    },
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    style: String,
    strength: f64,
    zoom: f64,
    x: f64,
    y: f64,
    #[serde(default = "default_frame_center")]
    frame_x: f64,
    #[serde(default = "default_frame_center")]
    frame_y: f64,
    #[serde(default = "default_frame_zoom")]
    frame_zoom: f64,
    #[serde(default = "default_entry")]
    entry: String,
    #[serde(default = "default_entry_direction")]
    entry_direction: String,
    #[serde(default = "default_entry_duration")]
    entry_duration: f64,
    #[serde(default)]
    entry_delay: f64,
    accent: String,
    text_color: String,
    background: String,
    parallax: bool,
    from_value: f64,
    to_value: f64,
    graph: bool,
}
fn default_frame_center() -> f64 {
    0.5
}
fn default_frame_zoom() -> f64 {
    1.0
}
fn default_entry() -> String { "none".into() }
fn default_entry_direction() -> String { "left".into() }
fn default_entry_duration() -> f64 { 0.45 }
impl Settings {
    fn validate(&self) -> AppResult<()> {
        let colour = |v: &str| {
            v.len() == 7 && v.starts_with('#') && v[1..].bytes().all(|c| c.is_ascii_hexdigit())
        };
        if ![
            "lean-in",
            "slow-push",
            "text-behind",
            "backdrop-word",
            "spotlight",
            "name-tag",
            "silhouette-intro",
            "bottom-fade",
            "glass-card",
            "freeze-sticker",
        ]
        .contains(&self.style.as_str())
            || ![
                self.strength,
                self.zoom,
                self.x,
                self.y,
                self.frame_x,
                self.frame_y,
                self.frame_zoom,
                self.entry_duration,
                self.entry_delay,
                self.from_value,
                self.to_value,
            ]
            .iter()
            .all(|v| v.is_finite())
            || !(0.0..=1.0).contains(&self.strength)
            || !(1.0..=1.6).contains(&self.zoom)
            || !(0.0..=1.0).contains(&self.x)
            || !(0.0..=1.0).contains(&self.y)
            || !(0.0..=1.0).contains(&self.frame_x)
            || !(0.0..=1.0).contains(&self.frame_y)
            || !(0.5..=2.5).contains(&self.frame_zoom)
            || !["none", "slide", "pop", "slide-pop"].contains(&self.entry.as_str())
            || !["left", "right", "top", "bottom"].contains(&self.entry_direction.as_str())
            || !(0.1..=3.0).contains(&self.entry_duration)
            || !(0.0..=5.0).contains(&self.entry_delay)
            || self.from_value.abs() > 1e9
            || self.to_value.abs() > 1e9
            || !colour(&self.accent)
            || !colour(&self.text_color)
            || !colour(&self.background)
        {
            return Err(AppError::InvalidInput(
                "Choose valid facecam style settings".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    path: String,
    source_in: f64,
    source_out: f64,
    seconds: f64,
    speed: f64,
    fps: f64,
    plates: Vec<String>,
    settings: Settings,
}
impl Request {
    fn validate(&self) -> AppResult<()> {
        self.settings.validate()?;
        if ![
            self.source_in,
            self.source_out,
            self.seconds,
            self.speed,
            self.fps,
        ]
        .iter()
        .all(|v| v.is_finite())
            || self.source_in < 0.0
            || self.source_out <= self.source_in
            || !(0.2 - 1e-6..=30.05).contains(&self.seconds)
            || !(0.1..=10.0).contains(&self.speed)
            || !(1.0..=240.0).contains(&self.fps)
            || ((self.source_out - self.source_in) / self.speed - self.seconds).abs() > 0.025
            || self.plates.len() > 48
            || (self.settings.entry != "none" && self.settings.entry_delay + self.settings.entry_duration > self.seconds + 1e-6)
        {
            return Err(AppError::InvalidInput(
                "Choose a forward facecam range of 0.2–30 seconds".into(),
            ));
        }
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    image: ImportedMedia,
    audio: Option<ImportedMedia>,
    has_audio: bool,
}
fn worker(app: &AppHandle) -> AppResult<PathBuf> {
    let dev =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/segmentation/facecam_style.py");
    let path = if dev.is_file() {
        dev
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| AppError::InvalidInput(e.to_string()))?
            .join("assets/segmentation/facecam_style.py")
    };
    if !path.is_file() {
        return Err(AppError::InvalidInput(
            "Facecam style resources are missing".into(),
        ));
    }
    Ok(path)
}
#[tauri::command]
pub async fn prepare_facecam_style(
    app: AppHandle,
    job: State<'_, AiJob>,
    request: Request,
) -> AppResult<Prepared> {
    request.validate()?;
    let source = allowed_source(&app, &request.path)?;
    // Empty entries stand for spaces between separately animated glyphs.
    let mut plates = Vec::new();
    let mut plate_keys = Vec::new();
    for plate in &request.plates {
        if plate.is_empty() {
            plates.push(String::new());
            plate_keys.push(String::new());
            continue;
        }
        let path = allowed_source(&app, plate)?;
        if path.extension().and_then(|x| x.to_str()) != Some("png") {
            return Err(AppError::InvalidInput(
                "Facecam text must use native PNG plates".into(),
            ));
        }
        plate_keys.push(derived_key(&path, "facecam-text-v1")?);
        plates.push(path.to_string_lossy().into_owned());
    }
    let script = worker(&app)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?
        .join("facecam-styles");
    let thumbs = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?
        .join("thumbnails");
    std::fs::create_dir_all(&dir)?;
    let key = derived_key(
        &source,
        &format!(
            "facecam-v2-overlay-entry|{}|{}",
            serde_json::to_string(&request).unwrap_or_default(),
            plate_keys.join("|")
        ),
    )?;
    let output = dir.join(format!("{key}.mp4"));
    let cancel = job.start()?;
    let events = app.clone();
    let scope = app.asset_protocol_scope();
    let result=tauri::async_runtime::spawn_blocking(move || {
        let backend=FfmpegBackend::locate()?;
        let info=backend.probe(&source)?;
        let shape=backend.shape(&source)?;
        if info.media_type!=MediaType::Video || request.source_out>info.duration.unwrap_or(0.0)+0.05 || !shape.has_video {
            return Err(AppError::InvalidInput("The selected video range is unavailable".into()));
        }
        let (w,h)=(info.width.unwrap_or(0),info.height.unwrap_or(0));
        if w==0 || h==0 {return Err(AppError::InvalidInput("The source dimensions are unavailable".into()));}
        let scale=(1920.0/w.max(h) as f64).min(1.0);
        let width=((w as f64*scale).round() as u32/2*2).max(2);
        let height=((h as f64*scale).round() as u32/2*2).max(2);
        for path in plates.iter().filter(|p|!p.is_empty()) {
            let plate=backend.probe(Path::new(path))?;
            if plate.media_type!=MediaType::Image || plate.width.unwrap_or(0)>1920 || plate.height.unwrap_or(0)>1920 {
                return Err(AppError::InvalidInput("The facecam text plate is too large".into()));
            }
        }
        if !output.is_file() {
            let ffmpeg=locate_tool("ffmpeg",FFMPEG_ENV)?;
            let render=serde_json::json!({"source":source,"output":output,"ffmpeg":ffmpeg,"start":request.source_in,
                "sourceSeconds":request.source_out-request.source_in,"seconds":request.seconds,"speed":request.speed,
                "fps":request.fps.clamp(1.0,30.0),"width":width,"height":height,"plates":plates,"settings":request.settings});
            super::moving_highlight::render(&events,&script,&output,&render,&cancel)?;
        }
        if cancel.load(std::sync::atomic::Ordering::Relaxed) { return Err(AppError::Cancelled); }
        scope.allow_file(&output).map_err(|e|AppError::InvalidInput(e.to_string()))?;
        Ok(Prepared{image:import_one(&backend,&output,&thumbs)?,audio:None,has_audio:shape.has_audio})
    }).await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("Facecam render task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> Settings {
        serde_json::from_value(serde_json::json!({"style":"lean-in","strength":0.8,"zoom":1.3,"x":0.5,"y":0.6,"accent":"#E5733A","textColor":"#FFFFFF","background":"#121218","parallax":false,"fromValue":0,"toValue":100,"graph":false})).unwrap()
    }
    #[test]
    fn validates_all_templates_and_rejects_invalid_parameters() {
        for style in [
            "lean-in",
            "slow-push",
            "text-behind",
            "backdrop-word",
            "spotlight",
            "name-tag",
            "silhouette-intro",
            "bottom-fade",
            "glass-card",
            "freeze-sticker",
        ] {
            let mut s = settings();
            s.style = style.into();
            assert!(s.validate().is_ok());
        }
        let mut s = settings();
        s.x = f64::NAN;
        assert!(s.validate().is_err());
        let mut s = settings();
        s.style = "orbit".into();
        assert!(s.validate().is_err());
        let mut s = settings();
        s.accent = "#bad".into();
        assert!(s.validate().is_err());
    }
    #[test]
    fn rejects_unbounded_ranges_and_inconsistent_speed() {
        let mut r = Request {
            path: "test.mp4".into(),
            source_in: 2.,
            source_out: 8.,
            seconds: 3.,
            speed: 2.,
            fps: 30.,
            plates: vec![],
            settings: settings(),
        };
        assert!(r.validate().is_ok());
        r.seconds = 4.;
        assert!(r.validate().is_err());
        r.seconds = 31.;
        r.source_out = 64.;
        assert!(r.validate().is_err());
    }
}
