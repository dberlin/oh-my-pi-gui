# omp GUI — Implementation Phases

8 phases, 15 weeks. Each phase has a concrete deliverable that can be
demonstrated and verified before proceeding.

---

## Phase 0: Scaffold (Week 1)

**Deliverable:** `bun run dev` opens a window showing "omp connected (protocol v2)".

### Tasks

- [ ] `packages/gui/package.json` with all dependencies
- [ ] `electron.vite.config.ts` (main/preload/renderer split)
- [ ] `tsconfig.json` (strict), `tsconfig.node.json`
- [ ] `biome.json` (matches monorepo rules)
- [ ] `tailwind.config.ts` with 95-color token system (from dark.json)
- [ ] `src/main/index.ts` — app entry, single BrowserWindow, basic menu
- [ ] `src/main/sidecar.ts` — spawn `omp --mode rpc-ui`, detect ready frame, restart logic
- [ ] `src/main/rpc-bridge.ts` — readline NDJSON parser, ChunkReassembler (v2)
- [ ] `src/main/rpc-client.ts` — id correlation, Promise.withResolvers, 30s timeout
- [ ] `src/main/event-batcher.ts` — 16ms batch, priority (never drop text_delta/lifecycle)
- [ ] `src/main/ipc.ts` — register handlers: `rpc:command`, `rpc:events`, `sidecar:status`
- [ ] `src/preload/index.ts` — contextBridge: `window.omp.rpc.*`, `window.omp.events.*`
- [ ] `src/shared/rpc-types.ts` — generated from source (scripts/gen-types.ts)
- [ ] `src/shared/event-types.ts` — AgentSessionEvent union (24 types)
- [ ] `src/shared/ipc-types.ts` — channel definitions
- [ ] `scripts/gen-types.ts` — extract types from `rpc-types.ts` (dev-time only)
- [ ] `src/renderer/index.html` — CSP meta, root div
- [ ] `src/renderer/main.tsx` — React entry
- [ ] `src/renderer/App.tsx` — shows connection status
- [ ] `electron-builder.yml` — macOS dmg config (minimal)
- [ ] `resources/` — app icon (icns/ico/png)

### Verification

1. `bun run dev` → window opens
2. Sidecar spawns → ready frame received → "Connected (v2)" displayed
3. Kill omp → "Disconnected" shown → auto-restart → "Connected" again
4. `get_state` command → response displayed in dev tools

---

## Phase 1: Core Conversation (Weeks 2-3)

**Deliverable:** Full streaming chat with markdown, thinking, images.

### Tasks

- [ ] Zustand stores: `session`, `messages`, `model`, `ui`
- [ ] Event router: parse AgentSessionEvent → dispatch to stores
- [ ] `InputArea` component: multiline, Enter send, Shift+Enter newline, image paste
- [ ] `prompt` / `abort` / `abort_and_prompt` commands wired
- [ ] `StreamingText`: token-by-token, RAF-batched, blinking cursor
- [ ] `ThinkingBlock`: collapsible, auto-expand during stream, auto-collapse on end
- [ ] `MessageBubble`: user/assistant/system styling, timestamp, copy button
- [ ] `MarkdownRenderer`: react-markdown + remark-gfm + rehype-katex + rehype-highlight
- [ ] `CodeBlock`: syntax highlight, line numbers, copy, language badge
- [ ] Virtual scroll: @tanstack/react-virtual, auto-scroll, pin on user scroll, "↓ latest" button
- [ ] `TitleBar`: model name, thinking level, context usage bar, tok/s
- [ ] `ModelPicker`: grouped dropdown (get_available_models + set_model)
- [ ] Thinking level selector (set_thinking_level / cycle_thinking_level)
- [ ] Fast mode toggle (set_fast_mode)
- [ ] Context usage bar (get_state.contextUsage)
- [ ] Session state indicator (streaming/idle/error)
- [ ] Error toasts for RPC failures
- [ ] Keyboard: Esc abort, Cmd+Enter send, Up/Down history
- [ ] Image attachments: paste/drag → ImageContent[] on prompt

### Verification

1. Send "hello" → streaming response appears token-by-token
2. Response with code blocks → syntax highlighted
3. Response with LaTeX → rendered via KaTeX
4. Thinking enabled → collapsible thinking block appears
5. Paste image → sent as attachment → agent responds about it
6. Esc during stream → aborts immediately
7. Context bar updates after each turn

---

## Phase 2: Tool Visualization (Weeks 4-5)

**Deliverable:** All tool executions render richly in conversation.

### Tasks

- [ ] `ToolCard` wrapper: status icon, name, duration, expand/collapse, error state
- [ ] Tool event routing: `tool_execution_start` → card appears; `update` → live; `end` → settle
- [ ] Streaming args display (partial JSON → formatted)
- [ ] Per-tool renderers (28 named, priority order):
  - [ ] `read` — file preview, syntax highlight, line numbers
  - [ ] `edit` / `apply_patch` — inline diff, streaming stabilization
  - [ ] `bash` — command + terminal output, exit code, streaming lines
  - [ ] `write` — path + content preview
  - [ ] `grep` — match list with highlights
  - [ ] `glob` — file tree
  - [ ] `task` — subagent spawn card
  - [ ] `todo` — todo list render
  - [ ] `eval` — code cell + output
  - [ ] `browser` — screenshot + action log
  - [ ] `debug` — stack/variables
  - [ ] `lsp` — operation results
  - [ ] `github` — GitHub card
  - [ ] `hub` — agent/process status
  - [ ] `ask` — renders as dialog
  - [ ] `computer` — screenshot + overlay
  - [ ] `ast_edit` / `ast_grep` — AST diff/matches
  - [ ] `inspect_image` — image + annotations
  - [ ] `resolve` / `reject` — resolution card
  - [ ] `retain` / `recall` / `reflect` — memory cards
  - [ ] `goal` — goal card
  - [ ] `web_search` — search results
  - [ ] `vibe_*` — worker cards
- [ ] Generic fallback renderer (MCP, custom, host tools)
- [ ] Rich renderers for tools without TUI renderers: `image_gen`, `tts`, `review`, `security_scan`
- [ ] Output truncation (>10KB → "Show more")
- [ ] `DiffView` component: unified/split, syntax highlighted
- [ ] Mermaid rendering (dynamic import, requestIdleCallback)

### Verification

1. Agent runs `read src/main.ts` → file preview with line numbers
2. Agent runs `edit` → inline diff with green/red
3. Agent runs `bash ls -la` → terminal output streams
4. Agent runs `grep` → match list with highlighted pattern
5. Agent runs `task` → subagent card appears
6. Large output → truncated with "Show more"
7. Tool error → red card with message

---

## Phase 3: Session Management (Week 6)

**Deliverable:** Full session lifecycle in sidebar.

### Tasks

- [ ] `session-index.ts`: chokidar watch, 256-byte title slot parse, 4KB header, 32KB tail status
- [ ] Session list sidebar: searchable, sorted by mtime, status badges
- [ ] New session (Cmd+N → `new_session`)
- [ ] Switch session (click → `switch_session`)
- [ ] Rename (inline edit → `set_session_name`)
- [ ] Branch (context menu → `branch` + `get_branch_messages`)
- [ ] Delete (confirm dialog → `fs.unlink`)
- [ ] Session search (Cmd+P, fuzzy)
- [ ] Recent sessions on welcome screen
- [ ] Cross-project scope toggle
- [ ] Session stats panel (`get_session_stats`)
- [ ] Export HTML (`export_html` → save dialog)
- [ ] Handoff (`handoff` — disabled while streaming)
- [ ] Paginated history (infinite scroll via `get_messages_page`)
- [ ] Handle `session_busy` / `stale_cursor` errors
- [ ] Welcome screen (no session): new / resume / recent

### Verification

1. Sidebar shows sessions with titles and status badges
2. Click session → loads history (paginated)
3. Cmd+N → new session created
4. Right-click → branch → new branch created
5. Delete → confirm → file removed
6. Scroll to top → older messages load (infinite scroll)
7. Export → HTML file saved

---

## Phase 4: Panels & Orchestration (Weeks 7-8)

**Deliverable:** Right panel system with live subagent monitoring.

### Tasks

- [ ] Panel container: tabbed, collapsible, resizable, persisted
- [ ] **Todo panel**: phase/task tree, status badges, editable (`set_todos`), drag reorder, reminder banner
- [ ] **Subagent panel**: subscribe (`set_subagent_subscription("events")`), tree, lifecycle badges, progress line, expandable transcript (`get_subagent_messages` byte pagination)
- [ ] **Diff panel**: latest edit diff, file selector, unified/split toggle
- [ ] **Files panel**: workspace tree (main process readdir), click to preview, @mention integration
- [ ] **Logs panel**: tail `~/.omp/logs/`, search, filter by level, auto-scroll
- [ ] IRC/notification feed: `irc_message` + `notice` events
- [ ] Goal card in sidebar: `goal_updated` event (passive display)

### Verification

1. Agent spawns subagent → appears in Agents panel with "running" badge
2. Subagent completes → badge changes, transcript expandable
3. Todo panel shows phases, editable, drag reorder works
4. Edit tool → Diff panel shows before/after
5. Files panel shows project tree, click previews file
6. Logs panel shows agent logs, searchable

---

## Phase 5: Commands, Extensions & Input (Week 9)

**Deliverable:** Full command system and extension UI.

### Tasks

- [ ] **Command palette** (Cmd+K): fuzzy search, `get_available_commands`, execute on select, recent
- [ ] **`/` autocomplete**: inline dropdown, filter as type, descriptions
- [ ] **@file mention**: `@` triggers file picker, fuzzy search, insert reference
- [ ] **Extension UI dialogs**:
  - [ ] select → modal options list
  - [ ] confirm → modal yes/no
  - [ ] input → modal text field
  - [ ] editor → modal CodeMirror
  - [ ] open_url → open browser + "Done" button
  - [ ] notify → toast
  - [ ] setStatus → status bar segment
  - [ ] setWidget → widget panel (string[] lines)
  - [ ] setTitle → title bar (PI_RPC_EMIT_TITLE=1)
  - [ ] set_editor_text → input box update
  - [ ] cancel → dismiss target
  - [ ] timeout → countdown + auto-dismiss
- [ ] **Approval dialog**: styled select (tool name, tier badge, args preview, Approve/Deny)
- [ ] Steering/follow-up mode indicators
- [ ] Queue display (pending messages count)
- [ ] Input history (Up/Down)
- [ ] `!command` bash shortcut → RPC `bash`
- [ ] Skill invocation: `skill://name` in prompt

### Verification

1. Cmd+K → palette opens, type "compact" → executes `/compact`
2. Type `/` → autocomplete dropdown appears
3. Type `@src/` → file picker filters
4. Extension sends confirm → dialog appears → respond → agent continues
5. Approval mode "always-ask" → write tool → approval dialog → approve → executes
6. `!ls -la` → bash output appears

---

## Phase 6: Stats & Settings (Weeks 10-11)

**Deliverable:** Analytics dashboard and configuration UI.

### Tasks

- [ ] **Stats dashboard** (panel or window):
  - [ ] Overview: cards (tokens, cost, sessions, error rate)
  - [ ] Models: bar chart + performance series
  - [ ] Providers: pie + hourly + usage windows
  - [ ] Tools: ranked table + time series
  - [ ] Costs: time-series line chart
  - [ ] Errors: list + trend
  - [ ] Behavior: frustration metrics
  - [ ] Gain: token savings
  - [ ] Projects: per-folder breakdown
  - [ ] Requests: paginated table + detail drawer
  - [ ] Range selector (1h/24h/7d/30d/90d/all)
  - [ ] Sync button
  - [ ] Stats HTTP client (poll 30s, discovery via header probe)
- [ ] **Settings window** (Cmd+,):
  - [ ] Tabbed: General, Models, Approval, Memory, GUI
  - [ ] Read config.yml for display
  - [ ] Runtime toggles via RPC (fast mode, thinking, steering, compaction, retry)
  - [ ] Approval mode selector (applies on next session spawn)
  - [ ] GUI preferences (theme, font size, panel layout, shortcuts)
  - [ ] "Edit config" button → opens config.yml in system editor
- [ ] **Login flow**: `get_login_providers` → provider list → `login` → `open_url` → browser → done

### Verification

1. Stats tab → charts render with real data
2. Range selector → data updates
3. Request row click → detail drawer
4. Settings → toggle fast mode → title bar updates
5. Settings → change approval mode → next session uses it
6. Login → browser opens → OAuth completes → provider shows "authenticated"

---

## Phase 7: Advanced Features (Weeks 12-13)

**Deliverable:** All remaining capabilities accessible.

### Tasks

- [ ] **Host tools**: register on ready (`gui_open_url`, `gui_notify`, `gui_select_file`, `gui_clipboard_read`); handle `host_tool_call` → execute → `host_tool_result`
- [ ] **Daemon broker** (optional): connect socket + token, process list panel, log viewer, PTY attach (xterm.js)
- [ ] **Memory panel**: memory tool results browser (retain/recall/reflect cards)
- [ ] **Compaction UI**: manual compact dialog (custom instructions), auto-compaction toggle, progress banner, result toast
- [ ] **Retry UI**: auto-retry toggle, progress banner (attempt N/M, countdown), fallback toast, abort button
- [ ] **Multi-window**: one session per window, "New Window" menu, state persistence
- [ ] **System tray**: status icon (idle/streaming/error), quick actions
- [ ] **Global shortcuts**: Cmd+Shift+O toggle (configurable)
- [ ] **Deep links**: `omp://session/<id>`, `omp://new`
- [ ] **Native notifications**: turn complete, error, subagent finished
- [ ] **Log viewer panel**: searchable, filterable, auto-scroll

### Verification

1. Agent calls `gui_open_url` → system browser opens
2. Broker connected → process list shows daemons
3. Compact dialog → compaction runs → result toast
4. Auto-retry → banner shows attempt 1/3 → countdown
5. Cmd+Shift+O → window toggles from any app
6. `omp://new` → new session window opens

---

## Phase 8: Polish & Distribution (Weeks 14-15)

**Deliverable:** Signed, packaged, auto-updating app for all platforms.

### Tasks

- [ ] **Auto-update**: electron-updater config, update dialog, background download, install on restart
- [ ] **Packaging**:
  - [ ] macOS: .dmg (arm64 + x64 universal)
  - [ ] Windows: NSIS installer (x64)
  - [ ] Linux: AppImage + .deb (x64)
- [ ] **Code signing**:
  - [ ] macOS: Developer ID + notarization
  - [ ] Windows: EV certificate
- [ ] **Performance audit**:
  - [ ] Profile cold start (< 1.5s target)
  - [ ] Profile streaming (1000 tokens, < 16ms/frame)
  - [ ] Profile large session (5000 messages, scroll 60fps)
  - [ ] Memory leak check (4h soak, < 400MB)
- [ ] **Accessibility audit**:
  - [ ] Keyboard navigation (all actions)
  - [ ] Screen reader (ARIA labels, live regions)
  - [ ] High contrast mode
  - [ ] Reduced motion
- [ ] **E2E tests** (Playwright + Electron):
  - [ ] Launch → connect → prompt → stream → tool → session switch
  - [ ] Extension UI dialog flow
  - [ ] Approval flow
- [ ] **Documentation**: README.md, development guide

### Verification

1. `bun run package:mac` → signed .dmg installs, launches, connects
2. Auto-update: publish new version → app detects → downloads → installs
3. Cold start < 1.5s on M1 MacBook
4. 5000-message session scrolls at 60fps
5. Playwright E2E passes on CI (mac + linux)
6. VoiceOver navigates conversation stream

---

## Milestone Summary

| Week | Milestone | Gate |
|---|---|---|
| 1 | Scaffold connects | Ready frame + v2 negotiated |
| 3 | Core conversation | Streaming chat + markdown + thinking |
| 5 | Tools render | All 28+ renderers working |
| 6 | Sessions managed | List/create/switch/branch/delete |
| 8 | Panels live | Subagents, todos, diffs, logs |
| 9 | Commands + extensions | Palette, approval, extension UI |
| 11 | Stats + settings | Dashboard renders, settings work |
| 13 | Advanced features | Host tools, broker, multi-window |
| 15 | Production release | Signed, packaged, E2E pass |

---

## Risk Register

| Risk | P | Impact | Mitigation |
|---|---|---|---|
| RPC protocol changes | M | H | Type generation from source; CI diff detection |
| Streaming performance | M | H | 16ms batching, virtual scroll, RAF cadence |
| Plan/goal/vibe/loop blocked | H | M | Documented v1 limitation; revisit if upstream adds handlers |
| Session file format changes | L | M | Only read headers/tails; full history via RPC |
| omp binary not found | M | L | Multi-path resolution, user config, error dialog |
| Large tool outputs | H | M | Truncation, lazy expansion, streaming |
| Memory leaks (long sessions) | M | H | Session switch clears stores, soak testing |
| Electron bundle size | L | L | ASAR, lazy load, tree shake, code split |
