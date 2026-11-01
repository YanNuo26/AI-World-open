// ===== 自定义界面：连接与权限（源码/panel/web/views/config.js）=====
// 这个页面有四种东西：
//   ① 服务器分页（每个分页 = 一套"服务器 / RCON / ai"配置，存在 配置/服务器配置.json）
//   ② 服主视角：改配置 + 管理玩家（角色 / 初始 ai 名）+ 管理每个 ai 的指挥权限
//   ③ 非服主视角：只能改自己「初始 ai」的名字（默认 way-<玩家名>）
//   ④ 全局项（行为 / 默认建筑）：只写 config.json，不属于任何分页
//
// 所有数据来自 GET /api/config（见 api/config.js），这里不自己拼路径、不自己读文件。
const { h, api, toast } = window.panelUI

let MODE = 'owner' // 'owner' 服主视角 | 'member' 非服主视角
// 成员视角要"填一次自己的游戏名"，重画（保存后 RELOAD）不该把填的名字清空，所以记在模块变量里
let MEMBER_NAME = ''
let RELOAD = async () => {}

function isProfileKey (key) {
  return /^(server|rcon|ai)\./.test(String(key))
}

function activeLabel (d) {
  const p = (d.profiles || []).find((x) => x.id === d.active)
  return p ? p.label : d.active
}

// 一个输入框（和 app.js 的 fieldEl 同款，custom 视图拿不到那边的函数所以复制一份）
function fieldEl (field, value) {
  const id = 'cf-' + String(field.key).replace(/[^\w-]/g, '-')
  let input
  if (field.type === 'select') {
    input = h('select', { id })
    for (const o of field.options || []) {
      const opt = h('option', { value: o.value }, o.label || o.value)
      if (String(value) === String(o.value)) opt.selected = true
      input.appendChild(opt)
    }
  } else if (field.type === 'switch') {
    input = h('input', { id, type: 'checkbox', checked: !(value === false || value === 'false' || value == null) })
    const wrap = h('div', { class: 'field' }, h('label', { class: 'switch' }, input, h('span', {}, field.label)))
    if (field.hint) wrap.appendChild(h('span', { class: 'hint' }, field.hint))
    return { wrap, input }
  } else {
    input = h('input', {
      id,
      type: field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text',
      placeholder: field.placeholder || '',
      value: value == null ? '' : String(value)
    })
    if (field.min != null) input.min = field.min
    if (field.max != null) input.max = field.max
  }
  const wrap = h('div', { class: 'field' }, h('label', { for: id }, field.label), input)
  if (field.hint) wrap.appendChild(h('span', { class: 'hint' }, field.hint))
  return { wrap, input }
}

function btn (label, onclick, cls) {
  const b = h('button', { class: cls || '' }, label)
  b.addEventListener('click', async () => {
    b.disabled = true
    try { await onclick() } catch (e) { toast(e.message, 'err') } finally { b.disabled = false }
  })
  return b
}

// 发一个 POST，自动 toast + 重画
async function post (feature, path, body, okTip) {
  const r = await api('/api/' + feature.id + path, { method: 'POST', body: body || {} })
  toast((r && r.note) || okTip || '完成', 'ok')
  await RELOAD(body && body.id)
  return r
}

// ---------- 分页条 ----------
function profileBar (ctx) {
  const { feature, d } = ctx
  const bar = h('div', { class: 'tabs' })
  for (const p of d.profiles) {
    const on = p.id === d.active
    const b = h('button', { class: 'tab' + (on ? ' on' : ''), title: p.id === d.applied ? '这一页已经写进 config.json（游戏在用它）' : '点这里切换分页' },
      h('span', {}, p.label),
      p.view ? h('span', { class: 'badge ' + (p.view === 'member' ? 'b-busy' : 'b-idle') },
        p.view === 'member' ? '成员' : '服主') : null,
      p.id === d.applied ? h('span', { class: 'badge b-ok' }, '生效中') : null)
    b.addEventListener('click', async () => {
      if (on) return
      try { await post(feature, '/profile/active', { id: p.id }, '已切换分页') } catch (e) { toast(e.message, 'err') }
    })
    bar.appendChild(b)
  }
  bar.appendChild(h('span', { class: 'tabs-sp' }))
  // 新建分页：名字 + 视角一次选好（视角建完就锁定，所以不能像以前那样只问名字）
  bar.appendChild(btn('+ 新建分页', async () => {
    bar.appendChild(newProfileForm(ctx, bar))
  }))
  bar.appendChild(btn('改名', async () => {
    const label = window.prompt('分页新名字', activeLabel(d))
    if (label == null) return
    await post(feature, '/profile/label', { id: d.active, label }, '已改名')
  }))
  bar.appendChild(btn('删除这一页', async () => {
    if (!window.confirm('删除分页「' + activeLabel(d) + '」？\n（只删面板里的配置档案，config.json 和游戏不受影响）')) return
    await post(feature, '/profile/delete', { id: d.active }, '已删除')
  }, 'danger'))
  bar.appendChild(btn('应用到游戏', async () => {
    if (!window.confirm('把「' + activeLabel(d) + '」写进 config.json？\n之后要重启 ai（改了端口还要重启服务器）才生效。')) return
    await post(feature, '/apply', { id: d.active }, '已应用')
  }, 'primary'))
  return bar
}

// ---------- 新建分页：名字 + 视角 ----------
// 视角（服主 / 非服主）**在这一步定下来**：一台机器上谁是服主是固定的，
// 之后面板里不再给切换按钮，服务端 /profile/view 也会拒绝第二次设置。
function newProfileForm (ctx, bar) {
  const { feature, d } = ctx
  const wrap = h('div', { class: 'newprofile' })
  const name = h('input', { type: 'text', placeholder: '分页名字（例如：朋友的服）', value: '新服务器', style: { minWidth: '180px' } })
  const viewSel = h('select', {})
  viewSel.appendChild(h('option', { value: 'owner' }, '我是服主（能改配置 / 管所有人）'))
  viewSel.appendChild(h('option', { value: 'member' }, '我是成员（只管自己的 ai）'))
  const close = () => { if (wrap.parentNode) wrap.parentNode.removeChild(wrap) }
  const go = async () => {
    const label = name.value.trim() || '新服务器'
    const view = viewSel.value === 'member' ? 'member' : 'owner'
    const r = await api('/api/' + feature.id + '/profile/new', {
      method: 'POST',
      body: { label, copyFrom: d.active, view }
    })
    toast('已新建分页「' + r.label + '」（视角：' + (r.view === 'member' ? '成员' : '服主') +
      '，之后不能改），配置是从当前页复制的', 'ok')
    await RELOAD(r.id)
  }
  wrap.appendChild(h('span', { class: 'muted small' }, '新分页：'))
  wrap.appendChild(name)
  wrap.appendChild(viewSel)
  wrap.appendChild(btn('创建', go, 'small primary'))
  wrap.appendChild(btn('取消', async () => { close() }, 'small'))
  return wrap
}

// ---------- 视角（每页一个，创建时定死）----------
function viewBar (ctx) {
  const { d } = ctx
  const wrap = h('div', { class: 'viewtoggle' })
  if (d.viewLocked) {
    wrap.appendChild(h('span', { class: 'muted small' }, '本页视角：'))
    wrap.appendChild(h('span', { class: 'badge ' + (d.view === 'member' ? 'b-busy' : 'b-ok') }, d.viewText))
    wrap.appendChild(h('span', { class: 'muted small' },
      '（创建分页时选定的，之后不能改 —— 要换视角就新建一个分页）'))
    wrap.appendChild(h('span', { class: 'muted small' },
      d.view === 'owner'
        ? '服主的游戏名在下面的「服主游戏名」里设置（ai.owner），设置后成员进服会被记成成员'
        : '成员：能看服务器信息、改自己 ai 的名字和「谁能指挥它」；初始名默认叫 ' +
          (d.guestPrefix || 'way-') + '<玩家名>'))
    return wrap
  }
  // 老分页（建的时候还没有视角字段）：给一次机会选定，选完就锁死
  wrap.appendChild(h('span', { class: 'muted small' }, '这一页还没定视角：'))
  const pick = (view) => async () => {
    const r = await api('/api/' + ctx.feature.id + '/profile/view', { method: 'POST', body: { id: ctx.d.active, view } })
    toast(r.note || '已设定视角', 'ok')
    await RELOAD(ctx.d.active)
  }
  wrap.appendChild(btn('我是服主', pick('owner'), 'small primary'))
  wrap.appendChild(btn('我是成员（非服主）', pick('member'), 'small'))
  wrap.appendChild(h('span', { class: 'muted small' }, '（只有这一次机会，选完就固定）'))
  return wrap
}

// ---------- 渲染入口 ----------
function paint (box, ctx) {
  ctx.box = box
  const { d } = ctx
  box.innerHTML = ''
  // 视角跟着分页走（不再是模块里的临时开关）
  MODE = d.view || 'owner'
  box.appendChild(profileBar(ctx))
  box.appendChild(viewBar(ctx))
  if (!d.viewLocked) {
    box.appendChild(h('div', { class: 'warnbar' },
      '这个分页还没有定「视角」。视角决定这一页能看什么、能改什么（服主 = 管所有人和所有 ai；成员 = 只管自己的 ai）。\n' +
      '视角在**创建分页时选定、之后不能改**，所以这里只问一次：这台机器你是服主就点「我是服主」。'))
    box.appendChild(footNotes(d))
    return
  }
  if (d.pruned && d.pruned.length) {
    box.appendChild(h('p', { class: 'note' },
      '已自动把 ' + d.pruned.length + ' 个「其实是 ai」的名字从玩家登记里清出去：' +
      d.pruned.join('、') + '\n（名字带 ' + (d.guestPrefix || 'way-') +
      ' 前缀、或者在 ais.json 里的，一律算 ai，不算玩家）'))
  }
  if (MODE === 'owner') box.appendChild(ownerView(ctx))
  else box.appendChild(memberView(ctx))
  box.appendChild(footNotes(d))
}

export async function render (root, feature) {
  const box = h('div', { class: 'cfgview' }, h('p', { class: 'muted' }, '读取中…'))
  root.innerHTML = ''
  root.appendChild(box)

  RELOAD = async (id) => {
    let d
    try {
      d = await api('/api/' + feature.id + (id ? '?id=' + encodeURIComponent(id) : ''))
    } catch (e) {
      box.innerHTML = ''
      box.appendChild(h('div', { class: 'warnbar' }, '读不到配置：' + e.message))
      return
    }
    if (!box.isConnected) return
    paint(box, { box, feature, d })
  }
  await RELOAD()
}

// ---------- 玩家登记表（服主）----------
function playerSection (ctx) {
  const { feature, d } = ctx
  const box = h('div', {})
  box.appendChild(h('div', { class: 'group-title' }, '玩家登记（服务器 ' + (d.serverKey || '') + '）'))
  const players = d.players || []
  if (!players.length) {
    box.appendChild(h('p', { class: 'note preline' },
      '还没有记录。ai 连上服务器后会自动记下进服的玩家（存到 配置/玩家登记.json）——\n' +
      '想让谁出现在这里，让他先进一次服务器；玩家名单和"谁有哪些 ai"都是游戏里自动记的。'))
    return box
  }
  box.appendChild(h('p', { class: 'note preline' },
    '角色 = 服主 / 成员；「初始 ai 名」是**固定**的（成员 = ' + (d.guestPrefix || 'way-') +
    '<玩家名>，服主 = 主 ai），不能改名 —— 想换叫法请设「别名」。\n' +
    '别名是成员在游戏里指挥自己 ai 的叫法：「小A build ...」和「' + (d.guestPrefix || 'way-') +
    '<玩家名> build ...」等价；ai 下次上线会向主 ai 报告自己的别名。\n' +
    '这张表**只列人**：名字带 ' + (d.guestPrefix || 'way-') + ' 前缀、或者在 ais.json 里的（world / AIBuilder / way-xxx）' +
    '一律算 ai，不会混进来（历史误记的会在打开页面时自动清掉）；它们看下面的「ai 一览」。'))
  const t = h('table', { class: 'list' })
  t.appendChild(h('thead', {}, h('tr', {},
    h('th', {}, '玩家'),
    h('th', { style: { width: '96px' } }, '角色'),
    h('th', {}, '初始 ai 名（固定）'),
    h('th', {}, '别名（可空）'),
    h('th', {}, '名下的 ai'),
    h('th', {}, '最后在线'),
    h('th', { style: { width: '140px' } }, '操作')
  )))
  const tb = h('tbody')
  for (const p of players) {
    const roleSel = h('select', {})
    for (const pair of [['owner', '服主'], ['member', '成员']]) {
      const o = h('option', { value: pair[0] }, pair[1])
      if (p.role === pair[0]) o.selected = true
      roleSel.appendChild(o)
    }
    // 名字固定：只读展示（服主没有初始 ai 名，用主 ai）
    const fixedName = p.aiName || (p.role === 'owner' ? '（主 ai）' : ((d.guestPrefix || 'way-') + p.name))
    const fixedEl = h('input', { type: 'text', value: fixedName, readonly: true })
    const aliasInput = h('input', { type: 'text', value: p.alias || '', placeholder: '例如：小A' })
    aliasInput.disabled = !p.aiName // 服主/没有初始 ai 的人不设别名
    const aiText = (p.ais || []).length
      ? p.ais.map((a) => a.name + (a.alias ? '（' + a.alias + '）' : '') +
        '：' + (a.obey.length ? a.obey.join('、') : '所有人')).join('、')
      : '—'
    const ops = h('div', { class: 'btnbar', style: { margin: '0', gap: '6px' } })
    ops.appendChild(btn('保存', async () => {
      const id = d.active
      if (roleSel.value !== p.role) {
        await api('/api/' + feature.id + '/player/role', { method: 'POST', body: { id, username: p.name, role: roleSel.value } })
      }
      const wantAlias = aliasInput.value.trim()
      if (p.aiName && wantAlias !== (p.alias || '')) {
        const r = await api('/api/' + feature.id + '/player/alias', {
          method: 'POST', body: { id, username: p.name, alias: wantAlias }
        })
        toast(r.note, 'ok')
      } else {
        toast('已保存 ' + p.name, 'ok')
      }
      await RELOAD(id)
    }, 'small primary'))
    ops.appendChild(btn('删除', async () => {
      if (!window.confirm('删掉 ' + p.name + ' 的登记？\n只是不在面板里显示，游戏里的 ai 不受影响。')) return
      await post(feature, '/player/delete', { id: d.active, username: p.name }, '已删除登记')
    }, 'small danger'))
    tb.appendChild(h('tr', {},
      h('td', {}, p.name, p.joinCount > 1 ? h('span', { class: 'muted small' }, '（进服 ' + p.joinCount + ' 次）') : null),
      h('td', {}, roleSel),
      h('td', {}, fixedEl),
      h('td', {}, aliasInput),
      h('td', { class: 'small' }, aiText),
      h('td', { class: 'small' }, p.lastSeenText || '—'),
      h('td', {}, ops)
    ))
  }
  t.appendChild(tb)
  box.appendChild(t)
  return box
}

// ---------- ai 一览：名字 / 归属 / 谁能指挥（服主）----------
function aiSection (ctx) {
  const { feature, d } = ctx
  const box = h('div', {})
  box.appendChild(h('div', { class: 'group-title' }, 'ai 一览（主 ai 是 ' + (d.mainAi || '?') + '）'))
  const rows = []
  for (const p of d.players || []) for (const a of p.ais || []) rows.push({ a, owner: p.name, guessed: !!a.ownerGuessed })
  for (const a of d.freeAis || []) {
    rows.push({
      a,
      owner: a.name === d.mainAi ? '（主 ai）' : (a.owner || '无主'),
      guessed: !!a.ownerGuessed
    })
  }
  if (!rows.length) {
    box.appendChild(h('p', { class: 'note' },
      '还没有 ai 记录：ai 启动后 ais.json 才会有内容（这里显示的是运行时注册表，不是配置文件）。'))
    return box
  }
  box.appendChild(h('p', { class: 'note preline' },
    '「谁能指挥」= ais.json 里的 obey 名单，空 = 所有人都能指挥它。改完**立即生效**（ai 每收到一条聊天都会重读）。\n' +
    '改名字只是改注册表 / 登记，正在跑的进程名字不会变，要它重连才生效。'))
  const t = h('table', { class: 'list' })
  t.appendChild(h('thead', {}, h('tr', {},
    h('th', {}, 'ai 名字'), h('th', {}, '归属'), h('th', {}, '谁能指挥（逗号分隔，空=所有人）'),
    h('th', { style: { width: '160px' } }, '操作')
  )))
  const tb = h('tbody')
  for (const row of rows) {
    const a = row.a
    const obeyInput = h('input', { type: 'text', value: (a.obey || []).join(','), placeholder: '空 = 所有人' })
    const ops = h('div', { class: 'btnbar', style: { margin: '0', gap: '6px' } })
    ops.appendChild(btn('保存权限', async () => {
      const r = await api('/api/' + feature.id + '/ai/obey', {
        method: 'POST',
        body: { name: a.name, obey: obeyInput.value }
      })
      toast(r.note, 'ok')
      await RELOAD(d.active)
    }, 'small primary'))
    ops.appendChild(btn('改名', async () => {
      const to = window.prompt('把 ai「' + a.name + '」改成什么名字？', a.name)
      if (to == null || to.trim() === a.name) return
      const r = await api('/api/' + feature.id + '/ai/rename', {
        method: 'POST',
        body: { from: a.name, to: to.trim() }
      })
      toast(r.note, 'ok')
      await RELOAD(d.active)
    }, 'small'))
    tb.appendChild(h('tr', {},
      h('td', {}, a.name + (a.alias ? '（' + a.alias + '）' : '') + (a.name === d.mainAi ? '（主）' : '')),
      h('td', { class: 'small' }, row.owner + (row.guessed ? '（按名字推断）' : '')),
      h('td', {}, obeyInput),
      h('td', {}, ops)
    ))
  }
  t.appendChild(tb)
  box.appendChild(t)
  return box
}

// ---------- 聊天监视（服主）----------
// 数据来源：ai 把收到的每条聊天追加到 日志/聊天.log（见 源码/bot.js 的 logChat），
//           面板 GET /api/config/chat 读最后 N 条。
// 用途：新召唤 / 新上线的 ai 说第一句话时，这里会显示「名字（属于 某人）」——
//       归属不对就去下面的「ai 一览」改名字 / 改听从名单。
function chatSection (ctx) {
  const { feature, d } = ctx
  const wrap = h('div', {})
  wrap.appendChild(h('div', { class: 'group-title' }, '聊天监视（记录每个 ai 的聊天）'))
  // R4/R5：服主能按 ai 过滤，并看到每个 ai 说了多少句、叫什么别名
  const aiSel = h('select', {})
  aiSel.appendChild(h('option', { value: '' }, '全部（玩家 + 所有 ai）'))
  const seen = new Set()
  for (const p of d.players || []) {
    for (const a of p.ais || []) {
      seen.add(a.name)
      aiSel.appendChild(h('option', { value: a.name },
        a.name + (a.alias ? '（' + a.alias + '）' : '') + ' · ' + p.name))
    }
  }
  for (const a of d.freeAis || []) {
    if (seen.has(a.name)) continue
    aiSel.appendChild(h('option', { value: a.name },
      a.name + (a.alias ? '（' + a.alias + '）' : '') + ' · ' + (a.owner || '无主')))
  }
  const list = h('div', { class: 'chatlog' })
  const stats = h('div', { class: 'note preline' })
  const meta = h('p', { class: 'note' })
  const pause = h('input', { type: 'checkbox' })
  const pauseWrap = h('label', { class: 'switch', style: { margin: '0' } }, pause, h('span', {}, '自动刷新（4 秒）'))
  let timer = null

  const fill = (r) => {
    list.innerHTML = ''
    if (r.missing) {
      list.appendChild(h('p', { class: 'muted small' },
        '还没有聊天记录：ai 收到聊天后才会写一行（' + (d.chatFile || '日志/聊天.log') + '）。'))
    } else if (!(r.entries || []).length) {
      list.appendChild(h('p', { class: 'muted small' },
        aiSel.value ? '这个 ai 还没有发过言。' : '这段时间没有聊天。'))
    } else {
      for (const e of r.entries) {
        const who = e.fromIsAi
          ? h('span', {}, e.from,
            e.alias ? h('span', { class: 'muted small' }, '（别名 ' + e.alias + '）') : null,
            e.aiOwner ? h('span', { class: 'muted small' }, '（属于 ' + e.aiOwner + '）') : null)
          : h('span', {}, e.from)
        list.appendChild(h('div', { class: 'chatline' + (e.fromIsAi ? ' from-ai' : '') },
          h('span', { class: 'chat-time' }, e.time || '—'),
          h('span', { class: 'chat-who' }, who),
          h('span', { class: 'chat-text' }, e.text)))
      }
    }
    // 每个 ai 的记录（R4）：说了几句 + 最后一句
    const by = (r.byAi || [])
    stats.textContent = by.length
      ? '每个 ai 的记录（共 ' + by.length + ' 个）：\n' + by.slice(0, 12).map((x) =>
        '· ' + x.name + (x.alias ? '（' + x.alias + '）' : '') +
        (x.owner ? ' → ' + x.owner : '') + '：' + x.count + ' 句，最后一句「' +
        String(x.last || '').slice(0, 40) + '」').join('\n')
      : ''
    meta.textContent = '共 ' + (r.total || 0) + ' 条记录，这里显示最后 ' + (r.entries || []).length +
      ' 条' + (aiSel.value ? '（只看 ' + aiSel.value + '）' : '') + '；文件：' + (r.file || '—')
  }
  const tick = async () => {
    try {
      const q = '/api/' + feature.id + '/chat?n=40' +
        (aiSel.value ? '&ai=' + encodeURIComponent(aiSel.value) : '')
      fill(await api(q))
    } catch (e) {
      list.innerHTML = ''
      list.appendChild(h('p', { class: 'muted small' }, '读不到聊天记录：' + e.message))
    }
  }
  aiSel.addEventListener('change', () => { tick() })
  tick()
  timer = setInterval(() => {
    // 页面切走了就别再轮询（custom 视图没有卸载钩子，只能自己看 isConnected）
    if (ctx.box && !ctx.box.isConnected) { clearInterval(timer); timer = null; return }
    if (!pause.checked) tick()
  }, 4000)

  const bar = h('div', { class: 'btnbar', style: { margin: '8px 0 0' } },
    h('span', { class: 'muted small' }, '只看：'), aiSel,
    btn('刷新', async () => { await tick() }, 'small'),
    pauseWrap)
  wrap.appendChild(list)
  wrap.appendChild(bar)
  wrap.appendChild(stats)
  wrap.appendChild(meta)
  wrap.appendChild(h('p', { class: 'note' },
    '「（别名 X）」来自玩家登记里给这个 ai 设的别名；「（属于 某人）」优先按 ais.json 的 owner，' +
    '没有就按名字前缀猜（' + (d.guestPrefix || 'way-') + 'alice → alice）。\n' +
    'ai 上线时会把别名报给主 ai（游戏里能看到「收到：way-alice 的别名是「小A」」），报的名字对不上会在日志里标 ⚠。'))
  return wrap
}

// ---------- 成员视角：我名下的 ai + 指挥白名单 ----------
// 改名单 / 改名都要带 owner（自己的游戏名），服务端会核对"这个 ai 是不是你的"。
function myAisSection (ctx, p) {
  const { feature, d } = ctx
  const box = h('div', {})
  const ais = p.ais || []
  box.appendChild(h('div', { class: 'group-title' }, '我的 ai 与指挥白名单（' + p.name + '）'))
  if (!ais.length) {
    box.appendChild(h('p', { class: 'note preline' },
      '你名下还没有 ai。进游戏后让主 ai 执行 summon 就有了（默认名字 ' +
      (p.defaultName || ((d.guestPrefix || 'way-') + p.name)) + '）。\n' +
      '有了之后再回到这个页面，就能设置"谁能指挥它"。'))
    return box
  }
  box.appendChild(h('p', { class: 'note preline' },
    '「谁能指挥」= 只有名单里的玩家能命令它，逗号分隔；**空 = 所有人都能指挥**。\n' +
    '改完立即生效（ai 每收到一条聊天都会重读 ais.json），不用重启。'))
  const t = h('table', { class: 'list' })
  t.appendChild(h('thead', {}, h('tr', {},
    h('th', {}, 'ai 名字'),
    h('th', {}, '谁能指挥（逗号分隔，空 = 所有人）'),
    h('th', { style: { width: '170px' } }, '操作')
  )))
  const tb = h('tbody')
  for (const a of ais) {
    const obeyInput = h('input', { type: 'text', value: (a.obey || []).join(','), placeholder: '空 = 所有人' })
    const ops = h('div', { class: 'btnbar', style: { margin: '0', gap: '6px' } })
    ops.appendChild(btn('保存名单', async () => {
      await post(feature, '/ai/obey', { name: a.name, obey: obeyInput.value, owner: p.name }, '已更新指挥名单')
    }, 'small primary'))
    ops.appendChild(btn('改名', async () => {
      const to = window.prompt('把你名下的 ai「' + a.name + '」改成什么名字？', a.name)
      if (to == null || to.trim() === a.name) return
      await post(feature, '/ai/rename', { from: a.name, to: to.trim(), owner: p.name }, '已改名')
    }, 'small'))
    tb.appendChild(h('tr', {},
      h('td', {}, a.name, ' ',
        a.pid ? h('span', { class: 'badge b-ok' }, '在跑')
          : h('span', { class: 'badge b-busy' }, '未启动')),
      h('td', {}, obeyInput),
      h('td', {}, ops)
    ))
  }
  t.appendChild(tb)
  box.appendChild(t)
  return box
}

// ---------- 非服主视角：服务器信息 + 自己的 ai + 指挥白名单 ----------
function memberView (ctx) {
  const { feature, d } = ctx
  const wrap = h('div', {})
  const listId = 'cfg-player-names'
  const datalist = h('datalist', { id: listId })
  for (const n of (d.playerNames || [])) datalist.appendChild(h('option', { value: n }))

  const nameInput = h('input', { type: 'text', list: listId, placeholder: '你的游戏名', value: MEMBER_NAME })
  const info = h('p', { class: 'note preline' })
  const fixedBox = h('div', {})
  const aliasInput = h('input', { type: 'text', placeholder: '例如：小A（2–16 位字母/数字/下划线/中文）' })
  const myBox = h('div', {})
  const chatBox = h('div', {})
  let me = null

  // 只在 /me 里查**自己**那条：成员页不下发别人的记录（R6）
  const loadMe = async () => {
    const name = nameInput.value.trim()
    MEMBER_NAME = name
    me = null
    fixedBox.innerHTML = ''
    myBox.innerHTML = ''
    chatBox.innerHTML = ''
    aliasInput.value = ''
    if (!name) { info.textContent = '填上你在游戏里的名字，面板会从登记里找出你的 ai。'; return }
    const r = await api('/api/' + feature.id + '/me?username=' + encodeURIComponent(name))
    if (!r.found) { info.textContent = r.note || '没有找到你的登记'; return }
    me = r.player
    fixedBox.appendChild(h('div', { class: 'field' },
      h('label', {}, '我的初始 ai（名字固定）'),
      h('input', { type: 'text', value: me.aiName || ('（还没生成，默认 ' + (r.guestPrefix || 'way-') + me.name + '）'), readonly: true }),
      h('span', { class: 'hint' }, '固定为「' + (r.guestPrefix || 'way-') + '玩家名」，不能改名；想换个叫法就用下面的别名')))
    aliasInput.value = me.alias || ''
    info.textContent = '找到你了：' + me.name + '，初始 ai 是「' + (me.aiName || '—') + '」' +
      (me.alias ? '（别名「' + me.alias + '」）' : '') + '。'
    myBox.appendChild(myAisSection(ctx, me))
    chatBox.appendChild(myChatSection(ctx, me))
  }
  nameInput.addEventListener('input', () => { MEMBER_NAME = nameInput.value.trim() })
  nameInput.addEventListener('change', () => { loadMe().catch((e) => toast(e.message, 'err')) })

  const v = d.values || {}
  wrap.appendChild(datalist)
  wrap.appendChild(h('p', { class: 'note' },
    '当前服务器：' + String(v['server.host'] || '—') + ':' + String(v['server.port'] || '—') +
    '（' + (d.active === d.applied ? '这一页已生效' : '还没应用到游戏') + '）· ' +
    'RCON ' + (v['rcon.enabled'] === false ? '关闭' : '开启')))
  // 我的连接：只有 server.* / rcon.* / behavior.* / building.*（ai.* 由服务端直接过滤掉，R6）
  wrap.appendChild(configForm(ctx))

  wrap.appendChild(h('div', { class: 'group-title' }, '我的初始 ai'))
  wrap.appendChild(h('div', { class: 'cards', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' } },
    h('div', { class: 'field' }, h('label', {}, '我的游戏名'), nameInput)))
  wrap.appendChild(info)
  wrap.appendChild(fixedBox)
  wrap.appendChild(h('div', { class: 'cards', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' } },
    h('div', { class: 'field' }, h('label', {}, '别名（游戏里用它也能指挥我的 ai）'), aliasInput)))
  wrap.appendChild(h('div', { class: 'formfoot' }, btn('保存别名', async () => {
    if (!me) throw new Error('先在上面填一个登记过的游戏名（进一次服务器就会自动登记）')
    const r = await api('/api/' + feature.id + '/player/alias', {
      method: 'POST',
      body: { id: d.active, username: me.name, alias: aliasInput.value.trim(), owner: me.name }
    })
    toast(r.note, 'ok')
    MEMBER_NAME = me.name
    await RELOAD(d.active)
  }, 'primary')))
  wrap.appendChild(myBox)
  wrap.appendChild(chatBox)
  wrap.appendChild(h('p', { class: 'note preline' },
    '规则：\n' +
    '· 初始 ai 的名字是**固定的**（' + (d.guestPrefix || 'way-') + '<你的游戏名>），不能改名；' +
    '想换个好叫的名字就设「别名」，游戏里「别名 build ...」和「全名 build ...」都行。\n' +
    '· 别名只在**你自己的 ai** 上生效，而且不能和别人的名字/别名撞。\n' +
    '· 「谁能指挥」只对你自己名下的 ai 生效；主 ai 和别人的 ai 由服主设置。\n' +
    '· 这里只显示你能设置的东西（连接 / 你的 ai）；服主的设置和其他玩家看不到。'))
  loadMe().catch(() => { /* 首次进页面时名字为空，忽略 */ })
  return wrap
}

// ---------- 成员：我的 ai 聊天（只看自己名下，R4/R6）----------
function myChatSection (ctx, me) {
  const { feature } = ctx
  const box = h('div', {})
  box.appendChild(h('div', { class: 'group-title' }, '我的 ai 聊天（最近 30 条）'))
  const list = h('div', { class: 'chatlog' })
  const meta = h('p', { class: 'note' })
  const fill = (r) => {
    list.innerHTML = ''
    if (r.missing || !(r.entries || []).length) {
      list.appendChild(h('p', { class: 'muted small' }, '还没有记录：你和你的 ai 说话后才会写进日志。'))
    } else {
      for (const e of r.entries) {
        const who = h('span', {}, e.from,
          e.alias ? h('span', { class: 'muted small' }, '（别名 ' + e.alias + '）') : null)
        list.appendChild(h('div', { class: 'chatline' + (e.fromIsAi ? ' from-ai' : '') },
          h('span', { class: 'chat-time' }, e.time || '—'),
          h('span', { class: 'chat-who' }, who),
          h('span', { class: 'chat-text' }, e.text)))
      }
    }
    meta.textContent = '只显示你（' + me.name + '）和你名下 ai 的聊天；共 ' + (r.total || 0) + ' 条日志。'
  }
  const tick = async () => {
    try {
      fill(await api('/api/' + feature.id + '/chat?n=30&owner=' + encodeURIComponent(me.name)))
    } catch (e) {
      list.innerHTML = ''
      list.appendChild(h('p', { class: 'muted small' }, '读不到聊天记录：' + e.message))
    }
  }
  tick()
  box.appendChild(list)
  box.appendChild(h('div', { class: 'btnbar', style: { margin: '8px 0 0' } },
    btn('刷新', async () => { await tick() }, 'small')))
  box.appendChild(meta)
  return box
}

// ---------- 页脚：文件位置 / 当前生效配置 / 告警 ----------
function footNotes (d) {
  const box = h('div', { class: 'cfgfoot' })
  box.appendChild(h('p', { class: 'note preline' },
    '当前生效（config.json）：' + (d.effective || '—') + '\n' +
    'config.json：' + d.file + '\n' +
    '分页档案：' + d.profileFile + '\n' +
    '玩家登记：' + d.registryFile))
  if (d.warnings && d.warnings.length) {
    const ul = h('ul', { class: 'warns' })
    for (const w of d.warnings) ul.appendChild(h('li', {}, w))
    box.appendChild(ul)
  }
  return box
}



// ---------- 配置表单（服主 / 成员共用）----------
// 成员视角不是"只能改个名字"：地址 / 端口 / 登录方式 / RCON / ai 名字 / 前缀 / 指令白名单 /
// 行为 / 默认建筑 **全部能改**（2026-11-01 用户反馈：选了成员就改不了服务器信息，太受限）。
// 只有 `field.ownerOnly` 的那几项（服主游戏名 / op 策略 / op 名单）在成员视角里是只读的，
// 因为那些决定"这台服务器归谁管"；服务端 POST /save 对它们也会回 403。
function configForm (ctx) {
  const { feature, d } = ctx
  const isMember = d.view === 'member'
  const box = h('div', {})
  const inputs = new Map()
  for (const g of d.groups || []) {
    const perProfile = (g.fields || []).some((f) => isProfileKey(f.key))
    box.appendChild(h('div', { class: 'group-title' },
      g.name + (perProfile ? '' : '（全局，所有分页共用）')))
    const grid = h('div', { class: 'cards', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' } })
    for (const f of g.fields) {
      const made = fieldEl(f, d.values ? d.values[f.key] : undefined)
      if (isMember && f.ownerOnly) {
        made.input.disabled = true
        if (made.wrap.classList) made.wrap.classList.add('owner-only')
        made.wrap.appendChild(h('span', { class: 'hint' }, '服主专用：成员视角只读（要改请让服主来）'))
      }
      inputs.set(f.key, made.input)
      grid.appendChild(made.wrap)
    }
    box.appendChild(grid)
  }

  const foot = h('div', { class: 'formfoot' })
  const saveBtn = h('button', { class: 'primary' }, '保存到分页「' + activeLabel(d) + '」')
  const resetSave = () => { saveBtn.disabled = false; saveBtn.textContent = '保存到分页「' + activeLabel(d) + '」' }
  saveBtn.addEventListener('click', async () => {
    const values = {}
    for (const f of d.fields || []) {
      const input = inputs.get(f.key)
      if (!input || input.disabled) continue // 服主专用项不提交
      values[f.key] = f.type === 'switch' ? !!input.checked : input.value
    }
    saveBtn.disabled = true
    saveBtn.textContent = '保存中…'
    try {
      const r = await api('/api/' + feature.id + '/save', { method: 'POST', body: { id: d.active, values } })
      toast(r.note || ('已保存 ' + r.saved + ' 项'), 'ok')
      await RELOAD(d.active)
    } catch (e) {
      toast(e.message, 'err')
      resetSave()
    }
  })
  foot.appendChild(saveBtn)
  foot.appendChild(btn('探测端口', async () => {
    const host = inputs.get('server.host')
    const port = inputs.get('server.port')
    const r = await api('/api/' + feature.id + '/probe', {
      method: 'POST',
      body: { host: host ? host.value : '', port: port ? port.value : '' }
    })
    toast((r.ok ? '✔ ' : '✘ ') + r.note, r.ok ? 'ok' : 'err')
  }))
  box.appendChild(foot)
  box.appendChild(h('p', { class: 'note' },
    '只改上面列出的字段，config.json 里的其它内容原样保留。' +
    '保存后要**重启 ai** 才生效；改了服务器地址 / 端口还要重启服务器（本机服的话）。' +
    (isMember ? '\n灰掉的几项是服主专用的：服主游戏名（决定谁是服主）、自动 op 策略、op 白名单。' : '')))
  return box
}

// ---------- 服主视角 ----------
function ownerView (ctx) {
  const { d } = ctx
  const wrap = h('div', {})
  if (d.appliedMismatch) {
    wrap.appendChild(h('div', { class: 'warnbar' },
      '你现在看的是「' + activeLabel(d) + '」，但游戏正在用的是「' + d.appliedLabel + '」。\n' +
      '在这里改只会改动**这个分页**；要让它生效请点右上「应用到游戏」，然后重启 ai。'))
  }

  wrap.appendChild(configForm(ctx))
  wrap.appendChild(playerSection(ctx))
  wrap.appendChild(chatSection(ctx))
  wrap.appendChild(aiSection(ctx))
  return wrap
}

// ---------- 成员视角：配置表单 + 我的初始 ai + 我的 ai 与指挥白名单 ----------