fn main() { if let Err(error) = tauri_build::try_build(tauri_build::Attributes::new()) { panic!("Tauri build failed: {error:?}"); } }
