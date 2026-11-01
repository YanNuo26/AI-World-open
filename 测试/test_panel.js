// 软件面板（源码/panel/）的回归测试 —— **不需要 Minecraft 服务器**，随时能跑：
//   node 测试/test_panel.js
//
// 测的重点是"面板骨架 + 扩展约定"，而不是界面好不好看：
//   1) loader：一个功能 = api/ 下一个文件；坏模块只警告不崩服务；id 重复 / ui.type 写错会被拦
//   2) HTTP：/api/features 自动带出新模块、各功能接口能返回数据、404/403 正常
//   3) 配置写入：只认声明过的字段、类型强转、非法值 400、**config.json 原样恢复**
//   4) 安全：路径穿越、非本机 Host、明文目录访问
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')

const ROOT = path.join(__dirname, '..')
const API_DIR = path.join(ROOT, '源码', 'panel', 'api')
const CONFIG_FILE = path.join(ROOT, 'config.json')

let pass = 0
let fail = 0
function check (name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name) } else {
    fail++
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra)))
  }
}

// 极简 HTTP 客户端：能自定义 Host 头 / 原始路径（fetch 会把 ../ 规范化掉，测不了穿越）
function request (port, pathName, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathName,
      method: opts.method || 'GET',
      headers: Object.assign({}, opts.headers)
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => {
        let data = null
        try { data = text && /json/.test(res.headers['content-type'] || '') ? JSON.parse(text) : text } catch (e) { data = text }
        resolve({ status: res.statusCode, headers: res.headers, data, text })
      })
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
    req.end()
  })
}

;(async function main () {
  // ---------- 1) 加载器 ----------
  console.log('[1] 功能模块加载器')
  const { loadFeatures, buildRoutes, validateFeature } = require('../源码/panel/loader')
  const loaded = loadFeatures(API_DIR)
  const ids = loaded.features.map((f) => f.id)
  check('加载到全部内置功能', ids.length >= 6, ids)
  check('必需功能都在', ['overview', 'processes', 'config', 'logs', 'assets'].every((id) => ids.includes(id)), ids)
  check('规划中的功能也加载（前端显示"规划中"）', ids.includes('llm') && ids.includes('scriptapi'), ids)
  check('下划线文件不当作功能（_util/_procs/_state/_settings）',
    !ids.some((id) => id.startsWith('_')) && loaded.warnings.length === 0, loaded.warnings)
  check('按 order 排序', loaded.features.every((f, i, a) => i === 0 || a[i - 1].order <= f.order),
    loaded.features.map((f) => f.order))
  const built = buildRoutes(loaded.features)
  check('路由表里能查到 GET /api/config', !!built.table.get('GET /api/config'))
  check('路由表里能查到 POST /api/processes/server/start', !!built.table.get('POST /api/processes/server/start'))
  check('模块不含坏路由', built.warnings.length === 0, built.warnings)

  // 坏模块：只警告、不崩、不影响其它模块
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-test-'))
  fs.writeFileSync(path.join(tmp, '_helpers.js'), 'module.exports = { ok: 1 }\n')
  fs.writeFileSync(path.join(tmp, 'good.js'),
    "module.exports = { id: 'good', title: '好模块', order: 1, ui: { type: 'cards' }, routes: { 'GET /': async () => ({}) } }\n")
  fs.writeFileSync(path.join(tmp, 'no-id.js'), "module.exports = { title: '没有 id', ui: { type: 'cards' }, routes: { 'GET /': () => 1 } }\n")
  fs.writeFileSync(path.join(tmp, 'bad-type.js'),
    "module.exports = { id: 'badType', title: '类型错', ui: { type: 'video' }, routes: { 'GET /': () => 1 } }\n")
  fs.writeFileSync(path.join(tmp, 'dup.js'),
    "module.exports = { id: 'good', title: '重复 id', ui: { type: 'cards' }, routes: { 'GET /': () => 1 } }\n")
  fs.writeFileSync(path.join(tmp, 'broken.js'), 'throw new Error("我就是坏的")\n')
  const tmpLoaded = loadFeatures(tmp)
  check('坏模块不影响好模块', tmpLoaded.features.length === 1 && tmpLoaded.features[0].id === 'good',
    tmpLoaded.features.map((f) => f.id))
  check('下划线文件被跳过', tmpLoaded.features.every((f) => f.id !== '_helpers'))
  check('每个坏模块都有警告', tmpLoaded.warnings.length === 4, tmpLoaded.warnings)
  check('警告能说清是哪个文件', tmpLoaded.warnings.some((w) => /no-id\.js/.test(w)) &&
    tmpLoaded.warnings.some((w) => /bad-type\.js/.test(w)) &&
    tmpLoaded.warnings.some((w) => /broken\.js/.test(w)) &&
    tmpLoaded.warnings.some((w) => /重复/.test(w)), tmpLoaded.warnings)
  check('validateFeature 能单独用', validateFeature({ id: 'x', title: 't', ui: { type: 'cards' }, routes: { 'GET /': () => 1 } }).length === 0)
  fs.rmSync(tmp, { recursive: true, force: true })


  // ---------- 2) 起面板（端口 0 = 系统随机分配，不占 8787）----------
  console.log('[2] HTTP 接口')
  // 面板运行期数据（服务器分页 / 玩家登记）：测试会写，先备份，最后原样还原
  const PROF_FILE = path.join(ROOT, '配置', '服务器配置.json')
  const REG_FILE = path.join(ROOT, '配置', '玩家登记.json')
  const PERF_FILE = path.join(ROOT, '配置', '面板设置.json')
  const AIS_FILE = path.join(ROOT, 'ais.json')
  const cfgBackup = fs.readFileSync(CONFIG_FILE, 'utf8')
  const profBackup = fs.existsSync(PROF_FILE) ? fs.readFileSync(PROF_FILE, 'utf8') : null
  const regBackup = fs.existsSync(REG_FILE) ? fs.readFileSync(REG_FILE, 'utf8') : null
  const perfBackup = fs.existsSync(PERF_FILE) ? fs.readFileSync(PERF_FILE, 'utf8') : null
  const aisBackup = fs.existsSync(AIS_FILE) ? fs.readFileSync(AIS_FILE, 'utf8') : null
  // 性能检测默认必须是关的：先把用户本机的开关挪开（finally 里还原），否则"默认关闭"测不出来
  if (fs.existsSync(PERF_FILE)) fs.unlinkSync(PERF_FILE)
  const server = await require('../源码/panel/server').start({ port: 0, quiet: true })
  const port = server.port
  try {
    const health = await request(port, '/api/health')
    check('GET /api/health -> ok', health.status === 200 && health.data.ok === true, health.data)
    check('health 带版本 / pid', !!health.data.version && !!health.data.pid, health.data)

    const feats = await request(port, '/api/features')
    const featureIds = (feats.data.features || []).map((f) => f.id)
    check('GET /api/features 带出全部功能', feats.status === 200 && featureIds.includes('config'), featureIds)
    check('每个功能都带 ui.type（前端靠它选渲染器）',
      (feats.data.features || []).every((f) => f.ui && typeof f.ui.type === 'string'))
    check('features 没有加载警告',
      Array.isArray(feats.data.warnings) && feats.data.warnings.length === 0, feats.data.warnings)

    const html = await request(port, '/')
    check('GET / 返回面板首页', html.status === 200 && /AI-World/.test(html.text), html.status)
    const css = await request(port, '/style.css')
    check('静态文件 Content-Type 正确', /text\/css/.test(css.headers['content-type'] || ''), css.headers['content-type'])
    const js = await request(port, '/app.js')
    check('app.js 能取到，含通用渲染器', js.status === 200 && /function viewCards/.test(js.text))

    // ---- 安全 ----
    const trav = await request(port, '/..%2Fpackage.json')
    check('静态目录穿越被拦（403/404）', trav.status === 403 || trav.status === 404, trav.status)
    const evilHost = await request(port, '/api/health', { headers: { Host: 'evil.example.com' } })
    check('非本机 Host 被拒（挡 DNS rebinding）', evilHost.status === 403, evilHost.status)
    const noRoute = await request(port, '/api/nope')
    check('不存在的接口 -> 404 JSON', noRoute.status === 404 && !!noRoute.data.error, noRoute.data)
    const wrongMethod = await request(port, '/api/processes/server/start', { method: 'GET' })
    check('方法不对 -> 404（路由按声明的方法挂）', wrongMethod.status === 404, wrongMethod.status)

    // ---- 各功能接口 ----
    const overview = await request(port, '/api/overview')
    check('GET /api/overview 返回卡片',
      Array.isArray(overview.data.cards) && overview.data.cards.length >= 3,
      overview.data.cards && overview.data.cards.length)
    const procs = await request(port, '/api/processes')
    check('GET /api/processes 返回服务器 + ai 两张卡', (procs.data.cards || []).length === 2)
    check('processes 卡片状态是已知值',
      (procs.data.cards || []).every((c) => ['ok', 'warn', 'err', 'busy', 'idle'].includes(c.status)),
      (procs.data.cards || []).map((c) => c.status))
    const out = await request(port, '/api/processes/output?target=server&tail=5')
    check('输出接口返回行数组 + next 游标',
      Array.isArray(out.data.lines) && typeof out.data.next === 'number', out.data)
    const logs = await request(port, '/api/logs')
    check('GET /api/logs 返回两个分组',
      Array.isArray(logs.data.groups) && logs.data.groups.length === 2,
      logs.data.groups && logs.data.groups.length)
    const badTail = await request(port, '/api/logs/tail?name=..%2F..%2Fconfig.json')
    check('日志接口挡路径穿越', badTail.status === 400, badTail.status)
    const assets = await request(port, '/api/assets')
    check('GET /api/assets 返回列定义 + 行',
      Array.isArray(assets.data.columns) && Array.isArray(assets.data.rows), assets.data && Object.keys(assets.data))
    const llmChat = await request(port, '/api/llm/chat', { method: 'POST', body: {} })
    check('规划中的功能返回 501（接口形状先定好）',
      llmChat.status === 501 && /还没实现/.test(llmChat.data.error || ''), llmChat.data)
    const reload = await request(port, '/api/_panel/reload', { method: 'POST' })
    check('POST /api/_panel/reload 能热重载', reload.status === 200 && reload.data.features >= 6, reload.data)


    // ---------- 3) 配置保存（会改 config.json，结束时原样恢复）----------
    console.log('[3] 配置保存')
    const backup = fs.readFileSync(CONFIG_FILE, 'utf8')
    try {
      const before = JSON.parse(backup.replace(/^\uFEFF/, ''))
      const get = await request(port, '/api/config')
      // 保存只会在"正在生效的那页"顺手写进 config.json；
      // 用户可能正看着别的分页（正常状态），所以这里明确用 applied —— 否则测不到字段转换。
      const activeId = get.data.applied || get.data.active
      check('GET /api/config 返回表单值',
        !!get.data.values && typeof get.data.values['server.host'] === 'string', get.data.values)
      check('GET /api/config 带生效摘要',
        typeof get.data.effective === 'string' && get.data.effective.length > 0, get.data.effective)
      check('GET /api/config 带告警数组', Array.isArray(get.data.warnings), get.data.warnings)

      const same = await request(port, '/api/config/save', { method: 'POST', body: { id: activeId, values: get.data.values } })
      const afterSame = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''))
      check('原样保存 -> 200', same.status === 200 && same.data.ok === true, same.data)
      // 只比"键还在不在"：值可能因为"分页档案 → config.json"的合并而变（这是设计如此），
      // 这条断言的本意是"保存不会把已有字段弄丢"。
      check('原样保存 -> 原有字段一个都没丢', hasAllKeys(before, afterSame), Object.keys(before))

      const setRes = await request(port, '/api/config/save', {
        method: 'POST',
        body: {
          id: activeId,
          values: {
            'ai.obeyWhitelist': 'alex, bob',
            'server.port': '25565',
            'rcon.enabled': 'false',
            'behavior.reconnect.maxDelayMs': '12345'
          }
        }
      })
      const written = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''))
      check('保存成功并回报字段数', setRes.status === 200 && setRes.data.saved === 4, setRes.data)
      check('名单字符串 -> 数组',
        JSON.stringify(written.ai.obeyWhitelist) === '["alex","bob"]', written.ai.obeyWhitelist)
      check('端口字符串 -> 数字', written.server.port === 25565, written.server.port)
      check('开关 "false" -> 布尔 false', written.rcon.enabled === false, written.rcon.enabled)
      check('数字字段 -> 数字', written.behavior.reconnect.maxDelayMs === 12345, written.behavior.reconnect.maxDelayMs)

      const badPort = await request(port, '/api/config/save', { method: 'POST', body: { id: activeId, values: { 'server.port': 'abc' } } })
      check('端口非数字 -> 400', badPort.status === 400 && /需要数字/.test(badPort.data.error), badPort.data)
      const badRange = await request(port, '/api/config/save', { method: 'POST', body: { id: activeId, values: { 'server.port': '99999' } } })
      check('端口超范围 -> 400', badRange.status === 400 && /不能大于/.test(badRange.data.error), badRange.data)
      const badSel = await request(port, '/api/config/save', { method: 'POST', body: { id: activeId, values: { 'server.auth': 'mojang' } } })
      check('选项外取值 -> 400', badSel.status === 400 && /只能是/.test(badSel.data.error), badSel.data)
      const unknown = await request(port, '/api/config/save', { method: 'POST', body: { id: activeId, values: { 'hack.me': 1 } } })
      check('未声明字段被忽略 -> 400（一个都没保存）',
        unknown.status === 400 && /没有可保存/.test(unknown.data.error), unknown.data)
      const badJson = await request(port, '/api/config/save', { method: 'POST', body: '{oops' })
      check('坏 JSON -> 400', badJson.status === 400, badJson.status)

      const probe = await request(port, '/api/config/probe', { method: 'POST', body: { host: '127.0.0.1', port: 1 } })
      check('探测空闲端口 -> ok:false 且有说明',
        probe.status === 200 && probe.data.ok === false && !!probe.data.note, probe.data)
    } finally {
      fs.writeFileSync(CONFIG_FILE, backup) // 测试不留痕迹
      const restored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''))

      check('config.json 已还原', !!restored.server && !!restored.ai)
    }

    // ---------- 4) 面板 v2：多 ai / 多服务器分页 / 玩家登记 / 性能 ----------
    console.log('[4] 面板 v2')
    const 玩家登记 = require('../源码/玩家登记')

    // 启动 / 停止：两张固定布局的卡 + 全部 ai 的表格
    const procs2 = await request(port, '/api/processes')
    const cards2 = procs2.data.cards || []
    check('启动停止：两张卡都是固定布局', cards2.length === 2 && cards2.every((c) => c.fixed === true),
      cards2.map((c) => !!c.fixed))
    check('启动停止：两张卡输出框同高（对齐）', cards2[0].log.height === cards2[1].log.height,
      [cards2[0].log.height, cards2[1].log.height])
    check('启动停止：ai 卡列出全部 ai（主 ai 排第一）',
      !!(cards2[1].table && cards2[1].table.rows.length >= 1) &&
      String(cards2[1].table.rows[0][0]).indexOf('world') === 0, cards2[1].table)

    // 多服务器分页：保存"没生效的分页"绝不能动 config.json
    let cfgA = await request(port, '/api/config')
    // 面板允许"看的页 ≠ 生效页"（用户切了标签没点「应用到游戏」，是正常状态）。
    // 为了让下面的断言有确定前提，先确保当前页就是生效页；两个文件测完都会原样还原。
    if (cfgA.data.active && cfgA.data.applied !== cfgA.data.active) {
      await request(port, '/api/config/apply', { method: 'POST', body: { id: cfgA.data.active } })
      cfgA = await request(port, '/api/config')
    }
    const cfgBefore = fs.readFileSync(CONFIG_FILE, 'utf8')
    check('连接与权限：能读到分页', (cfgA.data.profiles || []).length >= 1, cfgA.data.profiles)
    check('连接与权限：字段表里有 ai.owner / ai.guestPrefix',
      ['ai.owner', 'ai.guestPrefix'].every((k) => (cfgA.data.fields || []).some((f) => f.key === k)))
    check('连接与权限：默认分页就是生效中的那份', cfgA.data.active === cfgA.data.applied,
      [cfgA.data.active, cfgA.data.applied])

    const madeP = await request(port, '/api/config/profile/new',
      { method: 'POST', body: { label: '测试分页', copyFrom: cfgA.data.active } })
    check('新建分页', madeP.status === 200 && !!madeP.data.id, madeP.data)
    const newId = madeP.data.id

    const savedP = await request(port, '/api/config/save',
      { method: 'POST', body: { id: newId, values: { 'server.host': '127.0.0.9', 'server.port': '25599' } } })
    check('保存到新分页', savedP.status === 200 && savedP.data.saved === 2, savedP.data)
    check('保存"没生效的分页"不会改 config.json', fs.readFileSync(CONFIG_FILE, 'utf8') === cfgBefore)

    const cfgB = await request(port, '/api/config?id=' + newId)
    check('分页各存各的值', cfgB.data.values['server.host'] === '127.0.0.9', cfgB.data.values['server.host'])
    check('看的分页 ≠ 生效分页时给出提示', cfgB.data.appliedMismatch === true)

    const applied2 = await request(port, '/api/config/apply', { method: 'POST', body: { id: newId } })
    check('应用到 config.json', applied2.status === 200 && /127\.0\.0\.9/.test(fs.readFileSync(CONFIG_FILE, 'utf8')), applied2.data)
    const delP = await request(port, '/api/config/profile/delete', { method: 'POST', body: { id: newId } })
    check('删除分页', delP.status === 200, delP.data)
    fs.writeFileSync(CONFIG_FILE, cfgBefore) // 立刻还原，后面不再碰

    // 玩家登记（纯文件逻辑，不碰游戏）
    if (fs.existsSync(REG_FILE)) fs.unlinkSync(REG_FILE)
    const hp = { host: '127.0.0.1', port: 25565 }
    const j1 = 玩家登记.recordJoin({ host: hp.host, port: hp.port, username: 'TestUser', ownerName: '', guestPrefix: 'way-' })
    check('登记新玩家', !!(j1 && j1.isNew === true), j1)
    check('成员初始 ai 默认 way-玩家名', j1.player.aiName === 'way-TestUser', j1.player)
    check('同名不同大小写不会记成两个人',
      玩家登记.recordJoin({ host: hp.host, port: hp.port, username: 'testuser', ownerName: '', guestPrefix: 'way-' }).isNew === false)
    const listP = 玩家登记.listPlayers(hp.host, hp.port)
    check('玩家列表能读出来', listP.length === 1, listP)

    玩家登记.setRole({ host: hp.host, port: hp.port, username: 'TestUser', role: 'owner' })
    check('能设成服主', 玩家登记.listPlayers(hp.host, hp.port)[0].role === 'owner')

    // 2026-11-01 第二版：初始 ai 名字**固定**，改名接口一律拒绝（要换叫法用别名）
    let rnErr = ''
    try {
      玩家登记.renameAi({ host: hp.host, port: hp.port, username: 'TestUser', aiName: 'way-小测试', mainName: 'world' })
    } catch (e) { rnErr = e.message }
    check('初始 ai 名不能改（改名接口直接拒绝）', /固定/.test(rnErr), rnErr)
    // 注意：后一次 recordJoin('testuser') 会把 name 的写法更新成小写，固定规则按当前写法生成
    const fixedName = String(玩家登记.listPlayers(hp.host, hp.port)[0].aiName || '').toLowerCase()
    check('列表里的初始 ai 名仍是默认值（way-<玩家名>）', fixedName === 'way-testuser', fixedName)
    let regErr = ''
    try {
      玩家登记.setAlias({ host: hp.host, port: hp.port, username: 'TestUser', alias: 'a b', mainName: 'world' })
    } catch (e) { regErr = e.message }
    check('非法别名被拒绝', regErr.length > 0, regErr)

    玩家登记.removePlayer({ host: hp.host, port: hp.port, username: 'TestUser' })
    check('能删除玩家登记', 玩家登记.listPlayers(hp.host, hp.port).length === 0)

    // ---- 成员视角的护栏：只能改自己名下的 ai（归属看 ais.json 的 owner）----
    fs.writeFileSync(AIS_FILE, JSON.stringify({
      world: { owner: null, obey: [] },
      'way-TestUser': { owner: 'TestUser', obey: [] },
      other: { owner: 'someone', obey: [] }
    }, null, 2))
    const obeyMine = await request(port, '/api/config/ai/obey',
      { method: 'POST', body: { name: 'way-TestUser', obey: 'TestUser', owner: 'testuser' } })
    check('成员能改自己 ai 的指挥名单（owner 大小写不敏感）',
      obeyMine.status === 200 && JSON.stringify(obeyMine.data.obey) === '["TestUser"]', obeyMine.data)
    const obeyOther = await request(port, '/api/config/ai/obey',
      { method: 'POST', body: { name: 'other', obey: 'TestUser', owner: 'TestUser' } })
    check('成员不能改别人的 ai（403）', obeyOther.status === 403, obeyOther.data)
    const obeyMain = await request(port, '/api/config/ai/obey',
      { method: 'POST', body: { name: 'world', obey: 'TestUser', owner: 'TestUser' } })
    check('成员不能改主 ai（400）', obeyMain.status === 400 && /主 ai/.test(obeyMain.data.error || ''), obeyMain.data)
    const renameOther = await request(port, '/api/config/ai/rename',
      { method: 'POST', body: { from: 'other', to: 'other2', owner: 'TestUser' } })
    check('成员不能给别人的 ai 改名（403）', renameOther.status === 403, renameOther.data)
    const renameMine = await request(port, '/api/config/ai/rename',
      { method: 'POST', body: { from: 'way-TestUser', to: 'way-TestUser2', owner: 'TestUser' } })
    check('成员能给自己名下的 ai 改名', renameMine.status === 200, renameMine.data)
    // 服主视角不传 owner → 不受限制（要能管所有 ai）
    const obeyAsOwner = await request(port, '/api/config/ai/obey',
      { method: 'POST', body: { name: 'other', obey: 'someone' } })
    check('服主视角不传 owner 时不限归属', obeyAsOwner.status === 200, obeyAsOwner.data)

    // ---- 2026-11-01：视角跟着分页（建页时定死）/ way-xxx 算 ai / 聊天监视 ----
    const pv = await request(port, '/api/config/profile/new',
      { method: 'POST', body: { label: '成员视角页', view: 'member', copyFrom: cfgA.data.active } })
    check('新建分页能选视角（member）', pv.status === 200 && pv.data.view === 'member', pv.data)
    const cfgV = await request(port, '/api/config?id=' + pv.data.id)
    check('视角跟着分页走（view + viewLocked）',
      cfgV.data.view === 'member' && cfgV.data.viewLocked === true, [cfgV.data.view, cfgV.data.viewLocked])
    const setAgain = await request(port, '/api/config/profile/view',
      { method: 'POST', body: { id: pv.data.id, view: 'owner' } })
    check('视角定死后不能再切换（400）',
      setAgain.status === 400 && /不能切换/.test(setAgain.data.error || ''), setAgain.data)

    // 老分页（创建时还没有 view 字段）只能补一次
    const profRaw = JSON.parse(fs.readFileSync(PROF_FILE, 'utf8').replace(/^\uFEFF/, ''))
    const legacyP = profRaw.profiles.find((x) => x.id === pv.data.id)
    if (legacyP) delete legacyP.view
    fs.writeFileSync(PROF_FILE, JSON.stringify(profRaw, null, 2))
    const cfgLegacy = await request(port, '/api/config?id=' + pv.data.id)
    check('老分页没有视角（面板会提示选一次）',
      cfgLegacy.data.view === '' && cfgLegacy.data.viewLocked === false, cfgLegacy.data.view)
    const setOnce = await request(port, '/api/config/profile/view',
      { method: 'POST', body: { id: pv.data.id, view: 'owner' } })
    check('老分页能补一次视角', setOnce.status === 200 && setOnce.data.view === 'owner', setOnce.data)
    const setTwice = await request(port, '/api/config/profile/view',
      { method: 'POST', body: { id: pv.data.id, view: 'member' } })
    check('补过一次之后同样锁死', setTwice.status === 400, setTwice.data)

    // 成员视角：配置**照样能改**，但服主专用的字段**根本不下发**（R6：不显示服主的信息）
    // 注意：上面的 setOnce 已经把 pv 这个分页定成了「服主」，这里再建一个成员页来测。
    const mprof = await request(port, '/api/config/profile/new',
      { method: 'POST', body: { label: '成员页（可改配置）', view: 'member', copyFrom: cfgA.data.active } })
    check('再建一个成员视角分页', mprof.status === 200 && mprof.data.view === 'member', mprof.data)
    const mvCfg = await request(port, '/api/config?id=' + mprof.data.id)
    const mvFieldKeys = (mvCfg.data.fields || []).map((f) => f.key)
    check('成员视角不下发任何 ai.* 字段（服主专用）',
      mvFieldKeys.length > 0 && !mvFieldKeys.some((k) => k.indexOf('ai.') === 0), mvFieldKeys)
    check('成员视角仍能看到 server.* / rcon.*（自己的连接）',
      mvFieldKeys.includes('server.host') && mvFieldKeys.includes('rcon.password'), mvFieldKeys)
    check('成员视角不下发 ai.owner / 主 ai 名字（不显示服主的信息）',
      !('ai.owner' in (mvCfg.data.values || {})) && !('ai.name' in (mvCfg.data.values || {})) &&
      mvCfg.data.owner === '' && mvCfg.data.mainAi === '',
      [mvCfg.data.owner, mvCfg.data.mainAi, Object.keys(mvCfg.data.values || {})])
    check('成员视角不下发玩家登记表（只看得到名字列表）',
      Array.isArray(mvCfg.data.players) && mvCfg.data.players.length === 0 &&
      Array.isArray(mvCfg.data.playerNames), [mvCfg.data.players.length, (mvCfg.data.playerNames || []).length])
    const mvSave = await request(port, '/api/config/save',
      { method: 'POST', body: { id: mprof.data.id, values: { 'server.host': '10.0.0.5', 'server.port': '25570' } } })
    check('成员视角能改服务器地址 / 端口', mvSave.status === 200 && mvSave.data.saved === 2, mvSave.data)
    const mvRead = await request(port, '/api/config?id=' + mprof.data.id)
    check('成员视角改的值真的存进了那一页',
      mvRead.data.values['server.host'] === '10.0.0.5', mvRead.data.values['server.host'])
    const mvBad = await request(port, '/api/config/save',
      { method: 'POST', body: { id: mprof.data.id, values: { 'ai.owner': 'Hacker' } } })
    check('成员视角硬塞服主专用字段也存不进去（403）',
      mvBad.status === 403 && /服主专用/.test(mvBad.data.error || ''), mvBad.data)
    const mvBadOp = await request(port, '/api/config/save',
      { method: 'POST', body: { id: mprof.data.id, values: { 'ai.autoOp': 'always' } } })
    check('成员视角不能改 op 策略（403）', mvBadOp.status === 403, mvBadOp.data)
    // 对照：服主视角的分页能改这两项
    const owSave = await request(port, '/api/config/save',
      { method: 'POST', body: { id: pv.data.id, values: { 'ai.owner': 'YanNuo' } } })
    check('服主视角能改服主游戏名', owSave.status === 200, owSave.data)
    await request(port, '/api/config/profile/delete', { method: 'POST', body: { id: mprof.data.id } })
    await request(port, '/api/config/profile/delete', { method: 'POST', body: { id: pv.data.id } })
    // 保存会把 active 指到那一页，这里拨回原来的分页，后面的断言不受影响
    await request(port, '/api/config/profile/active', { method: 'POST', body: { id: cfgA.data.active } })

    // way-xxx / 主 ai 一律算 ai：不进玩家表，历史误记的会被清掉
    fs.writeFileSync(REG_FILE, JSON.stringify({
      servers: {
        [玩家登记.serverKey(hp.host, hp.port)]: {
          updatedAt: Date.now(),
          players: {
            alice: { name: 'alice', role: 'member', aiName: 'way-alice', renamedFrom: [], note: '', firstSeen: 1, lastSeen: 2, joinCount: 2 },
            'way-alice': { name: 'way-alice', role: 'member', aiName: 'way-way-alice', renamedFrom: [], note: '', firstSeen: 1, lastSeen: 2, joinCount: 1 },
            world: { name: 'world', role: 'member', aiName: 'way-world', renamedFrom: [], note: '', firstSeen: 1, lastSeen: 2, joinCount: 3 }
          }
        }
      }
    }, null, 2))
    const clsWay = 玩家登记.classifyName('way-alice', { guestPrefix: 'way-', mainName: 'world', ais: {} })
    check('名字带 way- 前缀算 ai（归属剥前缀）', clsWay.isAi === true && clsWay.owner === 'alice', clsWay)
    check('主 ai 名字算 ai', 玩家登记.classifyName('world', { mainName: 'world', ais: {} }).isAi === true)
    check('普通玩家不算 ai', 玩家登记.classifyName('alice', { guestPrefix: 'way-', ais: {} }).isAi === false)
    const humanOnly = 玩家登记.listPlayers(hp.host, hp.port, { mainName: 'world', guestPrefix: 'way-', ais: {} })
    check('玩家表里只剩真人（way-xxx / world 被排除）',
      humanOnly.length === 1 && humanOnly[0].name === 'alice', humanOnly.map((p) => p.name))
    const withAi = 玩家登记.listPlayers(hp.host, hp.port,
      { mainName: 'world', guestPrefix: 'way-', ais: {}, includeAi: true })
    check('includeAi 时能带出来并标 kind=ai',
      withAi.length === 3 && withAi.some((p) => p.kind === 'ai' && p.aiOwner === 'alice'), withAi)
    const prunedList = 玩家登记.pruneAiEntries({ host: hp.host, port: hp.port, mainName: 'world', guestPrefix: 'way-', ais: {} })
    check('历史误记成玩家的 ai 会被清掉', prunedList.length === 2, prunedList)
    check('清理后只剩真人', 玩家登记.listPlayers(hp.host, hp.port, {}).length === 1)
    const jAi = 玩家登记.recordJoin({
      host: hp.host, port: hp.port, username: 'way-bob', guestPrefix: 'way-', mainName: 'world',
      ais: { 'way-bob': { owner: 'bob', obey: [] } }
    })
    check('ai 上线不会被记成玩家', !!(jAi && jAi.isAi === true && !jAi.player), jAi)

    // 聊天监视：面板解析 bot 写进 日志/聊天.log 的行
    const CHAT_FILE = path.join(ROOT, '日志', '聊天.log')
    const chatBefore = fs.existsSync(CHAT_FILE) ? fs.readFileSync(CHAT_FILE, 'utf8') : null
    fs.writeFileSync(CHAT_FILE, [
      '[10:00:01] chat\talice\thello',
      '[10:00:02] ai\tway-alice\t我是 way-alice，已就绪！',
      '[10:00:03] chat\tbob\tway-alice help'
    ].join('\n') + '\n', 'utf8')
    const chatRes = await request(port, '/api/config/chat?n=10')
    check('聊天监视：能读到最后几条',
      chatRes.status === 200 && (chatRes.data.entries || []).length === 3, chatRes.data)
    const aiLine = (chatRes.data.entries || [])[1] || {}
    check('聊天监视：ai 说的话标出归属',
      aiLine.kind === 'ai' && aiLine.fromIsAi === true && aiLine.aiOwner === 'alice', aiLine)
    const humanLine = (chatRes.data.entries || [])[0] || {}
    check('聊天监视：玩家说的话不标 ai', humanLine.fromIsAi === false, humanLine)
    if (chatBefore == null) { try { fs.unlinkSync(CHAT_FILE) } catch (e) { /* ignore */ } } else fs.writeFileSync(CHAT_FILE, chatBefore)

    // ---- 2026-11-01 第二版：初始 ai 名称固定 / 成员别名 / 只查自己 / 每个 ai 的聊天 ----
    // 这些接口按**当前分页的 host:port** 查登记，所以 fixture 要用同一把 key
    const ph = {
      host: String(cfgA.data.values['server.host'] || 'localhost'),
      port: Number(cfgA.data.values['server.port']) || 25565
    }
    fs.writeFileSync(REG_FILE, JSON.stringify({
      servers: {
        [玩家登记.serverKey(ph.host, ph.port)]: {
          updatedAt: Date.now(),
          players: {
            alice: {
              name: 'alice', role: 'member', aiName: 'way-alice', alias: '',
              renamedFrom: [], note: '', firstSeen: 1, lastSeen: 2, joinCount: 2
            }
          }
        }
      }
    }, null, 2))
    // 1) 初始 ai 名字固定：进服时按规则重算，手工改过的会被纠正回来
    const rj = 玩家登记.recordJoin({
      host: ph.host, port: ph.port, username: 'alice', guestPrefix: 'way-', mainName: 'world'
    })
    check('进服时把初始 ai 名纠正回固定值', rj && rj.player && rj.player.aiName === 'way-alice',
      rj && rj.player && rj.player.aiName)
    let renameErr = ''
    try {
      玩家登记.renameAi({ host: ph.host, port: ph.port, username: 'alice', aiName: '随便改' })
    } catch (e) { renameErr = e.message }
    check('改名被拒绝（名称固定，改用别名）', /固定/.test(renameErr), renameErr)
    const rnApi = await request(port, '/api/config/player/rename',
      { method: 'POST', body: { username: 'alice', aiName: '随便改' } })
    check('老接口 /player/rename 也回 400', rnApi.status === 400 && /固定/.test(rnApi.data.error || ''), rnApi.data)

    // 2) 别名：能设、bot 能查到（游戏里用别名指挥）、不能撞主 ai
    const al1 = await request(port, '/api/config/player/alias',
      { method: 'POST', body: { username: 'alice', alias: '小A' } })
    check('能给成员的初始 ai 设别名', al1.status === 200 && al1.data.alias === '小A', al1.data)
    const hitAlias = 玩家登记.findByAiName(ph.host, ph.port, 'way-alice')
    check('bot 能按 ai 名查到别名（别名可当指令前缀）', hitAlias && hitAlias.alias === '小A',
      hitAlias && hitAlias.alias)
    const alBad = await request(port, '/api/config/player/alias',
      { method: 'POST', body: { username: 'alice', alias: 'world' } })
    check('别名不能和主 ai 名字撞（400）', alBad.status === 400, alBad.data)
    const alClear = await request(port, '/api/config/player/alias',
      { method: 'POST', body: { username: 'alice', alias: '小A' } })
    check('重复设置同名别名是幂等的', alClear.status === 200 && alClear.data.alias === '小A', alClear.data)

    // 3) /me：成员只查得到自己
    const meRes = await request(port, '/api/config/me?username=ALICE')
    check('/me 只返回自己那条（大小写不敏感）',
      meRes.status === 200 && meRes.data.found === true && meRes.data.player.name === 'alice' &&
      meRes.data.player.aiName === 'way-alice' && meRes.data.player.alias === '小A', meRes.data.player)
    const meNo = await request(port, '/api/config/me?username=nobody-here')
    check('/me 查不到时给友好提示（不报错）', meNo.status === 200 && meNo.data.found === false, meNo.data)

    // 4) 聊天：每个 ai 的统计 + 按 ai / 按 owner 过滤
    const chat2Before = fs.existsSync(CHAT_FILE) ? fs.readFileSync(CHAT_FILE, 'utf8') : null
    fs.writeFileSync(CHAT_FILE, [
      '[11:00:01] chat\talice\t小A 过来',
      '[11:00:02] ai\tway-alice\t已传送到你身边',
      '[11:00:03] ai\tway-bob\t我是 Bob',
      '[11:00:04] chat\tcarol\thello',
      '[11:00:05] ai\tway-alice\t开始建造默认建筑...'
    ].join('\n') + '\n', 'utf8')
    const chatAll = await request(port, '/api/config/chat?n=10')
    const aStat = (chatAll.data.byAi || []).find((x) => x.name === 'way-alice')
    check('聊天监视：能按 ai 统计发言（名字 + 别名 + 句数）',
      !!aStat && aStat.count === 2 && aStat.alias === '小A' && aStat.owner === 'alice',
      chatAll.data.byAi)
    const chatAi = await request(port, '/api/config/chat?n=10&ai=way-alice')
    check('聊天监视：只看某个 ai 的发言',
      (chatAi.data.entries || []).length === 2 &&
      chatAi.data.entries.every((e) => e.from === 'way-alice'), chatAi.data.entries.length)
    const chatOwner = await request(port, '/api/config/chat?n=10&owner=alice')
    check('聊天监视：成员视角只看得到自己和自己 ai 的发言',
      (chatOwner.data.entries || []).length === 3 &&
      chatOwner.data.entries.every((e) => e.from === 'alice' || e.from === 'way-alice'),
      (chatOwner.data.entries || []).map((e) => e.from))
    if (chat2Before == null) { try { fs.unlinkSync(CHAT_FILE) } catch (e) { /* ignore */ } } else fs.writeFileSync(CHAT_FILE, chat2Before)

    // ---- 性能：默认关闭；开启后才采样（面板自己 + 每个 ai）----
    const perfOff = await request(port, '/api/perf')
    check('性能：默认关闭（不采样）', perfOff.data.enabled === false && !perfOff.data.cpu, perfOff.data.enabled)
    check('性能：关闭时也知道面板 pid（页面要显示状态）',
      !!(perfOff.data.panel && perfOff.data.panel.pid === process.pid), perfOff.data.panel)
    check('性能：关闭时不列进程（省 CPU）', !perfOff.data.procs, perfOff.data.procs)

    const perfOn = await request(port, '/api/perf/toggle', { method: 'POST', body: { enabled: true } })
    check('性能：能开启', perfOn.status === 200 && perfOn.data.enabled === true, perfOn.data)
    check('性能：开关落盘（配置/面板设置.json）',
      fs.existsSync(PERF_FILE) && /"perf\.enabled":\s*true/.test(fs.readFileSync(PERF_FILE, 'utf8')))

    const perf1 = await request(port, '/api/perf')
    await new Promise((r) => setTimeout(r, 150)) // 给第二次采样留出明确的时间差
    const perf2 = await request(port, '/api/perf')
    check('性能：内存有总量', !!(perf1.data.mem && perf1.data.mem.total > 0), perf1.data.mem)
    check('性能：第二次采样 CPU 已就绪', !!(perf2.data.cpu && perf2.data.cpu.warm === true), perf2.data.cpu)
    check('性能：CPU 占用率在 0-100', perf2.data.cpu.percent >= 0 && perf2.data.cpu.percent <= 100, perf2.data.cpu.percent)
    check('性能：面板自己单独一行（pid / 内存都对）',
      !!(perf2.data.panel && perf2.data.panel.kind === 'panel' &&
        perf2.data.panel.pid === process.pid && perf2.data.panel.rss > 0), perf2.data.panel)
    check('性能：面板自己的 CPU 有数了', typeof perf2.data.panel.cpuPercent === 'number', perf2.data.panel.cpuPercent)
    check('性能：每个 ai 都单独列出（至少有主 ai）',
      (perf2.data.procs || []).some((x) => x.kind === 'ai-main'), (perf2.data.procs || []).map((x) => x.kind))
    check('性能：进程行都带 cpuPercent / rss / running',
      (perf2.data.procs || []).every((x) => 'cpuPercent' in x && 'rss' in x && 'running' in x), perf2.data.procs)
    check('性能：整机 CPU 带核心明细', perf2.data.cpu.count > 0 && (perf2.data.cpu.cores || []).length === perf2.data.cores,
      [perf2.data.cpu.count, perf2.data.cores])

    const perfStop = await request(port, '/api/perf/toggle', { method: 'POST', body: { enabled: false } })
    const perfAfter = await request(port, '/api/perf')
    check('性能：能关掉', perfStop.status === 200 && perfStop.data.enabled === false, perfStop.data)
    check('性能：关掉后不再采样（只回最小数据）',
      perfAfter.data.enabled === false && !perfAfter.data.cpu && !perfAfter.data.procs, perfAfter.data.enabled)

    const vConfig = await request(port, '/views/config.js')
    const vPerf = await request(port, '/views/perf.js')
    check('custom 视图能被前端加载（config / perf）',
      vConfig.status === 200 && /export async function render/.test(vConfig.text) &&
      vPerf.status === 200 && /export async function render/.test(vPerf.text), [vConfig.status, vPerf.status])
  } finally {
    await server.close()
    // config.json / 分页档案 / 玩家登记 / 面板设置 / ais.json：测完一律还原（原本没有就删掉）
    fs.writeFileSync(CONFIG_FILE, cfgBackup)
    if (profBackup == null) { try { fs.unlinkSync(PROF_FILE) } catch (e) { /* ignore */ } } else fs.writeFileSync(PROF_FILE, profBackup)
    if (regBackup == null) { try { fs.unlinkSync(REG_FILE) } catch (e) { /* ignore */ } } else fs.writeFileSync(REG_FILE, regBackup)
    if (perfBackup == null) { try { fs.unlinkSync(PERF_FILE) } catch (e) { /* ignore */ } } else fs.writeFileSync(PERF_FILE, perfBackup)
    if (aisBackup == null) { try { fs.unlinkSync(AIS_FILE) } catch (e) { /* ignore */ } } else fs.writeFileSync(AIS_FILE, aisBackup)
  }

  console.log('')
  console.log('PANEL TEST ' + (fail ? 'FAIL' : 'PASS') + '  (' + pass + ' 通过 / ' + fail + ' 失败)')
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('测试崩了：' + (e && e.stack ? e.stack : e))
  process.exit(1)
})

// before 里的每个键都要在 after 里且值相等（after 允许多出新键：保存时会补全默认字段）
// 注意：必须写在模块顶层 —— 写进 finally 块里就成了"块级函数"，外面看不见（踩过）。
// 递归比较"键结构"是否被包含（不看值）
function hasAllKeys (before, after) {
  if (before === null || typeof before !== 'object') return after !== undefined
  if (Array.isArray(before)) return Array.isArray(after) && after.length >= before.length
  if (!after || typeof after !== 'object' || Array.isArray(after)) return false
  return Object.keys(before).every((k) => hasAllKeys(before[k], after[k]))
}

function isSubset (before, after) {
  if (before === null || typeof before !== 'object') return JSON.stringify(before) === JSON.stringify(after)
  if (Array.isArray(before)) {
    return Array.isArray(after) && before.length === after.length &&
      before.every((v, i) => isSubset(v, after[i]))
  }
  if (!after || typeof after !== 'object') return false
  return Object.keys(before).every((k) => isSubset(before[k], after[k]))
}
