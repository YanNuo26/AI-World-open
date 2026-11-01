// ===== 自定义界面：性能（源码/panel/web/views/perf.js）=====
// app.js 用 import('/views/perf.js') 加载它，约定导出 render(root, feature)。
// 公共工具从 window.panelUI 拿（app.js 末尾挂上去的：h / api / toast / fmtDur）。
//
// 这里有三处和"普通页面"不一样的地方：
//   1. 检测器**默认关闭**：关着时不轮询（连定时器都不开），只显示一段说明 + 开启按钮。
//      原因是采样要起一次系统命令（约 0.2 秒 CPU），没必要一直跑。
//   2. 开着时每 2 秒轮询，但**只在数字变了才重画**（和 app.js 的 stable() 一个思路）：
//      重画会闪一下、也会打断选中文字，能少画就少画。
//   3. 表格里除了服务器，还有**面板自己**和**每一个 ai**：谁在吃 CPU 一眼看出来。
const { h, api, toast, fmtDur } = window.panelUI

function fmtBytes (n) {
  const v = Number(n)
  if (!isFinite(v) || v <= 0) return '—'
  const g = 1024 * 1024 * 1024
  if (v >= g) return (v / g).toFixed(1) + ' GB'
  return (v / 1024 / 1024).toFixed(0) + ' MB'
}

function fmtAgo (sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  if (s < 3600) return Math.floor(s / 60) + ' 分钟'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时 ' + (Math.floor(s / 60) % 60) + ' 分'
  return Math.floor(s / 86400) + ' 天 ' + (Math.floor(s / 3600) % 24) + ' 小时'
}

// 一根进度条（percent 可能 > 100 或 null，都要能画）
function meter (percent, cls) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0))
  return h('div', { class: 'meter ' + (cls || '') }, h('i', { style: { width: p + '%' } }))
}

function level (percent) {
  const p = Number(percent) || 0
  return p >= 90 ? 'lv-err' : p >= 70 ? 'lv-warn' : 'lv-ok'
}

// 进程 CPU 显示：没运行 / 还没采到第二份 / 正常数字
function cpuText (p) {
  if (!p || !p.running) return '—'
  if (p.cpuPercent == null) return '—'
  return Number(p.cpuPercent).toFixed(1) + '%'
}

function card (title, badge, kids, opts) {
  return h('div', { class: 'card perf-card' + (opts && opts.wide ? ' wide' : '') },
    h('div', { class: 'card-head' },
      h('h2', {}, title),
      badge ? h('span', { class: 'badge b-' + badge.kind }, badge.text) : null),
    ...kids
  )
}

// 键值小表（内存 / PID 这类"名字: 值"的信息）
function kvTable (rows) {
  const t = h('table', { class: 'kv' })
  for (const r of rows) t.appendChild(h('tr', {}, h('th', {}, r[0]), h('td', {}, r[1])))
  return t
}

function toggleBtn (feature, d, reload) {
  const b = h('button', { class: d.enabled ? 'small' : 'primary' },
    d.enabled ? '关闭性能检测' : '开启性能检测')
  b.addEventListener('click', async () => {
    b.disabled = true
    try {
      const r = await api('/api/' + feature.id + '/toggle', { method: 'POST', body: { enabled: !d.enabled } })
      toast(r.note || '已切换', 'ok')
      await reload()
    } catch (e) {
      toast(e.message, 'err')
      b.disabled = false
    }
  })
  return b
}

// 关闭状态：说明 + 开启按钮（不轮询，什么都不采）
function offView (d, feature, reload) {
  const pid = d.panel && d.panel.pid ? d.panel.pid : '?'
  return h('div', { class: 'perf-off' },
    h('h2', {}, '性能检测：已关闭（默认）'),
    h('p', { class: 'muted small' },
      '为什么默认关：每次采样要起一次系统命令（约 0.2 秒 CPU）。偶尔看一次没感觉，' +
      '但一直开着就是白白占 CPU —— 而面板本来就是"顺手看看"的工具。'),
    h('ul', {},
      h('li', {}, '整机：CPU（含每个核心）、内存、项目所在磁盘'),
      h('li', {}, '面板自己：CPU 占用、内存（RSS / 堆）、已运行时间'),
      h('li', {}, '每个 ai（主 ai + 召唤出来的）和 Minecraft 服务器：CPU / 内存 / 已运行时间'),
      h('li', {}, '开启后每 2 秒刷新；切到别的页面就停，不会留在后台空转')),
    h('div', { class: 'formfoot' }, toggleBtn(feature, d, reload)),
    h('p', { class: 'note preline' },
      '面板 PID ' + pid + ' · Node ' + (d.node || '?') + ' · 已运行 ' + fmtDur(d.panelUptimeMs) + '\n' +
      (d.host || '?') + ' · ' + (d.platform || '') + ' · 共 ' + (d.cores || '?') + ' 核')
  )
}


// 开启状态：卡片（面板自己 / 整机 CPU / 内存 / 磁盘 / 进程与 ai）
function onView (d, feature, reload) {
  const cpu = d.cpu || {}
  const mem = d.mem || {}
  const disk = d.disk
  const panel = d.panel || {}
  const procs = d.procs || []
  const grid = h('div', { class: 'cards' })

  // ---- 面板自己 ----
  grid.appendChild(card('面板自己', { kind: level(panel.cpuPercent), text: 'PID ' + (panel.pid || '?') }, [
    h('div', { class: 'big-num' }, cpuText(panel)),
    meter(panel.cpuPercent, level(panel.cpuPercent)),
    kvTable([
      ['内存', fmtBytes(panel.rss)],
      ['堆', fmtBytes(panel.heapUsed)],
      ['已运行', fmtDur(panel.uptimeMs)],
      ['机器核心', (d.cores || '?') + ' 核']
    ]),
    h('div', { class: 'note' }, '面板自己的 CPU / 内存用 Node 计数器直接读，不起系统命令。')
  ]))

  // ---- 整机 CPU ----
  const cores = cpu.cores || []
  grid.appendChild(card('整机 CPU', { kind: level(cpu.percent), text: (cpu.count || 0) + ' 核' }, [
    h('div', { class: 'big-num' }, (cpu.percent || 0).toFixed(1) + '%'),
    meter(cpu.percent, level(cpu.percent)),
    h('div', { class: 'muted small' }, (cpu.model || '') + (cpu.speedMhz ? ' · ' + cpu.speedMhz + ' MHz' : '')),
    h('div', { class: 'coregrid' }, ...cores.map((p, i) =>
      h('div', { class: 'core' }, h('span', {}, '#' + i), meter(p, level(p)), h('b', {}, Math.round(p) + '%'))
    )),
    cpu.warm === false ? h('div', { class: 'note' }, '第一次采样，2 秒后出真实数字') : null
  ]))

  // ---- 内存 ----
  grid.appendChild(card('内存', { kind: level(mem.percent), text: (mem.percent || 0) + '%' }, [
    h('div', { class: 'big-num' }, fmtBytes(mem.used) + ' / ' + fmtBytes(mem.total)),
    meter(mem.percent, level(mem.percent)),
    h('div', { class: 'note' }, '空闲 ' + fmtBytes(mem.free))
  ]))

  // ---- 磁盘 ----
  grid.appendChild(card('磁盘', disk ? { kind: level(disk.percent), text: (disk.percent || 0) + '%' } : { kind: 'idle', text: '读不到' },
    disk ? [
      h('div', { class: 'big-num' }, fmtBytes(disk.used) + ' / ' + fmtBytes(disk.total)),
      meter(disk.percent, level(disk.percent)),
      h('div', { class: 'note' }, '剩余 ' + fmtBytes(disk.free) + '（项目所在盘）')
    ] : [h('div', { class: 'note' }, '这台机器的 Node 不支持读磁盘用量（不影响使用）')]
  ))

  // ---- 进程与全部 ai（整行宽）----
  const KIND = {
    panel: ['面板', 'busy'],
    server: ['服务器', 'warn'],
    'ai-main': ['主 ai', 'ok'],
    ai: ['ai', 'idle']
  }
  const t = h('table', { class: 'list' })
  t.appendChild(h('thead', {}, h('tr', {},
    h('th', {}, '进程 / ai'),
    h('th', { style: { width: '92px' } }, 'PID'),
    h('th', { style: { width: '76px' } }, 'CPU'),
    h('th', { style: { width: '92px' } }, '内存'),
    h('th', { style: { width: '110px' } }, '已运行')
  )))
  const tb = h('tbody')
  for (const p of procs) {
    const k = KIND[p.kind] || [p.kind || '?', 'idle']
    tb.appendChild(h('tr', { class: p.running ? '' : 'muted' },
      h('td', {}, h('span', { class: 'badge b-' + k[1] }, k[0]), ' ', p.label || '—',
        p.owner ? h('span', { class: 'small muted' }, ' · 归 ' + p.owner) : null),
      h('td', {}, p.pid ? String(p.pid) : '未运行'),
      h('td', {}, cpuText(p)),
      h('td', {}, fmtBytes(p.rss)),
      h('td', {}, p.uptimeMs ? fmtDur(p.uptimeMs) : '—')
    ))
  }
  t.appendChild(tb)
  grid.appendChild(card('进程与全部 ai',
    { kind: 'idle', text: procs.filter((p) => p.running).length + ' 个在跑' }, [t], { wide: true }))

  return h('div', {},
    h('div', { class: 'perf-head muted small' },
      (d.host || '?') + ' · ' + (d.platform || '') + ' · Node ' + d.node +
      ' · 开机 ' + fmtAgo(d.uptimeSec) + ' · 面板已运行 ' + fmtDur(d.panelUptimeMs)),
    grid,
    d.source === 'tasklist'
      ? h('div', { class: 'warnbar' }, '这台机器读不到各进程的 CPU（没有 PowerShell），只显示内存占用。')
      : null,
    h('p', { class: 'note preline' },
      (d.note || '') + '\n' +
      '服务器和所有 ai 都跑在这台电脑上：CPU / 内存吃满时游戏会卡，先看上面表格里哪一行最大。\n' +
      '第一次打开时进程 CPU 显示"—"（要两份采样相减），2 秒后就有数；关掉这个页面就不再采样。')
  )
}

function draw (box, d, ctx) {
  box.innerHTML = ''
  box.appendChild(h('div', { class: 'perfbar' },
    h('span', { class: 'small muted' }, d.enabled ? '性能检测：已开启 · 每 2 秒采样一次（切走自动停）' : '性能检测：已关闭（默认）'),
    d.enabled ? h('span', { class: 'tabs-sp' }) : null,
    d.enabled ? toggleBtn(ctx.feature, d, ctx.tick) : null
  ))
  box.appendChild(d.enabled ? onView(d, ctx.feature, ctx.tick) : offView(d, ctx.feature, ctx.tick))
}

export async function render (root, feature) {
  const box = h('div', { class: 'perfview' }, h('p', { class: 'muted' }, '读取中…'))
  root.innerHTML = ''
  root.appendChild(box)

  let timer = null
  const stop = () => {
    if (timer) { clearInterval(timer); timer = null }
  }

  const tick = async () => {
    if (!box.isConnected) { stop(); return false } // 切到别的页面了（app.js 会清空 #view）
    let d
    try {
      d = await api('/api/' + feature.id)
    } catch (e) {
      if (box.isConnected) {
        box.innerHTML = ''
        box.appendChild(h('div', { class: 'warnbar' }, '读不到性能数据：' + e.message))
      }
      return false
    }
    if (!box.isConnected) { stop(); return false }
    draw(box, d, { feature, tick })
    // 只有开着的时候才轮询：关掉（或用户切页）就彻底停，不留在后台空转
    if (d.enabled) { if (!timer) timer = setInterval(tick, 2000) } else stop()
    return true
  }

  const alive = await tick()
  if (!alive) stop()
}
