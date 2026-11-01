// ===== 统一配置（源码/config.js）=====
// 目标：所有可配置项只从项目根 config.json 读，代码里不再写死端口 / 版本 / RCON 密码。
// 优先级：环境变量 > config.json > (RCON) 服务器/server.properties > 内置默认值。
// 兼容旧格式：顶层写 building/size/height/floor/wall/roof 的 config.json 会自动搬进 cfg.building，
//            所以老配置不改也能直接跑（保存成新结构后更清晰）。
const fs = require('fs')
const path = require('path')
const { opPolicy, normalizeList } = require('./access')

const ROOT = path.join(__dirname, '..')
const CONFIG_FILE = path.join(ROOT, 'config.json')
const SERVER_PROPS = path.join(ROOT, '服务器', 'server.properties')

const DEFAULTS = {
  server: {
    host: 'localhost',
    port: 25565,
    version: '1.21.1',
    // offline = 离线服（随便起名字）；microsoft = 正版服（弹设备码登录，见 文档/AI参考.md 坑 33）
    auth: 'offline',
    // 正版登录用的账号邮箱；留空则用 ai.name（此时 ai.name 得填邮箱）
    username: '',
    // 正版令牌缓存目录；留空 = 服务器/nmp-cache（下次启动免登录）
    profilesFolder: ''
  },
  rcon: { enabled: true, host: '127.0.0.1', port: 25575, password: '' },
  ai: {
    name: 'world',
    // 服主（本机运行者）的游戏名：面板靠它区分「服主 / 成员」，见 源码/玩家登记.js
    // 留空 = 所有进服的人都会被记成成员
    owner: '',
    // 成员的「初始 ai」默认名字前缀：way- => way-<玩家名>（面板里可以给他改名）
    guestPrefix: 'way-',
    // 自动 op 策略：local-only(默认, 只给本机服) / never / whitelist / always，见 源码/access.js
    autoOp: 'local-only',
    opWhitelist: [],
    // 谁能给 ai 下指令（空 = 所有人）。公共服建议填上，否则任何路人都能指挥它拆家
    obeyWhitelist: []
  },
  behavior: { markOnBuild: true, reconnect: { enabled: true, maxDelayMs: 30000 } },
  building: { building: 'house', size: 5, height: 3, floor: 'stone', wall: 'oak_planks', roof: 'bricks' }
}

function isPlainObject (v) { return !!v && typeof v === 'object' && !Array.isArray(v) }

// 深合并：对象递归合并，数组 / 标量直接覆盖（opWhitelist 这类数组以文件里的为准）
function mergeDeep (base, over) {
  const out = isPlainObject(base) ? Object.assign({}, base) : {}
  if (!isPlainObject(over)) return out
  for (const k of Object.keys(over)) {
    const b = out[k]
    const o = over[k]
    out[k] = (isPlainObject(b) && isPlainObject(o)) ? mergeDeep(b, o) : o
  }
  return out
}

// 旧格式迁移：把顶层的建筑字段搬进 building 段
const LEGACY_BUILDING_KEYS = ['size', 'height', 'floor', 'wall', 'roof']
function migrateLegacy (raw) {
  const cfg = Object.assign({}, raw || {})
  const legacy = {}
  // 旧格式里 building 是字符串（house/tower/pyramid），新格式里是对象
  if (typeof cfg.building === 'string') { legacy.building = cfg.building; delete cfg.building }
  for (const k of LEGACY_BUILDING_KEYS) {
    if (cfg[k] !== undefined) { legacy[k] = cfg[k]; delete cfg[k] }
  }
  if (Object.keys(legacy).length) {
    cfg.building = Object.assign({}, isPlainObject(cfg.building) ? cfg.building : {}, legacy)
  }
  return cfg
}

// 读 服务器/server.properties（没有这个目录也不报错，连接外服时本来就不需要它）
function readServerProps () {
  const out = {}
  try {
    const text = fs.readFileSync(SERVER_PROPS, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#')) continue
      const i = s.indexOf('=')
      if (i < 0) continue
      out[s.slice(0, i).trim()] = s.slice(i + 1).trim()
    }
  } catch (e) { /* ignore */ }
  return out
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0']
function isLocalHost (host) {
  return LOCAL_HOSTS.includes(String(host || '').trim().toLowerCase())
}

// ===== 命令行参数（临时连朋友的服不用改 config.json）=====
// 只做"解析"，落值仍然走 load() 的合并流程，保证优先级清楚：
//   命令行 > 环境变量 > config.json > 服务器/server.properties > 内置默认值
const CLI_OPTIONS = {
  '--host': { key: 'server.host' },
  '--port': { key: 'server.port', type: 'int' },
  '--version': { key: 'server.version' },
  '--auth': { key: 'server.auth' },
  '--server-user': { key: 'server.username' },
  '--name': { key: 'ai.name' },
  '--auto-op': { key: 'ai.autoOp' },
  '--op-whitelist': { key: 'ai.opWhitelist', type: 'list' },
  '--obey': { key: 'ai.obeyWhitelist', type: 'list' },
  '--rcon-host': { key: 'rcon.host' },
  '--rcon-port': { key: 'rcon.port', type: 'int' },
  '--rcon-password': { key: 'rcon.password' }
}
const CLI_FLAGS = {
  '--no-rcon': { key: 'rcon.enabled', value: false },
  '--no-reconnect': { key: 'behavior.reconnect.enabled', value: false }
}

const USAGE = [
  '用法:',
  '  node 源码/bot.js                                   用 config.json 里的配置',
  '  node 源码/bot.js --host play.example.com           临时连别的服务器（不改文件）',
  '  node 源码/bot.js --auth microsoft --server-user you@mail.com',
  '                                                     正版服登录（第一次会弹设备码）',
  '',
  '可用参数:',
  '  --host <地址>              服务器地址',
  '  --port <端口>              服务器端口（默认 25565）',
  '  --version <版本|auto>      服务器版本，不确定就写 auto（自动探测）',
  '  --auth <offline|microsoft> 离线服 / 正版服',
  '  --server-user <邮箱>       正版登录账号（进服名字由账号决定）',
  '  --name <名字>              ai 名字；指令前缀就是它（离线服可随便起）',
  '  --auto-op <策略>           local-only(默认) / never / whitelist / always',
  '  --op-whitelist <a,b,c>     这些人进服时自动 op（配合 --auto-op whitelist）',
  '  --obey <a,b,c>             只有这些人能指挥 ai（不填 = 所有人）',
  '  --rcon-host / --rcon-port / --rcon-password   RCON 连接信息',
  '  --no-rcon                  关掉 RCON（接公共服通常用这个）',
  '  --no-reconnect             掉线后不自动重连',
  '  -h, --help                 显示这段说明'
].join('\n')

function parseArgs (argv) {
  const args = Array.isArray(argv) ? argv.slice() : []
  const overrides = {}
  const errors = []
  let help = false

  for (let i = 0; i < args.length; i++) {
    let a = String(args[i])
    let inline = null
    // 支持 --port=25565 和 --port 25565 两种写法
    const eq = a.indexOf('=')
    if (a.startsWith('--') && eq > 0) {
      inline = a.slice(eq + 1)
      a = a.slice(0, eq)
    }
    if (a === '-h' || a === '--help') { help = true; continue }
    const flag = CLI_FLAGS[a]
    if (flag) { overrides[flag.key] = flag.value; continue }
    const opt = CLI_OPTIONS[a]
    if (!opt) { errors.push('不认识的参数 ' + args[i]); continue }

    let v = inline
    if (v === null) {
      v = args[i + 1]
      if (v === undefined || String(v).startsWith('--')) {
        errors.push(a + ' 后面缺少数值')
        continue
      }
      i++
    }
    if (opt.type === 'int') {
      const n = parseInt(v, 10)
      if (isNaN(n)) { errors.push(a + ' 需要数字，收到 ' + v); continue }
      overrides[opt.key] = n
    } else if (opt.type === 'list') {
      overrides[opt.key] = String(v).split(',').map((s) => s.trim()).filter(Boolean)
    } else {
      overrides[opt.key] = String(v)
    }
  }
  return { overrides, errors, help, usage: USAGE }
}

// 把 'server.host' 这样的点路径写进嵌套对象
function setDotted (obj, dotted, value) {
  const keys = String(dotted).split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!isPlainObject(cur[keys[i]])) cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
}

const AUTH_VALUES = ['offline', 'microsoft']

// 读配置并整理成最终值（每次调用都重新读文件，改完重启就生效）
// overrides：命令行解析出来的 { 'server.host': 'x' }，优先级最高
function load (overrides) {
  const warnings = []
  let raw = {}
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      // 去掉 BOM：记事本 / PowerShell 5.1 保存的 UTF-8 带 BOM，JSON.parse 会直接报错
      raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''))
    } catch (e) {
      warnings.push('[配置] config.json 解析失败，改用默认值：' + e.message)
    }
  } else {
    warnings.push('[配置] 没找到 config.json，改用默认值')
  }

  const cfg = mergeDeep(DEFAULTS, migrateLegacy(raw))

  // 环境变量：summon 用 fork 传 MC_USER，测试也常用 MC_HOST / MC_PORT，外服临时切换也能用
  if (process.env.MC_HOST) cfg.server.host = process.env.MC_HOST
  if (process.env.MC_PORT) cfg.server.port = parseInt(process.env.MC_PORT, 10) || cfg.server.port
  if (process.env.MC_VERSION) cfg.server.version = process.env.MC_VERSION
  if (process.env.MC_AUTH) cfg.server.auth = process.env.MC_AUTH
  if (process.env.MC_USER) cfg.ai.name = process.env.MC_USER
  if (process.env.MC_AUTO_OP) cfg.ai.autoOp = process.env.MC_AUTO_OP
  if (process.env.MC_OBEY) cfg.ai.obeyWhitelist = process.env.MC_OBEY // 逗号分隔
  if (process.env.MC_RCON_PASSWORD) cfg.rcon.password = process.env.MC_RCON_PASSWORD

  // 命令行优先级最高（临时连朋友的服：node 源码/bot.js --host xxx --auth microsoft）
  if (isPlainObject(overrides)) {
    for (const k of Object.keys(overrides)) setDotted(cfg, k, overrides[k])
  }

  // ---- 规范化 ----
  cfg.server.port = parseInt(cfg.server.port, 10) || 25565
  cfg.rcon.port = parseInt(cfg.rcon.port, 10) || 25575
  const rawAuth = String(cfg.server.auth == null ? '' : cfg.server.auth).trim().toLowerCase()
  cfg.server.auth = AUTH_VALUES.includes(rawAuth) ? rawAuth : 'offline'
  if (rawAuth && rawAuth !== cfg.server.auth) {
    warnings.push('[配置] server.auth=' + rawAuth + ' 不认识，已按 offline 处理（可选：offline / microsoft）')
  }
  // 写错的 op 策略不能变成"给所有人 op"：access.js 里未知值一律回落到 local-only
  const rawPolicy = String(cfg.ai.autoOp == null ? '' : cfg.ai.autoOp).trim().toLowerCase()
  cfg.ai.autoOp = opPolicy(rawPolicy)
  if (rawPolicy && rawPolicy !== cfg.ai.autoOp) {
    warnings.push('[配置] ai.autoOp=' + rawPolicy + ' 不认识，已按 local-only 处理' +
      '（可选：local-only / never / whitelist / always）')
  }

  // RCON 密码 / 端口没写在 config.json 时，沿用服务器自己的 server.properties
  const props = readServerProps()
  if (!cfg.rcon.password && props['rcon.password']) cfg.rcon.password = props['rcon.password']
  if (!cfg.rcon.port && props['rcon.port']) cfg.rcon.port = parseInt(props['rcon.port'], 10) || 25575
  if (cfg.rcon.enabled && !cfg.rcon.password) {
    cfg.rcon.enabled = false
    warnings.push('[配置] 没有 RCON 密码（config.json 的 rcon.password 为空），已自动关闭 RCON：' +
      'op / help 书 / 远距离 tp 会不可用')
  }

  // 本地自建服最容易踩的坑：config.json 改了端口，server.properties 没改
  const local = isLocalHost(cfg.server.host)
  if (local && props['server-port'] &&
      parseInt(props['server-port'], 10) !== cfg.server.port) {
    warnings.push('[配置] server.port=' + cfg.server.port +
      ' 与 服务器/server.properties 的 server-port=' + props['server-port'] + ' 不一致')
  }

  // ===== 连别人的服务器时最容易踩的四个坑，启动就说清楚 =====
  cfg._isLocal = local
  if (!local) {
    if (cfg.ai.autoOp === 'local-only') {
      warnings.push('[配置] 连的是外部服务器，autoOp=local-only → 不会给任何人 op' +
        '（安全默认值；确实需要就改成 whitelist / always）')
    }
    if (cfg.server.auth === 'offline') {
      warnings.push('[配置] server.auth=offline：对方若开着正版验证（online-mode=true）会登录失败，' +
        '这时要改成 "microsoft" 并用正版账号登录')
    }
    if (!normalizeList(cfg.ai.obeyWhitelist).length) {
      warnings.push('[配置] ai.obeyWhitelist 为空 → 任何玩家都能指挥 ai（公共服建议填上允许的玩家名）')
    }
    if (cfg.rcon.enabled) {
      warnings.push('[配置] 正在用 RCON 连外部服务器：大多数公共服不开放 RCON，' +
        '连不上就把 rcon.enabled 设成 false（或命令行加 --no-rcon）')
    }
  }
  if (cfg.server.auth === 'microsoft' && !cfg.server.username && !/@/.test(String(cfg.ai.name))) {
    warnings.push('[配置] auth=microsoft 需要账号邮箱：填 server.username' +
      '（或命令行 --server-user your@mail.com）')
  }

  cfg._warnings = warnings
  return cfg
}

// 启动时打一行，方便确认"到底连的哪儿 / 用什么身份"
function summary (cfg) {
  const rcon = cfg.rcon.enabled ? cfg.rcon.host + ':' + cfg.rcon.port : '关闭'
  const auth = cfg.server.auth === 'microsoft' ? '正版' : '离线'
  return cfg.ai.name + ' -> ' + cfg.server.host + ':' + cfg.server.port +
    '（version ' + cfg.server.version + '，auth ' + auth + '，rcon ' + rcon + '）'
}

module.exports = {
  load, parseArgs, isLocalHost, summary,
  CONFIG_FILE, SERVER_PROPS, DEFAULTS, USAGE, AUTH_VALUES
}
