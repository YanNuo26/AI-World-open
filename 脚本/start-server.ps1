# 下载并启动一个本地 Minecraft（Java 版）服务器
# 默认：创造模式 + 离线模式（让 AI bot 无需正版账号即可进入）
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

# 1) 下载最新正式版服务器核心
if (-not (Test-Path "server.jar")) {
  Write-Host "获取最新版本信息..."
  $manifest = Invoke-RestMethod "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json"
  $latest = $manifest.latest.release
  $ver = $manifest.versions | Where-Object { $_.id -eq $latest }
  $meta = Invoke-RestMethod $ver.url
  $url = $meta.downloads.server.url
  Write-Host "下载 Minecraft 服务器 $latest ..."
  Invoke-WebRequest $url -OutFile "server.jar"
}

# 2) 首次运行以生成配置文件（会因 EULA 未同意而退出）
if (-not (Test-Path "eula.txt")) {
  Write-Host "首次启动以生成配置文件..."
  java -jar server.jar --nogui
}

# 3) 同意 EULA
(Get-Content "eula.txt") -replace "eula=false", "eula=true" | Set-Content "eula.txt"

# 4) 设置为创造模式 + 离线模式
function Ensure-Prop($lines, $key, $val) {
  $hit = $false
  $out = $lines | ForEach-Object {
    if ($_ -match "^$key=") { $hit = $true; "$key=$val" } else { $_ }
  }
  if (-not $hit) { $out += "$key=$val" }
  return $out
}
$lines = Get-Content "server.properties"
$lines = Ensure-Prop $lines "gamemode" "creative"
$lines = Ensure-Prop $lines "online-mode" "false"
$lines | Set-Content "server.properties"

# 5) 启动服务器
Write-Host "正在启动 Minecraft 服务器（创造模式 / 离线模式）..."
java -jar server.jar --nogui
