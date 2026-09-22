@echo off
rem ============================================================
rem  Stop the workbench (web UI + parser worker)
rem ============================================================
setlocal
cd /d "%~dp0"

echo [stop] closing the "video-script-agent" window ...
taskkill /FI "WINDOWTITLE eq video-script-agent*" /T /F >nul 2>&1

rem --- keep the parser worker PID read on its own line (batch expands %VAR% per line) ---
set "WPID="
if exist "data\worker.lock" set /p WPID=<"data\worker.lock"
if defined WPID echo [stop] killing parser worker PID %WPID% ...
if defined WPID taskkill /PID %WPID% /T /F >nul 2>&1

set "APID="
if exist "data\avatar-worker.lock" set /p APID=<"data\avatar-worker.lock"
if defined APID echo [stop] killing avatar worker PID %APID% ...
if defined APID taskkill /PID %APID% /T /F >nul 2>&1

echo [stop] freeing port 3939 ...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3939" ^| findstr "LISTENING"') do taskkill /PID %%p /T /F >nul 2>&1

echo [done] stopped.
timeout /t 4 /nobreak >nul
exit /b 0
