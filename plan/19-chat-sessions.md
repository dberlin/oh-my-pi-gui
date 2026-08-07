# 19 — Chat Sessions(纯对话会话，与 agent 类型严格隔离)

**Status**: 全部四个 Phase 已实现并验证(2026-08-06/07:17/17 + 600/600 契约与回归测试,实机验证全项通过——chat 无工具、上下文连续、压缩成功、跨类型隔离、TUI 纯头部重放)。UX 审计(2026-08-07)修复 6 项并发现+根除 mode 武装漏洞。

---

## 11. UX 审计(2026-08-07,实机驱动)

按真实使用逻辑审计前端交互,实测发现 6 项问题并当场修复 + 1 个深层漏洞:

| # | 问题(实测) | 修复 |
|---|---|---|
| 1 | + 按钮回归:最高频的"开 agent tab"从 1 点击变 2 点击 | 左键=agent(回 1 点击),右键=类型菜单;菜单开着时左键先收菜单 |
| 2 | + 菜单键盘不可用(无 Escape/方向键/Enter/焦点) | 全键盘支持 + `role="menu"`/`aria-haspopup` + 15/15 TabBar 测试(含键盘契约) |
| 3 | 跨类型开新 tab 零反馈,用户困惑 | info toast:"Opened in a new tab — agent and chat sessions stay separate." |
| 4 | chat 的 `/` 菜单提供静默死命令(/plan 等实测无响应) | 渲染层按 `CHAT_DEAD_COMMANDS` 过滤(plan/goal/loop/vibe/modes/task/tan/security);`/plan` 实测消失 |
| 5 | SessionPicker 无类型徽标(侧边栏有) | picker 行加 💬 徽标 |
| 6 | chat 欢迎页是 agent 话术("What should we build?") | chat 变体:"What's on your mind?" + 4 个会话向 starter(explain/draft/brainstorm/translate) |

**深层漏洞(审计中实机抓获)**:手打 `/plan` 经 GUI-only 内建命令映射 `set_plan_mode(true)`,在 chat 侧车隐身武装 plan mode——会话文件出现真实 `plan-mode-context`("Plan mode is active...read-only working tree...exit only via `xd://propose`"),与无工具状态矛盾;模型自述不在 plan mode,advisor 抓到矛盾。**菜单过滤挡不住手打输入,必须 agent 侧拒绝**:

- `AgentSession.restrictToolNames` 透传(sdk 构造 → session 访问器)
- 5 个 RPC handler 守门:`set_plan_mode`/`set_goal`/`guided_goal`/`set_loop_mode`/`set_vibe_mode` → `mode_unavailable_in_chat`;disarm 放行
- 活体验证:chat 全拒、agent 全开、disarm 放行;palette "Plan Mode" 开关实机报 "Plan mode is unavailable in a tool-free (chat) session."
- 布线测试钉死(`AgentSession.restrictToolNames` 暴露),防止"守卫在、flag 没接上"的静默死路  
**Goal**: 新增第二种会话类型 `chat` —— 无工具的多轮对话，上下文连续、自动压缩照常工作。类型在**创建那一刻定型**，agent ⇄ chat 双向都不可转换。

---

## 1. 需求与既有能力的边界

用户需求三条，其中两条是既有能力，一条才是真正的新工作：

| 需求 | 现状 | 结论 |
|---|---|---|
| 多轮对话带上下文 | chat tab = 一个常驻 omp agent session(jsonl 落盘）,多轮上下文是 `AgentSession` 默认行为 | **免费**。不是 `-p` 一发一会 |
| 上下文满自动压缩 | `checkCompaction`(`session-maintenance.ts:1194`)→ 阈值判定纯 token 算术(`:1367-1369`)→ `runAutoCompaction` → `compact()`(`packages/agent/src/compaction/compaction.ts:1396`)→ `generateSummary` 用 `instrumentedCompleteSimple`,Context **不带 `tools` 字段**(`compaction.ts:918-937`) | **免费**。压缩与工具注册表无关,`--no-tools` 不破坏它 |
| 类型从第一句起严格隔离 | 不存在任何"会话类型"概念 | **本文档的全部工作** |

`--no-tools` 本身已存在:`cli/args.ts:244-245` → `main.ts:1035-1040`(`options.toolNames = []`)。但直接让 GUI 拼 `--no-tools` 有三个洞，见 §2。

---

## 2. 为什么不是"GUI 拼 flag + GUI 侧注册表"

朴素方案:`IpcSpawnTabPayload` 加 `chatOnly`,GUI 拼 `--no-tools --append-system-prompt …`,再在 `prefs` 里存 `sessionFile → chat` 注册表。三个洞:

1. **注册表会漂移**。会话文件是 agent 写的、可被 TUI/CLI 打开/fork/move;GUI 的旁路映射迟早对不上(`session-manager.ts` 的 `previousSessionFiles`、`forkFrom` 都会改路径)。类型必须跟着文件走。
2. **resume 恢复不了**。`toolNames` 从不持久化(`SessionInitEntry` 只覆盖 subagent),重开会话时 agent 侧无从知道该关工具 —— GUI 不参与的路径(TUI `omp --session`)必然退化成 agent。
3. **active set 可被重新激活**。`--no-tools` 只把 active set 清空(`sdk.ts:3005-3023`),**注册表仍按全量构建**(`tools/index.ts:460-465`:`toolNames=[]` → `requestedTools=undefined` → 全量),且 `alwaysInclude`(`sdk.ts:3027-3032`)会把 extension 注册的工具无条件加回来。

**决策：类型的唯一真相是会话文件头。** GUI 只传一个原子 flag,agent 侧负责"关工具 + 换提示词 + 盖章 + resume 重放 + 拒绝跨类型切换"。

### 决策表

| 问题 | 选择 | 理由 |
|---|---|---|
| 类型存哪 | `SessionHeader.kind?: "chat"`(缺省 = agent) | 头部是唯一随文件走的持久位;loader 不 strip 未知字段(`session-loader.ts:256-261` 只校验 `type`/`id`),migration 不删字段(`session-migrations.ts:63-72`),整文件重写按引用序列化(`session-manager.ts:756` → `session-persistence.ts:291-293` 通用 walker) |
| 字段名 | `kind`,**不用 `sessionMode`** | `mode_change` entry 已占用 "mode" 语义(plan 模式,`session-entries.ts:233-236`),复用会歧义 |
| GUI→agent 接口 | 新增 CLI flag `--chat` | 原子:一个 flag = 关工具 + 提示词 + 盖章。GUI 无法只做对一半;TUI 也白捡 `omp --chat` |
| 工具关闭强度 | `toolNames=[]` 且打开 `restrictToolNames`,让注册表**建成空的** | 堵 §2.3 的重新激活洞;chat 会话不该有"可被激活的工具"。**Phase 1 首项任务验证** `restrictToolNames` 实际入口与 `alwaysInclude` 是否在 restricted 下回填 |
| 提示词 | `--append-system-prompt` 语义(bundled `.md`),不是 `--system-prompt` | 保留默认的 environment/workspace 块,只追加"你现在是纯对话助手，没有工具"。仓库约定 prompt 走静态 `.md`(AGENTS.md) |
| 跨类型 switch | **拒绝**,不是静默降级 | 运行中的 sidecar 无法换工具集(`agent-session.ts:7495-7603`,`previousTools`(`:7542`)只是回滚快照)。必须在 switch 前拒 |
| 转换能力 | 不提供。无按钮、无命令、无 RPC | 用户明确要求 |
| session version | **不 bump**(留 3,`session-entries.ts:5`) | 可选加字段,旧版读到直接忽略;bump 只留给语义破坏 |
| 跨 app 重启恢复 | 不做新持久化 | GUI 今天就不恢复 tab(`window.ts:186-196` 只存几何);用户重开会话时走 resume 路径,头部即真相 |

---

## 3. 架构

```
创建                          持久                        恢复 / 打开
┌────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ TabBar 新建菜单 │    │ session.jsonl        │    │ SessionIndex 读 head │
│  Agent / Chat  │───►│  header.kind="chat"  │───►│  → SessionInfo.kind  │
└───────┬────────┘    └──────────┬───────────┘    └──────────┬───────────┘
        │ IpcSpawnTabPayload.kind           │ main.ts:843-855 读 header    │
        ▼                                  ▼                              ▼
┌────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ SidecarPool    │    │ omp --chat            │    │ 打开前比对 kind:      │
│  PoolEntry.kind│───►│ toolNames=[] (restrict)│   │ 不同类型 → 拒绝/新 tab│
└───────┬────────┘    │ + chat prompt         │    └──────────────────────┘
        │             │ + header.kind 盖章    │
        │ IpcTabInfo  └──────────┬───────────┘
        ▼                        ▼ get_state.kind
┌────────────────────────────────────────────┐
│ renderer:useTabsStore → tab.kind           │
│  裁剪 composer / drawer / footer / chip 图标│
└────────────────────────────────────────────┘
```

三个不变量：

- **I1(单一真相)**:运行中 sidecar 的类型 = 其会话文件头的 `kind`。argv 是它的来源，头部是它的记录。
- **I2(不可变)**:一个 sidecar 进程的类型在 spawn 时定型，生命周期内不变。要换类型只能新开 tab。
- **I3(拒绝而非降级)**:任何会让类型与 sidecar 不符的操作都必须被拒绝并给出可路由的错误，绝不静默继续。

---

## 4. Phase 1 — coding-agent:类型的家(`packages/coding-agent`)

### 4.1 头部字段

**`src/session/session-entries.ts`**
- `SessionHeader`(`:27-45`)加：
  ```ts
  /** Session kind. Absent = "agent" (tools enabled). "chat" = tool-free
    * conversation; stamped at creation, never mutated. */
  kind?: "chat";
  ```
  只编码非默认值 —— agent 会话头部不写这个字段，老会话零变化。
- `NewSessionOptions`(`:48-56`)加 `kind?: "chat"`(供 `#resetToNewSession` 透传)。

**`src/session/session-manager.ts`**
- `#resetToNewSession`(`:1021-1037`):`kind: options?.kind` 写入头部字面量(与 `parentSession`/`providerPromptCacheKey` 同款可选写法)。
- `forkFrom`(`:2367-2377`,`:2506+`):**必须显式复制 `kind`** —— 该函数逐字段拷贝,不复制就会让 fork 静默变回 agent。同时检查其他两处 header 字面量是否同样需要携带。
- 新增静态读取:`peekSessionKind(filePath)`,复用 `peekSessionInit`(`:2608+`)的冷读模式(不拿写锁),供 §4.4 的 switch 守卫使用。

### 4.2 `--chat` flag

**`src/cli/args.ts`**
- `Args` interface 加 `chat?: boolean`。
- 解析分支贴着 `--no-tools`(`:244-245`)写。

**`src/main.ts`**
- Tools 分支(`:1035-1040`)改为先算生效 kind:
  ```ts
  const sessionKind = parsed.chat ? "chat" : (sessionManager?.getHeader()?.kind ?? "agent");
  ```
- `sessionKind === "chat"` 时:
  - **验证任务**:确认 `restrictToolNames` 的实际入口名与传递路径,并确认 `alwaysInclude`(`sdk.ts:3027-3032`)在 restricted 下是否回填 extension 工具;若仍回填,则在 chat 路径显式排除。
  - `options.toolNames = []` 且打开 `restrictToolNames`。
  - 追加 chat 提示词:新建 `src/prompts/chat-mode.md`,经 `options.appendSystemPrompt` 走既有链路(`:795-797`)。用户显式 prompt flag 时以用户值优先。
  - `parsed.chat` 为真时把 `kind: "chat"` 传给新建会话路径。
  - 显式 `--tools` 与 `--chat` 同时出现:以 `--tools` 为准,但不盖 chat 章。
- resume 路径无需额外代码:上面 `sessionKind` 已经把 `header.kind` 折进来了。

**`src/commands/launch-help.ts`**:`--chat` 的 flag 描述与 example。

### 4.3 RPC 暴露

**`src/modes/rpc/rpc-types.ts`**
- `RpcSessionState`(`:341-379`)加 `kind?: "chat"`。

**`src/modes/rpc/rpc-mode.ts`**
- `get_state` 响应字面量(`:1357-1394`)带上 `kind`。
- `session_info_update` 的 ad-hoc emit(`:1268-1270`)也带 `kind`。
### 4.4 跨类型 switch 拒绝(I3)

**`src/modes/rpc/rpc-mode.ts`**

`switch_session` handler(`:592-596`)在派发给 `AgentSession.switchSession` 之前:

```ts
const targetKind = peekSessionKind(cmd.sessionPath) ?? "agent";
const ownKind = session.getHeader()?.kind ?? "agent";
if (targetKind !== ownKind) {
  return { id, type: "response", command: "switch_session", success: false,
    code: "session_kind_mismatch",
    data: { expected: ownKind, actual: targetKind } };
}
```

理由:`switchSession`(`agent-session.ts:7495-7603`)只调 `sessionManager.setSessionFile`,构造好的工具集不动 —— 换过去就是"chat 文件在带工具的 sidecar 里跑"或反之,直接违反 I1。

**`branch`/`fork`/`handoff` 不需要守卫**:它们在**同一 sidecar 内**产生新会话,类型自动继承当前 sidecar 的 kind。`branch` 的 RPC schema 是 `{type:"branch"; entryId:string}`(`rpc-types.ts:118`),handler 只操作当前会话(`rpc-mode.ts:598-601`),无 `sessionPath`;kind 经 `forkFrom`(§4.1)字段复制自动继承。

### 4.5 Phase 1 测试

| 契约 | 位置 |
|---|---|
| `--chat` → 会话头 `kind:"chat"`,且 active tool set 为空 | `src/session/*.test.ts` 新增 |
| 跨类型 `switch_session` 返回 `session_kind_mismatch` | rpc-mode 测试 |
| `forkFrom` 保留 `kind` | session-manager 现有 fork 测试旁 |
| 未知/缺省 `kind` 视为 agent | 读既有 fixture |
| 跨类型 `switch_session`/`branch` 返回 `session_kind_mismatch` | rpc-mode 测试 |

---

## 5. Phase 2 — GUI main:类型贯通与守卫

### 5.1 类型契约

**`src/shared/ipc-types.ts`**
- 新增 `export type SessionKind = "agent" | "chat";`。
- `IpcSpawnTabPayload`(`:445-448`)加 `kind?: SessionKind`。
- `IpcTabInfo`(`:431-439`)加 `kind: SessionKind`。
- `SessionInfo`(`:482+`)加 `kind: SessionKind`。
- `IpcSpawnTabResult`(`:457-466`)加拒绝原因:`refusal?: "owned" | "kind-mismatch"`。
- `OmpApi.tabs`(`:707-722`)加 `getSessionKind(sessionPath): Promise<SessionKind>`(belt-guard 用,见 §6.2 错误处理)。

**`src/shared/rpc-types.ts`**
- `SessionInfoUpdateFrame`(未显式声明类型,是 `object`)加 `kind?: SessionKind` —— pool 的 `sessionInfoUpdate` 处理(§5.3)要读这个字段。

**`src/preload/index.ts`**:`tabs` 块桥接 `getSessionKind`。

### 5.2 sidecar argv

**`src/main/sidecar.ts`**
- `SidecarOptions` 加 `kind?: SessionKind`。
- `#spawn`(`:199-209`)追加 `--chat`:
  ```ts
  if (this.#options.kind === "chat") args.push("--chat");
  ```

**`src/renderer/lib/launch-profile.ts`**:`--chat` 加入 denylist(`:43+`)。

### 5.3 pool 记账

**`src/main/sidecar-pool.ts`**
- `PoolEntry`(`:64-91`)加 `kind: SessionKind`。
- `acquire`(`:147-152`)签名扩 `kind: SessionKind = "agent"`。
- `tabStatusPayload`(`:474-486`)带上 `kind`。
- `sessionInfoUpdate` 处理(`:202-217`):若帧的 `kind` 与 entry 不符 → `logger.error`。这是 I1 的运行时哨兵。
- 新增 `kindForTab(tabId)`。

### 5.4 会话列表读 kind

**`src/main/session-index.ts`**
- header 解析内联类型(`:310`)加 `kind?: "chat"`;`SessionInfo` 组装带上 `kind: header?.kind ?? "agent"`。

**`src/main/ipc.ts`**
- 新增 `GET_SESSION_KIND` handler(供 renderer belt-guard):先查 `sessionIndex` 缓存;未命中则冷读文件头(复用 `#parseSessionFile`)。返回 `SessionKind`,读取失败返回 `"agent"`(安全降级:打开时若类型真不符,三守卫点会拒绝)。

### 5.5 三个守卫点(镜像 F-OWN)

1. **`SPAWN_TAB`**(`ipc.ts:540-557`):payload 指定 kind 且与文件不符 → `{ tabId: null, refusal: "kind-mismatch" }`。
2. **RPC passthrough**(`ipc.ts:416-430`):issuer tab 的 kind vs 目标文件 kind,不符则合成 `code: "session_kind_mismatch"` 失败响应。
3. **`SESSION_OPEN_NEW_WINDOW`**(`ipc.ts:508-518`):新窗口 sidecar 按目标文件 kind spawn。

### 5.6 Phase 2 测试

| 契约 | 位置 |
|---|---|
| chat tab argv 精确为 `["--mode","rpc-ui","--chat"]` | `sidecar.test.ts`(argv-recording fake bun) |
| launch profile 里的 `--chat` 被 strip | `launch-profile.test.ts` |
| `acquire(kind)` → TAB_STATUS 携带 kind | `sidecar-pool.test.ts` |
| 跨类型 switch 被 main 拒绝 | ipc 层测试 |
| SessionIndex 从头部解析 kind | session-index 测试 |

---

## 6. Phase 3 — GUI renderer:创建入口与界面裁剪

### 6.1 store

**`src/renderer/stores/tabs.ts`**
- `SessionTab`(`:44-60`)加 `kind: SessionKind`。
- `openTab`(`:302-356`)签名加 `kind?: SessionKind`,透传给 `spawn`。
- `result.refusal === "kind-mismatch"` → toast。
- 新增 selector `useActiveTabKind()`。

### 6.2 创建入口

| 入口 | 改动 |
|---|---|
| TabBar `+` 按钮(`TabBar.tsx:194-202`) | 改为小菜单:New Agent Tab / New Chat Tab |
| 键位 | `keymap.ts` 加 `tab.new`(`⌘T`)、`tab.newChat`(`⇧⌘T`)。`App.tsx:288` switch 加两 case |
| 原生菜单(`main/menu.ts:59-63` 旁) | New Tab / New Chat Tab,**不声明 accelerator**(keymap 拥有快捷键) |
| 命令面板(`command-registry.ts:334-340`) | 两条 entry,调 `openTab({kind})` |

打开已有会话的路径(`use-session-switch.ts:48-84`)加 `getSessionKind` 预检:
```ts
const targetKind = await window.omp.tabs.getSessionKind(session.path).catch(() => "agent");
if (targetKind !== useTabsStore.getState().tabs.find(t => t.id === activeTabId)?.kind) {
  return openTab({ sessionPath: session.path, kind: targetKind });
}
```
与当前 tab kind 不符 → 直接 `openTab` 开新 tab(比报错更符合直觉)。`.catch(() => "agent")` 是安全降级:文件读取失败时假定 agent,若猜错,SPAWN_TAB 守卫会拒绝并给 toast。

### 6.3 界面裁剪(chat tab)

单一读点 `useActiveTabKind() === "chat"`,沿用 `{flag && (…)}` 短路。

| 位置 | chat 行为 |
|---|---|
| `ApprovalControl` | 隐藏 |
| `ComposerModes` | 隐藏 plan/goal/loop;保留 autoCompact/autoRetry |
| placeholder | 新 i18n key `input.placeholder.chat` |
| `PanelContainer` TABS(`:25-33`) | chat 只留 files+logs。`ui.ts:183` `setPanelTab` 加 clamp |
| `ActivityStrip` agents 段 | 隐藏 |
| `StatusFooter` | plan/goal/loop 徽标隐藏 |
| Tab chip | chat 加 `MessageCircle` 图标 + 区分色调 |
| 侧边栏会话列表 | chat 加图标徽标 |
| `/` 命令 | **验证任务**:实机确认哪些命令需过滤 |

`@` 文件引用**保留**:展开在 agent 侧 prompt 预处理(`agent-session.ts:5282-5293`),不是工具。**Phase 4 实机验证**是否仍工作。

### 6.4 i18n

双写 `locales/en.ts` + `locales/zh.ts`:`tabs.new.agent`、`tabs.new.chat`、`tabs.kind.chat`、`input.placeholder.chat`、`input.hint.chat`、`hotkeys.row.tabNew*`、`cmd.newTab*`、`toast.kindMismatch`。

### 6.5 Phase 3 测试

| 契约 | 位置 |
|---|---|
| `+` 菜单两项以正确 kind 调 spawn | `TabBar.test.tsx` |
| chat tab 下部分控件不渲染 | 新增 `mode-visibility.test.tsx` |
| chat tab drawer 仅 files/logs | PanelContainer/ui store 测试 |
| 打开不符类型会话 → 开新 tab | `use-session-switch.test.ts` |
| 新 keymap action chord 可解析 | `keymap.test.ts`(自动) |
| locale 双语 parity | `locales.test.ts`(自动) |

---

## 7. Phase 4 — 验证(实机为准)

1. `bun check` + 受影响测试。
2. **源码 sidecar 实机**(`bun --cwd=packages/gui run dev`):
   - ⇧⌘T 开 chat tab → 问需要读文件的问题 → **断言模型自述无工具**,tab 显示 chat 图标。
   - 同一 chat tab 连问 3 轮带指代 → **上下文连续**。
   - 并行开 agent tab → 两 tab 互不影响。
   - chat drawer 只有 files/logs;composer 无审批/plan/goal/loop。
   - `@` 文件引用在 chat tab 是否展开(§6.3 待验证项)。
3. **压缩实机**:chat tab 压低 `compaction.*` 阈值 → 灌多轮 → 观察压缩 toast + 对话可继续。
4. **隔离实机**:
   - chat tab 内 switch 到 agent 会话 → 应开新 tab。
   - `omp --session <chat 文件>` 用 TUI 打开 → **仍无工具**(证明头部真相 + resume)。
   - 对 chat 会话 fork/branch → 新文件仍是 chat。
5. **兼容实机**:打开旧 agent 会话 → 头部无 `kind`,行为不变。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| `restrictToolNames` 与 `alwaysInclude` 回填未核实 | Phase 1 第一项任务核实并加断言 |
| `forkFrom` 漏复制 `kind` | §4.1 显式列为改动点 + 专项测试 |
| `setPanelTab` 强制展开隐藏 tab | ui store 层 clamp(§6.3) |
| `@` 展开在无工具下失效 | Phase 4 实机验证;失效则关掉该补全 |
| upstream 同步冲突 | 改动是加法:可选头字段、flag 分支、`get_state` 字段、switch 守卫 |
| 用户在 launch profile 手写 `--chat` | 加入 denylist(§5.2) |

---

## 9. 明确不做(v1)

- agent ⇄ chat 转换:任何形式都不提供。
- 跨 app 重启的 tab 恢复:GUI 今天就不做,本特性不引入新持久化。
- 独立"聊天区":chat 会话仍按 cwd 分组。
- chat 专属模型/提示词偏好:先用全局选择。
- `SessionInitEntry` 式完整契约持久化:头部 `kind` 足够。

---

## 10. 工作量

| Phase | 范围 | 估算 |
|---|---|---|
| 1 | coding-agent:头字段 + `--chat` + RPC + switch 守卫 + 测试 | 0.5 天 |
| 2 | GUI main:IPC 契约 + argv + pool + SessionIndex + 三守卫 + 测试 | 0.5 天 |
| 3 | GUI renderer:四入口 + 界面裁剪 + i18n + 测试 | 0.75 天 |
| 4 | 实机验证 | 0.25 天 |

**总计 ~2 天**。Phase 1 必须先落;2 与 3 可并行。
