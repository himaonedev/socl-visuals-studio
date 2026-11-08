//! Recent projects for the editor home screen, kept in the app's data folder.
//! The webview only ever names an entry by its index; the path comes from this list, so it
//! can still never ask for an arbitrary file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager};

pub const MAX_RECENT: usize = 10;
const STORE_FILE: &str = "recent-projects.json";
const MAX_STORE_BYTES: u64 = 64 * 1024;

#[derive(Default)]
pub struct RecentProjects {
    pub paths: Mutex<Vec<PathBuf>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    index: usize,
    name: String,
    path: String,
    exists: bool,
    modified_at: Option<u64>,
}

fn describe(paths: &[PathBuf]) -> Vec<RecentProject> {
    paths
        .iter()
        .enumerate()
        .map(|(index, path)| {
            let metadata = std::fs::metadata(path).ok();
            RecentProject {
                index,
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| label(path)),
                path: path.to_string_lossy().into_owned(),
                exists: metadata.as_ref().is_some_and(|m| m.is_file()),
                modified_at: metadata
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs()),
            }
        })
        .collect()
}

/// Describe only the backend-owned recent list. Opening still resolves its index in Rust.
#[tauri::command]
pub fn recent_projects(state: tauri::State<'_, RecentProjects>) -> Vec<RecentProject> {
    let paths = state.paths.lock().unwrap().clone();
    describe(&paths)
}

/// `list` with `path` moved (or added) to the front, at most `MAX_RECENT` long.
pub fn remembered(list: &[PathBuf], path: &Path) -> Vec<PathBuf> {
    let mut next = vec![path.to_path_buf()];
    next.extend(list.iter().filter(|p| p.as_path() != path).cloned());
    next.truncate(MAX_RECENT);
    next
}

/// Read a stored list. The file is untrusted input: anything that is not a short list of absolute paths
/// is dropped.
pub fn parse(text: &str) -> Vec<PathBuf> {
    let Ok(items) = serde_json::from_str::<Vec<String>>(text) else {
        return Vec::new();
    };
    let mut list: Vec<PathBuf> = Vec::new();
    for item in items {
        let path = PathBuf::from(&item);
        if item.len() <= 4096 && path.is_absolute() && !list.contains(&path) {
            list.push(path);
        }
        if list.len() == MAX_RECENT {
            break;
        }
    }
    list
}

/// A recent project's display label: its file name and parent folder.
pub fn label(path: &Path) -> String {
    let name = path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    match path.parent().and_then(|p| p.file_name()) {
        Some(folder) => format!("{name}  —  {}", folder.to_string_lossy()),
        None => name,
    }
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(STORE_FILE))
}

fn write(app: &AppHandle, list: &[PathBuf]) {
    let Some(file) = store_path(app) else { return };
    let names: Vec<String> = list
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if let (Some(dir), Ok(json)) = (file.parent(), serde_json::to_string_pretty(&names)) {
        // not being able to remember recent projects must never get in the way of opening or saving
        std::fs::create_dir_all(dir).ok();
        std::fs::write(&file, json).ok();
    }
}

/// Read the stored list into the app state (at startup).
pub fn load(app: &AppHandle) {
    let Some(state) = app.try_state::<RecentProjects>() else {
        return;
    };
    let list = store_path(app)
        .filter(|f| std::fs::metadata(f).is_ok_and(|m| m.len() <= MAX_STORE_BYTES))
        .and_then(|f| std::fs::read_to_string(f).ok())
        .map(|text| parse(&text))
        .unwrap_or_default();
    *state.paths.lock().unwrap() = list;
}

fn change(app: &AppHandle, edit: impl FnOnce(&[PathBuf]) -> Vec<PathBuf>) {
    let Some(state) = app.try_state::<RecentProjects>() else {
        return;
    };
    let next = {
        let mut paths = state.paths.lock().unwrap();
        *paths = edit(&paths);
        paths.clone()
    };
    write(app, &next);
}

/// A project was opened or saved at `path`: it goes to the top of Open Recent.
pub fn remember(app: &AppHandle, path: &Path) {
    change(app, |list| remembered(list, path));
}

/// `path` can no longer be opened: take it out of Open Recent.
pub fn forget(app: &AppHandle, path: &Path) {
    change(app, |list| {
        list.iter()
            .filter(|p| p.as_path() != path)
            .cloned()
            .collect()
    });
}

pub fn path_at(app: &AppHandle, index: usize) -> Option<PathBuf> {
    let state = app.try_state::<RecentProjects>()?;
    let paths = state.paths.lock().unwrap();
    paths.get(index).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_cards_preserve_indices_and_report_file_metadata_and_missing_paths() {
        let existing = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let missing = existing.with_file_name("missing-home-test-project.cutvii");
        let cards = describe(&[existing.clone(), missing.clone()]);
        assert_eq!(cards[0].index, 0);
        assert_eq!(cards[0].name, "Cargo");
        assert_eq!(cards[0].path, existing.to_string_lossy());
        assert!(cards[0].exists);
        assert!(cards[0].modified_at.is_some());
        assert_eq!(cards[1].index, 1);
        assert!(!cards[1].exists);
        assert!(cards[1].modified_at.is_none());
        let json = serde_json::to_value(&cards[0]).unwrap();
        assert!(json.get("modifiedAt").is_some());
    }

    fn p(s: &str) -> PathBuf {
        PathBuf::from(abs(s))
    }

    /// "/a/x" is only absolute on Unix; Windows needs a drive letter.
    fn abs(s: &str) -> String {
        if cfg!(windows) {
            format!("C:{s}")
        } else {
            s.to_string()
        }
    }

    #[test]
    fn the_newest_project_is_first_without_duplicates_and_the_list_stays_short() {
        let list = remembered(
            &[p("/a/one.cutvii"), p("/a/two.cutvii")],
            &p("/a/two.cutvii"),
        );
        assert_eq!(list, [p("/a/two.cutvii"), p("/a/one.cutvii")]);
        let mut long = Vec::new();
        for i in 0..15 {
            long = remembered(&long, &p(&format!("/a/{i}.cutvii")));
        }
        assert_eq!(long.len(), MAX_RECENT);
        assert_eq!(long[0], p("/a/14.cutvii"));
        assert_eq!(long[9], p("/a/5.cutvii"));
    }

    #[test]
    fn a_stored_list_is_read_as_untrusted_input() {
        assert_eq!(
            parse(&format!(
                r#"["{0}", "relative.cutvii", "{0}", "{1}"]"#,
                abs("/a/one.cutvii"),
                abs("/b/two.cutvii")
            )),
            [p("/a/one.cutvii"), p("/b/two.cutvii")]
        );
        assert!(parse("not json").is_empty());
        assert!(parse(r#"{"paths": []}"#).is_empty());
        assert!(parse(r#"[1, 2]"#).is_empty());
        let many: Vec<String> = (0..50).map(|i| abs(&format!("/a/{i}.cutvii"))).collect();
        assert_eq!(
            parse(&serde_json::to_string(&many).unwrap()).len(),
            MAX_RECENT
        );
        let long = format!("[\"{}\"]", abs(&format!("/{}", "x".repeat(5000))));
        assert!(parse(&long).is_empty());
    }

    #[test]
    fn labels_show_name_and_folder() {
        assert_eq!(label(&p("/Users/me/Films/Trip.cutvii")), "Trip  —  Films");
    }
}
