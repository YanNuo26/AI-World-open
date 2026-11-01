const fs = require('fs')
const path = require('path')
const Vec3 = require('vec3')
const mineflayer = require('mineflayer')
const { pathfinder } = require('mineflayer-pathfinder')
const {
  build, buildFromBlueprint, scanRegion, saveBlueprint, getBlueprint, listBlueprints,
  cleanupAssists, readFacing, readFace,
  saveTeaching, getTeaching, listTeachings, replayTeaching, deleteSaved, readWireShape,
  sizeOfSaved, readBlockStates
} = require('./build')
// 用 RCON 连到服务器控制台执行 /op —— bot 自己只是个玩家，没法给自己/别人 op
const { opPlayer, rconCommand } = require('./rcon')
// 所有移动统一走 movement.js 的 xyz 接口：
// 水平"看向移动方向 + W 键"、y 轴寻路、卡住走避障逻辑、走不通再 A* 兜底。
const M = require('./movement')
// 统一配置：连接信息 / RCON / 行为开关全部来自项目根 config.json（旧格式自动兼容）
// 另外支持命令行覆盖（临时连别人的服不用改文件），见 USAGE
const { load: loadConfig, summary: configSummary, isLocalHost, parseArgs } = require('./config')
// 准入（谁能指挥 / 谁能被 op）与失败诊断：纯逻辑，单独一个文件好做测试
const { canOp, canCommand, diagnose } = require('./access')
// 玩家登记：谁进过服 / 服主还是成员 / 他的初始 ai 叫什么（落盘到 配置/玩家登记.json）
// 面板「连接与权限」就是读这份文件来区分服主视角和非服主视角的
const 玩家登记 = require('./玩家登记')
// 日志：把控制台输出同时写进 日志/ai_<名字>.log（主 ai 以前完全没有文件日志）
const { initLogger } = require('./logger')
const { fork } = require('child_process')

// ===== 多 AI 注册表 =====
// 每个 AI 跑在**独立进程**里（bot.js 自身就是单实例结构，分进程最省事也最稳）。
// 主进程（第一个 AI）负责 summon / 删除，并把"当前有哪些 AI"写进 ais.json；
// 每个进程每次收到指令时读它，用来判断：
//   1) AI 数量 > 1 时，指令必须带自己的名字前缀才响应
//   2) 自己只听从 obey 名单里的玩家（默认 = 召唤者）
// ===== 聊天监视（落盘给面板看）=====
// 面板「连接与权限」的"聊天监视"读的是 日志/聊天.log（两个进程，落盘最省事）。
// 格式：`[HH:MM:SS] kind\t发送者\t内容`，kind = chat（玩家）/ ai（ai 自己说的）。
// 文件超过 256KB 时只留最后 64KB，防止长期跑爆盘。
const CHAT_LOG = path.join(__dirname, '..', '日志', '聊天.log')
const CHAT_LOG_MAX = 256 * 1024
function logChat (from, text, kind) {
  try {
    const d = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const line = '[' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '] ' +
      (kind || 'chat') + '\t' + String(from == null ? '' : from) + '\t' +
      String(text == null ? '' : text).replace(/[\r\n\t]+/g, ' ')
    if (fs.existsSync(CHAT_LOG) && fs.statSync(CHAT_LOG).size > CHAT_LOG_MAX) {
      const buf = fs.readFileSync(CHAT_LOG, 'utf8')
      fs.writeFileSync(CHAT_LOG, buf.slice(-64 * 1024), 'utf8')
    }
    fs.appendFileSync(CHAT_LOG, line + '\n', 'utf8')
  } catch (e) { /* 记聊天失败绝不影响正事 */ }
}

const AIS_FILE = path.join(__dirname, '..', 'ais.json')
const IS_WORKER = !!process.env.AI_WORKER

function readAis () {
  try { return JSON.parse(fs.readFileSync(AIS_FILE, 'utf8')) } catch (e) { return {} }
}
function writeAis (a) {
  try { fs.writeFileSync(AIS_FILE, JSON.stringify(a, null, 2)) } catch (e) { /* ignore */ }
}

// ===== 皮肤（summon <名字> <皮肤>）=====
// 前提：离线服本身不提供皮肤，要生效得服务器装了皮肤插件（最常见的是 SkinsRestorer）。
// 这里做的是"登记 + 让 AI 上线后自己执行换肤命令"这一层。
// skins.json 形如：
//   { "command": "/skin set {skin}", "skins": { "小红": "Notch", "小明": "https://xx/a.png" } }
// 未指定皮肤时从 skins 里随机挑一个（"随机离线皮肤"）。
const SKINS_FILE = path.join(__dirname, '..', 'skins.json')
function readSkins () {
  try { return JSON.parse(fs.readFileSync(SKINS_FILE, 'utf8')) } catch (e) {
    return { command: '/skin set {skin}', skins: {} }
  }
}
function pickSkin (want) {
  const cfg = readSkins()
  const map = cfg.skins || {}
  const keys = Object.keys(map)
  if (want) return map[want] || want // 没登记就把它本身当皮肤值(URL / 玩家名)
  if (!keys.length) return null
  return map[keys[Math.floor(Math.random() * keys.length)]] // 未指定 -> 随机
}

// ===== help：给玩家丢一本"指令手册" =====
// 内容刻意精简：整条 /give 命令走 RCON，长度仍要留余量
const HELP_PAGES = [
  'AI指令手册\nAIBuilder',
  'build <名字>\n复现教学/蓝图\nbuild <x> <y> <z>\n在指定坐标建造\nsave <名字>\n金块+钻石块框选保存',
  'teach <名字> 开始录制\nteach stop 结束保存\nteach ckpd 设检查点',
  'rep <名字> <x/y/z> <间隔> <数量>\n重复建造 -1=无限\nmark y/n 建造前标范围',
  'summon <名字> 召唤AI\nsummon <名字> del 删除\nsummon <名字> add <玩家>',
  'tpto / tpto x y z / tpto me\n传送与跟随\nstop 停止\nhelp 这本书\ndel/list 删除/查看'
]

async function giveHelpBook (bot, username) {
  // 1.21 用的是组件（不是旧 NBT）：written_book_content
  // 坑：SNBT 的单引号字符串**不认 \n**（只认 \\ 和引号转义），直接塞 JSON 会报
  // "Invalid escape sequence '\n'"。所以要把反斜杠再转义一层，
  // 让 SNBT 解析出 {"text":"a\nb"} 交给 JSON 文本组件去换行。
  const pages = HELP_PAGES.map((p) => "'" + JSON.stringify({ text: p }).replace(/\\/g, '\\\\') + "'").join(',')
  const item = `written_book[written_book_content={title:"AI指令手册",author:"AIBuilder",pages:[${pages}]}]`
  // !! 不能用 bot.chat !! 整条命令远超聊天 256 字上限，会被直接吞掉（实测过）。
  // 走 RCON 连控制台执行 /give。
  try {
    const res = await rconCommand(`/give ${username} ${item}`, rconOptions())
    console.log('[AI] /give 回显: ' + String(res || '').replace(/\s+/g, ' ').slice(0, 120))
  } catch (e) {
    console.error('[AI] help 书发送失败:', e && e.message)
    // 接别人的服基本都没有 RCON：别让玩家以为书已经到手了
    if (!cfg.rcon.enabled) {
      bot.chat('没有 RCON 权限，发不了成书（接别人的服一般都没有 RCON）。' +
        '指令列表看 文档/使用说明.md，常用: build / teach / tpto / stop')
    }
  }
}

// ===== 配置（统一走 源码/config.js，内容在项目根 config.json）=====
// 命令行 > config.json（临时连朋友的服：node 源码/bot.js --host play.example.com）
const cli = parseArgs(process.argv.slice(2))
if (cli.help) {
  console.log(cli.usage)
  process.exit(0)
}
for (const e of cli.errors) console.error('[AI] 参数有问题: ' + e)
const cfg = loadConfig(cli.overrides)
const HOST = cfg.server.host
const PORT = cfg.server.port
// 离线服：名字随便起（ai.name）；正版服：必须用账号邮箱登录，进服后的名字由账号决定
const AUTH = cfg.server.auth === 'microsoft' ? 'microsoft' : 'offline'
const LOGIN_NAME = AUTH === 'microsoft' ? (cfg.server.username || cfg.ai.name) : cfg.ai.name
// 第一个 AI 的默认名字就叫 world（玩家用 "world build ..." 这种形式下指令）
const USERNAME = cfg.ai.name
// version 写 'auto' 时交给 mineflayer 自动探测（要求服务器在线且 enable-status=true）
const VERSION = cfg.server.version === 'auto' ? undefined : cfg.server.version
// 本机自建服 vs 外部服务器：决定能不能自动 op（access.js 的 local-only 策略靠它）
const IS_LOCAL = isLocalHost(HOST)
// 日志文件名去掉 @ . 这类字符：正版登录时 ai.name 可能是个邮箱
const logName = String(USERNAME || 'world').replace(/[\\/:*?"<>|@\s]/g, '_')
// 日志：之后所有 console 输出都会同时落盘（主 ai / 子 ai 各写 日志/ai_<名字>.log）
initLogger(logName)
for (const w of (cfg._warnings || [])) console.warn(w)
console.log('[AI] 配置: ' + configSummary(cfg))

// RCON 参数只在这里拼一次，避免各处写死端口 / 密码
function rconOptions () {
  return {
    enabled: cfg.rcon.enabled,
    host: cfg.rcon.host,
    port: cfg.rcon.port,
    password: cfg.rcon.password
  }
}

// ===== 连接 / 重连 =====
// bot 用 let：断线重连会新建实例，业务函数里的闭包引用的是这个变量，自动指向新连接。
let bot = null
let reconnectDelay = 0
let reconnectTimer = null
let shuttingDown = false

function createAndAttach () {
  const opts = {
    host: HOST,
    port: PORT,
    username: LOGIN_NAME,
    version: VERSION
  }
  // 正版服（online-mode=true）：登录交给 mineflayer。
  // 第一次会打印一个**设备码**，用手机/浏览器打开链接输一次即可；
  // 令牌缓存在 profilesFolder（默认 服务器/nmp-cache），以后启动直接进服。
  // 注意：正版账号进服后名字由账号决定，config 里的 ai.name 就不再是游戏内名字了。
  if (AUTH === 'microsoft') {
    opts.auth = 'microsoft'
    if (cfg.server.profilesFolder) opts.profilesFolder = path.resolve(cfg.server.profilesFolder)
    opts.onMsaCode = (data) => {
      console.log('')
      console.log('=============== 正版登录（只需一次）===============')
      console.log(' ① 打开: ' + (data && data.verification_uri))
      console.log(' ② 输入: ' + (data && data.user_code))
      console.log(' 令牌会缓存，下次启动直接进服（见 profilesFolder）')
      console.log('==================================================')
      console.log('')
    }
  }
  bot = mineflayer.createBot(opts)
  bot.loadPlugin(pathfinder)
  // 建造前用红/蓝羊毛对角标出建造范围（默认值来自 config.json，mark n 可关）
  bot._markEnabled = cfg.behavior.markOnBuild !== false
  attachHandlers(bot)
  return bot
}

// 掉线后按指数退避重连（1s → 2s → 4s … 封顶 config.behavior.reconnect.maxDelayMs）。
// 以前掉线只是打印一行，服务器一重启就得人工把 ai 也重启一遍。
function scheduleReconnect (reason) {
  const rc = (cfg.behavior && cfg.behavior.reconnect) || {}
  if (shuttingDown || rc.enabled === false || reconnectTimer) return
  reconnectDelay = Math.min(reconnectDelay ? reconnectDelay * 2 : 1000, rc.maxDelayMs || 30000)
  const secs = Math.round(reconnectDelay / 1000)
  console.log('[AI] ' + secs + ' 秒后尝试重连（原因: ' + (reason || '未知') + '）')
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (shuttingDown) return
    console.log('[AI] 正在重连 ' + HOST + ':' + PORT + ' ...')
    try {
      createAndAttach()
    } catch (e) {
      console.error('[AI] 重连失败: ' + (e && e.message))
      scheduleReconnect(e && e.message)
    }
  }, reconnectDelay)
}

// Safety net: a single stray error should not kill the whole process (and the server)
process.on('uncaughtException', (e) => console.error('[AI] uncaught (kept alive):', e && e.message))
process.on('unhandledRejection', (e) => console.error('[AI] unhandledRejection (kept alive):', e && e.message))

let saveMode = null // { name, username, corners: [] }
let teachMode = null // { name, username, origin, events[], lastPos, timer }

// ===== 教学模式：记录玩家的操作 / 移动 / 交互顺序 =====

// 从 origin 沿 yaw/pitch 做一次简单射线步进，找出准星指向的方块
function raycastTarget (bot, origin, yaw, pitch, maxDist = 5) {
  // 方向向量（mineflayer 的 entity.yaw/pitch 约定）：
  //   水平: dx = -sin(yaw), dz = -cos(yaw)   （与 lookAt 的 atan2(-dx,-dz) 互为逆运算，已实测对齐）
  //   垂直: dy =  sin(pitch)                  —— 正值向上。实测：看向脚下方块时 pitch 为负。
  //   注意别写成 -sin(pitch)：符号反了射线会朝上飞，永远打不到脚下的方块。
  const dx = -Math.sin(yaw) * Math.cos(pitch)
  const dy = Math.sin(pitch)
  const dz = -Math.cos(yaw) * Math.cos(pitch)
  for (let t = 0; t <= maxDist; t += 0.1) {
    const bx = Math.floor(origin.x + dx * t)
    const by = Math.floor(origin.y + dy * t)
    const bz = Math.floor(origin.z + dz * t)
    const b = bot.blockAt(new Vec3(bx, by, bz))
    if (b && b.name !== 'air') return { x: bx, y: by, z: bz }
  }
  return null
}

function startTeaching (name, username) {
  // !! 连续录制必须先结束上一段 !!
  // 否则上一段的采样定时器还活着：它的闭包持有**上一段**的 origin，
  // 却会往**新**的 events 里继续塞数据 —— 两段录制被串在一起，坐标也全乱。
  if (teachMode) stopTeaching()

  const up = userPos(username)
  const origin = up ? { x: up.x, y: up.y, z: up.z } : { x: 0, y: 0, z: 0 }
  teachMode = {
    name, username, origin, events: [],
    lastPos: null, lastY: null, jumpDown: false, timer: null,
    pauseUntil: 0 // 玩家开着聊天框期间不记录
  }
  // 采样玩家移动。阈值取得比较小（0.5 格 / 200ms）才能把路线记细，
  // 否则复现时两点之间直接连直线，轨迹就和玩家走的不一样了。
  teachMode.timer = setInterval(() => {
    if (!teachMode) return
    // 玩家打开聊天框时不记录（服务器不广播"打开聊天"这个动作，
    // 只能以"他发来了聊天消息"作为信号，之后短暂忽略一段时间）
    if (Date.now() < teachMode.pauseUntil) return
    const p = bot.players[teachMode.username]
    if (!p || !p.entity) return
    const pp = p.entity.position

    // 空格（创造模式里 = 上升）：检测到持续升高就记成"按住空格"，
    // 复现时同样按住空格，保证按键与录制一致。
    const rising = teachMode.lastY != null && (pp.y - teachMode.lastY) > 0.08
    if (rising && !teachMode.jumpDown) {
      teachMode.jumpDown = true
      teachMode.events.push({ t: 'key', ts: Date.now(), key: 'jump', down: true })
    } else if (!rising && teachMode.jumpDown) {
      teachMode.jumpDown = false
      teachMode.events.push({ t: 'key', ts: Date.now(), key: 'jump', down: false })
    }
    teachMode.lastY = pp.y

    const last = teachMode.lastPos
    if (!last || pp.distanceTo(last) > 0.5) {
      teachMode.lastPos = pp.clone()
      teachMode.events.push({
        t: 'move', ts: Date.now(),
        x: pp.x - origin.x, y: pp.y - origin.y, z: pp.z - origin.z
      })
    }
  }, 200)
  bot.chat('教学模式开始：记录你的移动、空格/Shift、放置方块、右键交互。中途可用 teach ckpd 设检查点，完成输入 teach stop 保存')
}

// Shift（潜行）：mineflayer 会从实体元数据里给出 entityCrouch / entityUncrouch
function recordTeachKey (entity, key, down) {
  if (!teachMode) return
  if (!entity || entity.username !== teachMode.username) return
  teachMode.events.push({ t: 'key', ts: Date.now(), key, down })
}

// 检查点快照：把"到目前为止放置过的方块"按坐标去重记一份（同一格取最后一次）。
// 复现进行到检查点时，会拿这份快照核对一遍。
function buildCheckpointSnapshot () {
  if (!teachMode) return []
  const byPos = new Map()
  for (const e of teachMode.events) {
    if (e.t !== 'place') continue
    // 同时记下这一刻方块的**全部状态**（powered / delay / mode …）。
    // 否则可交互方块被右键改了状态，检查点只看名字/朝向是查不出来的。
    let states = null
    try {
      const o = teachMode.origin
      states = readBlockStates(bot, bot.blockAt(new Vec3(o.x + e.dx, o.y + e.dy, o.z + e.dz)))
    } catch (err) { states = null }
    byPos.set(e.dx + ',' + e.dy + ',' + e.dz, {
      dx: e.dx, dy: e.dy, dz: e.dz,
      name: e.name, facing: e.facing, face: e.face, wire: e.wire, states
    })
  }
  return Array.from(byPos.values())
}

// 放方块时客户端会顺带发一次挥臂动画，服务器也会广播出来，于是同一个动作会被
// 记成 place + use 两条。复现时会多右键一次（比如拉杆被多切一下、状态正好切回去）。
// 这里按时间戳过滤掉紧贴 place 的 use（不依赖事件到达顺序）。
const PLACE_SWING_MS = 700
function dropPlaceSwings (events) {
  return events.filter((e) => {
    if (e.t !== 'use') return true
    return !events.some((p) => p.t === 'place' && Math.abs((p.ts || 0) - (e.ts || 0)) <= PLACE_SWING_MS)
  })
}

function stopTeaching () {
  if (!teachMode) return null
  clearInterval(teachMode.timer)
  // 结束时确保没有卡住的按键（空格/Shift 可能停在按下状态）
  for (const k of ['jump', 'sneak']) { try { bot.setControlState(k, false) } catch (e) { /* ignore */ } }
  const name = teachMode.name
  let events = dropPlaceSwings(teachMode.events)
  // 收尾：若最后还留着"按住"状态，补一个松开事件，避免复现后按键卡住
  if (events.some((e) => e.t === 'key' && e.key === 'jump' && e.down)) {
    const lastJump = [...events].reverse().find((e) => e.t === 'key' && e.key === 'jump')
    if (lastJump && lastJump.down) events = events.concat([{ t: 'key', ts: Date.now(), key: 'jump', down: false }])
  }
  saveTeaching(name, { name, events })
  console.log(`[AI] 教学已保存: ${name}，共 ${events.length} 个事件`)
  teachMode = null
  return { name, count: events.length }
}

// Floored position of a given player (the human user)
function userPos (username) {
  const p = bot.players[username]
  if (!p || !p.entity) return null
  return p.entity.position.floored()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 去某个地点：统一 xyz（垂直对齐 → 水平看方向+W → 必要时 A* 兜底）
async function goTo (x, y, z) {
  return await M.moveTo(bot, x, y, z)
}

// 开始一个新任务前必须调用：清掉上一次 stop 留下的中止标志。
// !! 不这么做就会"stop 之后 AI 再也动不了"：_aiAbort 一旦为 true，
//    moveHorizontal / moveVertical / pathfindXYZ 全部立刻 return false，
//    于是赶路、传送、跟随全都静默失效（AI 看着像卡死、不响应指令）。
function beginTask (bot) {
  bot._aiAbort = false
}

// 传送指令也走同一套 xyz 移动（不再直接改写坐标）
async function teleportTo (x, y, z) {
  M.ensureFlying(bot)
  await M.moveTo(bot, x + 0.5, y + 1, z + 0.5)
}

// 传送到某个玩家身边。
// 坑：玩家超出 AI 的可见/模拟距离后，服务器不再同步他的实体，
// bot.players[name].entity 直接是 undefined -> userPos() 返回 null，
// AI 就只能回"找不到你的位置，请靠近一些"（玩家看到的就是"说距离太远"）。
// 这时改用服务器 /tp（AI 有 op），不受可见距离限制。
async function teleportToPlayer (username) {
  const up = userPos(username)
  if (up) {
    await teleportTo(up.x, up.y, up.z)
    return '已传送到你身边'
  }
  try {
    const res = await rconCommand(`/tp ${bot.username} ${username}`, rconOptions())
    const out = String(res || '')
    console.log('[AI] /tp 回显: ' + out.replace(/\s+/g, ' ').slice(0, 120))
    if (/no player|unknown|couldn/i.test(out)) return null
    await bot.waitForTicks(20) // 等服务器把新坐标推回来
    return '你超出了我的可见范围，已用服务器 /tp 直接过去'
  } catch (e) {
    console.error('[AI] /tp 失败:', e && e.message)
    return null
  }
}

// 跟随玩家，保持在 5 格内。用 followToken 自增来取消。
let followToken = 0
function cancelFollow () { followToken++ }
async function startFollow (username) {
  beginTask(bot) // stop 之后重新跟随：必须先清掉中止标志，否则循环立刻退出
  followToken++
  const myToken = followToken
  let landed = false // 已经落地就不要每 400ms 重复降一次
  bot.chat('开始跟随你（保持 5 格内，靠近会落地），用 stop 或 tpto 取消')
  console.log('[AI] follow START for', username, 'token', myToken)
  while (myToken === followToken) {
    if (bot._aiAbort) break
    const p = bot.players[username]
    if (p && p.entity) {
      const pp = p.entity.position
      const bp = bot.entity.position
      const dist = bp.distanceTo(pp)
      // 追人的时候飞，跟上了（<=5，当然也在 7 格内）就落地，别一直悬在空中。
      // 注意别写成 "dist<=7 就落地" 又在 "dist>5" 里起飞 —— 5~7 这段会来回抖。
      if (dist <= 5) {
        if (!landed) {
          await M.landOnGround(bot, { timeoutMs: 10000 })
          landed = true
        }
      } else {
        if (landed) { M.ensureFlying(bot); landed = false } // 走远了重新起飞
        // 停在玩家身边约 4 格处（沿当前所在方向），再走统一 xyz 移动过去
        const dx = bp.x - pp.x, dy = bp.y - pp.y, dz = bp.z - pp.z
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
        const target = new Vec3(pp.x + (dx / len) * 4, pp.y + 1, pp.z + (dz / len) * 4)
        // 容差要收紧：moveTo 会把 tolerance 同时用于水平和垂直，
        // 放太宽（比如 4）会让 3D 距离达到 ~5.7，撑破"5 格内"的要求。
        // 超时要给足：玩家跑远时单次移动可能要飞二三十格，
        // 超时太短会导致每次都半途而废、看起来"跟不上"。
        await M.moveTo(bot, target.x, target.y, target.z, { tolerance: 2, timeoutMs: 25000 })
      }
    }
    await sleep(400)
  }
  console.log('[AI] follow STOP token', myToken, 'current', followToken)
}

async function handleBuild (username, spec) {
  cancelFollow()
  beginTask(bot) // 清掉上一次 stop 的中止标志，否则连"赶去建造地点"都会被挡住
  try {
    // 目标点一律是完整的 xyz
    let target
    if (spec.coords) {
      target = new Vec3(spec.coords.x, spec.coords.y, spec.coords.z)
    } else {
      const up = userPos(username)
      if (!up) {
        // 同上：玩家超出可见范围时先 /tp 过去，再以自己所在位置作为建造点
        const msg = await teleportToPlayer(username)
        if (!msg) { bot.chat('找不到你的位置，请靠近一些再试'); return }
        target = bot.entity.position.floored()
      } else {
        target = up
      }
    }
    bot.chat('正在前往建造地点 (' + target.x + ',' + target.y + ',' + target.z + ')...')
    await goTo(target.x, target.y, target.z)

    // build <x> <y> <z>：把指定坐标作为建造基准点，默认建筑才会真的在这个高度开工
    if (spec.coords) spec.origin = target
    await doBuild(username, spec)
  } catch (err) {
    if (err && err.message === 'AI_ABORT') {
      await cleanupAssists(bot) // 中止时也要拆掉临时辅助方块
      bot.chat('已停止建造')
      return
    }
    console.error('[AI] Build error:', err)
    bot.chat('建造出错: ' + (err && err.message ? err.message : err))
  }
}

// 真正执行建造（假定 bot 已在附近）。origin 可显式指定，供 rep 重复建造时偏移用。
async function doBuild (username, spec) {
  const target = spec.origin || bot.entity.position.floored()
  try {
    if (spec.blueprint) {
      // 教学过程优先：同名教学存在时按"过程"复现，否则按蓝图复现
      const teach = getTeaching(spec.blueprint)
      if (teach) {
        bot.chat('开始复现教学: ' + spec.blueprint)
        await replayTeaching(bot, teach, target)
        bot.chat('复现完成！本次放置 ' + (bot._batchPlaced || 0) + ' 个方块')
        return
      }
      const bp = getBlueprint(spec.blueprint)
      if (!bp) { bot.chat('没有这个蓝图或教学: ' + spec.blueprint + '（用 list 查看已有）'); return }
      bot.chat('开始按蓝图建造: ' + spec.blueprint)
      await buildFromBlueprint(bot, bp, target)
    } else {
      bot.chat('开始建造默认建筑...')
      // 显式指定建造基准点（xyz），这样 build <x> <y> <z> 才会真的在指定高度开工
      const opts = Object.assign({}, cfg.building)
      if (spec.origin) opts.origin = { x: target.x, y: target.y, z: target.z }
      await build(bot, opts)
    }
    bot.chat('建造完成！本次放置 ' + (bot._batchPlaced || 0) + ' 个，累计 ' + (bot._totalPlaced || 0) + ' 个方块')
  } catch (err) {
    if (err && err.message === 'AI_ABORT') {
      await cleanupAssists(bot) // 中止时也要拆掉临时辅助方块
      bot.chat('已停止建造')
      return
    }
    console.error('[AI] Build error:', err)
    bot.chat('建造出错: ' + (err && err.message ? err.message : err))
  }
}

// rep <名字> <方向 x/y/z> <间隔> <数量(-1=无限)>
// 计算建筑尺寸，按"尺寸+间隔"沿指定方向重复建造。
const REP_MAX = 500 // 无限模式的安全上限，防止失控把服务器建爆
async function handleRep (username, parts) {
  const name = parts[1]
  const axis = (parts[2] || '').toLowerCase()
  if (!name || !['x', 'y', 'z'].includes(axis)) {
    bot.chat('用法: rep <名字> <方向 x/y/z> <间隔> <数量>  (-1 表示无限，用 stop 停止)')
    return
  }
  const interval = parseInt(parts[3], 10)
  const count = parseInt(parts[4], 10)
  if (isNaN(interval) || isNaN(count)) {
    bot.chat('用法: rep <名字> <方向 x/y/z> <间隔> <数量>  例如: rep 房子 x 2 5')
    return
  }
  const info = sizeOfSaved(name)
  if (!info) { bot.chat('没有这个蓝图或教学: ' + name + '（用 list 查看已有）'); return }

  const size = info.size[axis]
  const step = size + interval
  if (step <= 0) { bot.chat('间隔 + 尺寸 必须大于 0（当前尺寸 ' + size + '，间隔 ' + interval + '）'); return }
  const infinite = count === -1
  const total = infinite ? REP_MAX : count
  if (count === 0) { bot.chat('数量为 0，什么都不做'); return }

  cancelFollow()
  beginTask(bot)
  const up = userPos(username)
  const base = up || bot.entity.position.floored()
  bot.chat(`开始重复建造「${name}」：沿 ${axis} 轴每隔 ${step} 格（尺寸 ${size} + 间隔 ${interval}），共 ${infinite ? '无限' : count} 个`)
  console.log(`[AI] rep ${name} axis=${axis} size=${size} interval=${interval} step=${step} count=${count}`)

  let built = 0
  try {
    for (let i = 0; i < total; i++) {
      if (bot._aiAbort) break
      const off = i * step
      const origin = new Vec3(
        base.x + (axis === 'x' ? off : 0),
        base.y + (axis === 'y' ? off : 0),
        base.z + (axis === 'z' ? off : 0)
      )
      if (i > 0) {
        // 先赶去下一个建造点（远了会自动传送）
        await goTo(origin.x, origin.y, origin.z)
      } else {
        await goTo(base.x, base.y, base.z)
      }
      await doBuild(username, { blueprint: name, origin })
      built++
      console.log(`[AI]   rep 第 ${built} 个完成 @ (${origin.x},${origin.y},${origin.z})`)
    }
  } catch (err) {
    if (err && err.message !== 'AI_ABORT') {
      console.error('[AI] Rep error:', err)
      bot.chat('重复建造出错: ' + (err && err.message ? err.message : err))
    }
  }
  if (bot._aiAbort) {
    await cleanupAssists(bot)
    bot.chat('已停止重复建造，本次完成 ' + built + ' 个')
    return
  }
  bot.chat(`重复建造完成，共 ${built} 个，累计放置 ${bot._totalPlaced || 0} 个方块`)
}

async function finishSave (name, username, corners) {
  try {
    const c1 = corners[0]
    const c2 = corners[1]
    const cx = Math.floor((c1.x + c2.x) / 2)
    const cy = Math.floor((c1.y + c2.y) / 2)
    const cz = Math.floor((c1.z + c2.z) / 2)
    bot.chat('正在扫描区域...')
    // Fly straight above the build (no walking) so we never break the building,
    // then wait a moment for the chunks around it to load before reading blocks.
    const maxY = Math.max(c1.y, c2.y)
    await M.moveTo(bot, cx + 0.5, maxY + 3.5, cz + 0.5)
    await bot.waitForTicks(20)
    const blocks = await scanRegion(bot, c1, c2, ['gold_block', 'diamond_block'])
    saveBlueprint(name, blocks)
    if (bot.creative && bot.creative.stopFlying) bot.creative.stopFlying()
    bot.chat('已保存蓝图 ' + name + '，共 ' + blocks.length + ' 个方块。用 "build ' + name + '" 在任意位置复现')
  } catch (err) {
    console.error('[AI] Save error:', err)
    bot.chat('保存失败: ' + (err && err.message ? err.message : err))
  }
}

// ===== 主进程：管理子 AI 进程 =====
const children = new Map() // name -> ChildProcess

function summonAI (name, owner, skin) {
  if (children.has(name)) return false
  // 子 ai 自己会初始化 logger 写 日志/ai_<名字>.log，所以这里不再 pipe 到文件（否则会写两遍），
  // 用 inherit 让它的输出也直接进当前控制台，方便看着。
  const child = fork(path.join(__dirname, 'bot.js'), [], {
    env: { ...process.env, MC_USER: name, AI_WORKER: '1', AI_OWNER: owner || '', AI_SKIN: skin || '' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })
  child.on('exit', () => {
    children.delete(name)
    const a = readAis(); delete a[name]; writeAis(a)
  })
  children.set(name, child)
  const a = readAis()
  // pid 一起登记：面板「启动 / 停止」靠它判断这个 ai 还在不在（见 源码/panel/api/_procs.js）
  a[name] = { owner: owner || null, obey: owner ? [owner] : [], pid: child.pid, since: Date.now() }
  writeAis(a)
  return true
}

function dismissAI (name) {
  const c = children.get(name)
  if (c) { try { c.kill('SIGKILL') } catch (e) { /* ignore */ } children.delete(name) }
  const a = readAis(); delete a[name]; writeAis(a)
}

// 主 AI 启动时把自己登记进 ais.json
if (!IS_WORKER) {
  // 重置注册表：进程重启后子 AI 本来就不在了，留着旧名字会让"是否需要前缀"判断出错
  writeAis({ [USERNAME]: { owner: null, obey: [] } }) // 主 AI 默认听从所有人
}

// ===== 给玩家 op =====
// 注：`opped` 放在 attachHandlers 外面，重连后不会重复发 op（名单也在 服务器/ops.json 里）。
// !! 这里必须过策略 !!
// 以前是"谁进服就给谁 op" —— 连自己的服没事，连**别人**的服就等于把服务器交出去。
// 现在默认 autoOp=local-only：只有连本机自建服时才 op（策略见 源码/access.js）。
const opped = new Set()
const opSkipped = new Set() // 同一条拒绝原因只提示一次，别刷屏
async function ensureOp (username) {
  if (!username || opped.has(username)) return
  if (!cfg.rcon.enabled) {
    if (!opSkipped.has('rcon-off')) {
      opSkipped.add('rcon-off')
      console.log('[AI] RCON 已关闭，不会自动 op（op / help 发书 / 远距离 tp 不可用，其余功能正常）')
    }
    return
  }
  const verdict = canOp({
    policy: cfg.ai.autoOp,
    username,
    whitelist: cfg.ai.opWhitelist,
    isLocal: IS_LOCAL
  })
  if (!verdict.ok) {
    if (!opSkipped.has(verdict.reason)) {
      opSkipped.add(verdict.reason)
      console.log('[AI] 跳过自动 op（' + verdict.reason + '）')
    }
    return
  }
  opped.add(username)
  await opPlayer(username, rconOptions())
}

// ===== 玩家登记 =====
// 谁进过服 / 是服主还是成员 / 初始 ai 叫什么 —— 记到 配置/玩家登记.json，
// 面板「连接与权限」分服主 / 非服主两种视角展示，就是靠这份记录。
// 同一个玩家一次进程里只写一次盘（进服事件 + 已经在线的玩家都会调到这里）。
const registeredPlayers = new Set()
// 聊天里认出过的 ai 名字（每个只处理一次，避免每条消息都读写 ais.json）
const seenAiChatters = new Set()
function recordPlayerJoin (username) {
  const key = String(username || '').trim().toLowerCase()
  if (!key || registeredPlayers.has(key)) return
  registeredPlayers.add(key)
  try {
    const r = 玩家登记.recordJoin({
      host: HOST,
      port: PORT,
      username,
      ownerName: cfg.ai.owner,
      guestPrefix: cfg.ai.guestPrefix,
      // 主 ai 自己的名字也要能识别（它上线同样会触发 playerJoined）
      mainName: USERNAME
    })
    if (r && r.isAi) {
      // 上线的是个 ai（主 ai / summon 出来的 / 手动起的 way-xxx）：
      // 不记成玩家，并把"它属于谁"补进 ais.json —— 面板靠 owner 把 ai 归到正确的人名下
      const owner = r.owner || 玩家登记.inferOwner(username, {
        mainName: USERNAME, guestPrefix: cfg.ai.guestPrefix
      })
      const added = attributeAi(username, owner)
      console.log('[AI] ' + username + ' 是 ai（' + r.reason + '）' +
        (owner ? '，归到「' + owner + '」名下' : '，没能判断归属') +
        (added ? '（已写进 ais.json）' : '') +
        (r.removed && r.removed.length ? '；顺手清掉误记成玩家的 ' + r.removed.length + ' 条' : ''))
      return
    }
    if (r && r.isNew) {
      console.log('[AI] 记下玩家 ' + username + '（' + (r.player.role === 'owner' ? '服主' : '成员') + '）' +
        (r.player.aiName ? '，初始 ai 名 ' + r.player.aiName : '') +
        ' → 配置/玩家登记.json')
    }
  } catch (e) {
    console.log('[AI] 玩家登记失败（不影响使用）：' + (e && e.message))
  }
}

// 把"这个 ai 属于谁"写进 ais.json。
// 只在**没有 owner** 时补，绝不覆盖 summon 时记下的归属；主 ai 是共用的，不写。
function attributeAi (name, owner) {
  const nm = String(name == null ? '' : name).trim()
  const ow = String(owner == null ? '' : owner).trim()
  if (!nm || !ow) return false
  if (nm.toLowerCase() === String(USERNAME).toLowerCase()) return false
  const a = readAis()
  const key = Object.keys(a).find((k) => k.toLowerCase() === nm.toLowerCase())
  if (key) {
    if (a[key] && a[key].owner) return false
    a[key] = Object.assign({}, a[key], { owner: ow })
  } else {
    a[nm] = { owner: ow, obey: [] }
  }
  writeAis(a)
  return true
}

// ===== 别名（alias）=====
// 初始 ai 名字固定，成员用别名指挥自己的 ai（见 源码/玩家登记.js 的 setAlias）。
// 这里负责两件事：
//   1) 查自己的别名（带 5 秒缓存：每条聊天都读一次文件没必要）
//   2) 上线时把别名报给主 ai（R3），主 ai 记录 + 写日志，服主面板就能对上号
let aliasCache = { at: 0, name: '', alias: '' }
function currentAlias () {
  const me = bot && bot.username ? bot.username : ''
  if (!me) return ''
  const now = Date.now()
  if (aliasCache.name === me && now - aliasCache.at < 5000) return aliasCache.alias
  let alias = ''
  try {
    const hit = 玩家登记.findByAiName(HOST, PORT, me)
    if (hit && hit.alias) alias = String(hit.alias)
  } catch (e) { /* 登记读不到就当没别名 */ }
  aliasCache = { at: now, name: me, alias }
  return alias
}

// 初始 ai 上线：告诉主 ai "我的别名是什么"
function announceAlias () {
  if (!bot || !bot.username) return
  if (bot.username.toLowerCase() === String(USERNAME).toLowerCase()) return // 主 ai 自己不用报
  const alias = currentAlias()
  if (!alias) return
  const line = USERNAME + ' alias ' + bot.username + ' ' + alias
  setTimeout(() => {
    try {
      bot.chat(line)
      console.log('[AI] 已向主 ai ' + USERNAME + ' 报告别名：「' + alias + '」（' + bot.username + '）')
    } catch (e) { /* ignore */ }
  }, 2500)
}
if (!cfg.ai.owner) {
  console.log('[AI] 提示：config.json 的 ai.owner 还是空的 → 所有进服的人都会被记成「成员」，' +
    '面板里分不出谁是服主（在「连接与权限」里填上你自己的游戏名即可）')
}

// ===== 事件绑定 =====
// 踢人原因转纯文本：可能是字符串，也可能是聊天组件
// （1.21 常见的翻译组件长这样：{ translate: 'multiplayer.disconnect.not_whitelisted' }）
// 不转成文本的话，日志里只能看到一坨对象，诊断规则也匹配不上。
function kickText (reason) {
  if (reason == null) return ''
  if (typeof reason === 'string') return reason
  const walk = (o) => {
    if (o == null) return ''
    if (typeof o === 'string') return o
    if (typeof o === 'number' || typeof o === 'boolean') return String(o)
    if (Array.isArray(o)) return o.map(walk).join('')
    let s = ''
    if (typeof o.text === 'string') s += o.text
    if (typeof o.translate === 'string') s += o.translate
    if (o.with) s += ' ' + walk(o.with)
    if (o.extra) s += ' ' + walk(o.extra)
    if (o.value) s += ' ' + walk(o.value)
    return s
  }
  let out = ''
  try { out = walk(reason).trim() } catch (e) { out = '' }
  if (out) return out
  try { return JSON.stringify(reason) } catch (e) { return String(reason) }
}

// 所有事件都挂在这个函数里。断线重连会新建一个 bot 实例，重新调用一次即可。
// （函数体保持原有缩进，纯粹是为了这次改动 diff 最小、不引入无关变更）
function attachHandlers (bot) {
bot.on('chat', async (username, message) => {
  // 聊天监视：先落盘（面板「连接与权限」读它），自己的话也记（kind=ai）
  logChat(username, message, username === bot.username ? 'ai' : 'chat')
  if (username === bot.username) return // ignore our own messages

  // 聊天里第一次见到的 ai：它可能比我先上线（playerJoined 没赶上），
  // 这里按名字把归属补进 ais.json —— 面板「名下的 ai」才能归对人。每个名字只试一次。
  const chatKey = String(username || '').toLowerCase()
  if (chatKey && !seenAiChatters.has(chatKey)) {
    seenAiChatters.add(chatKey)
    const cls = 玩家登记.classifyName(username, { mainName: USERNAME, guestPrefix: cfg.ai.guestPrefix })
    if (cls.isAi) {
      const owner = cls.owner || 玩家登记.inferOwner(username, { mainName: USERNAME, guestPrefix: cfg.ai.guestPrefix })
      const added = attributeAi(username, owner)
      console.log('[AI] 聊天里认出 ai ' + username + (owner ? '（属于 ' + owner + '）' : '（没能判断归属）') +
        (added ? '，已写进 ais.json' : ''))
    }
  }

  // ===== 多 AI 路由 =====
  const myName = bot.username
  const ais = readAis()
  let msg = (message || '').trim()
  // **一律**要求名字前缀（哪怕只有一个 AI）：
  // 否则玩家正常聊天里出现 "build" / "stop" 之类的词就会被当成指令，很打扰人。
  // 2026-11-01 起：**别名也算前缀** —— 成员给自己的初始 ai 起了别名（如「小A」），
  //   游戏里 "小A build ..." 和 "way-alice build ..." 等价（别名存 配置/玩家登记.json）。
  const first = msg.split(/\s+/)[0]
  const firstLow = first.toLowerCase()
  const ali = currentAlias()
  const isMine = firstLow === myName.toLowerCase() || (!!ali && firstLow === ali.toLowerCase())
  if (!isMine) return
  msg = msg.slice(first.length).trim()
  if (!msg) { bot.chat('我是 ' + myName + '，要我做啥？输入 ' + myName + ' help 看指令'); return }
  // 只听从名单里的玩家：
  //   ais.json 的 obey（召唤时默认 = 召唤者）
  //   config.json 的 ai.obeyWhitelist（服主设的总白名单，公共服必填）
  // 两个都为空 = 听从所有人（本机自建服的老行为）
  const mine = ais[myName]
  const permit = canCommand({ username, obey: mine && mine.obey, allow: cfg.ai.obeyWhitelist })
  if (!permit.ok) {
    // 不回话：公共服上每个路人都回一句会刷屏，日志留一条就够
    console.log('[AI] 忽略 ' + username + ' 的指令：' + permit.reason)
    return
  }
  // 能指挥 ai 的人顺手登记一下（防 bot 上线前就在线 / 玩家列表没同步到的情况）
  recordPlayerJoin(username)

  // 玩家发来聊天 => 他刚开着聊天框。录制期间忽略这一小段时间的动作。
  if (teachMode && username === teachMode.username) teachMode.pauseUntil = Date.now() + 1500
  // 注意用 msg（多 AI 时已剥掉名字前缀），不是原始 message
  const parts = msg.split(/\s+/)
  let cmd = (parts[0] || '').toLowerCase()
  // 常见拼写错误自动纠正：否则玩家打成 bulid 时 AI 一声不吭，会以为它坏了
  const TYPO = {
    bulid: 'build', buld: 'build', biuld: 'build', buil: 'build', bild: 'build', bluid: 'build',
    teahc: 'teach', tach: 'teach', taech: 'teach',
    hepl: 'help', hlep: 'help', halp: 'help',
    sumon: 'summon', summn: 'summon', summen: 'summon', summonn: 'summon',
    repaet: 'rep', repat: 'rep',
    stpo: 'stop', sotp: 'stop',
    deleet: 'del', dle: 'del'
  }
  if (TYPO[cmd]) cmd = TYPO[cmd]

  if (cmd === 'alias') {
    // 子 ai 上线时会发 `<主ai> alias <ai名> <别名>`（见 announceAlias）。
    // 只做"核对 + 记录 + 日志"：别名以 配置/玩家登记.json 为准，对不上就提醒。
    // 服主面板的「ai 一览 / 聊天监视」就是靠这条记录把 ai 和玩家对上号的。
    const who = String(parts[1] || '').trim()
    const al = parts.slice(2).join(' ').trim()
    if (!who || !al) { bot.chat('用法（供 ai 内部使用）: alias <ai名> <别名>'); return }
    if (IS_WORKER) return
    let official = ''
    try {
      const hit = 玩家登记.findByAiName(HOST, PORT, who)
      official = hit ? String(hit.alias || '') : ''
    } catch (e) { /* ignore */ }
    // 记到 ais.json（面板显示用；真正的来源仍是玩家登记）
    const a2 = readAis()
    const key2 = Object.keys(a2).find((k) => k.toLowerCase() === who.toLowerCase())
    if (key2 && official) {
      a2[key2] = Object.assign({}, a2[key2], { alias: official })
      writeAis(a2)
    }
    const ok = official && official.toLowerCase() === al.toLowerCase()
    console.log('[AI] ' + who + ' 报告的别名：' + al + (ok
      ? '（与登记一致）'
      : '（⚠ 与登记不一致，登记里是「' + (official || '空') + '」）'))
    if (ok) bot.chat('收到：' + who + ' 的别名是「' + official + '」')
    else bot.chat('注意：' + who + ' 报的别名「' + al + '」和面板里登记的不一样（面板：' + (official || '空') + '）')
  } else if (cmd === 'help') {
    await giveHelpBook(bot, username)
    bot.chat('指令手册给你了（书在背包里，右键翻开）')
  } else if (cmd === 'summon') {
    // 多 AI 管理（只有主 AI 负责，子 AI 不处理）
    const name = parts[1]
    if (!name) { bot.chat('用法: summon <名字> 添加AI；summon <名字> del 删除；summon <名字> add <玩家>'); return }
    if (IS_WORKER) { bot.chat('请让主 AI ' + myName + ' 来召唤'); return }
    // 正版登录时所有进程共用同一个账号：再开一个会被服务器判成"重复登录"互相踢下线
    if (AUTH === 'microsoft') {
      bot.chat('正版账号只能有我一个：summon 出来的 ai 会共用同一个账号，一上线就把我踢掉。' +
        '要多 ai 请用离线模式的服务器')
      return
    }
    const sub = (parts[2] || '').toLowerCase()
    if (sub === 'del' || sub === 'delete' || sub === 'remove') {
      if (name === USERNAME) { bot.chat('不能删除主 AI'); return }
      if (!children.has(name)) { bot.chat('没有叫 ' + name + ' 的 AI'); return }
      dismissAI(name)
      bot.chat('已删除 AI: ' + name)
    } else if (sub === 'add') {
      const who = parts[3]
      if (!who) { bot.chat('用法: summon <名字> add <玩家>'); return }
      const a = readAis()
      if (!a[name]) { bot.chat('没有叫 ' + name + ' 的 AI'); return }
      a[name].obey = a[name].obey || []
      if (!a[name].obey.includes(who)) a[name].obey.push(who)
      writeAis(a)
      bot.chat('AI ' + name + ' 现在也听从 ' + who + '（当前名单: ' + a[name].obey.join(', ') + '）')
    } else {
      if (children.has(name) || name === USERNAME) { bot.chat('已经有一个叫 ' + name + ' 的 AI 了'); return }
      const skin = pickSkin(parts[2] || null) // 第三个参数当皮肤，没给就随机
      summonAI(name, username, skin)
      bot.chat('已召唤 AI: ' + name + '（默认听从 ' + username + (skin ? '，皮肤 ' + skin : '') + '）。指挥它要说 ' +
        name + ' <指令>，例如 ' + name + ' build xxx')
    }
  } else if (cmd === 'rep') {
    if (parts.length >= 5) {
      handleRep(username, parts)
    } else {
      bot.chat('用法: rep <名字> <方向 x/y/z> <间隔> <数量>  (-1 表示无限，用 stop 停止)')
    }
  } else if (cmd === 'mark') {
    // 建造前是否用红/蓝羊毛对角标出建造范围（默认开启）
    const v = (parts[1] || '').toLowerCase()
    if (v === 'y' || v === 'on' || v === 'true' || v === '1') {
      bot._markEnabled = true
      bot.chat('已开启：建造前用红/蓝羊毛标出建造范围')
    } else if (v === 'n' || v === 'off' || v === 'false' || v === '0') {
      bot._markEnabled = false
      bot.chat('已关闭建造范围标记')
    } else {
      bot.chat('用法: mark y 开启 / mark n 关闭（默认开启）')
    }
  } else if (cmd === 'build') {
    const isNum = (s) => s !== undefined && !isNaN(parseInt(s, 10))
    if (parts.length === 4 && isNum(parts[1]) && isNum(parts[2]) && isNum(parts[3])) {
      // build <x> <y> <z>：完整 xyz 坐标，会真的在这个高度开工
      const x = parseInt(parts[1], 10)
      const y = parseInt(parts[2], 10)
      const z = parseInt(parts[3], 10)
      handleBuild(username, { coords: { x, y, z } })
    } else if (parts.length === 3 && isNum(parts[1]) && isNum(parts[2])) {
      // 兼容旧的 build <x> <z>：高度取当前高度（推荐改用 build <x> <y> <z>）
      const x = parseInt(parts[1], 10)
      const z = parseInt(parts[2], 10)
      const curY = Math.floor(bot.entity.position.y)
      bot.chat('提示：建议使用 build <x> <y> <z>，本次按当前高度 ' + curY + ' 处理')
      handleBuild(username, { coords: { x, y: curY, z } })
    } else if (parts.length === 2) {
      handleBuild(username, { blueprint: parts[1] })
    } else if (parts.length === 1) {
      handleBuild(username, {})
    } else {
      bot.chat('用法: build 或 build <蓝图名> 或 build <x> <y> <z>')
    }
  } else if (cmd === 'save') {
    if (parts.length === 2) {
      cancelFollow()
      saveMode = { name: parts[1], username, corners: [] }
      bot.chat('保存模式：在地面上放置金块(gold_block)和钻石块(diamond_block)作为两个对角，我会扫描中间区域并保存')
    } else {
      bot.chat('用法: save <蓝图名>')
    }
  } else if (cmd === 'teach') {
    if (parts.length >= 2 && parts[1].toLowerCase() === 'ckpd') {
      // 检查点：为"到目前为止放置的方块"做一份快照，复现进行到此处时核对
      if (!teachMode) { bot.chat('当前没有在进行教学，请先输入 teach <名字>'); return }
      const snap = buildCheckpointSnapshot()
      const ckName = parts[2] || ('ckpd' + snap.length)
      teachMode.events.push({ t: 'ckpd', ts: Date.now(), name: ckName, blocks: snap })
      console.log(`[AI] 教学检查点 "${ckName}": ${snap.length} 个方块`)
      bot.chat(`已设置检查点「${ckName}」，记录 ${snap.length} 个方块。复现到此会核对一次`)
    } else if (parts.length === 2 && parts[1].toLowerCase() === 'stop') {
      const r = stopTeaching()
      bot.chat(r ? `教学已保存为「${r.name}」，共 ${r.count} 个事件。用 build ${r.name} 复现` : '当前没有在进行教学')
    } else if (parts.length === 2) {
      cancelFollow()
      startTeaching(parts[1], username)
    } else {
      bot.chat('用法: teach <名字> 开始记录；teach stop 结束并保存')
    }
  } else if (cmd === 'del' || cmd === 'delete' || cmd === 'remove') {
    // 删除已保存的建筑（蓝图 / 教学，同名时一起删）
    if (parts.length === 2) {
      const removed = deleteSaved(parts[1])
      bot.chat(removed.length
        ? '已删除' + removed.join('与') + '「' + parts[1] + '」'
        : '没有找到「' + parts[1] + '」（用 list 查看已有）')
    } else {
      bot.chat('用法: del <名字>')
    }
  } else if (cmd === 'list') {
    const bps = listBlueprints()
    const tchs = listTeachings()
    bot.chat('已有蓝图: ' + (bps.length ? bps.join('、') : '（暂无，用 save 创建）'))
    if (tchs.length) bot.chat('已有教学: ' + tchs.join('、'))
  } else if (cmd === 'stop' || cmd === 'cancel') {
    // 紧急停止并重置：取消跟随、松开所有按键、丢掉寻路目标、
    // 置 _aiAbort 中止正在进行的建造，并拆掉临时辅助方块。
    cancelFollow()
    M.releaseControls(bot)
    if (bot.pathfinder && bot.pathfinder.setGoal) bot.pathfinder.setGoal(null)
    bot._aiAbort = true
    // 同时记一个"停止次数"：cleanupAssists 清理期间会临时清掉 _aiAbort，
    // 只靠布尔标志的话，这段时间进来的 stop 会被 finally 里的 prev 盖掉（踩过：stop 了还在建）
    bot._aiStopToken = (bot._aiStopToken || 0) + 1
    saveMode = null
    // 教学模式进行中 -> 顺带结束并保存
    const taught = stopTeaching()
    await cleanupAssists(bot)
    bot.chat(taught
      ? `已停止所有任务并重置状态；教学「${taught.name}」已保存（${taught.count} 个事件）`
      : '已停止所有任务并重置状态')
  } else if (cmd === 'tpto' || cmd === 'tp') {
    // 取消跟随；tpto 传送到玩家，tpto <x> <y> <z> 传送到坐标，tpto me 跟随
    cancelFollow()
    beginTask(bot) // 同上：stop 之后仍要能正常传送/跟随
    if (parts.length === 4) {
      const x = parseInt(parts[1], 10)
      const y = parseInt(parts[2], 10)
      const z = parseInt(parts[3], 10)
      if ([x, y, z].some((n) => isNaN(n))) { bot.chat('用法: tpto <x> <y> <z> 或 tpto me 或 tpto'); return }
      await teleportTo(x, y, z)
      bot.chat('已传送到 ' + x + ' ' + y + ' ' + z)
    } else if (parts[1] && parts[1].toLowerCase() === 'me') {
      startFollow(username) // runs until stop / tpto cancels it
    } else {
      const msg = await teleportToPlayer(username)
      if (!msg) {
        bot.chat(cfg.rcon.enabled
          ? '找不到你：可能在不同的维度，或者我没有 op 权限（试试靠近一点再说）'
          : '找不到你：你超出了我的可见范围，而且没有 RCON 就没法用服务器 /tp 过去（靠近一点再说）')
        return
      }
      bot.chat(msg)
    }
  } else {
    // 不认识的指令：别一声不吭，告诉玩家怎么用（以前打成 bulid 会完全没反应）
    bot.chat('没看懂「' + parts[0] + '」。输入 help 我会给你一本指令手册，' +
      '常用: build / teach / save / rep / summon / tpto / stop')
  }
})

// Capture the two marker blocks the user places during save mode
// (and, while teaching, every block the player places)
bot.on('blockUpdate', (oldBlock, newBlock) => {
  // 教学模式：记录玩家放置的方块（含朝向与依附面）
  if (teachMode) {
    const wasEmpty = !oldBlock || oldBlock.name === 'air'
    const nm = newBlock && newBlock.name
    // !! 区块加载也会触发 blockUpdate（世界自带的方块"出现"了），
    //    不区分的话会把整片地形全记成"玩家放置的"——实测一次录制混进 116 个 iron_block，
    //    复现时 AI 会试图把上百个方块重新放一遍。
    //    过滤条件：之前确实是空气，且**就在玩家手够得到的范围内**（才算他放的）。
    let nearPlayer = true
    const pl = bot.players[teachMode.username]
    if (pl && pl.entity && newBlock) {
      const pp = pl.entity.position
      const bp = newBlock.position
      nearPlayer = Math.hypot(pp.x - bp.x, pp.y - bp.y, pp.z - bp.z) <= 5
    }
    if (wasEmpty && nearPlayer && nm && nm !== 'air' && nm !== 'gold_block' && nm !== 'diamond_block') {
      const p = newBlock.position
      const o = teachMode.origin
      teachMode.events.push({
        t: 'place', ts: Date.now(),
        dx: p.x - o.x, dy: p.y - o.y, dz: p.z - o.z,
        name: nm,
        facing: readFacing(bot, newBlock),
        face: readFace(bot, newBlock),
        wire: readWireShape(bot, newBlock) // 红石粉的点状/十字形态
      })
    }
  }
  if (!saveMode) return
  if (newBlock && (newBlock.name === 'gold_block' || newBlock.name === 'diamond_block')) {
    saveMode.corners.push(newBlock.position)
    if (saveMode.corners.length === 2) {
      const name = saveMode.name
      const username = saveMode.username
      const corners = saveMode.corners
      saveMode = null
      finishSave(name, username, corners)
    }
  }
})

// 录制期间记录 Shift（潜行/下降）的按下与松开
bot.on('entityCrouch', (entity) => recordTeachKey(entity, 'sneak', true))
bot.on('entityUncrouch', (entity) => recordTeachKey(entity, 'sneak', false))

// Capture the player's right-click / interaction while teaching
bot.on('entitySwingArm', (entity) => {
  if (!teachMode) return
  if (!entity || entity.username !== teachMode.username) return
  const p = bot.players[teachMode.username]
  if (!p || !p.entity) return
  // 注：放方块时客户端也会挥臂，服务器同样会广播。
  // 这里**不**做即时过滤（挥臂包可能比 blockUpdate 先到，此时还不知道刚放了个方块），
  // 统一在 stopTeaching() 里按时间戳过滤（见 PLACE_SWING_MS）。
  const pp = p.entity.position
  const o = teachMode.origin
  const tgt = raycastTarget(bot, pp.offset(0, 1.62, 0), p.entity.yaw, p.entity.pitch)
  teachMode.events.push({
    t: 'use', ts: Date.now(),
    x: pp.x - o.x, y: pp.y - o.y, z: pp.z - o.z,
    yaw: p.entity.yaw, pitch: p.entity.pitch,
    tx: tgt ? tgt.x - o.x : null,
    ty: tgt ? tgt.y - o.y : null,
    tz: tgt ? tgt.z - o.z : null
  })
})

// ===== 玩家加入时授权 op + 记进玩家登记 =====
// op 只能由控制台或已 op 的玩家来发，所以这里通过 RCON 让服务器执行 "op <名字>"。
// 已授权的名单存在 服务器/ops.json，重启后依然有效。
bot.on('playerJoined', (player) => {
  if (!player || !player.username) return
  recordPlayerJoin(player.username)
  ensureOp(player.username)
})

bot.on('login', () => console.log(`[AI] Logged in to ${HOST}:${PORT} as ${bot.username}`))

bot.on('spawn', () => {
  // 连上（含重连成功）就把退避重置，下次掉线仍从 1 秒开始
  reconnectDelay = 0
  // 正版登录时**进服名字由账号决定**，和 config 里的名字不一定一样。
  // 指令前缀、ais.json 登记都用真实名字，否则"只听从名单"那套会查不到自己的条目。
  if (!IS_WORKER && bot.username && bot.username !== USERNAME) {
    const a = readAis()
    if (!a[bot.username]) {
      a[bot.username] = { owner: null, obey: [] }
      if (a[USERNAME]) delete a[USERNAME]
      writeAis(a)
      console.log('[AI] 游戏内名字 = ' + bot.username + '（config 的 ai.name=' + USERNAME +
        ' 只用来做日志文件名；指令前缀请用 ' + bot.username + '）')
    }
  }
  // 给已经在线的玩家（以及自己）补一次 op —— playerJoined 只对之后进来的玩家触发。
  // 是否真的 op 由 autoOp 策略决定（见 ensureOp / 源码/access.js）
  for (const name of Object.keys(bot.players || {})) ensureOp(name)
  ensureOp(bot.username)
  // 同理：已经在线的玩家也要记进 配置/玩家登记.json（playerJoined 只对之后进来的触发）
  for (const name of Object.keys(bot.players || {})) {
    if (name !== bot.username) recordPlayerJoin(name)
  }
  // 初始 ai 上线：把自己的别名报给主 ai（R3），服主面板/日志就能把 ai 和玩家对上号
  announceAlias()
  // 换肤：离线服本身不带皮肤，需要服务器有皮肤插件（如 SkinsRestorer）才生效
  const skin = process.env.AI_SKIN
  if (skin) {
    setTimeout(() => {
      const cmd = (readSkins().command || '/skin set {skin}').replace('{skin}', skin)
      console.log('[AI] 应用皮肤: ' + cmd)
      bot.chat(cmd)
    }, 4000)
  }
  console.log('[AI] ready. In-game chat commands: build / build <name> / build <x> <y> <z> / save <name> / teach <name> / del <name> / list / tpto / stop')
  const ali = currentAlias()
  bot.chat('我是 ' + bot.username + '，已就绪！指令前要加我的名字' +
    (ali ? '（也可以叫我「' + ali + '」）' : '') + '，例如：' + bot.username +
    ' build <x> <y> <z> 在指定坐标建造；' + bot.username + ' teach <名字> 录制操作；' +
    bot.username + ' help 给你一本指令手册')
})

// 致命错误（白名单 / 封禁 / 版本不符 / 账号被占用）：重连一万次也没用，只会把日志刷成瀑布。
// 停掉重连并退出，让用户"按提示改配置后再启动"。
function fatalStop (why) {
  if (shuttingDown) return
  shuttingDown = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  console.error('[AI] 致命错误（' + why + '），已停止自动重连；按上面的提示改配置后再启动')
  setTimeout(() => process.exit(1), 300)
}

bot.on('kicked', (reason) => {
  // 踢人原因可能是字符串，也可能是聊天组件（translate / text / extra），统一转成纯文本
  const text = kickText(reason)
  console.log('[AI] 被服务器踢出: ' + text)
  const d = diagnose(text)
  if (d.hint) console.error('[AI] ' + d.hint)
  if (d.fatal) fatalStop('被踢：' + text.slice(0, 60))
})

bot.on('error', (err) => {
  // 注意：连不上时 mineflayer 抛的是 AggregateError，message 是空串，
  // 真正的错误藏在 err.code / err.errors[].code 里，只看 message 会什么都诊断不出来。
  const nested = Array.isArray(err && err.errors)
    ? err.errors.map((e) => (e && (e.code || e.message)) || '')
    : []
  const msg = [err && err.name, err && err.code, err && err.message, String(err || '')]
    .concat(nested).filter(Boolean).join(' ')
  console.error('[AI] Connection error:', msg)
  // 常见错误直接给中文诊断（连外服时最常见的几类见 源码/access.js 的 RULES）
  const d = diagnose(msg)
  if (d.hint) console.error('[AI] ' + d.hint)
  if (d.fatal) fatalStop('连接失败')
})

// 掉线（服务器重启 / 网络抖动 / 被踢）自动重连；Ctrl+C 退出时不再重连
bot.on('end', (reason) => {
  if (bot._dead) return // error 和 end 可能同时触发，别排两次重连
  bot._dead = true
  console.log('[AI] 与服务器断开（' + (reason || '未知原因') + '）')
  scheduleReconnect(reason)
})
}

process.on('SIGINT', () => {
  shuttingDown = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  console.log('[AI] 收到 Ctrl+C，退出（不再重连）')
  process.exit(0)
})

// ===== 启动 =====
createAndAttach()
