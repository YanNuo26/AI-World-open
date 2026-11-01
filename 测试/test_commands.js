const { HOST, PORT, VERSION } = require('./_common')
// Integration test for the `tpto` and `stop` chat commands.
// Starts the real bot.js (as AIBuilder) plus a "player" bot, then drives the
// player to issue chat commands and verifies the AI's behaviour.
const path = require('path')
const { spawn } = require('child_process')
const fs = require('fs')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'CmdPlayer'

let aiProc
function startAI (extraEnv) {
  const log = fs.createWriteStream(require('path').join(ROOT, '日志', 'ai_child.log'))
  aiProc = spawn(node, ['源码/bot.js'], {
    cwd: ROOT,
    env: { ...process.env, MC_USER: AI_NAME, ...(extraEnv || {}) }
  })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
  aiProc.on('exit', (code) => console.log('[T] AI child exited with', code))
}

// 等 AI 的实体出现在玩家的 players 列表里
async function waitAI (player, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const a = aiPos(player)
    if (a) return a
    if (i % 10 === 0) console.log('[T] players seen:', Object.keys(player.players).join(','))
    await sleep(500)
  }
  throw new Error('AIBuilder never appeared; players=' + Object.keys(player.players).join(','))
}

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond, extra })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

// teleport the player itself by stepping, after enabling creative flight so the
// server doesn't yank it back to the ground.
async function tpPlayer (player, x, y, z) {
  if (player.creative && player.creative.startFlying && !player.creative.flying) player.creative.startFlying()
  const dest = Vec3(x + 0.5, y + 1, z + 0.5)
  const start = player.entity.position.clone()
  const dist = start.distanceTo(dest)
  const steps = Math.max(1, Math.ceil(dist / 1.0))
  for (let i = 1; i <= steps; i++) {
    player.entity.position = start.plus(dest.minus(start).scaled(i / steps))
    await sleep(50)
  }
  player.entity.position = dest
  await sleep(1000)
}

function aiPos (player) {
  const a = player.players[AI_NAME]
  return a && a.entity ? a.entity.position : null
}

;(async () => {
  startAI()
  await sleep(4000)
  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })
  const aiChats = []
  player.on('chat', (u, m) => { if (u === AI_NAME) aiChats.push(m) })

  try {
    await new Promise((res) => player.on('spawn', res))
    if (player.creative && player.creative.startFlying && !player.creative.flying) player.creative.startFlying()
    await sleep(2000)
    await waitAI(player)

    // 1) tpto <x> <y> <z> -> teleport to coordinate (near ground to keep it realistic)
    aiChats.length = 0
    player.chat(AI_NAME + ' tpto 15 -58 15')
    await sleep(10000)
    let p = aiPos(player)
    console.log('[T] AI after tpto 15 -58 15 ->', p)
    check('tpto coords moves AI near (15,-58,15)', p && p.distanceTo(Vec3(15.5, -57, 15.5)) < 5, p ? 'dist=' + p.distanceTo(Vec3(15.5, -57, 15.5)).toFixed(2) : 'no ai pos')

    // 2) tpto (no arg) -> teleport to player
    await tpPlayer(player, 35, -58, 35)
    aiChats.length = 0
    player.chat(AI_NAME + ' tpto')
    await sleep(10000)
    p = aiPos(player)
    const pp = player.entity.position
    console.log('[T] AI after tpto(me-default) ->', p, 'player', pp)
    check('tpto (no arg) teleports AI to player', p && pp && p.distanceTo(pp) < 5, p && pp ? 'dist=' + p.distanceTo(pp).toFixed(2) : 'no pos')

    // 3) tpto me -> follow within 5 blocks: move player away, AI should follow
    player.chat(AI_NAME + ' tpto me')
    await sleep(3000)
    await tpPlayer(player, 55, -58, 55)
    await sleep(10000)
    p = aiPos(player)
    const pp2 = player.entity.position
    console.log('[T] AI while following ->', p, 'player', pp2)
    check('follow keeps AI within 5 blocks', p && pp2 && p.distanceTo(pp2) <= 5.5, p && pp2 ? 'dist=' + p.distanceTo(pp2).toFixed(2) : 'no pos')

    // 4) stop -> cancels follow + resets state (AI should no longer track player)
    aiChats.length = 0
    player.chat(AI_NAME + ' stop')
    await sleep(500)
    await tpPlayer(player, 75, -58, 75)
    await sleep(5000)
    p = aiPos(player)
    const pp3 = player.entity.position
    console.log('[T] AI after stop ->', p, 'player', pp3)
    check('stop cancels follow (AI no longer tracks player)', p && pp3 && p.distanceTo(pp3) > 10, p && pp3 ? 'dist=' + p.distanceTo(pp3).toFixed(2) : 'no pos')
    check('stop replies with reset message', aiChats.some((m) => /重置|停止/.test(m)), aiChats.join('|'))

    // 5) stop aborts an in-progress build
    aiChats.length = 0
    player.chat(AI_NAME + ' build 5 5')
    await sleep(4000)
    player.chat(AI_NAME + ' stop')
    await sleep(2000)
    const aborted = aiChats.some((m) => /停止建造|停止所有/.test(m))
    check('stop during build aborts it (AI reports stop)', aborted, aiChats.filter((m) => /停止|出错/.test(m)).join('|'))

    // 6) 指令白名单（ai.obeyWhitelist）：名单里没有这个玩家 -> 一句都不理
    //    这条是"接别人的服务器"的安全底线：公共服上路人不能指挥 ai
    console.log('[T] --- phase 6: obeyWhitelist ---')
    try { aiProc.kill('SIGKILL') } catch (e) {}
    await sleep(3000) // 等服务器把旧会话清掉，否则同名重登会被踢
    aiChats.length = 0
    startAI({ MC_OBEY: 'SomebodyElse' })
    // 等新进程上线：它 spawn 时会喊一句"我是 <名字>，已就绪"
    for (let i = 0; i < 60 && !aiChats.some((m) => /已就绪/.test(m)); i++) await sleep(500)
    check('新的 ai 进程上线了', aiChats.some((m) => /已就绪/.test(m)), aiChats.join('|'))
    const beforeDeny = aiPos(player)
    if (!beforeDeny) throw new Error('新 ai 没有实体，无法验证白名单')
    const startPos = beforeDeny.clone()
    aiChats.length = 0
    player.chat(AI_NAME + ' tpto 15 -58 15')
    await sleep(8000)
    const afterDeny = aiPos(player)
    check('白名单外的人下指令：ai 不动',
      afterDeny && startPos.distanceTo(afterDeny) < 2,
      afterDeny ? 'moved=' + startPos.distanceTo(afterDeny).toFixed(2) : 'no ai pos')
    check('白名单外的人下指令：ai 不回话',
      !aiChats.some((m) => /已传送|传送|用法/.test(m)), aiChats.join('|'))

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('ALL COMMANDS OK')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
