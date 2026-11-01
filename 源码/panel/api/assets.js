// ===== 面板功能：蓝图与教学（源码/panel/api/assets.js）=====
// 用 ui.type='list'：前端通用表格渲染器（列定义 + 行 + 行内按钮）。
// 删除不是真删：移到 <目录>/_回收/，手滑了还能捞回来。
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const U = require('./_util')

const GROUPS = [
  { id: 'blueprint', label: '蓝图', dir: path.join(U.ROOT, '蓝图') },
  { id: 'teach', label: '教学', dir: path.join(U.ROOT, '教学') }
]

function groupById (id) {
  return GROUPS.find((g) => g.id === id) || GROUPS[0]
}

// 读一个 json 文件的前 4MB 做摘要（蓝图/教学都不大；真超了就只显示大小）
function summarize (file, group) {
  try {
    const st = fs.statSync(file)
    if (st.size > 4 * 1024 * 1024) return '（文件较大，未解析）'
    const obj = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (group === 'blueprint') {
      const blocks = Array.isArray(obj.blocks) ? obj.blocks : []
      const kinds = new Set(blocks.map((b) => b && b.name).filter(Boolean))
      return blocks.length + ' 块 / ' + kinds.size + ' 种材质'
    }
    if (group === 'teach') {
      const ev = Array.isArray(obj.events) ? obj.events : []
      let span = ''
      if (ev.length >= 2 && ev[0].ts && ev[ev.length - 1].ts) {
        span = '，约 ' + Math.max(1, Math.round((ev[ev.length - 1].ts - ev[0].ts) / 1000)) + ' 秒'
      }
      return ev.length + ' 步' + span
    }
    return ''
  } catch (e) {
    return '（不是合法 JSON：' + e.message.slice(0, 40) + '）'
  }
}

module.exports = {
  id: 'assets',
  title: '蓝图与教学',
  order: 50,
  status: 'ready',
  summary: '看已录制的蓝图 / 教学有多少内容，支持打开目录、回收站式删除',
  ui: {
    type: 'list',
    note: '蓝图 = 扫出来的方块清单（rec save / bp save），教学 = 录制的一整段操作（rec start / stop）。' +
      '删除只是移到 _回收/ 子目录，可以手动恢复。'
  },
  routes: {
    'GET /': async () => {
      const rows = []
      for (const g of GROUPS) {
        for (const f of U.listDir(g.dir)) {
          if (f.name.startsWith('.') || /^_/.test(f.name)) continue // 跳过 _回收 之类的内部目录里的东西
          if (!/\.json$/i.test(f.name)) continue
          rows.push({
            group: g.id,
            groupLabel: g.label,
            name: f.name,
            info: summarize(f.file, g.id),
            size: U.fmtBytes(f.size),
            mtime: U.fmtTime(f.mtime),
            actions: [{
              label: '删除',
              path: '/delete',
              method: 'POST',
              body: { group: g.id, name: f.name },
              danger: true,
              confirm: '把「' + f.name + '」移到 _回收/ ？'
            }]
          })
        }
      }
      rows.sort((a, b) => (a.groupLabel === b.groupLabel ? 0 : a.groupLabel < b.groupLabel ? -1 : 1))
      return {
        columns: [
          { key: 'groupLabel', label: '类型', width: '70px' },
          { key: 'name', label: '文件' },
          { key: 'info', label: '内容' },
          { key: 'size', label: '大小', width: '80px' },
          { key: 'mtime', label: '修改时间', width: '150px' }
        ],
        toolbar: GROUPS.map((g) => ({ label: '打开 ' + g.label + ' 文件夹', path: '/open', method: 'POST', body: { group: g.id } })),
        rows: rows.map((r) => Object.assign({}, r, { group: undefined }))
      }
    },
    // 在资源管理器里打开目录（面板在浏览器里，开文件夹比让人自己找路径方便）
    'POST /open': async (ctx) => {
      const g = groupById((ctx.body || {}).group)
      try { fs.mkdirSync(g.dir, { recursive: true }) } catch (e) { /* ignore */ }
      if (process.platform !== 'win32') throw new U.HttpError(400, '只有 Windows 支持一键打开文件夹')
      try {
        const p = spawn('explorer.exe', [g.dir], { detached: true, stdio: 'ignore' })
        p.unref()
      } catch (e) {
        throw new U.HttpError(500, '打开失败：' + e.message)
      }
      return { ok: true, note: '已打开 ' + g.dir }
    },
    'POST /delete': async (ctx) => {
      const body = ctx.body || {}
      const g = groupById(body.group)
      const name = U.safeFileName(body.name)
      if (!name) throw new U.HttpError(400, '文件名不合法')
      const src = path.join(g.dir, name)
      if (!fs.existsSync(src)) throw new U.HttpError(404, '文件不存在：' + name)
      const trash = path.join(g.dir, '_回收')
      try { fs.mkdirSync(trash, { recursive: true }) } catch (e) { /* ignore */ }
      let dest = path.join(trash, name)
      if (fs.existsSync(dest)) dest = path.join(trash, Date.now() + '_' + name) // 重名不覆盖
      try {
        fs.renameSync(src, dest)
      } catch (e) {
        throw new U.HttpError(500, '移动失败：' + e.message)
      }
      return { ok: true, note: '已移到 ' + path.relative(U.ROOT, dest) }
    }
  }
}
