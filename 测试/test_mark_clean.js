const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// 验证两个羊毛标记都被正确清除。
// 关键：教学的两个方块故意放在 (0,2,0) 和 (2,0,2)，
// 这样包围盒的对角 (0,0,0) 和 (2,2,2) **不是结构本体**——
// 羊毛要是漏拆，那两格就会留着红/蓝羊毛，能被检出。
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const M = require('../源码/movement')
const { replayTeaching } = require('../源码/build')

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'MarkCleanBot', version: VERSION })
bot.loadPlugin(pathfinder)

const teach = {
  name: 'mark_clean',
  events: [
    { t: 'place', ts: 0, dx: 0, dy: 2, dz: 0, name: 'stone' },
    { t: 'place', ts: 0, dx: 2, dy: 0, dz: 2, name: 'stone' }
  ]
}

let ok = true
function check (name, cond, extra) {
  if (!cond) ok = false
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

bot.on('spawn', async () => {
  try {
    await bot.waitForTicks(40)
    M.ensureFlying(bot)
    const p = bot.entity.position.floored()
    await M.moveTo(bot, p.x + 0.5, p.y + 18, p.z + 0.5)
    await bot.waitForTicks(10)
    const o = bot.entity.position.floored()
    console.log('[T] 建造原点(高空) = ' + JSON.stringify(o))

    await replayTeaching(bot, teach, o)
    await bot.waitForTicks(10)

    // 两个对角：min=(0,0,0) max=(2,2,2)，都不是结构方块
    const c1 = new Vec3(o.x, o.y, o.z)
    const c2 = new Vec3(o.x + 2, o.y + 2, o.z + 2)
    for (const [label, c] of [['min 角(红羊毛位)', c1], ['max 角(蓝羊毛位)', c2]]) {
      const b = bot.blockAt(c)
      const n = b ? b.name : 'air'
      console.log(`[T] ${label} ${JSON.stringify(c)} = ${n}`)
      check(`${label}没有残留羊毛`, n !== 'red_wool' && n !== 'blue_wool', 'block=' + n)
    }
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    ok = false
  }
  try { bot.end() } catch (e) {}
  console.log(ok ? 'MARKCLEAN TEST PASS' : 'MARKCLEAN TEST FAIL')
  setTimeout(() => process.exit(ok ? 0 : 1), 500)
})
bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 180000)
