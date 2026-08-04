# omp GUI — Sidecar Integration Contract

Zero-coupling specification. The GUI is a pure consumer of omp's public
wire interfaces. Every claim in this document is verified against source.

---

## Spawn

```typescript
import { spawn } from "node:child_process";

const child = spawn(ompBinary, [
  "--mode", "rpc-ui",
  "--approval-mode", approvalMode,
  ...extraFlags,
], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PI_RPC_EMIT_TITLE: "1" },
  cwd: projectDir,
});
```

`--mode rpc-ui` vs `--mode rpc`:
- `rpc-ui`: `hasUI = true` → extension UI context wired → approval prompts
  work → `ask` tool functional → extension dialogs emitted → `PI_NO_PTY=1` set
- `rpc`: `hasUI = false` → approval fails closed → `ask` tool errors →
  extension dialogs never emitted

The GUI MUST use `rpc-ui`.

---

## Frame Protocol (Verified)

### Outbound (omp stdout → GUI)

| Frame Type | Shape | Frequency |
|---|---|---|
| `ready` | `{type:"ready", protocolVersion:1, supportedProtocolVersions:[1,2], maxFrameBytes:1048576, maxReassembledFrameBytes:67108864}` | Once at start |
| `response` | `{id?, type:"response", command, success, data?/error?, code?}` | Per command |
| AgentSessionEvent | `{type: "agent_start"\|"message_update"\|...}` (24 types) | Continuous |
| `extension_ui_request` | `{type:"extension_ui_request", id, method, ...}` | On demand |
| `host_tool_call` | `{type:"host_tool_call", callId, name, args}` | On demand |
| `host_tool_cancel` | `{type:"host_tool_cancel", callId}` | On demand |
| `host_uri_request` | `{type:"host_uri_request", requestId, url, operation}` | On demand |
| `host_uri_cancel` | `{type:"host_uri_cancel", requestId}` | On demand |
| `subagent_lifecycle` | `{type:"subagent_lifecycle", ...payload}` | Per subscription |
| `subagent_progress` | `{type:"subagent_progress", ...payload}` | Per subscription |
| `subagent_event` | `{type:"subagent_event", ...payload}` | Per subscription |
| `available_commands_update` | `{type:"available_commands_update", commands}` | On change |
| `prompt_result` | `{type:"prompt_result", id?, agentInvoked}` | Per local-only prompt |
| `command_output` | `{type:"command_output", ...}` | Per slash command |
| `session_info_update` | `{type:"session_info_update", ...}` | On change |
| `config_update` | `{type:"config_update", ...}` | On change |
| `extension_error` | `{type:"extension_error", extensionPath, event, error}` | On error |
| `rpc_chunk` | `{type:"rpc_chunk", chunkId, index, count, byteLength, data}` | For frames >1MiB |

### Inbound (GUI → omp stdin)

| Frame Type | Shape | Notes |
|---|---|---|
| RpcCommand | `{id?, type: "<command>", ...args}` (42 commands) | Serialized (except bash) |
| `extension_ui_response` | `{type:"extension_ui_response", id, value?/confirmed?/cancelled?}` | Side-channel (immediate) |
| `host_tool_result` | `{type:"host_tool_result", callId, result?, error?}` | Side-channel |
| `host_tool_update` | `{type:"host_tool_update", callId, update}` | Side-channel |
| `host_uri_result` | `{type:"host_uri_result", requestId, content?, error?}` | Side-channel |

---

## v2 Chunk Reassembly (Verified Against rpc-frame.ts)

Frames exceeding 1MiB are emitted as `rpc_chunk` sequences:

```typescript
class ChunkReassembler {
  #pending = new Map<string, { chunks: Buffer[]; count: number; byteLength: number }>();

  feed(frame: { chunkId: string; index: number; count: number; byteLength: number; data: string }): Buffer | null {
    const entry = this.#pending.get(frame.chunkId) ?? {
      chunks: [],
      count: frame.count,
      byteLength: frame.byteLength,
    };

    // Validate ordering
    if (frame.index !== entry.chunks.length) {
      this.#pending.delete(frame.chunkId);
      throw new Error(`Out-of-order chunk: expected ${entry.chunks.length}, got ${frame.index}`);
    }

    entry.chunks.push(Buffer.from(frame.data, "base64"));

    if (entry.chunks.length === entry.count) {
      this.#pending.delete(frame.chunkId);
      const full = Buffer.concat(entry.chunks);
      if (full.byteLength !== entry.byteLength) {
        throw new Error(`Byte length mismatch: expected ${entry.byteLength}, got ${full.byteLength}`);
      }
      if (full.byteLength > 67_108_864) {
        throw new Error("Exceeds maxReassembledFrameBytes (64MB)");
      }
      return full; // → JSON.parse(full.toString("utf-8"))
    }

    this.#pending.set(frame.chunkId, entry);
    return null;
  }
}
```

---

## Request/Response Correlation

```typescript
class RpcClient {
  #pending = new Map<string, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  #nextId = 0;
  #send: (frame: object) => void;

  async command(cmd: Record<string, unknown>): Promise<RpcResponse> {
    const id = `gui-${++this.#nextId}`;
    const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`RPC timeout: ${cmd.type}`));
    }, 30_000);
    this.#pending.set(id, { resolve, reject, timer });
    this.#send({ ...cmd, id });
    return promise;
  }

  onResponse(frame: { id?: string; success: boolean; error?: string; code?: string }) {
    if (!frame.id) return; // Unsolicited (unknown command errors have id: undefined)
    const entry = this.#pending.get(frame.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#pending.delete(frame.id);
    if (frame.success) entry.resolve(frame);
    else entry.reject(new RpcError(frame.error ?? "Unknown error", frame.code));
  }
}
```

### Serialization Constraint

Commands are processed one-at-a-time by `RpcInputDispatcher`. Only `bash`
is dispatched in background (allows concurrent `abort_bash`). Side-channel
frames (`extension_ui_response`, `host_tool_*`, `host_uri_result`) bypass
the queue entirely.

The GUI MUST NOT assume parallel command execution.

---

## All 42 RPC Commands (Verified Implemented)

### Protocol
- `negotiate_protocol` {protocolVersion: 2}

### Prompting
- `prompt` {message, images?, streamingBehavior?}
- `steer` {message, images?}
- `follow_up` {message, images?}
- `abort`
- `abort_and_prompt` {message, images?}
- `new_session` {parentSession?}

### State
- `get_state`
- `set_fast_mode` {enabled}
- `get_available_commands`
- `set_todos` {phases}
- `set_host_tools` {tools}
- `set_host_uri_schemes` {schemes}
- `set_subagent_subscription` {level: "off"|"progress"|"events"}
- `get_subagents`
- `get_subagent_messages` {subagentId?, sessionFile?, fromByte?}

### Model
- `set_model` {provider, modelId}
- `cycle_model`
- `get_available_models`

### Thinking
- `set_thinking_level` {level}
- `cycle_thinking_level`

### Queue Modes
- `set_steering_mode` {mode: "all"|"one-at-a-time"}
- `set_follow_up_mode` {mode: "all"|"one-at-a-time"}
- `set_interrupt_mode` {mode: "immediate"|"wait"}

### Compaction
- `compact` {customInstructions?}
- `set_auto_compaction` {enabled}

### Retry
- `set_auto_retry` {enabled}
- `abort_retry`

### Bash
- `bash` {command} — background-dispatched
- `abort_bash`

### Session
- `get_session_stats`
- `export_html` {outputPath?}
- `switch_session` {sessionPath}
- `branch` {entryId}
- `get_branch_messages`
- `get_last_assistant_text`
- `set_session_name` {name}
- `handoff` {customInstructions?} — refused while streaming

### Messages
- `get_messages`
- `get_messages_page` {cursor?, limit?} — errors: `session_busy`, `stale_cursor`

### Login
- `get_login_providers`
- `login` {providerId}

---

## All 24 Event Types (Verified Emitted)

### Core AgentEvent (10)
1. `agent_start`
2. `agent_end` {messages, telemetry?, coverage?, isTerminal?}
3. `turn_start`
4. `turn_end` {message, toolResults}
5. `message_start` {message}
6. `message_update` {message, assistantMessageEvent}
7. `message_end` {message}
8. `tool_execution_start` {toolCallId, toolName, args, intent?}
9. `tool_execution_update` {toolCallId, toolName, args, partialResult}
10. `tool_execution_end` {toolCallId, toolName, result, isError?}

### Session-Specific (14)
11. `auto_compaction_start` {reason, action}
12. `auto_compaction_end` {action, result, aborted, willRetry, errorMessage?, skipped?}
13. `auto_retry_start` {attempt, maxAttempts, delayMs, errorMessage, errorId?}
14. `auto_retry_end` {success, attempt, finalError?, recoveredErrors?}
15. `retry_fallback_applied` {from, to, role}
16. `retry_fallback_succeeded` {model, role}
17. `model_changed`
18. `ttsr_triggered` {rules}
19. `todo_reminder` {todos, attempt, maxAttempts}
20. `todo_auto_clear`
21. `irc_message` {message: CustomMessage}
22. `notice` {level, message, source?}
23. `thinking_level_changed` {thinkingLevel, configured?, resolved?}
24. `goal_updated` {goal, state?}

---

## Extension UI Methods (11, Verified)

| Method | Payload | Response | Notes |
|---|---|---|---|
| `select` | {title, options: string[], timeout?} | {value} or {cancelled} | Used for tool approval |
| `confirm` | {title, message, timeout?} | {confirmed: bool} or {cancelled} | |
| `input` | {title, placeholder?, timeout?} | {value} or {cancelled} | |
| `editor` | {title, prefill?, promptStyle?} | {value} or {cancelled} | CodeMirror in GUI |
| `notify` | {message, notifyType?} | None | Fire-and-forget |
| `setStatus` | {statusKey, statusText?} | None | Fire-and-forget |
| `setWidget` | {widgetKey, widgetLines?: string[], widgetPlacement?} | None | String arrays only |
| `setTitle` | {title} | None | Gated: `PI_RPC_EMIT_TITLE=1` |
| `set_editor_text` | {text} | None | Fire-and-forget |
| `open_url` | {url, launchUrl?, instructions?} | {value: "done"} | OAuth flow |
| `cancel` | {targetId} | None | Dismiss pending dialog |

**NOT available:** `askDialog` (rich multi-question radio/checkbox) — absent
from `RpcExtensionUIContext`. Callers degrade to sequential select/input.

---

## Stats HTTP API (15 Endpoints, Verified)

All GET. Base: `http://localhost:3847`. Range param: `1h|24h|7d|30d|90d|all` (default `24h`).

| # | Path | Params | Response |
|---|---|---|---|
| 1 | `/api/stats` | range? | Full `DashboardStats` (heavy) |
| 2 | `/api/stats/overview` | range? | {overall, byAgentType, timeSeries} |
| 3 | `/api/stats/model-dashboard` | range? | {byModel, modelSeries, modelPerformanceSeries} |
| 4 | `/api/stats/costs` | range? | {costSeries} |
| 5 | `/api/stats/behavior` | range? | BehaviorDashboardStats |
| 6 | `/api/stats/tools` | range? | ToolDashboardStats |
| 7 | `/api/stats/providers` | range? | ProviderDashboardStats |
| 8 | `/api/stats/recent` | limit? (default 50) | MessageStats[] |
| 9 | `/api/stats/errors` | range?, limit? | MessageStats[] |
| 10 | `/api/stats/models` | range? | ModelStats[] |
| 11 | `/api/stats/folders` | range? | FolderStats[] |
| 12 | `/api/stats/timeseries` | range? | TimeSeriesPoint[] |
| 13 | `/api/request/:id` | (path) | RequestDetails or 404 |
| 14 | `/api/sync` | (none) | {processed, files, totalMessages} |
| 15 | `/api/stats/gain` | range?, project? | GainDashboardStats |

Discovery: probe `GET /api/stats/models` → check `x-omp-stats-dashboard: 1` header.
No WebSocket/SSE. Pure polling (30s per active route).

---

## Daemon Broker (Optional)

Socket: `~/.omp/daemon/<project-hash>/broker.sock`
Auth: read token from `~/.omp/daemon/<project-hash>/broker.token`

```typescript
// Request envelope
{ id: string, auth: string, operation: DaemonOperation }

// Operations
{ op: "list" }
{ op: "logs", name, lines?, head?, grep? }
{ op: "send", name, data?, signal? }
{ op: "stop", name, timeoutMs }
{ op: "describe", name }
```

Used for: interactive terminal panel (PTY attach), process management.
GUI works fully without it.

---

## Error Handling

### Sidecar Exit Codes

| Code | Meaning | GUI Action |
|---|---|---|
| 0 | Normal shutdown (stdin closed) | No restart, show "Disconnected" |
| 1 | Error | Restart with backoff (1s, 2s, 4s), max 3 |
| 2+ | Fatal | Show error dialog, no restart |
| Signal | Crash | Treat as exit(1) |

### RPC Error Responses

```typescript
// Standard error
{ id, type: "response", command, success: false, error: "message" }

// With machine-readable code
{ id, type: "response", command, success: false, error: "...", code: "session_busy" }
{ id, type: "response", command, success: false, error: "...", code: "stale_cursor" }

// Unknown command (id: undefined)
{ type: "response", command: "parse", id: undefined, success: false, error: "..." }
```

### Reconnection

If sidecar dies mid-session:
1. Show "Connection lost" banner
2. Attempt restart (backoff)
3. On reconnect: `negotiate_protocol` → `get_state` → `get_messages_page` (resync)
4. Session file persists — no data loss
5. Streaming state resets (agent turn lost, user re-prompts)

---

## Host Tools (GUI as Host)

Registered after ready frame via `set_host_tools`:

| Tool | Description | Parameters |
|---|---|---|
| `gui_open_url` | Open URL in system browser | {url: string} |
| `gui_notify` | Show OS notification | {title: string, body?: string} |
| `gui_select_file` | Native file picker | {filters?: {name, extensions[]}[]} |
| `gui_clipboard_read` | Read clipboard text | {} |

Host URI schemes: none in v1 (future: `gui://screenshot`).
