# omp GUI — System Architecture

## Process Model

```
┌─────────────────────────────────────────────────────────────────┐
│                     Electron Main Process                         │
│                                                                   │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │ SidecarManager │  │ SessionIndex   │  │ StatsClient        │  │
│  │                │  │                │  │                    │  │
│  │ spawn(omp,     │  │ chokidar watch │  │ HTTP GET polling   │  │
│  │  ["--mode",    │  │ ~/.omp/        │  │ localhost:3847     │  │
│  │   "rpc-ui",    │  │ sessions/      │  │ 30s per active tab │  │
│  │   "--approval- │  │                │  │                    │  │
│  │    mode",mode] │  │ Parse 256-byte │  │ 15 endpoints       │  │
│  │                │  │ title slot +   │  │ Range: 1h|24h|7d|  │  │
│  │ env: {         │  │ 4KB header +   │  │ 30d|90d|all        │  │
│  │  PI_RPC_EMIT_  │  │ 32KB tail      │  │                    │  │
│  │  TITLE: "1"    │  │                │  │                    │  │
│  │ }              │  │ LRU cache 4096 │  │                    │  │
│  └───────┬────────┘  └───────┬────────┘  └─────────┬──────────┘  │
│          │                    │                      │             │
│  ┌───────┴────────────────────┴──────────────────────┴──────────┐ │
│  │                    IPC Bridge (contextBridge)                  │ │
│  │  invoke() → commands    on() → event streams                  │ │
│  │  Serialized clone       Batched at 16ms                       │ │
│  └────────────────────────────┬──────────────────────────────────┘ │
│                               │                                    │
│  ┌────────────────────────────┴──────────────────────────────────┐ │
│  │  LogWatcher (tail ~/.omp/logs/)  │  Tray  │  Updater  │ Menu  │ │
│  └───────────────────────────────────────────────────────────────┘ │
└───────────────────────────────┼────────────────────────────────────┘
                                │ IPC (structured clone)
┌───────────────────────────────┼────────────────────────────────────┐
│                     Electron Renderer (React 19)                     │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                     Zustand Stores                               │ │
│  │  session · messages · tools · subagents · model · todo          │ │
│  │  settings · stats · ui · extensionUi                            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                     React Components                             │ │
│  │  ChatStream · ToolRenderers(28+) · DiffViewer · SubagentTree   │ │
│  │  ModelPicker · CommandPalette · SettingsForm · StatsDashboard   │ │
│  │  TerminalPanel · LogViewer · ExtensionDialogs · ApprovalDialog  │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                ▼               ▼               ▼
       ┌──────────────┐ ┌────────────┐ ┌──────────────┐
       │ omp --mode   │ │ omp stats  │ │ ~/.omp/      │
       │ rpc-ui       │ │ (HTTP)     │ │ (filesystem) │
       │ (stdio)      │ │ :3847      │ │ (read-only)  │
       └──────────────┘ └────────────┘ └──────────────┘
```

## Main Process Modules (`src/main/`)

| Module | Responsibility | Key Implementation Detail |
|---|---|---|
| `sidecar.ts` | Spawn/kill omp, lifecycle, restart | `child_process.spawn`; restart on exit≠0 (3 attempts, 1s/2s/4s backoff); no restart on exit=0 |
| `rpc-bridge.ts` | NDJSON framing, v2 chunk reassembly | readline on stdout; `ChunkReassembler` validates chunkId/index/count/byteLength; 64MB ceiling |
| `rpc-client.ts` | Typed command methods, id correlation | `Promise.withResolvers()` per command; 30s timeout; commands serialized (only `bash` is concurrent) |
| `event-batcher.ts` | Batch events at 16ms for renderer | Accumulate in array; flush via `setTimeout(16)`; never drop `message_update` or lifecycle events; drop intermediate `tool_execution_update` under backpressure (>1000 buffered) |
| `session-index.ts` | Watch sessions dir, parse metadata | chokidar + `awaitWriteFinish: 300ms`; parse 256-byte title slot (line 1, fixed-width JSON) + 4KB header; LRU 4096 entries keyed by (mtimeMs, size) |
| `stats-client.ts` | HTTP GET to stats server | `fetch` with AbortSignal; 30s poll per active route; discovery via `x-omp-stats-dashboard` header probe |
| `log-watcher.ts` | Tail log files | `fs.createReadStream` from last offset; 1000-line ring buffer; poll fallback where fs.watch unreliable |
| `broker-client.ts` | Daemon broker socket (optional) | Connect to `~/.omp/daemon/<hash>/broker.sock`; read token from `broker.token`; JSON-line protocol with auth field |
| `tray.ts` | System tray | Status icon (idle/streaming/error); quick actions |
| `updater.ts` | Auto-update | electron-updater; GitHub Releases feed |
| `window.ts` | Window management | Multi-window; state persistence via electron-store; deep link `omp://` |
| `ipc.ts` | IPC handler registration | Type-safe channel map; all handlers validated with zod |

## Preload (`src/preload/index.ts`)

```typescript
contextBridge.exposeInMainWorld("omp", {
  rpc: { /* 42 typed command methods */ },
  events: { /* subscribe/unsubscribe to event streams */ },
  ui: { /* extension UI responses, host tool/URI results */ },
  sessions: { /* list, delete, metadata */ },
  stats: { /* fetch stats endpoints */ },
  system: { /* openExternal, showSaveDialog, clipboard, notifications */ },
});
```

## Renderer (`src/renderer/`)

| Directory | Content |
|---|---|
| `stores/` | Zustand stores (session, messages, tools, subagents, model, todo, settings, stats, ui, extensionUi) |
| `components/chat/` | MessageBubble, StreamingText, ThinkingBlock, MarkdownRenderer, CodeBlock |
| `components/tools/` | 28 named renderers + generic fallback (see 02-features §4) |
| `components/panels/` | TodoPanel, SubagentPanel, DiffPanel, FilesPanel, TerminalPanel, LogPanel, MemoryPanel |
| `components/dialogs/` | ExtensionDialogs (select/confirm/input/editor/open_url), ApprovalDialog, CommandPalette, ModelPicker |
| `components/settings/` | Tabbed settings form (read config.yml + limited RPC commands) |
| `components/stats/` | Dashboard views (10 routes matching stats API) |
| `components/layout/` | TitleBar, Sidebar, InputArea, PanelContainer |
| `hooks/` | useRpcEvent, useSessionList, useStats, useExtensionUi, useVirtualScroll |
| `lib/` | Event parser, markdown pipeline, diff renderer, theme tokens |
| `styles/` | Tailwind config, 95-color theme token system |

## Sidecar Lifecycle

```
App Launch
    │
    ├─► Create BrowserWindow (loads renderer bundle)
    │       └─► Renderer shows "Connecting..." skeleton
    │
    ├─► Spawn: omp --mode rpc-ui --approval-mode <mode> [flags]
    │   env: { ...process.env, PI_RPC_EMIT_TITLE: "1", PI_NO_PTY: "1" }
    │   cwd: <project directory>
    │   stdio: ["pipe", "pipe", "pipe"]
    │       │
    │       ├─► stdout readline → parse NDJSON
    │       ├─► Wait for { type: "ready" } frame
    │       ├─► Send { id: "proto-1", type: "negotiate_protocol", protocolVersion: 2 }
    │       ├─► Receive success → enable v2 chunked output
    │       ├─► Emit "sidecar:ready" to renderer
    │       │
    │       ├─► [RUNNING: forward commands stdin↔stdout, batch events to renderer]
    │       │
    │       ├─► On exit(0): normal shutdown, no restart
    │       ├─► On exit(≠0): restart with backoff (1s, 2s, 4s), max 3 attempts
    │       └─► On 3 failures: show error dialog, stop
    │
    ├─► Start session-index watcher (parallel with sidecar)
    ├─► Probe stats server (lazy, on first stats tab open)
    └─► Create tray icon
```

## Command Serialization Constraint

RPC commands are processed **one-at-a-time** by `RpcInputDispatcher`.
Exceptions that bypass the serial queue:
- `bash` — dispatched in background (allows concurrent `abort_bash`)
- Side-channel frames — dispatched immediately: `extension_ui_response`,
  `host_tool_result`, `host_tool_update`, `host_uri_result`

The GUI must not assume parallel command execution. Rapid-fire commands
(e.g., `set_model` + `set_thinking_level`) are queued and execute in order.

## Security Model

```typescript
// BrowserWindow
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
}

// CSP (index.html meta)
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
connect-src 'self' http://localhost:3847;
worker-src 'self' blob:;
```

- All filesystem access in main process only
- Preload exposes minimal typed API (no raw IPC channels leaked)
- Session files opened `O_RDONLY`
- Sidecar inherits env (API keys stay in main process, never serialized to renderer)
- Daemon broker requires token auth (read from `broker.token` file)
