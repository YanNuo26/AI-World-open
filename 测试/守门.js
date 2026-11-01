// ===== 静态守门（测试/守门.js）=====
// 为什么要有它：2026-10-31 那次夜间回归只有 15/28 通过，但其中 17 个失败**和功能无关**：
//   · 7 个测试文件漏了 `const path = require('path')` → 启动即崩（0 秒失败）；
//   · 10 个测试还在用 chat('build x') 这种**裸指令** → bot 一律要求名字前缀，
//     直接被当成普通聊天忽略（看起来像"功能坏了"，其实是测试没跟着规则改）。
// 这些毛病不用起服务器、几秒就能查出来，却因为要跑十几分钟的行为测试而被埋了一夜。
// 所以：每晚**先**跑本文件，把"测试自己写坏了"和"功能真的坏了"分开。
//
//   node 测试/守门.js             跑一遍（离线，几秒），报告写 日志/夜间回归/守门_<时间>.md
//   node 测试/守门.js --verbose   每条都打出来（默认只打有问题的）
//
// 查四件事：
//   1. 语法：源码/ + 测试/ + 面板 web（ESM 文件复制成 .mjs 再 node --check）
//   2. 指令前缀：测试里 player.chat(...) 必须带 ai 名字（白名单见 ALLOW_CHAT）
//   3. 变量有没有来源：用了 path./fs./spawn( 却没 require（今晚 7 个测试的死因）
//   4. require 的相对路径是否存在（改目录/改名后最容易漏的地方）
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const SRC_DIR = path.join(ROOT, '源码')
const TEST_DIR = path.join(ROOT, '测试')
const OUT_DIR = path.join(ROOT, '日志', '夜间回归')
const VERBOSE = process.argv.includes('--verbose')

const problems = [] // { where, msg }
const lines = [] // 报告正文
function bad (where, msg) {
  problems.push({ where, msg })
  if (VERBOSE) console.log('[X] ' + where + ' — ' + msg)
}
function ok (msg) {
  if (VERBOSE) console.log('[√] ' + msg)
}
const pad2 = (n) => String(n).padStart(2, '0')
function stamp () {
  const d = new Date()
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
}

function walk (dir, out) {
  out = out || []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}

// 有意"裸聊"的行：它们是**故意**不带前缀的（验证"不响应"），不是漏改
const ALLOW_CHAT = {
  'test_prefix.js': ["'大家好啊，今天天气不错'", "'help'", '"help"'], // 验证：无前缀不响应
  'test_teach4.js': ["'hello'"], // 故意发一条普通聊天：用来"打开聊天框"测忽略窗口
  'test_multi.js': ['`summon ${BOB} add Steve2`', "'tpto'"] // 验证：不带前缀 / 管理指令都不生效
}


// ---------- 1. 语法 ----------
function checkSyntax () {
  const files = walk(SRC_DIR).concat(walk(TEST_DIR))
  let n = 0
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8')
    // 面板前端是 ES module（有 import/export）—— .js 交给 node --check 会报错，复制成 .mjs
    const isEsm = /^\s*(import|export)\s/m.test(code)
    let target = f
    let tmp = null
    if (isEsm) {
      tmp = path.join(os.tmpdir(), 'guard_' + process.pid + '_' + (n++) + '.mjs')
      fs.writeFileSync(tmp, code, 'utf8')
      target = tmp
    }
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'ignore' })
    } catch (e) {
      bad(path.relative(ROOT, f), '语法错误（node --check 失败）')
    }
    if (tmp) { try { fs.unlinkSync(tmp) } catch (e) { /* ignore */ } }
  }
  ok('语法：' + files.length + ' 个文件都过了')
}

// ---------- 2. 指令前缀 ----------
function checkChatPrefix () {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.js'))
  for (const name of files) {
    // 守门.js 自己就写着 "player.chat(" 这些字样，跳过它，免得自己告自己
    if (name === '守门.js') continue
    const allow = ALLOW_CHAT[name] || []
    const text = fs.readFileSync(path.join(TEST_DIR, name), 'utf8')
    text.split(/\r?\n/).forEach((line, i) => {
      const at = line.indexOf('player.chat(')
      if (at < 0) return
      if (/^\s*(\/\/|\*)/.test(line)) return // 注释里提到的不算
      const arg = line.slice(at + 'player.chat('.length)
      const good =
        /^cmd\s*\(/.test(arg) || // 标准写法：cmd(AI_NAME, 'build ...')
        /\bAI_NAME\b/.test(arg) || // 老写法：AI_NAME + ' tpto'
        /^[A-Z][A-Z0-9_]*\s*\+/.test(arg) || // 指挥别的 ai：BOB + ' tpto'
        /^[`'"]\//.test(arg) || // 原版指令：chat('/tp ...')
        allow.some((a) => arg.includes(a)) // 白名单：故意裸聊
      if (!good) {
        bad(name + ':' + (i + 1), '指令没带 ai 名字前缀（用 cmd(AI_NAME, ...)）：' + line.trim())
      }
    })
  }
  ok('指令前缀：' + files.length + ' 个测试文件都合规')
}

// ---------- 3. 变量/模块有没有来源 ----------
const NEED = [
  { use: /\bpath\./, req: /require\(['"]path['"]\)/, name: 'path' },
  { use: /\bfs\./, req: /require\(['"]fs['"]\)/, name: 'fs' },
  { use: /\bos\./, req: /require\(['"]os['"]\)/, name: 'os' },
  { use: /\bnet\./, req: /require\(['"]net['"]\)/, name: 'net' },
  { use: /\bhttp\./, req: /require\(['"]http['"]\)/, name: 'http' },
  { use: /\bspawn\s*\(/, req: /require\(['"]child_process['"]\)/, name: 'spawn (child_process)' },
  { use: /\bexecFileSync\s*\(/, req: /require\(['"]child_process['"]\)/, name: 'execFileSync (child_process)' },
  { use: /\bmineflayer\./, req: /require\(['"]mineflayer['"]\)/, name: 'mineflayer' },
  { use: /\bVec3\b/, req: /require\(['"]vec3['"]\)/, name: 'Vec3 (vec3)' }
]
function checkRequires () {
  const files = walk(SRC_DIR).concat(walk(TEST_DIR))
  for (const f of files) {
    if (path.basename(f) === '守门.js') continue // 检查器自己的源码里有 "path." 等字样（正则），跳过
    const code = fs.readFileSync(f, 'utf8')
    for (const rule of NEED) {
      if (rule.use.test(code) && !rule.req.test(code)) {
        bad(path.relative(ROOT, f), '用了 ' + rule.name + ' 却没有 require 它（一启动就 ReferenceError）')
      }
    }
  }
  ok('模块来源：' + files.length + ' 个文件都查过')
}

// ---------- 4. require 的相对路径是否存在 ----------
function checkRelRequires () {
  const files = walk(SRC_DIR).concat(walk(TEST_DIR))
  for (const f of files) {
    const code = fs.readFileSync(f, 'utf8')
    const re = /require\((['"])(\.[^'"]+)\1\)/g
    let m
    while ((m = re.exec(code))) {
      const target = path.resolve(path.dirname(f), m[2])
      const cands = [target, target + '.js', target + '.json', path.join(target, 'index.js')]
      if (!cands.some((c) => fs.existsSync(c))) {
        bad(path.relative(ROOT, f), 'require 的相对路径不存在：' + m[2])
      }
    }
  }
  ok('相对 require：路径都存在')
}

// ---------- 5. 作用域里有没有 `bot` ----------
// 测试里玩家机器人叫 player，`bot` 只出现在 `function giveItem (bot, ...)` 这种工具函数里。
// 2026-11-01 test_teach.js 在主流程里写了 `bot.version`（应该是 player.version）→
// teach 跑到一半 ReferenceError，看起来像"教学功能坏了"。
// 做法：按行跟踪"当前在哪几个函数体里"，取最内层的参数表，里面没有 bot 就算错。
function checkBotScope () {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.js') && f !== '守门.js')
  for (const name of files) {
    const code = fs.readFileSync(path.join(TEST_DIR, name), 'utf8')
    // 文件自己声明了 bot（如 const bot = mineflayer.createBot(...)）就不归这条规则管
    if (/\b(const|let|var)\s+bot\b/.test(code)) continue
    const L = code.split(/\r?\n/)
    let depth = 0
    const stack = [] // { params, at }
    for (let i = 0; i < L.length; i++) {
      const line = L[i]
      const m = /function\s*\w*\s*\(([^)]*)\)\s*\{/.exec(line) ||
        /(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/.exec(line)
      if (m) stack.push({ params: m[1], at: depth + 1 })
      // 先把字符串字面量挖掉：'源码/bot.js' 里的 bot. 不是变量
      const code = line.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""')
      if (/\bbot\./.test(code) && !/^\s*(\/\/|\*)/.test(line)) {
        const inner = stack[stack.length - 1]
        const hasBot = !!(inner && /\bbot\b/.test(inner.params))
        if (!hasBot) {
          bad(name + ':' + (i + 1), '用了 bot. 但当前作用域没有 bot（测试里应该写 player.）')
        }
      }
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
      while (stack.length && depth < stack[stack.length - 1].at) stack.pop()
    }
  }
  ok('作用域：' + files.length + ' 个测试文件里的 bot 引用都合理')
}

// ---------- 主流程 ----------
function main () {
  const t0 = Date.now()
  console.log('守门开始（离线，不需要服务器）…')
  checkSyntax()
  checkChatPrefix()
  checkRequires()
  checkRelRequires()
  checkBotScope()
  const ms = Date.now() - t0

  lines.push('# 静态守门 ' + stamp())
  lines.push('')
  lines.push('- 用时：' + ms + 'ms（不需要服务器）')
  lines.push('- 检查项：语法 / 指令前缀 / 模块来源 / require 相对路径 / bot 作用域')
  lines.push('- 结果：' + (problems.length ? '**' + problems.length + ' 个问题**' : '**全部通过**'))
  lines.push('')
  if (problems.length) {
    lines.push('| 位置 | 问题 |')
    lines.push('|------|------|')
    for (const p of problems) lines.push('| `' + p.where + '` | ' + p.msg + ' |')
    lines.push('')
    lines.push('> 说明：这些是**测试/代码自己写坏了**，不是游戏功能坏了。先修它们，再看行为测试的结果。')
  } else {
    lines.push('没有发现问题，可以放心跑行为测试。')
  }
  const text = lines.join('\n')
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, '守门_' + stamp() + '.md'), text, 'utf8')
    fs.writeFileSync(path.join(OUT_DIR, '最新守门.md'), text, 'utf8')
  } catch (e) { /* 写不出来也不影响退出码 */ }

  console.log('=== 守门：' + problems.length + ' 个问题，' + ms + 'ms ===')
  if (problems.length) {
    for (const p of problems.slice(0, 30)) console.log('  ✘ ' + p.where + ' — ' + p.msg)
    if (problems.length > 30) console.log('  …（还有 ' + (problems.length - 30) + ' 条，见报告）')
  }
  return problems.length ? 1 : 0
}

process.exit(main())
