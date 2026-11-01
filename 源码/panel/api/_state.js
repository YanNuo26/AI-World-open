// ===== 面板运行期状态（源码/panel/api/_state.js）=====
// 为什么单独一个文件：面板支持"热重载功能模块"（POST /api/_panel/reload），
// 重载时只清掉**功能模块**的 require 缓存；以下划线开头的文件不清，
// 所以进程 / 输出缓冲这些**运行期状态**在这里，重载后不会丢（否则会丢子进程句柄）。
const state = {
  // 面板自己拉起来的子进程：{ child, pid, startedAt, label, logFile }
  procs: { server: null, ai: null },
  // 子进程输出的环形缓冲（前端 /output 增量拉取用）
  lines: { server: [], ai: [] },
  // 每个目标"已经被前端读到的行号"，由前端传 since，这里只做上限保护
  MAX_LINES: 1200,
  // 面板启动时刻（概览显示运行时长）
  startedAt: Date.now()
}

// 追加一行输出，超出上限就丢最老的
function pushLine (target, text) {
  const arr = state.lines[target]
  if (!arr) return
  arr.push(text)
  if (arr.length > state.MAX_LINES) arr.splice(0, arr.length - state.MAX_LINES)
}

// 清空输出（重新启动某个进程时调用）
function clearLines (target) {
  state.lines[target] = []
}

module.exports = { state, pushLine, clearLines }
