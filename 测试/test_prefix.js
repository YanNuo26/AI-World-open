const { HOST, PORT, VERSION } = require('./_common')
// 验证：
//   1) 第一个 AI 默认名字是 world
//   2) 不带名字前缀的聊天**不会**触发指令（不影响正常玩家聊天）
//   3) 带 "world " 前缀才响应
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'world' // 默认名，不传 MC_USER
const PLAYER = 'PrefixPlayer'

let aiProc
const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}

;(async () => {
  const log = fs.createWriteStream(path.join(ROOT, '日志', 'ai_prefix.log'))
  // 注意：不传 MC_USER，验证默认名
  const env = { ...process.env }
  delete env.MC_USER
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
  await sleep(6000)

  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })
  const heard = []
  player.on('messagestr', (m) => heard.push(String(m)))

  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(2500)
    // 等默认名 world 上线
    // 注意：这里判"服务器玩家列表里有 world"就够了。
    //   以前还要求 player.players[AI_NAME].entity 存在，但 1.21.1 下 mineflayer 有时收不到
    //   别人的 entity 生成包（ArmorTrimMaterial 的 PartialReadError 会吞包），AI 明明在线也会 FAIL。
    //   真正"能干活"在后面 (c) 用"拿到成书"验证。
    let joined = false
    for (let i = 0; i < 40; i++) {
      if (player.players[AI_NAME]) { joined = true; break }
      await sleep(500)
    }
    const hasEntity = !!(player.players[AI_NAME] && player.players[AI_NAME].entity)
    check('默认名 world 的 AI 已上线', joined,
      'names=' + Object.keys(player.players || {}).join(',') + ' entity=' + hasEntity)

    // (a) 普通聊天不该触发指令
    heard.length = 0
    player.chat('大家好啊，今天天气不错')
    await sleep(5000)
    const repliedToChat = heard.some((m) => m.includes(AI_NAME + '>') || m.includes('没看懂'))
    console.log('[T] 普通聊天后听到的: ' + JSON.stringify(heard.slice(-2)))
    check('普通聊天不会被当成指令', !repliedToChat, 'replied=' + repliedToChat)

    // (b) 无前缀的指令也不该生效（用"书多了没有"判断，背包跨次保留所以不能只看有没有）
    const booksBefore = player.inventory.items().filter((i) => i.name === 'written_book').length
    heard.length = 0
    player.chat('help')
    await sleep(5000)
    const booksNoPrefix = player.inventory.items().filter((i) => i.name === 'written_book').length
    check('无前缀 help 不生效', booksNoPrefix === booksBefore, 'books=' + booksBefore + '->' + booksNoPrefix)

    // (c) 带前缀才生效
    heard.length = 0
    player.chat(AI_NAME + ' help')
    await sleep(6000)
    const booksAfter = player.inventory.items().filter((i) => i.name === 'written_book').length
    check('带 world 前缀的 help 生效（拿到书）', booksAfter > booksNoPrefix,
      'books=' + booksNoPrefix + '->' + booksAfter)


    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('PREFIX TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
