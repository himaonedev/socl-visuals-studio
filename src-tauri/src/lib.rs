// Newer clippy (1.99) wants `as_chunks` instead of `chunks_exact(N)`; it needs Rust 1.88, and the README
// says 1.85+, so the lint is allowed (the older toolchains do not know it yet).
#![allow(unknown_lints, clippy::chunks_exact_to_as_chunks)]

use tauri::Manager;

mod engine_host;
mod app_icon;
mod legacy_native;
mod legacy_whisper;
mod legacy_settings;
mod legacy_files;
mod legacy_desktop;
mod legacy_fonts;
mod commands;
mod errors;
mod export;
mod media;
mod project;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // A panic that does take the app down leaves only "abort() called" in the crash report, so keep
    // the message and location in a file the user can send.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::temp_dir().join("socl-visuals-panic.log"))
        {
            let _ = writeln!(file, "{info}");
        }
        previous(info);
    }));
    let mut context = tauri::generate_context!();
    context.set_default_window_icon(Some(app_icon::window_icon().expect("invalid bundled SOCL icon")));
    let desktop = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::project::CurrentProjectPath::default())
        .manage(commands::export::ExportJob::default())
        .manage(commands::export::LastExport::default())
        .manage(commands::export::BatchFolder::default())
        .manage(commands::drop::DropState::default())
        .manage(commands::ai::AiJob::default())
        .manage(commands::transcript::TranscriptGrants::default())
        .manage(commands::recent::RecentProjects::default())
        .setup(|app| {
            if let (Some(window), Some(icon)) = (app.get_webview_window("main"), app.default_window_icon()) {
                window.set_icon(icon.clone())?;
            }
            engine_host::install(app.handle())?;
            commands::recent::load(app.handle());
            if let Ok(dir) = app.path().app_data_dir() { media::tools::set_managed_dir(dir.join("bin")); }
            commands::clip_tools::load_fonts(app.handle());
            commands::media_server::start(app.handle());
            if let Ok(dir) = app.path().resource_dir() {
                media::tools::set_bundled_dir(dir.join("binaries"));
            }
            Ok(())
        })

        // OS file drags arrive as *window* events (the webview-event hook never sees them).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drag) = event {
                let scale = window.scale_factor().unwrap_or(1.0);
                commands::drop::handle_drag_drop(window.app_handle(), drag, scale);
            }
        })
        .invoke_handler(tauri::generate_handler![
            engine_host::engine_info, engine_host::engine_invoke, engine_host::native_reply, engine_host::native_action,
            commands::media::import_socl_clip,
            commands::export::export_project,
            commands::export::apply_socl_effects,
            commands::export::cancel_export,
            commands::export::export_clips,
            commands::export::choose_clips_folder,
            commands::export::reveal_last_export,
            commands::drop::import_dropped_file,
            commands::clip_tools::prepare_reverse_preview,
            commands::clip_tools::extract_freeze_frame,
            commands::freeze_highlight::prepare_freeze_highlight,
            commands::moving_highlight::highlight_runtime,
            commands::facecam::prepare_facecam_style,
            commands::clip_tools::prepare_image_preview,
            commands::clip_tools::prepare_waveform,
            commands::clip_tools::render_text,
            commands::text_marker::prepare_text_marker,
            commands::clip_tools::text_style_preview,
            commands::clip_tools::bake_color_lut,
            commands::clip_tools::look_previews,
            commands::clip_tools::export_color_preset,
            commands::clip_tools::import_color_presets,
            commands::clip_tools::import_color_luts,
            commands::clip_tools::color_luts,
            commands::clip_tools::delete_color_lut,
            commands::clip_tools::open_lyrics_file,
            commands::clip_tools::open_srt_file,
            commands::clip_tools::export_srt,
            commands::clip_tools::split_captions,
            commands::clip_tools::text_line_counts,
            commands::support::open_support_link,
            commands::update::check_for_update,
            commands::update::open_release_page,
            commands::clip_tools::make_instrumental,
            commands::clip_tools::audio_clean_sample,
            commands::clip_tools::export_text_style,
            commands::clip_tools::import_text_styles,
            commands::clip_tools::export_style_pack,
            commands::clip_tools::open_style_pack,
            commands::drop::read_dropped_pack,
            commands::ai::whisper_models,
            commands::ai::download_whisper_model,
            commands::ai::cancel_ai_job,
            commands::ai::delete_whisper_model,
            commands::ai::transcribe_media,
            commands::clipper::find_clips_in_media,
            commands::transcript::choose_transcript_file,
            commands::transcript::inspect_transcript,
            commands::transcript::find_transcripts_near,            commands::clip_tools::media_details,
            commands::clip_tools::reveal_media,
            commands::clip_tools::text_fonts,
            commands::clip_tools::import_text_font,
            commands::media::import_media,
            commands::media_server::media_server_url,
            commands::media::relink_media,
            commands::media::pick_image,
            commands::project::open_project,
            commands::project::open_recent_project,
            commands::recent::recent_projects,
            commands::finishing::detect_clip_silences,
            commands::finishing::save_clip_projects,
            commands::subject::subject_runtime,
            commands::subject::process_subject,
            commands::project::save_project,
            commands::project::forget_project_path
        ])
        .build(context)
        .expect("error while running SOCL Visuals Studio");
    desktop.run(|app, event| { if matches!(event, tauri::RunEvent::Exit) { engine_host::shutdown(app); } });
}

