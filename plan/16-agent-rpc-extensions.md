# 16 — Agent RPC 扩展设计(Workstream A)

**状态**: A1 已交付(2026-08-05,13 命令中的 6 个 + cycle direction);A2/C1 未实施。源码核实于 2026-08-05。配套 [15-parity-closeout.md](./15-parity-closeout.md)。
**范围**: 在 `packages/coding-agent/src/modes/rpc/` 追加 11 个命令,全部是对**现成 session/manager 方法**的薄壳包装。不新增业务逻辑。

---

## 1. 既有扩展范式（必须遵循）

审计确认 RPC 层已有三种成熟范式，新命令按性质选一种，不要发明第四种：

| 范式 | 形态 | 现有样例 | 适用 |
|---|---|---|---|
| **read builder** | `buildRpc*Result(session)` 纯投影函数 | `rpc-domains.ts:57` `buildRpcSkillsResult` | 只读查询 |
| **apply action** | `applyRpc*(session, …)` 变更函数 | `rpc-actions.ts:53` `applyRpcSkillEnabled` | 一次性 mutation |
| **stateful controller** | `Rpc*Controller` 类,构造时注入 `{session, output, onError}`,通过第二个 `session.subscribe` 喂事件 | `rpc-modes.ts:33` `RpcVibeModeController`、`rpc-plan.ts:51` | 需要发事件/跨命令持有状态 |

多命令共享一个 handler 时的委派模板：`Extract<RpcCommand, …>` 子 union + `Pick<AgentSession, …>` 会话接口 + 导出 handler,见 `rpc-mode.ts:495-527` 的 `handleRpcSessionChange`。

### 1.1 每个新命令的必做清单

1. `rpc-types.ts` **RpcCommand union**(L37-199 末尾）追加成员。
2. `rpc-types.ts` **RpcResponse union**(L758-1019)追加对应 success variant。
   > **务必做**:`success()` 助手(rpc-mode.ts:730-739)会 `as RpcResponse` 强转,漏加 variant 不会报错但类型在说谎。审计已发现既存实例:`case "fork"` 活着但 response variant 不存在——本 workstream 顺手补上。
3. `rpc-mode.ts` `handleCommand` switch(L1098-2035)加 `case`。
4. GUI 侧 `packages/gui/src/shared/rpc-types.ts` 同名接口镜像,并让 `bun scripts/gen-types.ts --check` 通过（0.3.0 起是结构级 shape 检查，不再只比命令名）。
5. `preload/index.ts` 暴露方法;长耗时命令传 per-call timeout(0.3.0 起支持)。

### 1.2 协议版本

`negotiate_protocol` 只管**分帧**(v1 无 chunk / v2 有 `rpc_chunk`),**没有 per-command 版本门**。新命令无需版本协商；GUI 侧靠"命令不存在则报错"做特性探测(`SessionTreeDialog` 已有 feature-detect + fallback 先例)。

---

## 2. A1 批次 — 6 个低风险薄壳(含 `write_local_paste`,见 §4 #6)

### 2.1 `cycle_model` 增加 `direction`

**现状**:`{type:"cycle_model"}` 无参数(rpc-mode.ts:1342-1349);但 `AgentSession.cycleModel(direction: "forward" | "backward" = "forward")` **本身已支持方向**(agent-session.ts:6532),同样 `cycleRoleModels(roleOrder, direction)`(6547)。TUI 的 ⇧⌃P 走 `cycleRoleModel("backward")`。

**改动**:命令加可选 `direction?: "forward" | "backward"`,透传。默认 `"forward"` 保持向后兼容——GUI 旧版不传即原行为。

```ts
// rpc-types.ts — RpcCommand union
| { type: "cycle_model"; direction?: "forward" | "backward" }
```

**GUI**:`App.tsx` 的 ⇧⌃P 分支去掉 `TODO(rpc-gap)`,传 `direction:"backward"`。

**验证**:forward ×3 后 backward ×3 回到起点模型。

### 2.2 `retry`

**现状**:GUI 的 ⌥R 是客户端补偿——重发最后一条用户消息。TUI 的 `/retry` 调 `session.retry()`(builtin-registry.ts:1911-1919),语义是"重试上一个**失败的 turn**",返回 `didRetry: boolean`,假时 TUI 提示 "Nothing to retry"。

**改动**:`apply action` 范式。

```ts
| { type: "retry" }
// response: { success: true; command: "retry"; data: { retried: boolean } }
```

**GUI**:⌥R 与命令面板 retry 改走此命令;`retried:false` 时 toast "没有可重试的失败轮次"。保留旧的"重发最后一条"作为**独立**动作（语义不同，用户有时确实想重发），命名区分：`重试失败轮次` vs `重新发送上一条`。

### 2.3 `clear_context`

**现状(已核实,无待办)**:`/clear` 是 `handleTui`-only,调 `runtime.ctx.handleResetContextCommand()`。session 级方法**确实存在**:`session.resetSessionContext()`(agent-session.ts:3882),返回 `ResetSessionContextResult | undefined`。清上下文、保留会话 id 与会话文件、追加 reset 边界。UI 副作用留在 `command-controller.ts:964-995`,薄壳不碰。

```ts
| { type: "clear_context" }
// response: data: { cleared: boolean; droppedCount?: number }
```

**`undefined` 的两种成因**(不只是 streaming):streaming 中 **或** 前台 bash/eval 执行中(:3883-3889)。两者都映射 `cleared:false` + 错误码 `busy`。

**`droppedCount` 必须透出**:TUI 显示 "Context reset — N messages dropped"。只回 `{cleared}` 会丢掉这个用户可见信息。

**GUI**:`/clear` 从"prompt 转发"改原生动作;调用后重新 `get_transcript` + 刷新 context 用量条（照 0.3.1 的 `/compact` 修复模式，那次就是因为没刷新而"静默无反应"）。已有的"运行中禁止换会话"守卫复用。

### 2.4 `abort_subagent` / `revive_subagent`

**现状**:TUI agent hub 的 `x` = 杀单个子代理(agent-hub.ts:1100-1126):advisor 只读不可杀(notice 在 :1071-1074)→ `ref.session.abort({reason: USER_INTERRUPT_LABEL})` → `lifecycle().release(id, ref, {tombstone:true})`;`r` = 唤醒 parked。GUI 只能 abort 整个 turn。

**改动**:两个 apply action,调 `AgentLifecycleManager.global()`(registry/agent-lifecycle.ts:92)。

```ts
| { type: "abort_subagent"; id: string }
| { type: "revive_subagent"; id: string }
// response: data: { ok: boolean; reason?: string }   // reason: "advisor_readonly" | "not_found" | "not_parked"
```

**API 名称修正**:`release(id, expected?, {tombstone})` 存在;但"唤醒"的公开方法是 **`ensureLive(id)`**(`#revive` 是私有),它对 未知 id / 未 parked / 无 reviver **抛普通 Error**。薄壳必须 try/catch 把 Error 映射成上面的 `reason` 码——这是本命令唯一的实际逻辑。

**要点**:advisor transcript 不可杀,RPC 返回 `reason:"advisor_readonly"`,GUI 侧该行按钮禁用并 tooltip 说明——不要等到点了才报错。

**GUI**:`AgentHubWindow` 行内加 abort/revive 按钮 + 确认;状态靠既有 `subagent_lifecycle` 事件更新（注意 0.3.0 修过：这些帧是 `{type,payload}` 嵌套结构）。

### 2.5 扩展命令 RPC 分派

**现状**:RPC `prompt` 的链是 `loopModeController.onHostPrompt → tryRunRpcSkillCommand(仅 skill) → executeAcpBuiltinSlashCommand(仅有 handle 的 builtin) → session.prompt()`。

**关键发现**:`session.prompt()` **内部本来就会**依次尝试 `#tryExecuteExtensionCommand`(agent-session.ts:5339-5365) → `#tryExecuteCustomCommand`(5445-5485) → `expandSlashCommand`。也就是说**扩展命令与自定义命令在 RPC 下已经能执行**——它们走的是 prompt 内部链，不是 acp-builtin 链。

**因此本项从"加分派"降级为"验证 + 补 UI 短板"**:
1. 实测 GUI 下 `/autoresearch` 是否执行（预期：会执行，输出经 `extension_ui_request setWidget` 过线）。
2. 真正的缺口在**上下文能力**:扩展命令拿到的 `ExtensionCommandContext.ui` 在 RPC 下是 `RpcExtensionUIContext`(rpc-mode.ts:773-968),支持 dialog/notify/status/**widget** 帧;但 `api.registerShortcut` 注册的快捷键(autoresearch 的 ⌃X)不过线,overlay 类 UI 也不过线。
3. **另一处真实限制**:`session.followUp` 对扩展命令文本会抛错(agent-session.ts:5508-5510),`steer` 同理(`#throwIfExtensionCommand`)。GUI 在 streaming 中输入扩展命令必须走 `prompt` 而非 steer/followUp——0.3.1 已经为斜杠命令做过这个修复（"总是走 prompt RPC"），需确认覆盖扩展命令。

**改动**:agent 侧可能零改动。GUI 侧：
- `setWidget` 帧已被消费（P4 已修），确认 autoresearch 的 dashboard 行能显示。
- ⌘K 面板把扩展命令从 TUI-only 移出（`get_available_commands` 已带 `source:"extension"`）。
- 扩展注册的快捷键：GUI 侧无法接收，在面板里以命令项形式暴露（不做快捷键）。

---

## 3. A2 批次 — 7 个中等薄壳

### 3.1 `import_foreign_session`

**现状（好消息）**:导入机制已完整存在,不需要重写转换器。

```ts
// session/foreign-session-store.ts
interface ForeignSessionStore {
  list(): Promise<ForeignSessionInfo[]>;
  load(info: ForeignSessionInfo): Promise<SessionManager>;   // 非持久化 SessionManager
}
// session/foreign-session-import.ts
createForeignSessionStore(source)            // :9   → claude | codex store
foreignSessionSourceName(source)             // :14
foreignSessionInfoToSessionInfo(info)        // :19
persistForeignSession(...)                   // :36-48 → persistCopy 写出全新 omp 会话文件 + foreign_session_import 面包屑
```

实现:`ClaudeSessionStore.list()`(claude-session-store.ts:314)读 `~/.claude/history.jsonl` + projects;`CodexSessionStore.list()`(codex-session-store.ts:468)读 `bun:sqlite` state DB + rollouts。TUI 的 `/resume @claude` 走同一套(builtin-registry.ts:1849-1857)。

**改动**:两个命令。

```ts
| { type: "list_foreign_sessions"; source: "claude" | "codex" }
//   → data: { sessions: Array<{ id, title?, cwd?, updatedAt, messageCount? }> }
| { type: "import_foreign_session"; source: "claude" | "codex"; id: string }
//   → data: { sessionPath: string; sessionId: string }
```

**性能**:`list()` 可能扫大量文件/查 SQLite。列表命令必须走**后台派发**(照 bash/eval 的 `dispatchRpcInputFrame` 模式 rpc-mode.ts:358-368),不能阻塞串行命令队列;GUI 侧给 per-call timeout 与加载态。

**错误语义**:源不存在(未装 Claude/Codex)→ 错误码 `source_unavailable`,GUI 隐藏该 tab 而非报错。

**GUI**(设计要点):
- 入口:命令面板"导入外部会话" + 会话侧栏"+"菜单里一项。
- 对话框:左侧源 tab(Claude / Codex,不可用的置灰并注明原因),右侧列表（标题、工作区、时间、消息数）+ 搜索 + 多选。
- 导入后:单选 → 直接在当前窗口打开;多选 → 全部导入,询问是否打开第一条（不自动开 N 个窗口，会撞 10 窗口上限）。
- 导入是**拷贝**语义（写全新会话文件），UI 文案要说清"不会修改原始 Claude/Codex 数据"。

### 3.2 `fork_from` — 从历史节点新建独立会话

**现状(核实修正)**:`session.fork()`(agent-session.ts:6406)**无参数**;`SessionManager.fork()`(:1339)与 `forkFrom`(:2471)**同样不接受截断点**。所以"从某点 fork"不是给现有命令加参数,而是**新逻辑**。

**并且现有 `fork` 命令不能改签名**:它的响应是 `{cancelled}`,GUI `CommandPalette.tsx:196-236` 的 `forkSession` 已在消费这个形状。给它加 `entryId` 并改 data 形状会破坏该消费者。

**决策:新增独立命令 `fork_from`,不动 `fork`。**

```ts
| { type: "fork_from"; entryId: string }
//   → data: { sessionPath: string; sessionId: string }
```

实现:`sessionManager` entries 投影到 `entryId`(含)为止 + `persistCopy`——与 `persistForeignSession`(foreign-session-import.ts:36-51)同一套写出机制。**不切换当前会话**:返回路径,由 GUI 决定在新窗口打开。这与 `session.fork()` 的"克隆并切换"语义不同,必须保持区分。

**顺手补既存缺陷**:`fork` 的 case 活着(rpc-mode.ts:525-528、:1196)但 `RpcResponse` union **没有** `fork` variant(只有 `switch_session`:877、`branch`:878),靠 `success()` 的 `as RpcResponse` 强转(:730-739)掩盖。补上 `fork` 与新的 `fork_from` 两个 variant。

### 3.3 `switch_leaf` — 基于 `navigateTree`(重写)

**核实修正(原设计作废)**:不需要"寻找 session 侧机制"也不需要"最近祖先归一化"。`session.navigateTree(targetId, opts)` **已存在**(agent-session.ts:7879),文档注释即 *"Unlike branch() which creates a new session file, this stays in the same file"*,接受**任意 entry id**(无 user-only 门控),且已暴露给扩展(:5409)。TUI tree-selector 的 Enter 走的就是它(selector-controller.ts:1255-1262)。

对比:`branch(entryId)`(:7640)对非 user entry **抛** "Invalid entry ID for branching"(:7647-7649)——role gate 只是 branch 的约束,不是 navigateTree 的。

```ts
| { type: "switch_leaf"; entryId: string; summarize?: boolean; customInstructions?: string }
//   → data: { activeLeafId: string; cancelled?: boolean; reopenAsk?: boolean;
//             editorText?: string; editorImages?: string[] }
```

**必须透出 navigateTree 的全部返回语义**,漏一个就是行为分歧：

| 返回位 | 含义 | GUI 必须做 |
|---|---|---|
| `cancelled` | hook 否决了切换 | **不能**假装成功。这正是 0.3.x "静默重新 hydrate" 那一类回归 |
| `editorText` / `editorImages` | 目标节点处的草稿 | 恢复到 composer。TUI 会恢复(selector-controller.ts:1292-1294);GUI 漏掉就是丢用户输入 |
| `reopenAsk` | 目标是 ask toolResult,需重开审批 | 重新弹审批对话框 |
| `aborted` | 切换期间被中断 | 保持原状 + toast |

`summarize` 对应 TUI 的 shift+enter"总结并切换"。**一并实现**——它是 tree-selector 的既有能力,不做就是降级。

**GUI**:`SessionTreeDialog` 三个动作(详见 [18 §6](./18-management-surfaces.md#6-会话树叶节点操作)):

| 动作 | RPC | 结果 | 会话 id |
|---|---|---|---|
| 切换到此处 | `switch_leaf` | 当前会话活跃叶移动（同一文件） | 不变 |
| 从此处分支 | `branch`（已有，仅 user 节点） | 当前会话内新分支 | 不变 |
| 在新窗口打开 | `fork_from` → `window.open` | 独立新会话（截至该点副本） | 新 |

### 3.4 guided-goal + `allowArgs` 补线

**guided-goal 现状**:`handleTui`-only(builtin-registry.ts:500),本质是往会话注入一段访谈 prompt(`src/prompts/goals/` 模板),让 agent 在聊天里问用户几个问题,最后设 goal。产物走 `set_goal`(已有 RPC)。

**降级决定(2026-08-05,阶段 3 实施时)**:agent 侧 `handle` **不做**。实施调研发现访谈 kickoff 依赖 `#goalModePreviousTools` 的工具集恢复簿记——那是 interactive-mode 的**私有状态**(goal 退出时恢复访谈前的工具集)。RPC 侧没有对应物,加它不是薄壳而是真功能(goal 退出时的工具集恢复要落进 rpc-modes 的 GoalModeController)。**替代**:GUI 原生向导(ModesPanel Goal tab 表单 → 既有 `set_goal` RPC)覆盖 goal 设置,零隐藏状态。若将来要 RPC 化访谈,需先在 rpc-modes.ts 补工具集恢复簿记。

**GUI 原生向导**(桌面形态):`ModesPanel` 的 Goal tab 加"引导设置"表单——目标、token 预算。表单直接 `set_goal`,跳过访谈往返。

**`allowArgs` 补线**(为 B2 的斜杠参数补全服务):

`RpcAvailableSlashCommand`(rpc-types.ts:235-242)已带 `subcommands[].{name,description,usage}` 与 `input.hint`——**静态**参数补全所需数据已在线上。缺的是:

```ts
// 追加两个布尔字段(available-commands.ts:30-97 的 builder 里填)
allowArgs?: boolean;              // 命令是否吃参数(决定要不要在空格后继续提示)
hasDynamicArgCompletion?: boolean; // 是否存在动态候选(如 /mcp 的 server 名、/move 的目录)
```

动态候选（MCP server 名、目录）需要真数据，另加一个查询命令：

```ts
| { type: "get_command_arg_completions"; command: string; prefix: string }
//   → data: { items: Array<{ value: string; label?: string; description?: string; hint?: string }> }
```

**性能**:GUI 侧对该命令 debounce(≥120ms)+ 结果按 `command+prefix` 缓存;`hasDynamicArgCompletion:false` 的命令**根本不发**这个请求（纯静态本地算）。

---

## 4. 汇总:13 个命令的线路清单(A 批次)

| # | 命令 | 范式 | 批次 | 调用的现成能力（已核实） |
|---|---|---|---|---|
| 1 | `cycle_model.direction`(改) | 现有 case 透参 | A1 | `cycleModel(direction)` agent-session.ts:6532 |
| 2 | `retry` | apply | A1 | `session.retry()` :7037 → turn-recovery.ts:1980 |
| 3 | `clear_context` | apply | A1 | `session.resetSessionContext()` :3882 |
| 4 | `abort_subagent` | apply | A1 | `session.abort()` + `release(id, ref, {tombstone})` |
| 5 | `revive_subagent` | apply | A1 | `ensureLive(id)` + Error→reason 映射 |
| 6 | `write_local_paste` | apply | A1 | `resolveLocalRoot` + 计数器（**见下方说明**） |
| 7 | `list_foreign_sessions` | read（后台派发） | A2 | `ForeignSessionStore.list()` |
| 8 | `import_foreign_session` | apply | A2 | `persistForeignSession` :36-51 |
| 9 | `fork_from` | apply（新，不改 `fork`） | A2 | entries 投影 + `persistCopy` |
| 10 | `fork` / `fork_from` response variants | 补 union 缺口 | A2 | — |
| 11 | `switch_leaf` | apply | A2 | `session.navigateTree()` :7879 |
| 12 | `get_command_arg_completions` | read | A2 | `getArgumentCompletions`（**需重新 plumb**，见下） |
| 13 | guided-goal `handle` | builtin 补 handler | A2 | 既有 `handleTui` 注入逻辑 |

**#6 `write_local_paste`(审计补漏)** — 17 §3.3 的"存为文件"依赖它,但原清单漏了,导致 B1 被错标为"零 agent 改动"。

```ts
| { type: "write_local_paste"; content: string }
//   → data: { name: string; url: string }   // name 如 "paste-3.md",url 如 "local://paste-3.md"
```

计数器必须由 agent 分配:TUI 的 `#pasteCounter` 是 **InputController 实例级**(input-controller.ts:184-186),两个窗口连同一会话时各自从 1 起,会互相覆写 `local://paste-1.md`。agent 侧按目录现有文件取下一个可用编号。**因此 B1 不是零 agent 改动**:要么把"存为文件"推到 A1 之后,要么在阶段 1 的门里降级该路径(15 §4 已按前者修正)。

**#12 不是纯读字段**:`getArgumentCompletions` 由 `buildMcpArgumentCompletions(subcommands, runtime)` / `buildDirectoryArgumentCompletions()`(builtin-registry.ts:3052-3059)在 **TUI runtime ctx** 下构造;扩展命令自带(types.ts:1083)。RPC 侧需要用 RPC 的 runtime 重新 plumb,不能直接读取现成字段。

C1 批次的 MCP/marketplace/插件命令(9 个)见 [18-management-surfaces.md](./18-management-surfaces.md)。**A 批 13 + C 批 9 = 22 个新命令**,现有 82 → 104。

## 5. 实施纪律

- **两次重建,不是一次**:A 批(13 命令)落地后重建一次进 V1;C 批(9 命令)落地后再重建进 V2。开发期一律用**源码 sidecar** 验证,不重建。
- **重建 = 双架构**:`build:omp` 与 `build:omp:x64` 都要跑(packages/gui/AGENTS.md 的发布契约),不是单 arm64。若期间同步过 upstream,先按 `scripts/sync-upstream.sh` 重新 provision natives 再 build。
- **文件落点**:`rpc-session-extra.ts`(3/9/10/11)、`rpc-foreign.ts`(7/8)、`rpc-agents.ts`(4/5)、`rpc-paste.ts`(6)四个新文件 + `rpc-actions.ts` 追加(2);`rpc-mode.ts` 只加 case 与 import。upstream 合并时冲突只落在 switch 与 import 两处。
- **测试落点**:`packages/coding-agent/test/rpc-*.test.ts`(已有 15 个同类文件 + `fixtures/mock-rpc-agent.ts`)。每个命令至少一条契约测试,清单见 [15 §4.6](./15-parity-closeout.md)。
- **陈旧 sidecar 风险**(dev-only):源码 sidecar 落后时 `cycle_model` 会**静默忽略** `direction` 而继续前进循环——与 0.3.0 的 `toolcall_delta` 同类的"静默错行为"。`negotiate_protocol` 只管分帧,不覆盖命令级能力。开发期若出现"⇧⌃P 不后退",先确认 sidecar 是不是旧的。
- **不做**:不在薄壳里加重试/校验/遥测;不"顺便"重构既有 case。
