# AI-World（开源测试版 v1.1.0）

Minecraft **1.21.1** 建造机器人 + 本地控制面板。
用 [mineflayer](https://github.com/PrismarineJS/mineflayer) 以玩家身份连进创造服，听聊天指令搭建筑、
录教学并复现、处理红石、召唤多个 ai；另带一个零依赖的 Web 面板和自动化测试。

> 术语：**AI** = 参与开发这个项目的编码助手；**ai** = 游戏里的机器人玩家（默认名 `world`）。

## 一、下载安装（小白看这里，不用装任何环境）

### 方式 1：exe 安装包（推荐）

👉 **[点这里下载最新版](https://github.com/YanNuo26/AI-World-open/releases/latest)** → 选 `AI-World-*-安装包.exe`

1. 双击下载的 exe
2. **选安装位置**（默认 `%LOCALAPPDATA%\Programs\AI-World`，不需要管理员权限；想放 D 盘就点「浏览」）
3. 勾上「创建桌面快捷方式」→ 点「安装」
4. 装完双击桌面的 **AI-World** 图标 → 浏览器自动打开面板

- 卸载：Windows「设置 → 应用 → AI-World」，或安装目录里的 `卸载.bat`
- 安装包**自带 Node 运行时**，目标机器什么都不用装

### 方式 2：绿色包（不想装东西）

在 [Releases](https://github.com/YanNuo26/AI-World-open/releases/latest) 里下载 `.zip`，解压后双击 **`启动面板(无窗口).vbs`**（不弹黑框；关掉浏览器 60 秒后面板自动退出）。

> 两种方式都**没有** `server.jar`（版权 + 体积）。要本机开服自己下 1.21.1 服务端放进 `服务器\`，并装 **Java 21**；
> 连别人的服/远程服则完全不需要 Java。

### 装好之后

1. 面板「连接与权限」里填服务器地址 / 端口 / RCON 密码 → 点「应用到游戏」
2. 面板「启动 / 停止」里点「启动 ai」
3. 游戏里对它说话：`world build`（指令都要带 ai 名字前缀）

## 二、从源码跑

```powershell
npm install
powershell -ExecutionPolicy Bypass -File 脚本\start_server.ps1   # 起本机服务器（改配置要重启）
node 源码\bot.js                                                 # 起 ai（默认名 world）
node 源码\panel\server.js                                        # 控制面板 → http://127.0.0.1:8787/
```

自动打包成绿色软件（就是上面那个 zip）：

```powershell
powershell -ExecutionPolicy Bypass -File 脚本\打包.ps1
#   -NoRuntime 不塞 node.exe（包小 ~90MB，目标机得自己装 Node 18+）
#   -NoPrune   不裁剪依赖（minecraft-data 的 bedrock 数据多占 ~330MB）
```

产物在 `发布\`：目录 + 同名 zip + `发布说明.md`。

## 三、目录

| 目录 | 作用 |
|---|---|
| `源码/` | `bot.js` 连接与指令路由、`build.js` 建造、`movement.js` 移动/朝向、`rcon.js`、`access.js` 权限、`玩家登记.js` |
| `源码/panel/` | 本地控制面板（`server.js` + `api/` 接口 + `web/` 前端），**只监听 127.0.0.1** |
| `测试/` | 单用例 + `夜间回归.js`（自动起服 / 超时强杀 / 出报告）+ `守门.js`（静态检查） |
| `脚本/` | 一键启服务器 / 启面板 / 夜间回归 / 打包 |
| `文档/` | `使用说明.md`（游戏内怎么玩）、`AI参考.md`（踩过的坑，**开发前必读**）、`架构与规划.md`、`文件结构.md` |

## 四、这一版测过什么

- `node 测试/test_panel.js`：**133 项通过 / 0 失败**（面板接口、权限、视角隔离、聊天监视）
- `node 测试/守门.js`：静态检查 0 问题（语法 / 指令前缀 / require 路径）
- `test_mark2`（干净存档）：PASS
- **跨机联机**：另一台 Windows 通过 SSH 反向隧道连本机服务器，包内 ai 成功进服并正常发言
  （`pc02 joined the game`）。实测本机与远程行为一致。

## 五、已知限制

- 只支持 **Minecraft Java 1.21.1**（`config.json` 的 `server.version` 决定，数据随包提供）
- 日志里可能出现 `PartialReadError ... ArmorTrimMaterial`：这是 mineflayer 对当前服务端 registry 的
  **解析差异，不影响进服和使用**（本机未裁剪依赖也一样）
- 面板只监听 `127.0.0.1`，不能从别的机器直接打开
- 打包脚本不签名，Windows 首次运行可能提示"未知发布者"
- 只是**第一个测试版**，接口/配置项还可能改

## 六、许可

尚未选定开源许可证（默认保留所有权利）。要二次分发/商用请先联系仓库作者。
