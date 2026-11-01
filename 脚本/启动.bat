@echo off
chcp 65001 >nul
setlocal
REM 兜底：把 Node 和 Java 目录加入 PATH（如已写入用户环境变量则无影响）
set "PATH=%PATH%;D:\App存储\NodeJS;D:\App存储\Java\bin"
REM 切到本脚本所在目录
cd /d "%~dp0"
REM 用 Bypass 策略运行一键脚本（下载/启动服务器 + 启动 AI）
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0run.ps1"
pause
