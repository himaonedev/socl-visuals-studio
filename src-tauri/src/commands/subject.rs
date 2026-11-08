//! Local MediaPipe worker for subject cut-outs and subject-aware background blur.
use super::ai::AiJob;
use super::clip_tools::{allowed_source, derived_key};
use crate::errors::{AppError, AppResult};
use crate::media::ffmpeg::FfmpegBackend;
use crate::media::tools::{FFMPEG_ENV, command, locate_tool};
use crate::media::{MediaBackend, MediaType};
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

fn python() -> String {
    crate::media::tools::subject_python()
}
fn worker(app: &AppHandle) -> AppResult<PathBuf> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/segmentation/worker.py");
    if dev.is_file() {
        return Ok(dev);
    }
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?
        .join("assets/segmentation/worker.py");
    if bundled.is_file() {
        Ok(bundled)
    } else {
        Err(AppError::InvalidInput(
            "subject segmentation resources are missing".into(),
        ))
    }
}

#[derive(Serialize)]
pub struct SubjectRuntime {
    ready: bool,
    reason: Option<String>,
}

#[tauri::command]
pub async fn subject_runtime(app: AppHandle) -> SubjectRuntime {
    let ready = worker(&app).is_ok()
        && tauri::async_runtime::spawn_blocking(|| {
            command(Path::new(&python()))
                .args(["-c", "import mediapipe, cv2, numpy"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
        .await
        .unwrap_or(false);
    SubjectRuntime {
        ready,
        reason: if ready {
            None
        } else {
            Some("Install Python with mediapipe, opencv-python and numpy, or set CUTVII_PYTHON to that Python executable. No media is uploaded.".into())
        },
    }
}

#[derive(Serialize)]
pub struct SubjectVideo {
    path: String,
    width: u32,
    height: u32,
    duration: f64,
    alpha: bool,
}

#[tauri::command]
pub async fn process_subject(
    app: AppHandle,
    job: State<'_, AiJob>,
    path: String,
    source_in: f64,
    source_out: f64,
    mode: String,
    blur: f64,
) -> AppResult<SubjectVideo> {
    let src = allowed_source(&app, &path)?;
    if !matches!(mode.as_str(), "remove" | "blur")
        || !blur.is_finite()
        || !(2.0..=40.0).contains(&blur)
        || !source_in.is_finite()
        || !source_out.is_finite()
        || source_in < 0.0
        || source_out <= source_in
        || source_out - source_in > 600.0
    {
        return Err(AppError::InvalidInput(
            "choose a valid subject effect and a video range up to ten minutes".into(),
        ));
    }
    let script = worker(&app)?;
    let out_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::InvalidInput(e.to_string()))?
        .join("subjects");
    std::fs::create_dir_all(&out_dir)?;
    let key = derived_key(
        &src,
        &format!("subject-v1|{mode}|{blur}|{source_in:.6}|{source_out:.6}"),
    )?;
    let out = out_dir.join(format!(
        "{key}.{}",
        if mode == "remove" { "webm" } else { "mp4" }
    ));
    let cancel = job.start()?;
    let events = app.clone();
    let scope = app.asset_protocol_scope();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let backend = FfmpegBackend::locate()?;
        let info = backend.probe(&src)?;
        if info.media_type != MediaType::Video || info.duration.is_some_and(|d| source_out > d + 0.05) {
            return Err(AppError::InvalidInput("choose a valid video clip range".into()));
        }
        let (w, h) = (info.width.unwrap_or(0), info.height.unwrap_or(0));
        if w == 0 || h == 0 { return Err(AppError::InvalidInput("source dimensions could not be read".into())); }
        let scale = (1920.0 / w.max(h) as f64).min(1.0);
        let width = ((w as f64 * scale / 2.0).round() as u32 * 2).max(2);
        let height = ((h as f64 * scale / 2.0).round() as u32 * 2).max(2);
        let fps = (info.fps_num.unwrap_or(30) as f64 / info.fps_den.unwrap_or(1).max(1) as f64).clamp(1.0, 30.0);
        if !out.is_file() {
            let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV)?;
            let mut child = command(Path::new(&python())).arg(&script).env("PYTHONIOENCODING", "utf-8")
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()
                .map_err(|e| AppError::InvalidInput(format!("could not start local Python segmentation runtime: {e}")))?;
            let request = serde_json::json!({"source":src,"output":out,"ffmpeg":ffmpeg,"start":source_in,"seconds":source_out-source_in,"width":width,"height":height,"fps":fps,"mode":mode,"blur":blur});
            let sent = (|| -> std::io::Result<()> { let mut stdin = child.stdin.take().unwrap(); writeln!(stdin, "{request}") })();
            if let Err(e) = sent { child.kill().ok(); child.wait().ok(); return Err(e.into()); }
            let pipe = child.stdout.take().unwrap();
            let (tx, rx) = std::sync::mpsc::channel();
            let reader = std::thread::spawn(move || { for line in BufReader::new(pipe).lines().map_while(Result::ok) { if tx.send(line).is_err() { break; } } });
            let started = Instant::now();
            let mut activity = Instant::now();
            let mut failure = None;
            loop {
                if cancel.load(Ordering::Relaxed) || started.elapsed() > Duration::from_secs(3600) || activity.elapsed() > Duration::from_secs(120) {
                    #[cfg(windows)] { command(Path::new("taskkill")).args(["/PID", &child.id().to_string(), "/T", "/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status().ok(); }
                    child.kill().ok(); child.wait().ok(); reader.join().ok();
                    let partial = out.with_file_name(format!("{}.part.{}", out.file_stem().unwrap().to_string_lossy(), out.extension().unwrap().to_string_lossy()));
                    std::fs::remove_file(partial).ok();
                    return Err(if cancel.load(Ordering::Relaxed) { AppError::Cancelled } else { AppError::InvalidInput("subject processing timed out".into()) });
                }
                match rx.recv_timeout(Duration::from_millis(100)) {
                    Ok(line) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                            if let Some(fraction) = value.get("fraction").and_then(|v| v.as_f64()) {
                                activity = Instant::now();
                                events.emit("subject-progress", serde_json::json!({"fraction":fraction})).ok();
                            }
                            if let Some(error) = value.get("error").and_then(|v|v.as_str()) { failure = Some(error.to_string()); }
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(_) => {}
                }
            }
            let status = child.wait()?;
            reader.join().ok();
            if !status.success() || !out.is_file() { return Err(AppError::InvalidInput(failure.unwrap_or_else(|| "subject processing failed; check the local Python dependencies".into()))); }
        }
        scope.allow_file(&out).map_err(|e| AppError::InvalidInput(e.to_string()))?;
        let made = backend.probe(&out)?;
        Ok(SubjectVideo { path:out.to_string_lossy().into_owned(), width, height, duration:made.duration.unwrap_or(source_out-source_in), alpha:mode=="remove" })
    }).await;
    job.finish();
    result.map_err(|e| AppError::InvalidInput(format!("subject processing task failed: {e}")))?
}
