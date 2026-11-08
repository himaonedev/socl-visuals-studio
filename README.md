# SOCL Visuals Studio — Clipping + Effects Studio

SOCL's existing clipping workspace and a React/Rust effects editor now live in the same Tauri application. The Effects Studio is adapted from the local CutVii fork, with SOCL Lime appearance and a shared Clipping → Edit effects → Export workflow. The Node clipping engine remains available during the gradual migration. The active app has no Electron runtime or license activation gate.

## Start

```powershell
pnpm tauri dev
```

The project-local fallback still works if global Node/nvm is not configured:

```powershell
.\run-dev.cmd
```

The first native build now includes local Whisper and text rendering. Keep the terminal open. The launcher limits Cargo to two jobs and detects the Ninja bundled with Windows Visual Studio. MSVC Embedded debug information avoids the PDB-manager mismatch observed with the installed toolchain. This changes only build environment/cache inside this project. It does not change Windows or Visual Studio settings.

## Workflow

1. Run the existing SOCL clipping pipeline or select an already-rendered clip in its gallery.
2. Click **Effects** (✦) in the SOCL sidebar. The currently selected rendered clip is imported into the effects timeline. If an editor project is already open, the clip is added to that project; choose New Project first when you want a separate project per clip. An empty selection opens the project home screen instead.
3. Select a video clip, then **Motion** for Freeze Highlight, moving styles, Facecam styles, or motion presets.
4. Create/import subtitle/text clips, then use **Text** for font/box styling, animated marker/strikethrough, and flicker. Subtitle style overrides during Halftone remain in its effect panel.
5. Save the editor project through its File menu, then Export the final video. Export creates a separate file; it does not replace the original clipping output.
6. The **← Clipping** button returns to SOCL. The editor project stays in memory while the app remains open. Save the project before quitting.

For fully editable captions, use a clip without subtitles already burned into the pixels, then create/import the captions as editor text tracks. The editor cannot remove burned-in captions from an imported video.

## Included editor features

- Freeze Highlight (up to 15 seconds) and moving styles; Halftone, black/white, character outline/zoom, paper outline and paper texture. Grid/Wave/Radial dots and audio accents.
- Original/solid/image backgrounds behind a segmented subject; image placement, size, slide/shake and animation speed.
- Ten facecam styles: Lean-in, Slow Push, Text Behind, Backdrop Word, Spotlight, Name Tag, Silhouette Intro, Bottom Fade, Glass Card/Counter, Freeze Sticker.
- Custom subtitle fonts/colours/boxes, rounded corners, per-word boxes, separate box rotation, Active Word/text-only highlighting and reusable presets.
- Subtitle style overrides during an effect, reverting to the previous look afterwards.
- Apple-style and directional text motion, bulk application and Copy/Paste Motion.
- Animated marker/strikethrough and Blink/Neon Flicker/Soft Pulse.
- Multitrack timeline, multi-selection, Alt-drag duplication, track locking, layer insertion/cleanup, undo/redo, canvas zoom/pan and resizable inspector.
- New/Open/Recent projects and the existing one-click theme collection, plus the default SOCL Lime palette.

Voice-over and AI upscaling were excluded from this integration. Subject-aware effects require the local Python/MediaPipe/OpenCV runtime used by the source editor; their controls check availability. The app detects an installed Windows Python with these modules, or accepts SOCL_PYTHON / CUTVII_PYTHON as an explicit interpreter path. Offline transcription models are downloaded on demand. AI service API keys remain the user's own.

## Development

- `frontend/main.tsx`: workspace routing and SOCL entry point.
- `frontend/editor-host.tsx`: theme/style isolation and selected-clip import.
- `frontend/editor/`: adapted editor components, project model, stores, timeline operations and effect controls.
- `frontend/legacy-events.ts`: keeps old global keyboard listeners from interfering with editor shortcuts.
- `src/`: existing SOCL clipping/caption UI and Node pipeline.
- `engine/`: JSON protocol, streaming network facade and scoped media preview server.
- `src-tauri/src/engine_host.rs`: Node engine ownership and IPC.
- `src-tauri/src/commands`, `media`, `export`, `project`: editor native backend.
- `src-tauri/assets`: text fonts and segmentation worker/model with license notices.
- `third-party/`: CutVii license and attribution. The original CutVii directory was not modified.
- `reference/electron/`: historical recovered files; not loaded or packaged.

```powershell
pnpm run typecheck
pnpm run test
pnpm run test:editor
pnpm run build
pnpm tauri build
```

Use npm-local.cmd with the same script names when pnpm/global Node is unavailable. public/, dist/, .dev-tools/ and native target folders contain generated artifacts. Edit frontend/ and src/ instead. Project files use the retained .cutvii editor format for compatibility with the source fork.

## Validation

89 editor/integration tests and four Node engine tests passed. Frontend type checking and production build passed. Native Rust/C++ checking passed from a temporary C: build mirror because the automation sandbox cannot canonicalize paths on D:. Five Rust effect tests (including real FFmpeg Halftone/audio rendering) and five Python facecam-frame tests also passed. The Python tests cover all ten facecam templates. A linked native build passed. Interactive GUI smoke checks passed for opening SOCL, entering Effects, choosing a canvas, creating a project and displaying the preview/library/inspector/timeline. Fixed CSS layer ordering after visual inspection. Exhaustive GUI effect/export validation and installer packaging have not been completed. The C: validation mirror disabled installer resources; it checked the native application build, not a packaged installer.



## Rust backend migration

19 legacy IPC operations now run in Rust, including settings/DPAPI, session metadata/history, watermark/cookies, native file dialogs, thumbnails and bundled-font geometry. Clipping and Effects share the Rust media server. Node is still required for the remaining original pipeline/tool/model/AI operations. See MIGRATION-RUST.md and run pnpm migration:status for the current channel inventory in MIGRATION-STATUS.json. This migration is not complete.
