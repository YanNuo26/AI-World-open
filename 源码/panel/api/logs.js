// ===== 面板功能：日志（源码/panel/api/logs.js）=====
// 用 ui.type='logs'：前端有个通用日志查看器（左侧文件列表 + 右侧自动刷新）。
// 只读，不提供删除/清空 —— 日志是排查问题的唯一证据，别让误点毁掉。
const path = require('path')
const U = require('./_util')

const GROUPS = [
  { id: 'log', label: '项目日志（日志/）', dir: U.LOG_DIR },
  { id: 'server', label: '服务器日志（服务器/logs/）', dir: path.join(U.SERVER_DIR, 'logs') }
]

function groupById (id) {
  return GROUPS.find((g) => g.id === id) || GROUPS[0]
}

module.exports = {
  id: 'logs',
  title: '日志',
  order: 40,
  status: 'ready',
  summary: '看 日志/ 和 服务器/logs/ 的最新输出，自动刷新',
  ui: { type: 'logs', tailPath: '/tail', lines: 200, refresh: 3000 },
  routes: {
    'GET /': async () => {
      // 服务器/logs 里有 .log.gz 压缩包，查看器读不了，过滤掉
      const groups = GROUPS.map((g) => {
        const files = U.listDir(g.dir)
          .filter((f) => !/\.gz$/i.test(f.name))
          .slice(0, 60)
          .map((f) => ({ name: f.name, size: U.fmtBytes(f.size), mtime: U.fmtTime(f.mtime), mtimeMs: f.mtime }))
        return { id: g.id, label: g.label, dir: g.dir, exists: files.length > 0, files }
      })
      return { groups }
    },
    'GET /tail': async (ctx) => {
      const g = groupById(ctx.query.group)
      const name = U.safeFileName(ctx.query.name)
      if (!name) throw new U.HttpError(400, '文件名不合法')
      const full = path.join(g.dir, name)
      const lines = Math.max(10, Math.min(U.toInt(ctx.query.lines, 200), 2000))
      const r = U.tailLines(full, lines)
      if (r.error) throw new U.HttpError(404, '读不到 ' + name + '：' + r.error)
      return { group: g.id, name, lines: r.lines, shown: r.lines.length }
    }
  }
}
