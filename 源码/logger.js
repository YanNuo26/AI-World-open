// ===== 日志（源码/logger.js）=====
// 作用：把控制台输出**同时**写进 日志/ai_<名字>.log，方便事后排查。
// 以前只有 summon 出来的子 ai 有日志文件，主 ai 全靠控制台，出问题没法回看。
//
// 做法：不改业务代码里那几十处 console.log —— 直接在外面包一层，
//      所以只要在启动时调用一次 initLogger(名字) 就行。
const fs = require('fs')
const path = require('path')

const LOG_DIR = path.join(__dirname, '..', '日志')
let logFile = null

const pad = (n) => String(n).padStart(2, '0')
function stamp () {
  const d = new Date()
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

function fmtArg (a) {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.stack || a.message
  if (a && typeof a === 'object') {
    try { return JSON.stringify(a) } catch (e) { return String(a) }
  }
  return String(a)
}

function writeLine (text) {
  if (!logFile) return
  // 用同步追加：量很小，但能保证进程被 Ctrl+C / 异常打断时日志不丢
  try { fs.appendFileSync(logFile, '[' + stamp() + '] ' + text + '\n') } catch (e) { /* 磁盘异常不能影响主流程 */ }
}

// 每个进程调用一次。名字 = ai 名字（主 ai 是 world，子 ai 是自己名字）
function initLogger (name) {
  if (logFile) return logFile
  try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch (e) { /* ignore */ }
  logFile = path.join(LOG_DIR, 'ai_' + (name || 'unknown') + '.log')
  writeLine('===== 启动 ' + new Date().toLocaleString('zh-CN') +
    '  进程 ' + process.pid + '  名字 ' + (name || '?') + ' =====')

  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = typeof console[level] === 'function' ? console[level].bind(console) : console.log.bind(console)
    console[level] = (...args) => {
      orig(...args)
      writeLine((level === 'log' ? '' : '[' + level + '] ') + args.map(fmtArg).join(' '))
    }
  }
  return logFile
}

module.exports = { initLogger, LOG_DIR }
