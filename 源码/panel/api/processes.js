// ===== 面板功能：启动 / 停止（源码/panel/api/processes.js）=====
// 用 ui.type='cards'：前端有一套通用卡片渲染器，所以这个文件**只管数据**。
//
// 两张卡（服务器 / ai）刻意做成同样高度、同样的按钮行位置、同样大的输出框
// （card.fixed = true → 前端用 flex 把按钮行压到底部），这样左右两栏一眼对齐。
//
// ai 不止一个：面板托管的是**主 ai**，游戏里 `summon <名字>` 出来的 ai 是主 ai
// fork 的子进程（pid 记在 ais.json 里），所以这里列全，但起停只针对主 ai。
const U = require('./_util')
const P = require('./_procs')

// 输出框固定高度（两栏一样高才好对齐；行高 12px 左右，320px 大约 22 行）
const LOG_HEIGHT = 320

// 状态 → 卡片颜色：ok 绿 / warn 黄 / err 红 / idle 灰
function serverCard (st) {
  const running = st.phase === 'running' || st.phase === 'external'
  const rows = [
    ['地址', st.host + ':' + st.port + (st.local ? '（本机）' : '（外部服务器）')],
    ['状态', st.phase === 'running' ? '运行中（面板启动）'
      : st.phase === 'starting' ? '启动中…（端口还没监听，正常，等 30–60 秒）'
        : st.phase === 'external' ? '运行中（不是面板启动的 → 面板只能看/发 RCON 命令）'
          : '未运行'],
    ['PID', st.pid ? String(st.pid) : '—'],
    ['已运行', st.owned ? U.fmtDuration(st.uptimeMs) : '—'],
    ['延迟', st.listening ? (st.latencyMs + ' ms') : (st.probeError || '—')]
  ]
  if (st.players) rows.push(['在线玩家', st.players.length ? st.players.join('、') : '（只有 ai 的时候也是空）'])
  if (st.rconError) rows.push(['RCON', '不可用：' + st.rconError])

  const buttons = []
  if (!running && st.phase !== 'starting') {
    buttons.push({ label: '启动服务器', path: '/server/start', method: 'POST', primary: true })
  }
  if (st.owned) {
    buttons.push({ label: '停止服务器', path: '/server/stop', method: 'POST', danger: true, confirm: '确定停服务器？会先发 stop 保存世界。' })
  } else if (st.phase === 'external' && st.rconEnabled) {
    buttons.push({ label: '用 RCON 停止', path: '/server/stop', method: 'POST', danger: true, confirm: '这会让**别人的**服务器停机，确定？' })
  }

  const card = {
    title: 'Minecraft 服务器',
    subtitle: 'java -jar server.jar（面板托管）',
    status: st.phase === 'running' ? 'ok' : st.phase === 'starting' ? 'busy'
      : st.phase === 'external' ? 'warn' : 'idle',
    fixed: true,
    rows,
    buttons,
    input: { path: '/server/command', key: 'command', placeholder: '服务器控制台命令，如 list / op 玩家名 / time set day', submit: '发送' },
    log: { path: '/output?target=server&tail=80', height: LOG_HEIGHT }
  }
  if (!st.paths.jar) card.note = '服务器/server.jar 不存在：请先跑一次 脚本\\start_server.ps1 做首次初始化（下载服务端）。'
  return card
}

// ai 卡：一行摘要 + 一张"所有 ai"的表（主 ai 排第一）
function aiCard (st, list) {
  const others = list.filter((a) => !a.main)
  const rows = [
    ['主 ai', st.name + (st.running ? '（运行中，PID ' + st.pid + '，已 ' + U.fmtDuration(st.uptimeMs) + '）' : '（未运行）')],
    ['目标服务器', st.host + ':' + st.port],
    ['ai 总数', list.length + ' 个（主 ai ' + (st.running ? '在线' : '离线') + '，另外 ' + others.length + ' 个是 summon 出来的）']
  ]
  const body = list.map((a) => [
    a.name + (a.main ? '（主）' : ''),
    a.owner ? a.owner : '—',
    a.obey.length ? a.obey.join('、') : '所有人',
    a.running ? '运行中' : '不在线'
  ])
  const buttons = st.running
    ? [{ label: '停止 ai', path: '/ai/stop', method: 'POST', danger: true, confirm: '停止主 ai？它会断开连接，summon 出来的 ai 也会一起退出。' }]
    : [{ label: '启动 ai', path: '/ai/start', method: 'POST', primary: true }]
  return {
    title: 'ai（玩家机器人）',
    subtitle: 'node 源码/bot.js —— 面板只起停**主 ai**',
    status: st.running ? 'ok' : 'idle',
    fixed: true,
    rows,
    table: { head: ['ai 名字', '谁召唤的', '谁能指挥', '状态'], rows: body },
    buttons,
    log: { path: '/output?target=ai&tail=80', height: LOG_HEIGHT }
  }
}

module.exports = {
  id: 'processes',
  title: '启动 / 停止',
  order: 20,
  status: 'ready',
  summary: '一键启动服务器和 ai（列出全部 ai），实时看输出，发服务器命令',
  // refresh: 前端自动轮询间隔（毫秒）；不加就只在切页时拉一次
  ui: { type: 'cards', refresh: 2000 },
  routes: {
    'GET /': async () => {
      const server = await P.serverStatus()
      return {
        cards: [serverCard(server), aiCard(P.aiStatus(), P.aiList())],
        note: '面板只托管**自己启动**的进程：用 脚本/启动服务器.bat 起的服务器也能看到（标"不是面板启动"），' +
          '但停它只能靠 RCON 或手动关窗口。\n' +
          'ai 一栏里除主 ai 之外的都是游戏里 `summon <名字>` 召唤的，面板只负责显示；' +
          '要删某一个用 `summon <名字> del`（它们的输出会一起出现在下面的输出框里）。'
      }
    },
    'POST /server/start': async () => P.startServer(),
    'POST /server/stop': async () => P.stopServer(),
    'POST /server/command': async (ctx) => P.serverCommand(ctx.body.command),
    'POST /ai/start': async () => P.startAi(),
    'POST /ai/stop': async () => P.stopAi(),
    'GET /output': async (ctx) => P.output(ctx.query.target, ctx.query.since, ctx.query.tail)
  },
  // 面板 Ctrl+C / 关窗口时调用：把自己拉的进程收干净（服务器走 stop，保证存档落盘）
  dispose: () => P.shutdown()
}
