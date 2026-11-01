// ===== 面板功能：连接与权限（源码/panel/api/config.js）=====
// ui.type='custom'（web/views/config.js）—— 因为这个页面已经不是"一张表单"了：
//   · 多个服务器分页（配置/服务器配置.json，见 _profiles.js）
//   · 服主视角：改配置 + 管理玩家（角色 / 初始 ai 名 / 名下 ai 的听从名单）
//   · 非服主视角：只能改自己「初始 ai」的名字（默认 way-<玩家名>）
//
// 安全约定（改这个文件前先读）：
//   - 只写 _fields.js 声明过的字段；请求里带了别的键直接忽略。
//   - 写 config.json 之前先读出来，只覆盖声明的字段 → 不认识的字段、顺序都不丢。
//   - 类型转换失败一律 400，绝不悄悄写 undefined。
const fs = require('fs')
const path = require('path')
const U = require('./_util')
const F = require('./_fields')
const P = require('./_profiles')
const 玩家登记 = require('../../玩家登记')

// ai 每收到一条聊天都会往这里追加一行（见 源码/bot.js 的 logChat）
const CHAT_LOG = path.join(U.ROOT, '日志', '聊天.log')

// ---- 平台告警 / 顺手用的工具 ----
const VIEW_TEXT = { owner: '服主', member: '非服主（成员）' }

// 把"谁有哪些 ai"算出来：归属优先 ais.json 的 owner，没有就按名字猜（way-alice → alice）
// opts.aliasMap：Map(ai名小写 → 别名)，来自玩家登记（R5：服主要能看到成员初始 ai 的别名）
function attachAis (players, opts) {
  const o = opts || {}
  const ais = o.ais || 玩家登记.readAis()
  const prefix = o.guestPrefix
  const aliasMap = o.aliasMap instanceof Map ? o.aliasMap : new Map()
  const byOwner = new Map()
  const rest = []
  for (const name of Object.keys(ais)) {
    const rec = ais[name] || {}
    const direct = String(rec.owner == null ? '' : rec.owner).trim()
    const guess = direct ? '' : String(玩家登记.inferOwner(name, { ais, guestPrefix: prefix, players }) || '').trim()
    const ownerName = direct || guess
    const item = {
      name,
      alias: aliasMap.get(String(name).toLowerCase()) || rec.alias || '',
      owner: ownerName || null,
      ownerGuessed: !direct && !!guess, // 归属是"猜"出来的（面板要标一下）
      obey: Array.isArray(rec.obey) ? rec.obey : [],
      pid: rec.pid || null
    }
    const key = ownerName.toLowerCase()
    if (!key) { rest.push(item); continue }
    if (!byOwner.has(key)) byOwner.set(key, [])
    byOwner.get(key).push(item)
  }
  for (const p of players) {
    p.ais = byOwner.get(p.key) || []
    p.roleText = p.role === 'owner' ? '服主' : '成员'
  }
  return { players, freeAis: rest }
}

// 由玩家列表建"ai名 → 别名"的索引（服主主 ai 没别名就用它的名字）
function aliasMapOf (players) {
  const m = new Map()
  for (const p of players || []) {
    if (p && p.aiName && p.alias) m.set(String(p.aiName).toLowerCase(), String(p.alias))
  }
  return m
}

// 全局字段（behavior / building）直接写 config.json；分页字段写档案
function writeGlobal (patch) {
  const original = U.readJsonFile(U.CONFIG_FILE, null)
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    throw new U.HttpError(500, 'config.json 读不出来或格式不对，先手动修好再来面板里改')
  }
  const next = JSON.parse(JSON.stringify(original))
  for (const key of Object.keys(patch)) F.setDotted(next, key, patch[key])
  U.writeJsonFile(U.CONFIG_FILE, next)
}

function profileHostPort (id) {
  const prof = P.get(id)
  const s = (prof && prof.server) || {}
  return { host: s.host || 'localhost', port: parseInt(s.port, 10) || 25565 }
}

// 读 日志/聊天.log 的最后 N 条（面板「聊天监视」用）
// 行格式：`[HH:MM:SS] kind\t发送者\t内容`（kind: chat=玩家 / ai=ai 自己说的）
// 返回的每条会带上 fromIsAi / aiOwner / alias：一眼看出"这条是哪个 ai 说的、它归谁、叫什么别名"
// opts: { mainName, guestPrefix, ai, owner, host, port }
//   ai    只看这个 ai 的发言
//   owner 只看这个玩家 + 他名下 ai 的发言
//   byAi  每个 ai 说了多少句（R4：服主要能记录每个 ai 的聊天）
function readChat (n, opts) {
  const o = opts || {}
  const want = Math.max(1, Math.min(200, parseInt(n, 10) || 40))
  const out = { file: CHAT_LOG, entries: [], missing: true, total: 0, byAi: [] }
  let text = ''
  try { text = fs.readFileSync(CHAT_LOG, 'utf8') } catch (e) { return out }
  const all = text.split(/\r?\n/).filter((l) => l.trim())
  out.missing = false
  out.total = all.length
  const ais = o.ais || 玩家登记.readAis()

  // 初始 ai 名 → 归属玩家 / 别名（来自登记表；没有 host 就跳过 owner 过滤）
  const ownerOf = new Map()
  const aliasOf = new Map()
  try {
    const db = 玩家登记.load()
    const s = db.servers[玩家登记.serverKey(o.host, o.port)]
    for (const k of Object.keys((s && s.players) || {})) {
      const p = s.players[k] || {}
      if (!p.aiName) continue
      ownerOf.set(String(p.aiName).toLowerCase(), p.name || k)
      if (p.alias) aliasOf.set(String(p.aiName).toLowerCase(), p.alias)
    }
  } catch (e) { /* 登记读不到就不做归属过滤 */ }

  const entries = []
  for (const line of all) {
    const m = /^\[(\d\d:\d\d:\d\d)\]\s+(\w+)\t([^\t]*)\t([\s\S]*)$/.exec(line)
    if (!m) {
      entries.push({ time: '', kind: 'chat', from: '', text: line, fromIsAi: false, aiOwner: null, alias: '' })
      continue
    }
    const from = m[3]
    const low = from.toLowerCase()
    const cls = 玩家登记.classifyName(from, { ais, mainName: o.mainName, guestPrefix: o.guestPrefix })
    entries.push({
      time: m[1],
      kind: m[2] === 'ai' ? 'ai' : 'chat',
      from,
      text: m[4],
      fromIsAi: cls.isAi,
      aiOwner: cls.isAi
        ? (cls.owner || ownerOf.get(low) || 玩家登记.inferOwner(from, { ais, mainName: o.mainName, guestPrefix: o.guestPrefix }))
        : null,
      alias: aliasOf.get(low) || ''
    })
  }

  // 每个 ai 的统计（R4）：名字 / 别名 / 归属 / 说了多少句 / 最后一句
  const byMap = new Map()
  for (const e of entries) {
    if (!e.fromIsAi) continue
    const k = e.from.toLowerCase()
    const cur = byMap.get(k) || { name: e.from, alias: e.alias, owner: e.aiOwner, count: 0, last: '' }
    cur.count++
    cur.last = e.text
    if (e.alias) cur.alias = e.alias
    if (e.aiOwner) cur.owner = e.aiOwner
    byMap.set(k, cur)
  }
  out.byAi = Array.from(byMap.values()).sort((a, b) => b.count - a.count)

  let picked = entries
  const onlyAi = String(o.ai || '').trim().toLowerCase()
  if (onlyAi) picked = picked.filter((e) => String(e.from).toLowerCase() === onlyAi)
  const onlyOwner = String(o.owner || '').trim().toLowerCase()
  if (onlyOwner) {
    picked = picked.filter((e) => {
      if (String(e.from).toLowerCase() === onlyOwner) return true // 玩家自己说的话
      const own = e.aiOwner || ownerOf.get(String(e.from).toLowerCase()) || ''
      return String(own).toLowerCase() === onlyOwner
    })
  }
  out.entries = picked.slice(-want)
  return out
}

// 成员视角的护栏：成员改 ai 时必须带上自己在游戏里的名字（owner），只能碰自己名下的 ai。
// 面板是本机工具、没有登录，这玩意儿防的是"点错人 / 手滑"，不是安全边界；
// 服主视角不传 owner → 不受限制（服主本来就该能管所有 ai）。
function checkAiOwner (aiName, ownerName, cfg) {
  const who = String(ownerName == null ? '' : ownerName).trim()
  if (!who) return
  if (String(cfg.ai.name).toLowerCase() === String(aiName).toLowerCase()) {
    throw new U.HttpError(400, '主 ai 是服务器共用的，不能从成员视角改（要改请用「服主」视角）')
  }
  const rec = 玩家登记.readAis()[aiName]
  if (!rec) throw new U.HttpError(400, 'ais.json 里没有叫「' + aiName + '」的 ai（主 ai 启动过才有记录）')
  const real = String(rec.owner == null ? '' : rec.owner).trim().toLowerCase()
  if (!real || real !== who.toLowerCase()) {
    throw new U.HttpError(403, '「' + aiName + '」不是你（' + who + '）的 ai，不能改')
  }
}

module.exports = {
  id: 'config',
  title: '连接与权限',
  order: 30,
  status: 'ready',
  summary: '多个服务器分页 / 服主与成员视角 / 玩家与 ai 登记',
  ui: { type: 'custom', view: 'config' },
  routes: {
    // 页面数据（一次拿全：分页、字段、当前值、玩家登记、运行时告警）
    'GET /': async (ctx) => {
      const cfg = U.config.load()
      const info = P.info()
      const wantId = String((ctx.query && ctx.query.id) || info.active || '')
      const prof = P.get(wantId) || P.get(info.active)
      const activeId = prof ? prof.id : ''

      // 分页字段以档案为准；全局字段以 config.json 为准（它们不属于某个服务器）
      const cfgFlat = F.flatten(cfg)
      const globalValues = {}
      for (const key of Object.keys(cfgFlat)) if (!F.isProfileKey(key)) globalValues[key] = cfgFlat[key]
      const values = Object.assign({}, F.flatten(prof), globalValues)

      const hp = profileHostPort(activeId)
      const ais = 玩家登记.readAis()
      const regOpts = { ais, mainName: cfg.ai.name, guestPrefix: cfg.ai.guestPrefix }
      // 顺手把历史上误记成玩家的 ai（world / AIBuilder / way-xxx）清出登记表
      const pruned = 玩家登记.pruneAiEntries(Object.assign({ host: hp.host, port: hp.port }, regOpts))
      const rawList = 玩家登记.listPlayers(hp.host, hp.port, regOpts)
      const list = rawList.map((p) => Object.assign({}, p, {
        lastSeenText: p.lastSeen ? U.fmtTime(p.lastSeen) : '—',
        firstSeenText: p.firstSeen ? U.fmtTime(p.firstSeen) : '—',
        // 初始 ai 名**固定**：成员 = <前缀><玩家名>，服主 = 主 ai 名（R1）
        defaultName: 玩家登记.defaultAiName(p.name, p.role, cfg.ai.guestPrefix)
      }))
      const withAis = attachAis(list, { ais, guestPrefix: cfg.ai.guestPrefix, aliasMap: aliasMapOf(list) })
      const view = prof ? (prof.view || '') : ''
      const isMember = view === 'member'
      // 成员视角**不下发服主专用的字段/值**（R6：不显示服主的信息，只给自己能设置的部分）
      const fieldsForView = isMember ? F.FIELDS.filter((f) => !f.ownerOnly) : F.FIELDS
      const valuesForView = {}
      for (const k of Object.keys(values)) {
        if (!isMember || !F.isOwnerOnly(k)) valuesForView[k] = values[k]
      }

      const appliedLabel = (info.profiles.find((p) => p.id === info.applied) || {}).label || ''
      return {
        file: U.CONFIG_FILE,
        profileFile: P.FILE,
        registryFile: 玩家登记.FILE,
        serverKey: 玩家登记.serverKey(hp.host, hp.port),
        profiles: info.profiles,
        active: activeId,
        applied: info.applied,
        appliedLabel,
        // 看的分页 ≠ 游戏在用的分页，要在界面上说清楚（不然改了配置发现没生效很懵）
        appliedMismatch: !!info.applied && info.applied !== activeId,
        fields: fieldsForView,
        groups: F.groupedFields(fieldsForView),
        values: valuesForView,
        globalValues,
        // 成员视角不透露服主是谁 / 主 ai 叫什么
        owner: isMember ? '' : (cfg.ai.owner || ''),
        guestPrefix: cfg.ai.guestPrefix || 'way-',
        mainAi: isMember ? '' : cfg.ai.name,
        // 这一页的视角（创建分页时选定、之后锁死；老分页可能是空串，面板会提示"选一次"）
        view,
        viewText: VIEW_TEXT[view] || '（还没选）',
        viewLocked: !!view,
        profilesViews: info.profiles,
        pruned,
        chatFile: CHAT_LOG,
        // 成员只拿到"名字列表"（用来找自己），不给角色 / 别人的初始 ai 名 / ai 归属
        playerNames: rawList.map((p) => p.name),
        players: isMember ? [] : withAis.players,
        freeAis: isMember ? [] : withAis.freeAis,
        effective: U.config.summary(cfg),
        warnings: cfg._warnings || []
      }
    },

    // 成员视角专用：只查**自己**那条 + 自己名下的 ai（不暴露别人的）
    //   GET /me?username=alice
    'GET /me': async (ctx) => {
      const cfg = U.config.load()
      const hp = profileHostPort(String((ctx.query && ctx.query.id) || P.info().active || ''))
      const username = String((ctx.query && ctx.query.username) || '').trim()
      if (!username) throw new U.HttpError(400, '要带上 username（你在游戏里的名字）')
      const ais = 玩家登记.readAis()
      const regOpts = { ais, mainName: cfg.ai.name, guestPrefix: cfg.ai.guestPrefix }
      const all = 玩家登记.listPlayers(hp.host, hp.port, regOpts)
      const key = username.toLowerCase()
      const me = all.find((p) => p.key === key || String(p.name).toLowerCase() === key)
      if (!me) {
        return {
          found: false,
          note: '没有找到「' + username + '」的登记：先进一次服务器（ai 会自动记录）',
          guestPrefix: cfg.ai.guestPrefix || 'way-'
        }
      }
      const withAis = attachAis([me], { ais, guestPrefix: cfg.ai.guestPrefix, aliasMap: aliasMapOf(all) })
      return {
        found: true,
        player: withAis.players[0],
        guestPrefix: cfg.ai.guestPrefix || 'way-',
        chatFile: CHAT_LOG
      }
    },


    // 保存：分页字段进档案；"正在生效的那页"顺手写进 config.json；全局字段直接写 config.json
    'POST /save': async (ctx) => {
      const b = ctx.body || {}
      const patch = F.toPatch(b.values)
      const keys = Object.keys(patch)
      if (!keys.length) throw new U.HttpError(400, '没有可保存的字段（只认面板声明过的那些）')
      const id = String(b.id || P.info().active || '')
      // 成员视角也能改配置，但**服主专用的那几项**（服主游戏名 / op 策略 / op 名单）不让改：
      // 它们决定"这台服务器归谁管"，成员改了会影响所有人。直接 403，别静默丢掉（否则用户以为存上了）。
      const view = (P.get(id) || {}).view || ''
      if (view === 'member') {
        const bad = keys.filter((k) => F.isOwnerOnly(k))
        if (bad.length) {
          throw new U.HttpError(403, '这几项是服主专用的，成员视角不能改：' + bad.join('、') +
            '（要改请让服主来 / 或新建一个「服主」视角的分页）')
        }
      }
      const parts = F.splitPatch(patch)
      let applied = false
      if (Object.keys(parts.profile).length) {
        P.saveValues(id, parts.profile)
        if (P.info().applied === id) { P.apply(id); applied = true }
      }
      if (Object.keys(parts.global).length) writeGlobal(parts.global)
      const cfg = U.config.load()
      const label = (P.get(id) || {}).label || id
      return {
        ok: true,
        saved: keys.length,
        applied,
        effective: U.config.summary(cfg),
        warnings: cfg._warnings || [],
        note: applied
          ? '已保存 ' + keys.length + ' 项，并写进 config.json（重启 ai 才生效）'
          : '已保存 ' + keys.length + ' 项到分页「' + label + '」（还没应用到游戏）'
      }
    },

    'POST /profile/new': async (ctx) => {
      const b = ctx.body || {}
      // view：这一页是"服主"还是"非服主（成员）"，创建时定下来，之后不能改
      return P.create({ label: b.label, copyFrom: b.copyFrom, view: b.view })
    },
    // 老分页（创建时还没有 view 字段）补一次视角；已有视角会 400
    'POST /profile/view': async (ctx) => {
      const b = ctx.body || {}
      return P.setView(String(b.id || P.info().active || ''), b.view)
    },
    'POST /profile/label': async (ctx) => {
      const b = ctx.body || {}
      return P.rename(String(b.id || ''), b.label)
    },
    'POST /profile/delete': async (ctx) => {
      const b = ctx.body || {}
      return P.remove(String(b.id || ''))
    },
    'POST /profile/active': async (ctx) => {
      const b = ctx.body || {}
      return P.setActive(String(b.id || ''))
    },
    // 把某一页抄进 config.json（切服务器就点这个，然后重启 ai）
    'POST /apply': async (ctx) => {
      const b = ctx.body || {}
      const r = P.apply(String(b.id || P.info().active || ''))
      const cfg = U.config.load()
      return Object.assign({}, r, {
        effective: U.config.summary(cfg),
        note: '已把「' + r.label + '」写进 config.json，重启 ai 生效'
      })
    },

    // 聊天监视：读 日志/聊天.log 的最后 N 条（面板每几秒拉一次）
    // 聊天监视：读 日志/聊天.log 的最后 N 条（面板每几秒拉一次）
    //   ?n=40            条数
    //   ?ai=<ai名>       只看这个 ai 的发言（服主：记录每个 ai 的聊天，R4）
    //   ?owner=<玩家名>   只看这个玩家 + 他名下 ai 的发言（成员视角用，不暴露别人）
    // 返回还会带 byAi：[{name, alias, count, last}]，服主能一眼看到"哪个 ai 说了多少句"
    'GET /chat': async (ctx) => {
      const cfg = U.config.load()
      const q = ctx.query || {}
      const hp = profileHostPort(String(q.id || P.info().active || ''))
      const base = { host: hp.host, port: hp.port, mainName: cfg.ai.name, guestPrefix: cfg.ai.guestPrefix }
      return readChat(q.n, Object.assign({}, base, { ai: q.ai, owner: q.owner }))
    },

    // 探测端口（改 host/port 之前先点一下，省得改完才发现连不上）
    'POST /probe': async (ctx) => {
      const b = ctx.body || {}
      const host = String(b.host || '127.0.0.1').trim() || '127.0.0.1'
      const port = U.toInt(b.port, 25565)
      if (port < 1 || port > 65535) throw new U.HttpError(400, '端口要在 1-65535 之间')
      const r = await U.probeTcp(host, port, 1500)
      return {
        ok: r.ok,
        ms: r.ms,
        host,
        port,
        note: r.ok
          ? '端口通，有程序在监听（是不是 Minecraft 服务器，得真连上才知道）'
          : '连不上（' + (r.error || '未知错误') + '）：服务器没开，或者地址 / 端口不对'
      }
    },

    // ---- 玩家 / ai 管理（服主视角 + 非服主改名都走这里）----
    // 改名：**已取消**（R1：初始 ai 名称固定）。保留路由只为给老前端/老脚本一句明确的错误。
    'POST /player/rename': async (ctx) => {
      const hp = profileHostPort(String((ctx.body || {}).id || ''))
      const cfg = U.config.load()
      try {
        玩家登记.renameAi({ host: hp.host, port: hp.port, mainName: cfg.ai.name })
      } catch (e) {
        throw new U.HttpError(400, (e && e.message) || '初始 ai 名称固定，不能改名；请改用别名')
      }
      throw new U.HttpError(400, '初始 ai 名称固定，不能改名；请改用别名')
    },

    // 设置 / 清除**别名**（R2）：成员的初始 ai 名字固定（way-<玩家名>），
    // 但可以给它起个别名叫「小A」，游戏里 "小A build ..." 和 "way-alice build ..." 等价。
    //   body: { id, username, alias, owner? }
    //   服主视角不传 owner → 谁都能设；成员视角必须 owner == username（只能给自己设）
    'POST /player/alias': async (ctx) => {
      const b = ctx.body || {}
      const hp = profileHostPort(String(b.id || ''))
      const cfg = U.config.load()
      const username = String(b.username || '').trim()
      if (!username) throw new U.HttpError(400, '玩家名不能为空')
      const view = (P.get(String(b.id || P.info().active || '')) || {}).view || ''
      const who = String(b.owner == null ? '' : b.owner).trim()
      if (view === 'member' || who) {
        // 成员只能给自己设别名（面板没登录，这是防"改到别人头上"的软护栏）
        if (!who || who.toLowerCase() !== username.toLowerCase()) {
          throw new U.HttpError(403, '成员视角只能给自己设置别名（别人家的 ai 由服主设）')
        }
      }
      let r
      try {
        r = 玩家登记.setAlias({
          host: hp.host,
          port: hp.port,
          username,
          alias: b.alias,
          mainName: cfg.ai.name
        })
      } catch (e) {
        throw new U.HttpError(400, (e && e.message) || '设置别名失败')
      }
      return {
        ok: true,
        username: r.username,
        aiName: r.aiName,
        alias: r.alias,
        note: r.alias
          ? '已把 ' + r.username + ' 的初始 ai（' + r.aiName + '）别名设为「' + r.alias +
            '」：游戏里说「' + r.alias + ' build ...」也能指挥它（ai 下次上线会向主 ai 报告别名）'
          : '已清除 ' + r.username + ' 的别名（只能用 ' + r.aiName + ' 指挥）'
      }
    },
    'POST /player/role': async (ctx) => {
      const b = ctx.body || {}
      const hp = profileHostPort(String(b.id || ''))
      try {
        return 玩家登记.setRole({ host: hp.host, port: hp.port, username: b.username, role: b.role })
      } catch (e) {
        throw new U.HttpError(400, (e && e.message) || '改角色失败')
      }
    },
    'POST /player/delete': async (ctx) => {
      const b = ctx.body || {}
      const hp = profileHostPort(String(b.id || ''))
      try {
        return 玩家登记.removePlayer({ host: hp.host, port: hp.port, username: b.username })
      } catch (e) {
        throw new U.HttpError(400, (e && e.message) || '删除失败')
      }
    },

    // 服主可以直接改某个 ai 的名字（只改 ais.json，不动玩家登记的"初始 ai 名"）
    'POST /ai/rename': async (ctx) => {
      const b = ctx.body || {}
      const from = String(b.from || '').trim()
      const to = String(b.to || '').trim()
      const cfg = U.config.load()
      if (!from || !to) throw new U.HttpError(400, '要填原名字和新名字')
      if (from === to) return { ok: true, note: '名字没变' }
      // 成员视角会带 owner：只能改自己名下的 ai
      checkAiOwner(from, b.owner, cfg)
      if (from.toLowerCase() === String(cfg.ai.name).toLowerCase()) {
        throw new U.HttpError(400, '主 ai 的名字不能在这里改（它在分页的 ai.name 里）')
      }
      if (!玩家登记.NAME_RE.test(to)) throw new U.HttpError(400, '新名字只能是 2–16 位字母 / 数字 / 下划线 / 中文')
      if (!玩家登记.renameAisKey(from, to)) {
        throw new U.HttpError(400, 'ais.json 里没有「' + from + '」，或者「' + to + '」已经被占用')
      }
      return { ok: true, note: '已改名（重启对应的 ai 进程后游戏里才会用新名字）' }
    },

    // 服主改某个 ai 的"谁能指挥"（ais.json 的 obey；ai 每收到一条聊天都会重读，立即生效）
    // 成员视角也能用这条，但必须带 owner（自己的游戏名）且只能改自己名下的 ai。
    'POST /ai/obey': async (ctx) => {
      const b = ctx.body || {}
      const name = String(b.name || '').trim()
      if (!name) throw new U.HttpError(400, '要指明是哪个 ai')
      checkAiOwner(name, b.owner, U.config.load())
      const list = Array.isArray(b.obey) ? b.obey : String(b.obey == null ? '' : b.obey).split(',')
      try {
        const rec = 玩家登记.setAiObey(name, list)
        return { ok: true, obey: rec.obey, note: '已更新「' + name + '」的听从名单（立即生效，不用重启）' }
      } catch (e) {
        throw new U.HttpError(400, (e && e.message) || '保存失败')
      }
    }
  }
}
