// ===== 面板功能：大模型助手（源码/panel/api/llm.js）=====
// 状态 todo：**故意先占位**。放这个文件的目的有两个：
//   1. 证明"加一个功能只要往 api/ 丢一个文件"，前端导航会自动多出这一项；
//   2. 把接口形状先定下来，以后实现时前端不用改。
// 想真正实现时：把 status 改成 'ready'，在 routes 里填 'POST /chat' 的实现即可。
const U = require('./_util')

module.exports = {
  id: 'llm',
  title: '大模型助手（规划中）',
  order: 90,
  status: 'todo',
  summary: '把「world 盖个带二层的中式院子」这种话翻译成建筑指令（还没实现）',
  ui: { type: 'cards' },
  routes: {
    'GET /': async () => ({
      cards: [
        {
          title: '计划做什么',
          subtitle: '接口先留好，界面不用等实现',
          status: 'idle',
          rows: [
            ['自然语言 → 指令', '「盖个塔」→ world build tower（现在也能用，只是要自己拼指令）'],
            ['缺什么方块', '给一张方块清单，让 ai 自己 RCON 领取 / 统计'],
            ['报错解释', '把 日志/ai_world.log 里的报错丢给模型，给中文原因和处理建议'],
            ['需要的前置', '一个可用的模型 API key（放 config.json，别写进源码）']
          ],
          note: '现在这个页面只是个占位：按钮会返回 501（未实现），用来验证"新功能接入"这条链路是通的。'
        }
      ],
      note: '实现方式：把 llm.js 的 status 改成 ready，然后在 routes 里加 "POST /chat"。'
    }),
    // 占位接口：返回 501，前端会把它当成错误 toast 显示（正好演示 { status, body } 用法）
    'POST /chat': async () => ({
      status: 501,
      body: { error: '还没实现：大模型助手目前在规划阶段（源码/panel/api/llm.js）' }
    })
  }
}
