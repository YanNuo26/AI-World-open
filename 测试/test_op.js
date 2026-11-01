const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证：世界创建后所有玩家都会被授予 op（bot 通过 RCON 让服务器执行 /op）
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'OpTestPlayer'

let aiProc
function startAI () {
  const log = fs.createWriteStream(require('path').join(ROOT, '日志', 'ai_op.log'))
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env: { ...process.env, MC_USER: AI_NAME } })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
}

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

const readOps = () => {
  // 服务器的 ops.json 在 服务器/ 里（java 的 cwd 是那儿）；根目录是老位置，两处都找一遍
  for (const f of [path.join(ROOT, '服务器', 'ops.json'), path.join(ROOT, 'ops.json')]) {
    if (!fs.existsSync(f)) continue
    try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { return [] }
  }
  return []
}

;(async () => {
  startAI()
  await sleep(6000)
  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })

  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(6000) // 等 bot 处理 playerJoined 并调用 RCON

    const ops = readOps()
    const names = ops.map((o) => o && o.name).filter(Boolean)
    console.log('[T] ops.json =', JSON.stringify(names))
    check('bot 自己被 op', names.includes(AI_NAME), names.join(','))
    check('加入的玩家被 op', names.includes(PLAYER), names.join(','))

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('OP TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
