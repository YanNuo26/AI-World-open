$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
# 服务器的一切（server.jar / eula / 存档 / logs…）都在 <项目根>/服务器 里
Set-Location (Join-Path $dir "..\服务器")
$env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")

$PORT = 25565
function Wait-Server ($Timeout) {
  $elapsed = 0
  while ($elapsed -lt $Timeout) {
    try {
      $c = New-Object System.Net.Sockets.TcpClient
      $c.Connect("127.0.0.1", $PORT)
      $c.Close()
      return $true
    } catch {}
    Start-Sleep -Seconds 2
    $elapsed += 2
  }
  return $false
}

if (Wait-Server 5) {
  Write-Host "Server already running."
  exit 0
}

# ensure eula + creative + offline + flat
if (-not (Test-Path "eula.txt")) {
  Write-Host "Generating config..."
  java -jar server.jar --nogui
}
(Get-Content "eula.txt") -replace "eula=false", "eula=true" | Set-Content "eula.txt"
function Ensure-Prop($lines, $key, $val) {
  $hit = $false
  $out = $lines | ForEach-Object { if ($_ -match "^$key=") { $hit = $true; "$key=$val" } else { $_ } }
  if (-not $hit) { $out += "$key=$val" }
  return $out
}
$lines = Get-Content "server.properties"
$lines = Ensure-Prop $lines "gamemode" "creative"
$lines = Ensure-Prop $lines "online-mode" "false"
$lines = Ensure-Prop $lines "level-type" "flat"
# 关掉出生点保护：否则非 op 玩家在世界出生点 16 格内无法放置方块
# （建造/录制往往就在出生点附近，会被服务器静默拒绝）
$lines = Ensure-Prop $lines "spawn-protection" "0"
# 开 RCON：机器人要用它连到控制台给玩家 op（bot 自己是玩家，没法自己 op）
$lines = Ensure-Prop $lines "enable-rcon" "true"
$lines = Ensure-Prop $lines "rcon.password" "minecraft"
$lines = Ensure-Prop $lines "rcon.port" "25575"
$lines | Set-Content "server.properties"

if (-not (Test-Path "flat_initialized.txt")) {
  if (Test-Path "存档") { Remove-Item "存档" -Recurse -Force }
  "ok" | Set-Content "flat_initialized.txt"
}

Write-Host "Starting server (background)..."
# 中文日志乱码修复：
# JDK 18+ 默认用 UTF-8 写 stdout，而 Windows 中文环境的控制台/日志窗口按 **GBK** 解码，
# 于是中文变成 "澶嶇幇瀹屾垚" 这种 UTF-8 被当 GBK 读的乱码（文件本身其实是好的）。
# 这里让 JVM 直接按 GBK 输出，日志窗口就能正常显示中文。
# 若你的查看器是 UTF-8 的，把下面的 GBK 换成 UTF-8 即可。
$enc = "GBK"
$env:JAVA_TOOL_OPTIONS = "-Dfile.encoding=$enc -Dsun.stdout.encoding=$enc -Dsun.stderr.encoding=$enc"
$server = Start-Process -FilePath "java" -ArgumentList "-Xms1G", "-Xmx2G", "-Dfile.encoding=$enc", "-Dsun.stdout.encoding=$enc", "-Dsun.stderr.encoding=$enc", "-jar", "server.jar", "--nogui" -PassThru -RedirectStandardOutput "server_diag.log" -RedirectStandardError "server_diag.err"

if (-not (Wait-Server 180)) {
  Write-Error "Server start timeout"
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  exit 1
}
Write-Host "Server ready. Waiting 20s for world load..."
Start-Sleep -Seconds 20
Write-Host "DONE server ready (pid $($server.Id))"
