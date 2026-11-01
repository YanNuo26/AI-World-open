@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  一键启动 AI-World 软件面板（双击本文件即可）
REM
REM  面板是个本地网页服务，只监听 127.0.0.1:8787，不会暴露到局域网。
REM  关掉这个窗口 = 关面板，并且会顺手停掉**面板自己启动**的服务器和 ai
REM  （服务器会先收到 stop，保证存档正常保存）。
REM ============================================================
REM 兜底：把 Node 加进 PATH（已写进用户环境变量则无影响）
set "PATH=%PATH%;D:\App存储\NodeJS"
REM 切到项目根目录（本脚本在 脚本\ 里）
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 node：请先安装 Node.js，或把它加进 PATH（第 12 行）
  pause
  exit /b 1
)

echo 正在启动面板…浏览器会自动打开（打不开就手动访问 http://127.0.0.1:8787/）
REM 换端口就改下面的 8787；不想自动开浏览器就加 --no-open
node 源码\panel\server.js --port 8787

echo.
echo 面板已退出。
pause
