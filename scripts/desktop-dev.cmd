@echo off
setlocal

set "VSVARS=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if exist "%VSVARS%" (
  call "%VSVARS%" >nul
)

set "PATH=%ProgramFiles%\nodejs;%USERPROFILE%\.cargo\bin;%PATH%"
cd /d "%~dp0.."
node scripts\prepare-webview2.mjs --check
if errorlevel 1 exit /b 1
if /i "%~1"=="--check" exit /b 0
pnpm.cmd desktop
