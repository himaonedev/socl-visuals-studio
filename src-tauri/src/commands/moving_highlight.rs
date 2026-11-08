//! Supervise the local moving-style renderer, including progress and process-tree cancellation.
use crate::{
    errors::{AppError, AppResult},
    media::tools::command,
};
use serde::Serialize;
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

fn python() -> String {
    crate::media::tools::subject_python()
}
pub(crate) fn worker(app: &AppHandle) -> AppResult<PathBuf> {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/segmentation/moving_style.py");
    let path = if dev.is_file() {
        dev
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| AppError::InvalidInput(e.to_string()))?
            .join("assets/segmentation/moving_style.py")
    };
    if path.is_file() {
        Ok(path)
    } else {
        Err(AppError::InvalidInput(
            "moving style resources are missing".into(),
        ))
    }
}
#[derive(Serialize)]
pub struct Runtime {
    ready: bool,
    reason: Option<String>,
}
#[tauri::command]
pub async fn highlight_runtime(app: AppHandle, subject: bool) -> Runtime {
    let available = worker(&app).is_ok();
    let ready = available
        && tauri::async_runtime::spawn_blocking(move || {
            command(Path::new(&python()))
                .args([
                    "-c",
                    if subject {
                        "import cv2, numpy, mediapipe"
                    } else {
                        "import cv2, numpy"
                    },
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        })
        .await
        .unwrap_or(false);
    Runtime {
        ready,
        reason: if ready {
            None
        } else {
            Some(if subject{"Local subject styles need Python, MediaPipe, NumPy and OpenCV. Set CUTVII_PYTHON to that Python executable."}else{"Moving styles need local Python with NumPy and OpenCV. Set CUTVII_PYTHON to that Python executable."}.into())
        },
    }
}
// Spawn the interpreter itself rather than a launcher/app-execution alias, so its children belong to
// the process tree being cancelled. Windows may also hold a just-killed encoder's file briefly.
fn python_executable() -> AppResult<String> {
    let result = command(Path::new(&python()))
        .args(["-c", "import sys; print(sys.executable)"])
        .output()?;
    let path = String::from_utf8_lossy(&result.stdout).trim().to_string();
    if !result.status.success() || path.is_empty() || !Path::new(&path).is_file() {
        return Err(AppError::InvalidInput(
            "could not resolve the local Python interpreter".into(),
        ));
    }
    Ok(path)
}
fn cleanup(path: &Path) {
    for _ in 0..40 {
        match std::fs::remove_file(path) {
            Ok(()) => return,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}
fn stop(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        command(Path::new("taskkill.exe"))
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok();
    }
    #[cfg(unix)]
    {
        command(Path::new("/bin/kill"))
            .args(["-KILL", "--", &format!("-{}", child.id())])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok();
    }
    child.kill().ok();
    child.wait().ok();
}
pub(crate) fn render(
    app: &AppHandle,
    script: &Path,
    out: &Path,
    request: &serde_json::Value,
    cancel: &AtomicBool,
) -> AppResult<()> {
    render_with(script, out, request, cancel, &mut |fraction| {
        app.emit(
            "highlight-progress",
            serde_json::json!({"fraction":fraction}),
        )
        .ok();
    })
}
fn render_with(
    script: &Path,
    out: &Path,
    request: &serde_json::Value,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(f64),
) -> AppResult<()> {
    let result = render_inner(script, out, request, cancel, on_progress);
    if result.is_err() {
        if let Some(layers) = request.get("layers").filter(|v| v.is_object()) {
            for (name, extension) in [("subject", "webm"), ("overlay", "png")] {
                if let Some(path) = layers.get(name).and_then(|v| v.as_str()) {
                    let path = Path::new(path);
                    cleanup(path);
                    cleanup(&path.with_file_name(format!(
                        "{}.part.{extension}",
                        path.file_stem().unwrap().to_string_lossy()
                    )));
                }
            }
        }
    }
    result
}
fn render_inner(
    script: &Path,
    out: &Path,
    request: &serde_json::Value,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(f64),
) -> AppResult<()> {
    let interpreter = python_executable()?;
    let mut cmd = command(Path::new(&interpreter));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .arg(script)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            AppError::InvalidInput(format!("could not start local moving-style runtime: {e}"))
        })?;
    let partial = out.with_file_name(format!(
        "{}.part.mp4",
        out.file_stem().unwrap().to_string_lossy()
    ));
    let sent = (|| -> std::io::Result<()> {
        let mut input = child.stdin.take().unwrap();
        writeln!(input, "{request}")
    })();
    if let Err(error) = sent {
        stop(&mut child);
        cleanup(&partial);
        return Err(error.into());
    }
    let pipe = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let started = Instant::now();
    let mut activity = Instant::now();
    let mut failure = None;
    loop {
        if cancel.load(Ordering::Relaxed)
            || started.elapsed() > Duration::from_secs(1800)
            || activity.elapsed() > Duration::from_secs(120)
        {
            stop(&mut child);
            reader.join().ok();
            cleanup(&partial);
            cleanup(out);
            return Err(if cancel.load(Ordering::Relaxed) {
                AppError::Cancelled
            } else {
                AppError::InvalidInput("moving style processing timed out".into())
            });
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                    if let Some(fraction) = value
                        .get("fraction")
                        .and_then(|v| v.as_f64())
                        .filter(|v| v.is_finite())
                    {
                        activity = Instant::now();
                        on_progress(fraction.clamp(0.0, 1.0));
                    }
                    if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
                        failure = Some(error.to_string());
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            Err(_) => {}
        }
    }
    let status = child.wait()?;
    reader.join().ok();
    if !status.success() || !out.is_file() {
        cleanup(&partial);
        return Err(AppError::InvalidInput(failure.unwrap_or_else(|| {
            "moving style render failed; check the local Python runtime".into()
        })));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn moving_highlight_cancel_stops_worker_and_cleans_partial_video() {
        use crate::media::tools::{FFMPEG_ENV, locate_tool};
        let Ok(ffmpeg) = locate_tool("ffmpeg", FFMPEG_ENV) else {
            eprintln!("SKIPPED: FFmpeg unavailable");
            return;
        };
        if !command(Path::new(&python()))
            .args(["-c", "import cv2, numpy"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
        {
            eprintln!("SKIPPED: local Python/NumPy/OpenCV runtime unavailable");
            return;
        }
        let dir = std::env::temp_dir().join(format!("cutvii-moving-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.mp4");
        let out = dir.join("never.mp4");
        assert!(
            command(&ffmpeg)
                .args([
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=blue:s=180x320:r=12:d=20",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    "-pix_fmt",
                    "yuv420p"
                ])
                .arg(&source)
                .status()
                .unwrap()
                .success()
        );
        let settings:crate::media::freeze_highlight::Settings=serde_json::from_value(serde_json::json!({
            "playback":"moving","style":"mono","color":"#FFFFFF","darkColor":"#000000","opacity":1,"spacing":6,"intensity":0.8,"audio":"none","audioStrength":0.4
        })).unwrap();
        let request = serde_json::json!({"source":source,"output":out,"ffmpeg":ffmpeg,"start":0,"sourceSeconds":20,"seconds":20,"speed":1,"fps":30,"width":180,"height":320,"settings":settings});
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets/segmentation/moving_style.py");
        let cancel = AtomicBool::new(false);
        let mut ticks = 0;
        let result = render_with(&script, &out, &request, &cancel, &mut |_| {
            ticks += 1;
            cancel.store(true, Ordering::Relaxed);
        });
        assert!(matches!(result, Err(AppError::Cancelled)), "{result:?}");
        assert!(ticks >= 1);
        assert!(!out.exists());
        assert!(!dir.join("never.part.mp4").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn highlight_cancel_cleans_every_editable_layer_output() {
        if python_executable().is_err() {
            eprintln!("SKIPPED: Python unavailable");
            return;
        }
        let dir = std::env::temp_dir().join(format!("cutvii-layer-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("worker.py");
        std::fs::write(
            &script,
            r#"import json,sys,time
from pathlib import Path
job=json.loads(sys.stdin.readline())
for name,path in job['layers'].items():
 p=Path(path);p.write_bytes(b'pending');p.with_name(p.stem+'.part'+p.suffix).write_bytes(b'pending')
print(json.dumps({'fraction':.1}),flush=True)
time.sleep(30)
"#,
        )
        .unwrap();
        let out = dir.join("base.mp4");
        let subject = dir.join("subject.webm");
        let overlay = dir.join("image.png");
        let request = serde_json::json!({"layers":{"subject":subject,"overlay":overlay}});
        let cancel = AtomicBool::new(false);
        let result = render_with(&script, &out, &request, &cancel, &mut |_| {
            cancel.store(true, Ordering::Relaxed);
        });
        assert!(matches!(result, Err(AppError::Cancelled)), "{result:?}");
        for name in [
            "subject.webm",
            "subject.part.webm",
            "image.png",
            "image.part.png",
        ] {
            assert!(!dir.join(name).exists(), "{name}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
