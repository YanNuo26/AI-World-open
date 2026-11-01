const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证教学模式的三个修复：
//   1) 连续录制 A -> B，两者不应被串连（B 里不能混进 A 的移动）
//   2) 空格（上升）与 Shift（潜行）会被记成 key 事件
//   3) 含活塞的结构：复现过程中不纠正，结束后再收尾校对保证一致
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const { readFacing } = require('../源码/build')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'TeachPlayer3'

let aiProc
function startAI () {
  const log = fs.createWriteStream(require('path').join(ROOT, '日志', 'ai_teach3.log'))
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env: { ...process.env, MC_USER: AI_NAME } })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
}

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

// 分步移动（可带高度变化，用来模拟按空格上升）
async function walkTo (player, x, y, z) {
  const dest = Vec3(x + 0.5, y, z + 0.5)
  const start = player.entity.position.clone()
  const dist = start.distanceTo(dest)
  const steps = Math.max(1, Math.ceil(dist / 1.0))
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
  const f = require('path').join(ROOT, '教学', n + '.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}

;(async () => {
  startAI()
  await sleep(5000)
  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })
  const aiChats = []
  player.on('chat', (u, m) => { if (u === AI_NAME) aiChats.push(m) })

  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(2500)
    for (let i = 0; i < 40; i++) {
      if (player.players[AI_NAME] && player.players[AI_NAME].entity) break
      await sleep(500)
    }
    const p0 = player.entity.position.floored()
    const gy = groundUnder(player, p0.x, p0.y, p0.z)
    console.log('[T] player', p0, 'ground', gy)

    // ================= 录制 A：沿 +x 走，并上升（模拟按空格） =================
    player.chat(cmd(AI_NAME, 'teach A'))
    await sleep(1500)
    await walkTo(player, p0.x + 6, gy + 1, p0.z)
    await walkTo(player, p0.x + 6, gy + 4, p0.z) // 上升 3 格 -> 应记成按住空格
    try { player.setControlState('sneak', true) } catch (e) { /* ignore */ }
    await sleep(700)
    try { player.setControlState('sneak', false) } catch (e) { /* ignore */ }
    await sleep(400)
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2200)

    const A = readTeach('A')
    const aEvents = A ? (A.events || []) : []
    const aMoves = aEvents.filter((e) => e.t === 'move')
    const aKeys = aEvents.filter((e) => e.t === 'key')
    const aJump = aKeys.filter((e) => e.key === 'jump')
    const aSneak = aKeys.filter((e) => e.key === 'sneak')
    console.log('[T] A: move=' + aMoves.length + ' key=' + aKeys.length + ' (jump=' + aJump.length + ', sneak=' + aSneak.length + ')')
    check('A 记录了移动', aMoves.length > 0)
    check('A 记录了空格(jump)按键', aJump.length > 0, 'jump=' + aJump.length)
    check('A 记录了 Shift(sneak)按键', aSneak.length > 0, 'sneak=' + aSneak.length)

    // ================= 紧接着录制 B：只沿 +z 走 =================
    // 关键：如果上一段的定时器没被清掉，B 里会混进 A 的 x 方向移动。
    player.chat(cmd(AI_NAME, 'teach B'))
    await sleep(1500)
    await walkTo(player, p0.x + 6, gy + 4, p0.z + 7)
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2200)

    const B = readTeach('B')
    const bEvents = B ? (B.events || []) : []
    const bMoves = bEvents.filter((e) => e.t === 'move')
    // B 只沿 z 移动：相对 B 原点，x 分量应始终接近 0
    const maxAbsX = bMoves.reduce((m, e) => Math.max(m, Math.abs(e.x)), 0)
    const maxAbsZ = bMoves.reduce((m, e) => Math.max(m, Math.abs(e.z)), 0)
    console.log('[T] B: move=' + bMoves.length + ' maxAbsX=' + maxAbsX.toFixed(2) + ' maxAbsZ=' + maxAbsZ.toFixed(2))
    check('B 记录了移动', bMoves.length > 0)
    // A 的 x 位移可达 6；若串连，B 的 maxAbsX 会明显偏大
    check('B 没有被 A 串连(x 分量应接近 0)', maxAbsX < 2.0, 'maxAbsX=' + maxAbsX.toFixed(2))
    check('B 的 z 位移被正确记录', maxAbsZ > 4, 'maxAbsZ=' + maxAbsZ.toFixed(2))
    // A 的文件在 B 录制后不应被改动
    const A2 = readTeach('A')
    check('A 的内容在录制 B 后保持不变', (A2.events || []).length === aEvents.length,
      'A=' + aEvents.length + ' -> ' + (A2.events || []).length)

    // ================= 录制 C：放一个活塞，复现后应一致 =================
    giveItem(player, 'piston')
    await sleep(400)
    player.chat(cmd(AI_NAME, 'teach C'))
    await sleep(1500)
    await walkTo(player, p0.x + 8, gy + 1, p0.z)
    const px = p0.x + 10, pz = p0.z
    const below = player.blockAt(new Vec3(px, gy, pz))
    let pistonFacing = null
    try {
      await player.placeBlock(below, new Vec3(0, 1, 0))
      const pb = player.blockAt(new Vec3(px, gy + 1, pz))
      pistonFacing = readFacing(player, pb)
      console.log('[T] 玩家放置的活塞 facing =', pistonFacing)
    } catch (e) { console.log('[T] 放置活塞失败', e && e.message) }
    await sleep(1200)
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2200)

    const C = readTeach('C')
    const cPlaces = C ? (C.events || []).filter((e) => e.t === 'place') : []
    check('C 记录了活塞放置', cPlaces.length > 0, 'place=' + cPlaces.length)

    // 复现 C
    await walkTo(player, p0.x - 16, gy + 1, p0.z - 16)
    await sleep(800)
    let originC = null
    aiChats.length = 0
    player.chat(cmd(AI_NAME, 'build C'))
    for (let i = 0; i < 200; i++) {
      if (aiChats.some((m) => /开始复现教学/.test(m))) {
        const a = player.players[AI_NAME]
        if (a && a.entity) originC = a.entity.position.floored()
        break
      }
      await sleep(500)
    }
    for (let i = 0; i < 200; i++) {
      if (aiChats.some((m) => /复现完成|建造完成|出错|已停止建造/.test(m))) break
      await sleep(1000)
    }
    console.log('[T] C 复现 AI 回复:', aiChats.join(' | '))

    if (originC && cPlaces.length) {
      const p = cPlaces[0]
      // 原点是从外部近似的（可能与 AI 内部取的差 1 格），在期望位置附近容错查找
      let found = null
      for (let dx = -3; dx <= 3 && !found; dx++)
        for (let dy = -2; dy <= 2 && !found; dy++)
          for (let dz = -3; dz <= 3 && !found; dz++) {
            const b = player.blockAt(new Vec3(originC.x + p.dx + dx, originC.y + p.dy + dy, originC.z + p.dz + dz))
            if (b && b.name === p.name) found = b
          }
      const f = found ? readFacing(player, found) : null
      console.log('[T] 复现结果: 期望 ' + p.name + '/' + p.facing + '，实际 ' +
        (found ? found.name + '/' + f + ' @' + found.position : '未找到'))
      check('复现结束后方块与录制一致', !!found, found ? found.name : 'not found')
      if (p.facing && found) check('复现结束后朝向与录制一致', f === p.facing, 'facing=' + f + ' want=' + p.facing)
    }

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('TEACH3 TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
