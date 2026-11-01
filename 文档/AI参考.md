# AI 助手参考 — Minecraft AI 建造助手项目

> 面向后续接手本项目的 AI/开发者。记录架构、关键实现、以及**踩过的坑**（这些坑不看代码很难发现，改代码前务必先读）。

> ## 术语约定
> - **AI**（大写）= **开发用的 AI**（编码助手 / agent，读这份文档的你）。
> - **ai**（小写）= **游戏里的 AI 机器人**（进服当玩家的 bot，默认名 `world`）。
>
> 同一篇文档里两者都会出现，靠大小写区分；"ai / AI 机器人 / bot" 指游戏内那个。
> 更完整的协作约定见 `AGENTS.md`。

---

## 一、项目结构

| 文件 | 作用 |
| --- | --- |
| `源码/bot.js` | 主程序：mineflayer 机器人、连接/重连、聊天指令、保存/加载流程（移动一律调 `movement.js`） |
| `源码/movement.js` | **移动模块**：所有移动统一 xyz —— 水平"看方向+W 键"、y 轴推进、**避障逻辑**、A* 兜底、建造落位（详见第五节） |
| `源码/build.js` | 建造引擎：方块清单生成、排序、放置逻辑、平滑石头辅助支撑、蓝图读写 |
| `源码/rcon.js` | 极简 RCON：op / `/give` / `/tp` |
| `源码/config.js` | **统一配置入口**：读 `config.json`、深合并默认值、旧格式迁移、环境变量覆盖、命令行参数（`parseArgs`） |
| `源码/access.js` | **准入与失败诊断**（纯逻辑）：自动 op 策略 `canOp`、谁能指挥 `canCommand`、连不上/被踢的原因 `diagnose` |
| `源码/logger.js` | **日志**：把 console 输出同时写进 `日志/ai_<名字>.log` |
| `config.json` | 全部可配置项（server / rcon / ai / behavior / building） |
| `脚本/run.ps1` / `脚本/启动.bat` | 一键启动：起服务器 → 等世界 → 起 AI → 退出时关服务器 |
| `服务器/server.jar` + `server-version.txt` | 锁定的 Minecraft **1.21.1** 服务端 |
| `蓝图/*.json` | 保存的蓝图（相对坐标 + 方块名） |
| `教学/*.json` | 教学模式录制的**过程**记录（事件序列：move / place / use） |
| `服务器/server.properties` / `eula.txt` / `flat_initialized.txt` | 服务器配置；`flat_initialized.txt` 存在表示超平坦世界已初始化过 |

运行时：本地服务器 `localhost:25565`，`online-mode=false`，`gamemode=creative`，`level-type=flat`。
连接信息**全部**来自 `config.json`（代码里不再写死端口/版本）。

---

## 二、聊天指令 → 代码路径

| 指令 | 处理 |
| --- | --- |
| `build` | `handleBuild` → `goTo(用户位置)` → `build(bot, config)` |
| `build <名字>` | 同上，但 `buildFromBlueprint(bot, bp, 位置)` |
| `build <x> <y> <z>` | `moveTo(x,y,z)` → `build({ origin: {x,y,z} })`，在**指定高度**开工（悬空则用平滑石头辅助，见坑 14）。兼容旧的 `build <x> <z>`（取当前高度） |
| `save <名字>` | 进入 `saveMode`，监听 `blockUpdate` 收集两个标记（gold_block / diamond_block） |
| `teach <名字>` | 进入 `teachMode`：采样玩家移动 + 监听 `blockUpdate`（放置）与 `entitySwingArm`（右键交互），按时间顺序写入 `events` |
| `teach stop` | `stopTeaching()` 保存 `teachings/<名字>.json`；`build <名字>` 时若存在同名教学则 `replayTeaching()` 按序复现 |
| `del` / `delete` / `remove` <名字> | `deleteSaved()` 删除 `blueprints/<名字>.json` 与 `teachings/<名字>.json`（同名一起删），返回被删种类 |
| `list` | `listBlueprints()` |
| `tpto` / `tp` | 传送到玩家；`tpto <x> <y> <z>` 传送到坐标；`tpto me` 启动跟随（保持玩家 5 格内） |
| `stop` / `cancel` | 紧急停止并重置：取消跟随、释放控制状态、停止 pathfinder、置 `bot._aiAbort` 中止正在进行的建造，并清空 saveMode |

---

## 三、建造引擎（`build.js`）关键函数

```
findGroundY(bot,x,y,z)   向下扫描最多128格找实心地面 → gy
planHouse/Tower/Pyramid  生成方块清单 [{x,y,z,name}]
orderByProximity(start,blocks)  排序
placeBlocks(bot,blocks,label)   逐个放置（含超时+二轮重试）
  └ ensureReach(bot,x,y,z)      距离>MAX_REACH(4) 则飞到附近
  └ equipBlock(bot,name)        切换手持方块
  └ placeAt(bot,x,y,z)          tryPlace 失败则移位重试最多6次
       └ tryPlace(bot,x,y,z)    依次尝试6个相邻面作为依附面
```

### 排序规则（重要，曾踩坑）
`orderByProximity` = **先按 y 分层升序**（低层先建，保证每格下方有支撑），**层内再用最近邻贪心**，且跨层时接着上一层结束位置继续。

> 曾经用"纯三维最近邻"排序，结果 bot 爬高后会把**高层排在底层支撑之前**，导致大量方块因找不到依附面而失败、每次失败还要飞 6 次重试 → 建造从 26 秒劣化到 150 秒超时。**不要改回纯最近邻。**

实测（9×9 房子 261 格）：平均相邻跨度 **1.04**，需飞行的大跨度仅 **2 处**，低层先于高层 = true。

---

## 四、必须知道的坑（改代码前必读）

### 坑 1：`Movements.canFly` 在本版本**不存在**
本机安装的 `mineflayer-pathfinder` 的 `Movements` 类里没有 `canFly` 字段。创造飞行的正确开关是：

```js
movements.allowFreeMotion = true   // 而不是 canFly
```

原代码写的 `movements.canFly = true` 是**完全无效的空设置** —— bot 根本不会爬升，这正是"寻路卡住"的根因之一。

### 坑 2：`canDig` 默认为 `true`
`Movements` 构造里 `this.canDig = true`，意味着寻路时**会挖掉挡路的方块**。这就是"AI 走过去把玩家建筑挖坏"的真正原因。**务必显式设置：**

```js
movements.canDig = false
```

### 坑 3：超平坦世界的地面不在 y=64
现代版（1.18+）经典超平坦建在**世界底部**：草地表层约 **y = -61**，玩家站在 y ≈ -60。
曾把 `build <x> <z>` 的目标高度硬编码成 `y=64`，导致 bot 垂直爬升 125 格再建造，极慢且容易出错。**已改为保持 bot 当前高度水平移动，由 `findGroundY` 探测真实地面。**

### 坑 4：出生位置可能在半空
`spawn` 事件时 `bot.entity.position.y` 可能尚未落地（在下落中）。用 `pos.y - 1` 当地面会把整栋建筑抬到空中、下方是空气 → **没有依附面 → 大面积放置失败**。必须用 `findGroundY` 向下扫描。

### 坑 5：`bot.placeBlock` 可能永久挂起
若服务器不确认放置，promise 永不 settle，会**卡死整个建造**。已为每个方块加 **8 秒超时保护**（`withTimeout`），超时则跳过并在最后统一重试一次。

### 坑 6：`pathfinder.goto()` 被 `stop()` 后 promise 可能永不 settle
所以寻路**不要**用 `await goto()`，改用 `setGoal(goal, true)`（dynamic）+ 自己的看门狗循环，用 `setGoal(null)` 停止。

### 坑 7：创造模式物品栏写入
不要直接用 `bot.creative.setInventorySlot`：它内部的 "pending slot" 守卫在服务端 inventory-ack 包被协议解析错误（`PartialReadError`）丢弃时会**永久卡住**，之后每次换材质都抛 `Setting slot ... cancelled`。
正确做法（见 `equipBlock`）：直接写包

```js
bot._client.write('set_creative_slot', { slot: 36, item: PItem.toNotch(stack) })
bot._setSlot(36, stack)
bot.setQuickBarSlot(0)
```

### 坑 8：`placeBlock()` 会强制 `lookAt()`，破坏方向性方块的朝向
`bot.placeBlock()` → `_genericPlace()` 里有：

```js
if (options.forceLook !== 'ignore') {
  await bot.lookAt(referenceBlock.position.offset(dx, dy, dz), options.forceLook)
}
```

它会把视线强制对准被点击的那一面。我们的 bot 悬在目标正上方、以"下方方块顶面"为参照放置 → **视线变成垂直向下** → 活塞/观察者/发射器/楼梯等**朝向全部变成上或下**。

修法（`build.js` 的 `placeWithFacing`）：

1. 放置前**把 bot 移动到方块正确的一侧**，再 `await bot.lookAt(方块中心, true)`
2. 用 `bot._placeBlockWithOptions(ref, faceVec, { swingArm: 'right', forceLook: 'ignore' })` 放置（mineflayer 暴露了这个内部 API，`forceLook:'ignore'` 让 mineflayer 不要替我们 `lookAt`、破坏朝向）
3. 放置后**轮询回读**方块（`readFacing` 解码 block state，连读最多 6 tick 等服务器 block_change 到达），朝向不对就挖掉重放

**朝向解码**：`meta = stateId - minStateId`，属性按"第一个属性最高位、布尔值顺序为 true,false"枚举。对活塞即 `meta = 6 + facingIdx`（已放置活塞 `extended=false` 是布尔第二个值），`facing` 取值序 `[north,east,south,west,up,down]` —— 由"上/下"锚点验证成立。

**关键前提：朝向由"bot 站在哪一侧"决定，不靠 yaw 表。** 服务器用"视线射线是否命中目标方块"来校验并推导 facing。想让方块朝 F，bot 必须站在 **-F 侧**（即 `FACING_VEC` 取反的方向）朝方块看；站在 +F 侧会得到相反朝向。站错边/够不到时服务器直接拒绝（`Server refused to place`），只调 yaw 不移动没用——这正是"某些特定朝向总是失败"的原因。

`placeWithFacing` 当前策略（**水平朝向**）：

1. 目标方块中心 `center`，朝向向量 `v = FACING_VEC[facing]`。
2. 站位高度 `floorY = y`（**与方块同层**，创造模式关重力后 bot 悬浮于此；eye 约在方块中心上方 1.6 格，从 2 格外水平看过去，视线近似水平 → facing 一定是 N/S/E/W，绝不会变上/下）。早期写成 `y-1`（踩在下方的实心方块里）会被碰撞顶上来、变成俯视，活塞就朝上了——这是旧 bug 根因。
3. **先试 +F 侧**（`center + v × 2.0`，**正确朝向**），`navigateTo` 过去 → `lookAt(center)` → 放置。
4. **失败才试 -F 侧**（`center - v × 2.0`，兜底；这侧会得到**相反**的朝向，需要挖掉重放）。
5. 来回最多 4 轮。
6. **已经站在 +F 侧就不重新站位**（`stayOk`）：每放一块都飞到固定点位会明显打断流程。
   判据是"在 +F 侧"**且**距离合适（水平 1.2~4.5 格、高度差 <1.5 格）——
   贴太近视线会过陡、反而放不进去，所以必须带距离约束（只判断方向会**变慢**，实测过）。

> !! 站位方向以前写反过 !!
> 服务器算朝向用的是 `facing = 视线方向的反方向`，也就是"**方块朝向玩家**"：
> 想让方块朝 F，bot 必须站在 **+F 侧**（`FACING_VEC` 所指的那一侧）回头看它。
> 站在 -F 侧会得到相反朝向。原先代码把 -F 当 correct 先试，于是每个方向性方块都要
> "放错 → 挖掉 → 再放一次"，实测 83 格的建造从 **41s 拖到 ~91s**；
> 改回 +F 优先后，全部方块**第 0 次尝试就成功**（日志里不再出现 attempt 1/2/3）。

> 垂直朝向（up/down）不做水平移动，直接看天/看地（`bot.look(0, ±90°)`），实测可靠；只有水平朝向才走前后两侧。

> 注：`navigateTo` 不再用 `pathfinder`（A* 在创造模式坑多、慢），而是**分步直接改写 `bot.entity.position`**（每 0.5 格一步，正是 `creative.flyTo` 内部做法），但**不 `await` 服务器回的 `move` 包**——玩家自己的实体永不回传 `move`，那个 `await` 会永久挂起，导致每块都卡满超时。物理 tick 仍会把新坐标流给服务器，放置射线需要的就是它。

两个易错点：
- `_placeBlockWithOptions` 被拒绝时会**抛异常**，必须 try/catch，否则重试循环根本不会执行
- `placeWithFacing` 返回布尔值，**只有真正放好才计数**（否则会把被拒绝的方块算进"已放置"）

### 坑 9：`bot.creative.flyTo` 会直接改写坐标，且结尾可能永久挂起
mineflayer 的实现是**每 50ms 把 `bot.entity.position` 朝目标推进 0.5 格**（不走物理、无视碰撞），结尾是：

```js
bot.entity.position = destination
await once(bot, 'move', /* no timeout */ 0)   // 超时为 0 = 无限等待！
```

若位置没有实际变化（已经在目标点、或被服务器纠正），`move` 事件不触发 → **永久挂起**。所以：
- 不要裸用 `flyTo` 做长距离导航（要么包 `withTimeout`，要么像 `flyStraight` 那样自己实现可控推进）
- 现有 `flyToPoint`（保存扫描用）已加 20 秒超时保护

### 坑 10：紫颂果在创造模式下可食用
mineflayer 的 `bot.consume()` 有饱食度检查，但**创造模式会跳过**：

```js
if (bot.game.gameMode !== 'creative' && !ALWAYS_CONSUMABLES.includes(...) && bot.food === 20) throw 'Food is full'
```

所以"卡住 10 秒吃紫颂果传送脱困"可行。

### 坑 11：直接改写 `bot.entity.position` 做传送，单包大跳变会被服务器拒绝
`minecraft-js` 里"客户端位置"是服务器信任的——但服务器**逐包校验相邻两包的位置增量**。若一次性把 `bot.entity.position` 从 A 设到相距几十格的 B（类似 `/tp`），这一包的相对位移过大，服务器会判定非法并**把玩家弹回原位**，于是"传送到坐标/跟随"看起来完全没动。

修法（`bot.js` 的 `teleportTo` / `stepPosition` / `startFollow`）：**分步推进**，每 ~1 格一步（正是 `creative.flyTo` 的内部做法，也和 `navigateTo` 一致）。每一步都是合法的小增量，服务器照单全收，AI 就真的飞过去了。几百格的远距离传送会花几秒，属正常。

> 这也是建造 `navigateTo` 当年从 `flyTo`（结尾 `await once('move')` 永久挂起，见坑 9）改成"分步改写 + 不 await 服务器回包"的原因——同一套机制既修了挂起，又修了传送无效。

### 坑 17：`_aiAbort` 是一次性信号，**新任务开头必须清掉**，否则 stop 之后 AI 全面失灵

`stop` 会置 `bot._aiAbort = true` 来中止正在进行的建造。但下面这些地方开头都会先看它：

```
movement.js: moveHorizontal / moveVertical / pathfindXYZ -> 直接 return false
movement.js: navigateTo                                  -> throw AI_ABORT
bot.js:      startFollow 循环                            -> break
```

也就是说**只要这个标志还是 true，AI 的所有移动都会静默失败**——不报错、不移动，
表现为"用完 stop 之后 AI 就再也听不懂指令了"（tpto 不动、跟随不跟、build 在原地开工）。

而之前它只在 `build()` / `buildFromBlueprint()` / `replayTeaching()` **内部**被重置，
但 `handleBuild` 是先 `goTo()` 赶路、再调 `build()`——赶路那一段依旧被挡住。

修法：新增 `beginTask(bot)`（只做 `bot._aiAbort = false`），在每个**用户发起的新任务**开头调用：

- `handleBuild()` 开头（赶路之前）
- `tpto` 分支（传送/跟随之前）
- `startFollow()` 开头

> 同理，`cleanupAssists()` 里也要临时解除该标志再清理，否则 stop 之后
> 辅助方块因为"导航被中止"而永远拆不掉（见坑 14）。

### 坑 18：`entity.pitch` **正值向上**，射线公式写反符号就永远打不到目标

mineflayer 里 `bot.entity.yaw / pitch` 的约定（和 `bot.look()` 的参数符号**相反**）：

```js
// 已知：yaw = atan2(-dx, -dz)  （test_move 实测与位移方向 100% 对齐）
dx = -Math.sin(yaw) * Math.cos(pitch)
dy =  Math.sin(pitch)          // ← 正值向上！不是 -sin(pitch)
dz = -Math.cos(yaw) * Math.cos(pitch)
```

实测锚点：玩家站在地上、看脚下方块时 `pitch ≈ -0.51`（`atan2(-1.12, 2)`）。
之前教学录制里写成 `dy = -sin(pitch)`，射线朝上飞，**永远打不到脚下的方块**，
于是 `use` 事件的目标恒为 `null`，复现时右键完全失效。

> 另外 `bot.look(yaw, pitch)` 收的是**角度**且符号相反（上 = -90），
> 见 `FACING_PITCH = { up: -90, down: 90 }`——两套符号别混用。

### 坑 19：布尔型方块状态 **0 = true**

方块状态按"布尔值顺序 true,false"枚举，所以解码出来的数值是**反的**：

| 状态 | 解码值 | 实际含义 |
| --- | --- | --- |
| `lever.powered` | `0` | **true**（已打开） |
| `lever.powered` | `1` | false（关闭） |
| `piston.extended` | `1` | false（`extended=false`，见坑 8） |

`readStateValue()` 早期对非枚举一律返回 `null`，导致根本读不到 `powered`（int2）这类状态，
现已改为返回数值。

### 坑 20：教学复现的两个细节（路线 / 右键）

**路线**：不能用 `moveTo` 复现移动——它是"先走完水平、再统一调高度"的 L 形轨迹，
和玩家边走边升降的路线对不上（实测偏离 12 格）。改用 **`moveToSmooth`**：
分段同步推进（每段水平最多 1.5 格 + 按同比例推进高度），水平仍然是 W 键，
实测偏离降到 ~1.3 格。采样也要够密（200ms / 0.5 格），否则两点之间直接连直线。

**右键**：
- 不要还原记录的绝对 yaw/pitch，而是 `lookAt(目标方块中心)` 再 `activateBlock`——更可靠；
- 必须包 `withTimeout`，一次卡住整段复现就废了；
- **放方块时客户端也会挥臂**，服务器同样广播，于是同一动作被记成 `place` + `use` 两条，
  复现时会多右键一次（拉杆被多切一下、状态正好切回去）。
  过滤要在**保存时按时间戳**做（`dropPlaceSwings`，±700ms），
  不能在收到挥臂时即时过滤——挥臂包可能比 `blockUpdate` 先到，那时还不知道刚放了方块。

### 坑 21：教学录制的三个陷阱（串连 / 区块加载污染 / 活塞中途纠正）

**(a) 连续录制会被串连** —— `startTeaching` 直接覆盖 `teachMode` 却没清掉上一段的
`setInterval` 定时器。旧定时器的闭包持有**上一段**的 `origin`，却往**新**的 `events`
里继续塞数据，于是两段录制混在一起、坐标全乱。
修法：`startTeaching` 开头先 `if (teachMode) stopTeaching()`。

**(b) 区块加载会污染录制** —— `bot.on('blockUpdate')` 在**区块加载时也会触发**
（世界自带的方块"出现"了，`oldBlock` 多为 null）。原来的判断
`!oldBlock || oldBlock.name === 'air'` 会把整片地形全记成"玩家放置的"：
实测一次录制混进 **116 个 `iron_block`**（坐标散落在几十格外），
复现时 AI 会试图把上百个方块重新放一遍。
修法：额外要求**之前确实是空气** 且 **就在玩家 5 格以内**（手够得到才算他放的）。

**(e) 检查点要能查出"可交互方块状态被改"** —— 以前快照只记 `name/facing/wire`，
拉杆/中继器/比较器被右键改了**状态**（`powered`/`delay`/`mode`）时，名字朝向都没变，
检查点完全查不出来。现在：
- 快照用 `readBlockStates(bot, block)` 记下**全部状态**（`block.getProperties()`）。
- `checkCheckpoint` 用 `statesEqual` 比对：只有状态不对时**不挖了重放**，
  而是右键切回去（最多 3 次，右键前同样停 0.1s 防误触）。
- 实测：拉杆 `powered` 被改成 true 后，检查点识别为
  `状态不对…实际 {"powered":true…} -> 右键切回`，修正后恢复 `powered:false`。

**(d) 教学默认没有检查点** —— 只有玩家显式输入 `teach ckpd` 才会产生 `ckpd` 事件，
默认录制里 `ckpd` 数量为 0（已实测）。检查点快照由 `buildCheckpointSnapshot()` 生成：
按 `(dx,dy,dz)` 去重、**同一格取最后一次**放置的属性，字段包括
`name / facing / face / wire`，记录值与实际方块状态逐项一致（已实测）；
检查点**之后**放置的方块不会混进该检查点的快照。

**(c) 逐块确认朝向，但不管对别的方块的连带影响** ——
放置**每一格**都要先确认朝向正确再往下走（不对就挖掉重放，最多 4 次）。
但纠正只针对**当前这一格**：它对周围造成的连带变化（活塞被充能伸出、
红石连锁反应、邻接方块被带动…）**不去纠正、也不去比对**。
全部事件放完后再跑一遍 `reconcileTeaching()` 做整体收尾校对，
保证最终结果与录制一致（只比对录制里记录的那些格子）。

> 同理，"空格 / Shift"要如实记录：Shift 用 `entityCrouch` / `entityUncrouch` 事件；
> 空格没有对应包，用采样器判断 y 是否持续上升（`> 0.08`）来记成 `jump` 按下/松开。
> 复现时按记录 `setControlState('jump'/'sneak', down)`，结束务必松开避免按键卡住。

### 坑 23：`spawn-protection=16` 会让非 op 玩家在出生点附近**静默无法放置方块**

默认 `server.properties` 里是 `spawn-protection=16`：世界出生点 16 格半径内，
**非 op 玩家不能放置/破坏方块**。而建造、教学录制通常就在出生点附近发生。

最坑的是它**不报错**：`_placeBlockWithOptions` 不会抛异常，方块就是放不下去，
看起来像"放置逻辑坏了"，日志里只会看到反复重试、最后 `could not place`。

修法：`start_server.ps1` 里强制写入 `spawn-protection=0`（对这种创造建造服本就该关），
另外 bot 启动时会通过 RCON 给所有玩家 op（见坑 22）双保险。

> 排查同类问题时，别像我一样只盯着放置逻辑——先把拒绝原因打出来：
> `_placeBlockWithOptions` 的 catch 里 `console.error(e && e.message)`。
> 服务器通常会回 `Server refused to place xxx`，而 spawn-protection 连这个都没有。

### 坑 24：红石粉的点状 / 十字，以及"放置前后视角稳定 0.1s"

**红石粉形态**：`redstone_wire` 的状态是 `east/north/south/west`（各 `up/side/none`）+ `power`。
- **dot（点状）** = 四个方向全是 `none`
- **cross（一/十字）** = 至少一个方向是 `side` / `up`

两种形态可用**右键**切换，所以录制的 `place` 事件里会额外记 `wire` 字段，
蓝图 `scanRegion` 也会记；放置后若形态不一致就 `activateBlock` 右键切一次（`ensureWireShape`）。

**右键前也要等 0.1s**：除了放置，`activateBlock`（右键交互）之前同样要先停 0.1s —
操作太快会**误触**（最典型的是中继器：连点会把延迟档位点多了）。涉及位置：
`ensureWireShape`（切换红石粉形态）和 `replayTeaching` 的 `use` 分支。

**视角稳定**：方向性方块的朝向由视线决定，视角还在插值中就发放置包，
游戏端偶尔会拿到错误朝向或直接拒绝。所以 `placeWithFacing` / `placeOnFace` 在
`lookAt` 之后、放置之后各 `sleep(100)` 让视角稳定。
副作用是失败重试变慢，单块超时已从 20s 放宽到 **45s**。

### 坑 26："tpto 说距离太远" —— `bot.players[x].entity` 是 undefined

现象：玩家在远处用 `tpto`，AI 回 **"找不到你的位置，请靠近一些再试"**（玩家就理解为"说距离太远"）。
代码里其实没有"太远"这句话，是这个分支：

```js
function userPos (username) {
  const p = bot.players[username]
  if (!p || !p.entity) return null   // ← 远的时候走到这里
  return p.entity.position.floored()
}
```

原因：玩家超出 AI 的**可见/模拟距离**后，服务器不再把他的实体同步给 AI。
AI 只知道"这个人在玩家列表里"，但**拿不到坐标**，于是只能请你靠近。
（排查时注意：这不是 mineflayer 的报错，库里 "too far" 只有 `bed.js` 的 'the bed is too far'，与传送无关。）

修法（`teleportToPlayer`）：近的时候照旧飞过去；远到看不见时，
改用 **RCON `/tp <AI名> <玩家名>`**（AI 有 op，不受可见距离限制）。
`build <名字>` 也走同一套（原来远距离同样报"找不到你的位置"）。

实测：玩家跑到 259 格外（`aiDist = Infinity`，即 AI 完全看不见），
`world tpto` → RCON 回显 `Teleported world to FarPlayer` → 最终距离 **5.0 格**。

### 建造范围标记（red/blue wool）与重复建造（rep）

**标记**：`buildFromBlueprint` / `replayTeaching` 开工前会用 `markBuildArea()`
在包围盒的**两个对角**放 `red_wool` 和 `blue_wool`，停 1.5s 让玩家看清，然后**挖掉**再开工
（不挖会挡住真正的建造）。默认开启，由 `bot._markEnabled` 控制，`mark y/n` 命令切换。

细节与坑：
- 目标格若是实心就往上找最多 4 格空位，保证一定看得见。
- **标记必须走 `placeAt`（带临时辅助方块），不能用 `placeSimpleAt`** ——
  包围盒的对角常常**悬在空中**（尤其复现位置在空中时），没有相邻实心块根本放不上去，
  必须和正常建造一样先放 smooth_stone 支撑。实测：原点四周 0 个实心邻居的高空，
  标记照样能放出来。
- 标记拆除后要 `cleanupAssists(bot)`，把标记期间搭的临时支撑一起清掉，别留在场上。
- **拆除必须"靠过去 + 对准 + 挖 + 确认没了 + 重试"**（`removeMarker`）。
  以前只是 `bot.dig` 一次、失败被 catch 吞掉，结果**第一个红羊毛经常漏拆**留在场上。
  测试时要让包围盒的**对角不是结构本体**（比如方块放在 (0,2,0) 和 (2,0,2)），
  否则对角会被真正建造的方块盖住，漏拆也检测不出来。

**rep 重复建造**：`rep <名字> <x|y|z> <间隔> <数量>`，`-1` = 无限（用 `stop` 停）。
- `sizeOfSaved(name)` 从教学的 place 事件（优先）或蓝图的 blocks 算出包围盒尺寸，
  **教学优先于蓝图**（和 build 的优先级一致）。
- 步长 = 该方向的尺寸 + 间隔；第 i 份的原点 = 基准点 + i × 步长。
- 基准点取**玩家当前位置**；每份之间用 `goTo` 赶过去（超过 100 格会自动传送）。
- `REP_MAX = 500` 是无限模式的安全上限，防止失控把服务器建爆。

> 测试要点：验证重复建造时**要比对方块名**（`b.name === r.name`），
> 不能只判"非空气"——地面/残留方块会造成假阳性（实测踩过这个坑）。

### 多 AI（summon）与 help 成书

**架构选择**：每个 AI 跑在**独立 Node 进程**（`fork(bot.js)`，带 `AI_WORKER=1`）。
选它是因为 `bot.js` 本身就是"模块级单实例"结构（`bot`、`teachMode`、`saveMode` 都是全局），
改成工厂要重写几百行；分进程则几乎零改动，而且一个 AI 崩了不影响别人。
- 主进程（无 `AI_WORKER`）负责 `summon` / 删除，并把注册表写进 `ais.json`。
- 主进程启动时**重置** `ais.json` —— 否则上次残留的名字会让"是否需要前缀"判断出错。

**路由规则**（每次收到聊天时现读 `ais.json`）：
- **一律要求名字前缀，不再区分 AI 数量**。原因：只有一个 AI 时如果允许裸指令，
  玩家正常聊天里出现 "build"/"stop"/"help" 这类词就会被误当成指令，很打扰人。
  首词不等于自己名字 → 直接 return；匹配上才剥掉前缀继续处理。
  **管理指令（`summon ... del/add`）同样要加前缀**。
- 第一个 AI 的默认名字是 **`world`**（`process.env.MC_USER || 'world'`）。
- 听从名单 `obey`：非空时只响应名单内玩家（默认 = 召唤者；主 AI 默认听从所有人）。

**落地**（`M.stopFlying` / `M.landOnGround`）：跟随玩家时不能一直悬空。
- `stopFlying`：abilities 只发 `0x04`（去掉 `0x02` flying）+ 恢复本地重力。
- `landOnGround`：往下找地面 → `moveVertical` 降到 `地面+1` → `stopFlying`。
- 跟随循环里的**坑**：别写成"`dist<=7` 就落地"又在"`dist>5`"里起飞 —— 5~7 这段会
  **来回抖动**（刚落地又起飞）。正确写法：追人(`>5`)时飞，跟上了(`<=5`)才落地。
  实测：从 y=-48.45 空中落地后 y=-60.00，`onGround=true`，脚下实心。

**皮肤**：`summon <名字> <皮肤>`，未指定随机。`skins.json` 存 `{command, skins}`；
子 AI 通过 `AI_SKIN` 环境变量拿到，上线 4 秒后自己 `bot.chat(command)` 换肤。
**前提**：离线服不提供皮肤，需要服务器装皮肤插件（SkinsRestorer）；没装则命令失败仅记日志。

**help 成书的两个坑**：
1. **不能用 `bot.chat('/give ...')`** —— 整条命令远超聊天 256 字上限，会被静默吞掉
   （日志显示函数执行了，但服务器根本没收到）。必须走 **RCON** 执行。
2. **SNBT 单引号字符串不认 `\n`**，直接塞 `JSON.stringify` 的结果会报
   `Invalid escape sequence '\n' in quoted string`。要把反斜杠再转义一层
   （`.replace(/\\/g, '\\\\')`），让 SNBT 还原出 `{"text":"a\nb"}` 给 JSON 文本组件换行。
   1.21 用的是组件 `written_book[written_book_content={...}]`，不是旧 NBT。

### 坑 25：服务器日志中文乱码 —— 让 JVM 按 **GBK** 输出

现象：日志窗口里中文变成 `澶嶇幇瀹屾垚锛佹湰娆℃斁缃?28 涓柟鍧?` 这种乱码。

原因：JDK 18+ 默认用 **UTF-8** 写 stdout，而 Windows 中文环境的控制台/日志窗口
按 **GBK** 解码 —— 于是"UTF-8 字节被当成 GBK 读"。
**文件本身其实是好的**（用 `Get-Content -Encoding UTF8` 读能看到正常中文），
所以不要去改 bot 发消息的地方，那是没问题的。

修法：`start_server.ps1` 启动 java 时加上

```
-Dfile.encoding=GBK -Dsun.stdout.encoding=GBK -Dsun.stderr.encoding=GBK
```

让 JVM 直接按 GBK 输出，日志窗口就能正常显示。
（若你的查看器确实是 UTF-8 的，把脚本里的 `$enc = "GBK"` 改成 `"UTF8"` 即可。）

### 坑 15：**方块名 ≠ 物品名**（红石粉 / 火把直接报 "Unknown block"）

`equipBlock` 原来直接拿方块名去查 `mcData.itemsByName[name]`，但 Minecraft 里两者并
不总是一致，于是这些方块**根本拿不到手上**，控制台刷 `skip unknown block`：

| 方块名 | 物品名 |
| --- | --- |
| `redstone_wire`（红石粉） | `redstone` |
| `redstone_wall_torch` | `redstone_torch` |
| `wall_torch` / `torch` | `torch` |
| `cocoa` | `cocoa_beans` |
| `water` / `lava` | `water_bucket` / `lava_bucket` |

修法：`BLOCK_TO_ITEM` 显式映射 + 兜底规则（`oak_wall_sign` → `oak_sign`），见 `itemNameFor()`。
**新增任何方块材质时，若放不出来，先查这里。**

### 坑 16：非整块方块（`boundingBox === 'empty'`）必须用"贴面"放置

用 `mcData.blocksByName[name].boundingBox` 可以干净地区分：

```
piston / stone / oak_planks / repeater / comparator  -> 'block'  （整块）
redstone_wire / redstone_wall_torch / lever / torch   -> 'empty'  （非整块）
```

整块方块（坑 8 那套"站到 -F 侧 + 视线决定朝向"）对非整块**完全失效**，因为：
1. 目标格是空气，"盯着格子中心"射线打不到任何东西 → 服务器拒绝放置；
2. 它们的朝向由**被点击的那一面**决定，而不是玩家视线
   （`WallTorchBlock.getStateForPlacement` 用的是 `getClickedFace()`）。

修法（`build.js` 的 `placeAttached` / `placeOnFace`）：
- 找到要依附的实心方块 `ref`，算出**被点击面的中心** `fc`，把 bot 站到 `fc + faceVec × 2`（面外侧），
  `lookAt(fc)` 后再 `_placeBlockWithOptions(ref, faceVec, {forceLook:'ignore'})`
- 想朝 F 的墙上附件：墙在 **-F 侧**（`blockAt(x - v[0], y, z - v[2])`），点击面的法线就是 `v`
- 贴地方块（红石粉）：`ref` 是下方方块，`faceVec = (0,1,0)`
- 支持 `方块名:面:朝向`（如 `lever:wall:north`）显式指定，省略则自动：先贴墙 → 再贴地 → 任意邻面

> 辅助支撑也要跟着变：墙上附件缺的不是"脚下的柱子"而是**那面墙**，
> `placeWithAssist` 会先用平滑石头把墙补出来，放完再拆（见坑 14）。

### 坑 12：`bot.creative.startFlying()` 是**本地空操作**，服务器根本不知道你在飞（y 轴寻路的根因）

看 mineflayer 源码 `lib/plugins/creative.js` 第 102 行：

```js
function startFlying () {
  if (normalGravity == null) normalGravity = bot.physics.gravity
  bot.physics.gravity = 0        // ← 只改本地物理，一个包都不发
}
```

也就是说 `ensureFlying()` 调完之后，**服务器仍然认为玩家处于"走路"状态**：
- 按 `jump` 只上升 **1.25 格**（一次普通跳跃），无法持续爬升
- "抬头 90° + W" 更是完全不会上升——mineflayer 的物理**只按 yaw 算 W 位移，完全忽略 pitch**
- 结果就是"AI 在 y 轴上完全无法寻路"

**试过且确认无效的办法**：给服务器发 `abilities` 包开飞行
（`bot._client.write('abilities', { flags: 0x02 | 0x04 })`，位 2=flying / 4=allowFlying）。
1.21.1 的 serverbound `packet_abilities` 确实只有 `flags`(i8) 一个字段，写包也不报错，
但实测 flags=6 / 14 / 4 全都无效，按住 jump 依然只跳 1.25 格。

**唯一可靠的方式：逐帧小步改写 `bot.entity.position`（每 0.5 格一步）。**
服务器接受这种小增量位移，上升下降都成立（实测上升 90+ 格没问题，高层建造也靠它）。
`movement.js` 的 `moveVertical` 就是用这个 + 看门狗 + 避障实现 y 轴移动的。

> 副作用：bot 不会"悬停"。停手后服务器可能把它慢慢放回地面，所以建造时每一块都会
> 由 `ensureReach` 重新校准高度——这是正常的，不要"优化"掉。

### 坑 13：水平移动用 W 键，但**放置落位必须走小步**

按需求，AI 的水平移动要"看向移动方向 + 按 W 键"（`movement.js` 的 `moveHorizontal`），
实测有效：目标方向对齐率 100%，W 键按住比例 ~90%。

**但建造时的"站位调整"不能用 W**（`movement.js` 的 `navigateTo`）：
放置方向性方块要求 bot 站到建筑的**另一侧**，而挡在中间的墙正是 bot 自己刚砌好的 ——
物理飞行会一头撞上去卡住，接着触发避障逻辑、每块都跑满超时
（实测整栋 5×5 活塞房直接 180s 超时失败）。

所以分工是：
- **赶路**（`goTo` / `tpto` / 跟随 / 扫描前飞高）→ `moveTo()`：先水平 W 飞行，再垂直小步推进
- **放置落位**（`placeWithFacing` / `ensureReach` / `placeAt`）→ `navigateTo()`：小步落位，无视碰撞

### 坑 14：空中建造 —— 平滑石头辅助支撑，放完立刻拆

Minecraft 规定方块必须**挨着一个已有方块**才能放下。用 `build <x> <y> <z>` 在空中开工时，
第一块六个面全是空气，必然放不下。

`build.js` 的处理（`placeWithAssist`）：
1. `findSupportBase`：从目标下方往下找第一个"自身就放得住"的高度（`hasSolidNeighbor`）
2. 用 `smooth_stone` 自下而上搭临时支撑柱，每根都记进 `bot._assistBlocks`（"记住"）
3. **换回目标方块本身的材质**（搭柱子时手里是平滑石头，不换回来会放错材质！）
4. 放好目标方块
5. **`finally` 里立刻拆掉**全部临时支撑（方块放下后失去支撑也不会掉落）

> 易错点：搭柱子时 bot 自己的身体会占住格子导致放置被拒（`avoidSelfBlock` 先挪开）。
> 没做这步时，同一个坐标会反复失败 7 次才勉强成功。

> 只有真正悬空的格子才触发；一旦有相邻方块，后续方格互相依附即可，不会每块都搭柱子。

---

## 五、导航：统一 xyz（`movement.js` 的 `moveTo`）

所有"去某个地方"都走 `moveTo(x, y, z)`，参数是**完整三维坐标**（`bot.js` 的 `goTo` 只是薄封装）：

```
moveTo(x,y,z)
  ├─ 1) moveHorizontal(x,z)  水平：看向移动方向 + 按住 W 键（像玩家一样飞/走）
  │       └ 卡住 →【避障逻辑】1s：松 W 上飞 2 格 ／ 10s：吃紫颂果
  ├─ 2) moveVertical(y)      垂直：小步推进（见坑 12，物理飞行在此环境不可用）
  │       └ 卡住 →【避障逻辑】侧移重试 ／ 吃紫颂果
  └─ 3) pathfindXYZ(x,y,z)   仅当前两步走不通：A* 绕路（三维 GoalNear，含 y）
          └ 同样的【避障逻辑】看门狗
```

> **`避障逻辑` = 卡住时执行的那一套处理**（上飞 2 格 / 侧移 / 吃紫颂果），
> 集中在 `movement.js` 的【E】分类。三个移动阶段共用它，不要各自另写一套。

**赶路性能**（实测）：
- `moveHorizontal` 移动时同时按住 **疾跑**（`setControlState('sprint', true)`），`finally` 里松开；
- `moveTo` 若目标距离 **> 100 格**（`FAR_TELEPORT`）就不再一步步飞，直接走
  `teleportXYZ()` 小步推进（1 格/tick）。实测 165 格：传送 **9.8s**、终点偏差 0.00；
  而 27 格近距离仍正常疾跑走过去（5.1s）。
- 复现教学路线用的是 `moveToSmooth`，**不会**触发这个传送（否则轨迹就对不上了）。

### 阶段 1：`moveHorizontal`（水平，默认走这条）
不用 A*。**像玩家一样飞**：`await bot.lookAt(同高度的目标点, true)` 面向移动方向 →
`bot.setControlState('forward', true)` 按住 W 前进（每 100ms 重新瞄准一次）。
实测：W 键按住比例 ~90%，机头方向与位移方向**对齐率 100%**。

> 早先版本是直接改写 `bot.entity.position` 挪坐标（照搬 `creative.flyTo` 的做法），观感像瞬移。按用户要求改成"面向目标 + W 前进"。

看门狗循环：
- 位移 > 0.2 格 → 有进展，重置 `stuckSince` / `hardSince`
- 卡住先**松开 W**，再执行：
  - **1 秒**未移动 → `nudgeUp(bot, null, 2)`：上飞 2 格 → 继续（可翻越矮障碍）
  - **连续 10 秒**未移动 → `eatChorusFruit()`：发紫颂果到快捷栏并食用（随机传送）→ 继续
- `finally` 里一定 `setControlState('forward', false)`，避免一直往前飞
- 超时 40 秒仍未到 → 返回 false，进入阶段 2

### 阶段 3：`pathfindXYZ`（A* 兜底）
```js
movements.allowFreeMotion = true   // 不是 canFly！见坑 1
movements.canDig = false           // 见坑 2
ensureFlying(bot)                  // 本地去重力（注意服务器侧飞行开不了，见坑 12）
bot.pathfinder.setGoal(goal, true) // 不用 goto()，见坑 6
goal = new goals.GoalNear(x, y, z, 1)  // 三维目标，含 y
```
同样的 1 秒 / 10 秒看门狗，总超时 120 秒，结束时 `setGoal(null)`。

### 为什么改掉纯 A*
之前只用 A*（`allowFreeMotion`）时，在无障碍空地上也会**不停拐弯**（网格 8 向路径的锯齿效应）并**无故爬升**，用户体验很差。改为直线优先后：

> 实测跨越约 70 格：轨迹直线度 **1.02**（净位移/路径长度，1.0=完全直线），高度全程不变，无 `stuck` 日志，建造 100/100 完成。

---

### 坑 27：**断线重连必须重新挂事件**，否则重连后所有指令失联

- 现象：重连看起来成功（`[AI] Logged in ...` / `[AI] ready` 都打印），但发什么指令都没反应。
- 原因：mineflayer 的 `bot.on(...)` 绑在**那一个实例**上。新建实例后，旧监听器不会跟过去。
- 解决：所有事件统一写进 `attachHandlers(bot)`，`createAndAttach()` 每次新建实例都调用一次；
  业务函数（`goTo` / `teleportTo` / `startFollow` / `doBuild`…）读的是**模块级 `let bot`**，
  重连后自动指向新实例，所以这些函数一行都不用改。
- 三个容易漏的细节：
  1. `error` 和 `end` 可能**同时**触发 → 用 `bot._dead` 保证只排一次重连，否则重连风暴。
  2. 退避 1s → 2 → 4 … 封顶 30s；`spawn` 里必须把退避**清零**，否则一次长断线后永远按 30s 重连。
  3. Ctrl+C 时要置 `shuttingDown = true`；否则定时器还会再连一次（进程退不掉）。

### 坑 28：连不上服务器时 `err.message` 是**空串**（AggregateError）

Node 20+ 的 `ECONNREFUSED` 是 `AggregateError`：`message` 为空，真正的错误码在
`err.code` 或 `err.errors[].code` 里。只拿 `err.message` 做诊断，中文提示永远打不出来。
要拼 `name + code + message + errors[]` 一起判断（见 `bot.js` 的 `bot.on('error')`）。

### 坑 29：`config.json` 可能带 BOM，`JSON.parse` 直接抛

记事本、PowerShell 5.1 的 `Set-Content -Encoding utf8` 都会写 **BOM**，`JSON.parse` 不认 →
抛异常 → 代码静默回退默认值，表现是"我明明改了配置，为什么不生效"。
`config.js` 里已 `replace(/^\uFEFF/, '')`；以后凡是读用户手写的 JSON 都要这么干。

### 坑 30：测试里不要再写死 `localhost:25565` / `1.21.1`

26 个测试原本各写一份连接信息，换端口/换版本要改 26 处，几乎必然漏。
现在统一走 `测试/_common.js`（它读 `config.json`）。

另外 `require('minecraft-data')(bot.version || VERSION)` 在**模块作用域**里可能踩 TDZ：
`const bot` 还没初始化就去取 `bot.version` → `ReferenceError: Cannot access 'bot' before initialization`
（`test_facing.js` 踩过）。要么把这行挪到 `createBot` 之后，要么直接用 `VERSION`。

### 坑 31：登录时刷一堆 `PartialReadError ... ArmorTrimMaterial` 是**正常**的

1.21.1 服务器下 mineflayer/protodef 解析注册表里的 `ArmorTrimMaterial` 会报
`PartialReadError: Missing characters in string, found size is 108271 expected size was 114153`。
**登录照样成功**（接着就会打印 `Logged in` / `ready`），不用管它，也不是我们代码的问题。
排查真问题时别被这坨栈骗走注意力 —— 真正的连接错误是 `Connection error:` 那一行。

### 坑 32：右键放方块时，**依托方块自己会响应右键** → 方块放不上 + 红石状态被悄悄改掉

现象：AI 在拉杆 / 按钮 / 中继器 / 音符盒 / 箱子旁边放方块时经常放不上；
更隐蔽的是**红石状态被改掉**（拉杆被扳、中继器延时节 +1、音符盒响一声），
录制复现时检查点对不上，但日志里看不出任何异常。

原因：mineflayer 放方块 = 对**依托方块**发 `use_item_on`（右键）。服务器处理这个包时
**先执行方块自身的交互**，交互成功就直接消费掉这次点击，**不再走放置**。
而且 mineflayer 自己在 `lib/plugins/generic_place.js` 第 39 行还留着一条 TODO：
`// TODO: tell the server that we are sneaking while doing this` —— 它**不会**帮你按 shift。

修法（`build.js`，两条一起上）：

1. **换面优先**：`candidateRefs()` 把"可右键交互"的邻居排到最后。旁边还有普通方块时
   就拿它当依托，完全不碰可交互方块（`tryPlaceNormal` / `placeSimpleAt` / `placeAttached` 都改用它）。
2. **只剩可交互方块时才按 shift**：`clickPlace()` 是**唯一**的放方块入口，检测到
   `isInteractiveBlock(ref.name)` 就 `setControlState('sneak', true)` → 等 1 tick →
   发 `use_item_on` → **立刻** `sneak = false`。服务器看到玩家潜行会跳过方块自身交互，
   直接把手上的方块放上去（玩家手动"shift + 右键放方块"就是这个原理）。

两个必须注意的细节：

- **shift 只能在"发包那一瞬间"按着**。发包是同步完成的（`forceLook:'ignore'` 时
  `_genericPlace` 里没有 await），但等 ack 可能要好几秒；创造模式下 shift 是**下降**，
  一直按着会把 ai 从空中一路拽下来。所以顺序是"按下 → 1 tick → 发包 → 立刻松开 → 再等 ack"。
- 名单是**手写**的：minecraft-data 里没有 `interactive` 这种字段（`blocks.json` 只有
  id / hardness / resistance / boundingBox / states …），只能维护 `INTERACTIVE_NAMES` +
  `INTERACTIVE_SUFFIXES`（`_button` / `_door` / `_trapdoor` / `_fence_gate` / `_bed` /
  `_shulker_box` / `_sign` / `_anvil` / `_candle` / `_cauldron`）。作物也算（成熟后右键 = 收，
  会把地里的作物撸掉）。**以后遇到新的交互方块往名单里补，别靠"看着像不像"判断。**
- 回归测试：`node 测试/test_interactive.js`（唯一邻居=音符盒时必须 shift 放、有普通邻居时换面、
  红石粉贴音符盒顶面；三个场景都要求音符盒状态一个字节不变）。

### 坑 33：连正版服（online-mode=true）要 `auth: 'microsoft'`，而且**进服名字不是 `ai.name`**

离线服随便起名字，所以 `createBot({ username })` 就是游戏内名字。正版服不是：

- `options.auth = 'microsoft'`，`options.username` = **账号邮箱**（不是名字）；
- 第一次登录走**设备码**：`options.onMsaCode = (data) => ...`，打印 `data.verification_uri` +
  `data.user_code`，浏览器输一次即可；令牌缓存到 `options.profilesFolder`
  （默认 `服务器/nmp-cache`，来自 `prismarine-auth`），以后启动免登录；
- 登录成功后 **`bot.username` 由账号决定**，和 `cfg.ai.name` 没关系。

第三点是坑：指令前缀是拿 `bot.username` 比的，但 `ais.json` 里登记的是 `ai.name`，
对不上就会 `ais[myName] === undefined` —— 而"听从名单"是 `mine && mine.obey.length`，
`mine` 为空等于**没有限制**，任何玩家都能指挥。所以 `spawn` 里要把真实名字补登记进 `ais.json`
（`bot.username !== USERNAME` 时改键），日志名也只在启动时用 `ai.name`。

另外：**正版账号不能 `summon` 多个 ai** —— 子进程共用同一个账号，一上线服务器就判
`duplicate_login`，互相踢下线（`summon` 分支已直接拒绝）。

### 坑 34：「谁进服就自动 op」是接别人服务器的**头号风险**（P1-B）

`playerJoined` → `ensureOp()` → RCON `op <玩家名>`，这是给自己开的服写的逻辑。
连到**别人的**服务器上，等于路过的玩家都能被 op——服务器就交出去了。

现在由 `ai.autoOp` 决定（`源码/access.js` 的 `canOp`）：

| 值 | 行为 |
| --- | --- |
| `local-only`（默认） | 只有 `server.host` 是 `localhost` / `127.0.0.1` / `::1` / `0.0.0.0` 时才 op |
| `never` | 从不 op |
| `whitelist` | 只给 `ai.opWhitelist` 里的人 op |
| `always` | 谁进服都给（只在自己开的服上用） |

两个必须记住的点：

1. **写错的策略一律回落 `local-only`**（`opPolicy()`）。默认值必须是"最保守"的那个，
   配置打错字绝不能变成"给所有人 op"。
2. `isLocalHost` 只看**字符串**：用域名（哪怕解析到本机）连自己的服会被当成外部服，
   这时不会 op —— 这是有意的保守默认，需要 op 就在配置里显式改 `autoOp`。

想**本地**验证"外部服"这条分支：服务器监听 `*:25565`，用 `--host 127.0.0.2` 就能连上，
但 `127.0.0.2` 不在 `LOCAL_HOSTS` 里 → 会走"跳过自动 op"分支（实测日志：
`[AI] 跳过自动 op（autoOp=local-only：只给本机（自建）服务器的玩家 op）`）。

### 坑 35：指令准入有两套名单，是「取 AND」而不是互相覆盖

- `ais.json` 的 `obey`：**每个 ai 自己的**听从名单（`summon` 时默认 = 召唤者；主 ai 默认空 = 所有人）。
- `config.json` 的 `ai.obeyWhitelist`：**服主设的总白名单**（空 = 所有人）。

`canCommand()` 的规则：每个名单"空 = 不限制"，非空则必须在里面，两个都满足才放行。
空名单不构成限制 → 默认配置行为与以前**完全一致**（老测试不用改）。

被拒绝时**不回话**（公共服每个路人都回一句会刷屏），只在日志留一行
`[AI] 忽略 <玩家> 的指令：<原因>`。注意白名单是**启动时**读的，改完要重启 ai。

### 坑 36：`kicked` 的 reason 是聊天组件，不是字符串；且**致命错误别重连**

`bot.on('kicked', reason)` 的 `reason` 在 1.21 常常是组件对象
（如 `{ translate: 'multiplayer.disconnect.not_whitelisted' }`），直接
`JSON.stringify` 出来既不好读、也没法做中文诊断。先过 `kickText()`（递归拼
`text` / `translate` / `with` / `extra`）再用 `diagnose()` 匹配。

`diagnose()` 把失败分成两类，这一点很重要：

- **致命**（白名单 / 封禁 / 正版验证 / 版本不符 / 账号重复登录）→ `fatalStop()`：
  停掉重连**并退出进程**。否则 1s→2s→4s… 每 30 秒重连一次，日志滚成瀑布，
  真正的那一行原因被冲走。
- **非致命**（服务器满 / 网络抖动 / 反作弊踢人 / DNS 临时失败）→ 照常指数退避重连。



---

### 坑 37：测试里的指令**必须**带 ai 名字前缀，否则全是"假失败"

`bot.js` 现在**一律**要求 `world build ...`（第一个词 == ai 名字），哪怕场上只有一个 ai。
2026-10-31 夜间回归 28 个里 10 个就栽在这：`test_mark2` / `test_airmark` / `test_rep` /
`test_stop_del` / `test_teach1~5` / `test_multi` / `test_help` 还在
`player.chat('build 5 5')`，ai 把它当普通聊天**悄悄 return**（前缀不匹配连日志都不留），
表现出来就像"功能坏了"，很难看出是测试没跟上规则。

正确写法（`测试/_common.js` 统一给了一个 `cmd()`）：

```js
const { HOST, PORT, VERSION, cmd } = require('./_common')
player.chat(cmd(AI_NAME, 'build ' + NAME)) // => "AIBuilder build airmk"
```

例外是**故意**裸聊的（用来验证"不响应"）：`test_prefix.js` 的 `help` / 普通聊天、
`test_teach4.js` 的 `hello`（用它打开聊天框，测忽略窗口）、`test_multi.js` 的
`summon Bob add Steve2`。这些都登记在 `测试/守门.js` 的 `ALLOW_CHAT` 里 ——
新增例外要一起登记，否则守门会报错。

### 坑 38：离线服的**玩家背包会跨次保留**，"背包里有没有书"不能当断言

`help` 的书是 RCON `/give` 发的，物品存在 `服务器/存档/playerdata/` 里。
不清存档时，上一晚给的书还在 → `inventory.items().find(i => i.name === 'written_book')`
**永远为真**：`test_prefix` 的"无前缀 help 不生效"会假 FAIL，`test_help` 反而会假 PASS（更危险）。
改成数数量（基线 → 之后必须变多）：

```js
const before = player.inventory.items().filter(i => i.name === 'written_book').length
player.chat(cmd(AI_NAME, 'help'))
await sleep(6000)
const after = player.inventory.items().filter(i => i.name === 'written_book').length
const got = after > before
```

同理：玩家的方块、位置都会跨次保留，行为测试前最好 `--reset`（只会把 `存档` 改名备份）。

### 坑 39：夜间回归先跑 `测试/守门.js`，别让"测试自己坏了"埋一夜

2026-10-31 那次 15/28，其中 17 个失败**与游戏功能无关**：7 个测试漏写
`const path = require('path')`（一启动就 ReferenceError，0 秒失败），另外 10 个漏指令前缀（坑 37）。
`测试/守门.js` 用 **2 秒**查完四件事：语法（源码 + 测试 + 面板 ESM）/
测试里的指令前缀 / 用了 `path.`·`fs.`·`spawn(` 却没 require / require 的相对路径是否存在。

- 单独跑：`node 测试/守门.js`（`--verbose` 打全过程），报告 `日志/夜间回归/最新守门.md`
- 它已排在 `测试/夜间回归.js` 清单**第一位**，每晚自动先跑
- 读报告的顺序固定：先看 `最新守门.md`（测试/代码自己有没有写坏）→ 再看 `最新报告.md`
- 它还顺手查一个 2026-11-01 踩到的坑：测试主流程里写 `bot.version`（应该是 `player.version`）。
  `bot` 在测试里只作为 `function giveItem (bot, ...)` 的参数存在，主流程里没有它。

**2026-11-01 实测效果**：上晚失败的那 15 个测试，修完测试自身的问题后直接变 **11/15 通过**
（剩下 4 个：1 个等待时间太短、1 个同类 `bot.version`、1 个真实的"右键事件复现"问题、1 个测试语义被改）。

### 坑 40：ai 上线也会触发 `playerJoined` → 别把它记成玩家

mineflayer 的 `playerJoined` 对**所有**进服者都触发，ai 自己也是玩家，于是
`world` / `AIBuilder` / `way-yan_nuo` 全被当成"玩家"写进了 `配置/玩家登记.json`，
服主视角的玩家表里混一堆 ai，反而看不出"谁名下有哪些 ai"。

判定统一走 `源码/玩家登记.js` 的 `classifyName(name, { ais, mainName, guestPrefix })`，
命中任一条就是 ai：

1. `ais.json` 里有这个名字（主 ai / summon 出来的 / 手动起的）
2. 等于主 ai 名字（`config.ai.name`）
3. 形如 `<guestPrefix><名字>`（默认 `way-`）—— 前缀本身就是"这是 ai"的约定

配套三个函数：

- `recordJoin()`：识别成 ai 时**不建玩家记录**，返回 `{ isAi: true }`，顺手 `pruneAiEntries()` 清历史误记
- `listPlayers(host, port, { ais, mainName, guestPrefix })`：默认**只返回人**；
  要连 ai 一起看传 `includeAi: true`（返回项带 `kind: 'player' | 'ai'`）
- `inferOwner(aiName, opts)`：`ais.json` 的 `owner` 优先，没有就剥前缀（`way-alice` → `alice`）

`bot.js` 侧对应 `attributeAi(name, owner)`：ai 上线时**只在 owner 为空时**补写进 `ais.json`
（不覆盖 `summon` 记下的归属；主 ai 不写，它是共用的）。

### 坑 41：面板"视角"不能只存在前端内存里

原来 `views/config.js` 里 `let MODE = 'owner'` + 两个按钮切换。刷新浏览器、换分页、
重开面板都会回到默认值；更关键的是**一台机器上谁是服主是固定的**，来回切没有任何意义。

现在视角是**分页的字段**（`配置/服务器配置.json` 里每页的 `view: 'owner' | 'member'`）：

- 创建分页时选（`POST /profile/new` 带 `view`），之后 `POST /profile/view` 直接 **400**
- 老分页（没有 `view` 字段）允许**补一次**，补完同样锁死
- `GET /api/config` 返回 `view` / `viewLocked`；没锁定的时候前端只显示"选一次"的提示，不渲染配置表单

**别把成员视角做成"只能改名字"**（2026-11-01 用户反馈）。成员要改的是"我怎么连上去"：
地址 / 端口 / 版本 / 登录方式 / 正版账号 / RCON / ai 名字 / 成员 ai 前缀 / 指令白名单 / 行为 /
默认建筑 **全部放开**；只有 3 项归服主管（`_fields.js` 的 `OWNER_ONLY_KEYS`）：

| 字段 | 为什么是服主专用 |
|------|------------------|
| `ai.owner` | 谁是服主 —— 改了整台服的权限划分就变了 |
| `ai.autoOp` | 给谁 op —— 服务器管理权限 |
| `ai.opWhitelist` | op 名单 —— 同上 |

实现方式：字段表里给这三项打 `ownerOnly: true`（`GET /` 会把整个 FIELDS 一起发给前端，标记自动带过去），
前端渲染成 `disabled` + "服主专用（成员视角只读）"，服务端 `POST /save` 对这三项回 **403**
（不是静默丢掉 —— 否则用户以为存上了）。

### 坑 42：面板和 ai 是**两个进程**，聊天监视必须落盘

想在面板里看游戏聊天，不能在面板里"订阅" bot 的事件 —— 它们不是同一个进程。
做法是 bot 每条聊天追加一行到 `日志/聊天.log`：

```
[HH:MM:SS] kind<TAB>发送者<TAB>内容      （kind: chat=玩家 / ai=ai 自己说的）
```

面板 `GET /api/config/chat?n=40` 读最后 N 行并解析，顺便用 `classifyName` +
`inferOwner` 标出"这句是哪个 ai 说的、它归谁"。注意两点：

- ai 自己的话也会从服务器回显到 `bot.on('chat')`（`username === bot.username`），
  所以要在 `if (username === bot.username) return` **之前**记日志，否则监视窗口只有玩家的话
- 文件要限长（超 256KB 只留最后 64KB），否则长期跑会一直涨

### 坑 43：`cleanupAssists` 会临时清掉 `_aiAbort` → 期间的 `stop` 被吃掉

`stop` 的实现是 `bot._aiAbort = true`，建造循环在若干检查点抛 `AI_ABORT` 退出。
但 `cleanupAssists()` 为了"能拆掉辅助方块"会**临时**把它置回 `false`，结束时恢复 `prev`：

```js
const prev = bot._aiAbort
bot._aiAbort = false
try { await removeAssists(bot, list) } finally { bot._aiAbort = prev }   // ← 这里会吃掉期间的 stop
```

只要 `stop` 落在清理的那一瞬间（标记范围结束时正好会调 `cleanupAssists`），
`prev` 是 `false`，`finally` 又写回 `false` → **stop 白发了**：玩家看到"已停止所有任务"，
其实上一栋房子继续盖到 100/100（2026-11-01 test_mark2 就是这么连挂两次的）。

修法：`stop` 时额外 `bot._aiStopToken = (bot._aiStopToken||0)+1`，
`cleanupAssists` 记下进入时的 token，恢复时：

```js
bot._aiAbort = prev || (bot._aiStopToken || 0) !== token
```

**测试侧配套**：要"停掉一个正在跑的任务"然后接着测下一件事时，
必须等 ai **回话**（`已停止所有任务`）再往下走，别用固定 `sleep(4000)` —— 它可能还在建造。

### 坑 44：初始 ai 名字是**固定**的，改名一律拒绝 —— 要换叫法用「别名」

2026-11-01 需求：服主和成员的初始 ai 名称固定。

- 服主：初始 ai = 主 ai（`config.ai.name`，例：`world`）
- 成员：初始 ai = `<ai.guestPrefix><玩家名>`（例：`way-alice`）

所以 `玩家登记.renameAi()` 现在**直接抛错**（面板 `/player/rename` 回 400），
`recordJoin()` 每次进服都按规则**重算** `aiName`（历史上手工改过的会被纠正回来）。

想换叫法用**别名**：

| 层 | 存哪 | 谁写 | 用途 |
|---|---|---|---|
| `alias` | `配置/玩家登记.json` 每个玩家一条 | 面板 `/player/alias`（服主可给别人设；成员只能给自己设） | 游戏里用别名当指令前缀 |
| `alias` | `ais.json` 对应 ai 的条目 | 主 ai 收到子 ai 的 `alias` 上报时补写 | 面板「ai 一览 / 聊天监视」显示 |

- bot 每条聊天都会查一次自己的别名（`玩家登记.findByAiName`，**5 秒缓存**），
  所以 `小A build ...` 和 `way-alice build ...` 等价
- 别名必须 2–16 位字母/数字/下划线/中文，且不能和「主 ai 名 / 别人的初始 ai 名 / 别人的别名 /
  场上已有 ai 名」撞（`setAlias` 里逐个校验）

### 坑 45：初始 ai 上线要**主动上报**别名（两台进程，登记表是唯一共同语言）

子 ai 进程启动时读 `玩家登记.json` 拿到自己的别名，然后 `bot.chat('<主ai> alias <自己> <别名>')`：

- 主 ai 收到后**以登记表为准**核对：一致 → `已记录`；不一致 → 回一句 ⚠ 并在 stdout 标出来
- 主 ai 会把别名写进 `ais.json`（面板显示用，真正的来源仍是登记表）
- 为什么要这条消息：服主在游戏里就能看到"某个 ai 上线并报了别名"，不看面板也知道对没对上号

### 坑 46：成员视角要**不下发**服主的信息（不是灰掉）

之前只是把服主专用字段 `disabled`，但数据还是发给了前端（F12 能看到）。
现在 `GET /api/config` 在 `view === 'member'` 时：

- `fields` / `groups` / `values` **过滤掉所有 `ai.*`**（主 ai 名、服主游戏名、前缀、op 策略、白名单）
- `players` 置空（不给别人的角色 / 初始 ai 名 / ai 归属），只留 `playerNames: []`（找自己用）
- `owner` / `mainAi` 置空串
- 另开一个 `GET /me?username=xx` 只返回**自己那条**（初始 ai 名、别名、名下 ai）

服务端 `POST /save` 对成员视角仍会拒绝 `ai.*`（403），别指望"前端没显示 = 服务端放行"。

### 坑 47：`脚本/打包.ps1` 轻量打包踩的五个坑（2026-11-01 第一版）

打包思路：复制源码 + 依赖（裁剪）+ 内置 `node.exe` + 生成 `启动面板.bat`/`启动AI.bat` → zip。
下面每一条都是**实测踩过**的，改打包脚本前必读：

1. **`Get-ChildItem -LiteralPath X -Recurse -Include '*.md'` 会把所有文件都选中**
   —— `-Include` 配 `-LiteralPath` 时过滤不生效（`-Path` 才生效），我第一次裁剪文档时
   直接把 `node_modules` 里**所有文件**删光了（包只剩空目录，自检报 0 MB）。
   改用 `| Where-Object { $_.Extension -in @('.md','.map') }`。
2. **`minecraft-data` 的 `data/bedrock/common` 不能删**
   —— `lib/supportsFeature.js` 在 `require` 阶段就读 `data/bedrock/common/features.json`，
   删了直接 `MODULE_NOT_FOUND`。只能删 `bedrock` 下除 `common` 以外的版本目录（省 330MB）。
3. **`data/pc` 下不能只留 `1.21.1`**
   —— `data.js` 是"每个版本一个 getter"，而 `lib/indexes.js` 在 `require('minecraft-data')`
   时就访问了其中若干 getter（实测要 `pc/1.20.5/biomes.json`）。想只留一个版本就得改依赖源码，
   不值当：pc 全留也才 97MB。
4. **打包出来的 `config.json` 不能带 BOM**
   —— 项目 `config.js` 是 `JSON.parse(fs.readFileSync(...,'utf8'))`，BOM 会让它
   `Unexpected token`。用 `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`
   或者干脆用**随包 node** 洗配置（`JSON.stringify(c,null,2)`），写完读回校验前 3 字节不是 `EF BB BF`。
5. **`@(...)` 里别写 `'前缀：' + (表达式)`**
   —— 会被拆成 3 个数组元素，`版本.txt` / `发布说明.md` 里就成了「前缀：」换行「值」，
   Markdown 表格直接被破坏。一律先算进变量，再 `"前缀：$变量"`。

另外两条工程习惯（也是踩出来的）：
- 打包**必须自带自检**：拿包里的 `node.exe` 跑一次 `require('minecraft-data')` + 取 `stone` 方块，
  失败就 `throw`。没有这一步，坏包要等用户双击才发现。
- `ZipFile::CreateFromDirectory($dir,$zip,$level,$true)` 比 `Compress-Archive` 快一个数量级
  （202MB 目录 → 45.8MB zip，几十秒）。

### 坑 48：用 SSH 反向隧道测「远程机 ↔ 本机服」

详见 `文档/远程开发机.md` 第 7 节。三条最容易浪费半小时的：

- `ssh ngrok "powershell -Command \"...$var...\""`：**本机 PowerShell 先把 `$var` 展开**、
  引号被多跳吃掉 → 远程收到半截命令。一律用 `-EncodedCommand`（UTF-16LE base64）。
- 远程 `Start-Process` 起的进程**随 ssh 会话结束被杀**（Windows job object）：
  想让远程跑长任务，就让**本机** ssh 常驻（`Start-Process powershell -Command "ssh ... > log"`）。
- 本机**前台命令结束时，它拉起的 scp 也会被杀**（远程只剩半个 zip，且文件句柄被死占，
  连 `Expand-Archive` 都打不开）。所以 scp 也要用独立进程跑，传完用"能否独占打开"来判断。

---

## 六、测试环境注意事项（极易踩）

- **冒烟测试前必须删除 `world` 和 `flat_initialized.txt`**，否则 bot 会生成在**上一轮测试建好的房子顶上**：新建筑超出旧建筑边缘的格子下方是空气 → 无依附面 → 大量失败。此时 spawn 的 y 会逐轮升高（-60 → -59 → -58），这是明显的污染信号。
- 直接 `java -jar server.jar` 启动不会走 `run.ps1` 的平坦化逻辑，需确认 `server.properties` 里 `level-type=flat`。
- 世界生成后要等约 20–25 秒再让 bot 登录，否则区块未加载。
- PowerShell 的 `Start-Process` **不允许 stdout 和 stderr 重定向到同一个文件**，必须分开。
- **验证寻路是否走直线**：开第二个 bot（模拟用户）飞到远处后发 `build`，同时用 `bot.players['AIBuilder'].entity.position` 每 200ms 采样 AI 轨迹，算 `净位移 / 路径长度`。该比值 ≈1.0 表示完全直线，拐弯会明显小于 1。
- 长命令容易被使用者放到后台执行；此时日志仍会写入重定向文件，隔几十秒再读即可（本次实测就是这样拿到结果的）。
- **长测试要用独立进程跑**：在前台跑 `node 测试/test_commands.js` 时，下一批命令会关掉这个终端，
  测试进程和它 `spawn` 的 ai 子进程会被一起杀掉，表现是"跑到一半输出就没了"（踩过两次）。
  正确姿势：`Start-Process cmd /c "node 测试\test_commands.js > 日志\_x.txt 2>&1"`，
  之后只读文件轮询（`test_commands` 约 90 秒，含一次 ai 重启）。
- **改权限 / 配置解析 / 失败诊断先跑 `node 测试/test_access.js`**：它**不需要服务器**（纯逻辑），
  几秒钟就能确认 `canOp` / `canCommand` / `parseArgs` / 告警没被改坏。
- 想验证"连外部服务器"的分支又不想真找一台外服：服务器监听 `*:25565` 时用 `--host 127.0.0.2`
  就能连上，而 `127.0.0.2` 不在 `LOCAL_HOSTS` 里 → 会走"外部服"逻辑（见坑 34）。
- 性能参考：约 **0.26 秒/方块**（5×5 房子 100 格 ≈ 26 秒）。

---

## 七、已知限制 / 可改进点

- 非常大的建筑（数百格）耗时线性增长，无并行/批量放置优化。
- 若目标区域区块从未加载，`findGroundY` 可能探测失败（`blockAt` 返回 undefined，回退为 `y-1`）。
- 蓝图按**相对坐标**保存，不记录朝向；复现时不会旋转。
- 保存扫描依赖玩家手动放置金块/钻石块标记，无可视化框选。
- 建筑只支持 house / tower / pyramid 三种内置形状 + 蓝图复现。

---

## 八、软件面板与夜间回归（开发侧）

- **一个功能 = `源码/panel/api/` 下一个文件**：
  `module.exports = { id, title, order, status, summary, ui, routes, dispose? }`。
  前端 `app.js` 只认 `ui.type` 的五个渲染器（`cards` / `form` / `list` / `logs` / `custom`），
  所以**加功能不用改前端**；下划线开头的文件（`_util` / `_state` / `_procs` / `_fields` / `_profiles` / `_settings`）
  不算功能，是共享底座。
- **热重载只清功能模块的 `require.cache`**，`_util.js` / `_state.js` 故意保留 ——
  否则 `_state` 里的子进程句柄和输出缓冲会丢，面板就"忘了自己正在管哪个服务器"。
- **`ui.type='form'` 的后端只写自己声明过的字段**（`api/config.js` 的 `FIELDS`）：
  先整体校验（有一个不合格就一个都不写）→ 再读原文件、只覆盖这几个键 → 写回。
  顺序反过来就会出现"改一个端口，把用户 `config.json` 其它内容清空"的事故。
- **别动监听地址**：只 `127.0.0.1` + Host 头白名单（`127.0.0.1` / `localhost` / `::1`），
  静态文件有 `path.relative` 穿越保护，日志 / 资源接口都过 `safeFileName()`。
  面板能改配置、能起停进程，暴露到局域网等于把整台机器交出去。
- **`node --check` 通过 ≠ 代码没坏**：给大文件分块插入时，`insert_line` 差一两行会把
  函数体切到别处，语法却仍然合法（整段逻辑被塞进上一个函数、`module.exports` 没执行）。
  现象是"模块能 require，但 `Object.keys()` 是空的 / 接口全 404"。
  **排查口诀**：`node -e "console.log(Object.keys(require('./源码/panel/api/_procs.js')))"`，
  空的就说明有大括号没闭合到位。大文件优先**追加到末尾**，或先写小文件再拼。
- **工具函数别写在 `finally` / `if` 块里**：块级函数声明只在该块内可见，
  外面调用会报 `xxx is not a function`（`test_panel.js` 的 `isSubset` 踩过）。
- **夜间全量回归**：`node 测试/夜间回归.js`（或双击 `脚本\夜间回归.bat`）会自己起服务器、
  按 `TESTS` 顺序跑全部测试；每个测试独立进程 + 超时强杀（`taskkill /T /F`，连它 spawn 的 ai 一起），
  跑完按命令行匹配清残留 `bot.js` 进程，服务器掉了自动重启，最后写 `日志/夜间回归/最新报告.md`。
  `--reset` 是**改名备份** `服务器/存档`，不是删除 —— 无人值守的工具更不该带删世界的按钮。
- **面板"只在变化时重绘"靠的是 `stable()`**（`web/app.js`）：轮询拿到的新数据先剔掉
  `uptimeMs` / `latencyMs` / `rss` 这类每轮都在跳的字段再比 JSON，**一样就不重画**；
  另外每 15 秒补一次慢刷新（正在输入框里打字时跳过），否则"已运行 3 分"会永远停住。
  别把这些字段放回比较里 —— 那就变回"每 2 秒整块闪一次、输入内容被打断"。
- **面板的数据分两层，别混**：`配置/服务器配置.json` 是**分页档案**（可以存 N 套服务器），
  `config.json` 是**当前生效**的那份（ai 只读它）。「保存」只改档案；「应用到游戏」才抄进 `config.json`。
  好处是去看朋友服的配置不会顺手改掉正在跑的 ai；代价是用户会以为"保存了却没生效" →
  界面上必须提示（`appliedMismatch`）。
- **`ais.json` 里多了 `pid`**（`summonAI` 写）：面板靠 `process.kill(pid, 0)` 判断子 ai 是否还在。
  但 `ais.json` 会被**主 ai 启动时重置**，所以它是运行时视图、不是配置；面板的 ai 列表跟着主 ai 生命周期走。
- **玩家登记是"游戏里记、面板里看"**：`源码/玩家登记.js` 在 `playerJoined` / `spawn`（补记已在线的玩家）/
  收到指令时写 `配置/玩家登记.json`，按 `host:port` 分桶。同一个玩家一次进程只写一次盘（`registeredPlayers`），
  别改成每条聊天都写 —— 高频同步写文件会拖慢主循环。
- **服主 / 成员靠 `ai.owner`**：留空时所有进服的人都是成员（bot 启动会打一行提示）。
  成员的初始 ai 名 = `ai.guestPrefix` + 玩家名（默认 `way-`）。改名只改登记 + `ais.json` 的键，
  **在跑的进程名字改不了**（名字是登录时定的）——界面上必须写清楚，否则用户会以为改名失败。
- **性能页在 Windows 上的四个坑**：`os.loadavg()` 恒为 `[0,0,0]`（别显示它）；CPU 占用率必须
  **两次采样求差**（第一次一定 0%，前端先显示"—"）；磁盘用 `fs.statfsSync`（Node 18.15+，
  不支持就返回 `null`，界面显示"读不到"，**不能整个页面报错**）；**进程的 CPU 只能靠 PowerShell** ——
  `wmic` 在 Windows 11 24H2 已被移除（报 `无法将"wmic"项识别为 cmdlet`），`tasklist` 又只有内存，
  所以用 `Get-Process -Id 1,2,… | ForEach-Object { $_.Id + ' ' + [int64]($_.CPU*1000) + ' ' + $_.WorkingSet64 }`
  一次把所有 pid 问完（本机实测约 200ms，比 `tasklist` 全量列还快）；PowerShell 不可用时退回
  `tasklist`（只有内存），前端要说明"这台机器读不到 CPU"，别假装数字是 0。
  脚本里**只用单引号拼字符串**：`execFile` 传参时 `\"` 会被 PS 5.1 吃坏。
- **性能检测默认关闭，这是刻意的**：开关存在 `配置/面板设置.json`（`api/_settings.js`，不是 `config.json` ——
  那是游戏的配置）。关着时 `GET /api/perf` **只回 pid / 运行时长这类零成本数字**，不采 CPU、不列进程，
  前端也不开定时器。采样结果缓存 1.6 秒（多开几个标签页不会翻倍起命令）；开关一变就 `resetSamples()`，
  否则会拿几分钟前的累计 CPU 时间做差，算出离谱的百分比。面板自己的占用走 `process.cpuUsage()`（免费且准）。
- **成员视角的护栏在服务端**（`api/config.js` 的 `checkAiOwner`）：成员改 ai 必须带 `owner`（自己的游戏名），
  只允许改 `ais.json` 里 `owner` 匹配的 ai；主 ai 一律 400，别人的 ai 403；服主视角不传 `owner` 就不受限。
  面板没有登录，这不是安全边界，只是防"点错人" —— 真不想让人动就别把面板给外人开。
- **自定义界面（`ui.type='custom'`）拿不到 `app.js` 里的局部函数**：用 `window.panelUI`
  （`h` / `api` / `toast` / `fmtDur`）。视图自己管刷新：定时器里检查容器 `isConnected`，
  切页（`#view` 被清空）后自己 `clearInterval` —— 否则换十次页就攒十个定时器。

---

## 九、Git / 远端仓库（开发侧）

- 远端是 GitHub **私有库** `YanNuo26/AI-World`，分支 `main`。
  `.gitignore` 排除 `node_modules/`、`服务器/`、`日志/`、`*.log`。
  **别为了"备份完整"把 `服务器/` 提交上去**：jar + libraries + 存档从 118MB 起，GitHub 单文件硬限 100MB。
- **这台机器上探路用的 git 命令必须禁交互**：私有库缺凭据时 `git ls-remote` / `git fetch` 会一直等认证
  （甚至弹 GCM 登录窗），把终端挂住 —— 后续命令只能靠"抢占式关闭"才跑，输出还容易丢。
  先设 `$env:GIT_TERMINAL_PROMPT='0'; $env:GCM_INTERACTIVE='never'` 再试。
- 凭据存在 **Windows 凭据管理器**（GCM，target `git:https://github.com`），
  来自 VS Code 的 GitHub 登录（`gho_` 开头的 OAuth token）。
  在 VS Code 里退出账号 → 推送会失效，重新登录一次即可；也可 `cmdkey /delete:git:https://github.com` 清掉重来。
  推送时用 `git -c http.extraheader="AUTHORIZATION: basic <b64>" push` 临时传凭据，
  **不要**把 token 写进 `.git/config` 或远端 URL。
- **验证提交信息编码别被终端骗**：PowerShell 里 `git log` 显示中文乱码很常见（控制台编码问题），
  不代表仓库坏了，别急着 amend。取原始字节：`cmd /c "git cat-file commit HEAD > 日志\_raw.txt"` 再读该文件。
  同理 PowerShell 的 `>` / `Out-File` 默认写 **UTF-16**，重定向 git 输出会得到 `\u0000` 夹乱码。
- **零提交的新仓库改分支名**：`git branch -m main` 不生效（`refs/heads/master` 还不存在），
  用 `git symbolic-ref HEAD refs/heads/main`。
- 换行由 `.gitattributes` 定（仓库内 LF，`*.bat` / `*.ps1` 固定 CRLF）；`.ps1` 的 UTF-8 BOM 别被编辑器去掉。
