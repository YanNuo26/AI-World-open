# ===== 轻量打包（脚本/打包.ps1）=====
# 把项目打成一个「双击就能用」的绿色软件包：源码 + 依赖 + （可选）Node 运行时 + 启动器 + zip。
# 目标机不需要装 Node、不需要 git、不需要 npm install（默认会把 node.exe 一起塞进去）。
#
# 用法（在项目根目录跑）：
#   powershell -ExecutionPolicy Bypass -File 脚本\打包.ps1
#   ... -NoRuntime      不塞 node.exe（包小 ~90MB，但目标机得自己装 Node 18+ 并加进 PATH）
#   ... -NoPrune        不裁剪依赖（minecraft-data 的 bedrock 数据会多占 ~330MB）
#   ... -Tag 测试版1     换包名后缀（默认「测试版」）
#   ... -OutDir D:\发布  换输出目录（默认 项目根\发布）
#   ... -NoZip          只生成目录，不打 zip（调试打包脚本时用）
#
# 产物：
#   发布\AI-World-<版本>-<Tag>\        ← 解压即用的软件目录
#   发布\AI-World-<版本>-<Tag>.zip     ← 发出去的就是这个
#   发布\发布说明.md                    ← 版本 / 大小 / SHA256 / 怎么用（每次覆盖）
param(
  [string]$OutDir = '',
  [string]$Tag = '测试版',
  [switch]$NoRuntime,
  [switch]$NoPrune,
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot            # 脚本在 脚本\ 里，项目根是它的上一级
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)   # .bat / .json / .txt 一律用它（BOM 会害死 JSON.parse）
function Step ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn ($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function FindNodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  if (Test-Path -LiteralPath 'D:\App存储\NodeJS\node.exe') { return 'D:\App存储\NodeJS\node.exe' }
  return $null
}
function DirMB ($p) {
  if (-not (Test-Path -LiteralPath $p)) { return 0 }
  $s = (Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
  if (-not $s) { return 0 }
  return [math]::Round($s / 1MB, 1)
}
function CopyTree ($from, $to, [string[]]$excludeNames = @()) {
  if (-not (Test-Path -LiteralPath $from)) { Warn "缺少 $from，跳过"; return }
  New-Item -ItemType Directory -Force -Path $to | Out-Null
  # robocopy 比 Copy-Item 快很多；退出码 0-7 都算成功（8 以上才是真错）
  $rcArgs = @($from, $to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($excludeNames.Count) { $rcArgs += @('/XF') + $excludeNames }
  & robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "复制失败：$from -> $to（robocopy 退出码 $LASTEXITCODE）" }
  $global:LASTEXITCODE = 0
}

# ---------- 0. 版本号 / 输出路径 ----------
$pkg = Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Version = $pkg.version
$Name = "AI-World-$Version-$Tag"
if (-not $OutDir) { $OutDir = Join-Path $Root '发布' }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$Dest = Join-Path $OutDir $Name
$Zip = "$Dest.zip"

Step "打包 $Name"
Write-Host "    项目根：$Root"
Write-Host "    输出：  $Dest"

# 安全阀：只删「发布目录下的 AI-World-*」，绝不碰别的地方
if (Test-Path -LiteralPath $Dest) {
  if (-not ($Dest -like '*\AI-World-*')) { throw "输出路径看起来不对，拒绝删除：$Dest" }
  Remove-Item -LiteralPath $Dest -Recurse -Force
}
if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# ---------- 1. 源码 / 脚本 / 文档 / 根文件 ----------
Step '复制 源码 / 脚本 / 文档'
CopyTree (Join-Path $Root '源码') (Join-Path $Dest '源码')
CopyTree (Join-Path $Root '文档') (Join-Path $Dest '文档') @('远程开发机.md')

New-Item -ItemType Directory -Force -Path (Join-Path $Dest '脚本') | Out-Null
$keepScripts = @('start_server.ps1', 'start-server.ps1', '启动服务器.bat', '启动面板.bat', '启动.bat', 'run.ps1')
foreach ($f in $keepScripts) {
  $src = Join-Path $Root "脚本\$f"
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $Dest "脚本\$f") }
  else { Warn "脚本\$f 不存在，跳过" }
}

foreach ($f in @('skins.json', 'package.json', 'README.md', 'AGENTS.md')) {
  $src = Join-Path $Root $f
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $Dest $f) }
}

# config.json 要「洗一遍」：RCON 密码、服主游戏名不跟着发行包走（发行包里等你自己的机器再填）
# 注意：**必须写成无 BOM 的 UTF-8**。项目里 config.js 是 JSON.parse(fs.readFileSync(..., 'utf8'))，
#       BOM 会让它直接 Unexpected token（2026-11-01 第一次打包就是这么坏的）。
$cfgSrc = Join-Path $Root 'config.json'
if (Test-Path -LiteralPath $cfgSrc) {
  $cfgDst = Join-Path $Dest 'config.json'
  $cfgNode = FindNodeExe
  $cfgOk = $false
  if ($cfgNode) {
    $cleanJs = "const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));" +
               "if(c.rcon)c.rcon.password='';if(c.ai)c.ai.owner='';" +
               "fs.writeFileSync(process.argv[2],JSON.stringify(c,null,2)+'\n','utf8')"
    & $cfgNode -e $cleanJs $cfgSrc $cfgDst
    $cfgOk = ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $cfgDst))
  }
  if (-not $cfgOk) {
    # 兜底：没有 node 就用 PowerShell 洗（缩进难看但合法），同样写无 BOM
    $cfgObj = Get-Content -LiteralPath $cfgSrc -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfgObj.rcon) { $cfgObj.rcon.password = '' }
    if ($cfgObj.ai) { $cfgObj.ai.owner = '' }
    $json = $cfgObj | ConvertTo-Json -Depth 9
    [System.IO.File]::WriteAllText($cfgDst, $json + "`r`n", $utf8NoBom)
  }
  # 读回校验：BOM 没了、密码/服主名确实清空了
  $bytes = [System.IO.File]::ReadAllBytes($cfgDst)
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    throw 'config.json 写出来带 BOM 了（项目里 JSON.parse 会失败）'
  }
  $cfgBack = Get-Content -LiteralPath $cfgDst -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($cfgBack.rcon.password -or $cfgBack.ai.owner) { throw 'config.json 没洗干净（rcon.password / ai.owner）' }
  Write-Host '    config.json 已清空 rcon.password / ai.owner（无 BOM 写入，已读回校验）'
}

# 运行期目录先建好空壳（用户不用自己创建，日志/面板数据也直接能写）
foreach ($d in @('蓝图', '教学', '日志', '配置', '服务器')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Dest $d) | Out-Null
}

# ---------- 2. 依赖（node_modules） ----------
$nmSrc = Join-Path $Root 'node_modules'
$nmDst = Join-Path $Dest 'node_modules'
if (-not (Test-Path -LiteralPath $nmSrc)) {
  Warn '没有 node_modules（先 npm install），打包出来的软件跑不起来！'
} else {
  Step "复制 node_modules（$(DirMB $nmSrc) MB，比较慢，稍等）"
  # 只排除 .bin 里的 npm / npx 快捷方式没必要——整目录复制最省事，也避免漏依赖
  CopyTree $nmSrc $nmDst

  if (-not $NoPrune) {
    Step '裁剪依赖（去掉本项目用不到的 bedrock 数据）'
    $before = DirMB $nmDst
    $mdData = Join-Path $nmDst 'minecraft-data\minecraft-data\data'

    # (1) bedrock 数据本项目完全用不到 —— 一家伙 330MB。
    #     但 **bedrock/common 必须留**：minecraft-data 的 lib/supportsFeature.js 在 require 阶段
    #     就读 data/bedrock/common/features.json，删了直接 MODULE_NOT_FOUND（2026-11-01 踩过）。
    $bedrockDir = Join-Path $mdData 'bedrock'
    if (Test-Path -LiteralPath $bedrockDir) {
      Get-ChildItem -LiteralPath $bedrockDir -Directory | Where-Object { $_.Name -ne 'common' } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force }
    }

    # (2) ⚠ pc 下**不能**只留 1.21.1：minecraft-data 的 `data.js` 是「每个版本一个 getter」，
    #     而 `lib/indexes.js` 在 require('minecraft-data') 时就会访问其中若干 getter
    #     （实测报 Cannot find module './minecraft-data/data/pc/1.20.5/biomes.json'）。
    #     想只留一个版本就得改依赖源码，不值得 —— pc 全留也才 97MB。

    # (3) 文档 / sourcemap 全删（不影响运行），但 **LICENSE 一定要留**（合规）
    #     ⚠ 不能用 -Include：配合 -LiteralPath -Recurse 时 -Include 会被忽略，
    #       结果把 node_modules 里**所有文件**都删了（2026-11-01 第一次打包就踩了，包只剩空目录）。
    Get-ChildItem -LiteralPath $nmDst -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -in @('.md', '.markdown', '.map') } |
      Remove-Item -Force -ErrorAction SilentlyContinue
    $after = DirMB $nmDst
    Write-Host ("    node_modules：{0} MB -> {1} MB（省 {2} MB）" -f $before, $after, [math]::Round($before - $after, 1))
    if ($after -lt 80) { throw "裁剪后 node_modules 只剩 $after MB，明显不对（裁剪逻辑出错了）" }
    if (-not (Test-Path -LiteralPath (Join-Path $nmDst 'mineflayer\package.json'))) {
      throw '裁剪后找不到 node_modules\mineflayer，包是坏的'
    }
  }
}

# ---------- 3. Node 运行时（可选） ----------
# 放这里是因为：后面生成「版本.txt / 发布说明」要用 $nodeExe，打 zip 之前也必须已经塞进包里。
$nodeExe = $null
if (-not $NoRuntime) {
  Step '塞入 Node 运行时'
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
  elseif (Test-Path -LiteralPath 'D:\App存储\NodeJS\node.exe') { $nodeExe = 'D:\App存储\NodeJS\node.exe' }
  if ($nodeExe) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Dest '运行时') | Out-Null
    Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $Dest '运行时\node.exe')
    $nv = (& $nodeExe -v)
    $note = @(
      '这个目录里是 Node.js 运行时（node.exe），随软件一起发行，目标机不用另装 Node。',
      "版本：$nv",
      '',
      'Node.js 由 OpenJS Foundation 发布，许可证 MIT（见 https://nodejs.org/en/about/previous-releases ）。',
      '本软件只用它跑 源码\bot.js 和 源码\panel\server.js，没有改动过 node.exe。'
    )
    [System.IO.File]::WriteAllText((Join-Path $Dest '运行时\说明.txt'), ($note -join "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "    运行时：$nv（$([math]::Round((Get-Item $nodeExe).Length/1MB,1)) MB）"
  } else {
    Warn '找不到 node.exe，本次不打运行时（目标机需要自己装 Node）'
  }
}

# ---------- 3.5 自检：依赖能不能用（裁剪最容易把这里搞坏） ----------
Step '自检依赖（打包最容易坏在这一步）'
$nodeForCheck = $null
if (Test-Path -LiteralPath (Join-Path $Dest '运行时\node.exe')) { $nodeForCheck = Join-Path $Dest '运行时\node.exe' }
elseif (Get-Command node -ErrorAction SilentlyContinue) { $nodeForCheck = 'node' }
if ($nodeForCheck) {
  Push-Location $Dest
  try {
    $checkJs = "const md=require('minecraft-data');const d=md('1.21.1');" +
               "if(!d.blocksByName.stone) throw new Error('找不到 stone 方块数据');" +
               "console.log('    minecraft-data OK：版本 ' + d.version.minecraftVersion + '，方块 ' + Object.keys(d.blocks).length + ' 种')"
    & $nodeForCheck -e $checkJs
    if ($LASTEXITCODE -ne 0) { throw '打包后的依赖跑不起来（trim 剪坏了？加 -NoPrune 再试）' }
  } finally { Pop-Location }
} else {
  Warn '没有可用的 node，跳过自检'
}

# ---------- 4. 根目录启动器 ----------
Step '生成启动器'

$batPanel = @'
@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM   AI-World 控制面板（双击本文件）
REM   只监听 127.0.0.1:8787，浏览器打开 http://127.0.0.1:8787/
REM   关掉这个窗口 = 关面板，并顺手停掉面板拉起的服务器和 ai
REM ============================================================
cd /d "%~dp0"
set "NODE=%~dp0运行时\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo [X] 找不到 Node：把 node.exe 放回 运行时\ 目录，或装 Node.js 后加进 PATH
  pause
  exit /b 1
)
echo 正在启动面板…浏览器会自动打开（打不开就手动访问 http://127.0.0.1:8787/）
"%NODE%" 源码\panel\server.js --port 8787
echo.
echo 面板已退出。
pause
'@

$batBot = @'
@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM   AI-World 的 ai（不经过面板，直接连服务器）
REM   参数接着写就行，例如：启动AI.bat --name bob --host 1.2.3.4 --port 25565
REM ============================================================
cd /d "%~dp0"
set "NODE=%~dp0运行时\node.exe"
if not exist "%NODE%" set "NODE=node"
"%NODE%" --version >nul 2>nul
if errorlevel 1 (
  echo [X] 找不到 Node：把 node.exe 放回 运行时\ 目录，或装 Node.js 后加进 PATH
  pause
  exit /b 1
)
"%NODE%" 源码\bot.js %*
echo.
echo ai 已退出（上面最后几行就是原因，也可以看 日志\ai_*.log）。
pause
'@

[System.IO.File]::WriteAllText((Join-Path $Dest '启动面板.bat'), ($batPanel -replace "`r?`n", "`r`n"), $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $Dest '启动AI.bat'), ($batBot -replace "`r?`n", "`r`n"), $utf8NoBom)

# ---------- 5. 版本信息 ----------
$commit = ''
try { $commit = (& git -C $Root rev-parse --short HEAD) 2>$null } catch { }
if (-not $commit) { $commit = '（无 git 信息）' }
$nv2 = ''
if ($nodeExe) { $nv2 = (& $nodeExe -v) }
# ⚠ 不要在 @() 里写 '前缀：' + (表达式) —— PowerShell 会把它拆成多个数组元素，
#   txt / md 里就变成「前缀：」换行「值」（2026-11-01 第一次打包踩过）。一律先用变量接住。
$buildTimeText = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$pruneText = if ($NoPrune) { '否（完整 minecraft-data）' } else { '是（去掉 bedrock 数据，省 ~330MB）' }
$nodeText = if ($nodeExe) { $nv2 } else { '无（需要自己装 Node 18+）' }
$verLines = @(
  "名称：$Name",
  "版本：$Version（$Tag）",
  "打包时间：$buildTimeText",
  "源码提交：$commit",
  "依赖裁剪：$pruneText",
  "内置 Node：$nodeText",
  '',
  '说明：这是给「Minecraft 1.21.1 创造服」用的建造 ai + 本地控制面板。',
  '双击 启动面板.bat 就能用；要从命令行直连服务器就用 启动AI.bat。'
)
[System.IO.File]::WriteAllText((Join-Path $Dest '版本.txt'), ($verLines -join "`r`n"), $utf8NoBom)

# ---------- 6. 打 zip ----------
$zipMB = 0
$zipPath = ''
$sha = ''
if (-not $NoZip) {
  Step '压缩成 zip（大包要几十秒）'
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $Dest, $Zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $zipMB = [math]::Round((Get-Item -LiteralPath $Zip).Length / 1MB, 1)
  $sha = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash
  $zipPath = $Zip
  Write-Host "    $Zip（$zipMB MB）"
}

# ---------- 7. 发布说明 ----------
$dirMB = DirMB $Dest
$buildMinute = Get-Date -Format 'yyyy-MM-dd HH:mm'
$zipText = if ($NoZip) { '（本次没打）' } else { "$zipMB MB" }
$shaText = if ($sha) { '`' + $sha + '`' } else { '（本次没打）' }
$nodeText2 = if ($nodeExe) { $nv2 } else { '无' }
$relLines = @(
  "# AI-World $Version（$Tag）",
  '',
  '> 由 `脚本/打包.ps1` 自动生成，别手改。',
  '',
  '| 项 | 值 |',
  '| --- | --- |',
  "| 版本 | $Version（$Tag） |",
  "| 打包时间 | $buildMinute |",
  "| 源码提交 | $commit |",
  "| 未压缩目录 | $dirMB MB |",
  "| zip | $zipText |",
  "| SHA256 | $shaText |",
  "| 内置 Node | $nodeText2 |",
  '',
  '## 怎么用',
  '',
  '1. 解压到任意目录（**不要放在 `C:\Program Files` 里**，面板要往自己的目录写日志）。',
  '2. 双击 `启动面板.bat` → 浏览器打开 http://127.0.0.1:8787/ 。',
  '3. 在面板「连接与权限」里填服务器地址 / RCON 密码（第一次建议先点「探测服务器端口」）。',
  '4. 面板「启动 / 停止」里点「启动 ai」；要起本机服务器还得有 `服务器\server.jar` + Java 21。',
  '',
  '## 这个包里有什么',
  '',
  '| 路径 | 作用 |',
  '| --- | --- |',
  '| `启动面板.bat` / `启动AI.bat` | 一键入口（自带 Node，无需安装任何东西） |',
  '| `源码\` | ai 本体 + 控制面板 |',
  '| `node_modules\` | 依赖（已裁掉本项目用不到的 bedrock 数据，约 118MB） |',
  '| `运行时\node.exe` | 随包 Node（没有它就得自己装 Node 18+） |',
  '| `文档\` | `使用说明.md`（怎么玩）/ `AI参考.md`（坑）/ `架构与规划.md` |',
  '| `config.json` | 全部设置（RCON 密码、服主名已清空，自己填） |',
  '| `蓝图\` `教学\` `日志\` `配置\` `服务器\` | 运行期目录（空的，跑起来就有内容） |',
  '',
  '## 已知限制（第一个测试版）',
  '',
  '- 只支持 **Minecraft Java 1.21.1**（mineflayer 的版本跟 `config.json` 的 `server.version` 走，数据全都在包里）。',
  '- 面板只监听 `127.0.0.1`，**不能**从别的机器打开；远程要用就自己配 SSH 隧道。',
  '- 包里**没有** `server.jar`（版权 + 体积），本机开服请自己下 1.21.1 服务端放进 `服务器\`。',
  '- 打包脚本不签名，Windows 首次运行可能提示"未知发布者"。'
)
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$relFile = Join-Path $OutDir '发布说明.md'
[System.IO.File]::WriteAllText($relFile, ($relLines -join "`r`n"), $utf8NoBom)

Write-Host ''
Write-Host '================ 打包完成 ================' -ForegroundColor Green
Write-Host "  目录：$Dest（$dirMB MB）"
if ($zipPath) { Write-Host "  压缩包：$zipPath（$zipMB MB）" }
Write-Host "  说明：$relFile"
Write-Host '=========================================='

# （Node 运行时在「三」那里就已经复制进包了）

