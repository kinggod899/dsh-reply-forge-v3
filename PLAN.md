# dsh-reply-forge v3 — 设计与实证

> 「让模型采信你改过的那句话」。  
> v1 只改页面，v2 改磁盘（要重启），**v3 直接改活会话——改完立即生效**。

本文只写**结论与证据**。所有关于宿主的断言都来自读 `@deepseek-ai/dsh-session@0.2.0-rc.2`  
的源码与在本机真宿主上跑通的测试，不写推测。

---

## 1. 一句话结论

对 `assistant/message` 做 surface replacement 在这版宿主上**结构上不可能**。  
唯一可行的「真伪造」路径是：**追加一条自有的纯日志事件 + 注册一个 message projection**。  
v3 就是这条路。

---

## 2. 为什么不能用 surface replacement（这条路的形状在本机宿主上必抛）

`@deepseek-ai/dsh-session/lib/types/surface.js` 里有两条互相咬死的约束：

```js
// assertSourceEventReferences(event, shadowedSeqs)
if (event.type === 'assistant/message' && raw !== undefined) {
    throw new Error('assistant/message embeds its source stream and cannot carry sourceEventSeqs');
}
// ...
const missing = shadowedSeqs.filter(seq => !sources.has(seq));
if (missing.length > 0) {
    throw new Error(`surface replace: sourceEventSeqs must include every shadowed surface node; missing ${missing.join(', ')}`);
}
```

- replace 事件**必须**用 `sourceEventSeqs` 覆盖每一个被遮蔽的节点；
- `assistant/message` **禁止**携带 `sourceEventSeqs`；
- 于是 `assistant/message` + `{op:'replace'}` 必然抛  
  `sourceEventSeqs must include every shadowed surface node`。

**本机实测**：把全部真实会话回放一遍，带 `replace` 的事件只有两种类型 ——  
`system/message`（38 次）与 `tool/result`（21 次），**没有任何一条 `assistant/message`**。  
这不是巧合，是上面两条约束的必然结果。

`tests/projection.test.mjs` 把这个约束钉成了回归测试（形状写对也照样抛）。

### 学习对象的源码级分析：`dsh-chat-thinking-editor@0.1.2`

> 本节是 2026-10-15 的**源码阅读记录**（对象版本 0.1.2、当时本机宿主 0.2.0-rc.2），
> 用途是理解「surface replacement 路线在当前宿主上为何走不通」的约束边界，
> **不是对该项目现版本的评价**；门面表述见 README 的「致谢与借鉴」。

| 位置                 | 代码                                                       | 后果                                                                 |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------ |
| `lib/index.js:119` | `for (const event of session.events)`                    | `Session` 上没有 `events`（只有 `log`），TypeError                         |
| `lib/index.js:151` | `surfaceOp: { op: 'replace', start, end }`               | 键名必须是 `startSeq`/`endSeq`，抛 `carries an invalid replace surfaceOp` |
| `lib/index.js:152` | `sourceEventSeqs: [target.seq]` 挂在 `assistant/message` 上 | 抛 `cannot carry sourceEventSeqs`                                   |

三处都改对之后，第 2 节的互斥约束仍然会把最后一种写法拦下。  
它的 README 说「底层走的是官方 surface replacement 事件（和 compact 那套是同一个东西）」——  
compact 确实用 surface replacement，但用的是 `user/message` / `system/message`，  
键名是 `startSeq`/`endSeq`，与它写的不是同一个东西。

> 公平地说：它的 peer 区间声明的是 `^0.1.1-rc.2`，本机宿主是 `0.2.0-rc.2`。  
> 老版本上是否可行无从验证（本机只装了这一个版本）。结论限定为  
> **「在当前宿主 0.2.0-rc.2 上必挂」**。

---

## 3. v3 的机制

宿主为「仓库外插件的事件类型」留的正门是 message projection：

```js
// SessionStore.registerMessageProjection(projection)
// projection = { type: string, project(event, context) => Map<seq, message> }
```

折叠时 `planSurfaceEvent` 先查同类型的 projection；命中就用它返回的  
`Map<seq, message>` 覆盖「该 seq 的模型可见消息」。`image/offload` 用的就是这条。

于是 v3 分两步：

1. **追加**一条自有事件 `reply-forge/patch`（纯日志记录，不带 `surfaceOp` /  
   `sourceEventSeqs`，因此不进 surface；但宿主持久化层仍会校验它 —— 必须带  
   `ignorable: true`，由写路径上的 shim 在落盘前补齐，见下一节）；
2. 注册同类型的 projection，把目标 seq 的消息按 patch 内容改写。

**关键约束：不能注册到 `assistant/message` 上。** `planSurfaceEvent` 里  
projection 分支在 surfaceOp 分支**之前**就 return：

```js
const projection = projections.find(item => item.type === event.type);
if (projection !== undefined) return { kind: 'project', ... };   // ← 这里就 return 了
// ...
if (surfaceOp === 'append') return { kind: 'append', seq: event.seq };
```

注册到 `assistant/message` 会让它走 `{kind:'project'}` 分支、**永远进不了  
`surface.nodes`**，压缩与遮蔽关系整条被打断。所以必须用自有事件类型。

### 自定义事件类型的相容性：一层标记、一层投影

宿主自己的注释把这条路写明了（`known-event-types.js` 文件头）：

> Downstream (out-of-repo) plugin events are outside this list by construction.  
> The persisted `SessionEvent.ignorable` marker is the compatibility mechanism.

`surfaceOpOf` 对未知类型的处理是：只要不带 `surfaceOp` / `sourceEventSeqs`，  
就返回 `undefined`（日志记录，不改 surface），**不报错**。  
但**持久化层**是另一回事——`validateStoredEvents`  
（`@deepseek-ai/dsh-session-persistence`）对未知类型**且未标记**的事件直接抛错、  
**拒读整条日志**：

```
session "<id>" contains event type "<type>" (seq N) unknown to this harness and
not marked ignorable; refusing to interpret the log — it was likely written by
a newer harness
```

宿主自带文档（`dsh-agent-preset/skills/cordis-plugin-development/references/practices.md`）  
把结论写死了：

> Do not append session events with a new `type`. Readers accept an unknown  
> stored event **only when its envelope carries `ignorable: true`**, and live  
> `Session.append()` cannot set that marker, so the Session would refuse to reopen.

而 `Session.append()` 确实不接 `ignorable`（只透传 `surfaceOp` / `sourceEventSeqs`），  
所以标记必须在**进入宿主持久化之前**补上——这就是 shim（包  
`persistContiguous` / `session/event` 两条写路径）存在的理由，也是  
P0「每个 patch 事件必须带 `ignorable: true`」的实测依据。

**插件被禁用时的行为分两层**：

| 层            | 缺标记时                             | 标记正确时                |
| ------------ | -------------------------------- | -------------------- |
| 持久化层（冷读/无投影） | 闸门拒读，**会话打不开**（用 `修复会话.bat` 补标记） | 闸门放行，事件按 opaque 记录跳过 |
| 投影层（插件在场）    | 投影被静默跳过 → 伪造退回原文                 | 伪造生效                 |

projection 里任何异常都退化成「不覆盖」而不是抛错 —— projection 抛错会让  
**整个会话折叠失败**。这是刻意的降级设计。

### P0：ignorable shim 与每会话写句柄核验

`Session.append()` 不接 `ignorable`，所以 v3 在**进入宿主持久化之前**补标记。  
两条写路径最终都汇到宿主持久化后端：

```
session/event ──► tracker.writers.get(id).enqueueLive   （200ms 批处理）
                        └─► drainLive ─► persistContiguous ─► 磁盘
handle.append（落盘路径）──────────────┘
```

shim 包在 `persistContiguous` 上（`server/ignorable.mjs`）：

- 从 `ctx.reflect.get('sessionPersistence')` 拿到真后端，给每个 `access==='write'`  
  的句柄的 `persistContiguous` 套一层 `stampIgnorable(batch)`；
- 只动 `reply-forge/patch` 自家事件，别家事件（含系统事件）**不加字段**；
- wrapper 用 Symbol brand + WeakSet 双重标记，便于后续自检与「后端被换掉」的发现；
- `ensureIgnorableShim()` 幂等：后端被宿主替换时保留 `shimCtx` 重装（热重载场景）。

**每次真写前还要核验目标会话的写句柄**（`verifySessionWriter`），因为  
"shim.ok 为真"不等于"这个会话的写句柄真被包住"：

| 核验失败                | 含义                                      | 处理                                        |
| ------------------- | --------------------------------------- | ----------------------------------------- |
| `WRITER_NOT_ROUTED` | `tracker.writers` 里没有这个会话的写句柄——宿主没在持久化它 | 在线写了也不会落盘；auto 模式**退回落盘**（无并发风险）          |
| `APPEND_UNSAFE`     | 有句柄但没被包住 / brand 丢失 / 被宿主换掉 / 结构不符      | 一律拒绝，**连 auto 也不退落盘**——此时改磁盘会和宿主持久化抢同一份文件 |

`tests/persistence.test.mjs` 用**真 Cordis + 真 JSONL 后端 + 真 SessionStore**  
验证整条闭环：`prepare → create → enter → announce → append → 200ms 批处理落盘 →
重读 → validateStoredEvents 放行`，并做负面对照（不装 shim → 闸门拒读）。

### 生效时机

| 场景           | 读取路径                                                          | 写入路径                                     | 生效时机            |
| ------------ | ------------------------------------------------------------- | ---------------------------------------- | --------------- |
| 会话在内存里（正在聊）  | `session.surface.nodes` + `deriveEventMessage()`（投影后，与模型所见一致） | `session.append('reply-forge/patch', …)` | **立即**，下一轮请求就带上 |
| 会话不在内存里（没打开） | 落盘文件                                                          | 改写 `.jsonl.zstd`（v2 路径）                  | 该会话下次被载入时       |

重启后伪造仍在：会话恢复走 `SessionStore.prepare({seed})` →  
`Session.fromRestore(..., this.projections)`，用的是**已注册的** projection 列表，  
而本插件在 `apply()` 里同步注册，早于任何会话恢复。

> 所以 `apply()` 里注册 projection 必须同步。晚一步注册，带 patch 的会话回放时  
> 会看不到伪造，而且**不报错** —— 属于最难查的那类问题。

### 焦点交还：保存时先把焦点还给宿主输入框（2026-10-16 真机 bug）

真机现象（用户报告）：「伪造输入保存后，下方输入框无法输入东西，没有光标显示，  
添加文件才能继续输入内容」。

根因不在写入链路，在 UI：编辑器就地插在消息块里，保存成功走  
`applyOverride(block, …)`，它第一件事 `block.textContent = ''` 把**整个消息块  
连编辑器一起抹掉**。此刻焦点正落在编辑器里的按钮/textarea 上（点击按钮 =  
mousedown 先聚焦），持有焦点的元素被销毁 → 焦点掉到 `<body>` → 打字没有接收者。  
宿主工具栏的 `keepDraftFocus`（mousedown 里把焦点拉回输入框）会让「+ 添加文件」  
看起来像解法——那是宿主在替我们治症状。

修法与 v2.2.2 同源同法（v2 有同一缺陷）：`focusHostComposer(doc)` 按宿主官方  
属性 `[data-composer-input]` 交还焦点；三个保存出口一律  
**先 `closeEditorOnBlock` 交还焦点，再 `applyOverride` 抹块**（反过来做时 wrap  
已不在文档里，`activeElement` 早就掉到 `<body>`，判断为时已晚）。细节与测试  
见 v2 PLAN §9.9，两侧首轮 4 项焦点回归一一对应；异步「写入伪造」还有专门  
回归测试覆盖按钮 disable 导致焦点提前掉到 `<body>` 的真机路径。

第二轮（交还本身可能不成立）：宿主 `ComposerContentEditable` 的  
`editable = live && !locked && !machineBusy`——hero 态 / 无会话 / 被锁 /  
机审中时那个 div 的 `contenteditable` 为 `false`，**根本不可聚焦**，  
`focus()` 是无操作。无头复现里也实测到了这一态（hero 态 `ce:false`，进会话  
变 `ce:true`）。所以：

1. `focusHostComposer` 返回结构化结果（`ok/editable/reason/detail`）并记入  
   `lastFocusHandoff`，保存后提示行如实报告（`focusNoteSuffix()`）——真机  
   复现时块上那一行就是第一手证据；
2. `keepComposerFocus` 守候 ~700ms：焦点掉回 `<body>` 就重交还，用户一操作  
   （keydown / pointerdown）立即收工，不跟用户抢焦点；
3. 调试命名空间 `__dshReplyForgeV3.focus()` 给出最近一次交还结果 + 此刻  
   输入框真实状态（`composer.editable` / `activeIsComposer`）。  
   v2 侧同源移植（§9.9 有对应测试）。

第三轮（用户实测差异：**仅本机渲染后输入框正常；写入伪造后仍不能输入**）：  
不是 composer inert，也不是通用的 close 时序。写入按钮点击后会立刻禁用按钮防重复，  
若按钮当前持焦，Chromium 在 `disabled=true` 当下就把焦点退回 `<body>`；异步写成功  
后才跑 `closeEditorOnBlock`，此时只检查当前 `activeElement` 已无法知道点击前焦点  
曾在编辑器里，于是跳过交还。仅本机渲染是同步路径、不会禁用按钮，所以正常。  
修复是在 disable 前快照 `hadFocusAtClick = wrap.contains(doc.activeElement)`，成功收尾时  
传给 `closeEditorOnBlock`；当前焦点是 body 且快照为真，仍交还；等待中用户主动移焦到  
其它控件则尊重用户，不抢焦点。提示行也如实标出「关闭编辑器时焦点已不在编辑器里」。  
DOM 桩模拟 disabled 当前焦点元素即掉焦，并有两条专项回归（body→composer、等待中用户  
移焦不抢）。v3 `client` 45 项、全量 218/13；v2 `client` 31 项、全量 81/81。

---

## 4. 事件与 projection 契约

### `reply-forge/patch` 数据体

```json
{
  "type": "reply-forge/patch",
  "seq": 1234,
  "time": 1760000000000,
  "data": {
    "version": 1,
    "targets": [
      { "seq": 42, "blockIndex": 1, "kind": "text", "text": "改后的正文" }
    ]
  }
}
```

- 不带 `surfaceOp` / `sourceEventSeqs`（未知类型带了会抛）；
- `blockIndex` 是 `content` **数组下标**（含工具调用块），与写入器 `locateTargets`、  
  `session-log.assistantEditableBlocks` 三处同口径，改一处必须改三处；
- `kind` ∈ `text` | `reasoning`（`thinking` 是 `reasoning` 的别名）。

### projection 的行为约定

- 基准消息取 `context.messages.get(seq) ?? source.data.message` ——  
  取「当前已投影的消息」而不是原始事件，多条 patch 才能**叠加**  
  （patch1 改块 0、patch2 改块 1 时两者都保留）。全量回放时事件按 seq 折叠，累积顺序一致。
- 目标 seq 不在 `context.nodes` 上 → **跳过**（已被压缩遮蔽，模型本来也看不见了）。
- 单条 target 失效 → 只跳过它，其余照常。
- 改推理块 → **连带剥掉 `signature` / `thinkingSignature`**：签名对的是原文，  
  正文一改就失配，部分 provider 会据此拒掉整条请求（离线路径 `stripSignaturesInEvent` 同规则）。

---

## 5. 失败码

写路由业务失败一律 HTTP 200 + `ok:false` + `code`，UI 拿 `code` 做分支而不是解析状态码。

| code                    | 含义                                                     | auto 模式下会退回落盘吗       |
| ----------------------- | ------------------------------------------------------ | -------------------- |
| `NO_SESSIONS_SERVICE`   | 宿主没有 sessions 服务                                       | 会                    |
| `SESSION_NOT_LIVE`      | 会话不在内存里                                                | 会                    |
| `WRITER_NOT_ROUTED`     | 宿主持久化没在跟这个会话（活的但不在写路由里），在线写了也不会落盘                      | 会（改盘无并发覆盖风险，落盘是正确出路） |
| `APPEND_UNSAFE`         | 没法确认事件落盘时会带 `ignorable` 标记（shim 装失败 / 写句柄没被包住 / 被宿主换掉） | **不会**（写坏会话的风险）      |
| `NO_CONTENT`            | 目标消息没有可编辑内容                                            | **不会**               |
| `SHADOWED`              | 目标 seq 已被压缩摘要遮蔽                                        | **不会**（原样上报）         |
| `NOT_ASSISTANT_MESSAGE` | 目标不是助手消息                                               | **不会**               |
| `NOT_EDITABLE_BLOCK`    | 目标块不可编辑（工具调用块 / 越界）                                    | **不会**               |
| `KIND_MISMATCH`         | 块种类与请求不符                                               | **不会**               |
| `STALE_TARGET`          | 内容与界面看到的不一致                                            | **不会**               |
| `APPEND_FAILED`         | 宿主拒绝追加事件                                               | **不会**               |

**为什么后几种不能退回落盘**：它们都是「用户以为在改 A，实际会改到 B」的信号。  
悄悄去改文件会让用户以为改成功了 —— 这是最坏的一类失败。

**`WRITER_NOT_ROUTED` 与 `APPEND_UNSAFE` 的区别（P0-1）**：两者都在线写不了，  
但安全含义相反。前者说明宿主**根本没有**在把这个会话写进它的持久化文件，  
改磁盘不会和它抢，落盘安全；后者说明宿主**正在**写、只是我们包不住它的出口，  
此时在线写会把缺标记的事件混进宿主文件（会话被闸门拒读），而落盘改写同一份文件  
又可能被宿主持久化并发覆盖 —— 两条路都不安全，只能拒绝并让用户显式选择。  
每次真写前的核验见 `ignorable.mjs:verifySessionWriter`（brand 标记 + WeakSet 双校验）。

---

## 6. 测试矩阵（233 项 / 13 套；21 项需真宿主，缺则 SKIP）


| 套件                         | 项数 | 覆盖                                                                                                                    |
| -------------------------- | -- | --------------------------------------------------------------------------------------------------------------------- |
| `persistence.test.mjs`     | 5  | **P0 闭环（真宿主）**：Cordis + 真 JSONL 后端 + 真 SessionStore，create → append → flush → 重读 → 闸门放行；无投影冷恢复退原文；负面对照（无 shim → 闸门拒读） |
| `ignorable.test.mjs`       | 28 | shim 三层：`stampIgnorable` 纯函数、装得上/装不上、**每会话写句柄核验**（brand + WeakSet，WRITER_NOT_ROUTED vs APPEND_UNSAFE）、真宿主闸门对照         |
| `record.test.mjs`          | 19 | 会话读取/结构还原                                                                                                             |
| `routes.test.mjs`          | 29 | 路由层：在线优先 / 落盘兜底 / `prefer` 语义 / **陈旧与危险块一律不退落盘** / APPEND_UNSAFE 连 auto 都拒 / **读路过投影、投影块拒绝落盘** |
| `session-repair.test.mjs`  | 15 | 修复工具：严格读取、毒行识别、未动帧原字节保留、修不好自动还原、幂等                                                                                    |
| `live.test.mjs`            | 14 | 在线层校验与失败码（假会话对象，无需 DSH）                                                                                               |
| `patch.test.mjs`           | 14 | patch 纯数据层：形状校验、块寻址、叠加、越界不抛                                                                                           |
| `session-log.test.mjs`     | 14 | 块清单口径（含 `kind`）                                                                                                       |
| `session-write.test.mjs`   | 16 | 落盘写入器（备份、原子写、自读校验、陈旧拒绝、**投影优先拒绝 PATCHED_TARGET**）                                                                                               |
| `client.test.mjs`          | 57 | 客户端产物：定位、双出口、**模式提示**、目标选择器（含思维链）、**保存后焦点交还**（§3「焦点交还」，含交还结果提示行 / 不可编辑输入框 / 异步写入 disable 焦点回归 / 调试 `focus()`）、页面内两步确认、陈旧自动重试一次 |
| `projection.test.mjs`      | 13 | **在真宿主 `dsh-session` 上**验证机制：立即生效、回放重现、插件缺席静默降级、投影累积、签名剥离、三条宿主硬约束回归                                                   |
| `session-anatomy.test.mjs` | 7  | 会话文件结构探针                                                                                                              |
| `build.test.mjs`           | 2  | 产物与源码一致（`--check`）、换目录构建字节等价                                                                                          |

跑法：逐个文件 `node tests/<文件>`（每套自己打印「全部通过（N）」），  
或 `node --test "tests/*.test.mjs"` 看总门禁（每套算 1 项，全绿即通过）。  
需要宿主包的套件按 `DSH_SESSION_PKG` 环境变量 → 逐级向上找 → 已知安装位置  
三级探测，**找不到就 SKIP 而不是失败**（发行包解开在没有 DSH 的机器上跑要能过）。

---

## 7. 与 v1 / v2 的关系

|        | v1                  | v2           | v3                |
| ------ | ------------------- | ------------ | ----------------- |
| 改的是什么  | 页面（localStorage 覆盖） | 会话落盘文件       | **活会话对象**         |
| 模型能看到吗 | 不能                  | 能            | 能                 |
| 生效时机   | 立即（只对本机）            | 需重启 / 会话重新载入 | **立即**            |
| 改思维链   | 不支持                 | 不支持          | **支持**（在线 + 落盘）   |
| 可逆     | 是（删覆盖）              | 有自动备份        | 在线不可逆（追加事件）；落盘有备份 |

三代**完全独立**（独立插件 id、独立 localStorage 前缀、独立样式前缀），  
但共用同一条消息操作条，**同时开会挂出多条**。安装脚本默认把更早两代从  
`bundles` 摘掉、保留其依赖与 junction，随时可一键开回。

---

## 8. 已知限制 / 下一步

- **页面上的思维链入口**：宿主把思维链渲染成可折叠行（子元素只有 `span`/`svg`，  
  没有块级子元素），picker 的 markdown 形状判定天然收不到它。v3 的做法是  
  在编辑器里加一个**目标选择器**，把宿主给的可编辑块清单（含思维链）列出来 ——  
  走 `seq + blockIndex` 寻址，与 DOM 长什么样无关。这绕开了对宿主折叠面板  
  DOM 结构的猜测，代价是多一次选择动作。
- **在线伪造不可撤销**：追加的事件进了日志。要还原只能再追加一条把原文写回的 patch。  
  落盘路径有 `.bak-forge-*` 备份，在线路径没有（也不该有 —— 它不碰文件）。
- **agent 正在跑时**：客户端在 `running` 状态锁住入口，避免与流式输出抢同一段文本。
- **`ignorable` 标记（P0，已封口）**：本版宿主的持久化准入闸门  
  `validateStoredEvents` 对未知类型**且未标记**的事件**直接拒读整条日志**  
  （不是「跳过」）。`Session.append()` 不接受 `ignorable`，所以 v3 在  
  写路径上包了 shim：在线走 `session/event` → 同一批处理落盘通道，  
  落盘走 `handle.append`，两条都在 `persistContiguous` / 落盘前补齐  
  `ignorable: true`；每次真写前还核验目标会话的写句柄确实被包住  
  （`verifySessionWriter`，假宿主 28 项 + 真宿主闭环 5 项）。  
  **遗留风险**：宿主未来若改 `KNOWN_SESSION_EVENT_TYPES` 的表或换落盘管线，  
  需重跑 `tests/persistence.test.mjs`（真宿主闭环）确认闸门口径没变。
- **DSH 运行时热卸载**：宿主对「用过某投影的会话」有 `_assertProjections`  
  硬保护，运行时摘掉插件再读会话会抛  
  `session message projection "reply-forge/patch" was removed`。  
  开关一律走 bat + 重启，不碰这条路。
- **已损坏的历史会话**：若日志里存在缺标记的 patch 事件，冷读会被拒。  
  用 `修复会话.bat`（退出 DSH 后）补标记，工具自带备份 / 原子写 / 复验 / 还原。

---

## 9. 下一步研究方向：① 升级自检 与 ③ 就地回溯（2026-10-23 源码级调研，均未实施）

> 本节是调研记录，不是承诺。①②③ 来自对 `dsh-ctxedit` 的参考点提炼；
> ②「版本血统」已作为 v3.4.0 交付（PR #14）。本节所有宿主断言来自本机
> 真宿主提取树（`DSH_APP_ROOT`）的出货源码：DSH 桌面端运行时
> **0.2.1-rc.2**（`dsh/desktop-runtime.json` 实证，`hostProtocolVersion=4`、
> node 24.21.0、pnpm 11.28.5），`@deepseek-ai/dsh-session@0.2.1-rc.2`。

### 9.1 先说事实：宿主已经漂了一次，而且带着一个潜在稳定性风险

- 本文主体（§2-§7）的源码分析基于 `dsh-session@0.2.0-rc.2`；本机现装
  **0.2.1-rc.2**。机制测试（21 项需宿主包的套件）一直对着提取树跑，
  行为兼容性是**被测出来的**；但没有任何东西在宿主升级后**主动提醒**
  「该重跑了」——本文的版本号此刻就是陈旧的。
- 0.2.1 的包里出现了本文未涉及的 API 面：`appendPluginRecord(session,
  type, data)` / `pluginRecordOf(event)` / `plugin:` 记录文法
  （`/^plugin:[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/`），
  自动带 `ignorable: true`。比现在的「`session.append` + shim 补标记」
  更原生，但它要求插件运行时 import 宿主包（新耦合），且 doc 注明
  「Only production source under `packages/experimental/` may call」。

**v3→v4 迁移会把我们的事件改名（本次调研最重要的发现）**：

- `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js` 的
  `namespaceV3OpaqueEvent`：迁移时把每条「未知类型 + `ignorable: true`」
  的事件改名为 `plugin:<原类型>`。我们的 `reply-forge/patch` 正落在
  这个集合里 → 变成 `plugin:reply-forge/patch`。
- 迁移由 `dsh-session-persistence-jsonl` 接线：读取历史世代（v3）会话
  文件时触发，staging 临时文件 + 摘要校验 + 原子替换，**写盘生成 v4
  后继文件**。也就是说：**在旧宿主上伪造过的会话，被新宿主打开一次，
  patch 事件就被永久改名**。
- 后果链条（全部静默，无报错）：投影按 `reply-forge/patch` 注册 →
  改名后 `planSurfaceEvent` 的 `projections.find(type)` 匹配不上 →
  事件按「未知 ignorable」不透明跳过 → **伪造内容退回原文**；
  `lineage.mjs` / `projectedTextsOf` 按类型匹配 → 版本链与投影基准
  同时失效。这正是 §3 说的「不报错的最难查的一类问题」。
- **本机实证（只读扫描，未动任何文件）**：69 个 v3 世代文件、265 个 v4；
  patch 事件共 57 条，全部在 14 个 v4 文件里且**类型未被改名**；
  v3 文件里 patch 事件为 0。即风险在本机是**潜在**的（没有历史遗留
  失假会话），但对「在 v3 世代宿主上伪造过、升级后才打开」的用户是
  现实存在的；且我们自己的落盘读（`session-log.mjs`）不做迁移，
  与宿主观上的分歧会长期放大。

**修复方案（小步、可测）——双类型接受**：

- 读侧全部接受 `reply-forge/patch` 与 `plugin:reply-forge/patch`：
  `src/patch-event.mjs` 新增 `PATCH_EVENT_TYPES` 集合 + `isPatchEventType()`
  帮助函数，`projectedTextsOf`（落盘投影基准）改用它；
  `src/lineage.mjs` 的 `versionStackOf` 同样接受；
  `.dsh-plugin/server/patch.mjs` 为**两个类型各注册一个投影**
  （宿主按类型去重，多类型互不干扰）；
  `.dsh-plugin/server/ignorable.mjs` 的 `OWN_EVENT_TYPES` 纳入两者。
- 写侧不变：新事件仍写 `reply-forge/patch`（live append 不改名，
  只有 v3→v4 迁移改）。`src/session-repair.mjs` 的 `poisonLines` 按
  「未知 + 缺 ignorable」通用判定，两种类型天然覆盖，**不用改**。
- 回归测试：① 单元级——两种类型的事件在 `projectedTextsOf` /
  `versionStackOf` / 投影上行为一致（无宿主也能跑）；② 宿主门控——
  用宿主自己的 v3 codec 合成含 patch 事件的 v3 日志，跑真
  `sessionFormatV3ToV4` 迁移，断言改名后投影/血统仍然解析
  （`DSH_APP_ROOT` 缺失则 SKIP，与既有 21 项同规矩）。

### 9.2 ① 升级自检（verify-host）设计

**现成资产**（全部只读、不起写）：

| 资产 | 能力 |
|---|---|
| `scripts/host-oracle.mjs` | 从真宿主 boot slim host + RPC `session/list`/`session/page` 端到端 |
| `tests/host-pkg.mjs` | 宿主包三级解析（env → 逐级向上 → 已知安装位置 + 本地私有配置） |
| `scripts/frame-anatomy.mjs` / `session-anatomy.mjs` | 真会话文件结构解剖（zstd 帧、事件分布） |
| `scripts/probe-typert.mjs` | 导入宿主自己的校验器逐包体检（「用宿主的尺子量宿主」范式） |
| `scripts/diag-focus.mjs` | 起真宿主 + 无头 Edge CDP 活体探针 |
| `tests/_probe-admission.mjs` / `_probe-gate.mjs` | 宿主门控的准入/闸门探针 |

**设计**：`scripts/verify-host.mjs`，分层探针，逐项 PASS/WARN/FAIL + 退出码：

- **T0 定位与版本基线**：解析宿主安装（复用 host-pkg 三级解析）；
  读 `desktop-runtime.json` 与 `dsh-session/package.json` 报版本；
  与仓库内 `host-baseline.json`（发布时钉住的 known-good：版本 +
  关键 API 形状 + 迁移行为，含 9.1 的改名断言）比对，不一致 → WARN。
  附带校验 app.asar 可按既有配方提取（诊断工具自身的依赖）。
- **T1 契约面**（import 提取树的宿主包，不起进程）：`Session.append`
  接受 `surfaceOp`/`sourceEventSeqs`；`registerMessageProjection` 存在；
  `KNOWN_SESSION_EVENT_TYPES` 仍含 `assistant/message`/`system/message`；
  持久化闸门对「未知+无 ignorable」仍拒读（负面对照）；
  `namespaceV3OpaqueEvent` 行为（我们的双类型接受的依据）；
  存在性检查 `appendPluginRecord`/`pluginRecordOf`（存在 → 提示评估迁移）。
  宿主依赖的测试套件（projection/persistence/ignorable 等 21 项）
  在此层强制跑——**缺宿主 = FAIL 而不是 SKIP**（这正是 SKIP 机制
  在发行包与开发机之间的语义差）。
- **T2 boot 冒烟**（`--boot`，复用 host-oracle 配方）：slim host 起得来、
  RPC 通、会话读得到。
- **T3 活体**（`--live`，复用 diag-focus CDP）：`[data-composer-input]`
  锚点、气泡 DOM 形态、`projections.faceOf('inbox').getSnapshot()` 形状、
  **活体 UI 按 surface 还是 append-origin 渲染**（③ 的开放问题，见 9.4）。

**用法**：`npm run verify-host`（T0+T1 默认；T2/T3 opt-in）；
「DSH 升级后必跑」写进 `使用说明.md` 与 bat。
**工作量/风险**：中（组装现有探针 + 基线清单）；零写风险（全部只读）。

### 9.3 ③ 就地回溯（rewind）设计

**用户效果**：在任意历史轮次上标记「从这里重新聊」——该点之后的轮次对
**模型**即时收起（上下文卫生），完整记录仍在（界面可见、可翻），之后从
标记点继续对话即生效。与 v3.4 血统的分工：血统管「一句话改错了怎么退」，
回溯管「一大段聊偏了怎么重来」。

**机制调研结论**（`dsh-session/lib/types/surface.js` + `dsh-agent-loop` 实证）：

1. **遮蔽的原语是 `surfaceOp: replace`，不是投影**。投影
   （`Map<seq, message>`）只能覆盖**已在 surface 上**的节点的消息，
   增删不了节点；replace 才能把 `[startSeq, endSeq]` 区间从 surface 上
   摘掉、换成新事件（`nodes.splice(startIdx, endIdx-startIdx+1, seq)`）。
2. **插件侧可用的精确形状**（宿主自己的系统提示管理器用的就是这套，
   `dsh-agent-loop` 的 `SystemPromptProjection.replace`）：
   ```js
   session.append('system/message', {
     turn, step,
     message: { id, role: 'system', content: [], source: { kind: 'system-prompt' } },
   }, {
     surfaceOp: { op: 'replace', startSeq, endSeq },
     sourceEventSeqs: [...区间内每个当前 surface 节点],
   })
   ```
   - `content: []` → `deriveEventMessage` 返回 null → **不占 wire message**，
     但保留 surface 位置——天然的无痕标记（宿主管有 blanking 旧系统提示
     同款用法）。注意非空 content 的 system 节点会在下次请求序列开始时
     被宿主管机 blanking 掉，所以标记必须空 content。
   - 硬约束（`surface.js` 实证）：`startSeq/endSeq` 必须是**当前**
     surface 节点；`sourceEventSeqs` 必须密铺所有被遮蔽节点、无重复、
     全部早于事件自身 seq；`assistant/message` 禁止带 `sourceEventSeqs`
     （标记物只能用 system/developer/user 消息）；node 0 是系统提示时
     只能被同类型单节点替换（**回溯点最早只能落在系统提示之后**）；
     `assertMessageEventShape` 要求 system 消息 `source.kind ===
     'system-prompt'` 且带非空 `id`。
   - **持久化原生**：`system/message` 是已知类型，不需要 `ignorable`
     shim、不碰现有写路径；重放时 fold 确定性重现同一遮蔽。这是相对
     patch 事件（P0 shim）的稳定性优势。
3. **单向性**：surface 词表里没有「取消遮蔽」——被 replace 摘掉的节点
   不在 surface 上，后续 replace 的区间定位（`indexOf`）找不到它们。
   **回溯不可逆**：被收起的轮次不能再进模型上下文（重新合成副本是
   ctxedit 式的重路，不作为 v1）。UI 必须如实说明。
4. **人的记录不受影响**：宿主历史/转录按 **append-origin 事件**构建
   （`dsh-api-session-controller/lib/types/history.js` 的
   `isAppendSurfaceEvent` 过滤实证）——被遮蔽的轮次在冷载界面照常可见。
   「界面同步收起」是插件客户端的活（在 W 后注入回溯标记 + 折叠尾部，
   沿用气泡文本回匹定位，不依赖 id 锚点）。
5. **待实证的第一问题**：**活体 UI 到底按 surface 渲染还是按
   append-origin 渲染**。冷载（history/page）已证实按 append-origin；
   若直播按 surface，回溯发生的瞬间被遮蔽轮次会从当前界面消失、重启后
   又回来——体验割裂，需要插件 UI 对冲。用 diag-focus 式 CDP 验证，
   这是 ③ 设计阶段第一个实验（T3 探针的附带产出）。

**三个设计决策点**（设计评审时拍板）：

- **标记物形态**：(a) companion record——额外追加一条
  `reply-forge/rewind`（ignorable，复用既有 shim 路径）携带
  {watermark, shadowedSeqs, time, reason}，UI 纯推导自它；
  (b) 无 companion——从「多节点 + 空 content 的 system replace」反推
  （零新事件，但宿主自己的 blanking 也是同形状，靠「多节点/含非 system
  节点」粗分辨，脆弱）。**建议 (a)**：消除歧义，且 shadow 事件本身
  仍用宿主管道（system/message）。
- **回溯与队列**：回溯不碰 inbox 队列；在途项照常在标记后作为新
  user message 送达。产品层需决定「回溯时在途项如何处理」。
- **与既有写路径的关系**：回溯是**新写杠杆**（首次让插件增删 surface
  节点），必须过真实宿主回环测试（`tests/persistence.test.mjs` 同款
  基建：真 SessionStore 上 append → 落盘 → 重读 → fold 验证遮蔽重现），
  失败一律 `{ok:false, code}` 不抛；agent running 时锁入口（既有约定）。

**风险清单**：形状错位可能「活体 append 过、重载 adopt 抛」
（`assertMessageEventShape` 在恢复路径跑）——必须回环测试兜住；
活体渲染口径未知（上文 #5）；不可逆的心理预期管理；shadow 后 forge
编辑器不再能定位被遮蔽块（与「模型也看不见」一致，UI 明示）。

### 9.4 ① vs ③ vs 9.1 修复：对比与建议

| 维度 | 9.1 双类型修复 | ① 升级自检 | ③ 就地回溯 |
|---|---|---|---|
| 用户价值 | 防静默失假（稳定） | 间接（稳定保障） | 直接（上下文卫生） |
| 机制可行性 | 高（类型集合 + 双投影注册） | 高（组装现有探针） | 中高（宿主原生 replace，形状与活体口径待实证） |
| 工作量 | 小 | 中 | 中高 |
| 风险 | 低（读侧扩容，写侧不动） | 零写风险 | 中（新写杠杆，需真宿主回环） |
| 紧迫性 | **高**（静默失效类） | 中 | 低 |

**建议顺序：9.1 修复 → ① → ③**。9.1 是把已发现的静默失效模式堵掉
（顺带成为 ① 基线清单的第一条断言）；① 把全部宿主契约面（含 ③ 要用的
`Session.append` surfaceOpts、`system/message` 形状、fold 重放、迁移
改名行为）钉成可复跑的基线；③ 动工前先补 T3 活体渲染实验。
