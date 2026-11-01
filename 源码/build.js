const Vec3 = require('vec3')
const fs = require('fs')
const path = require('path')
// 移动统一走 movement.js 的 xyz 接口（水平看方向+W / y 轴 / 避障 / A*）
const M = require('./movement')

const BLUEPRINT_DIR = path.join(__dirname, '..', '蓝图')

// Put the given block into the bot's hand (infinite in creative mode).
// We bypass bot.creative.setInventorySlot on purpose: its internal "pending slot"
// guard can get stuck when the server's inventory-ack packet is dropped by a
// protocol parse error (PartialReadError), which would make every material switch
// throw "Setting slot ... cancelled". Writing the packet directly avoids that.
// 方块名 -> 手持物品名。Minecraft 里两者**并不总是一致**，直接拿方块名去查物品会
// "Unknown block"（红石粉方块叫 redstone_wire，但物品叫 redstone；墙上红石火把
// 方块叫 redstone_wall_torch，物品叫 redstone_torch）。
const BLOCK_TO_ITEM = {
  redstone_wire: 'redstone',
  redstone_wall_torch: 'redstone_torch',
  redstone_torch: 'redstone_torch',
  wall_torch: 'torch',
  torch: 'torch',
  soul_torch: 'soul_torch',
  soul_wall_torch: 'soul_torch',
  cocoa: 'cocoa_beans',
  wheat: 'wheat_seeds',
  sweet_berry_bush: 'sweet_berries',
  nether_wart: 'nether_wart',
  water: 'water_bucket',
  lava: 'lava_bucket',
  powdered_snow: 'powder_snow_bucket',
  farmland: 'farmland',
  grass: 'grass'
}
function itemNameFor (mcData, blockName) {
  if (BLOCK_TO_ITEM[blockName]) return BLOCK_TO_ITEM[blockName]
  if (mcData.itemsByName[blockName]) return blockName
  const alt = blockName.replace(/_wall_/, '_') // oak_wall_sign -> oak_sign 之类
  if (mcData.itemsByName[alt]) return alt
  return blockName
}

let _lastEquipped = null
function equipBlock (bot, name) {
if (name === _lastEquipped) return Promise.resolve()
const mcData = require('minecraft-data')(bot.version)
const item = mcData.itemsByName[itemNameFor(mcData, name)]
if (!item) return Promise.reject(new Error('Unknown block: ' + name))
const PItem = require('prismarine-item')(bot.version)
const stack = new PItem(item.id, 1, 0)
bot._client.write('set_creative_slot', { slot: 36, item: PItem.toNotch(stack) })
bot._setSlot(36, stack) // update local inventory so bot.heldItem is correct
if (typeof bot.setQuickBarSlot === 'function') bot.setQuickBarSlot(0)
else bot.quickBarSlot = 0
_lastEquipped = name
return Promise.resolve()
}

// ===== Directional blocks (piston / observer / dispenser / stairs / ...) =====
// Minecraft derives a directional block's facing from where the PLAYER IS
// LOOKING at the moment of placement - but mineflayer's placeBlock() forces a
// lookAt() at the clicked face. Our bot hovers above the target, so that look is
// straight down and pistons came out facing up/down. Fix: set the look ourselves
// and pass forceLook:'ignore' so mineflayer does not overwrite it.
// Measured on 1.21.1: looking up -> facing up, looking down -> facing down.
const FACING_PITCH = { up: -90, down: 90 }

const _facingCache = {}
function hasFacing (bot, name) {
  if (_facingCache[name] !== undefined) return _facingCache[name]
  let res = false
  try {
    const mcData = require('minecraft-data')(bot.version)
    const b = mcData.blocksByName[name]
    res = !!(b && b.states && b.states.some((s) => s.name === 'facing'))
  } catch (e) { res = false }
  _facingCache[name] = res
  return res
}

// Read back a block-state property (e.g. 'facing' / 'face') by decoding its state id.
// State ids enumerate with the first property most significant (and booleans
// ordered true,false) - validated by the up/down anchors.
function readStateValue (bot, block, prop) {
  try {
    if (!block || block.stateId == null) return null
    const mcData = require('minecraft-data')(bot.version)
    const b = mcData.blocksByName[block.name]
    if (!b || !b.states || !b.states.length) return null
    const idx = b.states.findIndex((s) => s.name === prop)
    if (idx < 0) return null
    const counts = b.states.map((s) => (s.type === 'enum' ? s.values.length : s.num_values))
    let total = counts.reduce((a, c) => a * c, 1)
    let rest = block.stateId - b.minStateId
    let value = 0
    for (let i = 0; i < counts.length; i++) {
      total = Math.floor(total / counts[i])
      const v = Math.floor(rest / total)
      rest = rest % total
      if (i === idx) value = v
    }
    const st = b.states[idx]
    // 枚举返回字符串；int / bool 返回数值（例如 lever 的 powered 是 int2 -> 0/1），
    // 早期版本对非枚举一律返回 null，导致根本读不到拉杆是否被打开。
    return st.type === 'enum' ? st.values[value] : value
  } catch (e) { return null }
}

// 红石粉（redstone_wire）的两种形态：
//   dot（点状）  —— 四个方向的连接状态全是 none，孤立成一个点
//   cross（一/十字）—— 至少有一个方向是 side / up
// 两种形态可以用**右键**互相切换，所以录制/蓝图要能区分并还原。
function readWireShape (bot, block) {
  if (!block || block.name !== 'redstone_wire') return null
  const vals = ['north', 'east', 'south', 'west'].map((d) => readStateValue(bot, block, d))
  if (vals.some((v) => v == null)) return null
  return vals.every((v) => v === 'none') ? 'dot' : 'cross'
}

// 若红石粉形态与要求不一致，右键切换一次（右键可在点状/连接态之间切换）
async function ensureWireShape (bot, x, y, z, want) {
  if (!want) return true
  const b = bot.blockAt(new Vec3(x, y, z))
  if (!b || b.name !== 'redstone_wire') return true
  if (readWireShape(bot, b) === want) return true
  try {
    await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true)
    // 右键前先停 0.1s：操作太快会误触（比如中继器被连点改掉延迟）
    await M.sleep(100)
    await withTimeout(bot.activateBlock(b), 5000)
  } catch (e) { /* ignore */ }
  await bot.waitForTicks(3)
  return readWireShape(bot, bot.blockAt(new Vec3(x, y, z))) === want
}

// 朝向（piston / observer / wall_torch ...）
function readFacing (bot, block) { return readStateValue(bot, block, 'facing') }
// 依附面（lever 的 floor / wall / ceiling）
function readFace (bot, block) { return readStateValue(bot, block, 'face') }

const FACING_VEC = {
  north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
  up: [0, 1, 0], down: [0, -1, 0]
}

// The server validates a placement with a raycast along the bot's look, so to
// get a given facing the bot must stand on the side OPPOSITE the facing and look
// at the block (want it facing north? stand to its south and look north).
// Per request: pathfind to a spot at least 4 blocks in FRONT of and BEHIND the
// block along its facing axis, then place from each.

// Move the bot to a point so it can place from a clean angle.
// 位移交给 movement.js：水平方向"看向移动方向 + 按 W 键"飞过去（不再直接改写坐标），
// 高度则做小步校准（放置朝向对高度敏感，按键有惯性所以垂直单独微调）。
// 这里只保留"中止"语义：_aiAbort 时抛出，让上层建造流程停下来。
async function navigateTo (bot, pos, timeoutMs = 6000) {
  try {
    if (bot._aiAbort) throw new Error('AI_ABORT')
    const ok = await M.navigateTo(bot, pos, { timeoutMs })
    if (bot._aiAbort) throw new Error('AI_ABORT')
    return ok
  } catch (e) {
    if (e && e.message === 'AI_ABORT') throw e
    console.error('[AI] navigateTo failed:', e && e.message)
    return false
  }
}

// Place a directional block so it ends up with the wanted `facing`.
//
// The server picks the facing from the player's LOOK: the facing equals the
// direction from the player's eye to the placed block. So to face F we must stand
// on the -F side and look at the block. Crucially the bot's eye must be at the
// block's height (standing on the floor beside it); if it is above/below, the look
// is steeply downward/upward and the block comes out facing up/down. We PATHFIND to
// a spot on the -F side at floor level, look at the block, then place with
// forceLook:'ignore' (so mineflayer does not overwrite our look). The +F side is a
// fallback when the -F side is blocked / unreachable.
async function placeWithFacing (bot, x, y, z, ref, faceVec, facing) {
  if (!facing) {
    // 没有朝向要求：直接点这一面。clickPlace 会处理"依托可右键交互"的情况（按住 shift），
    // 并把服务器拒绝/超时原样返回（→ 抛给调用方换一面重试）。
    const r = await clickPlace(bot, ref, faceVec, 3000, true)
    return r !== 'timeout'
  }
  const center = new Vec3(x + 0.5, y + 0.5, z + 0.5)
  const v = FACING_VEC[facing]
  const horizontal = v && (v[0] !== 0 || v[2] !== 0)
  if (!horizontal) {
    // up / down: just look at the sky / ground and place
    await bot.look(0, FACING_PITCH[facing], true)
    await bot.waitForTicks(1)
    try {
      const r = await clickPlace(bot, ref, faceVec, 3000)
      if (r === 'timeout') console.error('[AI] up/down 放置超时（服务器没回应）')
    } catch (e) {
      console.error('[AI] up/down 放置被拒:', e && e.message)
    }
    let placed = null
    for (let w = 0; w < 6; w++) {
      placed = bot.blockAt(new Vec3(x, y, z))
      if (placed && placed.name !== 'air') break
      await bot.waitForTicks(1)
    }
    return !!(placed && placed.name !== 'air')
  }
  // Stand LEVEL with the block (feet at y), not one below it: with gravity off
  // the bot just floats there, so its eye ends up ~1.6 blocks above the block's
  // centre. From 2 blocks away horizontally that look is near-horizontal, so the
  // facing is always a clean N/S/E/W and never up/down. (Standing one block lower
  // had the bot embedded in the solid block beneath, and the collision push-up
  // made it look steeply down -> piston faced up/down.)
  const DIST = 2.0
  const floorY = y
  // !! 站位顺序：先 +F 再 -F !!
  // 服务器算朝向用的是 facing = 玩家视线方向的**反方向**，也就是"方块朝向玩家"：
  // 想让方块朝 F，玩家必须站在 **+F 侧**（FACING_VEC 所指的那一侧）回头看它。
  // 反过来站在 -F 侧会得到**相反**的朝向。
  // 之前把 -F 当 correct 先试，结果每次都要先放错、挖掉、再放一次。
  const sides = [
    new Vec3(center.x + v[0] * DIST, floorY, center.z + v[2] * DIST), // +F 侧 -> 正确朝向
    new Vec3(center.x - v[0] * DIST, floorY, center.z - v[2] * DIST)  // -F 侧 -> 兜底
  ]
  // 已经站在 +F 这一侧的话就**别再飞过去了**：每放一块都重新站位会明显打断流程。
  // 判据：从方块中心指向 bot 的水平向量与 FACING_VEC 同向（点积 > 0）。
  const bp0 = bot.entity.position
  const dx0 = bp0.x - center.x, dz0 = bp0.z - center.z
  const flatD = Math.hypot(dx0, dz0)
  const onPlusF = (dx0 * v[0] + dz0 * v[2]) > 0.3
  // 光在正确一侧还不够，距离也要合适：
  // 贴太近（<1.2 格）视线会很陡，反而放不进去、还得退回来重放；
  // 太远（>4.5 格）又够不到。高度也要和方块大致同层。
  const stayOk = onPlusF && flatD >= 1.2 && flatD <= 4.5 && Math.abs(bp0.y - floorY) < 1.5

  // 每个方块都要确认朝向正确后才继续（发现不对就挖掉重放）。
  // 注意只针对**当前这一格**做纠正，它对别的方块造成的影响（活塞被充能伸出等）不去管。
  for (let attempt = 0; attempt < 4; attempt++) {
    const spot = sides[attempt % 2]
    const side = attempt % 2 === 0 ? '+F (correct)' : '-F (fallback)'
    // 第一次尝试且已经在正确一侧 -> 原地不动，避免无谓的往返飞行
    const stayPut = attempt === 0 && stayOk
    console.log(`[AI] facing attempt ${attempt}: ${stayPut ? 'stay (already on +F)' : 'to ' + side} of (${x},${y},${z})`)
    if (!stayPut) await navigateTo(bot, spot, 4000)
    await withTimeout(bot.lookAt(center, true), 2000).catch(() => {})
    // 放置前后各让视角稳定 0.1s：方向性方块的朝向由视线决定，
    // 视角还在插值中就发包，游戏端偶尔会拿到错误的朝向/直接拒绝放置。
    await M.sleep(100)
    try {
      // Guard against _placeBlockWithOptions hanging forever when the server
      // rejects the placement (it waits for an ack that never comes).
      // clickPlace：依托方块可右键交互时自动按住 shift（否则右键会变成
      // "扳拉杆 / 开箱子 / 改中继器延迟"，方块反而放不上去）。
      await clickPlace(bot, ref, faceVec, 3000)
    } catch (e) { /* server refused (look missed the block) or it hung -> retry */ }
    await M.sleep(100)

    // Poll for the block a few ticks: the server's block_change can lag the
    // placement packet, and a single immediate read would falsely report
    // "nothing placed" and waste a whole extra navigate+place cycle.
    let placed = null
    for (let w = 0; w < 6; w++) {
      placed = bot.blockAt(new Vec3(x, y, z))
      if (placed && placed.name !== 'air') break
      await bot.waitForTicks(1)
    }
    if (!placed || placed.name === 'air') continue // nothing placed -> retry from elsewhere
    // 确认朝向：不对就挖掉重放。只管这一格，不管它对周围造成的影响。
    const actual = readFacing(bot, placed)
    if (!actual || actual === facing) return true
    try { await bot.dig(placed) } catch (e) { /* could not remove, just retry */ }
    await bot.waitForTicks(3)
  }
  return false
}

// ===== 右键会"交互"而不是"放置"的方块 =====
// 放置方块靠的是**右键点击依托方块的某一个面**（mineflayer 发 use_item_on）。
// 如果依托方块自己也响应右键（拉杆/按钮/中继器/箱子/音符盒…），服务器会**先把交互执行掉**：
// 拉杆被扳、中继器延时节 +1、箱子弹出界面、音符盒响一声 —— 手上的方块根本没放上去。
// 即使侥幸放上，红石状态也已经被破坏，检查点必然对不上（而且这种错完全看不出来）。
//
// minecraft-data 里**没有** interactive 之类的字段（blocks.json 只有 id/hardness/
// boundingBox/states 等，实测确认过），所以只能自己维护名单 + 后缀规则。
const INTERACTIVE_NAMES = new Set([
  // —— 红石元件：右键改状态 ——
  'lever', 'repeater', 'comparator', 'note_block', 'jukebox', 'daylight_detector',
  'dispenser', 'dropper', 'hopper', 'crafter',
  // —— 能打开界面的 ——
  'chest', 'trapped_chest', 'ender_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker',
  'crafting_table', 'stonecutter', 'cartography_table', 'fletching_table', 'smithing_table',
  'grindstone', 'loom', 'enchanting_table', 'brewing_stand', 'beacon', 'lectern', 'composter',
  'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'jigsaw',
  'vault',
  // —— 右键"塞东西 / 点火 / 吃"的 ——
  'flower_pot', 'chiseled_bookshelf', 'decorated_pot', 'cauldron', 'cake', 'candle', 'candle_cake',
  'campfire', 'soul_campfire', 'respawn_anchor', 'end_portal_frame', 'dragon_egg',
  // —— 右键可收获的作物（成熟后右键 = 摘，会把地里的作物撸掉）——
  'wheat', 'carrots', 'potatoes', 'beetroots', 'sweet_berry_bush', 'nether_wart', 'cocoa',
  'cave_vines', 'cave_vines_plant', 'torchflower_crop', 'pitcher_crop'
])
// 带材质前缀的按后缀认：oak_button / oak_door / white_shulker_box / red_bed / oak_wall_sign …
const INTERACTIVE_SUFFIXES = [
  '_button', '_door', '_trapdoor', '_fence_gate', '_bed', '_shulker_box',
  '_sign', '_anvil', '_candle', '_cauldron'
]

function isInteractiveBlock (bot, name) {
  if (!name || name === 'air') return false
  if (INTERACTIVE_NAMES.has(name)) return true
  return INTERACTIVE_SUFFIXES.some((s) => name.endsWith(s))
}

// 依托方块候选表：**先普通方块，可右键交互的排最后**。
// 这就是"能换面就换面"：旁边还有别的实心方块时优先拿它当依托，完全不碰可交互方块；
// 实在只剩下可交互方块，才按 shift 放（见 clickPlace）。
const NEIGHBOR_OFFSETS = [[0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]
function candidateRefs (bot, x, y, z) {
  const plain = []
  const interactive = []
  for (const off of NEIGHBOR_OFFSETS) {
    const ref = bot.blockAt(new Vec3(x + off[0], y + off[1], z + off[2]))
    if (!ref || ref.name === 'air') continue
    if (isInteractiveBlock(bot, ref.name)) interactive.push({ ref, off })
    else plain.push({ ref, off })
  }
  return plain.concat(interactive)
}

// 同一种方块只提示一次：红石建筑里 shift 放置会很频繁，别刷屏
const _sneakNoted = new Set()

// 统一的"右键放方块"入口 —— **所有放置都走这里**，不要再直接调 bot.placeBlock。
//   ① lookAtFace=true 时先看一眼被点的那一面的中心（等价 bot.placeBlock 的默认行为）
//   ② 依托方块可右键交互 -> 按住 shift（潜行）：服务器看到玩家潜行会**跳过方块自身的交互**，
//      直接把手上的方块放上去 —— 玩家手动"shift + 右键放方块"就是这个原理
//   ③ 发 use_item_on；④ **立刻松开 shift**
// ④ 的位置很关键：发包是**同步**完成的（forceLook:'ignore' 时 _genericPlace 里没有 await），
// 而 ack 可能要等好几秒；创造模式下 shift 是"下降"，一直按着会把 ai 从空中拽下来。
async function clickPlace (bot, ref, faceVec, timeoutMs = 3000, lookAtFace = false) {
  if (!ref) return 'no-ref'
  if (lookAtFace) {
    const c = ref.position.offset(
      0.5 + faceVec.x * 0.5, 0.5 + faceVec.y * 0.5, 0.5 + faceVec.z * 0.5)
    try { await withTimeout(bot.lookAt(c, true), 1500) } catch (e) {}
  }
  if (!isInteractiveBlock(bot, ref.name)) {
    return await withTimeout(
      bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore' }),
      timeoutMs
    )
  }
  if (!_sneakNoted.has(ref.name)) {
    _sneakNoted.add(ref.name)
    console.log(`[AI] 依托 "${ref.name}" 右键会交互 -> 按住 shift 再放（同类只提示一次）`)
  }
  try { bot.setControlState('sneak', true) } catch (e) { /* 还没 spawn 之类，忽略 */ }
  // 给服务器 1 tick 处理"开始潜行"（同一条连接顺序本来就有保证，这是双保险）
  await withTimeout(bot.waitForTicks(1), 1000)
  const p = withTimeout(
    bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore' }),
    timeoutMs
  )
  // 上面这行返回时 use_item_on 已经发出去了 -> 马上松开，别让 ai 一边潜行一边掉高度
  try { bot.setControlState('sneak', false) } catch (e) {}
  return await p
}

// ===== 非整块方块（红石粉 / 墙上红石火把 / 墙上拉杆 …）=====
// 这类方块的 boundingBox === 'empty'（不占满一整格），放置规则**和整块方块相反**：
//   1) 目标格本身是空气，"站在一侧盯着格子中心"射线打不到任何东西 -> 服务器直接拒绝放置；
//   2) 它们的朝向由**被点击的那一面**决定，而不是玩家视线
//      （活塞/熔炉才是由玩家水平视线决定，见坑 8）。
// 所以必须：找到它要依附的那个实心方块，把视线对准**那一面的中心**，
// 并站到那一面的外侧，再放置。
function isFullBlock (bot, name) {
  try {
    const mcData = require('minecraft-data')(bot.version)
    const b = mcData.blocksByName[name]
    return !!(b && b.boundingBox === 'block')
  } catch (e) { return true }
}

// 把方块放到 ref 的 faceVec 那一面上（faceVec 由 ref 指向目标格）
async function placeOnFace (bot, ref, faceVec, x, y, z) {
  // 被点击面的中心点
  const fc = new Vec3(
    ref.position.x + 0.5 + faceVec.x * 0.5,
    ref.position.y + 0.5 + faceVec.y * 0.5,
    ref.position.z + 0.5 + faceVec.z * 0.5
  )
  // 沿法线退开 2 格站位：既能看见这一面，又不会站进目标格挡住自己
  const stand = new Vec3(fc.x + faceVec.x * 2.0, fc.y + faceVec.y * 2.0, fc.z + faceVec.z * 2.0)
  await navigateTo(bot, stand)
  try { await withTimeout(bot.lookAt(fc, true), 3000) } catch (e) {}
  // 同上：放置前后各保持视角稳定 0.1s
  await M.sleep(100)
  try {
    // clickPlace：依托方块可右键交互（箱子 / 拉杆 / 中继器…）时按住 shift，
    // 否则右键变成"交互"，方块根本放不上去。
    await clickPlace(bot, ref, faceVec, 5000)
  } catch (e) { /* 被拒绝或超时 -> 交给调用方换一面重试 */ }
  await M.sleep(100)
  for (let w = 0; w < 8; w++) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (b && b.name !== 'air') return true
    await bot.waitForTicks(1)
  }
  return false
}

// 非整块方块的放置：贴墙（朝向指定的一侧）优先，其次贴地（下方方块顶面）
async function placeAttached (bot, x, y, z, name, facing, facePref) {
  const v = facing && FACING_VEC[facing] ? FACING_VEC[facing] : null
  const horizontal = v && (v[0] !== 0 || v[2] !== 0)

  const tryCeiling = async () => {
    const above = bot.blockAt(new Vec3(x, y + 1, z))
    if (!above || above.name === 'air') return false
    return await placeOnFace(bot, above, new Vec3(0, -1, 0), x, y, z)
  }
  // 想朝 F 的墙上附件，墙在 -F 侧；点击的是墙朝向格子的那一面（法线 = v）
  const tryWall = async () => {
    if (!horizontal) return false
    const wall = bot.blockAt(new Vec3(x - v[0], y, z - v[2]))
    if (!wall || wall.name === 'air') return false
    return await placeOnFace(bot, wall, new Vec3(v[0], 0, v[2]), x, y, z)
  }
  const tryFloor = async () => {
    const below = bot.blockAt(new Vec3(x, y - 1, z))
    if (!below || below.name === 'air') return false
    return await placeOnFace(bot, below, new Vec3(0, 1, 0), x, y, z)
  }

  if (facePref === 'ceiling') return await tryCeiling()
  if (facePref === 'floor') return await tryFloor()
  if (facePref === 'wall') return await tryWall()
  // 自动判断：先贴墙，再贴地，最后任意实心邻面（普通方块优先，可交互的排最后）
  if (await tryWall()) return true
  if (await tryFloor()) return true
  for (const { ref, off } of candidateRefs(bot, x, y, z)) {
    const [ox, oy, oz] = off
    if (await placeOnFace(bot, ref, new Vec3(-ox, -oy, -oz), x, y, z)) return true
  }
  return false
}

// ===== 辅助方块（平滑石头）=====
// 当目标坐标悬在空中（六个相邻面全是空气，没有任何可依附的方块）时，
// 先用"平滑石头"临时搭一根支撑柱，把目标方块依附上去放好；
// 放好之后**立刻**把这根柱子拆掉 —— 方块放下后即使失去支撑也不会掉落。
// 所有临时支撑都记在 bot._assistBlocks 里（"记住"），异常/中止时统一清理。
const ASSIST_BLOCK = 'smooth_stone'
const ASSIST_MAX_DEPTH = 64

// (x,y,z) 周围是否已经存在可依附的实心方块
function hasSolidNeighbor (bot, x, y, z) {
  const offs = [[0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]
  for (const [ox, oy, oz] of offs) {
    const b = bot.blockAt(new Vec3(x + ox, y + oy, z + oz))
    if (b && b.name !== 'air') return true
  }
  return false
}

// 从目标下方往下找第一个"自身就放得住"的高度，作为支撑柱的起点
function findSupportBase (bot, x, y, z) {
  for (let yy = y - 1; yy > y - ASSIST_MAX_DEPTH; yy--) {
    if (hasSolidNeighbor(bot, x, yy, z)) return yy
  }
  return null
}

function rememberAssist (bot, x, y, z) {
  if (!bot._assistBlocks) bot._assistBlocks = []
  bot._assistBlocks.push(new Vec3(x, y, z))
}

// 自己的身体正好占着目标格子时服务器会拒绝放置（最常见的失败原因）。
// 挪到斜上方：既离开目标格，又还在手臂够得到的范围内。
async function avoidSelfBlock (bot, x, y, z) {
  const p = bot.entity.position
  const inCell = Math.floor(p.x) === x && Math.floor(p.z) === z && p.y >= y - 1.9 && p.y <= y + 1.9
  if (!inCell) return
  await navigateTo(bot, new Vec3(x + 1.5, y + 2.5, z + 1.5))
}

// 放一个普通方块（辅助方块没有朝向要求，看一眼那一面就行 —— 走 clickPlace）
async function placeSimpleAt (bot, x, y, z) {
  // 先挪开身体，再放；放不下就换个站位重试
  for (let attempt = 0; attempt < 3; attempt++) {
    await avoidSelfBlock(bot, x, y, z)
    await ensureReach(bot, x, y, z)
    for (const { ref, off } of candidateRefs(bot, x, y, z)) {
      const [ox, oy, oz] = off
      // keepLook=true：先看一眼被点的那一面（原来是 bot.placeBlock 的行为）；
      // 依托可右键交互时 clickPlace 会自动按住 shift。
      try { await clickPlace(bot, ref, new Vec3(-ox, -oy, -oz), 5000, true) } catch (e) {}
      let placed = null
      for (let w = 0; w < 6; w++) {
        placed = bot.blockAt(new Vec3(x, y, z))
        if (placed && placed.name !== 'air') break
        await bot.waitForTicks(1)
      }
      if (placed && placed.name !== 'air') return true
    }
    await navigateTo(bot, new Vec3(x + 0.5 + (attempt % 2 ? 1.5 : -1.5), y + 2.5, z + 0.5))
  }
  return false
}

// 拆除并"忘掉"这些辅助方块
async function removeAssists (bot, list) {
  for (const p of list) {
    const b = bot.blockAt(p)
    if (b && b.name !== 'air') {
      await ensureReach(bot, p.x, p.y, p.z)
      try { await withTimeout(bot.dig(bot.blockAt(p)), 5000) } catch (e) {}
      await bot.waitForTicks(2)
    }
    if (bot._assistBlocks) {
      bot._assistBlocks = bot._assistBlocks.filter((q) => !(q.x === p.x && q.y === p.y && q.z === p.z))
    }
  }
}

// 统一清理入口（stop / 出错 / 建造结束时调用）
async function cleanupAssists (bot) {
  const list = (bot._assistBlocks || []).slice()
  if (!list.length) return 0
  // 清理期间临时解除中止标志：否则导航会被 _aiAbort 挡住，
  // 结果就是"stop 之后辅助方块再也拆不掉"。
  // ⚠️ 这里必须记一个"停止次数"：清理期间玩家可能又发了 stop，那时 _aiAbort 会被我们置回 false，
  //    finally 里再拿 prev（false）覆盖回去就把这次 stop 吃掉了 —— 表现是"stop 了还在建"（2026-11-01 踩到）。
  const prev = bot._aiAbort
  const token = bot._aiStopToken || 0
  bot._aiAbort = false
  try {
    await removeAssists(bot, list)
  } finally {
    bot._aiAbort = prev || (bot._aiStopToken || 0) !== token
  }
  return list.length
}

// 悬空放置：先造出缺失的依托（墙 / 支撑柱）→ 放目标方块 → 立刻拆掉辅助方块
async function placeWithAssist (bot, x, y, z, facing, name, facePref) {
  const cur = bot.blockAt(new Vec3(x, y, z))
  if (cur && cur.name !== 'air') return false

  // 非整块方块缺的往往不是"脚下的支撑"，而是**那面墙**，单独处理
  if (name && !isFullBlock(bot, name)) {
    const v = facing && FACING_VEC[facing] ? FACING_VEC[facing] : null
    if (v && (v[0] !== 0 || v[2] !== 0)) {
      const wx = x - v[0], wy = y, wz = z - v[2]
      const wall = bot.blockAt(new Vec3(wx, wy, wz))
      if (!wall || wall.name === 'air') {
        console.log(`[AI] (${x},${y},${z}) 缺少依附的墙 -> 用 ${ASSIST_BLOCK} 临时补墙 (${wx},${wy},${wz})`)
        try { await equipBlock(bot, ASSIST_BLOCK) } catch (e) { /* ignore */ }
        if (await placeSimpleAt(bot, wx, wy, wz)) {
          rememberAssist(bot, wx, wy, wz)
          let ok = false
          try {
            try { await equipBlock(bot, name) } catch (e) { /* ignore */ }
            ok = await placeAttached(bot, x, y, z, name, facing, facePref)
          } finally {
            await removeAssists(bot, [new Vec3(wx, wy, wz)])
          }
          return ok
        }
      }
    }
  }

  const base = findSupportBase(bot, x, y, z)
  if (base === null) {
    console.error(`[AI] (${x},${y},${z}) 悬空且下方 ${ASSIST_MAX_DEPTH} 格内找不到可支撑的位置`)
    return false
  }
  console.log(`[AI] (${x},${y},${z}) 悬空 -> 用 ${ASSIST_BLOCK} 临时支撑 (${base}..${y - 1})`)
  try { await equipBlock(bot, ASSIST_BLOCK) } catch (e) { return false }

  const assists = []
  let ok = false
  try {
    // 自下而上搭支撑柱，一直搭到目标方块的正下方
    for (let yy = base; yy <= y - 1; yy++) {
      if (bot._aiAbort) throw new Error('AI_ABORT')
      if (!await placeSimpleAt(bot, x, yy, z)) break
      assists.push(new Vec3(x, yy, z))
      rememberAssist(bot, x, yy, z)
    }
    // 换回目标方块本身的材质（刚才搭柱子时手里是平滑石头）
    try { await equipBlock(bot, name) } catch (e) { /* ignore */ }
    ok = await tryPlaceNormal(bot, x, y, z, facing)
  } finally {
    // 该方块搭建结束 -> 立刻拆除辅助方块
    await removeAssists(bot, assists)
  }
  return ok
}

// 正常放置：从 bot 当前位置找一个实心相邻面作为依托放下去
async function tryPlaceNormal (bot, x, y, z, facing, name, facePref) {
  // 非整块方块（红石粉 / 墙上红石火把 / 拉杆 …）走专门的"贴面"放置，
  // 整块方块的"站位+视线"那套对它们无效（见 placeAttached 的注释）。
  if (name && !isFullBlock(bot, name)) {
    const occupied = bot.blockAt(new Vec3(x, y, z))
    if (occupied && occupied.name !== 'air') return false // already occupied
    const ok = await placeAttached(bot, x, y, z, name, facing, facePref)
    if (ok) {
      bot._batchPlaced = (bot._batchPlaced || 0) + 1
      bot._totalPlaced = (bot._totalPlaced || 0) + 1
    }
    return ok
  }
  // 依托候选：普通方块优先，可右键交互的排最后（避免放方块变成"扳拉杆/开箱子"）
  for (const { ref, off } of candidateRefs(bot, x, y, z)) {
    const [ox, oy, oz] = off
    const cur = bot.blockAt(new Vec3(x, y, z))
    if (cur && cur.name !== 'air') return false // already occupied
    try {
      const ok = await placeWithFacing(bot, x, y, z, ref, new Vec3(-ox, -oy, -oz), facing)
      if (!ok) continue // not really placed, try the next face
      bot._batchPlaced = (bot._batchPlaced || 0) + 1
      bot._totalPlaced = (bot._totalPlaced || 0) + 1
      return true
    } catch (e) {
      // this face did not work, try the next one
    }
  }
  return false
}

// 先正常放；正常放不了（坐标悬空 / 没有可依附的面）就用平滑石头辅助搭建
async function tryPlace (bot, x, y, z, facing, name, facePref) {
  if (await tryPlaceNormal(bot, x, y, z, facing, name, facePref)) return true
  return await placeWithAssist(bot, x, y, z, facing, name, facePref)
}

// Place a block at (x,y,z). Build normally on the ground; only if the bot's own
// body is blocking the placement do we relocate (fly up) and retry, moving
// further each time until the block can be placed.
async function placeAt (bot, x, y, z, facing, name, facePref) {
  if (await tryPlace(bot, x, y, z, facing, name, facePref)) return true
  for (let i = 1; i <= 6; i++) {
    const dest = new Vec3(Math.floor(x) + 0.5, y + i + 0.5, Math.floor(z) + 0.5)
    try {
      if (bot.pathfinder && bot.pathfinder.stop) bot.pathfinder.stop()
      await navigateTo(bot, dest)
    } catch (e) { /* ignore, then try placing anyway */ }
    await bot.waitForTicks(1)
    if (await tryPlace(bot, x, y, z, facing, name, facePref)) return true
  }
  console.error('[AI] could not place at', x, y, z, 'even after moving')
  return false
}

const tick = (bot) => bot.waitForTicks(1)

// Find the solid ground under (x,y,z) by scanning downwards. Using the bot's
// own y is unreliable: it may still be mid-air / falling right after spawn,
// which would put the whole build one layer up with nothing to attach to.
function findGroundY (bot, x, y, z) {
  for (let yy = y; yy > y - 128; yy--) {
    const b = bot.blockAt(new Vec3(x, yy, z))
    if (b && b.name !== 'air') return yy
  }
  return y - 1
}

// How close (blocks) the bot must be to a target before placing. Kept safely
// under mineflayer's interaction reach so placeBlock never fails on distance.
const MAX_REACH = 4.0

// Order blocks so the bot always places near where it just was, but never
// before the layer below (so every block has a support to attach to). We sort
// by height first (lowest layer first), then greedily pick the nearest still
// unplaced block within that horizontal layer, carrying the position across
// layers so the next layer starts right above where the previous one ended.
function orderByProximity (start, blocks) {
  const byY = {}
  for (const b of blocks) {
    if (!byY[b.y]) byY[b.y] = []
    byY[b.y].push(b)
  }
  const ys = Object.keys(byY).map(Number).sort((a, b) => a - b)
  const ordered = []
  let cur = start
  for (const y of ys) {
    const remaining = byY[y].slice()
    while (remaining.length) {
      let bestI = 0
      let bestD = Infinity
      for (let i = 0; i < remaining.length; i++) {
        const b = remaining[i]
        const d = (b.x - cur.x) ** 2 + (b.z - cur.z) ** 2
        if (d < bestD) { bestD = d; bestI = i }
      }
      const b = remaining.splice(bestI, 1)[0]
      ordered.push(b)
      cur = b
    }
  }
  return ordered
}

// Make sure the bot is within reach of (x,y,z); if not, fly it to a spot just
// above the block (usually air, and never the block itself) so placement works.
async function ensureReach (bot, x, y, z) {
  const target = new Vec3(x + 0.5, y + 0.5, z + 0.5)
  if (bot.entity.position.distanceTo(target) <= MAX_REACH) return
  const spots = [
    new Vec3(x + 0.5, y + 1.5, z + 0.5),
    new Vec3(x + 1.5, y + 0.5, z + 0.5),
    new Vec3(x - 0.5, y + 0.5, z + 1.5),
    new Vec3(x + 0.5, y + 0.5, z - 0.5),
    new Vec3(x + 0.5, y + 2.5, z + 0.5)
  ]
  for (const s of spots) {
    try {
      if (bot.pathfinder && bot.pathfinder.stop) bot.pathfinder.stop()
      await navigateTo(bot, s)
    } catch (e) { /* try next spot */ }
    await bot.waitForTicks(1)
    if (bot.entity.position.distanceTo(target) <= MAX_REACH) return
  }
}

// Guard against a single placement hanging (e.g. the server never confirms):
// never let one block stall the whole build.
function withTimeout (p, ms) {
  let t
  const timer = new Promise((resolve) => {
    t = setTimeout(() => resolve('timeout'), ms)
    if (t.unref) t.unref()
  })
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}

// Place a list of blocks (already ordered) one by one, keeping the bot within
// reach and letting placeAt relocate when its own body blocks a cell. Blocks
// that fail the first pass (no neighbour yet) get a second chance at the end.
async function placeBlocks (bot, blocks, label) {
  console.log(`[AI] ${label}: ${blocks.length} blocks`)
  const t0 = Date.now()
  const failed = []
  let i = 0
  for (const b of blocks) {
    i++
    if (bot._aiAbort) throw new Error('AI_ABORT')
    if (i % 20 === 0) {
      console.log(`[AI]   ${i}/${blocks.length} at (${b.x},${b.y},${b.z}) ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
    await ensureReach(bot, b.x, b.y, b.z)
    try {
      await equipBlock(bot, b.name)
    } catch (e) {
      console.error('[AI] skip unknown block', b.name)
      continue
    }
    const facing = b.facing && hasFacing(bot, b.name) ? b.facing : null
    // 单块超时放宽：放置前后各加了 0.1s 视角稳定，失败重试的耗时会变长，
    // 20s 太紧会导致明明能放下的方块被判超时。
    const ok = await withTimeout(placeAt(bot, b.x, b.y, b.z, facing, b.name, b.face), 45000)
    // 红石粉形态（点状 / 十字）不一致时用右键切换
    if (b.wire) await ensureWireShape(bot, b.x, b.y, b.z, b.wire)
    await tick(bot)
    if (ok !== true) {
      failed.push(b)
      if (ok === 'timeout') console.error('[AI] timed out placing at', b.x, b.y, b.z)
    }
  }
  for (const b of failed) {
    if (bot._aiAbort) throw new Error('AI_ABORT')
    await ensureReach(bot, b.x, b.y, b.z)
    try { await equipBlock(bot, b.name) } catch (e) { continue }
    const facing = b.facing && hasFacing(bot, b.name) ? b.facing : null
    await withTimeout(placeAt(bot, b.x, b.y, b.z, facing, b.name, b.face), 45000)
    await tick(bot)
  }
  // 收尾：确保没有任何临时辅助方块残留
  const left = await cleanupAssists(bot)
  if (left) console.log('[AI] 已清理残留辅助方块 ' + left + ' 个')
}

// ===== Block plans (list of {x,y,z,name}) =====

// 方块规格解析：
//   "piston:west"        -> { name:'piston', facing:'west' }
//   "lever:wall:north"   -> { name:'lever', face:'wall',  facing:'north' }   ← 非整块方块可指定依附面
//   "lever:floor:north"  -> { name:'lever', face:'floor', facing:'north' }
const FACE_ENUM = /^(wall|floor|ceiling)$/
const DIR_ENUM = /^(north|south|east|west|up|down)$/
function parseBlockSpec (spec) {
  const s = String(spec || '')
  const parts = s.split(':')
  if (parts.length === 3 && FACE_ENUM.test(parts[1])) {
    return { name: parts[0], face: parts[1], facing: DIR_ENUM.test(parts[2]) ? parts[2] : null }
  }
  const m = /^(.+?):(north|south|east|west|up|down)$/.exec(s)
  return m ? { name: m[1], facing: m[2], face: null } : { name: s, facing: null, face: null }
}

// facing pointing away from the centre of the build (used for wall blocks)
function outwardFacing (dx, dz) {
  if (dx === 0 && dz === 0) return 'up'
  if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? 'east' : 'west'
  return dz > 0 ? 'south' : 'north'
}

function planHouse (bot, o) {
  const half = Math.floor(o.size / 2)
  const x0 = bot.x0, z0 = bot.z0, gy = bot.gy
  const isEdge = (dx, dz) => dx === -half || dx === half || dz === -half || dz === half
  const isWall = (dx, dz) => isEdge(dx, dz) || (dx === 0 && dz === 0)
  const floorS = parseBlockSpec(o.floor)
  const wallS = parseBlockSpec(o.wall)
  const roofS = parseBlockSpec(o.roof)
  const blocks = []
  for (let dx = -half; dx <= half; dx++) for (let dz = -half; dz <= half; dz++)
    blocks.push({ x: x0 + dx, y: gy + 1, z: z0 + dz, name: floorS.name, facing: floorS.facing || 'up', face: floorS.face })
  for (let h = 2; h <= 1 + o.height; h++)
    for (let dx = -half; dx <= half; dx++) for (let dz = -half; dz <= half; dz++) {
      if (!isWall(dx, dz)) continue
      if (dx === 0 && dz === half && h === 2) continue // door on the front wall
      blocks.push({ x: x0 + dx, y: gy + h, z: z0 + dz, name: wallS.name, facing: wallS.facing || outwardFacing(dx, dz), face: wallS.face })
    }
  for (let dx = -half; dx <= half; dx++) for (let dz = -half; dz <= half; dz++)
    blocks.push({ x: x0 + dx, y: gy + 2 + o.height, z: z0 + dz, name: roofS.name, facing: roofS.facing || 'up', face: roofS.face })
  return blocks
}

function planTower (bot, o) {
  const half = Math.floor(o.size / 2)
  const x0 = bot.x0, z0 = bot.z0, gy = bot.gy
  const isEdge = (dx, dz) => dx === -half || dx === half || dz === -half || dz === half
  const wallS = parseBlockSpec(o.wall)
  const roofS = parseBlockSpec(o.roof)
  const blocks = []
  for (let h = 1; h <= o.height; h++)
    for (let dx = -half; dx <= half; dx++) for (let dz = -half; dz <= half; dz++) {
      if (!isEdge(dx, dz)) continue
      if (dx === 0 && dz === half && h === 1) continue // door at bottom
      blocks.push({ x: x0 + dx, y: gy + h, z: z0 + dz, name: wallS.name, facing: wallS.facing || outwardFacing(dx, dz), face: wallS.face })
    }
  for (let dx = -half; dx <= half; dx++) for (let dz = -half; dz <= half; dz++)
    if (isEdge(dx, dz)) blocks.push({ x: x0 + dx, y: gy + o.height + 1, z: z0 + dz, name: roofS.name, facing: roofS.facing || 'up', face: roofS.face })
  return blocks
}

function planPyramid (bot, o) {
  const x0 = bot.x0, z0 = bot.z0, gy = bot.gy
  let layer = o.size % 2 === 0 ? o.size - 1 : o.size
  let y = gy + 1
  const wallS = parseBlockSpec(o.wall)
  const roofS = parseBlockSpec(o.roof)
  const blocks = []
  while (layer >= 1) {
    const half = Math.floor(layer / 2)
    const isEdge = (dx, dz) => Math.abs(dx) === half || Math.abs(dz) === half
    for (let dx = -half; dx <= half; dx++) for (let dz = -half; dz <= half; dz++)
      if (isEdge(dx, dz)) blocks.push({ x: x0 + dx, y, z: z0 + dz, name: wallS.name, facing: wallS.facing || outwardFacing(dx, dz), face: wallS.face })
    layer -= 2
    y += 1
  }
  blocks.push({ x: x0, y, z: z0, name: roofS.name, facing: roofS.facing || 'up', face: roofS.face })
  return blocks
}

// ===== Default (config-driven) build =====
async function build (bot, opts) {
  bot._batchPlaced = 0
  bot._aiAbort = false
  const o = Object.assign(
    { building: 'house', size: 5, height: 3, floor: 'stone', wall: 'oak_planks', roof: 'bricks' },
    opts || {}
  )
  // 建造基准点：优先用调用方显式给出的 xyz（build <x> <y> <z>）—— 这样才会在
  // 指定的高度开工（哪怕那个高度悬在空中，由平滑石头辅助支撑）；
  // 没给坐标时沿用老行为：以"脚下的真实地面"为基准，绝不在半空开工。
  if (o.origin) {
    bot.x0 = Math.floor(o.origin.x)
    bot.z0 = Math.floor(o.origin.z)
    bot.gy = Math.floor(o.origin.y)
  } else {
    const pos = bot.entity.position.floored()
    bot.x0 = pos.x
    bot.z0 = pos.z
    bot.gy = findGroundY(bot, pos.x, pos.y, pos.z) // solid ground under the bot (never mid-air)
  }
  console.log(`[AI] building=${o.building} size=${o.size} height=${o.height} floor=${o.floor} wall=${o.wall} roof=${o.roof}`)

  let blocks
  if (o.building === 'tower') blocks = planTower(bot, o)
  else if (o.building === 'pyramid') blocks = planPyramid(bot, o)
  else blocks = planHouse(bot, o)

  // Build in nearest-neighbour order starting from where the bot is standing.
  const start = { x: bot.x0 + 0.5, y: bot.gy + 1.5, z: bot.z0 + 0.5 }
  const ordered = orderByProximity(start, blocks)
  await placeBlocks(bot, ordered, 'Building ' + o.building)

  try { if (bot.creative && bot.creative.stopFlying) bot.creative.stopFlying() } catch (e) {}
  const batch = bot._batchPlaced || 0
  const total = bot._totalPlaced || 0
  console.log(`[AI] placed ${batch} blocks (this build), total ${total}. Center near (x=${bot.x0}, z=${bot.z0})`)
}

// ===== Blueprint save / load =====

// Scan all non-air blocks inside the AABB defined by two corners.
// `exclude` is a list of block names to ignore (e.g. the marker blocks).
async function scanRegion (bot, c1, c2, exclude) {
  const minX = Math.min(c1.x, c2.x), maxX = Math.max(c1.x, c2.x)
  const minY = Math.min(c1.y, c2.y), maxY = Math.max(c1.y, c2.y)
  const minZ = Math.min(c1.z, c2.z), maxZ = Math.max(c1.z, c2.z)
  const blocks = []
  for (let x = minX; x <= maxX; x++)
    for (let y = minY; y <= maxY; y++)
      for (let z = minZ; z <= maxZ; z++) {
        const b = bot.blockAt(new Vec3(x, y, z))
        if (b && b.name !== 'air' && !exclude.includes(b.name)) {
          // keep the orientation of directional blocks (piston, observer, ...)
          // and the attachment face of non-full blocks (lever 的 floor/wall/ceiling)
          const facing = readFacing(bot, b)
          const face = readFace(bot, b)
          const wire = readWireShape(bot, b) // 红石粉的点状/十字形态
          blocks.push({ dx: x - minX, dy: y - minY, dz: z - minZ, name: b.name, facing, face, wire })
        }
      }
  return blocks
}

function saveBlueprint (name, blocks) {
  if (!fs.existsSync(BLUEPRINT_DIR)) fs.mkdirSync(BLUEPRINT_DIR, { recursive: true })
  fs.writeFileSync(path.join(BLUEPRINT_DIR, name + '.json'), JSON.stringify({ name, blocks }, null, 2))
}

function getBlueprint (name) {
  const file = path.join(BLUEPRINT_DIR, name + '.json')
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function listBlueprints () {
  if (!fs.existsSync(BLUEPRINT_DIR)) return []
  return fs.readdirSync(BLUEPRINT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
}

// ===== 建筑尺寸 / 建造范围标记 =====
// 由相对坐标列表算出包围盒（尺寸 = max-min+1）
function boxOf (pts, kind) {
  if (!pts.length) return null
  let mnx = Infinity, mny = Infinity, mnz = Infinity
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity
  for (const p of pts) {
    mnx = Math.min(mnx, p[0]); mny = Math.min(mny, p[1]); mnz = Math.min(mnz, p[2])
    mxx = Math.max(mxx, p[0]); mxy = Math.max(mxy, p[1]); mxz = Math.max(mxz, p[2])
  }
  return {
    kind,
    min: { dx: mnx, dy: mny, dz: mnz },
    max: { dx: mxx, dy: mxy, dz: mxz },
    size: { x: mxx - mnx + 1, y: mxy - mny + 1, z: mxz - mnz + 1 }
  }
}

// 计算已保存建筑（教学优先，其次蓝图）的尺寸，供 rep 算重复间隔
function sizeOfSaved (name) {
  const teach = getTeaching(name)
  if (teach) {
    const pts = (teach.events || []).filter((e) => e.t === 'place').map((e) => [e.dx, e.dy, e.dz])
    const b = boxOf(pts, 'teaching')
    if (b) return b
  }
  const bp = getBlueprint(name)
  if (bp) {
    const pts = (bp.blocks || []).map((b) => [b.dx, b.dy, b.dz])
    return boxOf(pts, 'blueprint')
  }
  return null
}

// 建造前用**红/蓝羊毛**在对角标出建造范围（默认开启，mark y/n 控制）
const MARK_RED = 'red_wool'
const MARK_BLUE = 'blue_wool'

async function putMarker (bot, x, y, z, wool) {
  // 该格若是实心就往上找空位，保证玩家一定看得见
  for (let up = 0; up < 4; up++) {
    const yy = y + up
    const b = bot.blockAt(new Vec3(x, yy, z))
    if (b && b.name !== 'air') continue
    try { await equipBlock(bot, wool) } catch (e) { return null }
    // 用 placeAt 而不是 placeSimpleAt：标记常常悬在空中（包围盒的对角），
    // 没有相邻实心块就放不上去，必须走和正常建造一样的"临时辅助方块"逻辑。
    const ok = await withTimeout(placeAt(bot, x, yy, z, null, wool, null), 20000)
    if (ok) return { x, y: yy, z }
  }
  return null
}

// 拆掉一个羊毛标记。
// 坑：以前只是简单 bot.dig 一次，结果**第一个（红）羊毛经常漏拆**——
// 拆的时候 bot 可能够不着/没对准，dig 失败就被 catch 吞掉了。
// 所以这里：靠过去 + 对准 + 挖，然后**确认真的没了**，没成功就重试。
async function removeMarker (bot, p) {
  const isMarker = (b) => b && (b.name === MARK_RED || b.name === MARK_BLUE)
  for (let i = 0; i < 3; i++) {
    const blk = bot.blockAt(new Vec3(p.x, p.y, p.z))
    if (!isMarker(blk)) return true // 已经没了
    try {
      await avoidSelfBlock(bot, p.x, p.y, p.z)
      await ensureReach(bot, p.x, p.y, p.z)
      await bot.lookAt(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5), true)
      await withTimeout(bot.dig(blk), 6000)
    } catch (e) { /* 失败就下一轮重试 */ }
    await bot.waitForTicks(3)
    if (!isMarker(bot.blockAt(new Vec3(p.x, p.y, p.z)))) return true
  }
  console.log(`[AI] 警告：羊毛标记没拆干净 (${p.x},${p.y},${p.z})`)
  return false
}

async function markBuildArea (bot, minP, maxP, label) {
  if (bot._markEnabled === false) return
  const a = await putMarker(bot, minP.x, minP.y, minP.z, MARK_RED)
  const b = await putMarker(bot, maxP.x, maxP.y, maxP.z, MARK_BLUE)
  if (!a && !b) return
  console.log(`[AI] 已用红/蓝羊毛标出建造范围${label ? ' ' + label : ''}: ` +
    `(${minP.x},${minP.y},${minP.z}) ~ (${maxP.x},${maxP.y},${maxP.z})`)
  await M.sleep(1500) // 让玩家看清楚
  // 标完就拆掉，免得挡住真正的建造
  for (const p of [a, b]) if (p) await removeMarker(bot, p)
  // 标记期间可能为了支撑而临时放了方块，一并拆掉，别留在场上
  try { await cleanupAssists(bot) } catch (e) { /* ignore */ }
}

// Rebuild a saved blueprint with its base placed at `origin` (a floored position).
async function buildFromBlueprint (bot, bp, origin) {
  bot._batchPlaced = 0
  bot._aiAbort = false
  const gy = findGroundY(bot, origin.x, origin.y, origin.z)
  const ox = origin.x
  const oz = origin.z
  const blocks = (bp.blocks || []).map((b) => ({
    x: ox + b.dx, y: gy + 1 + b.dy, z: oz + b.dz,
    name: b.name, facing: b.facing, face: b.face, wire: b.wire
  }))
  const start = { x: ox + 0.5, y: gy + 1.5, z: oz + 0.5 }
  const ordered = orderByProximity(start, blocks)
  // 建造前先用红/蓝羊毛在对角标出范围
  if (blocks.length) {
    const xs = blocks.map((b) => b.x), ys = blocks.map((b) => b.y), zs = blocks.map((b) => b.z)
    await markBuildArea(bot,
      { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
      { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
      bp.name)
  }
  await placeBlocks(bot, ordered, 'Rebuilding blueprint ' + bp.name)
  try { if (bot.creative && bot.creative.stopFlying) bot.creative.stopFlying() } catch (e) {}
}

// ===== 教学模式（记录玩家的操作 / 移动 / 交互顺序，并可复现）=====
// 与"蓝图"的区别：蓝图只记最终的方块列表；教学记录的是**过程**——
// 玩家走过的路、放置的方块、右键交互的时机与目标，全部按顺序记下来，
// 复现时 AI 会一步步重走一遍。
const TEACHING_DIR = path.join(__dirname, '..', '教学')

function saveTeaching (name, teaching) {
  if (!fs.existsSync(TEACHING_DIR)) fs.mkdirSync(TEACHING_DIR, { recursive: true })
  fs.writeFileSync(path.join(TEACHING_DIR, name + '.json'), JSON.stringify(teaching, null, 2))
}

function getTeaching (name) {
  const file = path.join(TEACHING_DIR, name + '.json')
  if (!fs.existsSync(file)) return null
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return null }
}

function listTeachings () {
  if (!fs.existsSync(TEACHING_DIR)) return []
  return fs.readdirSync(TEACHING_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
}

// 删除已保存的蓝图 / 教学（同名时两者一起删），返回被删掉的种类
function deleteSaved (name) {
  const removed = []
  const bpFile = path.join(BLUEPRINT_DIR, name + '.json')
  if (fs.existsSync(bpFile)) { fs.unlinkSync(bpFile); removed.push('蓝图') }
  const tcFile = path.join(TEACHING_DIR, name + '.json')
  if (fs.existsSync(tcFile)) { fs.unlinkSync(tcFile); removed.push('教学') }
  return removed
}

// 读取方块的**全部状态**（含 powered / delay / mode 这类"可交互状态"）。
// 坑：检查点以前只比 name / facing / wire，可交互方块（拉杆、中继器、比较器…）
// 被右键改了状态时**完全查不出来**——名字朝向都没变，只有状态变了。
function readBlockStates (bot, block) {
  if (!block || typeof block.getProperties !== 'function') return null
  try {
    const props = block.getProperties()
    const o = {}
    for (const k of Object.keys(props)) {
      const v = props[k]
      o[k] = (typeof v === 'boolean' || typeof v === 'number') ? v : String(v)
    }
    return Object.keys(o).length ? o : null
  } catch (e) { return null }
}

function statesEqual (a, b) {
  if (!a || !b) return true // 没记录到就不比（避免误判）
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => String(a[k]) === String(b[k]))
}

// 检查点校对：只核对"检查点快照"里记录的那些格子。
// 检查点由玩家在录制时用 `teach ckpd` 设置（替代了原来"复现结束后统一检查"的做法）。
async function checkCheckpoint (bot, blocks, ox, oy, oz, label) {
  let fixed = 0
  for (const p of blocks) {
    if (bot._aiAbort) throw new Error('AI_ABORT')
    const x = ox + p.dx, y = oy + p.dy, z = oz + p.dz
    const b = bot.blockAt(new Vec3(x, y, z))
    const nameOk = b && b.name === p.name
    const facingOk = !p.facing || readFacing(bot, b) === p.facing
    const wireOk = !p.wire || readWireShape(bot, b) === p.wire
    const stateOk = statesEqual(readBlockStates(bot, b), p.states)
    if (nameOk && facingOk && wireOk && stateOk) continue

    // 方块是对的、只有"状态"不对 —— 多半是被右键切了（拉杆/中继器/比较器）。
    // 这种情况不用挖了重放，右键切回去即可。
    if (nameOk && facingOk && wireOk && !stateOk) {
      console.log(`[AI] 检查点[${label || ''}]: (${x},${y},${z}) ${p.name} 状态不对，` +
        `应为 ${JSON.stringify(p.states)}，实际 ${JSON.stringify(readBlockStates(bot, b))} -> 右键切回`)
      for (let t = 0; t < 3; t++) {
        try {
          await bot.lookAt(b.position.offset(0.5, 0.5, 0.5), true)
          await M.sleep(100) // 右键前停 0.1s，防误触
          await withTimeout(bot.activateBlock(b), 5000)
        } catch (e) { /* ignore */ }
        await bot.waitForTicks(4)
        if (statesEqual(readBlockStates(bot, bot.blockAt(new Vec3(x, y, z))), p.states)) { fixed++; break }
      }
      continue
    }
    console.log(`[AI] 检查点[${label || ''}]: (${x},${y},${z}) 应为 ${p.name}` +
      `${p.facing ? '/' + p.facing : ''}${p.wire ? '/' + p.wire : ''}，实际 ${b ? b.name : 'air'}`)
    if (b && b.name !== 'air') {
      try { await withTimeout(bot.dig(bot.blockAt(new Vec3(x, y, z))), 6000) } catch (e) { /* ignore */ }
      await bot.waitForTicks(3)
    }
    try { await equipBlock(bot, p.name) } catch (e) { continue }
    const ok = await withTimeout(placeAt(bot, x, y, z, p.facing, p.name, p.face), 20000)
    if (ok) {
      if (p.wire) await ensureWireShape(bot, x, y, z, p.wire)
      fixed++
    }
  }
  return fixed
}

// 复现：严格按记录顺序执行 移动 / 按键 / 放置 / 交互
async function replayTeaching (bot, teach, origin) {
  bot._batchPlaced = 0
  bot._aiAbort = false
  const ox = Math.floor(origin.x)
  const oy = Math.floor(origin.y)
  const oz = Math.floor(origin.z)
  const events = (teach && teach.events) || []
  console.log(`[AI] 复现教学 "${(teach && teach.name) || '?'}": ${events.length} 个事件`)

  // 建造前先用红/蓝羊毛在对角标出范围
  const places = events.filter((e) => e.t === 'place')
  if (places.length) {
    const xs = places.map((e) => ox + e.dx), ys = places.map((e) => oy + e.dy), zs = places.map((e) => oz + e.dz)
    await markBuildArea(bot,
      { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
      { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
      (teach && teach.name) || '教学')
  }

  let i = 0
  for (const ev of events) {
    i++
    if (bot._aiAbort) throw new Error('AI_ABORT')
    if (ev.t === 'move') {
      // 移动：沿玩家走过的路线走。
      // 用 moveToSmooth 而不是 moveTo —— 后者是"先走完水平再统一调高度"的 L 形，
      // 轨迹和玩家原本的路线对不上；前者分段同步推进，更贴近原始路线。
      await M.moveToSmooth(bot, ox + ev.x + 0.5, oy + ev.y, oz + ev.z + 0.5)
    } else if (ev.t === 'place') {
      // 放置：方块（含朝向/依附面）
      const x = ox + ev.dx, y = oy + ev.dy, z = oz + ev.dz
      await ensureReach(bot, x, y, z)
      try { await equipBlock(bot, ev.name) } catch (e) {
        console.error('[AI] 跳过未知方块', ev.name)
        continue
      }
      await withTimeout(placeAt(bot, x, y, z, ev.facing, ev.name, ev.face), 45000)
      // 红石粉有点状/十字两种形态，若与录制不一致就用右键切换
      if (ev.wire) await ensureWireShape(bot, x, y, z, ev.wire)
      await tick(bot)
      if (i % 20 === 0) console.log(`[AI]   复现进度 ${i}/${events.length}`)
    } else if (ev.t === 'ckpd') {
      // 玩家在录制时设置的检查点：这里核对快照里的格子
      const fixed = await checkCheckpoint(bot, ev.blocks || [], ox, oy, oz, ev.name)
      console.log(`[AI]   检查点「${ev.name || '未命名'}」校对完成，修正 ${fixed} 处`)
    } else if (ev.t === 'use') {
      // 交互：走到当时的位置，然后右键。
      // 关键：不要去还原记录里的绝对 yaw/pitch，而是**直接对准目标方块中心**右键 ——
      // 这样即使高度/站位有一点误差也能命中，比还原角度可靠得多。
      await M.moveToSmooth(bot, ox + ev.x + 0.5, oy + ev.y, oz + ev.z + 0.5)
      const tb = ev.tx != null ? bot.blockAt(new Vec3(ox + ev.tx, oy + ev.ty, oz + ev.tz)) : null
      if (tb && tb.name !== 'air') {
        try {
          await bot.lookAt(tb.position.offset(0.5, 0.5, 0.5), true)
          // 右键前先停 0.1s：动作太快会误触（例如把中继器的延迟点多了）
          await M.sleep(100)
          await withTimeout(bot.activateBlock(tb), 6000) // 必须限时，否则一次卡住整段复现就废了
          console.log(`[AI]   复现交互: 右键 ${tb.name} @ (${tb.position.x},${tb.position.y},${tb.position.z})`)
        } catch (e) {
          console.error('[AI] 交互失败:', e && e.message)
        }
      } else {
        // 没记到目标方块：退回用记录的朝向右键一次
        try { await bot.look(ev.yaw, ev.pitch, true) } catch (e) { /* ignore */ }
        try { bot.swingArm('right') } catch (e) { /* ignore */ }
      }
      await bot.waitForTicks(3)
    } else if (ev.t === 'key') {
      // 空格 / Shift：与录制时按下/松开保持一致
      try { bot.setControlState(ev.key, ev.down) } catch (e) { /* ignore */ }
      await bot.waitForTicks(1)
    }
  }
  // 结束时务必松开按键，避免卡住
  for (const k of ['jump', 'sneak']) { try { bot.setControlState(k, false) } catch (e) { /* ignore */ } }
  const left = await cleanupAssists(bot)
  if (left) console.log('[AI] 已清理残留辅助方块 ' + left + ' 个')
  console.log(`[AI] 复现完成，本次放置 ${bot._batchPlaced || 0} 个`)
}

module.exports = {
  build, buildFromBlueprint, scanRegion, saveBlueprint, getBlueprint, listBlueprints,
  orderByProximity, cleanupAssists, readFacing, readFace, readStateValue, isFullBlock,
  placeBlocks, placeAt, isInteractiveBlock, candidateRefs,
  saveTeaching, getTeaching, listTeachings, replayTeaching, deleteSaved,
  readWireShape, ensureWireShape, checkCheckpoint, equipBlock, sizeOfSaved,
  readBlockStates, statesEqual,
  BLUEPRINT_DIR, TEACHING_DIR
}
