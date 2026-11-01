// ===== 移动模块（movement.js）=====
// 所有"去某个地方"的移动统一走这里，参数一律是 **xyz 三维坐标**。
// 不再直接改写 bot.entity.position 来做寻路式位移（那既不自然，也会被服务器拒包）。
//
// 分类索引（搜索【X】可直接跳到对应实现）：
//   【A】基础控制        创造飞行开关 / 松开所有移动按键
//   【B】水平移动（xz）  看向移动方向 + 按住 W 键（核心要求）
//   【C】垂直移动（y）   看向正上/正下 + 按住 W 键（修好"y 轴无法寻路"）
//   【D】统一入口        moveTo(x, y, z)：垂直对齐 → 水平飞行 → A* 兜底
//   【E】避障逻辑        卡住时执行：上飞 2 格 / 侧移 / 吃紫颂果
//   【F】A* 寻路兜底     xyz 三维 GoalNear + 看门狗
//   【G】精确落位        建造放置用的短距离微调（水平仍走 W，垂直小步校准）

const Vec3 = require('vec3')

// 【A】基础控制 =============================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout (p, ms) {
  let t
  const timer = new Promise((resolve) => {
    t = setTimeout(() => resolve('timeout'), ms)
    if (t.unref) t.unref()
  })
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}

// 确保处于创造飞行。
// !! 关键点（y 轴寻路的根因）!!
// mineflayer 的 bot.creative.startFlying() **只把本地 bot.physics.gravity 设成 0**，
// 完全不发包给服务器；服务器那边玩家仍然"没有在飞"，于是按 W 只能贴地走，
// 高度永远上不去 —— 这就是之前"AI 无法在 y 轴寻路"的真正原因。
// 必须显式给服务器发 abilities 包把 flying 打开：
//   flags 位: 1=无敌  2=flying(正在飞)  4=allowFlying(允许飞)  8=创造
// 创造模式下服务器已授予 allowFlying，所以客户端上报 flying 即可生效。
let _lastFlyPacket = 0
function ensureFlying (bot) {
  try {
    if (bot.creative && bot.creative.startFlying) bot.creative.startFlying() // 本地去重力
    const now = Date.now()
    // 落地/重生后飞行会被服务器关掉，所以按一定频率补发（不要每帧刷）
    if (bot._client && bot._client.write && now - _lastFlyPacket > 1500) {
      _lastFlyPacket = now
      bot._client.write('abilities', { flags: 0x02 | 0x04 }) // flying + allowFlying
    }
  } catch (e) { /* ignore */ }
}

// 【A-2】落地 ==============================================================
// 关闭"正在飞"（abilities 只保留 allowFlying），并恢复本地重力，让 bot 站到地上。
// 跟随玩家时一直悬在空中很碍事，靠近了就该落地。
let _lastLandPacket = 0
function stopFlying (bot) {
  try {
    if (bot.creative && bot.creative.stopFlying) bot.creative.stopFlying() // 恢复本地重力
    const now = Date.now()
    if (bot._client && bot._client.write && now - _lastLandPacket > 1500) {
      _lastLandPacket = now
      bot._client.write('abilities', { flags: 0x04 }) // 去掉 0x02(flying)，只留 allowFlying
    }
  } catch (e) { /* ignore */ }
}

// 往下找地面
function groundBelow (bot, x, y, z) {
  for (let yy = Math.floor(y); yy > y - 128; yy--) {
    const b = bot.blockAt(new Vec3(x, yy, z))
    if (b && b.name !== 'air') return yy
  }
  return null
}

// 主动降到地面上方一格并落地
async function landOnGround (bot, opts = {}) {
  const p = bot.entity.position
  const gy = groundBelow(bot, Math.floor(p.x), p.y, Math.floor(p.z))
  if (gy == null) return false
  const targetY = gy + 1
  if (Math.abs(p.y - targetY) < 0.8) { stopFlying(bot); return true }
  await moveVertical(bot, targetY, Object.assign({ quiet: true }, opts))
  stopFlying(bot)
  return true
}

// 松开所有移动按键，避免中止后 bot 还带着惯性继续漂移。
function releaseControls (bot) {
  for (const s of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
    try { bot.setControlState(s, false) } catch (e) { /* ignore */ }
  }
}

// 【E】避障逻辑（卡住时执行）=================================================
// "卡住" = 已经按住 W，但一段时间里位移没有变化。
// 处理分两级：
//   1 级（约 1s 没动）：松开 W，向上飞 2 格翻越矮障碍，再继续
//   2 级（连续约 10s 没动）：吃紫颂果随机传送，强行脱困
// 注意：A* 寻路阶段同样复用这套避障逻辑（见【F】）。

// 向上飞 n 格（自身就是一次"垂直移动"，走【C】）
async function nudgeUp (bot, n = 2) {
  try {
    bot.setControlState('forward', false)
    const p = bot.entity.position
    await moveVertical(bot, p.y + n, { timeoutMs: 8000, quiet: true })
  } catch (e) { /* ignore */ }
}

// 侧向挪一下，用来绕开正前方贴脸的障碍
async function sideStep (bot) {
  const p = bot.entity.position
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const d = dirs[Math.floor(Math.random() * dirs.length)]
  try {
    await bot.lookAt(new Vec3(p.x + d[0] * 2, p.y, p.z + d[1] * 2), true)
    bot.setControlState('forward', true)
    await sleep(250)
  } catch (e) { /* ignore */ } finally {
    bot.setControlState('forward', false)
  }
}

// 最后手段：发一个紫颂果到快捷栏并吃掉（创造模式允许满饱食度食用），随机传送脱困
async function eatChorusFruit (bot) {
  try {
    const mcData = require('minecraft-data')(bot.version)
    const item = mcData.itemsByName.chorus_fruit
    if (!item) { console.error('[AI] chorus_fruit not found in item registry'); return false }
    const PItem = require('prismarine-item')(bot.version)
    const stack = new PItem(item.id, 1, 0)
    bot._client.write('set_creative_slot', { slot: 36, item: PItem.toNotch(stack) })
    bot._setSlot(36, stack)
    if (typeof bot.setQuickBarSlot === 'function') bot.setQuickBarSlot(0)
    else bot.quickBarSlot = 0
    await bot.waitForTicks(2)
    await bot.consume()
    await bot.waitForTicks(10)
    return true
  } catch (e) {
    console.error('[AI] chorus fruit failed:', e && e.message)
    return false
  }
}

// 统一的避障入口：level 1 = 上飞 2 格，level >= 2 = 吃紫颂果
async function avoidObstacle (bot, level, where) {
  if (level >= 2) {
    console.log('[AI] 避障：' + where + ' 连续卡住 10s -> 吃紫颂果')
    await eatChorusFruit(bot)
    ensureFlying(bot)
  } else {
    console.log('[AI] 避障：' + where + ' 卡住 1s -> 上飞 2 格')
    await nudgeUp(bot, 2)
  }
}

// 【B】水平移动（xz）=========================================================
// 核心要求：水平移动时必须"看向移动方向"，并靠按住 W 键前进（像玩家一样飞），
// 而不是把坐标直接写过去。目标点取在**同一高度**，所以视线是水平的。
async function moveHorizontal (bot, destX, destZ, opts = {}) {
  const tol = opts.tolerance != null ? opts.tolerance : 0.6
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 20000
  ensureFlying(bot)

  const deadline = Date.now() + timeoutMs
  let last = bot.entity.position.clone()
  let stuckSince = Date.now()
  let hardSince = Date.now()

  try {
    while (Date.now() < deadline) {
      if (bot._aiAbort) return false
      const p = bot.entity.position
      const flat = Math.hypot(destX - p.x, destZ - p.z)
      if (flat <= tol) return true

      // 看向水平移动方向，再按住 W（同时按住疾跑，赶路能快不少）
      await bot.lookAt(new Vec3(destX, p.y, destZ), true)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      await sleep(100)

      const now = bot.entity.position
      if (now.distanceTo(last) > 0.12) { // 有进展，重置计时
        last = now.clone()
        stuckSince = Date.now()
        hardSince = Date.now()
        continue
      }
      bot.setControlState('forward', false)
      if (Date.now() - stuckSince >= 1000) {
        stuckSince = Date.now()
        await avoidObstacle(bot, 1, '水平移动')
        last = bot.entity.position.clone()
      }
      if (Date.now() - hardSince >= 10000) {
        hardSince = Date.now()
        await avoidObstacle(bot, 2, '水平移动')
        stuckSince = Date.now()
        last = bot.entity.position.clone()
      }
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
  }
  const p = bot.entity.position
  return Math.hypot(destX - p.x, destZ - p.z) <= tol
}

// 【C】垂直移动（y）==========================================================
// !! y 轴寻路的真相（实测，务必先看）!!
// 1) mineflayer 的 bot.creative.startFlying() 只把**本地** physics.gravity 设成 0，
//    完全不通知服务器 —— 服务器依旧认为玩家没在飞；
// 2) 试过给服务器发 abilities 包（flags: 2=flying / 4=allowFlying）打开飞行，
//    **无效**：按住 jump 仍然只上升 1.25 格（一次普通跳跃），无法持续爬升；
// 3) 唯一可靠的上下移动方式是**逐帧小步改写坐标**：服务器接受小增量位移，
//    之前 teleportTo 上升 90+ 格、以及高层建造，全都是靠它。
// 所以 y 轴采用小步推进，并配上看门狗 + 避障逻辑。
async function moveVertical (bot, destY, opts = {}) {
  const tol = opts.tolerance != null ? opts.tolerance : 0.4
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 20000
  const quiet = !!opts.quiet
  ensureFlying(bot)

  const startY = bot.entity.position.y
  const diff = destY - startY
  if (Math.abs(diff) <= tol) return true

  const dir = Math.sign(diff)
  const dist = Math.abs(diff)
  const steps = Math.max(1, Math.ceil(dist / 0.5))
  const deadline = Date.now() + timeoutMs
  let lastY = startY
  let stuckSince = Date.now()
  let hardSince = Date.now()

  try {
    for (let i = 1; i <= steps; i++) {
      if (bot._aiAbort) return false
      if (Date.now() > deadline) break
      const p = bot.entity.position
      bot.entity.position = new Vec3(p.x, startY + dir * Math.min(i * 0.5, dist), p.z)
      await bot.waitForTicks(1)

      const nowY = bot.entity.position.y
      if (Math.abs(nowY - lastY) > 0.05) { // 有进展
        lastY = nowY
        stuckSince = Date.now()
        hardSince = Date.now()
        continue
      }
      if (Date.now() - stuckSince >= 1500) {
        stuckSince = Date.now()
        if (!quiet) console.log('[AI] 避障：垂直移动卡住 -> 侧移后重试')
        await sideStep(bot)
        lastY = bot.entity.position.y
      }
      if (Date.now() - hardSince >= 10000) {
        hardSince = Date.now()
        await avoidObstacle(bot, 2, '垂直移动')
        stuckSince = Date.now()
        lastY = bot.entity.position.y
      }
    }
  } catch (e) { /* ignore */ }
  return Math.abs(bot.entity.position.y - destY) <= Math.max(tol, 1.0)
}

// 【F】A* 寻路兜底（xyz 三维）===============================================
// 直线飞不过去时才启用。用真正的三维 GoalNear（含 y），
// 并复用【E】的避障逻辑做看门狗。
async function pathfindXYZ (bot, x, y, z, opts = {}) {
  const timeoutMs = opts.pathfindTimeoutMs != null ? opts.pathfindTimeoutMs : 120000
  if (!bot.pathfinder || !bot.pathfinder.setMovements) {
    console.error('[AI] A* 不可用：未加载 mineflayer-pathfinder 插件')
    return false
  }
  const pf = require('mineflayer-pathfinder')
  const movements = new pf.Movements(bot)
  movements.allowFreeMotion = true // 创造飞行（本版本没有 canFly，见 AI参考 坑 1）
  movements.canDig = false         // 绝不挖方块
  bot.pathfinder.setMovements(movements)
  ensureFlying(bot)

  const target = new Vec3(x, y, z)
  const goal = new pf.goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), 1)
  bot.pathfinder.setGoal(goal, true)

  const deadline = Date.now() + timeoutMs
  let last = bot.entity.position.clone()
  let stuckSince = Date.now()
  let hardSince = Date.now()

  try {
    while (bot.entity.position.distanceTo(target) > 1.5 && Date.now() < deadline) {
      if (bot._aiAbort) return false
      await sleep(250)
      const p = bot.entity.position
      if (p.distanceTo(last) > 0.2) {
        last = p.clone()
        stuckSince = Date.now()
        hardSince = Date.now()
        continue
      }
      if (Date.now() - stuckSince >= 1000) {
        stuckSince = Date.now()
        bot.pathfinder.setGoal(null)
        await avoidObstacle(bot, 1, 'A* 寻路')
        bot.pathfinder.setGoal(goal, true)
        last = bot.entity.position.clone()
      }
      if (Date.now() - hardSince >= 10000) {
        hardSince = Date.now()
        await avoidObstacle(bot, 2, 'A* 寻路')
        bot.pathfinder.setGoal(goal, true)
        stuckSince = Date.now()
        last = bot.entity.position.clone()
      }
    }
  } finally {
    bot.pathfinder.setGoal(null)
  }
  return bot.entity.position.distanceTo(target) <= 2.5
}

// 【D-3】超远距离直接传送 ====================================================
// 按小步推进把坐标挪过去（服务器只接受小增量，一次大跳会被弹回，见 AI参考 坑 11）。
// 用于距离过远的赶路：几十秒的飞行压缩到几秒。
const FAR_TELEPORT = 100
async function teleportXYZ (bot, x, y, z) {
  ensureFlying(bot)
  const dest = new Vec3(x, y, z)
  const start = bot.entity.position.clone()
  const dist = start.distanceTo(dest)
  if (dist < 0.05) return true
  const steps = Math.max(1, Math.ceil(dist / 1.0))
  for (let i = 1; i <= steps; i++) {
    if (bot._aiAbort) return false
    bot.entity.position = start.plus(dest.minus(start).scaled(i / steps))
    await bot.waitForTicks(1)
  }
  bot.entity.position = dest
  await bot.waitForTicks(2) // 让服务器收到最终坐标
  return true
}

// 【D】统一入口：moveTo(x, y, z) ============================================
// 所有导航都调用它，参数是完整的 xyz。
//   1) 先做 y 轴对齐（垂直移动）
//   2) 再做 xz 水平飞行（看方向 + W）
//   3) 直线走不通 → A* 兜底
async function moveTo (bot, x, y, z, opts = {}) {
  ensureFlying(bot)
  // 超过 100 格就不再一步步飞了，直接传送，否则远距离赶路慢得没法用
  const far = bot.entity.position.distanceTo(new Vec3(x, y, z))
  if (far > FAR_TELEPORT && !opts.noTeleport) {
    console.log('[AI] 距离 ' + far.toFixed(0) + ' 格 > ' + FAR_TELEPORT + ' -> 直接传送')
    return await teleportXYZ(bot, x, y, z)
  }
  // 先水平（W 键飞/走过去），再垂直（小步推进）——垂直放最后，
  // 结束后 bot 正好停在目标高度，方便紧接着开始建造。
  const hOk = await moveHorizontal(bot, x, z, opts)
  const yOk = await moveVertical(bot, y, opts)
  if (yOk && hOk) return true
  console.log('[AI] 直线受阻 -> A* 寻路兜底 (' + x + ',' + y + ',' + z + ')')
  return await pathfindXYZ(bot, x, y, z, opts)
}

// 【D-2】平滑行进：按"路径"走（复现教学路线用）==============================
// 普通的 moveTo 是"先把水平全部走完，再统一调高度"，轨迹是个 L 形，
// 和玩家原本边走边升/降的路线对不上。
// 这里改成**分段同步推进**：每段水平最多前进 segLen 格（仍然是看方向 + W 键），
// 同时按相同比例把高度推进到对应值，于是整体轨迹更贴近原来的三维路线。
async function moveToSmooth (bot, x, y, z, opts = {}) {
  ensureFlying(bot)
  const start = bot.entity.position.clone()
  const dest = new Vec3(x, y, z)
  const flatTotal = Math.hypot(dest.x - start.x, dest.z - start.z)
  const segLen = opts.segLen != null ? opts.segLen : 1.5
  const segs = Math.max(1, Math.ceil(flatTotal / segLen))
  for (let i = 1; i <= segs; i++) {
    if (bot._aiAbort) return false
    const f = i / segs
    const sx = start.x + (dest.x - start.x) * f
    const sz = start.z + (dest.z - start.z) * f
    const sy = start.y + (dest.y - start.y) * f
    await moveHorizontal(bot, sx, sz, { tolerance: 0.5, timeoutMs: 8000 })
    if (bot._aiAbort) return false
    await moveVertical(bot, sy, { tolerance: 0.3, timeoutMs: 8000, quiet: true })
  }
  const p = bot.entity.position
  return p.distanceTo(dest) <= 1.5
}

// 【G】精确落位（建造放置用）=================================================
// 建造过程中把 bot 挪到某个"站位"。
// 这里刻意**不走 W 键物理飞行**，原因：放置方向性方块时，站位往往在建筑的
// 另一侧（比如墙的外侧/内侧），而挡在中间的那堵墙正是 bot 自己刚砌好的 ——
// 物理飞行会一头撞上去卡住，接着触发避障逻辑、每块都跑满超时
// （实测整栋 5×5 活塞房直接 180s 超时失败）。
// 所以站位用逐帧小步长落位（碰撞无关），并且先转向目标方向保持"看着要去的地方"。
// 真正的"赶路"（goTo / tpto / 跟随）一律走【D】moveTo 的 W 键飞行。
async function fineTuneY (bot, destY) {
  const start = bot.entity.position.y
  const dist = Math.abs(destY - start)
  if (dist < 0.05) return
  const steps = Math.max(1, Math.ceil(dist / 0.5))
  for (let i = 1; i <= steps; i++) {
    if (bot._aiAbort) throw new Error('AI_ABORT')
    const p = bot.entity.position
    bot.entity.position = new Vec3(p.x, start + (destY - start) * (i / steps), p.z)
    await bot.waitForTicks(1)
  }
  await bot.waitForTicks(1)
}

async function navigateTo (bot, pos, opts = {}) {
  try {
    ensureFlying(bot)
    const dest = new Vec3(pos.x, pos.y, pos.z)
    // 逐帧小步落位（穿墙/贴着建筑调整站位时不会被碰撞卡住）
    // 注：这里不额外 await lookAt —— 每次落位都等一次转向包会明显拖慢建造，
    //     真正的"看方向"由【D】moveTo 的 W 键飞行负责。
    const start = bot.entity.position.clone()
    const dist = start.distanceTo(dest)
    if (dist > 0.05) {
      const steps = Math.max(1, Math.ceil(dist / 0.5))
      for (let i = 1; i <= steps; i++) {
        if (bot._aiAbort) throw new Error('AI_ABORT')
        bot.entity.position = start.plus(dest.minus(start).scaled(i / steps))
        await bot.waitForTicks(1)
      }
      bot.entity.position = dest
      await bot.waitForTicks(2) // let the server receive the final position
    }
    return true
  } catch (e) {
    if (e && e.message === 'AI_ABORT') throw e
    console.error('[AI] navigateTo failed:', e && e.message)
    return false
  }
}

module.exports = {
  // 【A】
  ensureFlying, releaseControls, sleep, withTimeout, stopFlying, landOnGround,
  // 【B】【C】
  moveHorizontal, moveVertical,
  // 【D】
  moveTo, moveToSmooth, teleportXYZ, FAR_TELEPORT,
  // 【E】
  avoidObstacle, nudgeUp, sideStep, eatChorusFruit,
  // 【F】
  pathfindXYZ,
  // 【G】
  navigateTo, fineTuneY
}
