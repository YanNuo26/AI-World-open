const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// 验证移动要求：
//   1) 水平移动时使用 W 键（bot.controlState.forward 必须为 true）
//   2) 移动时机头朝向与移动方向一致（yaw 对齐）
//   3) y 轴能寻路（目标高度与当前高度不同，且能到达）
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const { pathfinder } = require('mineflayer-pathfinder')
const M = require('../源码/movement')

const bot = mineflayer.createBot({
  host: HOST, port: PORT, username: 'MoveBot', version: VERSION
})
bot.loadPlugin(pathfinder)

// 归一化到 (-PI, PI]
const norm = (a) => Math.atan2(Math.sin(a), Math.cos(a))

bot.on('spawn', async () => {
  let pass = true
  try {
    await bot.waitForTicks(30)
    const start = bot.entity.position.clone()
    // 目标：水平 25 格 + 垂直 +8 格（同时考察 xz 与 y）
    const dest = new Vec3(start.x + 25, start.y + 8, start.z + 20)
    console.log('start =', start, ' dest =', dest)

    // 采样：位移方向、yaw、是否按住 W
    const samples = []
    const iv = setInterval(() => {
      const p = bot.entity.position
      samples.push({
        x: p.x, y: p.y, z: p.z,
        yaw: bot.entity.yaw,
        fwd: !!(bot.controlState && bot.controlState.forward)
      })
    }, 100)

    await M.moveTo(bot, dest.x, dest.y, dest.z)
    clearInterval(iv)

    // 1) 到达判定
    const end = bot.entity.position
    const d3 = end.distanceTo(dest)
    const dFlat = Math.hypot(dest.x - end.x, dest.z - end.z)
    const dY = Math.abs(dest.y - end.y)
    console.log('end =', end)
    console.log('dist3D =', d3.toFixed(2), ' distFlat =', dFlat.toFixed(2), ' distY =', dY.toFixed(2))

    if (dFlat > 2.5) { console.log('FAIL: 水平没走到'); pass = false }
    if (dY > 2.5) { console.log('FAIL: y 轴没走到（y 轴寻路失败）'); pass = false }

    // 2) W 键
    const fwdCount = samples.filter((s) => s.fwd).length
    console.log('按住 W 的采样数 =', fwdCount, '/', samples.length)
    if (fwdCount < 3) { console.log('FAIL: 没有使用 W 键移动'); pass = false }

    // 3) 朝向与移动方向一致（取有明显位移的相邻采样对）
    let checked = 0
    let aligned = 0
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i]
      const dx = b.x - a.x, dz = b.z - a.z
      const step = Math.hypot(dx, dz)
      if (step < 0.15) continue // 太小，方向不可靠
      const moveYaw = Math.atan2(-dx, -dz)
      const diff = Math.abs(norm(moveYaw - b.yaw))
      checked++
      if (diff < 0.6) aligned++ // 约 34 度以内视为"看着移动方向"
    }
    console.log('方向对齐检查 =', aligned, '/', checked)
    if (checked === 0) { console.log('FAIL: 没有有效位移样本'); pass = false }
    else if (aligned / checked < 0.7) { console.log('FAIL: 移动时没有看向移动方向'); pass = false }

    console.log(pass ? 'MOVE TEST PASS' : 'MOVE TEST FAIL')
  } catch (e) {
    console.error('TEST ERROR', e && e.stack)
    pass = false
    console.log('MOVE TEST FAIL')
  }
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(pass ? 0 : 1), 500)
})

bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 180000)
