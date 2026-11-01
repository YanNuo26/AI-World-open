@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  一键跑夜间全量回归（双击本文件；开着窗口别关，第二天看报告）
REM
REM  它会自己起服务器 → 依次跑 测试\ 下所有行为测试 → 每步落盘 →
REM  最后在 日志\夜间回归\最新报告.md 写一份结果表格。
REM
REM  常用变体（在命令行里跑更灵活）：
REM    node 测试\夜间回归.js --list             先看看会跑哪些
REM    node 测试\夜间回归.js --reset            跑之前把存档改名备份（干净世界）
REM    node 测试\夜间回归.js --only teach       只跑文件名带 teach 的
REM ============================================================
REM 兜底：把 Node 加进 PATH（已写进用户环境变量则无影响）
set "PATH=%PATH%;D:\App存储\NodeJS"
REM 切到项目根目录（本脚本在 脚本\ 里）
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 没找到 node：请先安装 Node.js，或把它加进 PATH（第 17 行）
  pause
  exit /b 1
)

echo 夜间回归开始，日志写在 日志\夜间回归\ 里。
echo 跑完会自动停掉它自己启动的服务器；中途别关窗口。
echo.
REM 想换参数就改这一行，例如加 --reset 或 --only teach,redstone
REM 默认 --reset：行为测试会把世界改得乱七八糟（房子 / 羊毛 / 拉杆 / 支撑方块），
REM 不重置的话"放置失败"会让一堆测试连挂好几晚（2026-11-01 就是这个坑）。
REM 它只会把 服务器\存档 改名成 服务器\存档_夜间备份_<时间>，不会删数据。
node 测试\夜间回归.js --reset

echo.
echo 回归结束（退出码 %errorlevel%），报告：日志\夜间回归\最新报告.md
pause
