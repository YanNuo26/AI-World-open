// ===== 进程管理（源码/panel/api/_procs.js）=====
// 面板要"一键启动"的东西只有两个：Minecraft 服务器（java）和 ai（node 源码/bot.js）。
// 这里集中管理它们，processes.js / overview.js 只是把它包装成 HTTP 接口。
//
// 三个必须守住的规矩：
//   1. 只认**面板自己拉起来**的子进程（能拿到 PID 才敢停）；外部启动的服务器只能探测 + RCON。
//   2. 子进程的 stdout 要**自己攒行**（服务器一次 write 可能是半行）并留环形缓冲给前端轮询。
//   3. 网络/进程操作一律给超时，绝不让面板卡死（否则用户以为面板坏了）。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const U = require('./_util')
const S = require('./_state')

const JAVA = process.env.JAVA_EXE || 'java'
// 和 脚本/启动服务器.bat 保持一致的 JVM 参数（GBK 是为了修中文日志乱码，见 文档/AI参考.md 坑 25）
const JAVA_ARGS = [
  '-Xms1G', '-Xmx2G',
  '-Dfile.encoding=GBK', '-Dsun.stdout.encoding=GBK', '-Dsun.stderr.encoding=GBK',
  '-jar', 'server.jar', '--nogui'
]
const SERVER_LOG = path.join(U.LOG_DIR, 'server_console.log')
const MAX_LOG_BYTES = 8 * 1024 * 1024

function ensureDir (dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { /* ignore */ }
}

// 把子进程输出接进环形缓冲（+ 可选落盘）。按行切，半行留在 child._rest 里等下一次。
function attachOutput (key, child, file) {
  let stream = null
  if (file) {
    ensureDir(path.dirname(file))
    try {
      const st = fs.existsSync(file) ? fs.statSync(file) : null
      if (st && st.size > MAX_LOG_BYTES) fs.renameSync(file, file + '.old') // 太大就滚一份，别无限长
      stream = fs.createWriteStream(file, { flags: 'a' })
    } catch (e) { stream = null }
  }
  child._rest = ''
  const feed = (chunk) => {
    if (stream) { try { stream.write(chunk) } catch (e) { /* ignore */ } }
    const parts = (child._rest + String(chunk)).split(/\r?\n/)
    child._rest = parts.pop()
    for (const line of parts) if (line.length) S.pushLine(key, line)
  }
  if (child.stdout) child.stdout.on('data', feed)
  if (child.stderr) child.stderr.on('data', feed)
  child.on('close', () => { if (stream) try { stream.end() } catch (e) { /* ignore */ } })
  return child
}

function killTree (child) {
  if (!child || child.exitCode !== null) return
  try { child.kill() } catch (e) { /* ignore */ }
  // Windows 上 kill() 基本等于 TerminateProcess；留 3 秒给正常退出，再强杀一次
  setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL') } catch (e) { /* ignore */ } }, 3000)
}

function waitExit (child, ms) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve(true)
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    child.once('close', () => finish(true))
    setTimeout(() => finish(child.exitCode !== null), ms)
  })
}

// ---------- 服务器 ----------
// RCON 查询玩家列表带 3 秒缓存：卡片每 2 秒轮询一次，而 rconCommand 超时是 10 秒，
// 不缓存的话 RCON 一不可用就会把轮询请求越堆越多（面板看起来"卡死"）。
const playersCache = { at: 0, key: '', value: null, error: null }

function serverPathsOk () {
  const jar = path.join(U.SERVER_DIR, 'server.jar')
  const props = path.join(U.SERVER_DIR, 'server.properties')
  return { jar: fs.existsSync(jar), props: fs.existsSync(props) }
}


async function serverStatus () {
  const cfg = U.config.load()
  const owned = S.state.procs.server
  const probe = await U.probeTcp(cfg.server.host, cfg.server.port, 700)
  const local = U.config.isLocalHost(cfg.server.host)
  let players = null
  let rconError = null
  // 玩家列表只能靠 RCON（服务器控制台命令），对外的服务器基本不给 RCON
  if (probe.ok && local && cfg.rcon.enabled) {
    const cacheKey = cfg.rcon.host + ':' + cfg.rcon.port
    if (playersCache.key === cacheKey && Date.now() - playersCache.at < 3000) {
      players = playersCache.value
      rconError = playersCache.error
    } else {
      try {
        const out = await U.rcon.rconCommand('list', cfg.rcon)
        const m = /:\s*(.*)$/.exec(String(out || ''))
        players = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []
        rconError = null
      } catch (e) {
        players = null
        rconError = e && e.message
      }
      playersCache.at = Date.now()
      playersCache.key = cacheKey
      playersCache.value = players
      playersCache.error = rconError
    }
  }
  const ownAlive = !!(owned && owned.child && owned.child.exitCode === null)
  let phase = 'stopped'
  if (probe.ok) phase = ownAlive ? 'running' : 'external'
  else if (ownAlive) phase = 'starting'
  return {
    phase,
    owned: ownAlive,
    pid: ownAlive ? owned.pid : null,
    uptimeMs: ownAlive ? Date.now() - owned.startedAt : 0,
    host: cfg.server.host,
    port: cfg.server.port,
    local,
    listening: probe.ok,
    latencyMs: probe.ok ? probe.ms : null,
    probeError: probe.ok ? null : probe.error,
    players,
    rconEnabled: !!cfg.rcon.enabled,
    rconError,
    paths: serverPathsOk()
  }
}

async function startServer () {
  const cfg = U.config.load()
  const st = await serverStatus()
  if (st.owned) throw new U.HttpError(409, '面板已经在管着服务器了（PID ' + st.pid + '）')
  if (st.phase === 'external') {
    throw new U.HttpError(409, '端口 ' + cfg.server.port + ' 上已经有服务器在运行，' +
      '但它不是面板启动的，面板没法接管。要停它请用 RCON 或手动关窗口。')
  }
  const paths = serverPathsOk()
  if (!paths.jar) {
    throw new U.HttpError(400, '服务器/server.jar 不存在：请先跑一次 脚本\\start_server.ps1 做首次初始化')
  }
  if (!paths.props) {
    throw new U.HttpError(400, '服务器/server.properties 不存在：请先跑一次 脚本\\start_server.ps1')
  }
  S.clearLines('server')
  S.pushLine('server', '==== 面板启动服务器 ' + U.fmtTime(Date.now()) + ' ====')
  const child = spawn(JAVA, JAVA_ARGS, { cwd: U.SERVER_DIR, windowsHide: true })
  attachOutput('server', child, SERVER_LOG)
  child.on('error', (e) => {
    S.pushLine('server', '[面板] 启动 java 失败：' + (e && e.message) +
      '（java 不在 PATH？可以先跑 脚本\\启动服务器.bat 确认）')
  })
  child.on('close', (code) => {
    S.pushLine('server', '==== 服务器已退出（code ' + code + '）====')
    S.state.procs.server = null
  })
  S.state.procs.server = { child, pid: child.pid, startedAt: Date.now() }
  return { ok: true, pid: child.pid, note: '正在启动，首次进世界约需 30–60 秒（看下面的输出）' }
}


async function stopServer () {
  const cfg = U.config.load()
  const owned = S.state.procs.server
  if (owned && owned.child && owned.child.exitCode === null) {
    S.pushLine('server', '[面板] 发送 stop 命令，等待服务器保存世界…')
    try { owned.child.stdin.write('stop\n') } catch (e) { /* stdin 可能已关 */ }
    const exited = await waitExit(owned.child, 20000)
    if (!exited) {
      S.pushLine('server', '[面板] 20 秒没退出，强制结束进程')
      killTree(owned.child)
      await waitExit(owned.child, 5000)
    }
    return {
      ok: true,
      note: exited ? '服务器已正常保存并退出' : '服务器没响应 stop，已强制结束（世界可能没存完整）'
    }
  }
  // 不是面板启动的：只能试 RCON
  if (cfg.rcon.enabled) {
    try {
      await U.rcon.rconCommand('stop', cfg.rcon)
      return { ok: true, note: '已通过 RCON 让服务器停止（它不是面板启动的进程）' }
    } catch (e) {
      throw new U.HttpError(400, '无法停止：服务器不是面板启动的，RCON 也用不了（' + e.message + '）')
    }
  }
  throw new U.HttpError(400, '无法停止：服务器不是面板启动的，且 RCON 未启用')
}

// 往服务器控制台发命令（只有面板启动的进程才拿得到 stdin）
async function serverCommand (command) {
  const cmd = String(command || '').trim()
  if (!cmd) throw new U.HttpError(400, '命令不能为空')
  const owned = S.state.procs.server
  if (owned && owned.child && owned.child.exitCode === null) {
    S.pushLine('server', '> ' + cmd)
    owned.child.stdin.write(cmd + '\n')
    return { ok: true, note: '已发送到服务器控制台' }
  }
  const cfg = U.config.load()
  if (!cfg.rcon.enabled) throw new U.HttpError(400, '服务器不是面板启动的，且 RCON 未启用，发不了命令')
  const out = await U.rcon.rconCommand(cmd, cfg.rcon)
  return { ok: true, via: 'rcon', output: String(out || '') }
}

// ---------- ai ----------
function aiStatus () {
  const owned = S.state.procs.ai
  const alive = !!(owned && owned.child && owned.child.exitCode === null)
  const cfg = U.config.load()
  return {
    running: alive,
    pid: alive ? owned.pid : null,
    uptimeMs: alive ? Date.now() - owned.startedAt : 0,
    name: cfg.ai.name,
    host: cfg.server.host,
    port: cfg.server.port,
    // bot.js 自己会写这份日志（源码/logger.js），面板只是指个路
    logFile: 'ai_' + String(cfg.ai.name || 'world').replace(/[\\/:*?"<>|@\s]/g, '_') + '.log'
  }
}

function startAi () {
  const st = aiStatus()
  if (st.running) throw new U.HttpError(409, 'ai 已经在运行了（PID ' + st.pid + '）')
  S.clearLines('ai')
  S.pushLine('ai', '==== 面板启动 ai ' + U.fmtTime(Date.now()) + ' ====')
  const child = spawn(process.execPath, [path.join('源码', 'bot.js')], {
    cwd: U.ROOT,
    windowsHide: true,
    env: process.env
  })
  attachOutput('ai', child, null) // bot.js 自己写 日志/ai_<名字>.log，这里不重复落盘
  child.on('error', (e) => S.pushLine('ai', '[面板] 启动 ai 失败：' + (e && e.message)))
  child.on('close', (code, sig) => {
    S.pushLine('ai', '==== ai 已退出（code ' + code + (sig ? ' / ' + sig : '') + '）====')
    S.state.procs.ai = null
  })
  S.state.procs.ai = { child, pid: child.pid, startedAt: Date.now() }
  return { ok: true, pid: child.pid, note: '已启动，看下面的输出确认是否 Logged in' }
}

async function stopAi () {
  const owned = S.state.procs.ai
  if (!owned || !owned.child || owned.child.exitCode !== null) {
    throw new U.HttpError(400, 'ai 不是面板启动的（或已经退出），没法从面板停它')
  }
  S.pushLine('ai', '[面板] 正在停止 ai…')
  killTree(owned.child)
  const exited = await waitExit(owned.child, 6000)
  return { ok: true, note: exited ? 'ai 已停止' : '已发强杀，进程可能还在收尾' }
}

// ---- ai 名单：主 ai + 游戏里 summon 出来的 ----
// 面板只"托管"主 ai（它才是面板拉起来的进程）；其余 ai 是主 ai fork 出来的子进程，
// 它们的 pid 由 bot.js 写进 ais.json（见 summonAI），这里只负责读出来 + 探活。
const AIS_FILE = path.join(U.ROOT, 'ais.json')

// 进程还在不在。pid 存在但没权限查（EPERM）也算在，宁可当成活着也别谎报死亡
function alive (pid) {
  const n = parseInt(pid, 10)
  if (!n || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    return !!(e && e.code === 'EPERM')
  }
}

function aiList () {
  const cfg = U.config.load()
  const owned = S.state.procs.ai
  const mainAlive = !!(owned && owned.child && owned.child.exitCode === null)
  let ais = {}
  try {
    ais = JSON.parse(fs.readFileSync(AIS_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) { ais = {} }
  if (!ais || typeof ais !== 'object' || Array.isArray(ais)) ais = {}
  const main = cfg.ai.name
  const names = []
  // 主 ai 永远排第一：ais.json 被重置 / 读不出来时也得能看到它
  if (!Object.prototype.hasOwnProperty.call(ais, main)) names.push(main)
  for (const n of Object.keys(ais)) if (!names.includes(n)) names.push(n)
  return names.map((name) => {
    const rec = ais[name] || {}
    const isMain = name === main
    const pid = isMain ? (mainAlive ? owned.pid : null) : (rec.pid || null)
    return {
      name,
      main: isMain,
      owner: rec.owner || null,
      obey: Array.isArray(rec.obey) ? rec.obey : [],
      pid: pid || null,
      running: isMain ? mainAlive : alive(pid),
      // 召唤时间（bot.js summonAI 写的）：性能页算"这个 ai 跑了多久"
      since: typeof rec.since === 'number' ? rec.since : null,
      renamedFrom: typeof rec.renamedFrom === 'string' ? rec.renamedFrom : ''
    }
  })
}

// 面板退出：把自己拉起的东西收干净（服务器走 stop，保证存档正常保存）
async function shutdown () {
  const ownedAi = S.state.procs.ai
  if (ownedAi && ownedAi.child && ownedAi.child.exitCode === null) {
    S.pushLine('ai', '[面板] 面板关闭，停止 ai')
    killTree(ownedAi.child)
    await waitExit(ownedAi.child, 4000)
  }
  const owned = S.state.procs.server
  if (owned && owned.child && owned.child.exitCode === null) {
    S.pushLine('server', '[面板] 面板关闭，发送 stop')
    try { owned.child.stdin.write('stop\n') } catch (e) { /* ignore */ }
    const exited = await waitExit(owned.child, 15000)
    if (!exited) killTree(owned.child)
  }
}

// 取输出。两种用法：
//   since=N   增量：只要第 N 行之后的（前端自己存 next）
//   tail=N    只要最后 N 行（面板卡片每次整块重绘时用，省得传 1000 多行）
function output (target, since, tail) {
  const key = target === 'ai' ? 'ai' : 'server'
  const arr = S.state.lines[key] || []
  if (tail != null) {
    const n = Math.max(1, Math.min(U.toInt(tail, 60), 800))
    const from = Math.max(0, arr.length - n)
    return { target: key, from, total: arr.length, lines: arr.slice(from), next: arr.length }
  }
  const from = Math.max(0, Math.min(U.toInt(since, 0), arr.length))
  return { target: key, from, total: arr.length, lines: arr.slice(from), next: arr.length }
}

module.exports = {
  serverStatus, startServer, stopServer, serverCommand,
  aiStatus, aiList, startAi, stopAi,
  output, shutdown,
  SERVER_LOG
}
