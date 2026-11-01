// ===== 测试公共配置（测试/_common.js）=====
// 所有测试都从这里拿连接信息，**禁止再写死** localhost / 25565 / 1.21.1：
// 改 config.json 一处，ai 和测试一起跟着变（之前换版本要改 26 个文件）。
const cfg = require('../源码/config').load()

// ===== 指令前缀（测试里最容易踩的坑）=====
// 游戏内**所有**指令都必须带 ai 名字前缀（AGENTS.md 约定 5）：
//   玩家聊天里出现 "build" / "stop" 这种词不该被当成指令，所以 bot.js 一律要求 "world build ..."。
// 测试里别忘了：player.chat(cmd(AI_NAME, 'build ' + NAME)) —— 少写前缀，ai 会当成普通聊天**一声不吭**，
// 表现出来就是"功能坏了"（2026-10-31 夜间回归里 10 个测试就是这么假失败的）。
function cmd (aiName, text) {
  return String(aiName) + ' ' + String(text)
}

module.exports = {
  // 连接信息（来自 config.json 的 server 段）
  HOST: cfg.server.host,
  PORT: cfg.server.port,
  // version 写 'auto' 表示交给 mineflayer 自动探测 -> 传 undefined
  VERSION: cfg.server.version === 'auto' ? undefined : cfg.server.version,
  // 主 ai 的默认名字（大多数测试自己 spawn 时会用 MC_USER 覆盖）
  AI_NAME: cfg.ai.name,
  CONFIG: cfg,
  cmd
}

