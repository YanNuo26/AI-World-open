const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证：
//   1) 教学默认**没有**检查点（只有显式 teach ckpd 才会产生）
//   2) 设置检查点时，方块的各项属性（name / facing / face / wire）记录正确
//   3) 检查点之后的方块不会混进该检查点的快照
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const { readFacing, readFace, readWireShape } = require('../源码/build')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'TeachPlayer5'
const T1 = 'nock1'
const T2 = 'withck1'

let aiProc
function startAI () {
  const log = fs.createWriteStream(require('path').join(ROOT, '日志', 'ai_teach5.log'))
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
const readTeach = (n) => {
  const f = require('path').join(ROOT, '教学', n + '.json')
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
}

;(async () => {
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
    console.log('[T] player', p0, 'ground', gy)

    // ===== 1) 不设检查点的录制 =====
    player.chat(cmd(AI_NAME, 'teach ' + T1))
    await sleep(1500)
    await walkTo(player, p0.x + 5, gy + 1, p0.z)
    giveItem(player, 'piston')
    await sleep(400)
    try {
      const below = player.blockAt(new Vec3(p0.x + 7, gy, p0.z))
      await player.placeBlock(below, new Vec3(0, 1, 0))
    } catch (e) { console.log('[T] place err', e && e.message) }
    await sleep(1200)
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2200)

    const d1 = readTeach(T1)
    const e1 = d1 ? (d1.events || []) : []
    const ck1 = e1.filter((e) => e.t === 'ckpd')
    console.log('[T] T1: events=' + e1.length + ' ckpd=' + ck1.length + ' place=' + e1.filter((e) => e.t === 'place').length)
    check('默认录制没有检查点', ck1.length === 0, 'ckpd=' + ck1.length)
    check('默认录制仍能记录放置', e1.filter((e) => e.t === 'place').length > 0)

    // ===== 2) 设置检查点的录制 =====
    player.chat(cmd(AI_NAME, 'teach ' + T2))
    await sleep(1500)
    await walkTo(player, p0.x + 5, gy + 1, p0.z + 6)

    // 第一个方块：活塞
    const b1x = p0.x + 7, b1z = p0.z + 6
    giveItem(player, 'piston')
    await sleep(400)
    let real1 = null
    try {
      const below = player.blockAt(new Vec3(b1x, gy, b1z))
      await player.placeBlock(below, new Vec3(0, 1, 0))
      await sleep(500)
      const b = player.blockAt(new Vec3(b1x, gy + 1, b1z))
      real1 = { name: b.name, facing: readFacing(player, b), face: readFace(player, b), wire: readWireShape(player, b) }
      console.log('[T] 实际方块1 =', JSON.stringify(real1))
    } catch (e) { console.log('[T] place1 err', e && e.message) }
    await sleep(1200)

    // 设置检查点（此刻快照里只应有方块1）
    player.chat(cmd(AI_NAME, 'teach ckpd'))
    await sleep(1500)

    // 检查点之后再放一个方块（不该出现在上面那个检查点的快照里）
    const b2x = p0.x + 7, b2z = p0.z + 8
    giveItem(player, 'lever')
    await sleep(400)
    let real2 = null
    try {
      const below = player.blockAt(new Vec3(b2x, gy, b2z))
      await player.placeBlock(below, new Vec3(0, 1, 0))
      await sleep(500)
      const b = player.blockAt(new Vec3(b2x, gy + 1, b2z))
      real2 = { name: b.name, facing: readFacing(player, b), face: readFace(player, b), wire: readWireShape(player, b) }
      console.log('[T] 实际方块2(检查点后) =', JSON.stringify(real2))
    } catch (e) { console.log('[T] place2 err', e && e.message) }
    await sleep(1200)
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2200)

    const d2 = readTeach(T2)
    const e2 = d2 ? (d2.events || []) : []
    const cks = e2.filter((e) => e.t === 'ckpd')
    console.log('[T] T2: events=' + e2.length + ' ckpd=' + cks.length)
    check('设置了 1 个检查点', cks.length === 1, 'ckpd=' + cks.length)

    if (cks.length && real1) {
      const snap = cks[0].blocks || []
      console.log('[T] 检查点快照 =', JSON.stringify(snap))
      check('快照包含检查点前放的方块', snap.length === 1, 'blocks=' + snap.length)
      const s = snap[0]
      check('快照 name 正确', s.name === real1.name, s.name + ' vs ' + real1.name)
      check('快照 facing 正确', s.facing === real1.facing, s.facing + ' vs ' + real1.facing)
      check('快照 face 正确', (s.face || null) === (real1.face || null), s.face + ' vs ' + real1.face)
      check('快照含 wire 字段(可为 null)', 'wire' in s, 'wire=' + s.wire)
      const hasLater = snap.some((q) => q.dz === real2 && false)
      const b2InSnap = snap.some((q) => q.dx === b2x - p0.x && q.dz === b2z - p0.z)
      check('检查点之后的方块不在快照里', !b2InSnap, 'b2InSnap=' + b2InSnap)
    }

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('TEACH5 TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
