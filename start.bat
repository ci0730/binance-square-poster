@echo off
chcp 65001 >nul
set "NODE="

REM 优先从系统 PATH 查找 node
where node >nul 2>&1
if %errorlevel%==0 (
  for /f "delims=" %%i in ('where node 2^>nul ^| findstr /i /v "cursor\\resources"') do (
    if not defined NODE set "NODE=%%i"
  )
)

REM 常见安装路径
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\node\node.exe" set "NODE=%LOCALAPPDATA%\Programs\node\node.exe"
if not defined NODE if exist "D:\cursor\cursor\resources\app\resources\helpers\node.exe" set "NODE=D:\cursor\cursor\resources\app\resources\helpers\node.exe"
if not defined NODE if exist "C:\cursor\cursor\resources\app\resources\helpers\node.exe" set "NODE=C:\cursor\cursor\resources\app\resources\helpers\node.exe"

if not defined NODE (
  echo [错误] 未找到 Node.js
  echo.
  echo 请确认已安装 Node.js 并重新打开此窗口后再试。
  echo 下载地址: https://nodejs.org
  echo.
  echo 也可以手动在 PowerShell 中运行:
  echo   cd /d "%~dp0"
  echo   node server.js
  pause
  exit /b 1
)

cd /d "%~dp0"

REM 检查端口是否已被占用（说明服务已在运行）
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'http://localhost:3456/api/config' -TimeoutSec 2 -UseBasicParsing).StatusCode } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
  echo 检测到端口 3456 已有服务在运行。
  echo.
  echo 如果刚修改过代码，需要先重启服务才能生效：
  echo   Get-NetTCPConnection -LocalPort 3456 ^| %% { Stop-Process -Id $_.OwningProcess -Force }
  echo 然后重新运行 start.bat
  echo.
  echo 若无需重启，直接在浏览器打开: http://localhost:3456
  pause
  exit /b 0
)

echo 使用 Node: %NODE%
echo.
echo 正在启动币安广场批量发帖工具...
echo 浏览器打开: http://localhost:3456
echo 按 Ctrl+C 可停止服务
echo.
"%NODE%" server.js
pause
