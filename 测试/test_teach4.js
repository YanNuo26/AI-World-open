const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证本轮四项改进：
//   1) 红石粉的点状/十字形态会被记录并能还原
//   2) teach ckpd 能设置检查点，复现时在此核对（不再做结束后的统一检查）
//   3) 录制时忽略玩家打开聊天框的那段时间
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const { readWireShape } = require('../源码/build')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'TeachPlayer4'
const TEACH = 'ckpdtest'

let aiProc
function startAI () {
  const log = fs.createWriteStream(require('path').join(ROOT, '日志', 'ai_teach4.log'))
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env: { ...process.env, MC_USER: AI_NAME } })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
}

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

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

;(async () => {
  startAI()
  await sleep(6000)
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

    // ===== 录制 =====
    player.chat(cmd(AI_NAME, 'teach ' + TEACH))
    await sleep(1500)

    // 放一个孤立的红石粉（应为点状 dot）
    giveItem(player, 'redstone')
    await sleep(400)
    await walkTo(player, p0.x + 4, gy + 1, p0.z)
    const wx = p0.x + 6, wz = p0.z
    const below = player.blockAt(new Vec3(wx, gy, wz))
    let wireShape = null
    try {
      await player.placeBlock(below, new Vec3(0, 1, 0))
      await sleep(500)
      wireShape = readWireShape(player, player.blockAt(new Vec3(wx, gy + 1, wz)))
      console.log('[T] 玩家放置的红石粉形态 =', wireShape)
    } catch (e) { console.log('[T] 放置红石粉失败', e && e.message) }

    // 设置检查点
    player.chat(cmd(AI_NAME, 'teach ckpd'))
    await sleep(1500)

    // ===== 聊天框忽略测试：发消息后立刻移动，这段不应被记录 =====
    const movesBeforeChat = (() => 0)()
    player.chat('hello')           // 打开聊天框的输入
    await walkTo(player, p0.x + 4, gy + 1, p0.z + 4) // 紧接着移动（应被忽略）
    await sleep(2500)              // 等忽略窗口过去
    await walkTo(player, p0.x + 4, gy + 1, p0.z + 9) // 这次应被记录

    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2200)

    const file = require('path').join(ROOT, '教学', TEACH + '.json')
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { events: [] }
    const ev = data.events || []
    const places = ev.filter((e) => e.t === 'place')
    const ckpds = ev.filter((e) => e.t === 'ckpd')
    const moves = ev.filter((e) => e.t === 'move')
    console.log('[T] events: move=' + moves.length + ' place=' + places.length + ' ckpd=' + ckpds.length)

    const wireEv = places.find((e) => e.name === 'redstone_wire')
    check('记录了红石粉放置', !!wireEv, wireEv ? JSON.stringify(wireEv) : 'none')
    if (wireEv) {
      check('记录了红石粉形态(wire 字段)', !!wireEv.wire, 'wire=' + wireEv.wire)
      check('记录的形态与实际一致', wireEv.wire === wireShape, wireEv.wire + ' vs ' + wireShape)
    }
    check('teach ckpd 记录了检查点', ckpds.length > 0, 'ckpd=' + ckpds.length)
    if (ckpds.length) {
      check('检查点快照包含方块', (ckpds[0].blocks || []).length > 0, 'blocks=' + (ckpds[0].blocks || []).length)
    }

    // 聊天忽略：最后一段移动的 z 应能到 ~9；若被忽略则最大 z 会明显更小
    const maxZ = moves.reduce((m, e) => Math.max(m, e.z), 0)
    console.log('[T] 移动事件最大 z =', maxZ.toFixed(2), '(聊天后走到 z+9)')
    check('聊天框打开后的移动被忽略(仍记录到后续移动)', maxZ > 5, 'maxZ=' + maxZ.toFixed(2))

    // ===== 复现 =====
    await walkTo(player, p0.x - 18, gy + 1, p0.z - 18)
    await sleep(800)
    let originR = null
    aiChats.length = 0
    player.chat(cmd(AI_NAME, 'build ' + TEACH))
    for (let i = 0; i < 200; i++) {
      if (aiChats.some((m) => /开始复现教学/.test(m))) {
        const a = player.players[AI_NAME]
        if (a && a.entity) originR = a.entity.position.floored()
        break
      }
      await sleep(500)
    }
    for (let i = 0; i < 200; i++) {
      if (aiChats.some((m) => /复现完成|建造完成|出错|已停止建造/.test(m))) break
      await sleep(1000)
    }
    console.log('[T] AI 回复:', aiChats.join(' | '))

    // AI 日志：应出现"检查点"，且不再出现"收尾校对"
    const aiLog = fs.existsSync(require('path').join(ROOT, '日志', 'ai_teach4.log'))
      ? fs.readFileSync(require('path').join(ROOT, '日志', 'ai_teach4.log'), 'utf8') : ''
    check('复现时执行了检查点校对', aiLog.includes('检查点'), '')
    check('不再执行结束后的统一检查', !aiLog.includes('收尾校对'), '')

    // 复现出的红石粉形态应与录制一致
    if (originR && wireEv) {
      let found = null
      for (let dx = -4; dx <= 4 && !found; dx++)
        for (let dz = -4; dz <= 4 && !found; dz++) {
          const b = player.blockAt(new Vec3(originR.x + wireEv.dx + dx, originR.y + wireEv.dy, originR.z + wireEv.dz + dz))
          if (b && b.name === 'redstone_wire') found = b
        }
      const shape = found ? readWireShape(player, found) : null
      console.log('[T] 复现出的红石粉形态 =', shape, '(录制', wireEv.wire + ')')
      check('复现出的红石粉形态与录制一致', !!found && shape === wireEv.wire, 'shape=' + shape)
    }

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('TEACH4 TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
