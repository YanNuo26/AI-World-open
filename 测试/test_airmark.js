const { HOST, PORT, VERSION, cmd } = require('./_common')
// 只验证：建造位置**在空中**时，羊毛标记也能放出来（需要临时辅助方块）
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const M = require('../源码/movement')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'AirMarkPlayer'
const NAME = 'airmk'
const AI_LOG = path.join(ROOT, '日志', 'ai_airmark.log')

let aiProc
const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}
const aiLogHas = (s) => fs.existsSync(AI_LOG) && fs.readFileSync(AI_LOG, 'utf8').includes(s)
const clearAiLog = () => { if (fs.existsSync(AI_LOG)) fs.writeFileSync(AI_LOG, '') }

async function walkTo (player, x, y, z) {
  const dest = new Vec3(x + 0.5, y, z + 0.5)
  const start = player.entity.position.clone()
  const steps = Math.max(1, Math.ceil(start.distanceTo(dest) / 1.0))
  for (let i = 1; i <= steps; i++) {
    player.entity.position = start.plus(dest.minus(start).scaled(i / steps))
    await sleep(70)
  }
  await sleep(700)
}
function groundUnder (b, x, y, z) {
  for (let yy = y; yy > y - 128; yy--) {
    const blk = b.blockAt(new Vec3(x, yy, z))
    if (blk && blk.name !== 'air') return yy
  }
  return y - 1
}
function giveItem (bot, itemName) {
  const mcData = require('minecraft-data')(bot.version || VERSION)
  const PItem = require('prismarine-item')(bot.version || VERSION)
  const stack = new PItem(mcData.itemsByName[itemName].id, 1, 0)
  bot._client.write('set_creative_slot', { slot: 36, item: PItem.toNotch(stack) })
  bot._setSlot(36, stack)
  if (typeof bot.setQuickBarSlot === 'function') bot.setQuickBarSlot(0)
}

;(async () => {
  clearAiLog()
  const log = fs.createWriteStream(AI_LOG)
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env: { ...process.env, MC_USER: AI_NAME } })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
  await sleep(6000)

  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })

  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(2500)
    for (let i = 0; i < 40; i++) {
      if (player.players[AI_NAME] && player.players[AI_NAME].entity) break
      await sleep(500)
    }
    const p0 = player.entity.position.floored()
    const gy = groundUnder(player, p0.x, p0.y, p0.z)
    console.log('[T] 地面 y=' + gy)

    // 录一个教学（在地面上放 3 个石头）
    player.chat(cmd(AI_NAME, 'teach ' + NAME))
    await sleep(1500)
    await walkTo(player, p0.x + 3, gy + 1, p0.z)
    giveItem(player, 'stone')
    await sleep(400)
    for (let i = 0; i < 3; i++) {
      try {
        const below = player.blockAt(new Vec3(p0.x + 4 + i, gy, p0.z))
        await player.placeBlock(below, new Vec3(0, 1, 0))
        await sleep(350)
      } catch (e) { /* ignore */ }
    }
    await sleep(1200)
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2500)
    check('教学已录制', fs.existsSync(path.join(ROOT, '教学', NAME + '.json')))

    // 玩家升到高空：这样复现时整个包围盒都在空中，标记必须靠临时辅助方块
    M.ensureFlying(player)
    await M.moveTo(player, p0.x + 8 + 0.5, gy + 26, p0.z + 8 + 0.5)
    await player.waitForTicks(10)
    const high = player.entity.position.floored()
    console.log('[T] 玩家升空到 y=' + high.y)
    check('玩家已升空', high.y >= gy + 20, 'y=' + high.y)

    // 现在下达建造指令（AI 会飞到玩家所在的高空，原点就在空中）
    clearAiLog()
    player.chat(cmd(AI_NAME, 'build ' + NAME))
    for (let i = 0; i < 40; i++) {
      if (aiLogHas('标出建造范围')) break
      await sleep(1500)
    }
    check('空中也能用羊毛标出范围', aiLogHas('标出建造范围'),
      'marked=' + aiLogHas('标出建造范围'))

    // 标记用的临时支撑随后应被清掉
    await sleep(8000)
    const cleaned = aiLogHas('清理') || aiLogHas('辅助')
    console.log('[T] 辅助方块清理相关日志: ' + cleaned)

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('AIRMARK TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
