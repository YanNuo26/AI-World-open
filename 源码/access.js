// ===== 准入与失败诊断（源码/access.js）=====
// 为什么单独拆一个文件：ai 要连**别人**的服务器，最容易出事的不是建造代码，
// 而是下面两件事，而且它们都是**纯逻辑**（不碰网络、不读文件），值得自动化验证：
//
//   1) 准入 —— 谁能给 ai 下指令、谁能被自动 op。
//      在公共服上这套放错 = 把整个服务器交出去（以前是"谁进服就给谁 op"，
//      指令也只是"谁都能指挥"）。
//   2) 失败诊断 —— 连不上 / 被踢时到底是为什么。
//      白名单、封禁、正版验证、版本不符，mineflayer 只给英文原文，
//      新手完全看不出该怎么改配置。
//
// 约定：策略取值写错时一律**按最保守的那个处理**（不能被写错的配置放大权限）。

// op 策略：
//   local-only  默认。只有连本机（localhost / 127.0.0.1 …）自建服时才自动 op
//   never       从不自动 op（公共服推荐）
//   whitelist   只给 ai.opWhitelist 里的玩家 op
//   always      谁进服都给 op（只在自己开的服上用）
const OP_POLICIES = ['local-only', 'never', 'whitelist', 'always']

// MC 玩家名大小写不敏感；配置里写了空格 / 大小写混着也要能对上
function normalizeName (v) {
  return String(v == null ? '' : v).trim().toLowerCase()
}

// 名单既支持数组（config.json），也支持逗号分隔字符串（环境变量 / 命令行）
function normalizeList (list) {
  if (!list) return []
  const arr = Array.isArray(list) ? list : String(list).split(',')
  return arr.map(normalizeName).filter(Boolean)
}

function opPolicy (raw) {
  const v = normalizeName(raw)
  return OP_POLICIES.includes(v) ? v : 'local-only'
}

// 该不该给这个玩家 op。返回 { ok, reason }，reason 用来打日志（只提示一次）
function canOp ({ policy, username, whitelist, isLocal } = {}) {
  const who = normalizeName(username)
  if (!who) return { ok: false, reason: '没有玩家名' }
  const p = opPolicy(policy)
  if (p === 'always') return { ok: true, reason: 'autoOp=always' }
  if (p === 'never') return { ok: false, reason: 'autoOp=never（配置里关掉了自动 op）' }
  if (p === 'whitelist') {
    return normalizeList(whitelist).includes(who)
      ? { ok: true, reason: '在 opWhitelist 里' }
      : { ok: false, reason: '不在 opWhitelist 里' }
  }
  // local-only
  return isLocal
    ? { ok: true, reason: '本机服务器 + autoOp=local-only' }
    : { ok: false, reason: 'autoOp=local-only：只给本机（自建）服务器的玩家 op' }
}

// 这个玩家能不能指挥 ai。
//   obey ：ais.json 里每个 ai 自己的听从名单（summon 时默认 = 召唤者），空 = 所有人
//   allow：config.json 的 ai.obeyWhitelist（服主设的总白名单），空 = 所有人
// 两套是"都要满足"，空名单不构成限制 —— 这样默认配置的行为和以前完全一样。
function canCommand ({ username, obey, allow } = {}) {
  const who = normalizeName(username)
  if (!who) return { ok: false, reason: '没有玩家名' }
  const o = normalizeList(obey)
  const a = normalizeList(allow)
  if (o.length && !o.includes(who)) return { ok: false, reason: '不在这个 ai 的听从名单（obey）里' }
  if (a.length && !a.includes(who)) return { ok: false, reason: '不在指令白名单（ai.obeyWhitelist）里' }
  return { ok: true, reason: '' }
}

// 失败原因诊断。fatal=true 表示"重连一万次也没用"，调用方应停止自动重连。
// 规则顺序有意义：先匹配具体的（白名单 / 封禁），再匹配笼统的网络错误。
const RULES = [
  {
    re: /not\s*white-?listed|whitelist|白名单/i,
    fatal: true,
    hint: '对方服务器开了白名单：让服主执行 /whitelist add <ai 的名字>（离线服就是 ai.name）'
  },
  {
    re: /you are banned|banned from|封禁|封号/i,
    fatal: true,
    hint: '这个账号 / IP 被封禁了：换个名字（离线服）或联系服主'
  },
  {
    re: /invalid session|failed to verify username|unable to verify|authservers|online mode|正版验证/i,
    fatal: true,
    hint: '服务器是正版验证（online-mode=true）：把 config.json 的 server.auth 改成 "microsoft"，' +
      '并用正版账号登录（进服名字由账号决定，ai.name 会被覆盖）'
  },
  {
    re: /duplicate_login|logged in from another location|already connected/i,
    fatal: true,
    hint: '同一个账号在别处登录了：正版账号不能 summon 多个 ai（它们共用同一个账号）'
  },
  {
    re: /incompatible|outdated|unsupported|not supported|版本/i,
    fatal: true,
    hint: '版本不匹配：把 config.json 的 server.version 改成服务器版本号，或设成 "auto" 自动探测'
  },
  {
    re: /server is full|服务器已满|no free|slots/i,
    fatal: false,
    hint: '服务器满了：腾出位置后会自动重连'
  },
  {
    re: /flying is not enabled|moved too quickly|moved wrongly|floating|anti-?cheat|反作弊/i,
    fatal: false,
    hint: '服务器限制了飞行 / 瞬移（生存服或反作弊插件）：移动和建造会受限，建议只在创造服上用'
  },
  {
    re: /ENOTFOUND|EAI_AGAIN/i,
    fatal: false,
    hint: '域名解析失败：检查 server.host 有没有拼错，或本机 DNS'
  },
  {
    re: /ECONNREFUSED/i,
    fatal: false,
    hint: '对方没有在监听这个端口：确认服务器已启动，server.host / server.port 正确'
  },
  {
    re: /ETIMEDOUT|EHOSTUNREACH|ECONNRESET|socket hang up/i,
    fatal: false,
    hint: '连不上：检查网络 / 防火墙 / 端口是否对外开放'
  }
]

function diagnose (text) {
  const s = String(text == null ? '' : text)
  if (!s.trim()) return { fatal: false, hint: '' }
  for (const r of RULES) {
    if (r.re.test(s)) return { fatal: r.fatal, hint: r.hint }
  }
  return { fatal: false, hint: '' }
}

module.exports = {
  OP_POLICIES,
  normalizeName,
  normalizeList,
  opPolicy,
  canOp,
  canCommand,
  diagnose
}
