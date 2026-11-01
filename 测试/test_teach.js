const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证教学模式：
//   1) teach <名字> 开始记录玩家的移动 + 放置方块
//   2) teach stop 保存成文件（events 里同时有 move 和 place）
//   3) build <名字> 按记录的**顺序**复现（AI 重新走出路径并放回方块）
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'TeachPlayer'
const TEACH = 'teachtest1'

let aiProc
function startAI () {
  const log = fs.createWriteStream(require('path').join(ROOT, '日志', 'ai_teach.log'))
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env: { ...process.env, MC_USER: AI_NAME } })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
}

const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

// 让"玩家"分步移动到某处（服务器接受小增量位移）
async function walkTo (player, x, y, z) {
  const dest = Vec3(x + 0.5, y, z + 0.5)
  const start = player.entity.position.clone()
  const dist = start.distanceTo(dest)
  const steps = Math.max(1, Math.ceil(dist / 1.0))
  for (let i = 1; i <= steps; i++) {
    player.entity.position = start.plus(dest.minus(start).scaled(i / steps))
    await sleep(60)
  }
  await sleep(600)
}

function groundUnder (b, x, y, z) {
  for (let yy = y; yy > y - 128; yy--) {
    const blk = b.blockAt(new Vec3(x, yy, z))
    if (blk && blk.name !== 'air') return yy
  }
  return y - 1
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
    // 等 AI 上线
    for (let i = 0; i < 40; i++) {
      if (player.players[AI_NAME] && player.players[AI_NAME].entity) break
      await sleep(500)
    }

    const p0 = player.entity.position.floored()
    const gy = groundUnder(player, p0.x, p0.y, p0.z)
    console.log('[T] player at', p0, 'ground', gy)

    // 让 AI 先靠近，保证它能观察到玩家的方块变化
    player.chat(cmd(AI_NAME, 'tpto'))
    await sleep(4000)

    // ===== 开始教学 =====
    player.chat(cmd(AI_NAME, 'teach ' + TEACH))
    await sleep(1500)
    check('teach 开始有回应', aiChats.some((m) => /教学模式开始/.test(m)), aiChats.slice(-1)[0])

    // 玩家移动
    await walkTo(player, p0.x + 6, gy + 1, p0.z)
    await walkTo(player, p0.x + 6, gy + 1, p0.z + 5)

    // 玩家手里得先有方块（创造模式默认空手，placeBlock 会失败）
    const mcData = require('minecraft-data')(player.version || VERSION)
    const PItem = require('prismarine-item')(player.version || VERSION)
    const stack = new PItem(mcData.itemsByName.stone.id, 1, 0)
    player._client.write('set_creative_slot', { slot: 36, item: PItem.toNotch(stack) })
    player._setSlot(36, stack)
    if (typeof player.setQuickBarSlot === 'function') player.setQuickBarSlot(0)
    await sleep(500)

    // 玩家放置 3 个方块（放在地面上）
    // 注意：要放在自己身体**旁边**，放在脚下那一格会因为自阻挡被服务器拒绝
    const spots = [[p0.x + 8, p0.z + 5], [p0.x + 8, p0.z + 6], [p0.x + 8, p0.z + 7]]
    let placedCount = 0
    for (const [bx, bz] of spots) {
      const below = player.blockAt(new Vec3(bx, gy, bz))
      if (!below || below.name === 'air') continue
      try {
        await player.placeBlock(below, new Vec3(0, 1, 0))
        placedCount++
      } catch (e) { console.log('[T] place err at', bx, bz, e && e.message) }
      await sleep(800)
    }
    console.log('[T] 玩家放置方块数 =', placedCount)

    // ===== 结束教学 =====
    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2500)

    const file = require('path').join(ROOT, '教学', TEACH + '.json')
    const exists = fs.existsSync(file)
    check('教学文件已保存', exists, file)
    let ev = []
    if (exists) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      ev = data.events || []
      const mv = ev.filter((e) => e.t === 'move').length
      const pl = ev.filter((e) => e.t === 'place').length
      console.log('[T] events: 共', ev.length, '个 (move=' + mv + ', place=' + pl + ')')
      check('记录了移动', mv > 0, 'move=' + mv)
      check('记录了放置', pl > 0, 'place=' + pl)
    }

    // ===== 复现 =====
    // 把玩家挪到一块空地，让 AI 在新的位置复现
    await walkTo(player, p0.x - 12, gy + 1, p0.z - 12)
    aiChats.length = 0
    player.chat(cmd(AI_NAME, 'build ' + TEACH))
    // 等待复现完成
    let done = false
    for (let i = 0; i < 120; i++) {
      // 注意：不能只匹配 /复现/，"开始复现教学"也会命中，要在真正完成后再检查
      if (aiChats.some((m) => /复现完成|建造完成|出错|已停止建造/.test(m))) { done = true; break }
      await sleep(1000)
    }
    console.log('[T] AI 回复:', aiChats.join(' | '))
    check('复现流程有回应', done)

    // 校验：AI 应该把方块放在"玩家新位置 + 相对偏移"处
    const ai = player.players[AI_NAME]
    if (ai && ai.entity && ev.length) {
      const ap = ai.entity.position.floored()
      const placeEv = ev.find((e) => e.t === 'place')
      if (placeEv) {
        // 复现原点 = 当时 AI 所在位置，这里只验证"新原点附近确实出现了该方块"
        let found = false
        for (let dx = -20; dx <= 20 && !found; dx++) {
          for (let dz = -20; dz <= 20 && !found; dz++) {
            const b = player.blockAt(new Vec3(ap.x + dx, gy + 1 + placeEv.dy, ap.z + dz))
            if (b && b.name === placeEv.name) found = true
          }
        }
        check('复现后能找到记录里的方块类型(' + placeEv.name + ')', found)
      }
    }

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('TEACH TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
