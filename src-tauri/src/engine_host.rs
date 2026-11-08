use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
type Pending = HashMap<u64, oneshot::Sender<Reply>>;
pub(crate) struct Engine {
    child: Mutex<Option<Child>>,
    input: Mutex<ChildStdin>,
    pending: Mutex<Pending>,
    ready: Mutex<Option<Reply>>,
    next_id: AtomicU64,
}

impl Engine {
    fn send(&self, value: Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|_| "Engine input lock failed")?;
        serde_json::to_writer(&mut *input, &value).map_err(|e| e.to_string())?;
        input.write_all(b"\n").map_err(|e| e.to_string())?;
        input.flush().map_err(|e| e.to_string())
    }
    fn fail(&self, message: String) {
        if let Ok(mut ready) = self.ready.lock() {
            *ready = Some(Err(message.clone()));
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, tx) in pending.drain() {
                let _ = tx.send(Err(message.clone()));
            }
        }
    }
    fn stop(&self) {
        let _ = self.send(json!({"kind":"shutdown"}));
        std::thread::sleep(Duration::from_millis(350));
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut process) = child.take() {
                let _ = process.kill();
                let _ = process.wait();
            }
        }
    }
}

fn spawn_engine(app: &tauri::AppHandle) -> Result<Arc<Engine>, Box<dyn std::error::Error>> {
    let root = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("Missing project directory")?
            .to_path_buf()
    } else {
        app.path().resource_dir()?.join("engine-resources")
    };
    let node = if cfg!(debug_assertions) {
        root.join(".dev-tools/node-runtime/node.exe")
    } else {
        root.join("runtime/node.exe")
    };
    if !node.is_file() {
        return Err(format!(
            "Node engine runtime missing: {}. Run npm-local.cmd run prepare:runtime",
            node.display()
        )
        .into());
    }
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    let mut cmd = Command::new(node);
    cmd.arg(root.join("engine/server.cjs"))
        .current_dir(&root)
        .env("SOCL_APP_DATA", data_dir)
        .env("SOCL_NATIVE_MEDIA", "1")
        .env("SOCL_NATIVE_SETTINGS", "1")
        .env("SOCL_NATIVE_REPORTS", "1")
        .env("SOCL_NATIVE_WHISPER", "1")
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().ok_or("Missing engine stdout")?;
    let stderr = child.stderr.take().ok_or("Missing engine stderr")?;
    let input = child.stdin.take().ok_or("Missing engine stdin")?;
    let engine = Arc::new(Engine {
        child: Mutex::new(Some(child)),
        input: Mutex::new(input),
        pending: Mutex::new(HashMap::new()),
        ready: Mutex::new(None),
        next_id: AtomicU64::new(1),
    });
    let reader_engine = engine.clone();
    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                eprintln!("Invalid engine output: {line}");
                continue;
            };
            match message["kind"].as_str() {
                Some("ready") => {
                    crate::commands::media_server::grant_value(
                        &handle,
                        &message["data"]["mediaRoots"],
                    );
                    if let Ok(mut ready) = reader_engine.ready.lock() {
                        *ready = Some(Ok(message["data"].clone()));
                    }
                }
                Some("response") => {
                    if let Some(id) = message["id"].as_u64() {
                        if let Some(tx) = reader_engine
                            .pending
                            .lock()
                            .ok()
                            .and_then(|mut map| map.remove(&id))
                        {
                            let response = if let Some(error) = message["error"].as_str() {
                                Err(error.to_owned())
                            } else {
                                crate::commands::media_server::grant_value(
                                    &handle,
                                    &message["result"],
                                );
                                Ok(message["result"].clone())
                            };
                            let _ = tx.send(response);
                        }
                    }
                }
                Some("event") => {
                    crate::commands::media_server::grant_value(&handle, &message["data"]);
                    let _ = handle.emit("engine-event", &message);
                }
                Some("native")
                    if matches!(
                        message["op"].as_str(),
                        Some("store-settings" | "store-report" | "whisper-install")
                    ) =>
                {
                    let owner = reader_engine.clone();
                    let app = handle.clone();
                    let id = message["id"].clone();
                    let op = message["op"].as_str().unwrap().to_owned();
                    let payload = message["payload"].clone();
                    let progress_owner = owner.clone();
                    let progress_id = id.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = tauri::async_runtime::spawn_blocking(move || -> Reply {
                            if op == "whisper-install" {
                                crate::legacy_whisper::install_with_progress(&app,&payload,&mut |data| {
                                    let _ = progress_owner.send(json!({"kind":"native-progress","id":progress_id,"data":data}));
                                })
                            } else if op == "store-report" {
                                Ok(crate::legacy_files::persist_patch(&payload))
                            } else {
                                let dir = app
                                    .path()
                                    .app_data_dir()
                                    .map_err(|error| error.to_string())?;
                                crate::legacy_settings::internal_write(&dir, &payload)
                            }
                        })
                        .await
                        .map_err(|error| error.to_string())
                        .and_then(|result| result);
                        let reply = match result {
                            Ok(value) => json!({"kind":"native-result","id":id,"result":value}),
                            Err(error) => json!({"kind":"native-result","id":id,"error":error}),
                        };
                        let _ = owner.send(reply);
                    });
                }
                Some("native") => {
                    let _ = handle.emit("engine-native", &message);
                }
                Some("fatal") => {
                    reader_engine.fail(
                        message["error"]
                            .as_str()
                            .unwrap_or("Engine startup failed")
                            .to_owned(),
                    );
                }
                _ => {}
            }
        }
        reader_engine
            .fail("The video engine stopped. Restart the application to reconnect.".to_owned());
        let _ = handle.emit("engine-disconnected", ());
    });
    let log_handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[engine] {line}");
            let _ = log_handle.emit("engine-log", line);
        }
    });
    Ok(engine)
}

#[tauri::command]
pub(crate) async fn engine_info(state: tauri::State<'_, Arc<Engine>>) -> Reply {
    for _ in 0..300 {
        if let Some(ready) = state
            .ready
            .lock()
            .map_err(|_| "Engine state lock failed")?
            .clone()
        {
            return ready.and_then(|mut info| {
                if let Some(channels) = info["channels"].as_array_mut() {
                    for channel in crate::legacy_native::CHANNELS {
                        if !channels.iter().any(|item| item.as_str() == Some(channel)) {
                            channels.push(json!(channel));
                        }
                    }
                }
                info["rustChannels"] = json!(crate::legacy_native::CHANNELS);
                let base = crate::commands::media_server::media_server_url()
                    .ok_or("Rust media server could not start".to_owned())?;
                info["mediaBase"] = json!(base);
                info["mediaTransport"] = json!("rust");
                Ok(info)
            });
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Video engine startup timed out".into())
}

#[tauri::command]
pub(crate) async fn engine_invoke(
    app: tauri::AppHandle,
    channel: String,
    args: Vec<Value>,
) -> Reply {
    if channel.starts_with("license:") {
        return Err("Unknown operation".into());
    }
    if channel == "engine:grant-dropped" {
        crate::commands::media_server::grant_value(&app, &json!(args));
        return Ok(json!(true));
    }
    if crate::legacy_native::CHANNELS.contains(&channel.as_str()) {
        let result = crate::legacy_native::invoke(app.clone(), channel, args).await?;
        crate::commands::media_server::grant_value(&app, &result);
        return Ok(result);
    }
    crate::commands::media_server::grant_value(&app, &json!(&args));
    let state = app
        .try_state::<Arc<Engine>>()
        .ok_or("The remaining clipping engine is not available".to_owned())?;
    forward_invoke(&state, channel, args).await
}

async fn forward_invoke(state: &Engine, channel: String, args: Vec<Value>) -> Reply {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    state
        .pending
        .lock()
        .map_err(|_| "Engine pending lock failed")?
        .insert(id, tx);
    if let Err(error) =
        state.send(json!({"kind":"invoke", "id":id, "channel":channel, "args":args}))
    {
        state
            .pending
            .lock()
            .map_err(|_| "Engine pending lock failed")?
            .remove(&id);
        return Err(error);
    }
    match tokio::time::timeout(Duration::from_secs(24 * 60 * 60), rx).await {
        Ok(result) => result.map_err(|_| "Engine response disconnected".to_owned())?,
        Err(_) => {
            state
                .pending
                .lock()
                .map_err(|_| "Engine pending lock failed")?
                .remove(&id);
            Err("Engine operation timed out".into())
        }
    }
}

#[tauri::command]
pub(crate) fn native_reply(
    state: tauri::State<'_, Arc<Engine>>,
    id: u64,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    state.send(json!({"kind":"native-result", "id":id, "result":result, "error":error}))
}

#[tauri::command]
pub(crate) async fn native_action(app: tauri::AppHandle, op: String, payload: Value) -> Reply {
    tauri::async_runtime::spawn_blocking(move || {
        if op == "select-files" {
            let mut dialog = app.dialog().file();
            if let Some(title) = payload["title"].as_str() {
                dialog = dialog.set_title(title);
            }
            if let Some(filters) = payload["filters"].as_array() {
                for filter in filters {
                    let extensions: Vec<&str> = filter["extensions"]
                        .as_array()
                        .map(|items| items.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    if !extensions.is_empty() {
                        dialog = dialog
                            .add_filter(filter["name"].as_str().unwrap_or("Files"), &extensions);
                    }
                }
            }
            let properties = payload["properties"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let directory = properties.iter().any(|value| value == "openDirectory");
            let multiple = properties.iter().any(|value| value == "multiSelections");
            let selected = if directory {
                dialog.blocking_pick_folder().map(|file| vec![file])
            } else if multiple {
                dialog.blocking_pick_files()
            } else {
                dialog.blocking_pick_file().map(|file| vec![file])
            };
            let paths: Vec<String> = selected
                .unwrap_or_default()
                .into_iter()
                .filter_map(|file| file.into_path().ok())
                .map(|file| file.to_string_lossy().into_owned())
                .collect();
            return Ok(json!({"canceled":paths.is_empty(), "filePaths":paths}));
        }
        let path = payload["path"].as_str().unwrap_or("");
        let url = payload["url"].as_str().unwrap_or("");
        let target = if op == "open-external" {
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return Err("Only HTTP(S) links are allowed".into());
            }
            url.to_owned()
        } else {
            let file = PathBuf::from(path);
            if !file.is_absolute() || !file.exists() {
                return Err("The selected file or folder does not exist".into());
            }
            path.to_owned()
        };
        if !["open-external", "open-path", "reveal-path"].contains(&op.as_str()) {
            return Err("Unsupported native action".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new("explorer.exe");
            command.creation_flags(0x08000000);
            if op == "reveal-path" {
                command.arg(format!("/select,{target}"));
            } else {
                command.arg(&target);
            }
            command.spawn().map_err(|error| error.to_string())?;
        }
        #[cfg(not(windows))]
        {
            let target = if op == "reveal-path" {
                PathBuf::from(target)
                    .parent()
                    .ok_or("Missing parent directory")?
                    .to_string_lossy()
                    .into_owned()
            } else {
                target
            };
            Command::new(if cfg!(target_os = "macos") {
                "open"
            } else {
                "xdg-open"
            })
            .arg(target)
            .spawn()
            .map_err(|error| error.to_string())?;
        }
        Ok(json!(""))
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = spawn_engine(app)?;
    app.manage(state);
    Ok(())
}
pub(crate) fn shutdown(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<Engine>>() {
        state.stop();
    }
}
