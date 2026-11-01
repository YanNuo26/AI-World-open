const { HOST, PORT, VERSION } = require('./_common')
// 验证：玩家跑到 AI 看不见的远处后，world tpto 不再只会说"找不到你的位置"，
// 而是改用服务器 /tp 过去，并真的到达玩家身边。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const M = require('../源码/movement')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'world'
const PLAYER = 'FarPlayer'

let aiProc
const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}
const aiDist = (player) => {
  const p = player.players[AI_NAME]
  return (p && p.entity) ? p.entity.position.distanceTo(player.entity.position) : Infinity
}

;(async () => {
  const log = fs.createWriteStream(path.join(ROOT, '日志', 'ai_tptofar.log'))
  const env = { ...process.env }
  delete env.MC_USER
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
  await sleep(6000)

  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })
  const heard = []
  player.on('messagestr', (m) => heard.push(String(m)))

  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(2500)
    for (let i = 0; i < 40; i++) {
      if (player.players[AI_NAME] && player.players[AI_NAME].entity) break
      await sleep(500)
    }

    // 玩家跑到 250 格外（远超可见/模拟距离），AI 应该"看不见"他了
    M.ensureFlying(player)
    const p0 = player.entity.position.floored()
    await M.moveTo(player, p0.x + 250 + 0.5, p0.y + 5, p0.z + 0.5)
    await player.waitForTicks(20)
    const p1 = player.entity.position.floored()
    console.log('[T] 玩家已跑到 ' + JSON.stringify(p1))

    // AI 那边应该已经看不到玩家实体了（这正是原来报错的原因）
    await sleep(4000)
    console.log('[T] 此时 AI 可见距离 = ' + aiDist(player).toFixed(1))

    heard.length = 0
    player.chat(AI_NAME + ' tpto')
    for (let i = 0; i < 40; i++) {
      if (heard.some((m) => m.includes('tpto') === false && (m.includes('/tp') || m.includes('已传送到你身边')))) break
      await sleep(1500)
    }
    await sleep(5000)
    console.log('[T] AI 回复: ' + JSON.stringify(heard.slice(-3)))
    check('AI 有回应（不再是找不到位置）',
      heard.some((m) => m.includes('/tp') || m.includes('已传送到你身边')),
      'replied=' + heard.some((m) => m.includes('/tp') || m.includes('已传送到你身边')))
    check('走了服务器 /tp 这条兜底', heard.some((m) => m.includes('/tp')),
      'usedTp=' + heard.some((m) => m.includes('/tp')))

    const d = aiDist(player)
    console.log('[T] 传送后 AI 与玩家距离 = ' + d.toFixed(1))
    check('AI 真的到了玩家身边(15格内)', d < 15, 'dist=' + d.toFixed(1))

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('TPTO FAR TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
