@echo off
setlocal
cd /d "%~dp0"
set "VSVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VSVARS%" call "%VSVARS%" >nul
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%USERPROFILE%\.cargo\bin;%PATH%"
set "CARGO_NET_OFFLINE=true"
if exist "%~dp0.tmp\cargo-home\registry" set "CARGO_HOME=%~dp0.tmp\cargo-home"
if exist "%~dp0.tmp\insert-target" set "CARGO_TARGET_DIR=%~dp0.tmp\insert-target"
node scripts\prepare-webview2.mjs --check
if errorlevel 1 exit /b 1
echo Starting the Online test app. No installer will be created.
call pnpm.cmd tauri dev --config src-tauri/tauri.demo.conf.json --no-watch
exit /b %ERRORLEVEL%
