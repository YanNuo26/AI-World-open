const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证两个修复：
//   1) 拼错指令（bulid）不再是"一声不吭"：自动纠正成 build 并开工
//   2) 建造位置在空中时，羊毛标记也能放出来（需要临时辅助方块）
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const M = require('../源码/movement')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'MarkPlayer2'
const NAME = 'mk2'
const AI_LOG = path.join(ROOT, '日志', 'ai_mark2.log')

let aiProc
const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}
const aiLogHas = (s) => fs.existsSync(AI_LOG) && fs.readFileSync(AI_LOG, 'utf8').includes(s)
const clearAiLog = () => { if (fs.existsSync(AI_LOG)) fs.writeFileSync(AI_LOG, '') }

async function walkTo (player, x, y, z) {
  const dest = new (require('vec3'))(x + 0.5, y, z + 0.5)
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
    const blk = b.blockAt(new (require('vec3'))(x, yy, z))
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
  const heard = []
  player.on('messagestr', (m) => heard.push(String(m)))

  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(2500)
    for (let i = 0; i < 40; i++) {
      if (player.players[AI_NAME] && player.players[AI_NAME].entity) break
      await sleep(500)
    }
    const p0 = player.entity.position.floored()
    const gy = groundUnder(player, p0.x, p0.y, p0.z)

    // 录一个教学
    player.chat(cmd(AI_NAME, 'teach ' + NAME))
    await sleep(1500)
    await walkTo(player, p0.x + 3, gy + 1, p0.z)
    giveItem(player, 'stone')
    await sleep(400)
    // 每列自己找真正的地面再放：存档没重置时 (p0.x+4..6, gy) 可能是空气，
    // 放在空气上会被服务器拒绝 → 教学里一个 place 事件都录不到，
    // 复现时就变成"0 个事件 / 放置 0 个"，看起来像"标记功能坏了"（2026-11-01 连挂三次）。
    let placed = 0
    for (let i = 0; i < 3; i++) {
      const px = p0.x + 4 + i
      const bg = groundUnder(player, px, gy + 3, p0.z)
      const below = player.blockAt(new (require('vec3'))(px, bg, p0.z))
      try {
        await player.placeBlock(below, new (require('vec3'))(0, 1, 0))
        placed++
        await sleep(350)
      } catch (e) { console.log('[T] 放置失败 (' + px + ',' + (bg + 1) + ',' + p0.z + '): ' + (e && e.message)) }
    }
    await sleep(1200)
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2500)
    console.log('[T] 录制时放了 ' + placed + ' 个方块')

    // 教学里必须真的有 place 事件，否则后面"复现"什么都不会发生（失败要大声说出来）
    let teachPlaces = 0
    try {
      const tf = JSON.parse(fs.readFileSync(path.join(ROOT, '教学', NAME + '.json'), 'utf8'))
      teachPlaces = (tf.events || []).filter((e) => e.t === 'place').length
    } catch (e) { /* 文件没生成时算 0 */ }
    check('教学里录到了放置事件', teachPlaces >= 1, 'places=' + teachPlaces)


    // ===== 1) 拼写错误 =====
    // 用坐标版指令（bulid x y z），避免依赖"取玩家位置"，直接看它有没有被纠正成 build
    heard.length = 0
    player.chat(cmd(AI_NAME, `bulid ${p0.x + 12} ${gy + 1} ${p0.z + 12}`)) // 故意拼错
    await sleep(10000)
    console.log('[T] 听到的回复: ' + JSON.stringify(heard.slice(-3)))
    check('拼错 bulid 也有回应', heard.some((m) => m.includes('AIBuilder')),
      'replied=' + heard.some((m) => m.includes('AIBuilder')))
    check('bulid 被纠正为 build 并开工',
      heard.some((m) => m.includes('正在前往建造地点') || m.includes('开始建造默认建筑')),
      'built=' + heard.some((m) => m.includes('正在前往建造地点') || m.includes('开始建造默认建筑')))
    // 停掉它，别影响后面的空中测试
    // ⚠️ 必须等 ai 真的停下来（回「已停止所有任务」）再往下走：
    //    上一个建造还在跑的话，后面 `build mk2` 的空中标记会被它挤掉，
    //    测试就会看到 "marked=false"（2026-11-01 连挂两次都是这个原因）
    heard.length = 0
    player.chat(cmd(AI_NAME, 'stop'))
    let stopped = false
    for (let i = 0; i < 20; i++) {
      if (heard.some((m) => m.includes('已停止所有任务'))) { stopped = true; break }
      await sleep(1000)
    }
    console.log('[T] 停止确认: ' + stopped)
    await sleep(2000)

    // ===== 2) 空中建造时的羊毛标记 =====
    // 玩家飞到高空再 build -> 整个包围盒都在空中，标记必须靠临时辅助方块
    await sleep(6000)
    // 不能靠 /tp（测试玩家未必是 op）；也要先"开飞行"，否则会被重力拉回地面。
    // 直接用项目自己的 movement 模块，和 AI 走同一套。
    const cur = player.entity.position.clone()
    M.ensureFlying(player)
    await M.moveTo(player, Math.floor(cur.x) + 0.5, Math.floor(cur.y) + 25, Math.floor(cur.z) + 0.5)
    await player.waitForTicks(10)
    const high = player.entity.position.floored()
    console.log('[T] 玩家升空到 y=' + high.y)
    check('玩家已升空', high.y >= Math.floor(cur.y) + 20, 'y=' + high.y + ' (from ' + Math.floor(cur.y) + ')')

    clearAiLog()
    player.chat(cmd(AI_NAME, 'build ' + NAME))
    // 空中标记很慢：每个标记方块底下都要从地面垒一列 smooth_stone 临时支撑，
    // 5×5 的圈 ≈ 16 个标记 × 20 多格支撑，按 0.26s/方块算 1~2 分钟很正常。
    // 以前只等 45 秒 → 明明在干活也会判 FAIL（2026-11-01 跑到 1m26s 时日志里还在垒支撑）。
    for (let i = 0; i < 60; i++) {
      if (aiLogHas('标出建造范围')) break
      await sleep(1500)
    }
    check('空中也能标出羊毛范围（靠辅助方块）', aiLogHas('标出建造范围'),
      'marked=' + aiLogHas('标出建造范围'))

    // 标记用的临时支撑要被清掉，不能留在场上
    const leftAssist = aiLogHas('已清理残留辅助方块')
    console.log('[T] 清理辅助方块日志: ' + leftAssist)

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('MARK2 TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
