//! Native owner of the SOCL Whisper CLI/model installation. The on-disk layout
//! remains compatible with existing installs and the transitional clip pipeline.
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

pub const CHANNELS: &[&str] = &["whisper:status", "whisper:ensure", "whisper:remove"];
static INSTALL: Mutex<()> = Mutex::new(());

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    binaries: BTreeMap<String, Binary>,
    models: BTreeMap<String, Model>,
    default_model: String,
    vad: Model,
}
#[derive(Deserialize)]
struct Binary {
    url: String,
    sha256: String,
    exe: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    url: String,
    sha256: String,
    size: u64,
    min_bytes: u64,
    #[serde(default)]
    label: String,
    #[serde(default)]
    file: String,
}
fn manifest() -> Manifest {
    serde_json::from_str(include_str!("../../src/whisper-manifest.json"))
        .expect("bundled Whisper manifest")
}
fn platform() -> String {
    let os = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        std::env::consts::OS
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        std::env::consts::ARCH
    };
    format!("{os}-{arch}")
}
fn has_size(file: &Path, minimum: u64) -> bool {
    fs::metadata(file).is_ok_and(|m| m.is_file() && m.len() >= minimum)
}
fn model_name<'a>(m: &'a Manifest, requested: Option<&str>) -> &'a str {
    requested
        .and_then(|name| m.models.get_key_value(name).map(|(key, _)| key.as_str()))
        .unwrap_or(&m.default_model)
}
fn selected_model(data: &Path, payload: &Value) -> Result<String, String> {
    if let Some(name) = payload.as_str().filter(|name| !name.is_empty()) {
        return Ok(name.into());
    }
    let cfg = crate::legacy_settings::read(data)?;
    Ok(cfg["whisperModelSize"].as_str().unwrap_or("").into())
}
pub fn status(data: &Path, requested: Option<&str>) -> Value {
    let m = manifest();
    let name = model_name(&m, requested);
    let root = data.join("whisper").join(&m.version);
    let key = platform();
    let binary = m.binaries.get(&key);
    let binary_installed = binary.is_some_and(|b| has_size(&root.join(&b.exe), 100_001));
    let model_installed =
        |id: &str, model: &Model| has_size(&root.join(format!("model-{id}.bin")), model.min_bytes);
    json!({"supported":binary.is_some(), "platform":key, "binary":binary_installed,
        "installed":binary_installed && model_installed(name, &m.models[name]), "model":name,
        "sizeMB":((m.models[name].size + if binary.is_some() {15_000_000} else {0}) as f64 / 1048576.0).round(),
        "models":m.models.iter().map(|(id, model)|json!({"id":id,"label":model.label,"mb":(model.size as f64 /1048576.0).round(),"installed":binary.is_some() && model_installed(id,model)})).collect::<Vec<_>>()})
}
fn emit(app: &AppHandle, progress: Value) {
    let _ = app.emit(
        "engine-event",
        json!({"channel":"whisper-progress","data":progress}),
    );
}
pub fn invoke(app: &AppHandle, channel: &str, payload: &Value) -> Result<Value, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    match channel {
        "whisper:status" => Ok(status(&data, Some(&selected_model(&data, payload)?))),
        "whisper:ensure" => Ok(match install_for_app(app, payload) {
            Ok(_) => json!({"ok":true}),
            Err(error) => json!({"ok":false,"error":error}),
        }),
        "whisper:remove" => {
            let _guard = INSTALL
                .try_lock()
                .map_err(|_| "Tunggu unduhan Whisper selesai sebelum menghapus model.")?;
            let parent = data.join("whisper");
            // Only this fixed app-data child may be removed; never follow a replaced directory.
            if parent.exists() {
                let base = data.canonicalize().map_err(|e| e.to_string())?;
                let target = parent.canonicalize().map_err(|e| e.to_string())?;
                if target.parent() != Some(base.as_path())
                    || target.file_name() != Some(std::ffi::OsStr::new("whisper"))
                {
                    return Err("Lokasi model Whisper tidak valid.".into());
                }
                fs::remove_dir_all(target).map_err(|e| e.to_string())?;
            }
            Ok(json!(true))
        }
        _ => Err("Unknown Whisper operation".into()),
    }
}
pub fn install_for_app(app: &AppHandle, payload: &Value) -> Result<Value, String> {
    install_with_progress(app, payload, &mut |_| {})
}
pub fn install_with_progress(
    app: &AppHandle,
    payload: &Value,
    progress: &mut dyn FnMut(Value),
) -> Result<Value, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let model = selected_model(&data, payload)?;
    ensure(&data, Some(&model), &mut |p| {
        emit(app, p.clone());
        progress(p);
    })
}

fn ensure(
    data: &Path,
    requested: Option<&str>,
    progress: &mut dyn FnMut(Value),
) -> Result<Value, String> {
    let _guard = INSTALL.lock().map_err(|_| "Whisper install lock failed")?;
    let m = manifest();
    let name = model_name(&m, requested);
    let key = platform();
    let binary = m
        .binaries
        .get(&key)
        .ok_or_else(|| format!("Whisper lokal belum tersedia untuk {key}"))?;
    let root = data.join("whisper").join(&m.version);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let bin = root.join(&binary.exe);
    if !has_size(&bin, 100_001) {
        download(
            &binary.url,
            &bin,
            &binary.sha256,
            None,
            100_001,
            "binary",
            progress,
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
    }
    let model = &m.models[name];
    let model_path = root.join(format!("model-{name}.bin"));
    if !has_size(&model_path, model.min_bytes) {
        download(
            &model.url,
            &model_path,
            &model.sha256,
            Some(model.size),
            model.min_bytes,
            "model",
            progress,
        )?;
    }
    let vad = root.join(&m.vad.file);
    if !has_size(&vad, m.vad.min_bytes) {
        // VAD is an optional speed improvement; speech recognition still works without it.
        let _ = download(
            &m.vad.url,
            &vad,
            &m.vad.sha256,
            Some(m.vad.size),
            m.vad.min_bytes,
            "vad",
            progress,
        );
    }
    progress(json!({"phase":"done"}));
    Ok(
        json!({"bin":bin,"model":model_path,"vad":if has_size(&vad,m.vad.min_bytes) {Some(vad)}else{None}}),
    )
}

fn download(
    url: &str,
    destination: &Path,
    sha256: &str,
    exact: Option<u64>,
    minimum: u64,
    phase: &str,
    progress: &mut dyn FnMut(Value),
) -> Result<(), String> {
    progress(json!({"phase":phase,"percent":0}));
    let temporary = destination.with_extension("part-rust");
    let result = (|| {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(3600)))
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_body(Some(Duration::from_secs(60)))
            .build();
        let agent = ureq::Agent::new_with_config(config);
        let mut response = agent
            .get(url)
            .header("User-Agent", "SOCL-Visuals-Studio")
            .call()
            .map_err(|e| format!("Unduhan Whisper gagal: {e}"))?;
        let total = response.body().content_length();
        let mut reader = response.body_mut().as_reader();
        let mut output = fs::File::create(&temporary).map_err(|e| e.to_string())?;
        let mut digest = Sha256::new();
        let mut got = 0u64;
        let mut buffer = vec![0u8; 256 * 1024];
        let mut notified = Instant::now();
        loop {
            let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            got += n as u64;
            if exact.is_some_and(|size| got > size) {
                return Err("Ukuran unduhan Whisper melebihi manifest.".into());
            }
            output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
            digest.update(&buffer[..n]);
            if notified.elapsed() >= Duration::from_millis(150) {
                progress(
                    json!({"phase":phase,"got":got,"total":total,"percent":total.filter(|n|*n>0).map(|n|got as f64/n as f64).unwrap_or(0.0)}),
                );
                notified = Instant::now();
            }
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        let hash: String = digest.finalize().iter().map(|b| format!("{b:02x}")).collect();
        validate_download(got, total, exact, minimum, &hash, sha256)?;
        // A failed transfer never replaces the working installation.
        fs::rename(&temporary, destination).map_err(|e| e.to_string())?;
        progress(json!({"phase":phase,"got":got,"total":total,"percent":1}));
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn validate_download(
    got: u64,
    total: Option<u64>,
    exact: Option<u64>,
    minimum: u64,
    hash: &str,
    wanted: &str,
) -> Result<(), String> {
    if got < minimum || total.is_some_and(|n| n != got) || exact.is_some_and(|n| n != got) {
        return Err("Unduhan Whisper tidak lengkap atau ukurannya tidak cocok.".into());
    }
    if !wanted.eq_ignore_ascii_case("SKIP_VERIFY")
        && !wanted.eq_ignore_ascii_case("PENDING")
        && !hash.eq_ignore_ascii_case(wanted)
    {
        return Err("Checksum SHA-256 Whisper tidak cocok.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn manifest_matches_existing_layout() {
        let m = manifest();
        assert_eq!(model_name(&m, Some("../../bad")), "small");
        assert_eq!(m.binaries["win32-x64"].exe, "whisper-cli.exe");
        assert_eq!(m.version, "whisper-v1.9.1-m1");
    }
    #[test]
    fn rejects_partial_wrong_size_and_checksum() {
        assert!(validate_download(20, Some(30), None, 1, "abc", "abc").is_err());
        assert!(validate_download(20, None, Some(30), 1, "abc", "SKIP_VERIFY").is_err());
        assert!(validate_download(20, None, None, 21, "abc", "abc").is_err());
        assert!(validate_download(20, None, None, 1, "bad", "abc").is_err());
        assert!(validate_download(20, None, Some(20), 1, "AbC", "aBc").is_ok());
        assert!(validate_download(20, None, Some(20), 1, "abc", "SKIP_VERIFY").is_ok());
    }
    #[test]
    fn verified_download_is_published_and_bad_download_preserves_existing_file() {
        use std::net::TcpListener;
        fn fixture() -> (String, std::thread::JoinHandle<()>) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/file", listener.local_addr().unwrap());
            let task = std::thread::spawn(move || {
                let (mut connection, _) = listener.accept().unwrap();
                connection
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") && request.len() < 16384 {
                    if connection.read(&mut byte).unwrap() == 0 {
                        break;
                    }
                    request.push(byte[0]);
                }
                connection
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                    )
                    .unwrap();
            });
            (url, task)
        }
        let root =
            std::env::temp_dir().join(format!("socl-whisper-download-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("model.bin");
        let hash: String = Sha256::digest(b"hello").iter().map(|b| format!("{b:02x}")).collect();
        let (url, task) = fixture();
        download(&url, &destination, &hash, Some(5), 1, "model", &mut |_| {}).unwrap();
        task.join().unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"hello");
        let (url, task) = fixture();
        assert!(download(&url, &destination, "bad", Some(5), 1, "model", &mut |_| {}).is_err());
        task.join().unwrap();
        assert_eq!(fs::read(&destination).unwrap(), b"hello");
        assert!(!destination.with_extension("part-rust").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn existing_install_is_reported_without_modifying_files() {
        let dir = std::env::temp_dir().join(format!("socl-whisper-status-{}", std::process::id()));
        let m = manifest();
        let root = dir.join("whisper").join(&m.version);
        fs::create_dir_all(&root).unwrap();
        if let Some(bin) = m.binaries.get(&platform()) {
            fs::File::create(root.join(&bin.exe))
                .unwrap()
                .set_len(100_001)
                .unwrap();
            fs::File::create(root.join("model-small.bin"))
                .unwrap()
                .set_len(m.models["small"].min_bytes)
                .unwrap();
            assert_eq!(status(&dir, Some("small"))["installed"], true);
            fs::File::create(root.join("model-small.bin"))
                .unwrap()
                .set_len(1)
                .unwrap();
            assert_eq!(status(&dir, Some("small"))["installed"], false);
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
