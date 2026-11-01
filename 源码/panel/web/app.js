// ===== AI-World 面板前端（源码/panel/web/app.js）=====
// 零依赖、无构建：这一个文件就是整个界面。
// 关键约定：**前端不认识任何具体功能** —— 只认 ui.type 的五种渲染器
//   cards / form / list / logs / custom
// 所以加功能只动 源码/panel/api/，这里一行都不用改；真要特殊界面才用 custom + web/views/<名字>.js。
const $id = (s) => document.getElementById(s)
const view = $id('view')
const state = { features: [], warnings: [], active: null, timer: null }

// ---------- 1. 工具 ----------
// 极简 DOM 构造：h('div', { class: 'x' }, '文字', h('b', {}, '粗'))
//   props 里 class / style / on* / 其它属性都能写；值为 null/false 就跳过
function h (tag, props, ...kids) {
  const el = document.createElement(tag)
  const p = props || {}
  for (const k of Object.keys(p)) {
    const v = p[k]
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'html') el.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
    else if (k in el) el[k] = v // value / checked / selected / rows / type …
    else el.setAttribute(k, v)
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return el
}

// 调接口：非 2xx 直接抛 Error（带后端那句中文），调用方 catch 后弹提示
async function api (path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} }
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(opts.body)
  }
  const res = await fetch(path, init)
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (e) { data = { error: text } }
  if (!res.ok) throw new Error((data && data.error) || ('请求失败：HTTP ' + res.status))
  return data
}

function toast (msg, kind) {
  const el = h('div', { class: 'toast ' + (kind || '') }, String(msg == null ? '' : msg))
  $id('toasts').appendChild(el)
  setTimeout(() => { try { el.remove() } catch (e) { /* ignore */ } }, kind === 'err' ? 9000 : 4000)
}

// 毫秒 → "3 分 12 秒"
function fmtDur (ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒'
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
}

// 执行一个"动作按钮"：确认 → POST → 提示 → 重画
async function act (btn, spec) {
  if (spec.confirm && !window.confirm(spec.confirm)) return
  const old = btn.textContent
  btn.disabled = true
  btn.textContent = '处理中…'
  try {
    const r = await api(spec.url, { method: spec.method || 'POST', body: spec.body === undefined ? {} : spec.body })
    const msg = r && (r.note || r.output) ? (r.note || r.output) : (spec.ok || '完成')
    toast(msg, 'ok')
    await refresh()
  } catch (e) {
    toast(e.message, 'err')
  } finally {
    btn.disabled = false
    btn.textContent = old
  }
}

// 按钮描述：后端给什么就画什么
//   { label, tab }                                    → 切到另一个功能页
//   { label, path, method, body, confirm, danger }    → 调 /api/<当前功能><path>
function button (spec) {
  const cls = 'btn' + (spec.primary ? ' primary' : '') + (spec.danger ? ' danger' : '')
  const el = h('button', { class: cls }, spec.label)
  if (spec.tab) {
    el.addEventListener('click', () => { location.hash = '#/' + spec.tab })
    return el
  }
  const url = '/api/' + state.active + (spec.path || '')
  el.addEventListener('click', () => act(el, Object.assign({}, spec, { url })))
  return el
}

// ---------- 2. 导航 / 路由 ----------
function currentId () {
  const m = /^#\/?([\w-]+)/.exec(location.hash || '')
  return m ? m[1] : null
}

function currentFeature () {
  return state.features.find((f) => f.id === state.active) || null
}

async function loadFeatures () {
  const d = await api('/api/features')
  state.features = d.features || []
  state.warnings = d.warnings || []
  $id('ver').textContent = 'v' + (d.version || '')
  document.title = 'AI-World 控制面板 v' + (d.version || '')
  paintWarnings()
  renderNav()
}

function paintWarnings () {
  const bar = $id('warnbar')
  bar.innerHTML = ''
  for (const w of state.warnings || []) bar.appendChild(h('div', { class: 'warnbar' }, w))
}

function renderNav () {
  const nav = $id('nav')
  nav.innerHTML = ''
  for (const f of state.features) {
    const b = h('button', { class: f.id === state.active ? 'on' : '', title: f.summary || '' }, f.title)
    if (f.status === 'todo') b.appendChild(h('span', { class: 'badge b-warn' }, '规划中'))
    b.addEventListener('click', () => { if (currentId() === f.id) route(); else location.hash = '#/' + f.id })
    nav.appendChild(b)
  }
}

function stopTimer () {
  if (state.timer) {
    clearInterval(state.timer)
    state.timer = null
  }
}

async function refresh () {
  const f = currentFeature()
  if (!f) return
  stopTimer() // 重画前先停掉上一轮的轮询，否则点几次按钮就攒下好几个定时器
  await render(f)
}

async function route () {
  stopTimer()
  const id = currentId()
  const f = id ? state.features.find((x) => x.id === id) : state.features[0]
  if (!f) {
    $id('title').textContent = '没有这个功能'
    $id('sub').textContent = ''
    view.textContent = '地址栏里的功能不存在，点左边选一个。'
    return
  }
  if (id !== f.id) { // 首次进入 / 写错名字 → 跳回第一个功能
    location.replace('#/' + f.id)
    return
  }
  state.active = f.id
  renderNav()
  $id('title').textContent = f.title
  $id('sub').textContent = f.summary || ''
  await render(f)
}

// 按 ui.type 选渲染器。加新界面类型 = 在这里加一行 + 写一个 viewXxx
async function render (f) {
  const type = (f.ui && f.ui.type) || 'cards'
  try {
    if (type === 'cards') return await viewCards(f)
    if (type === 'form') return await viewForm(f)
    if (type === 'list') return await viewList(f)
    if (type === 'logs') return await viewLogs(f)
    if (type === 'custom') return await viewCustom(f)
    view.textContent = '不认识的界面类型：' + type + '（检查 loader.js 的 UI_TYPES）'
  } catch (e) {
    if (state.active !== f.id) return
    view.innerHTML = ''
    view.appendChild(h('div', { class: 'warnbar' }, '加载失败：' + e.message))
  }
}

// ---------- 3. cards 渲染器（概览 / 启动停止 用它）----------
// 后端给 { cards: [{ title, subtitle, status, rows:[[k,v]], buttons, input, log, note }], note }
const STATUS_TEXT = { ok: '正常', warn: '注意', err: '异常', busy: '进行中', idle: '空闲' }

async function viewCards (f) {
  const d = await api('/api/' + f.id)
  if (state.active !== f.id) return
  paintCards(f, d)
  if (!f.ui.refresh) return
  state.timer = setInterval(async () => {
    if (document.hidden || state.active !== f.id || state.busy) return
    try {
      const nd = await api('/api/' + f.id)
      if (state.active !== f.id) return
      // **只在内容真的变了才重绘**：否则每 2 秒整块重建，
      // 输入框焦点 / 滚动位置 / 正在输入的内容全被冲掉（这就是"刷新影响使用感受"的根因）。
      // 运行时长这类每 2 秒都在跳的数字由 stable() 剔掉，不算"变化"——
      // 为了别让"已运行 3 分"永远停在那，每 15 秒补一次慢刷新（正在输入时不补）。
      const el = document.activeElement
      const typing = el && /INPUT|TEXTAREA|SELECT/.test(el.tagName)
      const stale = Date.now() - (state.paintAt || 0) > 15000
      if (stable(nd) !== state.sig || (stale && !typing)) paintCards(f, nd)
    } catch (e) { /* 轮询失败不弹提示，避免刷屏 */ }
  }, Math.max(800, f.ui.refresh))
}

// 比较用的"稳定化"：递归剔掉那些每轮都在变、但变了也不必重画的字段
// （运行时长 / 延迟 / 输出行号…）。顺序统一排序，避免键序不同被当成变化。
const VOLATILE = new Set([
  'uptimeMs', 'latencyMs', 'panelUptimeMs', 'rss', 'at', 'since', 'from', 'total', 'next', 'updatedAt'
])
function stable (v) {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      if (VOLATILE.has(k)) continue
      out[k] = stable(v[k])
    }
    return out
  }
  return v
}

function paintCards (f, d) {
  state.sig = stable(d) // 记住上一次画出来的样子，轮询拿它比
  state.paintAt = Date.now()
  view.innerHTML = ''
  const wrap = h('div', { class: 'cards' })
  for (const c of d.cards || []) wrap.appendChild(cardEl(f, c))
  view.appendChild(wrap)
  if (d.note) view.appendChild(h('p', { class: 'note preline' }, d.note))
}

function cardEl (f, card) {
  const el = h('div', { class: 'card st-' + (card.status || 'idle') + (card.fixed ? ' fixed' : '') })
  const head = h('div', { class: 'card-head' }, h('h2', {}, card.title))
  if (card.status) head.appendChild(h('span', { class: 'badge b-' + card.status }, STATUS_TEXT[card.status] || card.status))
  el.appendChild(head)
  if (card.subtitle) el.appendChild(h('div', { class: 'muted small' }, card.subtitle))
  if (card.rows && card.rows.length) {
    const t = h('table', { class: 'kv' })
    for (const row of card.rows) {
      t.appendChild(h('tr', {}, h('th', {}, row[0]), h('td', {}, row[1] == null ? '—' : String(row[1]))))
    }
    el.appendChild(t)
  }
  // 可选的小表格（启动/停止 用它列"所有 ai"）：{ head: ['列名'], rows: [['a','b']] }
  if (card.table && card.table.rows && card.table.rows.length) {
    const t = h('table', { class: 'mini' })
    const tr = h('tr')
    for (const c of card.table.head || []) tr.appendChild(h('th', {}, c))
    t.appendChild(h('thead', {}, tr))
    const tb = h('tbody')
    for (const row of card.table.rows) {
      const r = h('tr')
      for (const cell of row) r.appendChild(h('td', {}, cell == null ? '—' : String(cell)))
      tb.appendChild(r)
    }
    t.appendChild(tb)
    el.appendChild(t)
  }
  if (card.note) el.appendChild(h('p', { class: 'note preline' }, card.note))
  const bar = h('div', { class: 'btnbar' })
  for (const b of card.buttons || []) bar.appendChild(button(b))
  if (card.input) bar.appendChild(inputEl(f, card.input))
  if (bar.childNodes.length) el.appendChild(bar)
  if (card.log) el.appendChild(logEl(f, card.log))
  return el
}

// 卡片里的一行输入 + 发送按钮（服务器控制台命令用）
function inputEl (f, inp) {
  const text = h('input', { type: 'text', placeholder: inp.placeholder || '' })
  const btn = h('button', { class: 'primary' }, inp.submit || '发送')
  const send = async () => {
    if (!text.value.trim()) return
    const body = {}
    body[inp.key] = text.value
    btn.disabled = true
    state.busy = true
    try {
      const r = await api('/api/' + f.id + inp.path, { method: 'POST', body })
      toast((r && (r.output || r.note)) || '已发送', 'ok')
      text.value = ''
      await refresh()
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      btn.disabled = false
      state.busy = false
    }
  }
  btn.addEventListener('click', send)
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter') send() })
  return h('div', { style: { display: 'flex', gap: '8px', flex: '1', minWidth: '240px' } }, text, btn)
}

// 卡片下方的小日志窗（只拉尾部，自动滚到底）
// log.height = 固定高度(px)：两张卡用同一个值 → 按钮行 + 输出框自然对齐
function logEl (f, log) {
  const height = Math.max(120, Math.min(Number(log.height) || 240, 900))
  const pre = h('pre', { class: 'logbox fixed', style: { marginTop: '10px', height: height + 'px' } }, '加载中…')
  const paint = async () => {
    try {
      const d = await api('/api/' + f.id + log.path)
      const lines = d.lines || []
      const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40
      pre.textContent = lines.length ? lines.join('\n') : '（还没有输出）'
      if (atBottom) pre.scrollTop = pre.scrollHeight
    } catch (e) {
      pre.textContent = '（读取输出失败：' + e.message + '）'
    }
  }
  paint()
  const t = setInterval(() => {
    if (!pre.isConnected) { clearInterval(t); return }
    if (!document.hidden) paint()
  }, 2000)
  return pre
}

// ---------- 4. form 渲染器（连接与权限 用它）----------
// 后端给 { values: { 'server.host': … }, effective, warnings, file }；字段定义在 ui.fields
async function viewForm (f) {
  const d = await api('/api/' + f.id)
  if (state.active !== f.id) return
  const ui = f.ui || {}
  const fields = ui.fields || []
  view.innerHTML = ''

  // 按 group 分组显示（group 只是个字符串，不写就都归到"其它"）
  const groups = []
  const byGroup = new Map()
  for (const field of fields) {
    const g = field.group || '其它'
    if (!byGroup.has(g)) { byGroup.set(g, []); groups.push(g) }
    byGroup.get(g).push(field)
  }

  const inputs = new Map()
  for (const gname of groups) {
    view.appendChild(h('div', { class: 'group-title' }, gname))
    const grid = h('div', { class: 'cards', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' } })
    for (const field of byGroup.get(gname)) {
      const made = fieldEl(field, d.values ? d.values[field.key] : undefined)
      inputs.set(field.key, made.input)
      grid.appendChild(made.wrap)
    }
    view.appendChild(grid)
  }

  // 脚注：保存 / 探测 / 当前生效的配置
  const foot = h('div', { class: 'formfoot' })
  const saveBtn = h('button', { class: 'primary' }, ui.saveLabel || '保存')
  saveBtn.addEventListener('click', async () => {
    const values = {}
    for (const field of fields) {
      const input = inputs.get(field.key)
      if (!input) continue
      values[field.key] = field.type === 'switch' ? !!input.checked : input.value
    }
    saveBtn.disabled = true
    saveBtn.textContent = '保存中…'
    try {
      const r = await api('/api/' + f.id, { method: 'POST', body: { values } })
      const warn = (r.warnings || []).length
      toast('已保存 ' + r.saved + ' 项' + (warn ? '（有 ' + warn + ' 条提示，见下方黄色文字）' : ''), 'ok')
      await render(f)
    } catch (e) {
      toast(e.message, 'err')
      saveBtn.disabled = false
      saveBtn.textContent = ui.saveLabel || '保存'
    }
  })
  foot.appendChild(saveBtn)
  if (ui.probePath) foot.appendChild(probeEl(f, inputs))
  foot.appendChild(h('span', { class: 'muted small' }, ui.note || ''))
  view.appendChild(foot)

  if (d.effective) view.appendChild(h('p', { class: 'note' }, '当前生效：' + d.effective))
  if (d.file) view.appendChild(h('p', { class: 'note' }, '文件：' + d.file))
  if (d.warnings && d.warnings.length) {
    const ul = h('ul', { class: 'warns' })
    for (const w of d.warnings) ul.appendChild(h('li', {}, w))
    view.appendChild(ul)
  }
}

// 一个输入框（按 field.type 生成）。返回 { wrap, input }，input 统一用 .value / .checked 取值
function fieldEl (field, value) {
  const id = 'f-' + String(field.key).replace(/[^\w-]/g, '-')
  let input
  if (field.type === 'select') {
    input = h('select', { id })
    for (const o of field.options || []) {
      const opt = h('option', { value: o.value }, o.label || o.value)
      if (String(value) === String(o.value)) opt.selected = true
      input.appendChild(opt)
    }
  } else if (field.type === 'switch') {
    input = h('input', { id, type: 'checkbox', checked: !(value === false || value === 'false' || value == null) })
    const wrap = h('div', { class: 'field' }, h('label', { class: 'switch' }, input, h('span', {}, field.label)))
    if (field.hint) wrap.appendChild(h('span', { class: 'hint' }, field.hint))
    return { wrap, input }
  } else if (field.type === 'textarea') {
    input = h('textarea', { id, rows: 4 })
    input.value = value == null ? '' : String(value)
  } else {
    input = h('input', {
      id,
      type: field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text',
      placeholder: field.placeholder || '',
      value: value == null ? '' : String(value)
    })
    if (field.min != null) input.min = field.min
    if (field.max != null) input.max = field.max
  }
  const wrap = h('div', { class: 'field' }, h('label', { for: id }, field.label), input)
  if (field.hint) wrap.appendChild(h('span', { class: 'hint' }, field.hint))
  return { wrap, input }
}

// "探测端口"按钮：把表单里 *.host / *.port 的值发过去，看看通不通
function probeEl (f, inputs) {
  const keys = [...inputs.keys()]
  const hostKey = keys.find((k) => /\.host$/.test(k))
  const portKey = keys.find((k) => /\.port$/.test(k))
  const btn = h('button', {}, '探测端口')
  const out = h('span', { class: 'small' })
  btn.addEventListener('click', async () => {
    btn.disabled = true
    out.textContent = '探测中…'
    out.style.color = ''
    try {
      const r = await api('/api/' + f.id + f.ui.probePath, {
        method: 'POST',
        body: {
          host: hostKey ? inputs.get(hostKey).value : undefined,
          port: portKey ? inputs.get(portKey).value : undefined
        }
      })
      out.textContent = (r.ok ? '✔ ' : '✘ ') + r.note
      out.style.color = r.ok ? 'var(--ok)' : 'var(--err)'
    } catch (e) {
      out.textContent = '✘ ' + e.message
      out.style.color = 'var(--err)'
    } finally {
      btn.disabled = false
    }
  })
  return h('span', { style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } }, btn, out)
}

// ---------- 5. list 渲染器（蓝图与教学 用它）----------
// 后端给 { columns:[{key,label,width}], rows:[{...,actions:[按钮]}], toolbar:[按钮], note }
async function viewList (f) {
  const d = await api('/api/' + f.id)
  if (state.active !== f.id) return
  view.innerHTML = ''

  if (d.toolbar && d.toolbar.length) {
    const bar = h('div', { class: 'btnbar', style: { margin: '0 0 12px' } })
    for (const b of d.toolbar) bar.appendChild(button(b))
    view.appendChild(bar)
  }
  if (d.note) view.appendChild(h('p', { class: 'note preline' }, d.note))

  const cols = d.columns || []
  const rows = d.rows || []
  if (!rows.length) {
    view.appendChild(h('p', { class: 'note' }, '这里还是空的。'))
    return
  }
  const table = h('table', { class: 'list' })
  const tr = h('tr')
  for (const c of cols) tr.appendChild(h('th', { style: c.width ? { width: c.width } : null }, c.label))
  tr.appendChild(h('th', { style: { width: '90px' } }, '操作'))
  table.appendChild(h('thead', {}, tr))

  const tbody = h('tbody')
  for (const row of rows) {
    const r = h('tr')
    for (const c of cols) r.appendChild(h('td', {}, row[c.key] == null ? '—' : String(row[c.key])))
    const td = h('td')
    const bar = h('div', { class: 'btnbar', style: { margin: '0', gap: '6px' } })
    for (const a of row.actions || []) bar.appendChild(button(a))
    td.appendChild(bar)
    r.appendChild(td)
    tbody.appendChild(r)
  }
  table.appendChild(tbody)
  view.appendChild(table)
}

// ---------- 6. logs 渲染器（日志 用它）----------
// 后端给 { groups:[{ id, label, dir, files:[{name,size,mtime}] }] }；tail 走 ui.tailPath
async function viewLogs (f) {
  const d = await api('/api/' + f.id)
  if (state.active !== f.id) return
  view.innerHTML = ''
  const ui = f.ui || {}
  const sel = { group: null, name: null }

  const pre = h('pre', { class: 'logbox tall' }, '点左边一个文件看内容')
  const head = h('div', { class: 'muted small', style: { margin: '0 0 8px' } }, '')
  const list = h('div', { class: 'filelist' })

  const loadTail = async () => {
    if (!sel.group || !sel.name) return
    try {
      const q = (ui.tailPath || '/tail') + '?group=' + encodeURIComponent(sel.group) +
        '&name=' + encodeURIComponent(sel.name) + '&lines=' + (ui.lines || 200)
      const r = await api('/api/' + f.id + q)
      const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40
      const lines = r.lines || []
      pre.textContent = lines.length ? lines.join('\n') : '（空文件）'
      head.textContent = sel.name + '  ·  最后 ' + (r.shown || 0) + ' 行'
      if (atBottom) pre.scrollTop = pre.scrollHeight
    } catch (e) {
      pre.textContent = '读不到：' + e.message
    }
  }

  for (const g of d.groups || []) {
    list.appendChild(h('h3', {}, g.label))
    if (!g.files || !g.files.length) {
      list.appendChild(h('div', { class: 'muted small', style: { padding: '4px 8px' } }, '（空）'))
      continue
    }
    for (const file of g.files) {
      const b = h('button', {}, h('span', {}, file.name), h('span', { class: 'sz' }, file.size))
      b.title = file.mtime || ''
      b.addEventListener('click', () => {
        for (const x of list.querySelectorAll('button.on')) x.classList.remove('on')
        b.classList.add('on')
        sel.group = g.id
        sel.name = file.name
        pre.textContent = '加载中…'
        loadTail()
      })
      list.appendChild(b)
    }
  }

  view.appendChild(h('div', { class: 'logs-layout' }, list, h('div', {}, head, pre)))
  if (ui.refresh) {
    state.timer = setInterval(() => {
      if (!document.hidden && sel.name) loadTail()
    }, Math.max(1000, ui.refresh))
  }
}

// ---------- 7. custom 渲染器（逃生口）----------
// 99% 的功能用上面五种就够了。真需要特殊界面时，在 web/views/<名字>.js 里
//   export function render (root, feature) { … }
// 功能模块里写 ui: { type: 'custom', view: '<名字>' }（不写 view 就用 id 当文件名）
async function viewCustom (f) {
  const name = (f.ui && f.ui.view) || f.id
  const mod = await import('/views/' + name + '.js')
  view.innerHTML = ''
  if (typeof mod.render !== 'function') {
    throw new Error('web/views/' + name + '.js 需要导出 render(root, feature)')
  }
  await mod.render(view, f)
  stopTimer() // custom 视图自己管刷新
}

// ---------- 8. 底部状态 / 热重载 / 启动 ----------
function startHealth () {
  const el = $id('health')
  const tick = async () => {
    try {
      const d = await api('/api/health')
      el.textContent = 'v' + d.version + ' · 已运行 ' + fmtDur(d.uptimeMs) + ' · ' + d.node
      el.style.color = ''
    } catch (e) {
      el.textContent = '面板已断开（窗口被关了？）'
      el.style.color = 'var(--err)'
    }
  }
  tick()
  setInterval(tick, 5000)
}

$id('btn-reload').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget
  btn.disabled = true
  try {
    const r = await api('/api/_panel/reload', { method: 'POST' })
    await loadFeatures()
    await route()
    toast('已重载 ' + r.features + ' 个功能 / ' + r.routes + ' 条接口', 'ok')
  } catch (e) {
    toast(e.message, 'err')
  } finally {
    btn.disabled = false
  }
})

window.addEventListener('hashchange', () => { route() })

;(async function boot () {
  try {
    await loadFeatures()
    await route()
    startHealth()
  } catch (e) {
    $id('title').textContent = '面板启动失败'
    view.innerHTML = ''
    view.appendChild(h('div', { class: 'warnbar preline' },
      '连不上面板：' + e.message + '\n（确认启动面板的命令行窗口还开着，或者刷新页面试试）'))
  }
})()

// 给 web/views/*.js（custom 界面）用的公共工具。
// 那些文件是 ES module，拿不到这个文件里的局部函数，所以只暴露必要几个。
window.panelUI = { h, api, toast, fmtDur }




