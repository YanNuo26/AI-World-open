const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// 验证移动优化：
//   1) 移动时按住疾跑(sprint)
//   2) 距离超过 100 格时直接传送，而不是一步步飞
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { pathfinder } = require('mineflayer-pathfinder')
const M = require('../源码/movement')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'MoveBot2', version: VERSION })
bot.loadPlugin(pathfinder)

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

bot.on('spawn', async () => {
  try {
    await bot.waitForTicks(40)
    const start = bot.entity.position.clone()

    // ===== 1) 近距离：应走过去，且按住疾跑 =====
    const near = new Vec3(start.x + 25, start.y, start.z + 10)
    const samples = []
    const iv = setInterval(() => samples.push(!!(bot.controlState && bot.controlState.sprint)), 60)
    const t0 = Date.now()
    await M.moveTo(bot, near.x, near.y, near.z)
    const tNear = (Date.now() - t0) / 1000
    clearInterval(iv)
    const sprinted = samples.filter(Boolean).length
    console.log('[T] 近距离(约27格): 用时 ' + tNear.toFixed(1) + 's，疾跑采样 ' + sprinted + '/' + samples.length)
    check('近距离移动时按住疾跑', sprinted > 0, 'sprint=' + sprinted)
    const dNear = bot.entity.position.distanceTo(near)
    check('近距离到达目标', dNear < 3, 'dist=' + dNear.toFixed(2))

    // ===== 2) 远距离：应触发直接传送 =====
    const s2 = bot.entity.position.clone()
    const far = new Vec3(s2.x + 160, s2.y, s2.z + 40)
    const dist = s2.distanceTo(far)
    console.log('[T] 远距离目标距离 = ' + dist.toFixed(1) + ' 格')
    const t1 = Date.now()
    await M.moveTo(bot, far.x, far.y, far.z)
    const tFar = (Date.now() - t1) / 1000
    const dFar = bot.entity.position.distanceTo(far)
    console.log('[T] 远距离: 用时 ' + tFar.toFixed(1) + 's，终点偏差 ' + dFar.toFixed(2))
    check('远距离到达目标', dFar < 3, 'dist=' + dFar.toFixed(2))
    // 167 格若一步步飞要几十秒；传送走 1 格/tick 也只需几秒
    check('远距离走的是传送(很快)', tFar < 25, 't=' + tFar.toFixed(1) + 's')

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('MOVE2 TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  }
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(process.exitCode || 0), 400)
})
bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 180000)
