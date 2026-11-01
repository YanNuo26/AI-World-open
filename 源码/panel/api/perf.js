// ===== 面板功能：性能（源码/panel/api/perf.js）=====
// 需求：一眼看出"这台电脑被谁吃满了"——面板自己 / Minecraft 服务器 / 每一个 ai 各占多少。
//
// 三条硬规矩（改之前先读）：
//   1. **默认关闭**（配 配置/面板设置.json 的 perf.enabled，见 _settings.js）。
//      采样要起子进程（约 200ms CPU），属于"想看才开"的东西；不能一开面板就在旁边一直吃 CPU。
//      关着的时候 GET /api/perf 只回几个几乎零成本的数字（pid / 运行时长 / 机器名）。
//   2. 进程的 CPU 只能问系统：wmic 在 Windows 11 24H2 已被**移除**（踩过），
//      所以用 PowerShell 的 Get-Process —— 一次调用把所有 pid 问完（本机实测约 200ms，比 tasklist 还快）；
//      没有 PowerShell 就退回 tasklist：它只有内存、没有 CPU，前端会说明"这台机器读不到 CPU"。
//   3. CPU 占用率是**两次采样的差值**（Get-Process 的 CPU 是累计秒数，不是瞬时值），
//      所以刚打开时第一次一定是"—"，第二次（约 2 秒后）才有数字。
//      Windows 的 os.loadavg() 恒为 [0,0,0]，不显示它。
//
// 百分比口径：和任务管理器一致 —— 占**整机**的百分比（已除以核心数）。
//   例：16 核机器上把一个核跑满 ≈ 6.3%。
const os = require('os')
const fs = require('fs')
const { execFile } = require('child_process')
const U = require('./_util')
const S = require('./_state')
const P = require('./_procs')
const SETTINGS = require('./_settings')

const KEY = 'perf.enabled'
// 进程采样最短间隔：前端 2 秒问一次，这里再兜一层（多个标签页同时开着也不会翻倍采样）
const PROC_TTL_MS = 1600
const PS_EXE = process.env.POWERSHELL_EXE || 'powershell'

function enabled () {
  return SETTINGS.get(KEY, false) === true
}

function cores () {
  return (os.cpus() || []).length || 1
}

function round1 (v) {
  return Math.round(v * 10) / 10
}

// ---- 整机 CPU：两次 os.cpus() 的时间差 ----
let lastSnap = null

function snap () {
  const list = (os.cpus() || []).map((c) => {
    const t = c.times || {}
    const idle = t.idle || 0
    const total = idle + (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0)
    return { idle, total, model: c.model, speed: c.speed }
  })
  return { at: Date.now(), cores: list }
}

function pct (dIdle, dTotal) {
  if (!(dTotal > 0)) return 0
  return round1(Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)))
}

function cpuInfo () {
  const now = snap()
  const prev = lastSnap
  lastSnap = now
  if (!prev || prev.cores.length !== now.cores.length) {
    return { percent: 0, cores: now.cores.map(() => 0), warm: false, count: now.cores.length }
  }
  let dIdle = 0
  let dTotal = 0
  const list = now.cores.map((c, i) => {
    const p = prev.cores[i]
    const di = c.idle - p.idle
    const dt = c.total - p.total
    dIdle += di
    dTotal += dt
    return pct(di, dt)
  })
  const first = now.cores[0] || {}
  return {
    percent: pct(dIdle, dTotal),
    cores: list,
    warm: true,
    count: now.cores.length,
    model: String(first.model || '').replace(/\s+/g, ' ').trim(),
    speedMhz: first.speed || null
  }
}

function memInfo () {
  const total = os.totalmem()
  const free = os.freemem()
  const used = Math.max(0, total - free)
  return { total, free, used, percent: total ? round1((used / total) * 100) : 0 }
}

// 磁盘：fs.statfsSync 要 Node 18.15+（本机 Node 24 可用）；
// 万一不支持就返回 null，前端那一格显示"读不到"，不影响其它数据。
function diskInfo () {
  try {
    const st = fs.statfsSync(U.ROOT)
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    if (!total) return null
    const used = total - free
    return { total, free, used, percent: round1((used / total) * 100) }
  } catch (e) {
    return null
  }
}


// ---- 各进程的 CPU / 内存 ----
// procSnap = { at, map: Map<pid, { cpuMs, rss }>, source }
//   source: 'powershell'（有 CPU 有内存）| 'tasklist'（只有内存）| 'none'
let procSnap = null
const pctCache = new Map() // pid -> { at, cpuMs, pct }

// PowerShell 脚本：一行一个进程，输出 "pid CPU毫秒 内存字节"。
// 字符串全用单引号拼 —— execFile 传参时不用和引号转义打架（踩过：\" 会被 PS 5.1 吃坏）。
function psScript (pids) {
  return 'Get-Process -Id ' + pids.join(',') + ' -ErrorAction SilentlyContinue | ' +
    "ForEach-Object { $_.Id.ToString() + ' ' + [int64]($_.CPU*1000) + ' ' + $_.WorkingSet64 }"
}

function parsePs (stdout) {
  const map = new Map()
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const c = line.trim().split(/\s+/)
    if (c.length < 3) continue
    const pid = parseInt(c[0], 10)
    const cpuMs = parseInt(c[1], 10)
    const rss = parseInt(c[2], 10)
    if (!pid || !isFinite(rss)) continue
    map.set(pid, { cpuMs: isFinite(cpuMs) ? cpuMs : null, rss })
  }
  return map
}

// 退回方案：tasklist 一次列出全部进程，按 pid 过滤（只有内存）
function tasklistProcs (want) {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 4000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        const map = new Map()
        if (!stdout) return resolve(map)
        const set = new Set(want)
        for (const line of String(stdout).split(/\r?\n/)) {
          const cells = line.trim().replace(/^"|"\s*$/g, '').split('","')
          if (cells.length < 5) continue
          const pid = parseInt(cells[1], 10)
          if (!set.has(pid)) continue
          const kb = parseInt(String(cells[4]).replace(/[^\d]/g, ''), 10)
          map.set(pid, { cpuMs: null, rss: isFinite(kb) ? kb * 1024 : null })
        }
        resolve(map)
      })
  })
}

function psProcs (pids) {
  const want = Array.from(new Set(pids.map((n) => parseInt(n, 10)).filter((n) => n > 0)))
  if (!want.length) return Promise.resolve({ at: Date.now(), map: new Map(), source: 'none' })
  if (procSnap && Date.now() - procSnap.at < PROC_TTL_MS) return Promise.resolve(procSnap)
  return new Promise((resolve) => {
    execFile(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', psScript(want)],
      { windowsHide: true, timeout: 5000, maxBuffer: 512 * 1024 }, (err, stdout) => {
        const map = parsePs(stdout)
        if (map.size) {
          procSnap = { at: Date.now(), map, source: 'powershell' }
          return resolve(procSnap)
        }
        tasklistProcs(want).then((m) => {
          procSnap = { at: Date.now(), map: m, source: 'tasklist' }
          resolve(procSnap)
        })
      })
  })
}

// 两次采样之间这个进程用了多少 CPU（占整机百分比）。
// 第一次没有"上一份" → null（前端显示"—"）；复用同一份缓存采样 → 直接给上次算出的数。
function pctOf (pid, cpuMs, at) {
  if (!pid || cpuMs == null) return null
  const c = pctCache.get(pid)
  if (c && c.at === at && c.cpuMs === cpuMs) return c.pct
  const p = (c && at > c.at && cpuMs >= c.cpuMs)
    ? round1((cpuMs - c.cpuMs) / (at - c.at) / cores() * 100)
    : null
  pctCache.set(pid, { at, cpuMs, pct: p })
  return p
}

// 面板自己的 CPU：process.cpuUsage() 免费又精确，不用麻烦系统工具
let panelPrev = null

function panelCpu (at) {
  const now = { at, usage: process.cpuUsage() }
  const prev = panelPrev
  panelPrev = now
  if (!prev || at <= prev.at) return null
  const us = (now.usage.user - prev.usage.user) + (now.usage.system - prev.usage.system)
  return round1(us / 1000 / (at - prev.at) / cores() * 100)
}

// 开关一变 / 重新开启：把"上一份采样"全清掉，免得拿几分钟前的数据算出离谱的百分比
function resetSamples () {
  lastSnap = null
  procSnap = null
  pctCache.clear()
  panelPrev = null
}

function uptimeOf (owned) {
  return owned && owned.child && owned.child.exitCode === null ? Date.now() - owned.startedAt : 0
}

// ---- 采样：面板自己 + 服务器 + 每一个 ai ----
async function sample () {
  const cpu = cpuInfo()
  const mem = memInfo()
  const disk = diskInfo()
  const ais = P.aiList()
  const server = S.state.procs.server
  const serverPid = server && server.child && server.child.exitCode === null ? server.pid : null
  // 面板自己走 process.cpuUsage()（更准、零成本），其余进程一次问完系统
  const watched = [serverPid].concat(ais.map((a) => (a.running ? a.pid : null)))
  const ps = await psProcs(watched)
  const now = Date.now()
  const self = process.memoryUsage()

  const procs = [{
    kind: 'panel',
    label: '面板（本程序，node）',
    name: 'panel',
    pid: process.pid,
    running: true,
    cpuPercent: panelCpu(now),
    rss: self.rss,
    heapUsed: self.heapUsed,
    uptimeMs: now - S.state.startedAt
  }]

  const srec = serverPid ? ps.map.get(serverPid) : null
  procs.push({
    kind: 'server',
    label: 'Minecraft 服务器（java）',
    name: 'server',
    pid: serverPid || null,
    running: !!serverPid,
    cpuPercent: serverPid ? pctOf(serverPid, srec ? srec.cpuMs : null, ps.at) : null,
    rss: srec ? srec.rss : null,
    uptimeMs: uptimeOf(server)
  })

  for (const a of ais) {
    const rec = a.running && a.pid ? ps.map.get(a.pid) : null
    procs.push({
      kind: a.main ? 'ai-main' : 'ai',
      label: 'ai「' + a.name + '」' + (a.main ? '（主 ai）' : ''),
      name: a.name,
      owner: a.owner || null,
      pid: a.pid || null,
      running: !!a.running,
      cpuPercent: a.running ? pctOf(a.pid, rec ? rec.cpuMs : null, ps.at) : null,
      rss: rec ? rec.rss : null,
      // 主 ai 是面板拉起来的（有 startedAt）；召唤出来的 ai 用 summonAI 写进 ais.json 的 since
      uptimeMs: a.main ? uptimeOf(S.state.procs.ai) : (a.since ? Math.max(0, now - a.since) : 0)
    })
  }

  return {
    enabled: true,
    at: now,
    host: os.hostname(),
    platform: os.platform() + ' / ' + os.arch(),
    node: process.version,
    cores: cores(),
    uptimeSec: os.uptime(),
    panelUptimeMs: now - S.state.startedAt,
    source: ps.source,
    cpu,
    mem,
    disk,
    loadavg: os.loadavg(),
    panel: procs[0],
    procs,
    note: ps.source === 'tasklist'
      ? '这台机器读不到各进程的 CPU（没有 PowerShell），只显示内存占用'
      : '进程 CPU 是 2 秒内的平均值，占整机百分比（' + cores() + ' 核）'
  }
}

// 关着的时候：只回几个几乎零成本的数字（不采样、不起子进程）
function offPayload () {
  return {
    enabled: false,
    at: Date.now(),
    host: os.hostname(),
    platform: os.platform() + ' / ' + os.arch(),
    node: process.version,
    cores: cores(),
    uptimeSec: os.uptime(),
    panelUptimeMs: Date.now() - S.state.startedAt,
    panel: { pid: process.pid },
    note: '性能检测默认关闭（省 CPU）。开启后每 2 秒采样一次：整机 CPU / 内存 / 磁盘 + 面板自己 + 每个 ai 的占用。'
  }
}

module.exports = {
  id: 'perf',
  title: '性能',
  order: 45,
  status: 'ready',
  summary: '默认关闭的检测器：整机 + 面板自己 + 每个 ai 的 CPU / 内存占用',
  ui: { type: 'custom', view: 'perf' },
  routes: {
    'GET /': async () => (enabled() ? sample() : offPayload()),
    // 开关（持久化到 配置/面板设置.json；重开面板还是上次的选择）
    'POST /toggle': async (ctx) => {
      const b = ctx.body || {}
      const want = b.enabled === undefined ? !enabled() : (b.enabled === true || b.enabled === 'true')
      SETTINGS.set(KEY, !!want)
      resetSamples()
      return {
        ok: true,
        enabled: !!want,
        note: want
          ? '性能检测已开启（每 2 秒采样一次，关掉页面也不会继续跑）'
          : '性能检测已关闭（不再采样，省点 CPU）'
      }
    }
  }
}
