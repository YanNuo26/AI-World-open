// ===== 面板功能：脚本接口（源码/panel/api/scriptapi.js）=====
// 状态 todo：对应 文档/架构与规划.md 里的 P4（玩家/外部程序调 bot 的 API）。
// 这里先把**面板侧**的接口形状和鉴权想法写下来，免得以后实现时又拍脑袋。
const U = require('./_util')

module.exports = {
  id: 'scriptapi',
  title: '脚本接口（规划中）',
  order: 91,
  status: 'todo',
  summary: '给外部脚本/网页调 ai 的 HTTP 接口（P4，还没实现）',
  ui: { type: 'cards' },
  routes: {
    'GET /': async () => ({
      cards: [
        {
          title: '计划做什么',
          subtitle: '对应 文档/架构与规划.md 的 P4',
          status: 'idle',
          rows: [
            ['目标', '别的程序（Python / 网页 / 定时任务）能指挥 ai：移动、放置、读取状态'],
            ['形态', '面板再加一个 /api/script/* 路由组，和现在这套保持同一套约定'],
            ['鉴权', '本机免密 + 可选 token（绝不暴露到局域网，面板只监听 127.0.0.1）'],
            ['安全', '默认只开放"读状态"，写操作要显式开开关 —— 否则等于给外部程序 root']
          ],
          note: '现在这个页面只是占位：按钮会返回 501（未实现）。'
        }
      ]
    }),
    'POST /call': async () => ({
      status: 501,
      body: { error: '还没实现：脚本接口在规划中（源码/panel/api/scriptapi.js）' }
    })
  }
}
