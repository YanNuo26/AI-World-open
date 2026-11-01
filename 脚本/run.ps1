# One-click launcher: start local server -> wait -> run AI -> close server on exit
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $dir          # 项目根
$botJs = Join-Path $root "源码\bot.js"    # ai 主程序
# 服务器的一切都在 <项目根>/服务器 里
Set-Location (Join-Path $root "服务器")
$env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")

$PORT = 25565

function Wait-Server {
  param($Timeout)
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
    Write-Host "Waiting for server... ($elapsed s)"
  }
  return $false
}

# If a server is already running, just start the AI
if (Wait-Server 5) {
  Write-Host "Server already running, starting AI builder..."
  try { & node $botJs } finally { Write-Host "AI exited." }
  exit 0
}

# 1) Download a fixed Minecraft version that is compatible with Java 21.
#    (The newest releases require Java 25+, which is not installed here.)
$MC_VERSION = "1.21.1"
$verFile = "server-version.txt"
$needDownload = $true
if ((Test-Path "server.jar") -and (Test-Path $verFile) -and ((Get-Content $verFile -Raw).Trim() -eq $MC_VERSION)) {
  $needDownload = $false
}
if ($needDownload) {
  Write-Host "Fetching version manifest..."
  $manifest = Invoke-RestMethod "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
  $ver = $manifest.versions | Where-Object { $_.id -eq $MC_VERSION }
  if (-not $ver) { Write-Error "Version $MC_VERSION not found in manifest"; exit 1 }
  $meta = Invoke-RestMethod $ver.url
  Write-Host "Downloading Minecraft server $MC_VERSION ..."
  Invoke-WebRequest $meta.downloads.server.url -OutFile "server.jar"
  $MC_VERSION | Set-Content $verFile
}

# 2) First launch to generate config files (exits because EULA not accepted yet)
if (-not (Test-Path "eula.txt")) {
  Write-Host "First launch to generate config..."
  java -jar server.jar --nogui
}

# 3) Accept EULA + set creative mode + offline mode
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
$lines | Set-Content "server.properties"

# Force a flat world: remove any previously generated (non-flat) world once,
# so the new level-type=flat actually takes effect.
if (-not (Test-Path "flat_initialized.txt")) {
  if (Test-Path "存档") { Remove-Item "存档" -Recurse -Force }
  "ok" | Set-Content "flat_initialized.txt"
}

# 4) Start server in a background window
Write-Host "Starting Minecraft server (background window)..."
$server = Start-Process -FilePath "java" -ArgumentList "-Xms1G", "-Xmx2G", "-jar", "server.jar", "--nogui" -PassThru

# 5) Wait until port is ready
if (-not (Wait-Server 180)) {
  Write-Error "Server start timeout, check the server window log"
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

# Give the server time to finish generating the spawn area before the bot logs in
Write-Host "Server port open. Waiting for world to load (20s)..."
Start-Sleep -Seconds 20

Write-Host "Server ready. Starting AI builder (Ctrl+C to exit, server will be closed)..."
try {
  & node $botJs
} finally {
  Write-Host "Shutting down server..."
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
}
