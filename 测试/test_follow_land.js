const { HOST, PORT, VERSION } = require('./_common')
// 验证：world tpto me 跟随靠近后，AI 会**落到地上**（不再一直悬空飞行）
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'world'
const PLAYER = 'FollowLandPlayer'

let aiProc
const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}
const aiEnt = (player) => {
  const p = player.players[AI_NAME]
  return (p && p.entity) ? p.entity : null
}
// 脚下是不是实心地面
function onSolidGround (player, ent) {
  const f = ent.position.floored()
  const below = player.blockAt(new Vec3(f.x, f.y - 1, f.z))
  return !!(below && below.name !== 'air')
}

;(async () => {
  const log = fs.createWriteStream(path.join(ROOT, '日志', 'ai_followland.log'))
  const env = { ...process.env }
  delete env.MC_USER
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
  await sleep(6000)

  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })

  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(2500)
    for (let i = 0; i < 40; i++) {
      if (player.players[AI_NAME] && player.players[AI_NAME].entity) break
      await sleep(500)
    }

    // 玩家先走开一点，让 AI 必须飞过来
    const p0 = player.entity.position.clone()
    const dest = new Vec3(p0.x + 30 + 0.5, p0.y, p0.z + 0.5)
    const steps = Math.ceil(p0.distanceTo(dest))
    for (let i = 1; i <= steps; i++) {
      player.entity.position = p0.plus(dest.minus(p0).scaled(i / steps))
      await sleep(60)
    }
    await sleep(1500)

    player.chat(AI_NAME + ' tpto me')
    // 等它飞过来并落地
    let ent = null
    for (let i = 0; i < 40; i++) {
      ent = aiEnt(player)
      if (ent && ent.position.distanceTo(player.entity.position) <= 7) break
      await sleep(1000)
    }
    await sleep(4000) // 给落地动作留时间

    ent = aiEnt(player)
    console.log('[T] players = ' + Object.keys(player.players || {}).join(','))
    const wp = player.players[AI_NAME]
    console.log('[T] world 条目 = ' + (wp ? ('hasEntity=' + !!wp.entity) : 'none'))
    console.log('[T] 玩家自身位置 = ' + JSON.stringify(player.entity.position.floored()))
    // 扫一遍所有实体，找找 AI 到底在哪
    for (const [id, e] of Object.entries(player.entities || {})) {
      if (e && e.type === 'player' && e.username === AI_NAME) {
        console.log('[T] 实体里找到 AI: ' + JSON.stringify(e.position.floored()) +
          ' 距离=' + e.position.distanceTo(player.entity.position).toFixed(1))
      }
    }
    if (!ent) { check('AI 在附近', false, 'no entity'); }
    else {
      const d = ent.position.distanceTo(player.entity.position)
      console.log('[T] AI 距离 = ' + d.toFixed(2) + '  onGround=' + ent.onGround +
        '  y=' + ent.position.y.toFixed(2))
      check('AI 已靠近(7格内)', d <= 7, 'dist=' + d.toFixed(2))
      check('AI 已落地(onGround)', ent.onGround === true, 'onGround=' + ent.onGround)
      check('AI 脚下是实心地面', onSolidGround(player, ent), 'below=' + onSolidGround(player, ent))
    }

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    console.log(failed.length ? 'FOLLOWLAND TEST FAIL' : 'FOLLOWLAND TEST PASS')
    if (failed.length) process.exitCode = 1
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
