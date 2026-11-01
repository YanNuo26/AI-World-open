// ===== 服务器配置分页（源码/panel/api/_profiles.js）=====
// 需求：「连接与权限」要能存**多个服务器**，每个一页。
//
// 数据分两处，别搞混：
//   配置/服务器配置.json  → **所有分页**（面板的"档案柜"）
//   config.json           → **当前生效**的那一份（ai 只读它）
// 所以：改分页 = 改档案；「应用到游戏」才把档案抄进 config.json。
// 这样临时去看朋友服的配置，不会顺手把正在跑的 ai 的配置改掉。
const fs = require('fs')
const path = require('path')
const U = require('./_util')
const F = require('./_fields')

const FILE = path.join(U.ROOT, '配置', '服务器配置.json')
const MAX_PROFILES = 30

// 从完整配置里挑出"跟着服务器走"的几段（深拷贝，避免把默认值对象写进档案）
function pickSections (cfg) {
  const out = {}
  for (const g of F.PROFILE_GROUPS) {
    const v = cfg && cfg[g]
    out[g] = v && typeof v === 'object' && !Array.isArray(v) ? JSON.parse(JSON.stringify(v)) : {}
  }
  return out
}

function cleanLabel (v, fallback) {
  const s = String(v == null ? '' : v).trim().slice(0, 40)
  return s || fallback || '未命名服务器'
}

// 视角 = 这一页是"服主"还是"非服主（成员）"。
// 2026-11-01 改：视角**在创建分页时选定、之后不能改**（一台机器上谁是服主是固定的），
// 所以老分页可能是空串（''），面板会提示"选一次"，选完就锁死。
const VIEWS = ['owner', 'member']
function cleanView (v) {
  const s = String(v == null ? '' : v).trim().toLowerCase()
  return VIEWS.includes(s) ? s : ''
}

function nextId (db) {
  let i = 1
  while (db.profiles.some((p) => p.id === 'p' + i)) i++
  return 'p' + i
}

// 把文件内容整理成可用的结构（坏数据不许让面板崩）
function normalize (raw) {
  const db = { active: '', applied: '', profiles: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return db
  const list = Array.isArray(raw.profiles) ? raw.profiles : []
  const seen = new Set()
  for (const p of list) {
    if (!p || typeof p !== 'object') continue
    let id = String(p.id == null ? '' : p.id).trim()
    if (!/^[\w-]{1,20}$/.test(id) || seen.has(id)) id = 'p' + (seen.size + 1)
    if (seen.has(id)) continue
    seen.add(id)
    const item = { id, label: cleanLabel(p.label, '服务器 ' + (seen.size)), view: cleanView(p.view) }
    for (const g of F.PROFILE_GROUPS) {
      item[g] = p[g] && typeof p[g] === 'object' && !Array.isArray(p[g]) ? p[g] : {}
    }
    db.profiles.push(item)
  }
  const ids = db.profiles.map((p) => p.id)
  db.active = ids.includes(raw.active) ? raw.active : (ids[0] || '')
  db.applied = ids.includes(raw.applied) ? raw.applied : ''
  return db
}

// 读档案柜；第一次用（文件不存在）就拿当前 config.json 建一页，用户无感
function load () {
  const raw = U.readJsonFile(FILE, null)
  let db = normalize(raw)
  if (!db.profiles.length) {
    db = normalize({
      active: 'p1',
      applied: 'p1',
      profiles: [Object.assign(
        { id: 'p1', label: '默认服务器（当前 config.json）', view: 'owner' },
        pickSections(U.config.load())
      )]
    })
    save(db)
  }
  return db
}

function save (db) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    U.writeJsonFile(FILE, db)
    return true
  } catch (e) {
    return false
  }
}

function info () {
  const db = load()
  return {
    file: FILE,
    active: db.active,
    applied: db.applied,
    profiles: db.profiles.map((p) => ({ id: p.id, label: p.label, view: cleanView(p.view) }))
  }
}

function get (id) {
  const db = load()
  return db.profiles.find((p) => p.id === id) || db.profiles[0] || null
}

// 某页的表单值（只有 server.* / rcon.* / ai.* 这些字段）
function values (id) {
  const p = get(id)
  return p ? F.flatten(p) : {}
}

// 存一页（只存 FIELDS 声明过、且属于该分页的字段）
function saveValues (id, patch) {
  const db = load()
  const p = db.profiles.find((x) => x.id === id)
  if (!p) throw new U.HttpError(404, '没有这个分页：' + id)
  let n = 0
  for (const key of Object.keys(patch || {})) {
    if (!F.isProfileKey(key) || !F.FIELD_MAP[key]) continue
    F.setDotted(p, key, patch[key])
    n++
  }
  db.active = id
  if (!save(db)) throw new U.HttpError(500, '写入 ' + FILE + ' 失败')
  return { saved: n, profile: { id: p.id, label: p.label } }
}

// 把一页抄进 config.json（游戏里真正生效的那份）
function apply (id) {
  const db = load()
  const p = db.profiles.find((x) => x.id === id)
  if (!p) throw new U.HttpError(404, '没有这个分页：' + id)
  const original = U.readJsonFile(U.CONFIG_FILE, null)
  const next = original && typeof original === 'object' && !Array.isArray(original)
    ? JSON.parse(JSON.stringify(original))
    : {}
  for (const g of F.PROFILE_GROUPS) {
    next[g] = Object.assign({}, (next[g] && typeof next[g] === 'object') ? next[g] : {}, JSON.parse(JSON.stringify(p[g] || {})))
  }
  U.writeJsonFile(U.CONFIG_FILE, next)
  db.applied = id
  db.active = id
  save(db)
  return { ok: true, applied: id, label: p.label }
}

function create (opts) {
  const o = opts || {}
  const db = load()
  if (db.profiles.length >= MAX_PROFILES) throw new U.HttpError(400, '分页太多了（上限 ' + MAX_PROFILES + ' 个），先删几个')
  const from = o.copyFrom ? db.profiles.find((x) => x.id === o.copyFrom) : null
  const base = from || { server: {}, rcon: {}, ai: {} }
  const item = {
    id: nextId(db),
    label: cleanLabel(o.label, '服务器 ' + (db.profiles.length + 1)),
    // 视角只在创建时定一次，之后不能改（见 cleanView 上面的说明）
    view: cleanView(o.view) || 'owner'
  }
  for (const g of F.PROFILE_GROUPS) item[g] = JSON.parse(JSON.stringify(base[g] || {}))
  db.profiles.push(item)
  db.active = item.id
  save(db)
  return { ok: true, id: item.id, label: item.label, view: item.view }
}

// 给老分页补一次视角（它们创建时还没有这个字段）。
// 已经有视角就拒绝 —— 这正是"之后不再切换"的保证。
function setView (id, view) {
  const db = load()
  const p = db.profiles.find((x) => x.id === id)
  if (!p) throw new U.HttpError(404, '没有这个分页：' + id)
  const want = cleanView(view)
  if (!want) throw new U.HttpError(400, '视角只能是 owner（服主）或 member（成员）')
  if (p.view) {
    throw new U.HttpError(400, '这个分页的视角已经定死了（' + (p.view === 'owner' ? '服主' : '成员') +
      '）：视角在创建分页时选定，之后不能切换')
  }
  p.view = want
  save(db)
  return { ok: true, id, view: p.view, note: '视角已定为' + (want === 'owner' ? '「服主」' : '「成员」') + '，之后不能再切换' }
}

function rename (id, label) {
  const db = load()
  const p = db.profiles.find((x) => x.id === id)
  if (!p) throw new U.HttpError(404, '没有这个分页：' + id)
  p.label = cleanLabel(label, p.label)
  save(db)
  return { ok: true, id, label: p.label }
}

function remove (id) {
  const db = load()
  if (db.profiles.length <= 1) throw new U.HttpError(400, '至少要留一个分页')
  const p = db.profiles.find((x) => x.id === id)
  if (!p) throw new U.HttpError(404, '没有这个分页：' + id)
  db.profiles = db.profiles.filter((x) => x.id !== id)
  if (db.active === id) db.active = db.profiles[0].id
  if (db.applied === id) db.applied = '' // config.json 不动：删档案不等于停服
  save(db)
  return { ok: true, removed: id }
}

function setActive (id) {
  const db = load()
  if (!db.profiles.some((x) => x.id === id)) throw new U.HttpError(404, '没有这个分页：' + id)
  db.active = id
  save(db)
  return { ok: true, active: id }
}

module.exports = {
  FILE, MAX_PROFILES, VIEWS,
  load, save, info, get, values, saveValues, apply, create, rename, remove, setActive,
  setView, cleanView, pickSections, cleanLabel
}
