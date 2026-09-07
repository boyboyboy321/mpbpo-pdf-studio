@echo off
setlocal
call "%~dp0scripts\desktop-dev.cmd" %*
if errorlevel 1 pause
