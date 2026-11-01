const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// 验证非整块方块（boundingBox === 'empty'）能否正确放置：
//   红石粉(贴地) / 墙上红石火把(贴墙) / 墙上拉杆(贴墙)
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { placeBlocks, readFacing, readFace } = require('../源码/build')

const bot = mineflayer.createBot({
  host: HOST, port: PORT, username: 'RedstoneBot', version: VERSION
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
    // 必须等周边区块加载完：否则这些列的 blockAt 还是空的，
    // 会被误判成"悬空"而走辅助支撑（辅助位又正好是地面，永远放不进去）。
    const M = require('../源码/movement')
    await M.moveToSmooth(bot, p.x + 0.5, p.y, p.z + 0.5)
    for (let i = 0; i < 40; i++) {
      const ok = [-1, 0, 1].every((dx) => [-1, 0, 1].every((dz) => {
        const b = bot.blockAt(new Vec3(p.x + dx, p.y - 1, p.z + dz))
        return b && b.name !== 'air'
      }))
      if (ok) break
      await bot.waitForTicks(10)
    }
    const gy = groundUnder(bot, p.x, p.y, p.z)
    const x0 = p.x, z0 = p.z
    const F = gy + 1 // 地板层
    console.log('ground =', gy, ' floor layer =', F, ' at', x0, z0)

    const blocks = []
    // 1) 先铺 3x3 石头地板
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
      blocks.push({ x: x0 + dx, y: F, z: z0 + dz, name: 'stone', facing: 'up', face: null })
    // 2) 两格高的"墙"（供火把和拉杆依附）
    blocks.push({ x: x0 + 1, y: F + 1, z: z0, name: 'stone', facing: 'up', face: null })
    blocks.push({ x: x0 + 1, y: F + 2, z: z0, name: 'stone', facing: 'up', face: null })
    // 3) 墙上红石火把：放在 (x0,F+1,z0)，朝西 -> 依附它东边的墙
    blocks.push({ x: x0, y: F + 1, z: z0, name: 'redstone_wall_torch', facing: 'west', face: 'wall' })
    // 4) 红石粉：放在 (x0-1,F+1,z0)，下方是地板 -> 贴地
    blocks.push({ x: x0 - 1, y: F + 1, z: z0, name: 'redstone_wire', facing: null, face: 'floor' })
    // 5) 墙上拉杆：放在 (x0,F+2,z0)，朝西 -> 依附东边的墙
    blocks.push({ x: x0, y: F + 2, z: z0, name: 'lever', facing: 'west', face: 'wall' })

    await placeBlocks(bot, blocks, 'Redstone test')

    const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
    const show = (label, b, wantFacing, wantFace) => {
      const name = b ? b.name : 'null'
      const f = readFacing(bot, b)
      const fc = readFace(bot, b)
      console.log(`${label}: name=${name} facing=${f} face=${fc}`)
      if (name !== label.split(' ')[0]) { console.log(`  FAIL 方块不对`); pass = false; return }
      if (wantFacing && f !== wantFacing) { console.log(`  FAIL facing 应为 ${wantFacing}`); pass = false }
      if (wantFace && fc !== wantFace) { console.log(`  FAIL face 应为 ${wantFace}`); pass = false }
    }

    show('redstone_wire 红石粉', at(x0 - 1, F + 1, z0), null, null)
    show('redstone_wall_torch 墙上红石火把', at(x0, F + 1, z0), 'west', null)
    show('lever 墙上拉杆', at(x0, F + 2, z0), 'west', 'wall')

    console.log(pass ? 'REDSTONE TEST PASS' : 'REDSTONE TEST FAIL')
  } catch (e) {
    console.error('TEST ERROR', e && e.stack)
    pass = false
    console.log('REDSTONE TEST FAIL')
  }
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(pass ? 0 : 1), 500)
})

bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 240000)
