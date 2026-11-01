// ===== 面板公共工具（源码/panel/api/_util.js）=====
// 文件名以 _ 开头 → 加载器不会把它当成"功能模块"。
// 这里只放**无副作用**的小工具：HTTP 读写、TCP 探测、文件读写、格式化。
const fs = require('fs')
const net = require('net')
const path = require('path')

// 目录层级：源码/panel/api → 项目根
const ROOT = path.join(__dirname, '..', '..', '..')
const LOG_DIR = path.join(ROOT, '日志')
const SERVER_DIR = path.join(ROOT, '服务器')
const WEB_DIR = path.join(__dirname, '..', 'web')
const CONFIG_FILE = path.join(ROOT, 'config.json')

// 让功能模块只 require 这一个文件就能拿到配置/RCON，避免各写一份路径
const config = require('../../config')
const rcon = require('../../rcon')
const access = require('../../access')

// ---- 错误：带上 HTTP 状态码，server.js 统一转成 JSON ----
class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

function fail (status, message) { throw new HttpError(status, message) }

// ---- 读请求体（JSON，最大 1MB，防止误传大文件把内存吃满）----
function readBody (req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new HttpError(413, '请求体太大（上限 ' + Math.round(limit / 1024) + ' KB）'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try { resolve(JSON.parse(text)) } catch (e) { reject(new HttpError(400, '请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function sendJson (res, status, obj) {
  const text = JSON.stringify(obj == null ? null : obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

function sendText (res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  })
  res.end(text)
}

// ---- 探测端口（判断服务器 / 面板是否已经在监听）----
function probeTcp (host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const started = Date.now()
    const sock = new net.Socket()
    let done = false
    const finish = (ok, error) => {
      if (done) return
      done = true
      try { sock.destroy() } catch (e) { /* ignore */ }
      resolve({ ok, ms: Date.now() - started, error: error || null })
    }
    sock.setTimeout(timeoutMs, () => finish(false, 'ETIMEDOUT'))
    sock.on('error', (e) => finish(false, (e && (e.code || e.message)) || 'ERROR'))
    sock.connect(port, host, () => finish(true))
  })
}

// ---- 文件 ----
function readJsonFile (file, fallback) {
  try {
    // 去 BOM：记事本 / PowerShell 5.1 保存的 UTF-8 带 BOM，JSON.parse 会直接抛
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return fallback
  }
}

// 2 空格缩进 + 结尾换行，跟现有 config.json 风格一致；**不写 BOM**
function writeJsonFile (file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

// 列目录（只要文件），按修改时间倒序
function listDir (dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const full = path.join(dir, d.name)
        const st = fs.statSync(full)
        return { name: d.name, size: st.size, mtime: st.mtimeMs, file: full }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch (e) {
    return []
  }
}

// 目录里最后 N 行（日志 tail 用；文件很大时只读尾部 256KB，避免整份读进内存）
function tailLines (file, lines = 200) {
  let text = ''
  try {
    const st = fs.statSync(file)
    const max = 256 * 1024
    const start = Math.max(0, st.size - max)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(max, st.size))
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1) // 丢掉被截断的半个行
  } catch (e) {
    return { error: e.message, lines: [] }
  }
  const all = text.split(/\r?\n/)
  if (all.length && all[all.length - 1] === '') all.pop()
  return { lines: all.slice(-Math.max(1, lines)) }
}

// 文件名安全化：只允许单纯的文件名，挡住 ../ 之类的路径穿越
function safeFileName (name) {
  const s = String(name == null ? '' : name).trim()
  if (!s || s !== path.basename(s) || /[\\/:*?"<>|]/.test(s)) return null
  return s
}

// ---- 格式化 ----
function fmtBytes (n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB'
  return (v / 1024 / 1024).toFixed(1) + ' MB'
}

function fmtTime (ms) {
  const d = new Date(Number(ms) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

// 毫秒 → "1 小时 03 分" 这种人看的时长
function fmtDuration (ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  if (s < 60) return s + ' 秒'
  const m = Math.floor(s / 60)
  if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒'
  return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分'
}

function toInt (v, def) {
  const n = parseInt(v, 10)
  return isNaN(n) ? def : n
}

module.exports = {
  ROOT, LOG_DIR, SERVER_DIR, WEB_DIR, CONFIG_FILE,
  config, rcon, access,
  HttpError, fail,
  readBody, sendJson, sendText,
  probeTcp,
  readJsonFile, writeJsonFile, listDir, tailLines, safeFileName,
  fmtBytes, fmtTime, fmtDuration, toInt
}
