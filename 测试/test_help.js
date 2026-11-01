const { HOST, PORT, VERSION, cmd } = require('./_common')
// 只验证 help：AI 是否真的把成书(written_book)给了玩家
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'HelpPlayer'

let aiProc
;(async () => {
  const log = fs.createWriteStream(path.join(ROOT, '日志', 'ai_help.log'))
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env: { ...process.env, MC_USER: AI_NAME } })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
  await sleep(6000)

  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })
  let ok = false
  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(2500)
    for (let i = 0; i < 40; i++) {
      if (player.players[AI_NAME] && player.players[AI_NAME].entity) break
      await sleep(500)
    }
    // 离线服的玩家背包会跨次保留：上一晚给的书还在，直接"背包里有书"会永远 PASS。
    // 所以先数一遍基线，只看这次有没有**多出来**。
    const booksBefore = player.inventory.items().filter((i) => i.name === 'written_book').length
    player.chat(cmd(AI_NAME, 'help'))
    await sleep(6000)
    const books = player.inventory.items().filter((i) => i.name === 'written_book')
    const book = books.length > booksBefore ? books[0] : null
    console.log('[T] 成书数量: ' + booksBefore + ' -> ' + books.length)
    console.log('[T] ' + (book ? 'PASS' : 'FAIL') + ' - help 给了成书 :: ' + (book ? book.name : 'none'))

    if (book) {
      // 打印一下书里的内容（能读到说明书是合法的）
      try {
        const nbt = book.nbt || book.components
        console.log('[T] 书内容: ' + JSON.stringify(nbt).slice(0, 300))
      } catch (e) { /* ignore */ }
    }
    ok = !!book
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    console.log(ok ? 'HELP TEST PASS' : 'HELP TEST FAIL')
    setTimeout(() => process.exit(ok ? 0 : 1), 500)
  }
})()
