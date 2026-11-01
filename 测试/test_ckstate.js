const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// 验证检查点能发现"可交互方块状态被改"，并把它切回去
// （以前只比 name/facing/wire，拉杆被右键切了状态根本查不出来）
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const M = require('../源码/movement')
const { checkCheckpoint, readBlockStates, placeAt } = require('../源码/build')

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'CkStateBot', version: VERSION })
bot.loadPlugin(pathfinder)

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

function groundUnder (b, x, y, z) {
  for (let yy = y; yy > y - 128; yy--) {
    const blk = b.blockAt(new Vec3(x, yy, z))
    if (blk && blk.name !== 'air') return yy
  }
  return y - 1
}

bot.on('spawn', async () => {
  try {
    await bot.waitForTicks(40)
    M.ensureFlying(bot)
    const p = bot.entity.position.floored()
    const gy = groundUnder(bot, p.x, p.y, p.z)
    const lx = p.x + 3, ly = gy + 1, lz = p.z
    console.log('[T] 放置拉杆于 ' + lx + ',' + ly + ',' + lz)

    const okPlace = await placeAt(bot, lx, ly, lz, 'north', 'lever', 'floor')
    check('拉杆放置成功', okPlace, 'ok=' + okPlace)
    await bot.waitForTicks(5)

    let lever = bot.blockAt(new Vec3(lx, ly, lz))
    const recorded = readBlockStates(bot, lever)
    console.log('[T] 录制到的状态 = ' + JSON.stringify(recorded))
    check('快照记录到了方块状态', !!recorded && 'powered' in recorded, 'states=' + JSON.stringify(recorded))

    // 人为把状态改掉（模拟"被右键误触"）
    await bot.lookAt(lever.position.offset(0.5, 0.5, 0.5), true)
    await M.sleep(100)
    await bot.activateBlock(lever)
    await bot.waitForTicks(6)
    lever = bot.blockAt(new Vec3(lx, ly, lz))
    const nowStates = readBlockStates(bot, lever)
    console.log('[T] 被改后的状态 = ' + JSON.stringify(nowStates))
    check('状态确实被改了(与录制不同)', JSON.stringify(nowStates) !== JSON.stringify(recorded),
      'now=' + JSON.stringify(nowStates))

    // 让检查点去校对：应该发现状态不对并右键切回去
    const fixed = await checkCheckpoint(
      bot,
      [{ dx: 0, dy: 0, dz: 0, name: lever.name, face: 'floor', states: recorded }],
      lx, ly, lz, 'test'
    )
    console.log('[T] 检查点修正数 = ' + fixed)
    check('检查点发现并修正了状态', fixed > 0, 'fixed=' + fixed)

    lever = bot.blockAt(new Vec3(lx, ly, lz))
    const after = readBlockStates(bot, lever)
    console.log('[T] 校对后状态 = ' + JSON.stringify(after))
    check('状态已恢复到录制值', JSON.stringify(after) === JSON.stringify(recorded),
      'after=' + JSON.stringify(after))
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    results.push({ name: 'exception', ok: false })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
  console.log(failed.length ? 'CKSTATE TEST FAIL' : 'CKSTATE TEST PASS')
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500)
})
bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 180000)
