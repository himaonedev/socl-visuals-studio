@echo off
setlocal
cd /d "%~dp0"
set "PATH=%~dp0.dev-tools\node-runtime;%PATH%"
"%~dp0.dev-tools\node-runtime\node.exe" "%~dp0.dev-tools\package\bin\npm-cli.js" %*

