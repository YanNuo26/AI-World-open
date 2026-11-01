const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// 直接调用 replayTeaching，原点设在**高空**：验证羊毛标记能靠临时辅助方块放出来
// （绕过聊天指令和长途飞行，只测 markBuildArea 这一处）
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const Vec3 = require('vec3')
const M = require('../源码/movement')
const { replayTeaching } = require('../源码/build')

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'AirMarkBot', version: VERSION })
bot.loadPlugin(pathfinder)

const teach = {
  name: 'airmark_direct',
  events: [
    { t: 'place', ts: 0, dx: 0, dy: 0, dz: 0, name: 'stone' },
    { t: 'place', ts: 0, dx: 1, dy: 0, dz: 0, name: 'stone' },
    { t: 'place', ts: 0, dx: 2, dy: 0, dz: 0, name: 'stone' }
  ]
}

bot.on('spawn', async () => {
  try {
    await bot.waitForTicks(40)
    M.ensureFlying(bot)
    const p = bot.entity.position.floored()
    // 升到高空 20 格，让整个建造范围都悬在空中
    await M.moveTo(bot, p.x + 0.5, p.y + 20, p.z + 0.5)
    await bot.waitForTicks(10)
    const origin = bot.entity.position.floored()
    console.log('[T] 建造原点(高空) = ' + JSON.stringify(origin))
    // 确认目标格确实是"四周没有实心方块"的悬空格（否则就测不到辅助方块的必要性）
    const b0 = bot.blockAt(new Vec3(origin.x, origin.y, origin.z))
    let solidNb = 0
    for (const [ox, oy, oz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
      const nb = bot.blockAt(new Vec3(origin.x + ox, origin.y + oy, origin.z + oz))
      if (nb && nb.name !== 'air') solidNb++
    }
    console.log('[T] 原点方块=' + (b0 ? b0.name : '?') + ' 实心邻居数=' + solidNb)
    console.log('[T] ' + (solidNb === 0 ? 'PASS' : 'FAIL') + ' - 建造范围确实悬空(无实心邻居)')

    await replayTeaching(bot, teach, origin)
    console.log('[T] 复现完成')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  }
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(process.exitCode || 0), 500)
})
bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 180000)
