@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo 正在构建 Windows 安装包，请稍候...
call npm.cmd run build:win
if errorlevel 1 (
  echo.
  echo 构建失败，请检查上方错误信息。
  pause
  exit /b 1
)
echo.
echo 构建完成，安装包位于 release 目录。
pause
