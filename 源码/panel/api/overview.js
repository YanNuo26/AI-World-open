// ===== 面板功能：概览（源码/panel/api/overview.js）=====
// 打开面板第一眼要看的东西：配置对不对、服务器/ai 在不在、有没有配置告警。
const U = require('./_util')
const P = require('./_procs')

// 配置里能一眼看出问题的点（不全量校验，只挑最容易踩的）
function configHints (cfg) {
  const out = []
  if (cfg.server.auth === 'microsoft' && !cfg.server.username && !/@/.test(String(cfg.ai.name))) {
    out.push('auth=正版，但没有填 server.username（账号邮箱）→ 登录会失败')
  }
  if (!cfg.rcon.enabled) out.push('RCON 已关闭 → 面板看不到在线玩家，op / 远距离 tp 也不可用')
  if (!U.config.isLocalHost(cfg.server.host) && !String(cfg.ai.obeyWhitelist || '').trim()) {
    out.push('连的是外部服务器且 ai.obeyWhitelist 为空 → 任何路人都能指挥 ai')
  }
  return out
}

module.exports = {
  id: 'overview',
  title: '概览',
  order: 10,
  status: 'ready',
  summary: '一眼看清配置、服务器和 ai 的运行状态',
  ui: { type: 'cards', refresh: 4000 },
  routes: {
    'GET /': async () => {
      const cfg = U.config.load()
      const server = await P.serverStatus()
      const ai = P.aiStatus()
      const cards = []

      // ---- 1. 运行状态 ----
      cards.push({
        title: '运行状态',
        subtitle: '面板托管 = 只有面板拉起来的进程才能从这里停',
        status: (server.phase === 'running' && ai.running) ? 'ok'
          : (server.phase === 'stopped' && !ai.running) ? 'idle' : 'warn',
        rows: [
          ['服务器', server.phase === 'running' ? '运行中（面板启动，PID ' + server.pid + '）'
            : server.phase === 'starting' ? '启动中…'
              : server.phase === 'external' ? '运行中（不是面板启动）' : '未运行'],
          ['ai', ai.running ? '运行中（PID ' + ai.pid + '，已 ' + U.fmtDuration(ai.uptimeMs) + '）' : '未运行'],
          ['在线玩家', server.players ? (server.players.length ? server.players.join('、') : '0 人') : '（RCON 不可用，看不到）']
        ],
        buttons: [
          { label: '去启动 / 停止', tab: 'processes', primary: !ai.running },
          { label: '看日志', tab: 'logs' }
        ]
      })

      // ---- 2. 连接配置 ----
      cards.push({
        title: '连接配置',
        subtitle: '改完要重启 ai 才生效（服务器端口改动还要重启服务器）',
        status: cfg.server.auth === 'microsoft' ? 'warn' : 'idle',
        rows: [
          ['服务器', cfg.server.host + ':' + cfg.server.port + (U.config.isLocalHost(cfg.server.host) ? '（本机）' : '（外部）')],
          ['版本', cfg.server.version + (cfg.server.version === 'auto' ? '（自动探测）' : '')],
          ['登录', cfg.server.auth === 'microsoft' ? ('正版 ' + (cfg.server.username || cfg.ai.name)) : '离线'],
          ['ai 名字', cfg.ai.name + '（游戏里输入 ' + cfg.ai.name + ' build … 指挥它）'],
          ['自动 op', cfg.ai.autoOp + (cfg.ai.autoOp === 'local-only' ? '（只给本机服的自己）' : '')],
          ['指令白名单', String(cfg.ai.obeyWhitelist || '').trim() ? String(cfg.ai.obeyWhitelist) : '空 = 任何人都能指挥'],
          ['RCON', cfg.rcon.enabled ? (cfg.rcon.host + ':' + cfg.rcon.port) : '关闭']
        ],
        buttons: [{ label: '编辑配置', tab: 'config', primary: true }]
      })

      // ---- 3. 告警（有才显示）----
      const warnings = []
      for (const w of cfg._warnings || []) warnings.push(w)
      for (const h of configHints(cfg)) if (!warnings.some((x) => x.includes(h))) warnings.push(h)
      if (!server.paths.jar) warnings.push('服务器/server.jar 不存在：面板启动不了服务器，先跑一次 脚本\\start_server.ps1')
      if (warnings.length) {
        cards.push({
          title: '需要留意（' + warnings.length + ' 条）',
          status: 'warn',
          rows: warnings.map((w, i) => ['#' + (i + 1), w]),
          note: '这些都是"配置能跑但容易出问题"的地方，改完点"编辑配置"保存即可。'
        })
      }

      // ---- 4. 快速上手 ----
      cards.push({
        title: '快速上手',
        subtitle: '三步开始玩',
        status: 'idle',
        note: [
          '① 到「启动 / 停止」点「启动服务器」，等输出里出现 Done 和「可以进服了」',
          '② 再点「启动 ai」，等输出里出现 Logged in',
          '③ 进游戏（地址 ' + cfg.server.host + ':' + cfg.server.port + '），在聊天框里输入：',
          '     ' + cfg.ai.name + ' build 木屋',
          '     ' + cfg.ai.name + ' come      （让它走过来）',
          '     ' + cfg.ai.name + ' help      （看全部指令）',
          '想重新录制/复现建筑：' + cfg.ai.name + ' rec start / rec stop / rec play 名字'
        ].join('\n')
      })

      return { cards }
    }
  }
}
