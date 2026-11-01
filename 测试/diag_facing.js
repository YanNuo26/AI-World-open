const { HOST, PORT, VERSION } = require('./_common')
const path = require('path')
const ROOT = path.join(__dirname, '..')
// Focused diagnostic: place ONE piston with a chosen facing and report every
// step so we can see exactly where placement / facing breaks.
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const bot = mineflayer.createBot({
  host: HOST, port: PORT, username: 'DiagBot', version: VERSION
})

const mcData = require('minecraft-data')(bot.version || VERSION)
function equipBlock (name) {
  const item = mcData.itemsByName[name]
  if (!item) throw new Error('Unknown block: ' + name)
  const PItem = require('prismarine-item')(bot.version || VERSION)
  const stack = new PItem(item.id, 1, 0)
  bot._client.write('set_creative_slot', { slot: 36, item: PItem.toNotch(stack) })
  bot._setSlot(36, stack)
  if (typeof bot.setQuickBarSlot === 'function') bot.setQuickBarSlot(0)
  else bot.quickBarSlot = 0
}

function readFacing (block) {
  if (!block || block.stateId == null) return null
  const b = mcData.blocksByName[block.name]
  if (!b || !b.states || !b.states.length) return null
  const idx = b.states.findIndex((s) => s.name === 'facing')
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
  return b.states[idx].values[value]
}

const FACING_VEC = {
  north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
  up: [0, 1, 0], down: [0, -1, 0]
}
const FACING_PITCH = { up: -90, down: 90 }

function withTimeout (p, ms) {
  let t
  const timer = new Promise((res) => { t = setTimeout(() => res('timeout'), ms); if (t.unref) t.unref() })
  return Promise.race([p, timer]).finally(() => clearTimeout(t))
}

async function flyTo (dest) {
  if (bot.creative && bot.creative.startFlying) bot.creative.startFlying()
  if (bot.creative && bot.creative.flyTo) {
    await withTimeout(bot.creative.flyTo(dest), 3000)
  }
  bot.entity.position = dest.clone()
  await bot.waitForTicks(1)
}

async function clearCell (b) {
  const blk = bot.blockAt(b)
  if (blk && blk.name !== 'air') {
    await flyTo(new Vec3(b.x + 1.5, b.y, b.z + 0.5))
    await bot.lookAt(b, true)
    await bot.waitForTicks(1)
    try { await bot.dig(blk) } catch (e) { console.log('[DIAG] dig err', e.message) }
    await bot.waitForTicks(3)
  }
}

async function placeTest (tx, ty, tz, facing, side) {
  await clearCell(new Vec3(tx, ty, tz))
  const v = FACING_VEC[facing]
  const center = new Vec3(tx + 0.5, ty + 0.5, tz + 0.5)
  const horizontal = v[0] !== 0 || v[2] !== 0
  const ref = bot.blockAt(new Vec3(tx, ty - 1, tz))
  console.log(`[DIAG] neighbour below (${tx},${ty - 1},${tz}) = ${ref && ref.name}`)
  if (!ref || ref.name === 'air') { console.log('[DIAG] no solid neighbour, skip'); return }
  const faceVec = new Vec3(0, 1, 0)

  if (!horizontal) {
    await flyTo(new Vec3(center.x, ty + 2.5, center.z))
    bot.look(0, FACING_PITCH[facing] * Math.PI / 180, true)
    await bot.waitForTicks(2)
  } else {
    const D = 2.0
    const spot = new Vec3(center.x - side * v[0] * D, ty, center.z - side * v[2] * D)
    await flyTo(spot)
    await bot.lookAt(center, true)
    await bot.waitForTicks(2)
  }
  equipBlock('piston')
  console.log(`[DIAG] facing=${facing} side=${side} T=(${tx},${ty},${tz}) pos=${bot.entity.position} yaw=${bot.entity.yaw.toFixed(3)} pitch=${bot.entity.pitch.toFixed(3)} ref=${ref.name}`)
  try {
    await withTimeout(bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore' }), 5000)
    console.log('[DIAG] place returned (no throw)')
  } catch (e) { console.log('[DIAG] place err', e.message) }
  await bot.waitForTicks(4)
  const placed = bot.blockAt(new Vec3(tx, ty, tz))
  const got = placed && placed.name === 'piston' ? readFacing(placed) : (placed && placed.name)
  console.log(`[DIAG] -> placed=${placed && placed.name} facing=${got} EXPECTED=${facing} ${got === facing ? 'OK' : 'WRONG'}`)
}

bot.on('spawn', async () => {
  try {
    await bot.waitForTicks(30)
    const pos = bot.entity.position.floored()
    let gy = pos.y
    for (let yy = pos.y; yy > pos.y - 64; yy--) {
      const b = bot.blockAt(new Vec3(pos.x, yy, pos.z))
      if (b && b.name !== 'air') { gy = yy; break }
    }
    console.log('[DIAG] spawn', pos, 'gy=', gy)
    const x0 = pos.x, z0 = pos.z
    // use columns offset from the bot's own column (which is occupied by the bot)
    await placeTest(x0 + 2, gy + 1, z0, 'east', -1)  // -F side (west), look east
    await placeTest(x0 + 2, gy + 1, z0, 'east', +1)  // +F side (east), look west
    await placeTest(x0 + 3, gy + 1, z0, 'north', -1) // -F side (south), look north
    await placeTest(x0 + 4, gy + 1, z0, 'up', 0)
  } catch (e) {
    console.error('[DIAG] FAIL', e && e.stack)
  }
  try { bot.end() } catch (e) {}
  setTimeout(() => process.exit(0), 500)
})
bot.on('error', (e) => { console.error('[DIAG] BOT ERR', e && e.message) })
setTimeout(() => { console.log('[DIAG] TIMEOUT'); process.exit(2) }, 90000)
