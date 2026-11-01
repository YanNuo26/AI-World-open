// ===== 玩家与 ai 登记（源码/玩家登记.js）=====
// 干什么：把"谁进过服 / 他是服主还是成员 / 他的初始 ai 叫什么 / 改过哪些名字"落盘，
// 让面板「连接与权限」能按 **服主 / 非服主** 两种视角展示和管理。
//
// 为什么不塞进 ais.json：
//   ais.json 是**运行时**注册表（主 ai 启动就重置），重启后人就没了；
//   而且它由主 ai + 每个子 ai 同时读写，塞太多东西容易互相覆盖。
//
// 文件：配置/玩家登记.json
//   {
//     "servers": {
//       "localhost:25565": {
//         "updatedAt": 1730000000000,
//         "players": {
//           "yan_nuo": {
//             "name": "yan_nuo",              // 显示用（保留玩家第一次出现的大小写）
//             "role": "owner" | "member",
//             "aiName": "way-yan_nuo",        // 他的「初始 ai」名字（成员默认 way-<玩家名>）
//             "renamedFrom": ["way-老名字"],  // 改过名的历史，方便追
//             "note": "",
//             "firstSeen": 1730000000000,
//             "lastSeen": 1730000000000,
//             "joinCount": 3
//           }
//         }
//       }
//     }
//   }
//
// 约定：**ai 归属不落盘**。谁有哪些 ai 随时能从 ais.json 的 owner 字段算出来，
// 同一份数据只存一处，改起来不会两边不一致。
//
// 并发：主 ai（记录进服）和面板（改名 / 改角色）都会读-改-写这个文件。
// 两边都是"读完马上写"，窗口极小；真撞上了最多丢一次改名，不会写坏文件
// （写入是一次 writeFileSync 覆盖，不会留半截 JSON）。
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIR = path.join(ROOT, '配置')
const FILE = path.join(DIR, '玩家登记.json')
const AIS_FILE = path.join(ROOT, 'ais.json')

// 每个服务器最多记多少人（防止有人开小号刷爆文件）
const MAX_PLAYERS = 500

function normKey (name) {
  return String(name == null ? '' : name).trim().toLowerCase()
}

// MC 名字：离线服允许字母 / 数字 / 下划线，中文名在离线服也能进，所以一并放行
const NAME_RE = /^[\w\u4e00-\u9fa5-]{2,16}$/

function serverKey (host, port) {
  const h = String(host == null || host === '' ? 'localhost' : host).trim().toLowerCase()
  const p = parseInt(port, 10)
  return h + ':' + (isNaN(p) ? 25565 : p)
}

function empty () {
  return { servers: {} }
}

function load () {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty()
    if (!raw.servers || typeof raw.servers !== 'object' || Array.isArray(raw.servers)) raw.servers = {}
    return raw
  } catch (e) {
    return empty()
  }
}

function save (db) {
  try {
    fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(db, null, 2) + '\n', 'utf8')
    return true
  } catch (e) {
    return false
  }
}

// 取某个服务器的分桶（create=true 时没有就建）
function bucket (db, key, create) {
  if (!db.servers[key] && create) db.servers[key] = { updatedAt: 0, players: {} }
  const s = db.servers[key]
  if (!s) return null
  if (!s.players || typeof s.players !== 'object' || Array.isArray(s.players)) s.players = {}
  return s
}

// 成员（非服主）的初始 ai 默认名：way-玩家名；服主用主 ai，不需要另起
function defaultAiName (username, role, prefix) {
  if (role === 'owner') return ''
  const p = String(prefix == null ? '' : prefix).trim() || 'way-'
  return p + String(username == null ? '' : username).trim()
}

// ===== 名字归类：这是"人"还是"ai"？ =====
// 背景（2026-11-01）：ai 上线时和玩家一样会触发 playerJoined，于是
//   world / AIBuilder / way-yan_nuo 这些 ai 全被当成"玩家"记进了登记表，
//   服主视角的「玩家登记」里混进一堆 ai，名下的 ai 反而对不上人。
// 规则（按顺序，命中就返回）：
//   1. ais.json 里有这个名字            → ai（主 ai / summon 出来的 / 手动起的）
//   2. 等于主 ai 名字（ai.name）         → ai
//   3. 形如 <guestPrefix><任意名字>      → ai（前缀本身就是"这是 ai"的约定，例如 way-alice）
// 返回 { isAi, owner, reason }；owner 只是"猜"，真正的归属仍以 ais.json 的 owner 为准。
const DEFAULT_PREFIX = 'way-'

function prefixOf (v) {
  const s = String(v == null ? '' : v).trim()
  return s || DEFAULT_PREFIX
}

function findAisKey (name, ais) {
  const key = normKey(name)
  if (!key) return ''
  for (const k of Object.keys(ais || {})) if (normKey(k) === key) return k
  return ''
}

function classifyName (name, opts) {
  const o = opts || {}
  const raw = String(name == null ? '' : name).trim()
  const key = normKey(raw)
  if (!key) return { isAi: false, owner: null, reason: '空名字' }
  const ais = o.ais || readAis()
  const hit = findAisKey(raw, ais)
  if (hit) {
    const rec = ais[hit] || {}
    return { isAi: true, owner: rec.owner || null, reason: 'ais.json 里有记录' }
  }
  const main = String(o.mainName == null ? '' : o.mainName).trim()
  if (main && normKey(main) === key) return { isAi: true, owner: null, reason: '等于主 ai 名字' }
  const prefix = prefixOf(o.guestPrefix)
  if (key.length > prefix.length && key.slice(0, prefix.length) === prefix.toLowerCase()) {
    return { isAi: true, owner: raw.slice(prefix.length), reason: '名字带 ai 前缀 ' + prefix }
  }
  return { isAi: false, owner: null, reason: '玩家' }
}

// 猜某个 ai 属于谁（面板"名下的 ai"用它兜底；ais.json 的 owner 优先）
//   1. ais.json 的 owner
//   2. 名字剥掉前缀 → 剩下那段就是玩家名（way-alice → alice）
//   3. 某个玩家的「初始 ai 名」正好等于它
function inferOwner (aiName, opts) {
  const o = opts || {}
  const raw = String(aiName == null ? '' : aiName).trim()
  if (!raw) return null
  const ais = o.ais || readAis()
  const hit = findAisKey(raw, ais)
  const rec = hit ? (ais[hit] || {}) : {}
  if (rec.owner) return String(rec.owner)
  const players = Array.isArray(o.players) ? o.players : []
  const byAiName = players.find((p) => p && normKey(p.aiName) === normKey(raw))
  if (byAiName) return byAiName.name
  const prefix = prefixOf(o.guestPrefix)
  if (raw.toLowerCase().slice(0, prefix.length) === prefix.toLowerCase()) {
    const rest = raw.slice(prefix.length)
    const byName = players.find((p) => p && normKey(p.name) === normKey(rest))
    return byName ? byName.name : rest
  }
  return null
}

// 把历史误记成玩家的 ai 清出登记表（world / AIBuilder / way-xxx 这类）
// 返回被删掉的名字（供面板提示"顺手清理了 N 条"）
function pruneAiEntries (opts) {
  const o = opts || {}
  const db = load()
  const s = bucket(db, serverKey(o.host, o.port), false)
  if (!s) return []
  const ais = o.ais || readAis()
  const removed = []
  for (const k of Object.keys(s.players)) {
    const p = s.players[k] || {}
    const cls = classifyName(p.name || k, { ais, mainName: o.mainName, guestPrefix: o.guestPrefix })
    if (cls.isAi) { delete s.players[k]; removed.push(p.name || k) }
  }
  if (removed.length) { s.updatedAt = Date.now(); save(db) }
  return removed
}

// 记一次进服（玩家进服 / ai 上线时把在线玩家补记一遍都走这里）

// 返回 { player, isNew }；参数不合法返回 null（绝不让登记失败影响 ai 干正事）
function recordJoin (opts) {
  const o = opts || {}
  const key = normKey(o.username)
  if (!key) return null
  // ai 上线也会触发 playerJoined：名字是 ai（way-xxx / 主 ai / ais.json 里有记录）就不要记成玩家，
  // 顺手把历史上误记的那些清掉（2026-11-01：world / AIBuilder / way-yan_nuo 都混进过玩家表）
  const cls = classifyName(o.username, { ais: o.ais, mainName: o.mainName, guestPrefix: o.guestPrefix })
  if (cls.isAi) {
    const removed = pruneAiEntries(o)
    return { player: null, isAi: true, owner: cls.owner, reason: cls.reason, removed }
  }
  const now = Number(o.now) || Date.now()
  const db = load()
  const sk = serverKey(o.host, o.port)
  const s = bucket(db, sk, true)
  if (!s) return null
  const role = (o.ownerName && normKey(o.ownerName) === key) ? 'owner' : 'member'
  let p = s.players[key]
  const isNew = !p
  if (!p) {
    if (Object.keys(s.players).length >= MAX_PLAYERS) return null
    p = {
      name: String(o.username).trim(),
      role,
      aiName: defaultAiName(o.username, role, o.guestPrefix),
      alias: '',
      renamedFrom: [],
      note: '',
      firstSeen: now,
      lastSeen: now,
      joinCount: 0
    }
    s.players[key] = p
  } else {
    p.name = String(o.username).trim()
    if (o.ownerName) p.role = role
    // 初始 ai 名称**固定**（R1）：每次进服都按规则重算，历史上的手工改名会被纠正回来。
    // 想换个好叫的名字用 alias（别名），不改这个。
    p.aiName = defaultAiName(p.name, p.role, o.guestPrefix)
    if (typeof p.alias !== 'string') p.alias = ''
  }
  p.lastSeen = now
  p.joinCount = (p.joinCount || 0) + 1
  s.updatedAt = now
  save(db)
  return { player: p, isNew }
}

// ===== 别名（alias）=====
// 需求（2026-11-01）：
//   1) 初始 ai 的**名字固定**（成员 = <前缀><玩家名>，服主 = 主 ai 名），不许改；
//   2) 但成员可以给它起一个**别名**，游戏里用别名也能指挥它（"小A build ..."）；
//   3) 别名存在这里（玩家登记），不另存一份：一个玩家 = 一个初始 ai = 一个别名。
// 为什么不用 ais.json：ais.json 是运行时注册表（主 ai 重启就重置），别名要长期保留。

// 别名合法性：沿用 ai 名字的规则（2–16 位字母/数字/下划线/中文），空串 = 清除
function cleanAlias (v) {
  return String(v == null ? '' : v).trim()
}

// 找"名字正好是 xxx 的那个初始 ai"属于谁（bot 用它查自己的别名）
function findByAiName (host, port, aiName) {
  const want = normKey(aiName)
  if (!want) return null
  const s = bucket(load(), serverKey(host, port), false)
  if (!s) return null
  for (const k of Object.keys(s.players)) {
    const p = s.players[k] || {}
    if (normKey(p.aiName) === want) return { key: k, player: p, alias: p.alias || '' }
  }
  return null
}

// 设置 / 清除别名
//   opts = { host, port, username, alias }
//   抛错（面板会转成 400）：玩家没登记 / 别名不合法 / 别名和别人的名字撞了
function setAlias (opts) {
  const o = opts || {}
  const key = normKey(o.username)
  const alias = cleanAlias(o.alias)
  if (!key) throw new Error('玩家名不能为空')
  if (alias && !NAME_RE.test(alias)) throw new Error('别名只能是 2–16 位字母 / 数字 / 下划线 / 中文')
  const db = load()
  const s = bucket(db, serverKey(o.host, o.port), false)
  if (!s || !s.players[key]) throw new Error('还没有这个玩家的记录（让他先进一次服务器）')
  const p = s.players[key]
  if (!p.aiName) throw new Error('这个玩家没有初始 ai（服主自己用的是主 ai，不需要别名）')

  if (alias) {
    const low = alias.toLowerCase()
    if (o.mainName && low === normKey(o.mainName)) throw new Error('「' + alias + '」是主 ai 的名字，换一个')
    // 不能和别的玩家的初始 ai 名 / 别名 撞（否则游戏里分不清在指挥谁）
    for (const k of Object.keys(s.players)) {
      if (k === key) continue
      const q = s.players[k] || {}
      if (normKey(q.aiName) === low) throw new Error('「' + alias + '」是 ' + (q.name || k) + ' 的初始 ai 名，换一个')
      if (q.alias && normKey(q.alias) === low) throw new Error('「' + alias + '」已经是 ' + (q.name || k) + ' 的别名了，换一个')
    }
    const ais = readAis()
    if (Object.keys(ais).some((n) => normKey(n) === low)) {
      throw new Error('「' + alias + '」已经是场上一个 ai 的名字，换一个')
    }
  }

  p.alias = alias
  s.updatedAt = Date.now()
  save(db)
  return { ok: true, username: p.name, aiName: p.aiName, alias: p.alias }
}

// 改名：**已废弃**。初始 ai 名称固定（R1），要换叫法请用别名。
// 保留这个函数只是为了老调用方拿到一句清楚的错误，而不是静默失效。
function renameAi () {
  throw new Error('初始 ai 名称是固定的（成员 = 前缀+玩家名，服主 = 主 ai 名），不能改名；想换个叫法请设置「别名」')
}

// 在 ais.json 里把 old 换成 new（保留 owner / obey / pid）
function renameAisKey (oldName, newName) {
  try {
    const a = JSON.parse(fs.readFileSync(AIS_FILE, 'utf8').replace(/^\uFEFF/, ''))
    if (!a || typeof a !== 'object' || Array.isArray(a)) return false
    if (!a[oldName] || a[newName]) return false
    a[newName] = Object.assign({}, a[oldName], { renamedFrom: oldName })
    delete a[oldName]
    fs.writeFileSync(AIS_FILE, JSON.stringify(a, null, 2))
    return true
  } catch (e) {
    return false
  }
}

// 设角色。服主只能有一个：把别人设成 owner 时，原来的 owner 自动降成 member。
function setRole (opts) {
  const o = opts || {}
  const key = normKey(o.username)
  if (!key) throw new Error('玩家名不能为空')
  const role = o.role === 'owner' ? 'owner' : 'member'
  const db = load()
  const s = bucket(db, serverKey(o.host, o.port), false)
  if (!s || !s.players[key]) throw new Error('还没有这个玩家的记录（让他先进一次服务器）')
  if (role === 'owner') {
    for (const k of Object.keys(s.players)) {
      if (k !== key && s.players[k].role === 'owner') s.players[k].role = 'member'
    }
  }
  s.players[key].role = role
  s.updatedAt = Date.now()
  save(db)
  return { ok: true, player: s.players[key] }
}

// 删掉一个玩家的记录（不碰 ais.json：ai 是否还在由游戏里决定）
function removePlayer (opts) {
  const o = opts || {}
  const key = normKey(o.username)
  const db = load()
  const s = bucket(db, serverKey(o.host, o.port), false)
  if (!s || !s.players[key]) throw new Error('没有这个玩家的记录')
  delete s.players[key]
  s.updatedAt = Date.now()
  save(db)
  return { ok: true }
}

// 列出某个服务器登记过的玩家（服主排前面，其次按最后在线时间倒序）
// opts：{ ais, mainName, guestPrefix, includeAi } —— 不给就用当前 config.json / ais.json 判断。
// ai 名字（way-xxx / 主 ai / ais.json 里有的）默认**不出现在玩家表**里，
// 需要连 ai 一起看时传 includeAi: true（返回项带 kind: 'player' | 'ai'）。
function listPlayers (host, port, opts) {
  const o = opts || {}
  const s = bucket(load(), serverKey(host, port), false)
  if (!s) return []
  const key = serverKey(host, port)
  const ais = o.ais || readAis()
  return Object.keys(s.players).map((k) => {
    const p = s.players[k] || {}
    const name = p.name || k
    const cls = classifyName(name, { ais, mainName: o.mainName, guestPrefix: o.guestPrefix })
    return {
      key: k,
      name,
      kind: cls.isAi ? 'ai' : 'player',
      aiOwner: cls.isAi ? (cls.owner || inferOwner(name, Object.assign({ ais }, o))) : null,
      role: p.role === 'owner' ? 'owner' : 'member',
      aiName: typeof p.aiName === 'string' ? p.aiName : '',
      // 别名（成员给初始 ai 起的叫法；服主为主 ai 用自己的名字，这里为空）
      alias: typeof p.alias === 'string' ? p.alias : '',
      renamedFrom: Array.isArray(p.renamedFrom) ? p.renamedFrom : [],
      note: p.note || '',
      firstSeen: p.firstSeen || 0,
      lastSeen: p.lastSeen || 0,
      joinCount: p.joinCount || 0,
      serverKey: key
    }
  }).filter((p) => o.includeAi || p.kind !== 'ai').sort((a, b) => {
    if (a.role !== b.role) return a.role === 'owner' ? -1 : 1
    return (b.lastSeen || 0) - (a.lastSeen || 0)
  })
}

// 改某个 ai 的听从名单（谁能指挥它）。空数组 = 所有人。
// 立即生效：bot 每收到一条聊天都会重读 ais.json（见 bot.js 的 readAis()）。
function setAiObey (name, list) {
  const key = String(name == null ? '' : name).trim()
  if (!key) throw new Error('没指明是哪个 ai')
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(AIS_FILE, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new Error('读不到 ais.json（主 ai 还没启动过？）')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ais.json 格式不对')
  if (!raw[key]) throw new Error('ais.json 里没有叫「' + key + '」的 ai')
  const arr = (Array.isArray(list) ? list : String(list == null ? '' : list).split(','))
    .map((s) => String(s).trim()).filter(Boolean)
  raw[key].obey = arr
  fs.writeFileSync(AIS_FILE, JSON.stringify(raw, null, 2))
  return raw[key]
}

// 读 ais.json（面板也要看"谁有哪些 ai"）
function readAis () {
  try {
    const a = JSON.parse(fs.readFileSync(AIS_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return a && typeof a === 'object' && !Array.isArray(a) ? a : {}
  } catch (e) {
    return {}
  }
}

module.exports = {
  FILE, AIS_FILE, DIR, NAME_RE,
  serverKey, defaultAiName,
  load, save,
  recordJoin, renameAi, renameAisKey, setRole, removePlayer, listPlayers,
  setAiObey, readAis,
  // 名字归类（人 / ai），面板「玩家登记」和 bot.js 的 playerJoined 都用它
  classifyName, inferOwner, pruneAiEntries, prefixOf,
  // 别名：初始 ai 名字固定，成员用别名在游戏里指挥它
  setAlias, findByAiName, cleanAlias
}
