@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
call "%~dp0npm-local.cmd" run tauri:dev
if errorlevel 1 pause
