// 验证"右键会交互的方块"当依托时不会把交互误触掉（背景见 文档/AI参考.md 坑 32）：
//   场景 1：目标格唯一的邻居是音符盒（右键 = 弹奏，会吃掉放置）-> 必须按住 shift 放，
//           放完松开；音符盒状态一个字节都不能变。
//   场景 2：目标格同时挨着音符盒和普通石柱 -> 应该**换那一面**当依托（连 shift 都不用按）。
//   场景 3：红石粉贴音符盒顶面（非整块方块走 placeAttached 那条路）-> 同样不能碰到音符盒。
const { HOST, PORT, VERSION } = require('./_common')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')
const B = require('../源码/build')

const bot = mineflayer.createBot({
  host: HOST, port: PORT, username: 'InteractBot', version: VERSION
})

function groundUnder (x, y, z) {
  for (let yy = y; yy > y - 128; yy--) {
    const b = bot.blockAt(new Vec3(x, yy, z))
    if (b && b.name !== 'air') return yy
  }
  return y - 1
}

bot.on('spawn', async () => {
  let pass = true
  const ok = (cond, msg) => {
    console.log((cond ? '  PASS ' : '  FAIL ') + msg)
    if (!cond) pass = false
  }
  try {
    await bot.waitForTicks(30)
    const M = require('../源码/movement')
    const p = bot.entity.position.floored()
    await M.moveToSmooth(bot, p.x + 0.5, p.y, p.z + 0.5)
    // 等周边区块加载完：否则 blockAt 全是 air，目标格会被当成"悬空"走辅助支撑
    for (let i = 0; i < 40; i++) {
      const loaded = [-1, 0, 1].every((dx) => [-1, 0, 1].every((dz) => {
        const b = bot.blockAt(new Vec3(p.x + dx, p.y - 1, p.z + dz))
        return b && b.name !== 'air'
      }))
      if (loaded) break
      await bot.waitForTicks(10)
    }
    const gy = groundUnder(p.x, p.y, p.z)
    console.log('ground =', gy)

    // ---------- 0) 名单自检（不碰服务器，先把"哪些方块会被右键交互"锁死） ----------
    const yes = ['lever', 'repeater', 'comparator', 'note_block', 'stone_button', 'oak_door',
      'oak_trapdoor', 'oak_fence_gate', 'chest', 'hopper', 'daylight_detector', 'red_bed',
      'white_shulker_box', 'oak_sign', 'jukebox', 'water_cauldron', 'wheat']
    const no = ['stone', 'oak_planks', 'redstone_wire', 'piston', 'observer', 'glass',
      'smooth_stone', 'redstone_torch', 'rail']
    for (const n of yes) ok(B.isInteractiveBlock(bot, n) === true, `isInteractiveBlock(${n}) = true`)
    for (const n of no) ok(B.isInteractiveBlock(bot, n) === false, `isInteractiveBlock(${n}) = false`)

    const y0 = gy + 1 // 一律建在地面之上，避免和地形打架

    // ---------- 场景 1：唯一邻居 = 音符盒 -> 必须 shift 放置 ----------
    const x1 = p.x + 4, z1 = p.z
    await B.placeBlocks(bot, [
      { x: x1, y: y0, z: z1, name: 'stone' },
      { x: x1, y: y0 + 1, z: z1, name: 'stone' },
      { x: x1, y: y0 + 2, z: z1, name: 'stone' },
      { x: x1, y: y0 + 3, z: z1, name: 'note_block' }
    ], '场景1 搭建（音符盒塔）')
    const note1 = new Vec3(x1, y0 + 3, z1)
    const t1 = new Vec3(x1, y0 + 4, z1)
    ok(bot.blockAt(note1).name === 'note_block', '场景1 音符盒搭好了')
    const before1 = B.readBlockStates(bot, bot.blockAt(note1))
    ok(!!before1 && Object.keys(before1).length > 0, '场景1 读到了音符盒状态快照')
    await M.moveToSmooth(bot, x1 + 2.5, t1.y, z1 + 0.5)
    await B.equipBlock(bot, 'stone') // placeAt 不会自己换材质，必须手动拿
    const placed1 = await B.placeAt(bot, t1.x, t1.y, t1.z, null, 'stone', null)
    await bot.waitForTicks(3)
    const after1 = B.readBlockStates(bot, bot.blockAt(note1))
    ok(placed1 === true, '场景1 石头放置成功（依托只有音符盒）')
    ok(bot.blockAt(t1).name === 'stone', `场景1 目标格 = stone（实际 ${bot.blockAt(t1).name}）`)
    ok(B.statesEqual(before1, after1), '场景1 音符盒状态没被右键改掉')
    ok(bot.getControlState('sneak') === false, '场景1 放完已经松开 shift')

    // ---------- 场景 2：旁边还有普通方块 -> 换面，不该碰音符盒 ----------
    const x2 = p.x - 4, z2 = p.z
    const scene2 = [
      { x: x2, y: y0, z: z2, name: 'stone' },
      { x: x2, y: y0 + 1, z: z2, name: 'stone' },
      { x: x2, y: y0 + 2, z: z2, name: 'stone' },
      { x: x2, y: y0 + 3, z: z2, name: 'note_block' }
    ]
    for (let i = 0; i < 5; i++) scene2.push({ x: x2 + 1, y: y0 + i, z: z2, name: 'stone' })
    await B.placeBlocks(bot, scene2, '场景2 搭建（音符盒 + 旁边石柱）')
    const note2 = new Vec3(x2, y0 + 3, z2)
    const t2 = new Vec3(x2, y0 + 4, z2)
    ok(bot.blockAt(note2).name === 'note_block', '场景2 音符盒搭好了')
    ok(bot.blockAt(new Vec3(x2 + 1, t2.y, z2)).name === 'stone', '场景2 石柱搭好了')
    const before2 = B.readBlockStates(bot, bot.blockAt(note2))
    await M.moveToSmooth(bot, x2 + 2.5, t2.y, z2 + 2.5)
    await B.equipBlock(bot, 'stone')
    const placed2 = await B.placeAt(bot, t2.x, t2.y, t2.z, null, 'stone', null)
    await bot.waitForTicks(3)
    const after2 = B.readBlockStates(bot, bot.blockAt(note2))
    ok(placed2 === true, '场景2 石头放置成功')
    ok(bot.blockAt(t2).name === 'stone', `场景2 目标格 = stone（实际 ${bot.blockAt(t2).name}）`)
    ok(B.statesEqual(before2, after2), '场景2 音符盒状态没被右键改掉（换面生效）')

    // ---------- 场景 3：红石粉贴在音符盒顶面 ----------
    const x3 = p.x, z3 = p.z + 4
    await B.placeBlocks(bot, [
      { x: x3, y: y0, z: z3, name: 'stone' },
      { x: x3, y: y0 + 1, z: z3, name: 'stone' },
      { x: x3, y: y0 + 2, z: z3, name: 'stone' },
      { x: x3, y: y0 + 3, z: z3, name: 'note_block' }
    ], '场景3 搭建（音符盒上放红石粉）')
    const note3 = new Vec3(x3, y0 + 3, z3)
    const t3 = new Vec3(x3, y0 + 4, z3)
    ok(bot.blockAt(note3).name === 'note_block', '场景3 音符盒搭好了')
    const before3 = B.readBlockStates(bot, bot.blockAt(note3))
    await M.moveToSmooth(bot, x3 + 2.5, t3.y + 2, z3 + 0.5)
    await B.equipBlock(bot, 'redstone_wire')
    const placed3 = await B.placeAt(bot, t3.x, t3.y, t3.z, null, 'redstone_wire', 'floor')
    await bot.waitForTicks(3)
    const after3 = B.readBlockStates(bot, bot.blockAt(note3))
    ok(placed3 === true, '场景3 红石粉放置成功（依托是音符盒顶面）')
    const got3 = bot.blockAt(t3)
    ok(got3 && got3.name === 'redstone_wire', `场景3 目标格 = redstone_wire（实际 ${got3 && got3.name}）`)
    ok(B.statesEqual(before3, after3), '场景3 音符盒状态没被右键改掉')
    ok(bot.getControlState('sneak') === false, '场景3 放完已经松开 shift')

    const left = await B.cleanupAssists(bot)
    if (left) console.log('清理残留辅助方块', left)
    console.log(pass ? 'INTERACTIVE TEST PASS' : 'INTERACTIVE TEST FAIL')
  } catch (e) {
    console.error('TEST ERROR', e && e.stack)
    pass = false
    console.log('INTERACTIVE TEST FAIL')
  }
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(pass ? 0 : 1), 500)
})

bot.on('error', (e) => { console.error('BOT ERR', e && e.message); process.exit(1) })
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 300000)
