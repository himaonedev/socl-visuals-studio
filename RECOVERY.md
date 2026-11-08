> Historical recovery note. The active project has since migrated to Tauri phase 1; see README.md for current setup.

# SOCL Visuals Studio — recovered codebase

Recovered from the installed app.asar and app.asar.unpacked on 2026-11-01.
Version: 2.4.41. All 500 archive entries were extracted and checked for size; SHA-256 was checked wherever supplied by the archive. The installed application was not modified.

## Entry points

- package.json: recovered application metadata, dependencies, src/main.js entry point.
- src/main.js: Electron main process and IPC handlers (obfuscated).
- src/preload.js: API exposed to the renderer.
- src/index.html, src/renderer.js, src/styles.css: main interface.
- src/pipeline-inverse-v1.js: processing pipeline.
- src/*.js and src/*.py: supporting modules.
- assets/: fonts, graphics and other application resources.
- node_modules/: dependencies shipped with the installed application, including unpacked binaries.

## Development status

This is the shipped code, not a reconstruction of the original development repository. Some JavaScript is obfuscated. Original variable names, build configuration, tests, Git history and development scripts may not be recoverable. Application source maps were not found.

The recovered package.json has no start/build scripts or Electron development dependency. Electron 33.4.11 is referenced in its allowScripts metadata, but a working runtime version has not been verified. A normal development setup will need a working Node.js installation (package requires >=18), Electron, and explicit development/build scripts. The node command currently resolves to an nvm shim with no active version configured.

The extracted application has not been launched, and startup, external services, licensing, downloads and media processing have not been tested. This extraction does not alter licensing or integrity checks. Establish a baseline before changing application logic.

Suggested next work: make the three large main/renderer/pipeline modules readable, map IPC calls using preload.js, set up an isolated development launch, and implement the requested feature against that baseline.

