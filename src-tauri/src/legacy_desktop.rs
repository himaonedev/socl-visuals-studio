//! File reveal, output folders and preview thumbnails for the original SOCL UI.
use crate::media::tools::{FFMPEG_ENV, FFPROBE_ENV, command, locate_tool};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

pub const CHANNELS: &[&str] = &[
    "history-thumb",
    "get-bin-paths",
    "open-output",
    "reveal-clip",
    "open-download-page",
];
static NEXT_THUMB: AtomicU64 = AtomicU64::new(1);

pub fn invoke(app: &AppHandle, channel: &str, payload: &Value) -> Result<Value, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    match channel {
        "get-bin-paths" => Ok(json!({
            "ffmpeg": locate_tool("ffmpeg", FFMPEG_ENV).ok(),
            "ffprobe": locate_tool("ffprobe", FFPROBE_ENV).ok(),
            "ytdlp": locate_tool("yt-dlp", "SOCL_YTDLP").ok(),
            "deno": locate_tool("deno", "SOCL_DENO").ok(),
        })),
        "history-thumb" => Ok(payload
            .as_str()
            .map(Path::new)
            .and_then(thumbnail)
            .map_or(Value::Null, |path| json!(path))),
        "open-download-page" => {
            crate::commands::support::open_in_browser("https://socialvisuals.xyz/download")
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "open-output" => {
            let settings = crate::legacy_settings::read(&data)?;
            let default = home.join("Movies/SOCL Visuals Studio");
            let selected = output_folder(&home, &default, &settings, payload.as_str());
            fs::create_dir_all(&selected).map_err(|error| error.to_string())?;
            open_path(&selected, false)?;
            Ok(json!(selected))
        }
        "reveal-clip" => {
            let settings = crate::legacy_settings::read(&data)?;
            let Some(source) = payload["file"]
                .as_str()
                .map(Path::new)
                .filter(|path| path.is_file())
            else {
                return Ok(json!({"ok":false}));
            };
            let path = delivered_clip(&home, &settings, source, payload["clipIndex"].as_u64());
            open_path(&path, true)?;
            Ok(json!({"ok":true,"path":path}))
        }
        _ => Err(format!("Unknown desktop operation: {channel}")),
    }
}

fn open_path(path: &Path, reveal: bool) -> Result<(), String> {
    if !path.is_absolute() || !path.exists() {
        return Err("The selected file or folder does not exist".into());
    }
    #[cfg(windows)]
    {
        let mut child = command(Path::new("explorer.exe"));
        if reveal {
            child.arg(format!("/select,{}", path.display()));
        } else {
            child.arg(path);
        }
        child.spawn().map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let target = if reveal {
            path.parent().ok_or("Path has no parent")?
        } else {
            path
        };
        command(Path::new(if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        }))
        .arg(target)
        .spawn()
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn session_root(folder: &Path) -> &Path {
    if folder
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            [
                "raw",
                "subtitle",
                "edited",
                "efek",
                "crop-biasa",
                "crop-gaming",
                "hasil",
                "burn-edited",
                "_clean",
            ]
            .contains(&name)
        })
    {
        folder.parent().unwrap_or(folder)
    } else {
        folder
    }
}

fn export_base(home: &Path, settings: &Value) -> Option<PathBuf> {
    let text = settings["exportPath"].as_str().unwrap_or("").trim();
    if text.is_empty() {
        return None;
    }
    let path = if text == "~" {
        home.to_path_buf()
    } else if text.starts_with("~/") || text.starts_with("~\\") {
        home.join(&text[2..])
    } else {
        PathBuf::from(text)
    };
    path.is_absolute().then_some(path)
}

fn hasil_dir(home: &Path, settings: &Value, session: &Path) -> Option<PathBuf> {
    let base = export_base(home, settings).or_else(|| session.parent().map(Path::to_path_buf))?;
    Some(base.join(session.file_name()?).join("hasil"))
}

fn output_folder(
    home: &Path,
    default: &Path,
    settings: &Value,
    requested: Option<&str>,
) -> PathBuf {
    if let Some(folder) = requested
        .map(Path::new)
        .filter(|path| path.is_absolute() && path.is_dir())
    {
        if let Some(hasil) = hasil_dir(home, settings, session_root(folder)) {
            let has_video = fs::read_dir(&hasil)
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .any(|entry| {
                    entry
                        .path()
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| {
                            ["mp4", "mov", "webm", "mkv"].contains(&ext.to_lowercase().as_str())
                        })
                });
            if has_video {
                return hasil;
            }
        }
        return folder.to_path_buf();
    }
    export_base(home, settings).unwrap_or_else(|| default.to_path_buf())
}

fn delivered_clip(home: &Path, settings: &Value, source: &Path, index: Option<u64>) -> PathBuf {
    if let Some(index) = index.and_then(|value| value.checked_add(1)) {
        if let Some(folder) = source
            .parent()
            .and_then(|folder| hasil_dir(home, settings, session_root(folder)))
        {
            let prefix = format!("{index:02}-");
            let extension = source
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase();
            let best = fs::read_dir(folder)
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter(|entry| {
                    entry.file_name().to_string_lossy().starts_with(&prefix)
                        && entry
                            .path()
                            .extension()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase()
                            == extension
                })
                .filter_map(|entry| {
                    entry
                        .metadata()
                        .ok()
                        .filter(|meta| meta.is_file())
                        .and_then(|meta| meta.modified().ok())
                        .map(|time| (time, entry.path()))
                })
                .max_by_key(|(time, _)| *time)
                .map(|(_, path)| path);
            if let Some(best) = best {
                return best;
            }
        }
    }
    source.to_path_buf()
}

fn thumbnail(source: &Path) -> Option<PathBuf> {
    if !source.is_absolute() || !source.is_file() {
        return None;
    }
    let root = source.parent()?.join(".thumbs");
    let output = root.join(format!("{}.jpg", source.file_stem()?.to_string_lossy()));
    if fs::metadata(&output).is_ok_and(|meta| meta.len() > 0) {
        return Some(output);
    }
    fs::create_dir_all(&root).ok()?;
    // Match the original 15-second budget and reap the child on timeout.
    let temp = root.join(format!(
        "{}.{}-{}.tmp.jpg",
        source.file_stem()?.to_string_lossy(),
        std::process::id(),
        NEXT_THUMB.fetch_add(1, Ordering::Relaxed)
    ));
    let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV).ok()?;
    let mut child = command(&ffmpeg)
        .args(["-y", "-v", "error", "-ss", "0.5", "-i"])
        .arg(source)
        .args(["-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4"])
        .arg(&temp)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(15);
    let success = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    if success
        && fs::metadata(&temp).is_ok_and(|meta| meta.len() > 0)
        && fs::rename(&temp, &output).is_ok()
    {
        Some(output)
    } else {
        let _ = fs::remove_file(temp);
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_and_reveal_follow_custom_export_structure() {
        let root = std::env::temp_dir().join(format!("socl-desktop-test-{}", std::process::id()));
        let source = root.join("work/socl-2026-11-01T10-00-00/raw/clip.mp4");
        let delivered = root.join("export/socl-2026-11-01T10-00-00/hasil/01-final.mp4");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::create_dir_all(delivered.parent().unwrap()).unwrap();
        fs::write(&source, b"source").unwrap();
        fs::write(&delivered, b"delivered").unwrap();
        let settings = json!({"exportPath":root.join("export")});
        assert_eq!(
            delivered_clip(&root, &settings, &source, Some(0)),
            delivered
        );
        assert_eq!(
            output_folder(&root, &root, &settings, source.parent().unwrap().to_str()),
            delivered.parent().unwrap()
        );
        assert_eq!(
            export_base(&root, &json!({"exportPath":"~/Videos"})),
            Some(root.join("Videos"))
        );
        fs::remove_file(&source).unwrap();
        fs::remove_file(&delivered).unwrap();
        for path in [
            source.parent().unwrap().to_path_buf(),
            source.parent().unwrap().parent().unwrap().to_path_buf(),
            root.join("work"),
            delivered.parent().unwrap().to_path_buf(),
            delivered.parent().unwrap().parent().unwrap().to_path_buf(),
            root.join("export"),
            root.clone(),
        ] {
            fs::remove_dir(path).unwrap();
        }
    }
}
