<div align="center">

# omp GUI

**A desktop GUI for the [omp](https://github.com/can1357/oh-my-pi) coding agent.**

Every slash command as a menu · full-fidelity rendering · providers, models & usage in one place.

[English](#english) · [中文](#中文)

</div>

---

![Chat](docs/screenshots/01-chat-main.webp)

<a name="english"></a>
## English

`omp GUI` wraps the omp agent (`omp --mode rpc-ui`) in a fast Electron shell. The agent runs as a bundled sidecar — **no separate omp / bun / Node install is required**; the app ships its own binary and talks to it over a typed NDJSON RPC bridge.

### Highlights

- **Every `/` command, as a menu.** Commands aren't just text you type — they're grouped, searchable menus. Open the **Command Palette (`⌘K`)** for fuzzy access to everything, or browse grouped categories (Workspace, Providers, Model, Session…). Sub-menus, argument prompts, and toggles all run the underlying RPC — never a fake input box.

- **Full-fidelity rendering.** The chat renders what omp's TUI renders: streaming text, collapsible **thinking** blocks, live **tool cards** (bash, edit, read, grep, task, …) with real diffs, markdown, **KaTeX math**, mermaid diagrams, and syntax-highlighted code — streamed token-by-token.

- **Providers & login.** Sign in with OAuth or API keys, add third-party providers, edit `models.json` config, and see auth status at a glance.

- **Model config.** Pick the model, tune the **thinking level**, toggle fast/plan mode, and assign per-role models.

- **Usage & quotas.** A full stats dashboard — requests, tokens, cost, cache-hit, speed, errors, per-agent breakdown — with time ranges and charts.

- **Workspace panels.** Todo, Plan, Subagents, Diff, Files, and Logs in a collapsible side panel, kept in sync with the agent in real time.

- **Sessions.** Search, group, rename, branch, fork/handoff, and resume sessions across projects. Global and per-project history.

- **Parallel, protected sessions.** Open up to 10 windows, each with its own sidecar. Switching away from a busy session offers a new window, explicit abort, or cancel instead of silently killing work.

- **OMP capabilities, not generic toggles.** Settings leads with TTSR, parallel subagents, model roles, Advisor, goal/loop modes, memory, and native tools. Schema-driven controls distinguish live settings from restart-required ones, and full-row switches persist across reconnects.

- **Proxy-aware packaged app.** Finder-launched builds resolve an explicit GUI proxy, inherited proxy variables, or the macOS system proxy for OAuth, streaming, and usage requests.

### Screenshots

| | |
|---|---|
| **Command Palette (`⌘K`)** — every slash command as a grouped, searchable menu | ![Command palette](docs/screenshots/02-command-palette.webp) |
| **Workspace panel** — Todo / Plan / Agents / Diff / Files / Logs beside the chat | ![Workspace](docs/screenshots/03-workspace-files.webp) |
| **Settings** — runtime, model, context, tools, providers, GUI, all in one window | ![Settings](docs/screenshots/05-settings.webp) |
| **Model picker** — grouped by provider with auth status | ![Model picker](docs/screenshots/06-model-picker.webp) |
| **Usage & stats** — requests, tokens, cost, cache-hit, speed over time | ![Stats](docs/screenshots/07-session-stats.webp) |
| **Providers & login** — OAuth / API-key sign-in, third-party providers | ![Providers](docs/screenshots/08-providers-login.webp) |

### Install

Current release: [**v0.3.1**](https://github.com/nornzach/oh-my-pi-gui/releases/tag/v0.3.1)

- **Apple Silicon (M1/M2/M3/M4):** `omp-0.3.1-arm64.dmg`
- **Intel:** `omp-0.3.1-x64.dmg`

Open the `.dmg` and drag **omp** into **Applications**. The build is unsigned, so on first launch macOS may block it: **right-click → Open** (or *System Settings → Privacy & Security → Open Anyway*).

### Build from source

```bash
bun install
bun run build        # renderer + main + preload → out/
bun run build:omp    # bundle the agent binary → resources/omp (needs the omp monorepo alongside)
bun run package:mac  # electron-builder → dist/
```

> The agent sidecar binary (`resources/omp`, ~120 MB) is **not** committed. Build it with `bun run build:omp` from the [oh-my-pi](https://github.com/can1357/oh-my-pi) monorepo, or copy a prebuilt one in, before packaging. The release apps already include it.

### Keyboard

`⌘K` command palette · `⌘P` session search · `⌘N` new session · `⌘,` settings · `⌘B`/`⌘J` toggle sidebars · `Esc` abort turn

---

<a name="中文"></a>
## 中文

`omp GUI` 是 [omp](https://github.com/can1357/oh-my-pi) 编码 agent 的桌面图形界面。agent 以内置 sidecar 方式随应用打包——**无需单独安装 omp / bun / Node**，应用自带二进制，通过类型化的 NDJSON RPC 桥与其通信。

### 核心特性

- **所有 `/` 命令,全部做成菜单。** 命令不再只是手敲的文本——而是分组、可搜索的菜单。打开**命令面板(`⌘K`)**模糊直达任意命令,或浏览分组(工作区、Provider、模型、会话…)。子菜单、参数输入、开关项都走真实 RPC,绝不是套个输入框。

- **完整渲染。** 聊天区渲染 omp TUI 的全部内容:流式文本、可折叠的**思考块**、实时**工具卡**(bash、edit、read、grep、task…,带真实 diff)、markdown、**KaTeX 公式**、mermaid 图、语法高亮代码——逐 token 流式呈现。

- **Provider 与登录。** 支持 OAuth 或 API key 登录、添加第三方 provider、编辑 `models.json` 配置,认证状态一目了然。

- **模型配置。** 选择模型、调节**思考等级**、切换快速/计划模式、按角色分配模型。

- **用量与配额。** 完整的统计仪表盘——请求数、token、花费、缓存命中、速度、错误、按 agent 类型拆分,支持时间范围与图表。

- **工作区面板。** 待办、计划、子 agent、Diff、文件、日志,集成在可折叠侧栏,与 agent 实时同步。

- **会话管理。** 搜索、分组、重命名、分支、fork/交接、跨项目恢复会话,支持全局与项目级历史。

- **并行且受保护的会话。** 最多同时打开 10 个窗口,每个窗口拥有独立 sidecar。离开繁忙会话时会明确提供“新窗口打开”“中止后切换”或取消,不会静默终止正在进行的工作。

- **围绕 OMP 能力组织的设置。** 设置首页直接呈现 TTSR、并行子 agent、角色模型、顾问、目标/循环模式、记忆和原生工具；schema 控件会区分即时生效与需要重启的设置,整行滑块在重连后也保持正确状态。

- **适配代理网络的打包应用。** 从 Finder 启动时,应用会依次解析 GUI 显式代理、继承的代理环境变量和 macOS 系统代理,用于 OAuth、流式请求与用量查询。

### 界面截图

| | |
|---|---|
| **命令面板(`⌘K`)**——所有 slash 命令的分组可搜索菜单 | ![命令面板](docs/screenshots/02-command-palette.webp) |
| **工作区面板**——聊天旁的待办/计划/子agent/Diff/文件/日志 | ![工作区](docs/screenshots/03-workspace-files.webp) |
| **设置**——运行时、模型、上下文、工具、Provider、GUI 集中一窗 | ![设置](docs/screenshots/05-settings.webp) |
| **模型选择器**——按 provider 分组,带认证状态 | ![模型选择器](docs/screenshots/06-model-picker.webp) |
| **用量统计**——请求、token、花费、缓存命中、速度随时间变化 | ![统计](docs/screenshots/07-session-stats.webp) |
| **Provider 与登录**——OAuth / API key 登录、第三方 provider | ![Provider](docs/screenshots/08-providers-login.webp) |

### 安装

当前版本：[**v0.3.1**](https://github.com/nornzach/oh-my-pi-gui/releases/tag/v0.3.1)

- **Apple Silicon(M1/M2/M3/M4):** `omp-0.3.1-arm64.dmg`
- **Intel:** `omp-0.3.1-x64.dmg`

打开 `.dmg`,把 **omp** 拖进 **应用程序**。构建未签名,首次打开 macOS 可能拦截:**右键 → 打开**(或 *系统设置 → 隐私与安全性 → 仍要打开*)。

### 从源码构建

```bash
bun install
bun run build        # 渲染层 + 主进程 + preload → out/
bun run build:omp    # 打包 agent 二进制 → resources/omp(需要 oh-my-pi monorepo 在旁)
bun run package:mac  # electron-builder → dist/
```

> agent sidecar 二进制(`resources/omp`,约 120 MB)**不入库**。打包前用 `bun run build:omp`(需 [oh-my-pi](https://github.com/can1357/oh-my-pi) monorepo)构建,或放入预编译二进制。Release 应用已内置。

### 快捷键

`⌘K` 命令面板 · `⌘P` 会话搜索 · `⌘N` 新会话 · `⌘,` 设置 · `⌘B`/`⌘J` 切换侧栏 · `Esc` 中止回合

---

<div align="center">
Built on the <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> agent. The TUI and GUI coexist and share <code>~/.omp</code>.
</div>
