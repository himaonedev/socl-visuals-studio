//! Auto-clips finishing: audio pause detection and independent editable projects.
use super::clip_tools::allowed_source;
use super::export::{BatchFolder, BatchItem, batch_file_names};
use crate::errors::{AppError, AppResult};
use crate::media::tools::{FFMPEG_ENV, command, locate_tool};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[derive(Debug, Serialize, PartialEq)]
pub struct Silence {
    pub start: f64,
    pub end: f64,
}

fn silence_ranges(log: &str, offset: f64, duration: f64) -> Vec<Silence> {
    let mut start = None;
    let mut ranges = Vec::new();
    for line in log.lines() {
        for (marker, is_start) in [("silence_start:", true), ("silence_end:", false)] {
            if let Some(text) = line.split(marker).nth(1)
                && let Some(value) = text
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse::<f64>().ok())
                && value.is_finite()
            {
                let t = value.clamp(0.0, duration);
                if is_start {
                    start = Some(t);
                } else if let Some(from) = start.take()
                    && t > from
                {
                    ranges.push(Silence {
                        start: offset + from,
                        end: offset + t,
                    });
                }
            }
        }
    }
    if let Some(from) = start
        && duration > from
    {
        ranges.push(Silence {
            start: offset + from,
            end: offset + duration,
        });
    }
    ranges
}

#[tauri::command]
pub async fn detect_clip_silences(
    app: AppHandle,
    path: String,
    source_in: f64,
    source_out: f64,
) -> AppResult<Vec<Silence>> {
    let source = allowed_source(&app, &path)?;
    if !source_in.is_finite()
        || !source_out.is_finite()
        || source_in < 0.0
        || source_out <= source_in
        || source_out - source_in > 86400.0
    {
        return Err(AppError::InvalidInput(
            "invalid silence-detection range".into(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let ffmpeg = locate_tool("ffmpeg", FFMPEG_ENV)?;
        let output = command(&ffmpeg)
            .args([
                "-hide_banner",
                "-nostdin",
                "-ss",
                &source_in.to_string(),
                "-t",
                &(source_out - source_in).to_string(),
                "-i",
            ])
            .arg(source)
            .args([
                "-vn",
                "-af",
                "silencedetect=noise=-35dB:d=0.6",
                "-f",
                "null",
                "-",
            ])
            .output()?;
        if !output.status.success() {
            return Err(AppError::InvalidInput(
                "could not analyse silence in this audio track".into(),
            ));
        }
        Ok(silence_ranges(
            &String::from_utf8_lossy(&output.stderr),
            source_in,
            source_out - source_in,
        ))
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("silence detection failed: {e}")))?
}

#[derive(Serialize)]
pub struct SavedProjects {
    folder: String,
    paths: Vec<String>,
}

#[tauri::command]
pub async fn save_clip_projects(
    app: AppHandle,
    chosen: State<'_, BatchFolder>,
    items: Vec<BatchItem>,
) -> AppResult<SavedProjects> {
    if items.is_empty() || items.len() > 50 {
        return Err(AppError::InvalidInput("choose 1 to 50 clips".into()));
    }
    let folder = chosen
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| AppError::InvalidInput("choose a folder first".into()))?;
    for item in &items {
        crate::project::validate(&item.project)
            .map_err(|e| AppError::InvalidInput(e.join("; ")))?;
        for asset in &item.project.assets {
            allowed_source(&app, &asset.path)?;
        }
    }
    let destination = folder.clone();
    let paths = tauri::async_runtime::spawn_blocking(move || {
        let titles: Vec<String> = items.iter().map(|i| i.title.clone()).collect();
        let names = batch_file_names(&titles, "cutvii", &|name| destination.join(name).exists());
        let mut paths: Vec<PathBuf> = Vec::new();
        for (item, name) in items.iter().zip(names) {
            let path = destination.join(name);
            // Reserve each filename without overwriting existing projects.
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            drop(file);
            if let Err(error) =
                crate::project::persistence::write_project_atomic(&path, &item.project)
            {
                std::fs::remove_file(&path).ok();
                return Err(error);
            }
            paths.push(path);
        }
        AppResult::Ok(paths)
    })
    .await
    .map_err(|e| AppError::InvalidInput(format!("saving projects failed: {e}")))??;
    for path in &paths {
        super::recent::remember(&app, path);
    }
    Ok(SavedProjects {
        folder: folder.to_string_lossy().into_owned(),
        paths: paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_absolute_ranges_and_an_unclosed_trailing_pause() {
        assert_eq!(
            silence_ranges(
                "[x] silence_start: 1.0\n[x] silence_end: 2.2 | silence_duration: 1.2\n[x] silence_start: 4",
                10.0,
                5.0
            ),
            vec![
                Silence {
                    start: 11.0,
                    end: 12.2
                },
                Silence {
                    start: 14.0,
                    end: 15.0
                }
            ]
        );
        assert!(silence_ranges("silence_start: NaN", 0.0, 5.0).is_empty());
    }
}
