// ===== 面板自己的设置（源码/panel/api/_settings.js）=====
// 为什么单独存一份、不塞进 config.json：
//   config.json 是**游戏里的 ai** 的配置（连哪个服 / 谁是服主 / 建筑参数），
//   而这里存的是"这台电脑上的面板"自己的开关（比如性能检测开没开）。
//   用户换服务器 / 换 config.json 时不该把这些开关一起带走。
//
// 文件：配置/面板设置.json（配置/ 已进 .gitignore，属于本机运行期数据）
//   { "perf.enabled": true }
//
// 读一次就缓存，每次写都整份覆盖（文件极小，不怕并发；坏 JSON 当空处理，绝不抛异常）。
// 注意：本文件以 _ 开头 → 面板"热重载功能模块"不会重载它，所以缓存能一直用。
const fs = require('fs')
const path = require('path')
const U = require('./_util')

const FILE = path.join(U.ROOT, '配置', '面板设置.json')

let cache = null

function all () {
  if (cache) return cache
  const raw = U.readJsonFile(FILE, {})
  cache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  return cache
}

function get (key, def) {
  const v = all()[key]
  return v === undefined ? def : v
}

// 写一个键（value === undefined 表示删掉它）
function set (key, value) {
  const db = Object.assign({}, all())
  if (value === undefined) delete db[key]
  else db[key] = value
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }) } catch (e) { /* ignore */ }
  U.writeJsonFile(FILE, db)
  cache = db
  return db
}

// 丢掉缓存重新读（测试 / 手工改了文件之后用）
function reload () {
  cache = null
  return all()
}

module.exports = { FILE, all, get, set, reload }
