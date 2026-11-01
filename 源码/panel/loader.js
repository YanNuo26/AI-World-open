// ===== 面板功能加载器（源码/panel/loader.js）=====
// 这是"可扩展"的核心：**一个功能 = 源码/panel/api/ 下的一个 .js 文件**。
//
// 功能模块必须导出：
//   id       唯一标识，路由前缀就是 /api/<id>
//   title    导航里显示的名字
//   order    排序（小的在前，建议 10/20/30… 留空档方便插队）
//   status   'ready' | 'beta' | 'todo'（todo = 规划中，前端打灰显示但保留入口）
//   summary  一句话说明（导航标题的悬浮提示 + 卡片副标题）
//   ui       前端渲染描述，见下面 UI_TYPES
//   routes   { 'GET /': 处理函数, 'POST /save': 处理函数 }  ← 路径相对 /api/<id>
//
// 处理函数签名：async (ctx) => 任意可 JSON 化的值
//   ctx = { req, res, query, body, feature, panel, fail(code, msg) }
//   想返回非 200：return { status: 400, body: { error: '...' } } 或 ctx.fail(400, '...')
//
// 文件名以 _ 开头的（如 _util.js）是公共工具，**不会**被当成功能加载。
//
// 加新功能的完整步骤（不用动 server.js、不用动前端）：
//   1. 丢一个 源码/panel/api/xxx.js 进去
//   2. 刷新面板（或 POST /api/_panel/reload）
//   3. 想改端口/持久化就调 源码/config.js，别在面板里另搞一套配置
const fs = require('fs')
const path = require('path')

// 前端已有的通用渲染器。新功能挑一个就能直接出界面：
//   cards  = 一组卡片（状态 / 键值行 / 按钮 / 内嵌日志）
//   form   = 表单（字段有 text/number/switch/select/list/password/textarea）
//   list   = 表格（列 + 行 + 行内按钮）
//   logs   = 日志查看器（左侧文件列表 + 右侧 tail + 自动刷新）
//   custom = 特殊界面，模块自带 web/views/<名字>.js（导出 render(root, feature)）
const UI_TYPES = ['cards', 'form', 'list', 'logs', 'custom']

function isFn (v) { return typeof v === 'function' }

// 把 'GET /save' 解析成 { method: 'GET', sub: '/save' }
function parseRouteKey (key) {
  const m = /^\s*(GET|POST|PUT|DELETE|PATCH)\s+(\S*)\s*$/i.exec(String(key || ''))
  if (!m) return null
  return { method: m[1].toUpperCase(), sub: m[2] || '/' }
}

// 统一路径：去掉结尾多余的 '/'（'/' 本身保留成 ''）
function normalizePath (p) {
  let s = String(p || '/')
  if (!s.startsWith('/')) s = '/' + s
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  return s === '/' ? '' : s
}

// 校验一个模块，返回问题列表（为空表示合格）
function validateFeature (f) {
  const errs = []
  if (!f || typeof f !== 'object') return ['模块没有导出对象']
  if (!f.id || typeof f.id !== 'string') errs.push('缺少 id')
  else if (!/^[a-zA-Z][\w-]*$/.test(f.id)) errs.push('id 只能用字母开头 + 字母/数字/下划线/横线')
  if (!f.title || typeof f.title !== 'string') errs.push('缺少 title')
  if (f.status && !['ready', 'beta', 'todo'].includes(f.status)) errs.push('status 只能是 ready / beta / todo')
  if (f.order != null && typeof f.order !== 'number') errs.push('order 必须是数字')
  if (!f.ui || typeof f.ui !== 'object') errs.push('缺少 ui')
  else if (!UI_TYPES.includes(f.ui.type)) errs.push('ui.type 只能是 ' + UI_TYPES.join(' / '))
  else if (f.ui.type === 'custom' && !f.ui.view) errs.push("ui.type='custom' 时必须给 ui.view")
  if (!f.routes || typeof f.routes !== 'object') errs.push('缺少 routes')
  else {
    const keys = Object.keys(f.routes)
    if (!keys.length) errs.push('routes 是空的')
    for (const k of keys) {
      if (!parseRouteKey(k)) errs.push('路由写法不对（应形如 "GET /"）：' + k)
      else if (!isFn(f.routes[k])) errs.push('路由处理函数不是函数：' + k)
    }
  }
  return errs
}

// 加载目录下所有功能模块。
// 返回 { features, warnings }：坏模块**只记警告不崩服务**（面板自己坏了就没法修了）。
function loadFeatures (dir) {
  const warnings = []
  const features = []
  const seenIds = new Set()

  let files = []
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith('.js') && !n.startsWith('_'))
  } catch (e) {
    return { features, warnings: ['功能目录读不到：' + dir + '（' + e.message + '）'] }
  }

  for (const file of files) {
    const full = path.join(dir, file)
    let mod
    try {
      mod = require(full)
    } catch (e) {
      warnings.push('加载失败 ' + file + '：' + (e && e.message))
      continue
    }
    const errs = validateFeature(mod)
    if (errs.length) {
      warnings.push(file + ' 不合格：' + errs.join('；'))
      continue
    }
    if (seenIds.has(mod.id)) {
      warnings.push(file + ' 的 id 与前面重复（' + mod.id + '），已跳过')
      continue
    }
    seenIds.add(mod.id)
    features.push(Object.assign({}, mod, {
      order: mod.order == null ? 100 : mod.order,
      status: mod.status || 'ready',
      summary: mod.summary || '',
      file
    }))
  }

  features.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  return { features, warnings }
}

// 把功能模块的 routes 拼成一张表： '/api/config' -> { feature, handler }
function buildRoutes (features) {
  const table = new Map()
  const warnings = []
  for (const f of features) {
    for (const key of Object.keys(f.routes)) {
      const r = parseRouteKey(key)
      if (!r) continue
      const full = '/api/' + f.id + normalizePath(r.sub)
      const id = r.method + ' ' + full
      if (table.has(id)) {
        warnings.push('路由冲突，已跳过：' + id + '（' + f.id + '）')
        continue
      }
      table.set(id, { feature: f, method: r.method, path: full, handler: f.routes[key] })
    }
  }
  return { table, warnings }
}

module.exports = { loadFeatures, buildRoutes, validateFeature, UI_TYPES, normalizePath }
