//! Locating FFmpeg/FFprobe. Missing tools produce a clear error.
//! Order: explicit env var, then the copy bundled with the app (`binaries/` in the resource folder, put
//! there by `scripts/fetch-ffmpeg.mjs`), then PATH (plus common macOS dirs, since GUI apps get a minimal PATH).

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::errors::{AppError, AppResult};

pub const FFMPEG_ENV: &str = "CUTVII_FFMPEG";
pub const FFPROBE_ENV: &str = "CUTVII_FFPROBE";

static BUNDLED_DIR: OnceLock<PathBuf> = OnceLock::new();
static MANAGED_DIR: OnceLock<PathBuf> = OnceLock::new();
pub fn set_managed_dir(dir: PathBuf) { let _ = MANAGED_DIR.set(dir); }

/// Remember the folder the installer put FFmpeg in (`<resources>/binaries`). Called once at startup.
pub fn set_bundled_dir(dir: PathBuf) {
    let _ = BUNDLED_DIR.set(dir);
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn find_in_dirs(exe: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(exe)).find(|c| c.is_file())
}

pub fn locate_tool(name: &str, env_var: &str) -> AppResult<PathBuf> {

    if let Some(value) = env::var_os(env_var) {
        let path = PathBuf::from(value);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(AppError::ToolMissing(format!(
                "{env_var} points to {}, which is not a file",
                path.display()
            )))
        };
    }

    if let Some(dir) = MANAGED_DIR.get() { let candidate = dir.join(exe_name(name)); if candidate.is_file() { return Ok(candidate); } }
    if cfg!(debug_assertions) { let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(exe_name(name)); if candidate.is_file() { return Ok(candidate); } }
    let dirs = search_dirs(BUNDLED_DIR.get().map(PathBuf::as_path));
    let found = find_in_dirs(&exe_name(name), &dirs).ok_or_else(|| {
        AppError::ToolMissing(format!(
            "{name} not found. Reinstall SOCL Visuals Studio, install FFmpeg yourself, or set {env_var}."
        ))
    })?;
    make_executable(&found);
    Ok(found)
}

/// Where to look: the bundled folder first, then PATH, then the usual macOS folders.
fn search_dirs(bundled: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = bundled.map(Path::to_path_buf).into_iter().collect();
    if let Some(path) = env::var_os("PATH") {
        dirs.extend(env::split_paths(&path));
    }
    #[cfg(target_os = "macos")]
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    dirs
}

/// An installer or archive can lose the execute bit; give it back (best effort, Unix only).
fn make_executable(_path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(_path) {
            let mut perms = meta.permissions();
            if perms.mode() & 0o111 == 0 {
                perms.set_mode(perms.mode() | 0o755);
                let _ = std::fs::set_permissions(_path, perms);
            }
        }
    }
}

/// A `Command` that does not flash a console window on Windows.
pub fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_folder_is_searched_before_path() {
        let bundled = PathBuf::from("bundled-dir");
        let dirs = search_dirs(Some(&bundled));
        assert_eq!(dirs.first(), Some(&bundled));
        assert!(!search_dirs(None).contains(&bundled));
    }

    #[test]
    fn finds_executable_in_listed_dirs_only() {
        let dir = env::temp_dir().join(format!("cutvii-tools-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("faketool"), b"").unwrap();
        assert_eq!(
            find_in_dirs("faketool", std::slice::from_ref(&dir)),
            Some(dir.join("faketool"))
        );
        assert_eq!(find_in_dirs("missing", std::slice::from_ref(&dir)), None);
        std::fs::remove_dir_all(dir).ok();
    }
}


/// Prefer the user's explicit interpreter, then an installed Windows Python with the effect modules.
pub fn subject_python() -> String {
    if let Ok(value) = env::var("SOCL_PYTHON").or_else(|_| env::var("CUTVII_PYTHON")) { return value; }
    static PYTHON: OnceLock<String> = OnceLock::new();
    PYTHON.get_or_init(|| {
        #[cfg(windows)]
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            let base = PathBuf::from(local).join("Python");
            let mut candidates: Vec<PathBuf> = std::fs::read_dir(base).into_iter().flatten().filter_map(Result::ok)
                .map(|entry| entry.path().join("python.exe")).filter(|file| file.is_file()).collect();
            candidates.sort(); candidates.reverse();
            for candidate in candidates {
                if command(&candidate).args(["-c", "import mediapipe, cv2, numpy"]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().is_ok_and(|status| status.success()) {
                    return candidate.to_string_lossy().into_owned();
                }
            }
        }
        if cfg!(windows) { "py".to_owned() } else { "python3".to_owned() }
    }).clone()
}
