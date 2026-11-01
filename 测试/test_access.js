// 接入别人的服务器 = 准入 + 失败诊断（源码/access.js）+ 配置解析（源码/config.js）。
// 这三块都是**纯逻辑**，所以这个测试**不需要服务器**，随时能跑：
//   node 测试/test_access.js
// 重点锁死两条安全底线：
//   1) 默认配置（autoOp=local-only）连外部服务器时，**任何玩家都不会被 op**
//   2) 指令白名单 / 策略写错时，只会更严格，不会变成"谁都能指挥"
const { canOp, canCommand, diagnose, opPolicy } = require('../源码/access')
const cfgMod = require('../源码/config')

let pass = 0
let fail = 0
function check (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) } else {
    fail++
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)))
  }
}

// ---------- 1) op 策略 ----------
console.log('[1] autoOp 策略')
check('local-only + 本机服务器 -> 允许 op', canOp({ policy: 'local-only', username: 'Alex', isLocal: true }).ok === true)
check('local-only + 外部服务器 -> 拒绝', canOp({ policy: 'local-only', username: 'Alex', isLocal: false }).ok === false)
check('never -> 一律拒绝（本机也不行）', canOp({ policy: 'never', username: 'Alex', isLocal: true }).ok === false)
check('always -> 一律允许', canOp({ policy: 'always', username: 'Alex', isLocal: false }).ok === true)
check('whitelist + 名单内 -> 允许',
  canOp({ policy: 'whitelist', username: 'Alex', whitelist: ['alex'], isLocal: false }).ok === true)
check('whitelist + 名单外 -> 拒绝',
  canOp({ policy: 'whitelist', username: 'Alex', whitelist: ['bob'], isLocal: false }).ok === false)
check('whitelist 支持逗号字符串',
  canOp({ policy: 'whitelist', username: 'bob', whitelist: 'alex, bob', isLocal: false }).ok === true)
check('写错的策略按 local-only 处理（外部服 -> 拒绝）',
  canOp({ policy: 'give-everyone', username: 'Alex', isLocal: false }).ok === false)
check('空策略也按 local-only 处理（外部服 -> 拒绝）',
  canOp({ policy: '', username: 'Alex', isLocal: false }).ok === false)
check('空策略 + 本机 -> 允许', canOp({ policy: '', username: 'Alex', isLocal: true }).ok === true)
check('没有玩家名 -> 拒绝', canOp({ policy: 'always', username: '' }).ok === false)
check('opPolicy 归一化', opPolicy(' ALWAYS ') === 'always' && opPolicy('nope') === 'local-only')

// ---------- 2) 谁能指挥 ai ----------
console.log('[2] 指令白名单')
check('两边都空 -> 谁都能指挥（老行为不变）', canCommand({ username: 'Anyone', obey: [], allow: [] }).ok === true)
check('obey 有名单 + 名单内 -> 允许', canCommand({ username: 'alex', obey: ['alex'], allow: [] }).ok === true)
check('obey 有名单 + 名单外 -> 拒绝', canCommand({ username: 'bob', obey: ['alex'], allow: [] }).ok === false)
check('obey 空 + allow 有名单 + 名单内 -> 允许', canCommand({ username: 'Alex', obey: [], allow: ['alex'] }).ok === true)
check('obey 空 + allow 有名单 + 名单外 -> 拒绝', canCommand({ username: 'mallory', obey: [], allow: ['alex'] }).ok === false)
check('两套名单都要满足（obey 内、allow 外 -> 拒绝）',
  canCommand({ username: 'alex', obey: ['alex'], allow: ['bob'] }).ok === false)
check('allow 支持逗号字符串（环境变量 MC_OBEY）',
  canCommand({ username: 'bob', obey: [], allow: 'alex, bob' }).ok === true)
check('大小写不敏感', canCommand({ username: 'ALEX', obey: [], allow: ['alex'] }).ok === true)
check('没有玩家名 -> 拒绝', canCommand({ username: '', obey: [], allow: [] }).ok === false)

// ---------- 3) 失败诊断 ----------
console.log('[3] 连不上 / 被踢的原因')
const whitelist = diagnose('You are not whitelisted on this server')
check('白名单 -> 致命 + 提示加白名单', whitelist.fatal === true && /白名单/.test(whitelist.hint), whitelist)
check('翻译键也能认（multiplayer.disconnect.not_whitelisted）',
  diagnose('multiplayer.disconnect.not_whitelisted').fatal === true)
check('封禁 -> 致命', diagnose('You are banned from this server').fatal === true)
const authHint = diagnose('Failed to verify username!')
check('正版验证 -> 致命 + 提示改 auth=microsoft', authHint.fatal === true && /microsoft/.test(authHint.hint), authHint)
check('版本不符 -> 致命', diagnose('Incompatible client! Please use 1.20.4').fatal === true)
check('账号重复登录 -> 致命', diagnose('You logged in from another location').fatal === true)
const full = diagnose('Server is full')
check('服务器满 -> 不致命（等重连）+ 有提示', full.fatal === false && /满/.test(full.hint), full)
const refused = diagnose('connect ECONNREFUSED 127.0.0.1:25565')
check('ECONNREFUSED -> 不致命 + 提示端口', refused.fatal === false && /端口/.test(refused.hint), refused)
const dns = diagnose('getaddrinfo ENOTFOUND play.example.com')
check('ENOTFOUND -> 不致命 + 提示域名', dns.fatal === false && /域名/.test(dns.hint), dns)
check('反作弊（floating）-> 不致命', diagnose('Kicked for floating too long!').fatal === false)
const unknown = diagnose('some totally unknown message')
check('不认识的文本 -> 不致命 + 无提示', unknown.fatal === false && unknown.hint === '', unknown)
check('空文本 -> 不致命 + 无提示', diagnose('').fatal === false && diagnose(null).fatal === false)

// ---------- 4) 命令行参数 ----------
console.log('[4] 命令行参数')
const a1 = cfgMod.parseArgs(['--host', 'play.example.com', '--port', '25566', '--auth', 'microsoft',
  '--server-user', 'me@example.com', '--no-rcon', '--obey', 'alex, bob'])
check('--host', a1.overrides['server.host'] === 'play.example.com', a1.overrides)
check('--port 变成数字', a1.overrides['server.port'] === 25566, a1.overrides['server.port'])
check('--auth', a1.overrides['server.auth'] === 'microsoft')
check('--server-user', a1.overrides['server.username'] === 'me@example.com')
check('--no-rcon 关掉 RCON', a1.overrides['rcon.enabled'] === false)
check('--obey 拆成数组',
  JSON.stringify(a1.overrides['ai.obeyWhitelist']) === '["alex","bob"]', a1.overrides['ai.obeyWhitelist'])
check('正常参数没有错误', a1.errors.length === 0, a1.errors)
check('--port=25570 内联写法', cfgMod.parseArgs(['--port=25570']).overrides['server.port'] === 25570)
check('--port abc -> 报错', cfgMod.parseArgs(['--port', 'abc']).errors.length === 1)
check('--host 后面直接跟另一个参数 -> 报错', cfgMod.parseArgs(['--host', '--port', '1']).errors.length >= 1)
check('不认识的参数 -> 报错', cfgMod.parseArgs(['--bogus']).errors.length === 1)
const help = cfgMod.parseArgs(['--help'])
check('--help 输出用法', help.help === true && /--host/.test(help.usage) && /--no-rcon/.test(help.usage))
check('--no-reconnect', cfgMod.parseArgs(['--no-reconnect']).overrides['behavior.reconnect.enabled'] === false)

// ---------- 5) 配置合并（config.json + 命令行覆盖） ----------
console.log('[5] 配置合并与告警')
const base = cfgMod.load()
check('默认 auth=offline', base.server.auth === 'offline', base.server.auth)
check('默认 autoOp=local-only', base.ai.autoOp === 'local-only', base.ai.autoOp)
check('默认 obeyWhitelist 是数组', Array.isArray(base.ai.obeyWhitelist), base.ai.obeyWhitelist)
check('默认 username 是空串', base.server.username === '', base.server.username)
check('localhost 判定为本机', base._isLocal === true)

const ext = cfgMod.load({ 'server.host': 'play.example.com' })
check('外部服务器 -> _isLocal=false', ext._isLocal === false)
check('外部服务器 -> 提示 autoOp 不会 op',
  ext._warnings.some((w) => /autoOp=local-only/.test(w)), ext._warnings)
check('外部服务器 -> 提示离线模式可能登录失败',
  ext._warnings.some((w) => /auth=offline/.test(w)), ext._warnings)
check('外部服务器 -> 提示指令白名单为空',
  ext._warnings.some((w) => /obeyWhitelist/.test(w)), ext._warnings)

const bad = cfgMod.load({ 'ai.autoOp': 'EVERYONE', 'server.host': 'play.example.com' })
check('写错的 autoOp 回落到 local-only', bad.ai.autoOp === 'local-only', bad.ai.autoOp)
check('写错的 autoOp 有告警', bad._warnings.some((w) => /不认识/.test(w)), bad._warnings)

const badAuth = cfgMod.load({ 'server.auth': 'mojang' })
check('不认识的 auth 回落到 offline', badAuth.server.auth === 'offline', badAuth.server.auth)
check('不认识的 auth 有告警', badAuth._warnings.some((w) => /server\.auth/.test(w)), badAuth._warnings)

const portStr = cfgMod.load({ 'server.port': '25599' })
check('命令行端口是字符串也能转数字', portStr.server.port === 25599, portStr.server.port)

const ms = cfgMod.load({ 'server.auth': 'microsoft' })
check('auth=microsoft 但没填邮箱 -> 告警',
  ms._warnings.some((w) => /server\.username/.test(w)), ms._warnings)
check('auth 进 summary', /正版/.test(cfgMod.summary(ms)), cfgMod.summary(ms))

const obey = cfgMod.load({ 'ai.obeyWhitelist': ['alex'] })
check('命令行白名单进配置', JSON.stringify(obey.ai.obeyWhitelist) === '["alex"]', obey.ai.obeyWhitelist)
check('白名单非空 -> 不再提示公共服风险',
  !obey._warnings.some((w) => /任何玩家都能指挥/.test(w)), obey._warnings)

// 环境变量传进来的是**逗号字符串**，不能因为不是数组就被当成"空名单"
process.env.MC_OBEY = 'alex'
const envObey = cfgMod.load({ 'server.host': 'play.example.com' })
const envSelf = cfgMod.load()
delete process.env.MC_OBEY
check('MC_OBEY 生效（逗号字符串）', envSelf.ai.obeyWhitelist === 'alex', envSelf.ai.obeyWhitelist)
check('MC_OBEY 非空 -> 不误报"任何玩家都能指挥"',
  !envObey._warnings.some((w) => /任何玩家都能指挥/.test(w)), envObey._warnings)

console.log('')
console.log('ACCESS TEST ' + (fail ? 'FAIL' : 'PASS') + '  (' + pass + ' 通过 / ' + fail + ' 失败)')
process.exit(fail ? 1 : 0)
