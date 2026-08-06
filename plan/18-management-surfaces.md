# 18 — 管理面板设计(Workstream C)

**状态**: plan,未实施。源码核实于 2026-08-05。配套 [15-parity-closeout.md](./15-parity-closeout.md)。
**范围**: MCP 服务器管理（添加向导/连接测试/重新授权）、marketplace 安装升级、插件配置编辑器、Agent Hub 单代理控制、会话树叶节点操作、启动配置 profile。

---

## 1. 现状与所有权边界

现有 `ExtensionsPanel`(skills/hooks 开关 + MCP enable/disable/reconnect/remove)与 `InventoryPanel`(plugins 开关,marketplaces/templates/memory 只读)。缺的是**创建/配置/授权**类操作。

**所有权决策(重申 §15.3.3)**:所有 `~/.omp/agent/` 写入走 agent RPC。GUI 主进程不直写 MCP 配置与插件 lock 文件。硬证据：

- `mcp/config-writer.ts` 是**带锁原子写**;`mcp/config.ts` 有 `validateServerConfig`。绕过 = 多窗口并发损坏。
- **不存在 mcp.json 文件监听器**。写完必须由 agent 执行 reload,否则配置与运行态分裂。
- `omp-plugins.lock.json` 由 `PluginManager` 内存缓存 `#runtimeConfig`,`#saveRuntimeConfig` 是**无锁非原子** `Bun.write`。GUI 直写必丢。

---

## 2. MCP 管理

### 2.1 新增 RPC(apply action 范式,落在新文件 `rpc-mcp-extra.ts`)

```ts
| { type: "mcp_add"; name: string; config: RpcMcpServerInput; scope?: "user" | "project" }
| { type: "mcp_test"; name?: string; config?: RpcMcpServerInput }   // 二者之一:测已存在的 or 测草稿
| { type: "mcp_reauth"; name: string }
| { type: "mcp_reauth_cancel"; name: string }
```

`RpcMcpServerInput` 覆盖 `MCPServerConfig` 的全部字段（向导需要收集的）:transport(stdio/http/sse)、command+args+env(stdio)、url+headers(http/sse)、超时、oauth 相关。**以 agent 侧 `mcp/types.ts` 的 `MCPServerConfig` 为准逐字对应**,不自己发明子集。

### 2.2 三个操作的实现要点

**`mcp_add`** — 用 `addMCPServer`(config-writer)+ **定向连接**:照 `applyRpcMcpAction` 的 enable 分支用 `connectServers`(manager.ts:416),**不要**用 `discoverAndConnect`(L393,重量级全量发现)。remove 分支才走全量重发现。

**`mcp_test`** — **必须用一次性 manager,绝不碰单例**。照 `helpers/mcp.ts` 的 `withPreparedMcpConnection`(L204):

```
new MCPManager(cwd)                      // 不是 MCPManager.instance()
  → setAuthStorage(session.modelRegistry.authStorage)
  → prepareConfig → connectToServer → listTools
  → finally: disconnect(必须保证)
```

返回 `{ ok, toolNames?, toolCount?, error? }`。**不是无副作用操作**:会 spawn stdio 子进程、可能触发 OAuth token 刷新的网络调用。UI 必须显示"测试中"并允许取消（超时兜底）。

**`mcp_reauth`** — 复用 `mcp-command-controller` 的 `#handleOAuthFlow`(743)/`#handleReauth`(1763)/`#resolveServerForAuth`(1084)——这些**纯逻辑部分已经与 UI 无关**。差异处理：

- 授权 URL 以**流式事件**发出(新事件帧 `mcp_auth_prompt {name, url, launchUrl?, instructions?}`),GUI 用 `shell.openExternal` 打开。**绝不**在 agent 侧开浏览器。
- 命令响应在 login 完成 + 持久化(`updateMCPServer`,注意**保留 `${ENV}` 占位符原样**)+ reload 之后才 resolve。GUI 侧给长 timeout。
- 取消:`AbortController` 替代 TUI 的 `editor.onEscape` 钩子。
- **互斥**:OAuth 单例有 `oauthManualInput` claim,同时只能一个流程。第二个请求返回错误码 `oauth_busy`,GUI 提示"已有授权流程进行中"。

### 2.3 `RpcMcpServerInfo` 字段扩展

审计确认现有返回**缺** scope / command / url / error 字段——GUI 卡片要显示这些。追加是 wire-safe 的（只加字段）：

```ts
scope?: "user" | "project";
transport?: "stdio" | "http" | "sse";
command?: string;   // stdio
url?: string;       // http/sse
lastError?: string;
authState?: "none" | "authorized" | "expired" | "required";
```

### 2.4 GUI 设计

**入口**:`ExtensionsPanel` 的 MCP 段头部加"添加服务器"按钮;每张卡片右侧菜单增加 测试连接 / 重新授权 / 编辑。

**添加向导**:`ProviderConfigDialog` 是本仓已验证的 CRUD **表单**范式(校验、错误态、保存回写),但它是**单页表单,不是分步向导**——本项的分步结构是新增的,复用它的表单/校验/样式惯例,不复用不存在的 stepper。若不想引入 stepper 抽象,可退化为单页 + 传输方式切换时字段区重渲染(更贴近既有范式,推荐先做这个)。分步描述如下:

1. 步骤一：传输方式（stdio / http / sse 三选一，卡片式）
2. 步骤二：按传输渲染字段
   - stdio:command、args(chip 编辑器,复用 `ArrayChipEditor`)、env(kv 编辑器,复用 `RecordKvEditor`)
   - http/sse:url、headers(kv,值可掩码)
3. 步骤三:名称 + scope(user/project) + **测试连接**按钮(可跳过)
4. 完成:`mcp_add` → 成功后**重新拉取** `get_mcp_servers`(不做乐观推断,因为 reload 会改 tool 数/auth 态)

**名称校验**:server-name 正则**允许 `:`**(插件命名空间形如 `cloudflare:cloudflare-api`)。前端校验要与 agent 侧一致,否则会出现前端放过、后端拒绝。

**卡片内容**:名称、传输徽章、scope 徽章、连接状态点、tool 数、auth 状态、最近错误（可展开）。

**测试结果呈现**:成功 → 绿色 + tool 名列表(前 10 + "还有 N 个");失败 → 红色 + 可复制的错误全文（MCP 错误常含长 stderr，必须可复制且截断显示）。

---

## 3. Marketplace

### 3.1 新增 RPC

```ts
| { type: "marketplace_action";
    action: "add" | "remove" | "update" | "install" | "uninstall" | "upgrade" | "list_available";
    marketplace?: string; plugin?: string; source?: string }
```

单命令多动词（照 `mcp_action` 的既有形态，避免 7 个命令膨胀）。全部走 `createDomainMarketplaceManager(cwd)`(rpc-domains.ts:190,已存在)调 `MarketplaceManager` 的对应方法(manager.ts:74)。

**每个 mutation 必须以 `reloadPluginState` 收尾**(rpc-mode.ts:1050):clearPluginRootsAndCaches → resetCapabilities → refreshSkills → 重载 slash 命令。之后 GUI 会收到 `available_commands_update`——这是安装成功的可观测信号。

**网络与缓存**:`fetchMarketplace`(fetcher.ts:244)是网络操作;catalog 与 pluginCount **是缓存值**,只有 `update` 才刷新。UI 必须区分"缓存数据"与"刚刷新",给出显式刷新按钮 + 上次更新时间。

### 3.2 GUI 设计

`InventoryPanel` 的 Marketplaces 段从只读升级：

- 市场列表：名称、来源 URL、插件数（标注缓存时间）、刷新 / 移除
- "添加市场"表单：source 字符串（`classifySource` 支持多形态：git URL / 本地路径 / registry 名）
- 展开市场 → 可用插件列表(`list_available`):名称、描述、版本、已安装徽章 → 安装 / 升级 / 卸载
- **TUI 的 marketplace 插件详情是只读的**(`MarketplacePluginDetailComponent`)。GUI 做安装/升级是**超出** TUI 的能力——这是有意的（桌面适合做这类管理），在 plan 里明确记录为 parity 的正向偏离。
- 安装是长耗时（网络 + 文件写 + reload），必须有进度态与失败详情，per-call timeout 放宽。

---

## 4. 插件配置编辑器

### 4.1 新增 RPC

```ts
| { type: "get_plugin_detail"; id: string }
//   → data: { manifest: {...features[], settingsSchema?}, values: Record<string,unknown>, enabledFeatures: string[] }
| { type: "set_plugin_features"; id: string; features: string[] }
| { type: "set_plugin_setting"; id: string; key: string; value: unknown }
| { type: "delete_plugin_setting"; id: string; key: string }
```

全部包 `PluginManager` 既有方法(manager.ts:786/810/855/867),用 `validateSetting`(L1093)返回校验反馈,收尾 `reloadPluginState`。

**绝不允许** GUI 直写 `omp-plugins.lock.json`(§1 已述:内存缓存 + 无锁写)。

### 4.2 GUI 设计

对标 TUI 的 `plugin-settings.ts` 组件，但用 GUI 已有的 schema 编辑器基础设施：

- 插件卡片点开 → 详情抽屉：启用开关、features 多选（复选列表，来自 manifest）、设置表单
- 设置表单**复用 SettingsWindow 的编辑器族**:`EnumerableSelect` / `ArrayChipEditor` / `RecordKvEditor` / 布尔行开关。插件 settings schema 若与主 schema 形状一致即可直接套;不一致的字段退化为受校验的 JSON 文本域（与主设置的复杂嵌套处理一致）。
- 校验失败：字段级红字 + 保留用户输入（不要静默回滚）。
- 保存后重新拉 `get_plugin_detail`(reload 可能改变派生值)。

---

## 5. Agent Hub 单代理控制

依赖 A1 的 `abort_subagent` / `revive_subagent`(见 16 §2.4)。

`AgentHubWindow` 现有 Definitions + Hub 两 tab,Hub tab 有实时子代理表。改动：

- 每行加操作区：**中止**(running/idle)、**唤醒**(parked)、查看 transcript(已有)
- advisor 行：两个按钮都禁用 + tooltip "只读顾问记录，不可中止"（对应 RPC 的 `advisor_readonly`，不要让用户点了才知道）
- 中止需确认（单击即杀一个跑着的代理，代价不低）
- 状态更新靠既有 `subagent_lifecycle` 事件。**注意 0.3.0 的教训**:这些帧是 `{type, payload}` 嵌套,progress 按 `payload.progress.id` 归属（`index` 在批次间会重复）。已修，勿退化。
- 表格状态列必须覆盖全部运行时状态(running/pending/aborted/parked/idle + fallback)——0.2.1 曾因 `STATUS_META[status]` 为 undefined 白屏,已有 fallback 与 error boundary,新增行为不要绕过它们。

---

## 6. 会话树叶节点操作

依赖 A2 的 `fork(entryId)` 与 `switch_leaf`(见 16 §3.2/3.3)。

`SessionTreeDialog` 每节点三个动作，语义必须在 UI 上明确区分（这是最容易让用户困惑的地方）：

| 按钮 | RPC | 结果 | 会话 id |
|---|---|---|---|
| 切换到此处 | `switch_leaf` | 当前会话活跃叶移动 + 重新 hydrate | 不变 |
| 从此处分支 | `branch`（已有） | 当前会话内新建分支 | 不变 |
| 在新窗口打开 | `fork(entryId)` → `window.open` | 独立新会话（截至该点副本） | 新 |

实现要点：

- **角色门控**:0.3.x 修过"在 assistant 节点上 branch"的问题(sidecar 只接受 user 节点)。`switch_leaf` 同样要确认接受范围;若 RPC 侧做了最近祖先归一化,UI 要显示"已切换到最近的用户消息处"而不是假装切到了点击的节点。
- **新窗口路径**:必须走 0.3.0 修好的顺序 —— 主进程开窗 + `pendingSessionPath`,由**新窗口的 renderer 在 boot 时**自己 `switch_session` + hydrate。不要在旧窗口里切。
- **10 窗口上限**:命中上限时 toast 拒绝（既有行为），不自动关别的窗口。
- 运行中守卫:切换类动作在 turn 运行时走既有的 `SessionSwitchDialog`(新窗口打开 / 中止并切换 / 取消)。

---

## 7. 启动配置 profile

### 7.1 定位

`sidecar.ts` 已有 `extraFlags` 接缝(63、158 行)但**无调用者**。本项把它接上,并**只**暴露真正 launch-only 的少数 flag——有运行时等价物的一律走设置,不重复。

**值得暴露**(launch-only 且有实际用途):

| Flag | 用途 |
|---|---|
| `--system-prompt` / `--append-system-prompt` | 会话构造期注入，无运行时路径 |
| `--no-rules` | 跳过规则文件加载 |
| `--add-dir` | 额外工作目录（有 `/add-dir` 但那是运行时增量；启动期声明更干净） |
| `--tools` / `--no-tools` | 工具白名单（`/tools` 只读） |
| `--no-lsp` | 关 LSP 池 |
| `--session-dir` | 会话持久化目录 |
| `--plan-yolo` | plan 模式自动执行 |
| `--profile` / `--alias` | 配置 profile 引导 |
| `--config` | 额外配置文件覆盖层 |

**不暴露**:`--model/--provider/--thinking/--approval-mode/--advisor/--skills/--prewalk/--hide-thinking/--service-tier` 等已有运行时等价物的;`--print/--help/--version/--export` 等非交互;`--mode/--no-pty/--no-title`(rpc-ui 已强制)。

### 7.2 设计

**存储**:per-workspace 的 GUI 偏好(`~/.omp/gui/`),键为工作区路径。与 v0.3.0 的 per-window sidecar pool 天然契合——每个窗口按其工作区取 profile。

**UI**:`SettingsWindow` 新增"启动配置"段。已有先例:GUI tab 就是**非 schema 的纯 GUI 偏好段**,照它的形态做（不要混进 schema 驱动的 tab，那些是 agent 设置）。

- 顶部醒目说明：**改动需重启 sidecar 才生效**，并提供"立即重启"按钮（空闲时；运行中禁用并提示）。
- 字段:文本框(system-prompt 多行)、目录选择器(add-dir 走原生 picker)、chip 编辑器(tools)、开关(no-rules/no-lsp/plan-yolo)。
- **展示实际生效的命令行**（只读代码块），让用户确切知道注入了什么——这类"魔法配置"最需要透明度。

**应用点**:`sidecar-pool` 构造 spawn options 处读取该工作区 profile → 拼进 `extraFlags`。**注意** `--session` 等既有参数由代码控制,profile 不得覆盖(冲突时以代码为准,并在 UI 上把这些 flag 列为不可用)。

**验证**:设 `--append-system-prompt "TEST"` → 重启 → `get_state` 返回的 systemPrompt 含该串。
