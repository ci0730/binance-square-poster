@echo off
chcp 65001 >nul
title 币安广场批量发帖

set PORT=3456
set URL=http://127.0.0.1:%PORT%

where node >nul 2>&1
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node.js 18 或更高版本。
  pause
  exit /b 1
)

cd /d "%~dp0"

echo 正在启动本地服务...
start "" /B node server.js

echo 等待服务就绪...
set /a RETRY=0
:wait_loop
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing '%URL%/api/config' -TimeoutSec 2).StatusCode -eq 200 | Out-Null; exit 0 } catch { exit 1 }"
if %errorlevel%==0 goto open_app
set /a RETRY+=1
if %RETRY% GEQ 30 (
  echo 启动超时，请检查 %PORT% 端口是否被占用。
  pause
  exit /b 1
)
timeout /t 1 /nobreak >nul
goto wait_loop

:open_app
echo 正在打开应用窗口...

set "APP_CMD="
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  set "APP_CMD=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe --app=%URL% --window-size=1360,920"
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  set "APP_CMD=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe --app=%URL% --window-size=1360,920"
) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
  set "APP_CMD=%LocalAppData%\Google\Chrome\Application\chrome.exe --app=%URL% --window-size=1360,920"
) else (
  start "" "%URL%"
  echo 已在默认浏览器中打开。关闭本窗口不会停止后台服务。
  pause
  exit /b 0
)

start "" %APP_CMD%
echo.
echo 应用已启动。关闭本窗口不会停止后台服务。
echo 如需停止，请在任务管理器中结束 node.exe 进程。
pause
