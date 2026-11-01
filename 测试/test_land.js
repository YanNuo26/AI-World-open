const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// 直接验证 landOnGround：飞在空中 -> 落地 -> 站在实心地面上
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const M = require('../源码/movement')

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'LandBot', version: VERSION })
bot.loadPlugin(pathfinder)

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}
const belowSolid = () => {
  const f = bot.entity.position.floored()
  const b = bot.blockAt(new Vec3(f.x, f.y - 1, f.z))
  return !!(b && b.name !== 'air')
}

bot.on('spawn', async () => {
  try {
    await bot.waitForTicks(40)
    // 飞高
    M.ensureFlying(bot)
    const p = bot.entity.position.floored()
    await M.moveTo(bot, p.x + 0.5, p.y + 12, p.z + 0.5)
    await bot.waitForTicks(10)
    const airY = bot.entity.position.y
    console.log('[T] 升空后 y=' + airY.toFixed(2) + ' onGround=' + bot.entity.onGround)
    check('确实在空中(脚下非实心)', !belowSolid(), 'belowSolid=' + belowSolid())

    // 落地
    const ok = await M.landOnGround(bot)
    await bot.waitForTicks(30)
    const gy = bot.entity.position.y
    console.log('[T] 落地后 y=' + gy.toFixed(2) + ' onGround=' + bot.entity.onGround +
      ' 脚下实心=' + belowSolid())
    check('landOnGround 返回成功', ok, 'ok=' + ok)
    check('高度降下来了', gy < airY - 8, 'air=' + airY.toFixed(1) + ' ground=' + gy.toFixed(1))
    check('已站在地面(onGround)', bot.entity.onGround === true, 'onGround=' + bot.entity.onGround)
    check('脚下是实心地面', belowSolid(), 'belowSolid=' + belowSolid())
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    results.push({ name: 'exception', ok: false })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
  console.log(failed.length ? 'LAND TEST FAIL' : 'LAND TEST PASS')
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500)
})
bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 120000)
