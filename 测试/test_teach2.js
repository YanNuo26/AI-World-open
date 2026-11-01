const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证教学复现的两个关键点：
//   1) 右键交互：玩家放下拉杆并右键打开 -> 复现后新拉杆也应处于 powered=true
//   2) 行走路线：AI 复现时的轨迹应贴近记录下来的路线点
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')
const { readStateValue } = require('../源码/build')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'TeachPlayer2'
const TEACH = 'teachuse1'

let aiProc
function startAI () {
  const log = fs.createWriteStream(require('path').join(ROOT, '日志', 'ai_teach2.log'))
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
    await sleep(60)
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

    player.chat(cmd(AI_NAME, 'tpto'))
    await sleep(4000)

    // ===== 录制 =====
    player.chat(cmd(AI_NAME, 'teach ' + TEACH))
    await sleep(1500)

    // 走一条折线（先沿 x，再沿 z），方便后面比对路线
    await walkTo(player, p0.x + 5, gy + 1, p0.z)
    await walkTo(player, p0.x + 10, gy + 1, p0.z)
    await walkTo(player, p0.x + 10, gy + 1, p0.z + 5)

    // 放一个拉杆
    giveItem(player, 'lever')
    await sleep(400)
    // 拉杆要放在玩家**旁边**（+2 格），放在自己脚下那一格会被自阻挡挡掉、射线也打偏
    const lx = p0.x + 12, lz = p0.z + 5
    // 地面高度别假设就是 gy：存档没重置时上一轮可能在这里留了方块，
    // 直接按 gy 取"脚下那块"可能取到空气 → 服务器拒绝放置（"the block is still air"），
    // 于是整个录制里没有右键事件，后面的断言全废（2026-11-01 就是这样连挂）。
    let groundY = gy
    for (let yy = gy + 3; yy > gy - 8; yy--) {
      const b = player.blockAt(new Vec3(lx, yy, lz))
      if (b && b.name !== 'air') { groundY = yy; break }
    }
    const below = player.blockAt(new Vec3(lx, groundY, lz))
    let leverPos = null
    // 让测试可重复运行：上一轮留下的拉杆先挖掉，否则会 "block is still lever"
    const existing = player.blockAt(new Vec3(lx, groundY + 1, lz))
    if (existing && existing.name !== 'air') {
      try { await player.dig(existing) } catch (e) { /* ignore */ }
      await sleep(600)
    }
    try {
      await player.placeBlock(below, new Vec3(0, 1, 0))
      leverPos = new Vec3(lx, groundY + 1, lz)
    } catch (e) { console.log('[T] 放置拉杆失败', e && e.message) }
    await sleep(1200) // 避开"放置挥臂"过滤窗口

    // 右键打开拉杆
    if (leverPos) {
      const lb = player.blockAt(leverPos)
      console.log('[T] 拉杆方块 =', lb && lb.name)
      try { await player.activateBlock(lb) } catch (e) { console.log('[T] 右键失败', e && e.message) }
      console.log('[T] 玩家点击时 yaw=', player.entity.yaw.toFixed(3), 'pitch=', player.entity.pitch.toFixed(3))
      await sleep(1200)
      const lb2 = player.blockAt(leverPos)
      console.log('[T] 右键后 powered =', readStateValue(player, lb2, 'powered'))
    }

    player.chat(cmd(AI_NAME, 'teach stop'))
    await sleep(2500)

    const file = require('path').join(ROOT, '教学', TEACH + '.json')
    let ev = []
    if (fs.existsSync(file)) ev = (JSON.parse(fs.readFileSync(file, 'utf8')).events) || []
    const uses = ev.filter((e) => e.t === 'use')
    const moves = ev.filter((e) => e.t === 'move')
    const places = ev.filter((e) => e.t === 'place')
    console.log('[T] events: move=' + moves.length + ' place=' + places.length + ' use=' + uses.length)
    check('记录了放置', places.length > 0)
    check('记录了右键交互(use)', uses.length > 0, 'use=' + uses.length)
    if (uses.length) {
      const u = uses[0]
      console.log('[T] use 事件目标 =', u.tx, u.ty, u.tz, '(期望相对坐标', leverPos.x - p0.x, leverPos.y - p0.y, leverPos.z - p0.z, ')')
      console.log('[T] use 记录的 yaw=', u.yaw, 'pitch=', u.pitch)
      check('use 事件记录了目标方块', u.tx != null)
    }

    // ===== 复现 =====
    await walkTo(player, p0.x - 14, gy + 1, p0.z - 14)
    await sleep(1000)

    // 采样 AI 轨迹
    const traj = []
    const iv = setInterval(() => {
      const a = player.players[AI_NAME]
      if (a && a.entity) traj.push(a.entity.position.clone())
    }, 300)

    aiChats.length = 0
    player.chat(cmd(AI_NAME, 'build ' + TEACH))

    // 注意：build 会先把 AI 送到玩家身边（goTo），**那之后**的位置才是复现原点。
    // 所以要等"开始复现教学"出现时再取 AI 位置，不能发指令前就取。
    let aiBefore = null
    for (let i = 0; i < 200; i++) {
      if (aiChats.some((m) => /开始复现教学/.test(m))) {
        const a = player.players[AI_NAME]
        if (a && a.entity) aiBefore = a.entity.position.floored()
        break
      }
      await sleep(500)
    }
    console.log('[T] 复现原点(AI 位置) =', aiBefore)

    for (let i = 0; i < 200; i++) {
      if (aiChats.some((m) => /复现完成|建造完成|出错|已停止建造/.test(m))) break
      await sleep(1000)
    }
    clearInterval(iv)
    console.log('[T] AI 回复:', aiChats.join(' | '))

    // 1) 路线比对：AI 轨迹应经过每个记录的路线点（平移到复现原点后）
    if (moves.length && traj.length) {
      let worst = 0
      for (const m of moves) {
        const wx = aiBefore.x + m.x + 0.5
        const wz = aiBefore.z + m.z + 0.5
        let best = Infinity
        for (const t of traj) best = Math.min(best, Math.hypot(t.x - wx, t.z - wz))
        worst = Math.max(worst, best)
      }
      console.log('[T] 路线点最大偏离 =', worst.toFixed(2), '(共', moves.length, '点)')
      check('复现路线经过记录的路线点', worst < 3.0, 'worst=' + worst.toFixed(2))
    }

    // 2) 右键：新位置上的拉杆应处于 powered=true
    let foundLever = null
    for (let dx = -25; dx <= 25 && !foundLever; dx++) {
      for (let dy = -2; dy <= 4 && !foundLever; dy++) {
        for (let dz = -25; dz <= 25 && !foundLever; dz++) {
          const b = player.blockAt(new Vec3(aiBefore.x + dx, aiBefore.y + dy, aiBefore.z + dz))
          if (b && b.name === 'lever') foundLever = b
        }
      }
    }
    if (foundLever) {
      const powered = readStateValue(player, foundLever, 'powered')
      console.log('[T] 复现出的拉杆 powered =', powered, '@', foundLever.position)
      // powered 是布尔型状态，按 Minecraft 的枚举顺序 **0 = true(打开)、1 = false(关闭)**
      check('复现后拉杆被右键打开(powered=0 即开)', powered === 0, 'powered=' + powered)
    } else {
      console.log('[T] 没找到复现出的拉杆')
      check('复现后拉杆被右键打开(powered=true)', false, 'lever not found')
    }

    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('TEACH REPLAY TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
