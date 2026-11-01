const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证：
//   1) 用过 stop 之后，AI 仍能正常响应 tpto 传送 / tpto me 跟随（中止标志必须被清掉）
//   2) del <名字> 能删除已保存的蓝图 / 教学
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'StopDelPlayer'
const TMP = 'deltmp1'

let aiProc
function startAI () {
  const log = fs.createWriteStream(require('path').join(ROOT, '日志', 'ai_stopdel.log'))
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env: { ...process.env, MC_USER: AI_NAME } })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
}

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

async function walkTo (player, x, y, z) {
  const dest = Vec3(x + 0.5, y, z + 0.5)
  const start = player.entity.position.clone()
  const dist = start.distanceTo(dest)
  const steps = Math.max(1, Math.ceil(dist / 1.0))
  for (let i = 1; i <= steps; i++) {
    player.entity.position = start.plus(dest.minus(start).scaled(i / steps))
    await sleep(60)
  }
  await sleep(700)
}

function aiPos (player) {
  const a = player.players[AI_NAME]
  return a && a.entity ? a.entity.position : null
}

;(async () => {
  startAI()
  await sleep(5000)
  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })
  const aiChats = []
  player.on('chat', (u, m) => { if (u === AI_NAME) aiChats.push(m) })

  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(2500)
    for (let i = 0; i < 40; i++) { if (aiPos(player)) break; await sleep(500) }

    const p0 = player.entity.position.floored()

    // ===== 1) 先 stop，再验证后续指令仍然有效 =====
    player.chat(cmd(AI_NAME, 'stop'))
    await sleep(1500)
    check('stop 有回应', aiChats.some((m) => /已停止/.test(m)), aiChats.slice(-1)[0])

    // 目标点必须相对 **AI 当前位置** 选，否则可能刚好就在 AI 脚下，位移恒为 0
    // 必须 clone：aiPos 返回的是 mineflayer 实时更新的 Vec3 引用，
    // 不 clone 的话 before/after 是同一个对象，位移恒为 0
    const before = aiPos(player).clone()
    const tx = Math.floor(before.x) + 20, ty = Math.floor(before.y), tz = Math.floor(before.z) + 14
    aiChats.length = 0
    player.chat(cmd(AI_NAME, `tpto ${tx} ${ty} ${tz}`))
    await sleep(14000)
    const after = aiPos(player)
    const moved = before && after ? Math.hypot(after.x - before.x, after.z - before.z) : 0
    console.log('[T] tpto 前', before, '后', after, '位移', moved.toFixed(2))
    check('stop 之后 tpto 仍能移动', moved > 8, 'moved=' + moved.toFixed(2))
    const want = Vec3(tx + 0.5, ty + 1, tz + 0.5)
    const d = after ? Math.hypot(after.x - want.x, after.z - want.z) : 999
    check('tpto 到达目标坐标附近', d < 6, 'distFlat=' + d.toFixed(2))

    // 跟随
    player.chat(cmd(AI_NAME, 'tpto me'))
    await sleep(3000)
    await walkTo(player, p0.x + 30, p0.y, p0.z + 24)
    await sleep(18000) // 跟 25 格的路需要时间，给足
    const ap = aiPos(player)
    const pp = player.entity.position
    const fd = ap ? ap.distanceTo(pp) : 999
    console.log('[T] 跟随时 AI', ap, '玩家', pp, '距离', fd.toFixed(2))
    check('stop 之后 tpto me 仍能跟随(5格内)', fd <= 5.5, 'dist=' + fd.toFixed(2))

    player.chat(cmd(AI_NAME, 'stop'))
    await sleep(1500)

    // 建造：stop 之后 build 也要能"赶去建造地点"（goTo 以前同样被中止标志挡住，
    // 结果就是会在原地开工、建错地方）
    const b0 = aiPos(player).clone()
    const bx = Math.floor(b0.x) + 16, by = Math.floor(b0.y), bz = Math.floor(b0.z) + 10
    aiChats.length = 0
    player.chat(cmd(AI_NAME, `build ${bx} ${by} ${bz}`))
    await sleep(16000)
    const b1 = aiPos(player)
    const bmoved = b0.distanceTo(b1)
    console.log('[T] build 赶路 前', b0, '后', b1, '位移', bmoved.toFixed(2))
    check('stop 之后 build 仍能赶往建造地点', bmoved > 8, 'moved=' + bmoved.toFixed(2))
    player.chat(cmd(AI_NAME, 'stop'))
    await sleep(1500)

    // ===== 2) del 删除已保存的内容 =====
    player.chat(cmd(AI_NAME, 'teach ' + TMP))
    await sleep(1500)
    await walkTo(player, p0.x + 4, p0.y, p0.z)
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2000)
    const tFile = require('path').join(ROOT, '教学', TMP + '.json')
    check('教学文件已创建', fs.existsSync(tFile), tFile)

    aiChats.length = 0
    player.chat(cmd(AI_NAME, 'del ' + TMP))
    await sleep(1500)
    check('del 删除成功', !fs.existsSync(tFile))
    check('del 有回应', aiChats.some((m) => /已删除/.test(m)), aiChats.slice(-1)[0])

    // 删除不存在的名字应提示
    aiChats.length = 0
    player.chat(cmd(AI_NAME, 'del nosuchthing'))
    await sleep(1200)
    check('del 不存在的名字有提示', aiChats.some((m) => /没有找到/.test(m)), aiChats.slice(-1)[0])

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('STOP/DEL TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
