// ===== AI-World 软件面板（源码/panel/server.js）=====
// 一个**零依赖**的本地 Web 面板：双击 脚本/启动面板.bat 就能用（会自动开浏览器）。
//
// 它只做四件事：
//   1. 加载 源码/panel/api/*.js（每个文件 = 一个功能模块，约定见 loader.js 文件头）
//   2. 把模块的 routes 拼成 /api/<id>... 的路由表
//   3. 发 源码/panel/web/ 下的静态前端
//   4. Ctrl+C / 关窗口时，把面板**自己拉起来**的子进程收干净
//
// 安全：只监听 127.0.0.1，并校验 Host 头（挡 DNS rebinding）。
// 这个面板能改 config.json、能起停进程 —— **绝不能**改成 0.0.0.0 暴露到局域网。
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { loadFeatures, buildRoutes, normalizePath } = require('./loader')
const { fail, readBody, sendJson, sendText } = require('./api/_util')

const WEB_DIR = path.join(__dirname, 'web')
const API_DIR = path.join(__dirname, 'api')
const DEFAULT_PORT = 8787
const BIND_HOST = '127.0.0.1'
const PKG = (() => { try { return require('../../package.json') } catch (e) { return { version: '?' } } })()

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
}

// ===== 功能模块的加载 / 热重载 =====
function createApp (opts = {}) {
  const apiDir = opts.apiDir || API_DIR
  const webDir = opts.webDir || WEB_DIR
  const state = { features: [], routes: new Map(), warnings: [], startedAt: Date.now() }

  // 热重载：只清**功能模块**的缓存。_util.js / _state.js 这类下划线文件保持同一实例，
  // 否则进程句柄、输出缓冲会丢（原因见 _state.js 文件头）
  function reload () {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(apiDir + path.sep) && !path.basename(key).startsWith('_')) {
        delete require.cache[key]
      }
    }
    const loaded = loadFeatures(apiDir)
    const built = buildRoutes(loaded.features)
    state.features = loaded.features
    state.routes = built.table
    state.warnings = loaded.warnings.concat(built.warnings)
    for (const w of state.warnings) console.warn('[面板] ' + w)
    return { features: state.features.length, routes: state.routes.size, warnings: state.warnings }
  }
  reload()

  // ctx.panel：功能模块之间**唯一**允许的互相访问方式（别 require 别的功能模块）
  const panel = {
    version: PKG.version,
    startedAt: state.startedAt,
    features: () => state.features,
    feature: (id) => state.features.find((f) => f.id === id) || null,
    reload
  }

  async function handleApi (req, res, url, pathname) {
    const method = String(req.method || 'GET').toUpperCase()

    // ---- 内置接口（不属于任何功能模块）----
    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        version: PKG.version,
        pid: process.pid,
        uptimeMs: Date.now() - state.startedAt,
        node: process.version
      })
    }
    if (pathname === '/api/features') {
      // 前端导航就靠这个：加一个模块文件 = 导航自动多一项
      return sendJson(res, 200, {
        version: PKG.version,
        warnings: state.warnings,
        features: state.features.map((f) => ({
          id: f.id, title: f.title, order: f.order, status: f.status,
          summary: f.summary, ui: f.ui, file: f.file
        }))
      })
    }
    if (pathname === '/api/_panel/reload') {
      if (method !== 'POST') return sendJson(res, 405, { error: '请用 POST' })
      return sendJson(res, 200, Object.assign({ ok: true }, reload()))
    }

    // ---- 功能模块路由 ----
    const route = state.routes.get(method + ' ' + normalizePath(pathname))
    if (!route) return sendJson(res, 404, { error: '没有这个接口：' + method + ' ' + pathname })

    let body = {}
    if (method !== 'GET' && method !== 'HEAD') body = await readBody(req)
    const ctx = {
      req,
      res,
      query: Object.fromEntries(url.searchParams.entries()),
      body: body || {},
      feature: route.feature,
      panel,
      fail
    }
    const out = await route.handler(ctx)
    // 约定：返回 { status: 4xx, body: {...} } 可自定义状态码；否则 200 + 原值
    if (out && typeof out === 'object' && typeof out.status === 'number' && 'body' in out) {
      return sendJson(res, out.status, out.body)
    }
    return sendJson(res, 200, out === undefined ? { ok: true } : out)
  }


  function serveStatic (req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    let full = path.resolve(webDir, rel)
    // 路径穿越保护：解析后必须还在 web/ 里
    const relCheck = path.relative(webDir, full)
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) return sendText(res, 403, '禁止访问')
    let st = null
    try { st = fs.statSync(full) } catch (e) { st = null }
    if (st && st.isDirectory()) {
      full = path.join(full, 'index.html')
      try { st = fs.statSync(full) } catch (e) { st = null }
    }
    if (!st || !st.isFile()) return sendText(res, 404, '找不到：' + pathname)
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': st.size })
    fs.createReadStream(full).pipe(res)
  }

  async function handler (req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      // 只接受本机访问：挡 DNS rebinding（攻击者把自己的域名解析到 127.0.0.1）
      const hostHeader = String(req.headers.host || '').toLowerCase()
      const hostname = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
      if (hostname && !['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
        return sendText(res, 403, '只允许本机访问（Host: ' + hostname + '）')
      }
      const pathname = decodeURIComponent(url.pathname)
      if (pathname.startsWith('/api/')) return await handleApi(req, res, url, normalizePath(pathname))
      return serveStatic(req, res, pathname)
    } catch (e) {
      const status = e && e.status ? e.status : 500
      if (status >= 500) console.error('[面板] ' + (e && e.stack ? e.stack : e))
      if (!res.headersSent) sendJson(res, status, { error: (e && e.message) || '未知错误' })
      else try { res.end() } catch (err) { /* ignore */ }
    }
  }

  // 关面板时让每个功能模块收尾（进程模块会停掉自己拉起的 java / ai）
  let disposed = false
  async function dispose () {
    if (disposed) return
    disposed = true
    for (const f of state.features) {
      if (typeof f.dispose !== 'function') continue
      try { await f.dispose() } catch (e) { console.error('[面板] dispose(' + f.id + ') 失败：' + e.message) }
    }
  }

  return { handler, reload, dispose, state, panel, webDir }
}


// 启动面板。返回 Promise<{ server, port, url, app, close }>
//   opts.port  端口（0 = 让系统分配，测试用）
//   opts.quiet 不打印启动横幅
function start (opts = {}) {
  const app = createApp(opts)
  const server = http.createServer(app.handler)
  const port = opts.port == null ? DEFAULT_PORT : opts.port

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, BIND_HOST, () => {
      const realPort = server.address().port
      const url = 'http://' + BIND_HOST + ':' + realPort + '/'
      let closed = false
      async function close () {
        if (closed) return
        closed = true
        await app.dispose()
        await new Promise((r) => server.close(() => r()))
      }
      if (!opts.quiet) {
        console.log('')
        console.log('  AI-World 面板已启动  v' + PKG.version)
        console.log('  地址: ' + url)
        console.log('  功能: ' + app.state.features.map((f) => f.title).join(' / '))
        for (const w of app.state.warnings) console.warn('  警告: ' + w)
        console.log('  关闭面板: 在这个窗口按 Ctrl+C（同时停掉面板拉起的服务器/ai）')
        console.log('')
      }
      resolve({ server, app, port: realPort, url, close })
    })
  })
}

// 打开默认浏览器（Windows；其它平台按各自命令兜底）
function openBrowser (url) {
  const win = process.platform === 'win32'
  const cmd = win ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = win ? ['/c', 'start', '', url] : [url]
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    p.unref()
  } catch (e) { /* 打不开浏览器不影响面板本身 */ }
}

function parseCli (argv) {
  const out = { port: DEFAULT_PORT, open: true, help: false, quiet: false }
  const args = Array.isArray(argv) ? argv : []
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i])
    const eq = a.indexOf('=')
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a
    const inline = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : null
    const take = () => {
      if (inline !== null) return inline
      const v = args[i + 1]
      if (v === undefined || String(v).startsWith('--')) return null
      i++
      return v
    }
    if (name === '-h' || name === '--help') out.help = true
    else if (name === '--port') {
      const n = parseInt(take(), 10)
      if (!isNaN(n) && n >= 0) out.port = n
    } else if (name === '--open') out.open = true
    else if (name === '--no-open') out.open = false
    else if (name === '--quiet') out.quiet = true
  }
  return out
}

const USAGE = [
  '用法:',
  '  node 源码/panel/server.js                 启动面板并自动打开浏览器（默认 8787）',
  '  node 源码/panel/server.js --port 9000     换端口',
  '  node 源码/panel/server.js --no-open       只启动，不开浏览器',
  '',
  '加新功能: 往 源码/panel/api/ 丢一个 .js（约定见 源码/panel/loader.js 文件头），',
  '          然后重启面板，或在浏览器里 POST /api/_panel/reload 热重载。'
].join('\n')

if (require.main === module) {
  const cli = parseCli(process.argv.slice(2))
  if (cli.help) {
    console.log(USAGE)
    process.exit(0)
  }
  start({ port: cli.port, quiet: cli.quiet }).then(async (app) => {
    if (cli.open) openBrowser(app.url)
    let stopping = false
    const stop = async (sig) => {
      if (stopping) return
      stopping = true
      console.log('\n[面板] 收到 ' + sig + '，正在收尾（会停掉面板拉起的服务器/ai）…')
      try { await app.close() } catch (e) { /* ignore */ }
      process.exit(0)
    }
    process.on('SIGINT', () => stop('SIGINT'))
    process.on('SIGTERM', () => stop('SIGTERM'))
  }).catch((e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.error('[面板] 端口 ' + cli.port + ' 已被占用：可能面板已经在运行，或换个端口 --port 8788')
    } else {
      console.error('[面板] 启动失败：' + (e && e.stack ? e.stack : e))
    }
    process.exit(1)
  })
}

module.exports = { start, createApp, parseCli, USAGE, DEFAULT_PORT }
