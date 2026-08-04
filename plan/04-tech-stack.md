# omp GUI — Technology Stack

## Shell: Electron 35+

| Aspect | Choice | Rationale |
|---|---|---|
| Version | Electron 35+ (Chromium 134+, Node 22) | ESM support, latest security |
| Build | electron-vite 3 | Fast HMR, TS-native, main/preload/renderer split |
| Package | electron-builder 26 | dmg/NSIS/AppImage/deb, signing, auto-update |
| Update | electron-updater 6 | GitHub Releases feed, background download |
| Min OS | macOS 12+, Windows 10 1809+, Linux GTK 3.22+ | Electron 35 support matrix |

## Frontend: React 19

| Aspect | Choice | Version |
|---|---|---|
| Framework | React | ^19.0.0 |
| Language | TypeScript (strict) | ^5.8.0 |
| Bundler | Vite (via electron-vite) | ^6.0.0 |
| State | Zustand | ^5.0.0 |
| Styling | Tailwind CSS | ^4.0.0 |
| Icons | lucide-react | ^0.500.0 |
| Charts | chart.js + react-chartjs-2 | ^4.4.0 / ^5.3.0 |
| Markdown | react-markdown + remark-gfm + rehype-katex + rehype-highlight | ^10 / ^4 / ^7 / ^7 |
| Mermaid | mermaid (dynamic import) | ^11.0.0 |
| Code editor | CodeMirror 6 (@codemirror/view + lang-json) | ^6.36.0 |
| Terminal | @xterm/xterm + @xterm/addon-fit | ^5.5.0 / ^0.10.0 |
| Virtual scroll | @tanstack/react-virtual | ^3.13.0 |
| Date | date-fns | ^4.1.0 |
| Forms | react-hook-form + zod | ^7.54.0 / ^3.24.0 |
| Drag & drop | @dnd-kit/core + @dnd-kit/sortable | ^6.3.0 / ^10.0.0 |

## Main Process (Node 22, Electron built-in)

| Aspect | Choice | Rationale |
|---|---|---|
| Process mgmt | `node:child_process` spawn | Sidecar lifecycle |
| NDJSON parse | `node:readline` + JSON.parse | Streaming line parser |
| File watch | chokidar ^4 | Session directory, awaitWriteFinish |
| HTTP | `fetch` (Node built-in) | Stats API polling |
| Logging | electron-log ^5 | Main process logs |
| Preferences | electron-store ^10 | Window state, GUI settings |
| IPC validation | zod ^3 | Runtime check at IPC boundary |

## Dev-Time Only (not in built app)

| Package | Purpose |
|---|---|
| `@oh-my-pi/pi-coding-agent` (workspace:*) | Type generation source for `scripts/gen-types.ts` |
| electron ^35 | Shell |
| electron-vite ^3 | Build |
| electron-builder ^26 | Package |
| vitest ^3 | Unit tests |
| @playwright/test ^1.50 | E2E tests |
| @biomejs/biome ^1.9 | Lint + format (matches monorepo) |
| tailwindcss ^4 + @tailwindcss/vite | Styling build |

## Package Structure

```
packages/gui/
├── plan/                          # This documentation
├── src/
│   ├── main/                      # Electron main process
│   │   ├── index.ts               # App entry, window creation, lifecycle
│   │   ├── sidecar.ts             # omp spawn/kill/restart
│   │   ├── rpc-bridge.ts          # NDJSON framing, v2 ChunkReassembler
│   │   ├── rpc-client.ts          # 42 typed command methods, id correlation
│   │   ├── event-batcher.ts       # 16ms batch, backpressure, priority
│   │   ├── session-index.ts       # chokidar + JSONL header/tail parse
│   │   ├── stats-client.ts        # HTTP GET polling, 15 endpoints
│   │   ├── log-watcher.ts         # Tail log files, ring buffer
│   │   ├── broker-client.ts       # Daemon broker socket + token auth
│   │   ├── tray.ts                # System tray
│   │   ├── menu.ts                # Application menu
│   │   ├── updater.ts             # Auto-update
│   │   ├── window.ts              # Multi-window, state persistence
│   │   ├── deep-link.ts           # omp:// protocol handler
│   │   └── ipc.ts                 # IPC handler registration (zod-validated)
│   ├── preload/
│   │   └── index.ts               # contextBridge typed API
│   ├── renderer/
│   │   ├── index.html             # CSP meta, root div
│   │   ├── main.tsx               # React entry
│   │   ├── App.tsx                # Root layout (3-column)
│   │   ├── stores/                # Zustand (10 stores)
│   │   ├── components/
│   │   │   ├── common/            # Primitives (20+)
│   │   │   ├── chat/              # MessageBubble, StreamingText, ThinkingBlock, Markdown
│   │   │   ├── tools/             # 28 named renderers + generic fallback
│   │   │   ├── panels/            # Todo, Subagent, Diff, Files, Logs
│   │   │   ├── dialogs/           # ExtensionDialog, ApprovalDialog, CommandPalette, ModelPicker
│   │   │   ├── settings/          # Tabbed form
│   │   │   ├── stats/             # 10 dashboard routes
│   │   │   └── layout/            # TitleBar, Sidebar, InputArea, PanelContainer
│   │   ├── hooks/                 # useRpcEvent, useSessionList, useStats, etc.
│   │   ├── lib/                   # Event parser, markdown pipeline, diff, theme
│   │   └── styles/                # Tailwind config, theme tokens (95 colors)
│   └── shared/                    # Types shared across processes
│       ├── ipc-types.ts           # IPC channel definitions
│       ├── rpc-types.ts           # Generated from source (dev-time)
│       └── event-types.ts         # AgentSessionEvent union (24 types)
├── scripts/
│   ├── gen-types.ts               # Extract RPC types from rpc-types.ts
│   └── gen-settings-schema.ts     # Extract settings schema for form
├── resources/                     # Icons (icns/ico/png), tray images
├── electron-builder.yml
├── electron.vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── package.json
└── biome.json
```

## package.json

```jsonc
{
  "name": "@oh-my-pi/omp-gui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./out/main/index.js",
  "scripts": {
    "dev": "electron-vite dev",
    "build": "electron-vite build",
    "package": "electron-builder",
    "package:mac": "electron-builder --mac",
    "package:win": "electron-builder --win",
    "package:linux": "electron-builder --linux",
    "gen:types": "bun scripts/gen-types.ts",
    "check": "biome check . && tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "bench": "vitest bench"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "lucide-react": "^0.500.0",
    "chart.js": "^4.4.0",
    "react-chartjs-2": "^5.3.0",
    "react-markdown": "^10.0.0",
    "remark-gfm": "^4.0.0",
    "rehype-katex": "^7.0.0",
    "rehype-highlight": "^7.0.0",
    "mermaid": "^11.0.0",
    "@codemirror/view": "^6.36.0",
    "@codemirror/lang-json": "^6.0.0",
    "@xterm/xterm": "^5.5.0",
    "@xterm/addon-fit": "^0.10.0",
    "@tanstack/react-virtual": "^3.13.0",
    "date-fns": "^4.1.0",
    "react-hook-form": "^7.54.0",
    "zod": "^3.24.0",
    "@dnd-kit/core": "^6.3.0",
    "@dnd-kit/sortable": "^10.0.0",
    "chokidar": "^4.0.0",
    "electron-log": "^5.3.0",
    "electron-store": "^10.0.0",
    "electron-updater": "^6.4.0"
  },
  "devDependencies": {
    "electron": "^35.0.0",
    "electron-vite": "^3.0.0",
    "electron-builder": "^26.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.8.0",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "vitest": "^3.0.0",
    "@playwright/test": "^1.50.0",
    "@biomejs/biome": "^1.9.0",
    "@oh-my-pi/pi-coding-agent": "workspace:*"
  }
}
```

## Rejected Alternatives

| Rejected | Reason |
|---|---|
| Tauri | Requires Rust (hard constraint) |
| Next.js / Remix | SSR irrelevant for desktop |
| Redux / MobX | Overkill; Zustand simpler for event-driven |
| Styled-components / Emotion | Tailwind faster to iterate, smaller bundle |
| Webpack | Vite faster, electron-vite purpose-built |
| Svelte / Solid | Team familiarity, stats dashboard uses React |
| SDK in-process embed | Crash coupling; sidecar isolation is safer |
