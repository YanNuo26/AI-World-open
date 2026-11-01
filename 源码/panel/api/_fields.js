// ===== 配置字段定义（源码/panel/api/_fields.js）=====
// 从 config.js 拆出来：现在「连接与权限」既有表单（写 config.json），
// 又有"多个服务器分页"（写 配置/服务器配置.json），两边都要用同一份字段表，
// 放一起才不会出现"表单能改、分页不认识这个字段"的情况。
//
// 安全约定（别破坏）：
//   - 只写这里声明过的字段；请求里带了别的键直接忽略（防止面板被当成任意文件写入器）。
//   - 类型转换失败一律 400，绝不悄悄写成 undefined。
const U = require('./_util')

// 属于"某个服务器"的字段（跟着分页走）：server.* / rcon.* / ai.*
// 其余字段（behavior.* / building.*）是全局的，只写 config.json
const PROFILE_GROUPS = ['server', 'rcon', 'ai']

// 服主专用字段：成员视角**根本看不到**（不是灰掉，是不下发）。
// 判定标准：改了会影响"这台服务器归谁管 / 别人的 ai 怎么叫"，而不是"我怎么连上去"。
// 2026-11-01 第二版（R6）：所有 ai.* 都归服主 —— 主 ai 名字、成员 ai 前缀、op 策略、各种白名单。
//   成员能改的是自己的连接（server.* / rcon.*）和全局表现（behavior.* / building.*），
//   以及**自己的**初始 ai 别名（走 /player/alias，不进这张表）。
const OWNER_ONLY_KEYS = [
  'ai.name', 'ai.owner', 'ai.guestPrefix',
  'ai.autoOp', 'ai.opWhitelist', 'ai.obeyWhitelist'
]

function isOwnerOnly (key) {
  return OWNER_ONLY_KEYS.includes(String(key || ''))
}

function isProfileKey (key) {
  const g = String(key || '').split('.')[0]
  return PROFILE_GROUPS.includes(g)
}

const FIELDS = [
  // ---- 服务器 ----
  { key: 'server.host', label: '服务器地址', type: 'text', group: '服务器', placeholder: 'localhost', hint: '连本机服务器填 localhost；连别人的服填域名/IP' },
  { key: 'server.port', label: '服务器端口', type: 'number', group: '服务器', min: 1, max: 65535, hint: '必须和 服务器/server.properties 的 server-port 一致' },
  { key: 'server.version', label: '游戏版本', type: 'text', group: '服务器', placeholder: '1.21.1', hint: '填 auto = 让 mineflayer 自动探测' },
  {
    key: 'server.auth',
    label: '登录方式',
    type: 'select',
    group: '服务器',
    hint: 'offline 离线（默认，自建服）；microsoft 正版（要填下面两项）',
    options: [
      { value: 'offline', label: 'offline 离线' },
      { value: 'microsoft', label: 'microsoft 正版' }
    ]
  },
  { key: 'server.username', label: '正版账号邮箱', type: 'text', group: '服务器', hint: '只有 auth=microsoft 时才需要' },
  { key: 'server.profilesFolder', label: '正版令牌缓存目录', type: 'text', group: '服务器', hint: '留空 = 用默认位置；换账号时想重新登录就填个新目录' },

  // ---- ai ----
  { key: 'ai.name', label: 'ai 名字', type: 'text', group: 'ai', hint: '游戏里的名字，也是指令前缀（world build ...）' },
  { key: 'ai.owner', label: '服主游戏名', type: 'text', group: 'ai', placeholder: '你自己在游戏里的名字', hint: '面板靠它区分「服主 / 成员」；留空 = 所有人都是成员' },
  { key: 'ai.guestPrefix', label: '成员初始 ai 前缀', type: 'text', group: 'ai', placeholder: 'way-', hint: '非服主的初始 ai 默认叫 <前缀><玩家名>，默认 way-' },
  {
    key: 'ai.autoOp',
    label: '自动 op 策略',
    type: 'select',
    group: 'ai',
    hint: 'local-only 只给本机服的玩家；接别人服务器建议 never',
    options: [
      { value: 'local-only', label: 'local-only 只限本机服务器' },
      { value: 'never', label: 'never 从不 op' },
      { value: 'whitelist', label: 'whitelist 只 op 名单里的人' },
      { value: 'always', label: 'always（进服就 op，公共服危险）' }
    ]
  },
  { key: 'ai.opWhitelist', label: 'op 白名单', type: 'list', group: 'ai', hint: '逗号分隔；配合 autoOp=whitelist 使用' },
  { key: 'ai.obeyWhitelist', label: '指令白名单', type: 'list', group: 'ai', hint: '逗号分隔；空 = 任何玩家都能指挥 ai（公共服必填）' },

  // ---- RCON ----
  { key: 'rcon.enabled', label: '启用 RCON', type: 'switch', group: 'RCON', hint: '关了就没有 op / 玩家列表 / 远距离传送' },
  { key: 'rcon.host', label: 'RCON 地址', type: 'text', group: 'RCON', placeholder: '127.0.0.1' },
  { key: 'rcon.port', label: 'RCON 端口', type: 'number', group: 'RCON', min: 1, max: 65535 },
  { key: 'rcon.password', label: 'RCON 密码', type: 'password', group: 'RCON', hint: '留空会用 服务器/server.properties 里的 rcon.password' },

  // ---- 行为 ----
  { key: 'behavior.markOnBuild', label: '建造前标注范围', type: 'switch', group: '行为' },
  { key: 'behavior.reconnect.enabled', label: '掉线自动重连', type: 'switch', group: '行为' },
  { key: 'behavior.reconnect.maxDelayMs', label: '重连退避上限(毫秒)', type: 'number', group: '行为', min: 1000, max: 600000 },

  // ---- 默认建筑 ----
  {
    key: 'building.building',
    label: '默认建筑',
    type: 'select',
    group: '默认建筑',
    options: [
      { value: 'house', label: 'house 房子' },
      { value: 'tower', label: 'tower 塔' },
      { value: 'pyramid', label: 'pyramid 金字塔' }
    ]
  },
  { key: 'building.size', label: '尺寸', type: 'number', group: '默认建筑', min: 3, max: 64 },
  { key: 'building.height', label: '高度', type: 'number', group: '默认建筑', min: 1, max: 32 },
  { key: 'building.floor', label: '地板材质', type: 'text', group: '默认建筑', placeholder: 'stone' },
  { key: 'building.wall', label: '墙体材质', type: 'text', group: '默认建筑', placeholder: 'oak_planks' },
  { key: 'building.roof', label: '屋顶材质', type: 'text', group: '默认建筑', placeholder: 'bricks' }
]

const FIELD_MAP = {}
for (const f of FIELDS) {
  // 给前端直接带上 ownerOnly 标记：成员视角把这几项渲染成"只读 + 服主专用"
  if (isOwnerOnly(f.key)) f.ownerOnly = true
  FIELD_MAP[f.key] = f
}


// ---- 点路径读写 ----
function getDotted (obj, key) {
  return String(key).split('.').reduce((cur, k) => (cur == null ? undefined : cur[k]), obj)
}

function setDotted (obj, key, value) {
  const keys = String(key).split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object' || Array.isArray(cur[keys[i]])) cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
}

// 把配置压成 { 'server.host': 'localhost', ... } 给表单填值（数组转逗号串）
function flatten (cfg) {
  const out = {}
  for (const f of FIELDS) {
    const v = getDotted(cfg, f.key)
    if (v === undefined) continue
    out[f.key] = Array.isArray(v) ? v.join(',') : v
  }
  return out
}

// 按字段类型转换（转不了抛 400，绝不悄悄写个 undefined 进去）
function coerce (field, raw) {
  const key = field.key
  if (field.type === 'number') {
    const n = parseInt(raw, 10)
    if (isNaN(n)) throw new U.HttpError(400, key + ' 需要数字，收到「' + raw + '」')
    if (field.min != null && n < field.min) throw new U.HttpError(400, key + ' 不能小于 ' + field.min)
    if (field.max != null && n > field.max) throw new U.HttpError(400, key + ' 不能大于 ' + field.max)
    return n
  }
  if (field.type === 'switch') {
    // 表单来的是 'on' / 'true' / true；只有明确表示"关"的才算 false
    return !(raw === false || raw === 'false' || raw === 0 || raw === '0' || raw === 'off' || raw == null)
  }
  if (field.type === 'list') {
    if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean)
    return String(raw == null ? '' : raw).split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (field.type === 'select') {
    const v = String(raw == null ? '' : raw).trim()
    const allowed = (field.options || []).map((o) => o.value)
    if (!allowed.includes(v)) throw new U.HttpError(400, key + ' 只能是 ' + allowed.join(' / ') + '，收到「' + v + '」')
    return v
  }
  // text / password（password 也按字符串处理，不做 trim，免得把密码里的空格吃掉）
  return raw == null ? '' : (field.type === 'password' ? String(raw) : String(raw).trim())
}

// 把前端传来的 values 里"声明过的字段"转成 patch（未知键忽略）
function toPatch (values) {
  const patch = {}
  if (!values || typeof values !== 'object' || Array.isArray(values)) return patch
  for (const key of Object.keys(values)) {
    const field = FIELD_MAP[key]
    if (!field) continue
    patch[key] = coerce(field, values[key])
  }
  return patch
}

// 把 patch 分成"跟着服务器分页走的"和"全局的"
function splitPatch (patch) {
  const profile = {}
  const global = {}
  for (const key of Object.keys(patch)) {
    if (isProfileKey(key)) profile[key] = patch[key]
    else global[key] = patch[key]
  }
  return { profile, global }
}

// 按 group 分组（顺序 = FIELDS 里第一次出现的顺序）
// list 可选：传进来就只分组这些字段（成员视角用它过滤掉服主专用的）
function groupedFields (list) {
  const src = Array.isArray(list) ? list : FIELDS
  const groups = []
  const byGroup = new Map()
  for (const f of src) {
    const g = f.group || '其它'
    if (!byGroup.has(g)) { byGroup.set(g, []); groups.push({ name: g, fields: [] }) }
    byGroup.get(g).push(f)
  }
  for (const g of groups) g.fields = byGroup.get(g.name)
  return groups
}

module.exports = {
  FIELDS, FIELD_MAP, PROFILE_GROUPS, OWNER_ONLY_KEYS,
  isProfileKey, isOwnerOnly, getDotted, setDotted, flatten, coerce, toPatch, splitPatch, groupedFields
}
