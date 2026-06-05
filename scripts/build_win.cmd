@echo off
REM Wrapper so the local build runs regardless of PowerShell execution
REM policy (.cmd files aren't gated by it). Forwards any args, e.g.:
REM   scripts\build_win.cmd
REM   scripts\build_win.cmd -Run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_win.ps1" %*
exit /b %ERRORLEVEL%
