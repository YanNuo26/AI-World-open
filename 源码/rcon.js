// ===== 极简 Minecraft RCON 客户端（不依赖第三方库）=====
// 用途：给玩家 op。服务器的 op 只能由控制台（或已 op 的玩家）执行，
// 机器人自己是玩家，没法给自己/别人 op，所以走 RCON 连到服务器控制台。
//
// 包格式： int32 长度 | int32 请求ID | int32 类型 | payload(NUL 结尾) | 1字节 NUL
//   类型: 3=登录(Auth)  2=执行命令  0=响应
//   登录失败时服务器会返回一个 requestId = -1 的包。
const net = require('net')

const TYPE_RESPONSE = 0
const TYPE_COMMAND = 2
const TYPE_AUTH = 3

function pack (id, type, body) {
  const payload = Buffer.concat([Buffer.from(String(body), 'utf8'), Buffer.from([0x00, 0x00])])
  const len = 4 + 4 + payload.length // len 字段本身不含最前面的 4 字节长度
  const buf = Buffer.alloc(4 + len)
  buf.writeInt32LE(len, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  return buf
}

function unpack (pkt) {
  const len = pkt.readInt32LE(0)
  const id = pkt.readInt32LE(4)
  const type = pkt.readInt32LE(8)
  // 去掉尾部两个 0x00
  const body = pkt.slice(12, 4 + len - 2).toString('utf8')
  return { id, type, body }
}

// 执行一次控制台命令，返回服务器回显文本。
// opts 由调用方从 config.json 的 rcon 段传进来（源码/config.js），这里不再写死密码：
// 端口 / 密码每台服务器都不一样，写死会让"接别人的服"直接失效。
async function rconCommand (cmd, opts = {}) {
  if (opts.enabled === false) throw new Error('rcon 已禁用（config.json 的 rcon.enabled=false）')
  const host = opts.host || '127.0.0.1'
  const port = opts.port || 25575
  const password = opts.password || process.env.MC_RCON_PASSWORD || ''
  if (!password) throw new Error('没有 RCON 密码（请在 config.json 的 rcon.password 里填写）')

  return new Promise((resolve, reject) => {
    const sock = new net.Socket()
    let buf = Buffer.alloc(0)
    let authed = false
    let finished = false

    const finish = (err, res) => {
      if (finished) return
      finished = true
      try { sock.destroy() } catch (e) { /* ignore */ }
      if (err) reject(err)
      else resolve(res)
    }

    sock.setTimeout(10000, () => finish(new Error('rcon 超时')))
    sock.on('error', (e) => finish(e))
    sock.on('connect', () => { sock.write(pack(1, TYPE_AUTH, password)) })
    sock.on('close', () => finish(new Error('rcon 连接关闭')))
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (buf.length < 4) break
        const len = buf.readInt32LE(0)
        if (len < 10 || buf.length < 4 + len) break // 包还没收全
        const pkt = buf.slice(0, 4 + len)
        buf = buf.slice(4 + len)
        const { id } = unpack(pkt)
        const { body } = unpack(pkt)
        if (id === -1) { finish(new Error('rcon 认证失败（密码不对？）')); return }
        if (!authed && id === 1) { // 登录成功 -> 发命令
          authed = true
          sock.write(pack(2, TYPE_COMMAND, cmd))
          continue
        }
        if (authed && id === 2) { finish(null, body); return }
      }
    })
    sock.connect(port, host)
  })
}

// 给指定玩家 op（失败只记日志，不影响主流程）
async function opPlayer (username, opts = {}) {
  if (!username) return false
  try {
    const res = await rconCommand('op ' + username, opts)
    console.log('[AI] 已授权 op -> ' + username + (res ? ' | ' + String(res).replace(/\s+/g, ' ').slice(0, 80) : ''))
    return true
  } catch (e) {
    console.error('[AI] op 失败 (' + username + '):', e && e.message)
    return false
  }
}

module.exports = { rconCommand, opPlayer }
