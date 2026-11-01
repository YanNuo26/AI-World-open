@echo off
chcp 936 >nul
REM ============================================================
REM  启动 Minecraft 服务器（并修好中文日志乱码）
REM
REM  乱码原因：JDK 18+ 默认用 UTF-8 写日志，而 Windows 中文环境的
REM  控制台/日志窗口按 GBK 解码，于是中文变成 "鏁欏鐢熷宸蹭繚" 这种乱码。
REM  这里强制 JVM 按 GBK 输出即可正常显示。
REM
REM  如果你是用 PCL 启动服务器的，这个 bat 用不上 —— 请到 PCL 的
REM  服务器设置里把下面这串填进「JVM 参数」：
REM      -Dfile.encoding=GBK -Dsun.stdout.encoding=GBK -Dsun.stderr.encoding=GBK
REM ============================================================

set JAVA_TOOL_OPTIONS=-Dfile.encoding=GBK -Dsun.stdout.encoding=GBK -Dsun.stderr.encoding=GBK

echo Starting server...
REM 服务器相关文件都在 <项目根>\服务器 里
cd /d "%~dp0..\服务器"
java -Xms1G -Xmx2G -Dfile.encoding=GBK -Dsun.stdout.encoding=GBK -Dsun.stderr.encoding=GBK -jar server.jar --nogui
pause
