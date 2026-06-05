@echo off
REM Wrapper so the installer build runs regardless of PowerShell execution
REM policy (.cmd files aren't gated by it). Forwards any args, e.g.:
REM   scripts\build_win_installer.cmd
REM   scripts\build_win_installer.cmd -SkipClean -Open
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_win_installer.ps1" %*
exit /b %ERRORLEVEL%
