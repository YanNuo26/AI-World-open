// ===== 夜间全量回归（测试/夜间回归.js）=====
// 无人值守跑完 测试/ 下所有行为测试：自动起服务器 → 逐个跑 → 每步落盘 → 早上看一份报告。
//
//   node 测试/夜间回归.js                 全量（默认：能跑的全跑）
//   node 测试/夜间回归.js --list          只看会跑哪些、预计多久
//   node 测试/夜间回归.js --only teach    只跑文件名带 teach 的
//   node 测试/夜间回归.js --skip multi    跳过文件名带 multi 的
//   node 测试/夜间回归.js --reset         先把 服务器/存档 改名备份，跑一个干净世界
//   node 测试/夜间回归.js --no-retry      失败不重试（默认重试 1 次）
//
// 为什么需要它：这些测试要连真服务器、单个可能跑几分钟；一条条手动开既费时间，
// 又会互相干扰（上一个测试留下的 ai / 方块没清干净，下一个就"假失败"）。
// 它负责的正是这些脏活：起服、等服、超时杀进程、清孤儿 ai、坏掉就重启服务器。
//
// 产物（都在 日志/夜间回归/ 里）：
//   运行_<时间>.log      整个过程的时间线（人看的）
//   01_test_access.log   每个测试的原始输出（失败时看这个）
//   server_console.log   服务器控制台（测试中途服务器崩了看这里）
//   最新报告.md          结果表格 + 失败测试的末尾输出
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SERVER_DIR = path.join(ROOT, '服务器')
const OUT_DIR = path.join(ROOT, '日志', '夜间回归')
const CFG = require('../源码/config').load()

// ---- 测试清单：顺序 = 执行顺序 ----
// 排序思路：便宜的（不用服务器的）排最前，早失败早发现；同类连着跑，减少 ai 反复登录。
// timeout 单位秒：行为测试光登录 + 落地就要十几秒，别给太小。
const TESTS = [
  // 0. 静态守门：几秒、不用服务器 —— 先把"测试自己写坏了"筛掉（2026-10-31 那次 17 个假失败都源于此）
  { name: '守门.js', cat: '静态', timeout: 120, offline: true },

  // 1. 离线：不起服务器也能跑
  { name: 'test_access.js', cat: '离线', timeout: 60, offline: true },
  { name: 'test_panel.js', cat: '离线', timeout: 120, offline: true },

  // 2. 移动 / 落地
  { name: 'test_move.js', cat: '移动', timeout: 180 },
  { name: 'test_move2.js', cat: '移动', timeout: 180 },
  { name: 'test_land.js', cat: '移动', timeout: 240 },

  // 3. 建造 / 放置 / 朝向
  { name: 'test_facing.js', cat: '建造', timeout: 300 },
  { name: 'test_redstone.js', cat: '建造', timeout: 300 },
  { name: 'test_interactive.js', cat: '建造', timeout: 300 },
  { name: 'test_airmark.js', cat: '建造', timeout: 300 },
  { name: 'test_airmark2.js', cat: '建造', timeout: 300 },
  { name: 'test_mark2.js', cat: '建造', timeout: 420 },
  { name: 'test_mark_clean.js', cat: '建造', timeout: 240 },
  { name: 'test_ckstate.js', cat: '建造', timeout: 240 },
  { name: 'test_rep.js', cat: '建造', timeout: 300 },
  { name: 'test_stop_del.js', cat: '建造', timeout: 300 },
  { name: 'test_xyz.js', cat: '建造', timeout: 300 },

  // 4. 教学录制 / 复现
  { name: 'test_teach.js', cat: '教学', timeout: 360 },
  { name: 'test_teach2.js', cat: '教学', timeout: 360 },
  { name: 'test_teach3.js', cat: '教学', timeout: 360 },
  { name: 'test_teach4.js', cat: '教学', timeout: 360 },
  { name: 'test_teach5.js', cat: '教学', timeout: 360 },

  // 5. 多 ai / 跟随 / 远距离传送
  { name: 'test_multi.js', cat: '多人', timeout: 420 },
  { name: 'test_follow_land.js', cat: '多人', timeout: 360 },
  { name: 'test_tpto_far.js', cat: '多人', timeout: 300 },

  // 6. 指令 / 综合
  { name: 'test_prefix.js', cat: '指令', timeout: 240 },
  { name: 'test_help.js', cat: '指令', timeout: 240 },
  { name: 'test_op.js', cat: '指令', timeout: 240 },
  { name: 'test_commands.js', cat: '指令', timeout: 480 },

  // 7. 诊断脚本：只打日志、没有 PASS/FAIL，默认不跑（--with-diag 才跑）
  { name: 'diag_facing.js', cat: '诊断', timeout: 120, diag: true }
]

// ---- 小工具 ----
const pad2 = (n) => String(n).padStart(2, '0')
function stamp () {
  const d = new Date()
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
}
function clock () {
  const d = new Date()
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
}
function ensureDir (d) {
  try { fs.mkdirSync(d, { recursive: true }) } catch (e) { /* ignore */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function fmtDur (ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + pad2(s % 60) + 's'
}

// 过程日志：同时打控制台 + 写 运行_<时间>.log（终端被关掉也能事后查）
let runLog = null
function log (msg) {
  const line = '[' + clock() + '] ' + msg
  console.log(line)
  if (runLog) { try { runLog.write(line + '\n') } catch (e) { /* ignore */ } }
}

// 端口探测（判断服务器在不在）
function probePort (port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      try { sock.destroy() } catch (e) { /* ignore */ }
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => finish(false))
    sock.on('error', () => finish(false))
    sock.connect(port, host, () => finish(true))
  })
}

// 杀掉整棵进程树（测试超时后必须连它 spawn 的 ai 一起杀，否则下一个测试会被"名字已占用"搞挂）
function killTree (pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }) } catch (e) { /* 已经退出了 */ }
  } else {
    try { process.kill(pid, 'SIGKILL') } catch (e) { /* ignore */ }
  }
}

// ---------- 服务器 ----------
const serverState = { child: null, external: false, restarts: 0 }

function serverUp () {
  return probePort(CFG.server.port)
}

// 存档搬家：**改名而不是删除** —— 一夜之间把用户的世界删掉是不可接受的
function backupWorld () {
  const dir = path.join(SERVER_DIR, '存档')
  if (!fs.existsSync(dir)) {
    log('存档目录不存在（第一次跑），跳过重置')
    return true
  }
  const dest = path.join(SERVER_DIR, '存档_夜间备份_' + stamp())
  try {
    fs.renameSync(dir, dest)
  } catch (e) {
    log('❌ 存档改名失败：' + e.message + '（可能还被 java 占着，先关掉服务器）')
    return false
  }
  log('世界已重置：存档 → ' + path.basename(dest) + '（想还原就把名字改回 存档）')
  return true
}

async function startServer () {
  if (await serverUp()) {
    serverState.external = true
    log('端口 ' + CFG.server.port + ' 上已经有服务器在跑 → 直接复用（本脚本不管它的生死）')
    return true
  }
  const jar = path.join(SERVER_DIR, 'server.jar')
  if (!fs.existsSync(jar)) {
    log('❌ 服务器/server.jar 不存在 → 先跑一次 脚本\\start_server.ps1 做首次初始化')
    return false
  }
  // JDK 18+ 默认按 UTF-8 输出，中文控制台按 GBK 读 → 日志变乱码（见 文档/AI参考.md 坑）
  const enc = 'GBK'
  const args = ['-Xms1G', '-Xmx2G', '-Dfile.encoding=' + enc, '-Dsun.stdout.encoding=' + enc,
    '-Dsun.stderr.encoding=' + enc, '-jar', 'server.jar', '--nogui']
  const fd = fs.openSync(path.join(OUT_DIR, 'server_console.log'), 'a')
  try { fs.writeSync(fd, '\n==== 夜间回归启动服务器 ' + clock() + ' ====\n') } catch (e) { /* ignore */ }
  const child = spawn('java', args, { cwd: SERVER_DIR, stdio: ['pipe', fd, fd], windowsHide: true })
  serverState.child = child
  serverState.external = false
  let spawnError = null
  child.on('error', (e) => { spawnError = e })
  child.on('exit', () => { if (serverState.child === child) serverState.child = null })

  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    if (spawnError) {
      log('❌ 起 java 失败：' + spawnError.message + '（java 不在 PATH？先跑 脚本\\启动服务器.bat 确认）')
      return false
    }
    if (await serverUp()) {
      log('服务器已在监听 ' + CFG.server.port + '，等 15 秒让区块 / 玩家数据加载完')
      await sleep(15000)
      return true
    }
    await sleep(3000)
  }
  log('❌ 服务器 240 秒还没起来，看 日志/夜间回归/server_console.log')
  return false
}

async function stopServer () {
  const child = serverState.child
  if (!child) return
  serverState.child = null
  log('正在停服务器（发 stop，等它存世界）…')
  try { child.stdin.write('stop\n') } catch (e) { /* stdin 可能已关 */ }
  const deadline = Date.now() + 30000
  while (Date.now() < deadline && child.exitCode === null) await sleep(500)
  if (child.exitCode === null) {
    log('30 秒没退出，强制结束')
    killTree(child.pid)
  }
  await sleep(2000)
}

// 测试之间看服务器一眼：挂了就重启（行为测试全指望它）
async function ensureServerAlive () {
  if (await serverUp()) return true
  if (serverState.external) {
    log('⚠ 复用的服务器掉了 —— 它不是本脚本启动的，没法帮你重启，后面的行为测试大概率全失败')
    return false
  }
  serverState.restarts++
  log('⚠ 服务器没响应了，重启（第 ' + serverState.restarts + ' 次）')
  serverState.child = null
  return startServer()
}

// 清掉上一个测试没收拾干净的 ai 进程。
// 用命令行匹配，别按窗口标题猜 —— 否则会把正在跑回归的脚本自己也杀掉。
function killOrphanAi () {
  if (process.platform !== 'win32') return 0
  let text = ''
  try {
    text = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
    ], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  } catch (e) { return 0 }
  let list = []
  try { list = JSON.parse(String(text || '[]')) } catch (e) { return 0 }
  if (!Array.isArray(list)) list = [list]
  let n = 0
  for (const p of list) {
    const cmd = String(p.CommandLine || '')
    if (!/bot\.js/.test(cmd)) continue
    if (p.ProcessId === process.pid) continue
    if (/夜间回归/.test(cmd)) continue
    killTree(p.ProcessId)
    n++
  }
  if (n) log('清掉 ' + n + ' 个残留的 ai 进程')
  return n
}

// ---------- 跑一个测试 ----------
function runTest (test, idx) {
  return new Promise((resolve) => {
    const logfile = path.join(OUT_DIR, pad2(idx) + '_' + test.name.replace(/\.js$/, '') + '.log')
    const fd = fs.openSync(logfile, 'w')
    const started = Date.now()
    const child = spawn(process.execPath, [path.join('测试', test.name)], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    })
    const tail = []
    const feed = (chunk) => {
      const text = chunk.toString('utf8')
      try { fs.writeSync(fd, text) } catch (e) { /* ignore */ }
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue
        tail.push(line)
        if (tail.length > 30) tail.shift()
      }
    }
    if (child.stdout) child.stdout.on('data', feed)
    if (child.stderr) child.stderr.on('data', feed)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      log('⏱ ' + test.name + ' 跑过 ' + test.timeout + ' 秒，强杀（含它 spawn 的 ai）')
      killTree(child.pid)
    }, test.timeout * 1000)

    const done = (code, note) => {
      clearTimeout(timer)
      try { fs.closeSync(fd) } catch (e) { /* ignore */ }
      resolve({ code, timedOut, note: note || null, tail, logfile, ms: Date.now() - started })
    }
    child.on('close', (code) => done(code == null ? -1 : code))
    child.on('error', (e) => done(-1, e.message))
  })
}

// ---------- 参数 ----------
const USAGE = [
  '用法：node 测试/夜间回归.js [选项]',
  '',
  '  --list              只列出会跑哪些测试（附超时上限），不真跑',
  '  --dry               只打印执行计划',
  '  --only a,b          只跑文件名包含这些词的（如 --only teach,redstone）',
  '  --skip a,b          跳过文件名包含这些词的',
  '  --reset             开跑前把 服务器/存档 改名备份（跑一个干净世界）；服务器必须先关',
  '  --keep              不重置存档（默认）',
  '  --retry n           失败重试 n 次（默认 1；--no-retry 等于 0）',
  '  --timeout 秒        统一覆盖单个测试的超时（表里的值更准，一般不用改）',
  '  --server auto|none  auto = 没在跑就自己起（默认）；none = 不起服务器',
  '  --with-diag         连 diag_* 诊断脚本一起跑（默认跳过）',
  '',
  '产物在 日志/夜间回归/：运行_*.log（时间线）、NN_*.log（每个测试的输出）、最新报告.md'
].join('\n')

function parseArgs (argv) {
  const o = {
    only: [], skip: [], reset: false, retry: 1, list: false, dry: false,
    server: 'auto', withDiag: false, timeout: null, help: false
  }
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    const take = () => {
      const v = argv[i + 1]
      if (v === undefined || String(v).startsWith('--')) return ''
      i++
      return String(v)
    }
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--list') o.list = true
    else if (a === '--dry') o.dry = true
    else if (a === '--reset') o.reset = true
    else if (a === '--keep') o.reset = false
    else if (a === '--with-diag') o.withDiag = true
    else if (a === '--no-retry') o.retry = 0
    else if (a === '--retry') o.retry = Math.max(0, parseInt(take(), 10) || 0)
    else if (a === '--timeout') o.timeout = Math.max(30, parseInt(take(), 10) || 0)
    else if (a === '--server') o.server = take() || 'auto'
    else if (a === '--only') o.only = take().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--skip') o.skip = take().split(',').map((s) => s.trim()).filter(Boolean)
    else console.log('（忽略不认识的参数：' + a + '）')
  }
  return o
}

// 挑出这次要跑的测试（保持 TESTS 里的顺序）
function pick (opt) {
  const hit = (t, pats) => pats.some((p) => t.name.toLowerCase().includes(p.toLowerCase()))
  const out = []
  for (const t of TESTS) {
    if (t.diag && !opt.withDiag) continue
    if (opt.only.length && !hit(t, opt.only)) continue
    if (opt.skip.length && hit(t, opt.skip)) continue
    if (!fs.existsSync(path.join(__dirname, t.name))) {
      console.log('（清单里的 ' + t.name + ' 已经不存在，跳过）')
      continue
    }
    out.push(Object.assign({}, t, { timeout: opt.timeout || t.timeout }))
  }
  return out
}

function progressText (list, results) {
  const lines = ['夜间回归进行中 ' + clock() + '（' + results.length + '/' + list.length + '）', '']
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    lines.push(pad2(i + 1) + ' ' + r.test.name.padEnd(22) + r.status + '  ' + fmtDur(r.ms))
  }
  return lines.join('\n') + '\n'
}

// ---------- 报告 ----------
function writeReport (results, meta) {
  const bad = results.filter((r) => r.status !== 'PASS')
  const md = []
  md.push('# 夜间回归报告 ' + stamp())
  md.push('')
  md.push('- 通过：**' + (results.length - bad.length) + ' / ' + results.length + '**')
  const serverNote = !meta.needsServer ? '（这批测试不需要服务器）'
    : serverState.external ? '（复用已在跑的）' : '（本脚本启动）'
  md.push('- 服务器：' + CFG.server.host + ':' + CFG.server.port + serverNote +
    '，中途重启 ' + serverState.restarts + ' 次')
  md.push('- 存档重置：' + (meta.reset ? '是（旧存档已改名备份，没删）' : '否'))
  md.push('- 失败重试：' + meta.retry + ' 次')
  md.push('- 环境：node ' + process.version + ' / ' + process.platform)
  md.push('')
  md.push('| # | 测试 | 类别 | 结果 | 用时 | 次数 | 日志 |')
  md.push('|---|------|------|------|------|------|------|')
  results.forEach((r, i) => {
    const f = r.logfile ? path.basename(r.logfile) : '—'
    md.push('| ' + (i + 1) + ' | ' + r.test.name + ' | ' + r.test.cat + ' | **' + r.status + '** | ' +
      fmtDur(r.ms) + ' | ' + (r.tries || 1) + ' | ' + f + ' |')
  })
  md.push('')
  if (bad.length) {
    md.push('## 失败详情（每个测试的末尾 20 行）')
    md.push('')
    for (const r of bad) {
      md.push('### ' + r.test.name + ' — ' + r.status +
        (r.test.offline ? '（离线测试，和服务器无关，多半是真 bug）' : ''))
      md.push('')
      md.push('```')
      for (const line of (r.tail || []).slice(-20)) md.push(line)
      md.push('```')
      md.push('')
    }
  } else {
    md.push('全部通过 —— 没有需要看的失败输出。')
    md.push('')
  }
  const text = md.join('\n')
  const file = path.join(OUT_DIR, '报告_' + stamp() + '.md')
  fs.writeFileSync(file, text, 'utf8')
  fs.writeFileSync(path.join(OUT_DIR, '最新报告.md'), text, 'utf8')
  return file
}

// 崩溃兜底：main 把结果数组挂到这里，这样即使脚本自己抛异常，也能写出一份"跑到哪了"的报告
let RESULTS = []
let META = null

// ---------- 主流程 ----------
async function main () {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.help) {
    console.log(USAGE)
    return 0
  }
  const list = pick(opt)
  if (!list.length) {
    console.log('没有匹配的测试（--only / --skip 写错了？）')
    return 2
  }
  const capMin = Math.round(list.reduce((s, t) => s + t.timeout, 0) / 60)

  if (opt.list) {
    console.log('按顺序跑 ' + list.length + ' 个测试（超时上限合计约 ' + capMin + ' 分钟）：')
    list.forEach((t, i) => {
      console.log('  ' + pad2(i + 1) + ' ' + t.name.padEnd(22) + t.cat + '  ≤' + t.timeout + 's')
    })
    return 0
  }
  const needServer = list.some((t) => !t.offline)
  if (opt.dry) {
    console.log('[dry] 服务器 ' + CFG.server.host + ':' + CFG.server.port +
      (needServer ? '（没在跑就启动）' : '（这批测试不需要）'))
    console.log('[dry] 存档重置：' + (opt.reset ? '是' : '否') + '；失败重试 ' + opt.retry + ' 次')
    list.forEach((t, i) => {
      console.log('[dry] ' + pad2(i + 1) + ' node 测试/' + t.name + '  （超时 ' + t.timeout + 's）')
    })
    return 0
  }

  ensureDir(OUT_DIR)
  runLog = fs.createWriteStream(path.join(OUT_DIR, '运行_' + stamp() + '.log'), { flags: 'a' })
  log('===== 夜间全量回归开始 =====')
  log('node ' + process.version + ' / 服务器 ' + CFG.server.host + ':' + CFG.server.port +
    ' / 存档重置：' + (opt.reset ? '是' : '否'))
  log('共 ' + list.length + ' 个测试，失败重试 ' + opt.retry + ' 次')
  killOrphanAi() // 开跑前先清一次：上次手动跑剩下的 ai 会抢名字

  let serverOk = true
  if (needServer) {
    if (opt.reset) {
      if (await serverUp()) {
        log('❌ 要重置存档，但端口 ' + CFG.server.port + ' 上已经有服务器在跑 —— 先关掉它再带 --reset 跑')
        log('（本脚本不会去停别人的服务器，避免误伤）')
        if (runLog) await new Promise((r) => runLog.end(r))
        return 3
      }
      if (!backupWorld()) {
        if (runLog) await new Promise((r) => runLog.end(r))
        return 3
      }
    }
    if (opt.server === 'none') {
      log('--server none：不启动服务器（行为测试会全部跳过）')
      serverOk = false
    } else {
      serverOk = await startServer()
    }
  }

  const results = []
  RESULTS = results
  META = { reset: opt.reset, retry: opt.retry, needsServer: needServer }
  for (let i = 0; i < list.length; i++) {
    const test = list[i]
    const idx = i + 1
    if (!test.offline && !serverOk) {
      log('跳过 ' + test.name + '（服务器不可用）')
      results.push({ test, status: 'SKIP', ms: 0, tries: 0, logfile: null, tail: ['服务器不可用，跳过'] })
      continue
    }
    let attempt = 0
    let r = null
    while (attempt <= opt.retry) {
      attempt++
      log('▶ [' + idx + '/' + list.length + '] ' + test.name + '（' + test.cat + '，超时 ' +
        test.timeout + 's' + (attempt > 1 ? '，第 ' + attempt + ' 次' : '') + '）')
      r = await runTest(test, idx)
      const ok = !r.timedOut && r.code === 0
      log((ok ? '✔ ' : '✘ ') + test.name + ' ' + (r.timedOut ? '超时' : '退出码 ' + r.code) +
        '，用时 ' + fmtDur(r.ms))
      if (ok) break
      if (attempt <= opt.retry) {
        log('  重试前清场：')
        killOrphanAi()
        if (!test.offline) serverOk = await ensureServerAlive()
        await sleep(5000)
      }
    }
    const status = r.timedOut ? 'TIMEOUT' : (r.code === 0 ? 'PASS' : 'FAIL')
    if (status !== 'PASS') {
      log('  末尾输出：')
      for (const line of r.tail.slice(-8)) log('  | ' + line)
    }
    results.push({ test, status, ms: r.ms, tries: attempt, logfile: r.logfile, tail: r.tail })
    killOrphanAi()
    if (!test.offline && serverOk) serverOk = await ensureServerAlive()
    fs.writeFileSync(path.join(OUT_DIR, '进度.txt'), progressText(list, results), 'utf8')
  }

  if (serverState.child) await stopServer()
  const report = writeReport(results, { reset: opt.reset, retry: opt.retry, needsServer: needServer })
  const bad = results.filter((r) => r.status !== 'PASS').length
  log('===== 结束：' + (results.length - bad) + '/' + results.length + ' 通过' +
    (bad ? '，' + bad + ' 个没过' : '') + ' =====')
  log('报告：' + path.relative(ROOT, report))
  if (runLog) await new Promise((r) => runLog.end(r))
  return bad ? 1 : 0
}

main().then((code) => {
  // 日志流已经 end 完了，这里可以直接退
  process.exit(code)
}).catch(async (e) => {
  log('❌ 回归脚本自己崩了：' + (e && e.stack ? e.stack : e))
  // 无人值守最怕"什么都没留下"：先把服务器收干净，再把已跑的结果写成报告
  try { if (serverState.child) await stopServer() } catch (e2) { /* ignore */ }
  try {
    if (RESULTS.length && META) {
      const crash = {
        test: { name: '（回归脚本异常中止）', cat: '—' },
        status: 'FAIL', ms: 0, tries: 0, logfile: null,
        tail: String((e && e.stack) || e).split(/\r?\n/)
      }
      const f = writeReport(RESULTS.concat([crash]), META)
      log('已写出部分报告：' + path.relative(ROOT, f))
    }
  } catch (e2) {
    log('（部分报告也写不出来：' + (e2 && e2.message) + '）')
  }
  if (runLog) runLog.end(() => process.exit(1))
  else process.exit(1)
})



