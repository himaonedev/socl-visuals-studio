//! Rust implementations of the original SOCL IPC contracts.
//! Keep response shapes stable while the clipping UI is migrated separately.
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

pub const CHANNELS: &[&str] = &[
    "pick-video",
    "pick-subtitle",
    "pick-folder",
    "get-settings",
    "set-settings",
    "secrets:available",
    "secrets:diagnose",
    "clip:saveMeta",
    "wm:saveAsset",
    "wm:deleteAsset",
    "list-history",
    "set-cookies",
    "history-thumb",
    "get-bin-paths",
    "open-output",
    "reveal-clip",
    "open-download-page",
    "fonts:metrics",
    "whisper:status",
    "whisper:ensure",
    "whisper:remove",
];

pub async fn invoke(
    app: tauri::AppHandle,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if crate::legacy_whisper::CHANNELS.contains(&channel.as_str()) {
            return crate::legacy_whisper::invoke(&app,&channel,args.first().unwrap_or(&Value::Null));
        }
        if channel == "fonts:metrics" {
            return Ok(crate::legacy_fonts::metrics(
                args.first().unwrap_or(&Value::Null),
            ));
        }
        if crate::legacy_desktop::CHANNELS.contains(&channel.as_str()) {
            return crate::legacy_desktop::invoke(
                &app,
                &channel,
                args.first().unwrap_or(&Value::Null),
            );
        }
        if crate::legacy_settings::CHANNELS.contains(&channel.as_str()) {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            return crate::legacy_settings::invoke(
                &dir,
                &channel,
                args.first().unwrap_or(&Value::Null),
            );
        }
        if crate::legacy_files::CHANNELS.contains(&channel.as_str()) {
            let data = app
                .path()
                .app_data_dir()
                .map_err(|error| error.to_string())?;
            let output = app
                .path()
                .home_dir()
                .map_err(|error| error.to_string())?
                .join("Movies/SOCL Visuals Studio");
            let mut payload = args.first().cloned().unwrap_or(Value::Null);
            if channel == "set-cookies"
                && payload["clear"] != true
                && payload["filePath"].as_str().is_none()
            {
                let Some(file) = app
                    .dialog()
                    .file()
                    .add_filter("Cookies", &["txt"])
                    .blocking_pick_file()
                else {
                    return Ok(json!({"ok":false}));
                };
                let path = file.into_path().map_err(|error| error.to_string())?;
                payload = json!({"filePath":path});
            }
            return crate::legacy_files::invoke(&data, &output, &channel, &payload);
        }
        let dialog = app.dialog().file();
        let selected = match channel.as_str() {
            "pick-video" => dialog
                .add_filter(
                    "Media",
                    &[
                        "mp4", "mov", "mkv", "webm", "m4v", "jpg", "jpeg", "png", "webp",
                    ],
                )
                .blocking_pick_file(),
            "pick-subtitle" => dialog
                .add_filter("Transcript", &["srt", "vtt", "txt"])
                .blocking_pick_file(),
            "pick-folder" => dialog.blocking_pick_folder(),
            _ => return Err(format!("Unsupported Rust service: {channel}")),
        };
        let Some(selected) = selected else {
            return Ok(Value::Null);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        if channel == "pick-folder" {
            return Ok(folder_result(&path));
        }
        Ok(json!(path.to_string_lossy()))
    })
    .await
    .map_err(|error| error.to_string())?
}

static NEXT_PROBE: AtomicU64 = AtomicU64::new(1);

fn folder_result(path: &Path) -> Value {
    match probe_folder(path) {
        Ok(()) => json!({"path": path.to_string_lossy()}),
        Err(error) => json!({"error": format!("Folder tidak bisa ditulis: {error}")}),
    }
}

fn probe_folder(path: &Path) -> std::io::Result<()> {
    // Only remove the uniquely created probe, never an existing user file.
    let name = format!(
        ".socl-write-test-{}-{}",
        std::process::id(),
        NEXT_PROBE.fetch_add(1, Ordering::Relaxed)
    );
    let probe = path.join(name);
    fs::create_dir(&probe)?;
    let file = probe.join("probe");
    let result = fs::File::create_new(&file).and_then(|mut handle| handle.write_all(b"ok"));
    let cleanup = if file.exists() {
        fs::remove_file(&file)
    } else {
        Ok(())
    };
    let remove_dir = fs::remove_dir(&probe);
    result.and(cleanup).and(remove_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writable_folder_preserves_existing_files_and_cleans_probe() {
        let root = std::env::temp_dir().join(format!(
            "socl-native-picker-{}-{}",
            std::process::id(),
            NEXT_PROBE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let existing = root.join("keep.txt");
        fs::write(&existing, b"original").unwrap();
        assert_eq!(
            folder_result(&root)["path"],
            root.to_string_lossy().as_ref()
        );
        assert_eq!(fs::read(&existing).unwrap(), b"original");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        fs::remove_file(existing).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn unavailable_folder_returns_legacy_error_shape() {
        let root = std::env::temp_dir().join(format!(
            "socl-absent-picker-{}-{}",
            std::process::id(),
            NEXT_PROBE.fetch_add(1, Ordering::Relaxed)
        ));
        let result = folder_result(&root.join("missing"));
        assert!(
            result["error"]
                .as_str()
                .unwrap()
                .starts_with("Folder tidak bisa ditulis: ")
        );
        assert!(result.get("path").is_none());
        assert!(!root.exists());
    }
}
