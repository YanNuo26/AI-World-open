const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// Build a house whose walls are pistons, then read back every piston's facing
// and check it matches "pointing outward from the centre" (never up/down).
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { build } = require('../源码/build')

const bot = mineflayer.createBot({
  host: HOST, port: PORT,
  username: 'TestBot',
  version: VERSION
})
// mcData 必须放在 createBot 之后：bot 是 const，前面引用会触发 TDZ
const mcData = require('minecraft-data')(bot.version || VERSION)

const P = mcData.blocksByName.piston
const VALS = P.states.find((s) => s.name === 'facing').values
const decode = (block) => {
  if (!block || block.name !== 'piston' || block.stateId == null) return null
  return VALS[(block.stateId - P.minStateId) - 6]
}
const outward = (dx, dz) => {
  if (dx === 0 && dz === 0) return 'up'
  if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? 'east' : 'west'
  return dz > 0 ? 'south' : 'north'
}

bot.on('spawn', async () => {
  try {
    await bot.waitForTicks(30)
    await build(bot, {
      building: 'house', size: 5, height: 2,
      floor: 'stone', wall: 'piston', roof: 'bricks'
    })
    const cx = bot.x0
    const cz = bot.z0
    let total = 0
    let ok = 0
    let vertical = 0
    const wrong = []
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        for (let y = bot.gy + 1; y <= bot.gy + 5; y++) {
          const b = bot.blockAt(new Vec3(cx + dx, y, cz + dz))
          const f = decode(b)
          if (!f) continue
          total++
          if (f === 'up' || f === 'down') vertical++
          const want = outward(dx, dz)
          if (f === want) ok++
          else wrong.push(`(${dx},${dz}) want ${want} got ${f}`)
        }
      }
    }
    console.log('PISTONS FOUND:', total)
    console.log('CORRECT FACING:', ok)
    console.log('VERTICAL (old bug):', vertical)
    console.log('WRONG (first 8):', wrong.slice(0, 8).join(' | '))
    console.log(total > 0 && ok === total ? 'FACING TEST PASS' : 'FACING TEST FAIL')
  } catch (e) {
    console.error('TEST FAIL', e && e.stack)
  }
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(0), 500)
})
bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 330000)
