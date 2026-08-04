# omp GUI — Feature Catalog

Every feature mapped to its verified wire interface. Source-verified against
`rpc-mode.ts` (42 commands), `agent-session-events.ts` (24 event types),
`renderers.ts` (28 tool renderers), and `server.ts` (15 stats endpoints).

Legend: ✅ = fully available via RPC · ⚠️ = partial/workaround · ❌ = unavailable in v1

---

## 1. Conversation Core

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 1.1 | Send prompt | Input box, Enter | RPC `prompt` | ✅ |
| 1.2 | Steer mid-stream | Input box (while streaming) | RPC `steer` | ✅ |
| 1.3 | Follow-up queue | Input box (while streaming) | RPC `follow_up` | ✅ |
| 1.4 | Abort turn | Stop button, Esc | RPC `abort` | ✅ |
| 1.5 | Abort + new prompt | Input box (replaces current) | RPC `abort_and_prompt` | ✅ |
| 1.6 | Streaming text | Token-by-token render | Event `message_update` → `assistantMessageEvent.type: "text_delta"` | ✅ |
| 1.7 | Thinking stream | Collapsible block | Event `message_update` → `assistantMessageEvent.type: "thinking_delta"` | ✅ |
| 1.8 | Tool call stream | Live tool card | Event `message_update` → `assistantMessageEvent.type: "toolcall_delta"` | ✅ |
| 1.9 | Image attachments | Paste/drag into input | RPC `prompt.images: ImageContent[]` | ✅ |
| 1.10 | Message history | Virtual scroll list | RPC `get_messages_page` (cursor pagination, max 256/page) | ✅ |
| 1.11 | Last assistant text | Copy button | RPC `get_last_assistant_text` | ✅ |
| 1.12 | Markdown rendering | GFM + code + LaTeX + Mermaid | Renderer-side (react-markdown + rehype) | ✅ |
| 1.13 | Interrupt mode | Settings toggle | RPC `set_interrupt_mode` ("immediate"\|"wait") | ✅ |
| 1.14 | Steering mode | Settings toggle | RPC `set_steering_mode` ("all"\|"one-at-a-time") | ✅ |
| 1.15 | Follow-up mode | Settings toggle | RPC `set_follow_up_mode` ("all"\|"one-at-a-time") | ✅ |
| 1.16 | Skill invocation | `skill://name` in prompt | RPC `prompt` (server routes via `tryRunRpcSkillCommand`) | ✅ |
| 1.17 | Text-mode slash commands | `/compact`, `/clear`, `/model` etc. | RPC `prompt` (server routes via `executeAcpBuiltinSlashCommand`) | ✅ |

**Pagination error handling:** `get_messages_page` returns error code
`session_busy` (streaming/compacting) or `stale_cursor` (snapshot changed).
GUI retries after stream ends; discards partial pages on stale cursor.

---

## 2. Session Management

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 2.1 | Session list | Sidebar, searchable | Read `~/.omp/sessions/` headers (256-byte title slot + 4KB JSON header) | ✅ |
| 2.2 | Session status badges | complete/interrupted/aborted/error/pending | Derived from 32KB tail parse (last message type) | ✅ |
| 2.3 | New session | Cmd+N | RPC `new_session` (optional `parentSession`) | ✅ |
| 2.4 | Switch session | Click in sidebar | RPC `switch_session` | ✅ |
| 2.5 | Rename session | Inline edit | RPC `set_session_name` | ✅ |
| 2.6 | Branch from message | Context menu | RPC `branch` (entryId) + `get_branch_messages` | ✅ |
| 2.7 | Session stats | Info panel | RPC `get_session_stats` | ✅ |
| 2.8 | Export HTML | Menu → save dialog | RPC `export_html` (outputPath) | ✅ |
| 2.9 | Handoff | Menu action | RPC `handoff` (refused while streaming — disable button) | ✅ |
| 2.10 | Delete session | Context menu + confirm | Direct file deletion (`fs.unlink`) — exception to read-only | ⚠️ |
| 2.11 | Recent sessions | Welcome screen | Session index sorted by mtime | ✅ |
| 2.12 | Cross-project sessions | Sidebar scope toggle | Read global `~/.omp/sessions/` | ✅ |
| 2.13 | Session tree (fork graph) | Visual tree | Header `parentSession` field + branch data | ✅ |
| 2.14 | Paginated history | Infinite scroll | RPC `get_messages_page` (cursor, limit≤256) | ✅ |

---

## 3. Model & Provider

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 3.1 | Model picker | Grouped dropdown | RPC `get_available_models` (awaits background refresh) | ✅ |
| 3.2 | Switch model | Picker selection | RPC `set_model` (provider, modelId) | ✅ |
| 3.3 | Cycle model | Keyboard shortcut | RPC `cycle_model` | ✅ |
| 3.4 | Thinking level | 7-level selector | RPC `set_thinking_level` / `cycle_thinking_level` | ✅ |
| 3.5 | Fast mode | Toggle in title bar | RPC `set_fast_mode` + `get_state.fastModeActive` | ✅ |
| 3.6 | Context usage | Progress bar | `get_state.contextUsage` {tokens, contextWindow, percent} | ✅ |
| 3.7 | Tokens/sec | Status indicator | `get_state.tokensPerSecond` (number\|null) | ✅ |
| 3.8 | Login providers | Settings → Auth | RPC `get_login_providers` + `login` (OAuth via `open_url` extension UI) | ✅ |
| 3.9 | Model change notification | Toast | Event `model_changed` | ✅ |
| 3.10 | Thinking level change | Toast + indicator | Event `thinking_level_changed` {thinkingLevel, configured?, resolved?} | ✅ |

---

## 4. Tool Execution Visualization

Data source: events `tool_execution_start` / `tool_execution_update` / `tool_execution_end`.

### Tools with dedicated TUI renderers (port rendering logic to React):

| # | Tool | Renderer Description |
|---|---|---|
| 4.1 | `read` | File preview, syntax highlight, line numbers, selector display |
| 4.2 | `write` | File path + content preview (collapsible) |
| 4.3 | `edit` / `apply_patch` | Inline diff (before/after), hashline display, streaming diff stabilization |
| 4.4 | `bash` | Command + terminal output, exit code badge, streaming lines |
| 4.5 | `glob` | File tree of matches |
| 4.6 | `grep` | Match list: file:line:content, syntax highlighted |
| 4.7 | `ast_edit` | AST pattern → replacement diff |
| 4.8 | `ast_grep` | AST match results |
| 4.9 | `browser` | Screenshot thumbnail, action log |
| 4.10 | `computer` | Screenshot + action overlay |
| 4.11 | `debug` | Stack frames, variables, breakpoints |
| 4.12 | `eval` | Code cell with output (Python/JS/Julia/Ruby) |
| 4.13 | `github` | GitHub entity card (issue/PR/repo) |
| 4.14 | `hub` | Agent roster, message log, process list (displaceable when polling) |
| 4.15 | `inspect_image` | Image with annotations |
| 4.16 | `lsp` | LSP operation result (references/rename/diagnostics) |
| 4.17 | `read` | File content with syntax highlighting |
| 4.18 | `resolve` / `reject` | Resolution card (xd:// device) |
| 4.19 | `retain` | Memory retain confirmation |
| 4.20 | `recall` | Recall results list |
| 4.21 | `reflect` | Reflection card |
| 4.22 | `task` | Subagent spawn card with progress (lazy-loaded renderer) |
| 4.23 | `todo` | Todo list with phases and status (displaceable) |
| 4.24 | `goal` | Goal card |
| 4.25 | `web_search` | Search results with sources |
| 4.26 | `vibe_spawn/send/wait/kill/list` | Worker session cards |
| 4.27 | `ask` | Interactive question dialog (renders as extension UI select/confirm) |

### Tools using generic renderer (GUI builds rich renderers — opportunity to exceed TUI):

| # | Tool | GUI Renderer |
|---|---|---|
| 4.28 | `image_gen` | Generated image preview with download |
| 4.29 | `tts` | Audio player with waveform |
| 4.30 | `checkpoint` | Checkpoint marker with timestamp |
| 4.31 | `learn` | Skill/memory learning card |
| 4.32 | `manage_skill` | Skill management card |
| 4.33 | `memory_edit` | Memory diff viewer |
| 4.34 | `review` | Review findings list with severity |
| 4.35 | `security_scan` | SARIF findings table |
| 4.36 | `xdev` | Device operation card |
| 4.37 | `yield` | Yield/handoff card |
| 4.38 | `report_tool_issue` | Issue report card |
| 4.39 | MCP tools | Generic JSON schema renderer + per-server custom |
| 4.40 | Host tools | Generic renderer + host-provided metadata |
| 4.41 | Custom tools | Generic card: name/description/args/result |

### Tool card states

Each card: `pending` (spinner) → `running` (streaming `tool_execution_update`)
→ `success` (green ✓ + duration) / `error` (red ✗ + message) / `cancelled` (grey).

---

## 5. Subagent & Task Orchestration

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 5.1 | Subscribe to subagents | Auto on session start | RPC `set_subagent_subscription("events")` | ✅ |
| 5.2 | Subagent list | Tree panel | RPC `get_subagents` → `RpcSubagentSnapshot[]` | ✅ |
| 5.3 | Lifecycle events | Status badges | Event `subagent_lifecycle` {status: started\|completed\|failed\|cancelled} | ✅ |
| 5.4 | Progress events | Activity line | Event `subagent_progress` {progress: AgentProgress} | ✅ |
| 5.5 | Full events | Expandable log | Event `subagent_event` {AgentSessionEvent data} | ✅ |
| 5.6 | Subagent transcript | Full viewer | RPC `get_subagent_messages` (byte-cursor pagination: fromByte/nextByte) | ✅ |
| 5.7 | IRC messages | Message feed | Event `irc_message` {message: CustomMessage} | ✅ |

---

## 6. Todo & Planning

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 6.1 | Todo phases/tasks | Collapsible tree | `get_state.todoPhases` (id, name, tasks[{id, content, status}]) | ✅ |
| 6.2 | Set/edit todos | Drag reorder, inline edit | RPC `set_todos` (phases: TodoPhase[]) | ✅ |
| 6.3 | Todo reminder | Banner | Event `todo_reminder` {todos, attempt, maxAttempts} | ✅ |
| 6.4 | Todo auto-clear | Toast | Event `todo_auto_clear` | ✅ |
| 6.5 | Plan mode | — | ❌ handleTui-only (`/plan` filtered from RPC) | ❌ |

---

## 7. Compaction & Context

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 7.1 | Manual compact | Dialog + menu | RPC `compact` (customInstructions?) → CompactionResult | ✅ |
| 7.2 | Auto-compaction toggle | Settings | RPC `set_auto_compaction` (enabled) | ✅ |
| 7.3 | Compaction progress | Banner | Events `auto_compaction_start` {reason, action} / `auto_compaction_end` {result, aborted, willRetry} | ✅ |
| 7.4 | Context usage | Title bar bar | `get_state.contextUsage` | ✅ |

---

## 8. Retry & Resilience

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 8.1 | Auto-retry toggle | Settings | RPC `set_auto_retry` (enabled) | ✅ |
| 8.2 | Abort retry | Button (during retry) | RPC `abort_retry` | ✅ |
| 8.3 | Retry progress | Banner | Events `auto_retry_start` {attempt, maxAttempts, delayMs} / `auto_retry_end` {success} | ✅ |
| 8.4 | Fallback model | Toast | Events `retry_fallback_applied` {from, to} / `retry_fallback_succeeded` {model} | ✅ |
| 8.5 | Retry last turn | — | ❌ No RPC command. Workaround: re-send last user message via `prompt` | ⚠️ |

---

## 9. Bash & Terminal

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 9.1 | Agent bash | Tool card + streaming output | `tool_execution_*` events for bash tool | ✅ |
| 9.2 | User bash | Input `!command` | RPC `bash` (background-dispatched, concurrent) | ✅ |
| 9.3 | Abort bash | Button | RPC `abort_bash` | ✅ |
| 9.4 | Interactive terminal | xterm.js panel | Daemon broker PTY (optional, requires broker socket + token) | ⚠️ |

---

## 10. Extension UI

All arrive as `extension_ui_request` frames. GUI responds via
`extension_ui_response` (side-channel, bypasses command queue).

| # | Method | GUI Surface | Response | Status |
|---|---|---|---|---|
| 10.1 | `select` | Modal with options list | `{id, value: selectedOption}` | ✅ |
| 10.2 | `confirm` | Modal yes/no | `{id, confirmed: boolean}` | ✅ |
| 10.3 | `input` | Modal text field | `{id, value: string}` | ✅ |
| 10.4 | `editor` | Modal code editor (CodeMirror) | `{id, value: string}` | ✅ |
| 10.5 | `notify` | Toast (info/warning/error) | No response needed | ✅ |
| 10.6 | `setStatus` | Status bar segment | No response needed | ✅ |
| 10.7 | `setWidget` | Widget panel (string[] lines only) | No response needed | ✅ |
| 10.8 | `setTitle` | Title bar (requires `PI_RPC_EMIT_TITLE=1`) | No response needed | ✅ |
| 10.9 | `set_editor_text` | Input box content update | No response needed | ✅ |
| 10.10 | `open_url` | Open system browser + instructions | `{id, value: "done"}` after user action | ✅ |
| 10.11 | `cancel` | Dismiss target dialog | No response needed | ✅ |
| 10.12 | Timeout | Auto-dismiss with countdown | `{id, cancelled: true, timedOut: true}` | ✅ |
| 10.13 | `askDialog` (rich multi-question) | — | ❌ Not implemented in RPC UI context | ❌ |

**Tool approval** rides on `select` (method 10.1) when `--approval-mode` is
not `yolo`. The approval prompt is free-text (tool name + args + tier).
GUI renders it as a styled approval dialog with Approve/Deny buttons.

---

## 11. Slash Commands

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 11.1 | Command palette | Cmd+K, fuzzy search | RPC `get_available_commands` + `available_commands_update` frame | ✅ |
| 11.2 | `/` autocomplete | Inline dropdown | Same data source | ✅ |
| 11.3 | Command output | Inline block | `command_output` frame | ✅ |
| 11.4 | Session info update | Sidebar refresh | `session_info_update` frame | ✅ |
| 11.5 | Config update | Settings refresh | `config_update` frame | ✅ |
| 11.6 | TUI-only commands | — | ❌ `/plan`, `/goal`, `/vibe`, `/loop` (handleTui-only) | ❌ |

---

## 12. File & Workspace

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 12.1 | File tree | Sidebar panel | Main process reads project directory (fs.readdir) | ✅ |
| 12.2 | @file mention | Autocomplete in input | File tree + inserted into prompt text | ✅ |
| 12.3 | Diff viewer | Side-by-side / inline | Edit tool events + file content from read | ✅ |
| 12.4 | File preview | Syntax-highlighted | Read tool results / direct fs read | ✅ |

---

## 13. Stats & Analytics

All endpoints: GET, polling (30s), range param `1h|24h|7d|30d|90d|all`.

| # | Feature | GUI Route | Endpoint | Status |
|---|---|---|---|---|
| 13.1 | Overview | /stats/overview | `GET /api/stats/overview?range=` | ✅ |
| 13.2 | Model analytics | /stats/models | `GET /api/stats/model-dashboard?range=` | ✅ |
| 13.3 | Provider breakdown | /stats/providers | `GET /api/stats/providers?range=` | ✅ |
| 13.4 | Tool usage | /stats/tools | `GET /api/stats/tools?range=` | ✅ |
| 13.5 | Cost tracking | /stats/costs | `GET /api/stats/costs?range=` | ✅ |
| 13.6 | Error tracking | /stats/errors | `GET /api/stats/errors?range=&limit=` | ✅ |
| 13.7 | Behavior analysis | /stats/behavior | `GET /api/stats/behavior?range=` | ✅ |
| 13.8 | Gain analysis | /stats/gain | `GET /api/stats/gain?range=&project=` | ✅ |
| 13.9 | Project breakdown | /stats/projects | `GET /api/stats/folders?range=` | ✅ |
| 13.10 | Request log | /stats/requests | `GET /api/stats/recent?limit=` | ✅ |
| 13.11 | Request detail | Drawer on click | `GET /api/request/:id` | ✅ |
| 13.12 | Manual sync | Button | `GET /api/sync` | ✅ |

---

## 14. Settings & Configuration

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 14.1 | Display config | Tabbed form | Read `~/.omp/config.yml` (main process, read-only) | ✅ |
| 14.2 | Approval mode | Spawn-time selector | CLI flag `--approval-mode` (always-ask\|write\|yolo) | ✅ |
| 14.3 | Runtime toggles | Settings panel | RPC: `set_fast_mode`, `set_thinking_level`, `set_steering_mode`, `set_follow_up_mode`, `set_interrupt_mode`, `set_auto_compaction`, `set_auto_retry` | ✅ |
| 14.4 | Arbitrary settings edit | — | ❌ No `set_setting` RPC command | ❌ |
| 14.5 | Theme switching | — | ❌ `setTheme` returns error in RPC | ❌ |
| 14.6 | GUI preferences | GUI-only settings | `~/.omp/gui/preferences.json` (electron-store) | ✅ |

---

## 15. Notices & Notifications

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 15.1 | Info/warning/error | Toast + panel | Event `notice` {level, message, source?} | ✅ |
| 15.2 | TTSR triggered | Banner | Event `ttsr_triggered` {rules} | ✅ |
| 15.3 | Extension errors | Error list | `extension_error` frame {extensionPath, event, error} | ✅ |
| 15.4 | Goal updated | Sidebar card | Event `goal_updated` {goal, state?} | ✅ |

---

## 16. Host Tools & URI Schemes

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 16.1 | Register host tools | Auto on ready | RPC `set_host_tools` (name, description, parameters JSON Schema) | ✅ |
| 16.2 | Handle tool calls | Execute + respond | `host_tool_call` frame → `host_tool_result` / `host_tool_update` | ✅ |
| 16.3 | Register URI schemes | Auto on ready | RPC `set_host_uri_schemes` (scheme, description, writable) | ✅ |
| 16.4 | Handle URI requests | Execute + respond | `host_uri_request` frame → `host_uri_result` | ✅ |

GUI-provided host tools:
- `gui_open_url` — open URL in system browser
- `gui_show_notification` — OS notification
- `gui_select_file` — native file picker dialog
- `gui_get_clipboard` — read clipboard content

---

## 17. Window & System

| # | Feature | Implementation |
|---|---|---|
| 17.1 | Multi-window | One session per BrowserWindow; state persisted |
| 17.2 | System tray | Electron Tray; status icon; quick actions |
| 17.3 | Global shortcuts | Cmd+Shift+O toggle window (configurable) |
| 17.4 | Deep links | `omp://session/<id>`, `omp://new` |
| 17.5 | Native notifications | Turn complete, error, subagent finished |
| 17.6 | Auto-update | electron-updater; GitHub Releases |
| 17.7 | Application menu | Full menu bar (File, Edit, View, Session, Help) |

---

## 18. Log & Debug

| # | Feature | GUI Surface | Wire Interface | Status |
|---|---|---|---|---|
| 18.1 | Log viewer | Searchable panel | Tail `~/.omp/logs/omp.*.log` (main process) | ✅ |
| 18.2 | Protocol errors | Debug panel | RPC error responses + `rpc_frame_error` frame | ✅ |
