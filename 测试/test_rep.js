const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证两个新功能：
//   1) 建造前用红/蓝羊毛对角标出范围（默认开，mark n 关 / mark y 开）
//   2) rep <名字> <方向> <间隔> <数量> 重复建造
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'RepPlayer'
const NAME = 'reptest'
const AI_LOG = path.join(ROOT, '日志', 'ai_rep.log')

let aiProc
function startAI () {
  const log = fs.createWriteStream(AI_LOG)
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env: { ...process.env, MC_USER: AI_NAME } })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
}
const aiLogHas = (s) => fs.existsSync(AI_LOG) && fs.readFileSync(AI_LOG, 'utf8').includes(s)
const clearAiLog = () => { if (fs.existsSync(AI_LOG)) fs.writeFileSync(AI_LOG, '') }

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

async function walkTo (player, x, y, z) {
  const dest = Vec3(x + 0.5, y, z + 0.5)
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
const readTeach = (n) => {
  const f = path.join(ROOT, '教学', n + '.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}

;(async () => {
  clearAiLog()
  startAI()
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
    console.log('[T] player', JSON.stringify(p0), 'ground', gy)

    // ===== 录一个教学：沿 x 放 3 个石头 =====
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
      } catch (e) { console.log('[T] place err', e && e.message) }
    }
    await sleep(1200)
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2200)

    const teach = readTeach(NAME)
    const places = teach ? (teach.events || []).filter((e) => e.t === 'place') : []
    console.log('[T] 教学 "' + NAME + '" 放置事件 = ' + places.length)
    check('教学已记录', places.length > 0, 'places=' + places.length)
    if (!places.length) throw new Error('no teaching recorded')

    // ===== 1) mark 开关 =====
    player.chat(cmd(AI_NAME, 'mark n'))
    await sleep(1200)
    clearAiLog()
    player.chat(cmd(AI_NAME, 'build ' + NAME))
    await sleep(14000)
    check('mark n 后不再标羊毛', !aiLogHas('标出建造范围'), 'log has marker=' + aiLogHas('标出建造范围'))

    player.chat(cmd(AI_NAME, 'mark y'))
    await sleep(1200)
    clearAiLog()
    player.chat(cmd(AI_NAME, 'build ' + NAME))
    await sleep(14000)
    check('mark y 后会标羊毛', aiLogHas('标出建造范围'), 'log has marker=' + aiLogHas('标出建造范围'))

    // ===== 2) rep 重复建造 =====
    // 玩家站定，rep 以玩家位置为基准
    await walkTo(player, p0.x + 20, gy + 1, p0.z + 20)
    const base = player.entity.position.floored()
    console.log('[T] rep 基准点 =', JSON.stringify(base))
    clearAiLog()
    player.chat(cmd(AI_NAME, `rep ${NAME} x 1 3`))
    // 等 3 份建完（每份含标记停顿，给足时间）
    for (let i = 0; i < 60; i++) {
      if (aiLogHas('rep 第 3 个完成')) break
      await sleep(2000)
    }
    // 注意：完成提示是 bot.chat（进游戏聊天），stdout 里看得到的是进度日志
    check('rep 完成提示', aiLogHas('rep 第 3 个完成'), 'done=' + aiLogHas('rep 第 3 个完成'))

    // 校验：3 份都真的建出来了
    // 教学的相对坐标
    // 必须比对**方块名**：只判"非空气"会被地面误判成已建（世界被挖过更容易踩到）
    const rel = places.map((e) => ({ dx: e.dx, dy: e.dy, dz: e.dz, name: e.name }))
    const dxs = rel.map((r) => r.dx)
    const sizeX = Math.max(...dxs) - Math.min(...dxs) + 1
    const step = sizeX + 1
    console.log('[T] 教学 x 尺寸=' + sizeX + '，step=' + step)
    let copiesFound = 0
    for (let i = 0; i < 3; i++) {
      const ox = base.x + i * step
      // 该份里所有记录过的相对位置都要有方块
      const allOk = rel.every((r) => {
        const b = player.blockAt(new Vec3(ox + r.dx, base.y + r.dy, base.z + r.dz))
        return b && b.name === r.name
      })
      console.log('[T] 第 ' + (i + 1) + ' 份 @ x=' + ox + ' -> ' + (allOk ? 'OK' : '缺块'))
      if (allOk) copiesFound++
    }
    check('rep 建出 3 份', copiesFound === 3, 'copies=' + copiesFound)

    // 第 4 份不该存在（只请求了 3 个）
    const ox4 = base.x + 3 * step
    const anyAt4 = rel.some((r) => {
      const b = player.blockAt(new Vec3(ox4 + r.dx, base.y + r.dy, base.z + r.dz))
      return b && b.name === r.name
    })
    check('没有多建第 4 份', !anyAt4, 'extra=' + anyAt4)

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('REP TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
