//! Legacy-compatible settings and Windows DPAPI storage, without Node or PowerShell.
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::{Map, Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

pub const CHANNELS: &[&str] = &[
    "get-settings",
    "set-settings",
    "secrets:available",
    "secrets:diagnose",
];
const SECRET_FIELDS: &[&str] = &[
    "geminiKey",
    "groqKey",
    "openrouterKey",
    "openaiKey",
    "sumopodKey",
    "anthropicKey",
    "apiKey",
];
static STORE_LOCK: Mutex<()> = Mutex::new(());
static NEXT_FILE: AtomicU64 = AtomicU64::new(1);

pub fn invoke(dir: &Path, channel: &str, payload: &Value) -> Result<Value, String> {
    let _lock = STORE_LOCK
        .lock()
        .map_err(|_| "Settings store lock failed")?;
    match channel {
        "get-settings" => read(dir),
        "set-settings" => write(dir, payload),
        "secrets:available" => Ok(json!(cfg!(windows))),
        "secrets:diagnose" => diagnose(dir),
        _ => Err(format!("Unknown settings operation: {channel}")),
    }
}

fn object_file(path: &Path) -> Result<Map<String, Value>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
            .map_err(|error| format!("Cannot read {}: {error}", path.display()))?
            .as_object()
            .cloned()
            .ok_or_else(|| format!("{} must contain a JSON object", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(format!("Cannot read {}: {error}", path.display())),
    }
}

fn defaults() -> Value {
    serde_json::from_str(include_str!("../assets/socl-defaults.json"))
        .expect("bundled SOCL defaults")
}

fn normalize(settings: &mut Value) {
    let standard = defaults();
    for (key, retired) in [
        (
            "geminiModel",
            &[
                "gemini-2.5-flash",
                "gemini-2.5-pro",
                "gemini-2.0-flash",
                "gemini-2.0-flash-lite",
                "gemini-1.5-flash",
                "gemini-1.5-pro",
            ][..],
        ),
        (
            "groqModel",
            &[
                "llama-3.3-70b-versatile",
                "llama-3.1-8b-instant",
                "moonshotai/kimi-k2-instruct",
            ][..],
        ),
        (
            "openrouterModel",
            &["meta-llama/llama-3.3-70b-instruct:free"][..],
        ),
        ("model", &["nemotron-3-ultra-free"][..]),
        ("freeModel", &["nemotron-3-ultra-free"][..]),
        ("hookProvider", &["local"][..]),
    ] {
        if retired.contains(&settings[key].as_str().unwrap_or("")) {
            settings[key] = standard[key].clone();
        }
    }
    let base = settings["baseUrl"].as_str().unwrap_or("").to_lowercase();
    if ["http://api.opencode.ai", "https://api.opencode.ai"]
        .iter()
        .any(|host| base == *host || base.starts_with(&format!("{host}/")))
    {
        settings["baseUrl"] = standard["baseUrl"].clone();
    }
    if settings["hookPreset"] == "riot_potong" {
        settings["hookPreset"] = json!("riot");
        if settings["videoFx"].as_str().unwrap_or("").is_empty() {
            settings["videoFx"] = json!("cut_pink");
        }
    }
    settings["emojiStickers"] = json!(false);
    let model = settings["whisperModelSize"]
        .as_str()
        .unwrap_or("")
        .to_lowercase();
    if ["turbo", "large", "medium"]
        .iter()
        .any(|word| model.contains(word))
    {
        settings["whisperModelSize"] = standard["whisperModelSize"].clone();
    }
}

fn decrypt(encoded: &str) -> Result<String, String> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Stored key is not valid base64")?;
    String::from_utf8(crypt(&bytes, true)?).map_err(|_| "Stored key is not valid UTF-8".into())
}

pub(crate) fn read(dir: &Path) -> Result<Value, String> {
    let mut settings = defaults();
    // Reads preserve the old default fallback for a damaged settings file.
    if let Ok(saved) = object_file(&dir.join("settings.json")) {
        settings.as_object_mut().unwrap().extend(saved);
    }
    normalize(&mut settings);
    if cfg!(windows) {
        if let Ok(saved) = object_file(&dir.join("secrets.bin")) {
            for key in SECRET_FIELDS {
                if let Some(value) = saved
                    .get(*key)
                    .and_then(Value::as_str)
                    .and_then(|text| decrypt(text).ok())
                    .filter(|text| !text.is_empty())
                {
                    settings[*key] = json!(value);
                }
            }
        }
    }
    Ok(settings)
}

fn write(dir: &Path, payload: &Value) -> Result<Value, String> {
    write_inner(dir, payload, false)
}

pub(crate) fn internal_write(dir: &Path, payload: &Value) -> Result<Value, String> {
    let _lock = STORE_LOCK
        .lock()
        .map_err(|_| "Settings store lock failed")?;
    write_inner(dir, payload, true)
}

fn write_inner(dir: &Path, payload: &Value, main_owned: bool) -> Result<Value, String> {
    let mut patch = payload
        .as_object()
        .cloned()
        .ok_or("Settings patch must be an object")?;
    // Do not replace an unreadable/corrupt existing store with default values.
    let saved_settings = object_file(&dir.join("settings.json"))?;
    if !main_owned {
        patch.remove("workRoots");
    }
    let mut settings = read(dir)?;
    if cfg!(windows) {
        let mut secrets = object_file(&dir.join("secrets.bin"))?;
        let mut changed = false;
        // Preserve plaintext credentials from older installations before clearing
        // their settings fields. Prefer an already readable encrypted value.
        for key in SECRET_FIELDS {
            if saved_settings
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
            {
                if let Some(text) = settings[*key]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                {
                    secrets.insert(
                        (*key).into(),
                        json!(STANDARD.encode(crypt(text.trim().as_bytes(), false)?)),
                    );
                    changed = true;
                }
            }
        }
        for key in SECRET_FIELDS {
            if let Some(value) = patch.get_mut(*key) {
                let text = value.as_str().unwrap_or("").trim();
                if text.is_empty() {
                    secrets.remove(*key);
                } else {
                    secrets.insert(
                        (*key).into(),
                        json!(STANDARD.encode(crypt(text.as_bytes(), false)?)),
                    );
                }
                *value = json!("");
                changed = true;
            }
        }
        if changed {
            atomic_json(&dir.join("secrets.bin"), &Value::Object(secrets))?;
        }
    }
    settings.as_object_mut().unwrap().extend(patch);
    if cfg!(windows) {
        for key in SECRET_FIELDS {
            settings[*key] = json!("");
        }
    }
    atomic_json(&dir.join("settings.json"), &settings)?;
    read(dir)
}

fn diagnose(dir: &Path) -> Result<Value, String> {
    let saved = object_file(&dir.join("secrets.bin"))?;
    let stored: Vec<&str> = SECRET_FIELDS
        .iter()
        .copied()
        .filter(|key| {
            saved
                .get(*key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
        })
        .collect();
    let unreadable: Vec<&str> = stored
        .iter()
        .copied()
        .filter(|key| {
            saved
                .get(*key)
                .and_then(Value::as_str)
                .is_none_or(|text| decrypt(text).is_err())
        })
        .collect();
    let ok = unreadable.is_empty();
    Ok(
        json!({"ok":ok,"reason":if ok { if stored.is_empty() {"empty"} else {"ok"} } else if cfg!(windows) {"unreadable"} else {"locked"},
        "stored":stored,"unreadable":unreadable,"warning":if ok {Value::Null} else {json!("API key tersimpan belum dapat dibaca oleh akun Windows ini. Masukkan ulang key melalui Settings.")}}),
    )
}

pub(crate) fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    atomic_bytes(path, &bytes)
}

pub(crate) fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Store path has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(
        ".socl-store-{}-{}.tmp",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> Result<(), String> {
        let mut file = fs::File::create_new(&temp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.flush()
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

#[cfg(windows)]
fn crypt(bytes: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *const c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *const c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }
    let input = Blob {
        len: bytes.len().try_into().map_err(|_| "Key is too large")?,
        data: bytes.as_ptr().cast_mut(),
    };
    let mut output = Blob {
        len: 0,
        data: std::ptr::null_mut(),
    };
    let success = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                1,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                1,
                &mut output,
            )
        }
    };
    if success == 0 {
        return Err(format!(
            "Windows DPAPI failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let result = if output.len == 0 {
        Vec::new()
    } else if output.data.is_null() {
        return Err("Windows DPAPI returned an invalid data buffer".into());
    } else {
        unsafe { std::slice::from_raw_parts(output.data, output.len as usize).to_vec() }
    };
    if !output.data.is_null() {
        unsafe {
            LocalFree(output.data.cast());
        }
    }
    Ok(result)
}

#[cfg(not(windows))]
fn crypt(_bytes: &[u8], _decrypt: bool) -> Result<Vec<u8>, String> {
    Err("OS key storage unavailable on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn folder() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "socl-settings-test-{}-{}",
            std::process::id(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn keeps_unknown_fields_and_main_owned_roots() {
        let dir = folder();
        atomic_json(
            &dir.join("settings.json"),
            &json!({"workRoots":["old"],"custom":42}),
        )
        .unwrap();
        let result = write(&dir, &json!({"clipCount":8,"workRoots":["replaced"]})).unwrap();
        assert_eq!(result["clipCount"], 8);
        assert_eq!(result["custom"], 42);
        assert_eq!(result["workRoots"], json!(["old"]));
        assert_eq!(result["format"], "face");
        internal_write(&dir, &json!({"workRoots":["pipeline-root"]})).unwrap();
        assert_eq!(read(&dir).unwrap()["workRoots"], json!(["pipeline-root"]));
        assert_eq!(read(&dir).unwrap()["custom"], 42);
        fs::remove_file(dir.join("settings.json")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn refuses_to_overwrite_corrupted_settings() {
        let dir = folder();
        fs::write(dir.join("settings.json"), "broken-json").unwrap();
        assert!(write(&dir, &json!({"clipCount":9})).is_err());
        assert_eq!(
            fs::read_to_string(dir.join("settings.json")).unwrap(),
            "broken-json"
        );
        fs::remove_file(dir.join("settings.json")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn normalizes_retired_settings_like_legacy_engine() {
        let mut value = defaults();
        value["hookPreset"] = json!("riot_potong");
        value["whisperModelSize"] = json!("large-v3");
        value["geminiModel"] = json!("gemini-2.0-flash");
        normalize(&mut value);
        assert_eq!(value["hookPreset"], "riot");
        assert_eq!(value["videoFx"], "cut_pink");
        assert_eq!(value["whisperModelSize"], "small");
        assert_eq!(value["geminiModel"], defaults()["geminiModel"]);
    }
    #[cfg(windows)]
    #[test]
    fn dpapi_keeps_keys_out_of_settings_and_preserves_legacy_format() {
        assert_eq!(crypt(&crypt(b"", false).unwrap(), true).unwrap(), b"");
        let dir = folder();
        atomic_json(
            &dir.join("settings.json"),
            &json!({"openaiKey":"legacy-synthetic-key"}),
        )
        .unwrap();
        let result = write(&dir, &json!({"groqKey":" synthetic-test-key "})).unwrap();
        assert_eq!(result["groqKey"], "synthetic-test-key");
        assert_eq!(result["openaiKey"], "legacy-synthetic-key");
        let stored = object_file(&dir.join("settings.json")).unwrap();
        assert_eq!(stored["groqKey"], "");
        let secret = object_file(&dir.join("secrets.bin")).unwrap();
        assert_eq!(
            decrypt(secret["groqKey"].as_str().unwrap()).unwrap(),
            "synthetic-test-key"
        );
        assert_eq!(
            decrypt(secret["openaiKey"].as_str().unwrap()).unwrap(),
            "legacy-synthetic-key"
        );
        assert_eq!(diagnose(&dir).unwrap()["ok"], true);
        write(&dir, &json!({"groqKey":""})).unwrap();
        assert_eq!(read(&dir).unwrap()["groqKey"], "");
        fs::remove_file(dir.join("settings.json")).unwrap();
        fs::remove_file(dir.join("secrets.bin")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
