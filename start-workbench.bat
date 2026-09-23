@echo off
rem ============================================================
rem  Start the workbench (web UI on 3939 + parser worker)
rem  Double-click this file. Close the "video-script-agent"
rem  window (or run stop-workbench.bat) to stop everything.
rem
rem  Usage: start-workbench.bat [clean]
rem    clean = drop the .next build cache first (use this if the
rem            web window errors out right after starting)
rem ============================================================
setlocal
cd /d "%~dp0"

rem --- zero-friction guards: give a human-readable hint instead of raw errors ---
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo [fail] 这台电脑还没有安装 Node.js。
  echo        请打开浏览器访问  https://nodejs.org/zh-cn  ，
  echo        下载 22 LTS（长期支持版）安装包，双击一路「下一步」装完，
  echo        装好后重新双击本脚本即可。
  echo.
  pause
  exit /b 1
)

if /i "%~1"=="clean" (
  echo [setup] removing .next build cache ...
  if exist ".next" rmdir /s /q ".next"
)

if not exist "node_modules" (
  echo [setup] node_modules not found - running npm install ...
  echo         （首次安装约 1~3 分钟，请耐心等待）
  call npm install
  if errorlevel 1 goto :fail
)

if not exist ".env" (
  echo [setup] .env not found - copying from .env.example ...
  copy /y ".env.example" ".env" >nul
)

if not exist "node_modules\.prisma\client" (
  echo [setup] prisma client not found - running npm run setup ...
  call npm run setup
  if errorlevel 1 goto :fail
)

rem --- playwright chromium: needed for Tencent Muse link fetching / QR login ---
if not exist "%LOCALAPPDATA%\ms-playwright" (
  echo [setup] browser engine for link fetching not found - downloading ...
  echo         （约 150MB，只需要这一次，请耐心等待）
  call npx playwright install chromium
  if errorlevel 1 goto :fail
)

echo [start] launching web (3939) + parser worker + avatar worker ...
start "video-script-agent" cmd /k "npm run dev"

echo [wait ] waiting for http://127.0.0.1:3939 ...
set /a tries=0
:wait
set /a tries+=1
powershell -NoProfile -Command "try{ $r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3939/login' -TimeoutSec 3; exit 0 }catch{ exit 1 }" >nul 2>&1
if not errorlevel 1 goto :open
if %tries% geq 60 goto :fail
timeout /t 2 /nobreak >nul
goto :wait

:open
echo [ready] opening http://127.0.0.1:3939 in your browser ...
start "" "http://127.0.0.1:3939"
echo.
echo   Running. Login with the account configured in .env (see README 3.1)
echo   To stop: close the "video-script-agent" window, or run stop-workbench.bat
timeout /t 6 /nobreak >nul
exit /b 0

:fail
echo.
echo [fail] startup failed or timed out.
echo        Check the "video-script-agent" window for the error message.
pause
exit /b 1
