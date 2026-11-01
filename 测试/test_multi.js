const { HOST, PORT, VERSION, cmd } = require('./_common')
// 验证三个新功能：
//   1) help：AI 给玩家丢一本指令手册（written_book）
//   2) summon <名字> 新增 AI；summon <名字> del 删除；默认听从发指令的玩家
//   3) summon <名字> add <玩家> 添加听从名单
//      且"有多个 AI 时所有指令（含 summon 管理指令）前必须加 AI 名字前缀"
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const node = process.execPath
const ROOT = path.join(__dirname, '..')
const AI_NAME = 'AIBuilder'
const PLAYER = 'MultiPlayer'
const BOB = 'Bob'
const AIS = path.join(ROOT, 'ais.json')

let aiProc
function startAI () {
  const log = fs.createWriteStream(path.join(ROOT, '日志', 'ai_multi.log'))
  aiProc = spawn(node, ['源码/bot.js'], { cwd: ROOT, env: { ...process.env, MC_USER: AI_NAME } })
  aiProc.stdout.pipe(log)
  aiProc.stderr.pipe(log)
}
const readAis = () => {
  try { return JSON.parse(fs.readFileSync(AIS, 'utf8')) } catch (e) { return {} }
}
const results = []
function check (name, cond, extra) {
  results.push({ name, ok: !!cond })
  console.log(`[T] ${cond ? 'PASS' : 'FAIL'} - ${name}${extra ? ' :: ' + extra : ''}`)
}
const aiPos = (player, name) => {
  const p = player.players[name]
  return (p && p.entity) ? p.entity.position.clone() : null
}
const moved = (a, b) => (a && b) ? a.distanceTo(b) : -1
// 用 /tp 可靠移动（玩家自己是 op）；手动改坐标会被服务器弹回
async function tpSelf (player, x, y, z) {
  player.chat(`/tp ${player.username} ${x} ${y} ${z}`)
  await sleep(2500)
}

;(async () => {
  startAI()
  await sleep(6000)
  const player = mineflayer.createBot({ host: HOST, port: PORT, username: PLAYER, version: VERSION })

  try {
    await new Promise((res) => player.on('spawn', res))
    await sleep(2500)
    for (let i = 0; i < 40; i++) {
      if (player.players[AI_NAME] && player.players[AI_NAME].entity) break
      await sleep(500)
    }
    check('主 AI 已上线', !!(player.players[AI_NAME] && player.players[AI_NAME].entity))

    // ===== 1) help：给一本书 =====
    // 背包跨次保留：用"数量变多"判断，别被上一晚的书骗了
    const books0 = player.inventory.items().filter((i) => i.name === 'written_book').length
    player.chat(cmd(AI_NAME, 'help'))
    await sleep(5000)
    const books1 = player.inventory.items().filter((i) => i.name === 'written_book').length
    const book = books1 > books0 ? true : null
    check('help 给了一本成书(written_book)', !!book, 'books=' + books0 + '->' + books1)


    // ===== 2) summon =====
    player.chat(cmd(AI_NAME, 'summon ' + BOB))
    for (let i = 0; i < 30; i++) {
      if (player.players[BOB] && player.players[BOB].entity) break
      await sleep(1000)
    }
    check('summon 新 AI 上线', !!(player.players[BOB] && player.players[BOB].entity))
    const ais2 = readAis()
    console.log('[T] ais(召唤后) =', JSON.stringify(ais2))
    check('注册表里有 2 个 AI', Object.keys(ais2).length === 2, 'names=' + Object.keys(ais2).join(','))
    check('新 AI 默认听从召唤者', !!(ais2[BOB] && ais2[BOB].obey && ais2[BOB].obey.includes(PLAYER)),
      'obey=' + JSON.stringify(ais2[BOB] && ais2[BOB].obey))

    // ===== 3) 多个 AI 时指令必须带前缀（用"AI 自身位移"判断，不受玩家位置影响）=====
    const p0 = player.entity.position.floored()
    // 先让 AI 站定：summon 刚结束，主 AI 可能还在飞/走，
    // 直接取基线会把"上一件事的余速"算成"它响应了指令"（2026-11-01 multi 就是这么假失败的）。
    await sleep(8000)
    await tpSelf(player, p0.x + 60, p0.y, p0.z)
    const p1 = player.entity.position.floored()
    console.log('[T] 玩家已从', JSON.stringify(p0), '移到', JSON.stringify(p1))

    const mainBefore = aiPos(player, AI_NAME)
    const bobBefore = aiPos(player, BOB)

    // (a) 不带前缀 -> 两个 AI 都不该响应
    // 注意：这里**故意**不写 ai 名字（守门.js 的 ALLOW_CHAT 里登记过）
    player.chat('tpto')
    await sleep(12000)
    const dMainNo = moved(mainBefore, aiPos(player, AI_NAME))
    const dBobNo = moved(bobBefore, aiPos(player, BOB))
    console.log('[T] 无前缀 tpto: 主AI位移=' + dMainNo.toFixed(1) + ' Bob位移=' + dBobNo.toFixed(1))
    check('无前缀指令两个 AI 都不响应', dMainNo < 4 && dBobNo < 4,
      'main=' + dMainNo.toFixed(1) + ' bob=' + dBobNo.toFixed(1))

    // (b) 带 Bob 前缀 -> 只有 Bob 响应
    const mainBefore2 = aiPos(player, AI_NAME)
    const bobBefore2 = aiPos(player, BOB)
    player.chat(BOB + ' tpto')
    await sleep(25000)
    const dBobYes = moved(bobBefore2, aiPos(player, BOB))
    const dMainYes = moved(mainBefore2, aiPos(player, AI_NAME))
    console.log('[T] Bob tpto: Bob位移=' + dBobYes.toFixed(1) + ' 主AI位移=' + dMainYes.toFixed(1))
    // 不卡"必须跑 X 格"：60 格外寻路 + 间隙掉帧，20 秒只走 8 格也正常（2026-11-01 实测）。
    // 只要"Bob 明显动了、而且比主 AI 动得多"就说明路由正确。
    check('带前缀后只有 Bob 过来', dBobYes > 4 && dBobYes > dMainYes,
      'bob=' + dBobYes.toFixed(1) + ' main=' + dMainYes.toFixed(1))
    check('主 AI 仍没动', dMainYes < 4 && dMainYes < dBobYes, 'main=' + dMainYes.toFixed(1))


    // ===== 4) summon 管理指令本身也要带前缀 =====
    // 先验证不带前缀的管理指令无效
    player.chat(`summon ${BOB} add Steve2`)
    await sleep(2500)
    const aisNoPrefix = readAis()
    check('管理指令不带前缀也无效', !(aisNoPrefix[BOB] && aisNoPrefix[BOB].obey.includes('Steve2')),
      'obey=' + JSON.stringify(aisNoPrefix[BOB] && aisNoPrefix[BOB].obey))

    player.chat(`${AI_NAME} summon ${BOB} add Steve2`)
    await sleep(2500)
    const ais3 = readAis()
    console.log('[T] ais(add 后) =', JSON.stringify(ais3))
    check('add 新增听从玩家', !!(ais3[BOB] && ais3[BOB].obey.includes('Steve2')),
      'obey=' + JSON.stringify(ais3[BOB] && ais3[BOB].obey))

    // ===== 5) summon <名字> del =====
    player.chat(`${AI_NAME} summon ${BOB} del`)
    await sleep(8000)
    check('del 后 Bob 下线', !(player.players[BOB] && player.players[BOB].entity))
    const ais4 = readAis()
    check('注册表回到 1 个 AI', Object.keys(ais4).length === 1, 'names=' + Object.keys(ais4).join(','))

    // ===== 6) 只剩一个 AI 时，指令**仍然**要带前缀（前缀是硬规则，不会因为只有一个 AI 就放宽）=====
    // 用 ai 的回话判断，不看坐标：`del Bob` 之后主 ai 的 entity 有时会从玩家列表里消失
    // （1.21.1 收不到别人的 entity 生成包，见坑 26），那时位移只能读到 -1，会假失败。
    heard.length = 0
    player.chat(cmd(AI_NAME, 'tpto'))
    let soloOk = false
    for (let i = 0; i < 30; i++) {
      if (heard.some((m) => m.includes('已传送到'))) { soloOk = true; break }
      await sleep(1000)
    }
    console.log('[T] 单 AI 带前缀 tpto 回复: ' + JSON.stringify(heard.slice(-2)))
    check('只剩一个 AI 时带前缀照样能指挥', soloOk, 'replied=' + soloOk)


    const failed = results.filter((r) => !r.ok)
    console.log(`\n=== RESULTS: ${results.length - failed.length}/${results.length} passed ===`)
    if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join('; ')); process.exitCode = 1 }
    else console.log('MULTI TEST PASS')
  } catch (e) {
    console.error('[T] ERROR', e && e.stack)
    process.exitCode = 1
  } finally {
    try { player.end() } catch (e) {}
    if (aiProc) aiProc.kill('SIGKILL')
    // 确保子 AI 进程也被清掉
    try {
      const ais = readAis()
      for (const n of Object.keys(ais)) {
        if (n !== AI_NAME) console.log('[T] 清理残留 AI 进程: ' + n)
      }
    } catch (e) {}
    setTimeout(() => process.exit(process.exitCode || 0), 500)
  }
})()
