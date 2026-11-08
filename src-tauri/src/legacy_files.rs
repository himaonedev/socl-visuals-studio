//! SOCL session metadata, history, watermark assets and cookies in Rust.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock, mpsc},
    time::{Duration, Instant},
};

pub const CHANNELS: &[&str] = &[
    "clip:saveMeta",
    "wm:saveAsset",
    "wm:deleteAsset",
    "list-history",
    "set-cookies",
];
static REPORT_LOCK: Mutex<()> = Mutex::new(());

pub fn invoke(data: &Path, output: &Path, channel: &str, payload: &Value) -> Result<Value, String> {
    Ok(match channel {
        "clip:saveMeta" => save_meta(payload),
        "wm:saveAsset" => {
            watermark_save(data, payload).unwrap_or_else(|error| json!({"error":error}))
        }
        "wm:deleteAsset" => watermark_delete(data, payload)
            .unwrap_or_else(|error| json!({"ok":false,"error":error})),
        "list-history" => history(data, output),
        "set-cookies" => {
            set_cookies(data, payload).unwrap_or_else(|error| json!({"ok":false,"error":error}))
        }
        _ => return Err(format!("Unknown file operation: {channel}")),
    })
}

fn report_for(output: &Path) -> Option<PathBuf> {
    let folder = output.parent()?;
    let session = if [
        "raw",
        "subtitle",
        "edited",
        "crop-biasa",
        "crop-gaming",
        "hasil",
        "burn-edited",
        "_clean",
    ]
    .contains(&folder.file_name()?.to_str()?)
    {
        folder.parent()?
    } else {
        folder
    };
    let current = session.join("data/report.json");
    let legacy = session.join("report.json");
    Some(if !current.exists() && legacy.exists() {
        legacy
    } else {
        current
    })
}

fn save_meta(payload: &Value) -> Value {
    let mut patch: serde_json::Map<String, Value> = ["title", "hook", "why"]
        .into_iter()
        .filter_map(|key| {
            payload[key]
                .as_str()
                .map(|text| (key.to_owned(), json!(text)))
        })
        .collect();
    if let Some(cues) = payload["cueWords"].as_array() {
        if cues.len() > 10000 || payload["cueWords"].to_string().len() > 4 * 1024 * 1024 {
            return json!({"updated":false,"reason":"caption-data-too-large"});
        }
        patch.insert("cueWords".into(), payload["cueWords"].clone());
        patch.insert("captionProject".into(), Value::Null);
    }
    if patch.is_empty() {
        return json!({"updated":false,"reason":"empty-patch"});
    }
    persist_patch(
        &json!({"outputFile":payload["outputFile"],"clipIndex":payload["clipIndex"],"patch":patch}),
    )
}

pub(crate) fn persist_patch(payload: &Value) -> Value {
    const ALLOWED: &[&str] = &[
        "cueWords",
        "effectsBaked",
        "effectsReportFile",
        "captionProject",
        "file",
        "thumbnail",
        "rawFile",
        "subsBurned",
        "splitCrop",
        "aiStickerCache",
        "title",
        "hook",
        "why",
        "titles",
        "titlesBurned",
        "watermarkBurnedSnapshot",
        "trackPlan",
        "cropAspect",
        "cropRect",
        "cropKF",
    ];
    let patch: serde_json::Map<String, Value> = payload["patch"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, value)| {
            ALLOWED.contains(&key.as_str())
                && !(key.as_str() == "thumbnail"
                    && (value.is_null() || **value == false || **value == "" || **value == 0))
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let Some(index) = payload["clipIndex"]
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
    else {
        return json!({"updated":false,"reason":"invalid-target"});
    };
    let Some(output) = payload["outputFile"]
        .as_str()
        .map(Path::new)
        .filter(|path| path.is_absolute())
    else {
        return json!({"updated":false,"reason":"invalid-target"});
    };
    let Some(report_path) = report_for(output) else {
        return json!({"updated":false,"reason":"invalid-target"});
    };
    if !report_path.is_file() {
        return json!({"updated":false,"reason":"report-missing","reportPath":report_path});
    }
    if patch.is_empty() {
        return json!({"updated":false,"reason":"empty-patch","reportPath":report_path});
    }
    let result = (|| -> Result<Value, String> {
        let _lock = REPORT_LOCK.lock().map_err(|_| "Report store lock failed")?;
        let bytes = fs::read(&report_path).map_err(|error| error.to_string())?;
        let mut report: Value =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let Some(clip) = report["clips"]
            .as_array_mut()
            .and_then(|clips| clips.get_mut(index))
            .and_then(Value::as_object_mut)
        else {
            return Ok(json!({"updated":false,"reason":"clip-missing","reportPath":report_path}));
        };
        clip.extend(patch);
        crate::legacy_settings::atomic_json(&report_path, &report)?;
        Ok(json!({"updated":true,"reportPath":report_path}))
    })();
    result.unwrap_or_else(|error| json!({"updated":false,"error":error,"reportPath":report_path}))
}

fn watermark_save(data: &Path, payload: &Value) -> Result<Value, String> {
    let filename = payload["filename"]
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or("Missing filename/bytes")?;
    let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    if !["png", "webp", "jpg", "jpeg"].contains(&ext.as_str()) {
        return Err(format!(
            "Format tidak didukung ({ext}). Gunakan PNG/WebP/JPEG."
        ));
    }
    let values = payload["bytes"]
        .as_array()
        .or_else(|| payload["bytes"]["data"].as_array())
        .ok_or("Missing filename/bytes")?;
    if values.len() > 5 * 1024 * 1024 {
        return Err(format!(
            "File terlalu besar ({:.1}MB). Max 5MB.",
            values.len() as f64 / 1048576.0
        ));
    }
    if values.len() < 32 {
        return Err("File terlalu kecil / rusak.".into());
    }
    let bytes: Vec<u8> = values
        .iter()
        .map(|item| {
            item.as_u64()
                .and_then(|n| u8::try_from(n).ok())
                .ok_or("Invalid image bytes".to_owned())
        })
        .collect::<Result<_, _>>()?;
    let hash: String = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let root = data.join("watermarks");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let path = root.join(format!("{}.{ext}", &hash[..16]));
    if !path.is_file() {
        crate::legacy_settings::atomic_bytes(&path, &bytes)?;
    }
    Ok(json!({"path":path,"filename":filename,"ext":ext,"bytes":bytes.len()}))
}

fn watermark_delete(data: &Path, payload: &Value) -> Result<Value, String> {
    let Some(text) = payload.as_str().filter(|text| !text.is_empty()) else {
        return Ok(json!({"ok":true}));
    };
    let root = data.join("watermarks");
    let path = Path::new(text);
    if !path.is_absolute()
        || !path.starts_with(&root)
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Path outside watermarks dir".into());
    }
    if path.exists() {
        let real = path.canonicalize().map_err(|error| error.to_string())?;
        let real_root = root.canonicalize().map_err(|error| error.to_string())?;
        if real == real_root || !real.starts_with(&real_root) || !real.is_file() {
            return Err("Path outside watermarks dir".into());
        }
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(json!({"ok":true}))
}

fn session_name(name: &str) -> bool {
    let Some(stamp) = name
        .strip_prefix("socl-")
        .and_then(|text| text.as_bytes().get(..19))
    else {
        return false;
    };
    stamp.iter().enumerate().all(|(i, byte)| match i {
        4 | 7 | 13 | 16 => *byte == b'-',
        10 => *byte == b'T',
        _ => byte.is_ascii_digit(),
    })
}

fn scan_root(root: &Path) -> Vec<Value> {
    let mut sessions: Vec<_> = fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && session_name(&entry.file_name().to_string_lossy())
        })
        .collect();
    sessions.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    sessions.truncate(50);
    sessions
        .into_iter()
        .map(|entry| {
            let dir = entry.path();
            let report = [dir.join("data/report.json"), dir.join("report.json")]
                .iter()
                .find_map(|file| fs::read(file).ok())
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .unwrap_or(Value::Null);
            json!({"jobId":entry.file_name().to_string_lossy(),"dir":dir,"report":report})
        })
        .collect()
}

fn history(data: &Path, output: &Path) -> Value {
    static BUSY: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    let settings = crate::legacy_settings::read(data).unwrap_or(Value::Null);
    let mut roots = vec![output.to_path_buf()];
    if let Some(items) = settings["workRoots"].as_array() {
        roots.extend(
            items
                .iter()
                .filter_map(Value::as_str)
                .map(PathBuf::from)
                .filter(|path| path.is_absolute()),
        );
    }
    let mut seen = HashSet::new();
    roots.retain(|root| seen.insert(root.to_string_lossy().to_lowercase()));
    let (tx, rx) = mpsc::channel();
    let mut pending = 0;
    // A sleeping/offline volume can stall OS file IO. One worker per root and a
    // persistent busy set keep later History opens from spawning more stuck IO.
    for root in roots {
        let busy = BUSY.get_or_init(Mutex::default);
        if !busy.lock().unwrap().insert(root.clone()) {
            continue;
        }
        let tx = tx.clone();
        pending += 1;
        std::thread::spawn(move || {
            let found = scan_root(&root);
            BUSY.get().unwrap().lock().unwrap().remove(&root);
            let _ = tx.send(found);
        });
    }
    drop(tx);
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut sessions = Vec::new();
    for _ in 0..pending {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(found) => sessions.extend(found),
            Err(_) => break,
        }
    }
    sessions.sort_by(|a, b| b["jobId"].as_str().cmp(&a["jobId"].as_str()));
    sessions.truncate(50);
    json!(sessions)
}

struct Cookies {
    content: Vec<u8>,
    fixed: Vec<&'static str>,
    rows: usize,
    skipped: usize,
}

fn inspect_cookies(input: &[u8]) -> Result<Cookies, (&'static str, &'static str)> {
    if input.starts_with(&[255, 254]) || input.starts_with(&[254, 255]) {
        return Err((
            "utf16",
            "File ini tersimpan sebagai UTF-16. Simpan ulang sebagai UTF-8 (tanpa BOM), atau export ulang lewat ekstensi SCL VSL Cookies Exporter.",
        ));
    }
    let mut fixed = Vec::new();
    let bytes = if let Some(rest) = input.strip_prefix(&[239, 187, 191]) {
        fixed.push("bom");
        rest
    } else {
        input
    };
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if text.trim().is_empty() {
        return Err(("empty", "File cookies-nya kosong."));
    }
    if text.trim_start().starts_with(['[', '{']) {
        return Err((
            "json",
            "File ini format JSON, bukan Netscape. Pakai ekstensi yang mengekspor cookies.txt Netscape — misalnya SCL VSL Cookies Exporter.",
        ));
    }
    let data: Vec<_> = text
        .split('\n')
        .map(|line| line.trim_start().strip_prefix("#HttpOnly_").unwrap_or(line))
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .collect();
    let rows = data
        .iter()
        .filter(|line| line.trim_end_matches('\r').split('\t').count() == 7)
        .count();
    if rows == 0 {
        return Err((
            "no-cookies",
            "Tidak ada satu pun baris cookie yang sah — kolomnya harus dipisah TAB, bukan koma atau spasi. Export ulang lewat ekstensi.",
        ));
    }
    let skipped = data.len() - rows;
    let lower = text.to_lowercase();
    let header = lower
        .strip_prefix('#')
        .map(str::trim_start)
        .and_then(|tail| {
            if let Some(rest) = tail.strip_prefix("netscape") {
                if rest.starts_with(char::is_whitespace) {
                    Some(rest.trim_start())
                } else {
                    None
                }
            } else {
                Some(tail)
            }
        })
        .is_some_and(|tail| tail.starts_with("http cookie file"));
    if !header {
        text = format!("# Netscape HTTP Cookie File\n{text}");
        fixed.push("header");
    }
    Ok(Cookies {
        content: text.into_bytes(),
        fixed,
        rows,
        skipped,
    })
}

fn set_cookies(data: &Path, payload: &Value) -> Result<Value, String> {
    let target = data.join("cookies.txt");
    if payload["clear"] == true {
        match fs::remove_file(&target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        crate::legacy_settings::invoke(data, "set-settings", &json!({"cookiesPath":""}))?;
        return Ok(json!({"ok":true,"path":""}));
    }
    let source = payload["filePath"]
        .as_str()
        .map(Path::new)
        .filter(|path| path.is_file())
        .ok_or("File not found")?;
    let bytes = fs::read(source).map_err(|error| format!("Gagal membaca file: {error}"))?;
    let cookies = match inspect_cookies(&bytes) {
        Ok(value) => value,
        Err((code, message)) => {
            return Ok(
                json!({"ok":false,"error":message,"code":code,"name":source.file_name().unwrap_or_default().to_string_lossy()}),
            );
        }
    };
    crate::legacy_settings::atomic_bytes(&target, &cookies.content)?;
    crate::legacy_settings::invoke(data, "set-settings", &json!({"cookiesPath":target}))?;
    Ok(
        json!({"ok":true,"path":target,"name":source.file_name().unwrap_or_default().to_string_lossy(),"cookieRows":cookies.rows,"skippedRows":cookies.skipped,"fixed":cookies.fixed}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cookie_validation_preserves_http_only_and_repairs_bom_header() {
        let value = inspect_cookies(
            b"\xef\xbb\xbf#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsynthetic\n",
        )
        .ok()
        .unwrap();
        assert_eq!(value.rows, 1);
        assert_eq!(value.skipped, 0);
        assert_eq!(value.fixed, ["bom", "header"]);
        assert!(
            String::from_utf8(value.content)
                .unwrap()
                .contains("#HttpOnly_.youtube.com")
        );
    }
    #[test]
    fn invalid_cookie_files_are_not_silently_accepted() {
        for (input, code) in [
            (&b"\xff\xfetext"[..], "utf16"),
            (&b"{}"[..], "json"),
            (&b""[..], "empty"),
            (&b"# Netscape HTTP Cookie File\na b c"[..], "no-cookies"),
        ] {
            assert_eq!(inspect_cookies(input).err().unwrap().0, code);
        }
    }
    #[test]
    fn only_timestamped_session_names_are_history_entries() {
        assert!(session_name("socl-2026-11-01T12-34-56-extra"));
        for name in [
            "socl-private",
            "notes",
            "socl-2026-11-01",
            "socl-2026-11-01Taa-bb-cc",
        ] {
            assert!(!session_name(name));
        }
    }
    #[test]
    fn metadata_patch_preserves_clip_geometry_and_report_fields() {
        let root = std::env::temp_dir().join(format!("socl-report-test-{}", std::process::id()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir_all(root.join("hasil")).unwrap();
        let report = root.join("data/report.json");
        crate::legacy_settings::atomic_json(
            &report,
            &json!({"other":42,"clips":[{"title":"before","thumbnail":"original.jpg","cropRect":{"x":123}}]}),
        )
        .unwrap();
        let result = save_meta(
            &json!({"outputFile":root.join("hasil/clip.mp4"),"clipIndex":0,"title":"after","cropRect":{"x":999},"cueWords":[{"start":0,"end":1,"text":"SOCL","tokens":[{"text":"SOCL","style":{"font":"Anton"}}],"textMotion":{"motion":"rise"}}]}),
        );
        assert_eq!(result["updated"], true);
        let stored: Value = serde_json::from_slice(&fs::read(&report).unwrap()).unwrap();
        assert_eq!(stored["clips"][0]["title"], "after");
        assert_eq!(stored["clips"][0]["cropRect"]["x"], 123);
        assert_eq!(stored["other"], 42);
        assert_eq!(stored["clips"][0]["cueWords"][0]["textMotion"]["motion"], "rise");
        assert_eq!(stored["clips"][0]["cueWords"][0]["tokens"][0]["style"]["font"], "Anton");
        assert_eq!(
            persist_patch(
                &json!({"outputFile":root.join("hasil/clip.mp4"),"clipIndex":0,"patch":{"file":"rendered.mp4","thumbnail":null,"subsBurned":true,"forbidden":42}})
            )["updated"],
            true
        );
        let merged: Value = serde_json::from_slice(&fs::read(&report).unwrap()).unwrap();
        assert_eq!(merged["clips"][0]["title"], "after");
        assert_eq!(merged["clips"][0]["thumbnail"], "original.jpg");
        assert_eq!(merged["clips"][0]["file"], "rendered.mp4");
        assert!(merged["clips"][0].get("forbidden").is_none());
        fs::remove_file(report).unwrap();
        fs::remove_dir(root.join("hasil")).unwrap();
        fs::remove_dir(root.join("data")).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn watermark_delete_rejects_outside_paths() {
        let root = std::env::temp_dir().join("socl-watermark-test");
        assert!(watermark_delete(&root, &json!(root.join("unrelated.png"))).is_err());
        assert!(watermark_delete(&root, &json!(root.join("watermarks/../unrelated.png"))).is_err());
    }
    #[test]
    fn history_keeps_new_report_precedence_and_ignores_unrelated_folders() {
        let root = std::env::temp_dir().join(format!("socl-history-test-{}", std::process::id()));
        let older = root.join("socl-2026-10-01T10-00-00");
        let newer = root.join("socl-2026-11-01T10-00-00");
        let unrelated = root.join("personal");
        fs::create_dir_all(older.join("data")).unwrap();
        fs::create_dir_all(newer.join("data")).unwrap();
        fs::create_dir(&unrelated).unwrap();
        fs::write(
            older.join("report.json"),
            br#"{"clips":[],"title":"old-format"}"#,
        )
        .unwrap();
        fs::write(newer.join("report.json"), br#"{"title":"stale-copy"}"#).unwrap();
        fs::write(newer.join("data/report.json"), b"broken-json").unwrap();
        let entries = scan_root(&root);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["jobId"], "socl-2026-11-01T10-00-00");
        assert!(entries[0]["report"].is_null());
        assert_eq!(entries[1]["report"]["title"], "old-format");
        fs::remove_file(older.join("report.json")).unwrap();
        fs::remove_file(newer.join("report.json")).unwrap();
        fs::remove_file(newer.join("data/report.json")).unwrap();
        fs::remove_dir(older.join("data")).unwrap();
        fs::remove_dir(newer.join("data")).unwrap();
        fs::remove_dir(older).unwrap();
        fs::remove_dir(newer).unwrap();
        fs::remove_dir(unrelated).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
