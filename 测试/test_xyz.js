const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// 验证：
//   1) build 支持显式的 xyz 基准点（可以在"空中"开工）
//   2) 悬空时会用平滑石头(smooth_stone)临时支撑
//   3) 方块放好后辅助支撑被立刻拆除（现场不留 smooth_stone，也不留空心柱）
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { build } = require('../源码/build')

const bot = mineflayer.createBot({
  host: HOST, port: PORT, username: 'XyzBot', version: VERSION
})

function groundUnder (bot, x, y, z) {
  for (let yy = y; yy > y - 128; yy--) {
    const b = bot.blockAt(new Vec3(x, yy, z))
    if (b && b.name !== 'air') return yy
  }
  return y - 1
}

bot.on('spawn', async () => {
  let pass = true
  try {
    await bot.waitForTicks(30)
    const p = bot.entity.position.floored()
    const gy = groundUnder(bot, p.x, p.y, p.z)
    // 在空中开工：基准点抬到地面上方 4 格
    const origin = { x: p.x, y: gy + 4, z: p.z }
    console.log('ground y =', gy, ' build origin =', JSON.stringify(origin))

    await build(bot, {
      building: 'house', size: 3, height: 1,
      floor: 'stone', wall: 'oak_planks', roof: 'bricks',
      origin
    })

    const x0 = bot.x0, z0 = bot.z0, by = bot.gy
    console.log('build base gy =', by, '(want', origin.y, ')')

    // 1) 基准点必须是给定的 xyz
    if (by !== origin.y) { console.log('FAIL: 基准点不是指定高度'); pass = false }

    // 2) 地板层（origin.y+1）应当真的建起来了
    let floorOk = 0
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const b = bot.blockAt(new Vec3(x0 + dx, by + 1, z0 + dz))
      if (b && b.name === 'stone') floorOk++
    }
    console.log('floor stone cells =', floorOk, '/ 9')
    if (floorOk < 8) { console.log('FAIL: 地板没建起来'); pass = false }

    // 3) 支撑柱区域（地面之上、地板之下）必须已被拆除 -> 空气
    let leftOver = 0
    let smooth = 0
    for (let y = gy + 1; y <= by; y++) {
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const b = bot.blockAt(new Vec3(x0 + dx, y, z0 + dz))
        if (!b || b.name === 'air') continue
        leftOver++
        if (b.name === 'smooth_stone') smooth++
      }
    }
    console.log('残留方块(地板下方) =', leftOver, ' 其中 smooth_stone =', smooth)
    if (smooth > 0) { console.log('FAIL: 辅助支撑没拆干净'); pass = false }
    if (leftOver > 0) { console.log('FAIL: 支撑柱没拆干净'); pass = false }

    // 4) 记录表应为空
    const recorded = (bot._assistBlocks || []).length
    console.log('bot._assistBlocks 剩余 =', recorded)
    if (recorded !== 0) { console.log('FAIL: 辅助方块记录未清空'); pass = false }

    console.log(pass ? 'XYZ ASSIST TEST PASS' : 'XYZ ASSIST TEST FAIL')
  } catch (e) {
    console.error('TEST ERROR', e && e.stack)
    pass = false
    console.log('XYZ ASSIST TEST FAIL')
  }
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(pass ? 0 : 1), 500)
})

bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 240000)
