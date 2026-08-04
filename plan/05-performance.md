# omp GUI — Performance Strategy

## Targets

| Metric | Target | Measurement Method |
|---|---|---|
| Cold start to interactive | < 1.5s | Window visible + ready frame received + first paint |
| Session load (100 messages) | < 200ms | First paint of conversation |
| Session load (1000 messages) | < 800ms | Virtual list populated |
| Streaming token latency | < 16ms (60fps) | Delta event → pixel |
| Tool card render | < 8ms | Event → card visible |
| Memory (idle, 1 session) | < 200MB | Electron process tree RSS |
| Memory (streaming, tools active) | < 400MB | Peak during heavy turn |
| Session list scan (500 sessions) | < 300ms | Sidebar populated |
| Stats dashboard load | < 500ms | Charts rendered |

---

## Streaming Batching (Critical Path)

Token deltas arrive at 50-200/s during fast generation. Per-delta setState
causes re-render storms. Solution: 3-stage pipeline.

### Stage 1: Main Process Batcher

```typescript
// event-batcher.ts
const BATCH_MS = 16; // 60fps cadence
let pending: AgentSessionEvent[] = [];
let scheduled = false;

function onEvent(event: AgentSessionEvent) {
  pending.push(event);
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, BATCH_MS);
  }
}

function flush() {
  scheduled = false;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  win.webContents.send("rpc:events", batch);
}
```

### Stage 2: Renderer Store Accumulation

```typescript
// stores/messages.ts
const streamBuffer = { text: "", thinking: "" }; // mutable ref, not state

function applyBatch(events: AgentSessionEvent[]) {
  for (const event of events) {
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta.type === "text_delta") streamBuffer.text += delta.delta;
      if (delta.type === "thinking_delta") streamBuffer.thinking += delta.delta;
    }
  }
  // Single setState per batch → one re-render
  set({ streamVersion: ++version });
}
```

### Stage 3: Component Read

```typescript
// StreamingText.tsx
function StreamingText() {
  const version = useMessagesStore(s => s.streamVersion);
  const text = streamBuffer.text; // read from ref, not state
  return <span>{text}<Cursor active /></span>;
}
```

Result: 1 re-render per 16ms regardless of token frequency.

---

## Virtual Scrolling

`@tanstack/react-virtual` for conversation stream.

- Estimate row height: 80px (user) / 200px (assistant) until measured
- Cache measured heights in Map<messageId, number>
- Overscan: 5 items above/below viewport
- Mounted DOM: ~30 nodes for any session size
- Scroll container: `overflow-y: auto` with `contain: strict`

### Infinite Scroll (History)

- `get_messages_page` loads pages of 256 (max)
- Virtual list requests pages on scroll-to-top
- Retain 3 pages in memory (prev, current, next)
- On `session_busy` error: retry after `agent_end` event
- On `stale_cursor` error: discard partial, re-fetch from current tail

---

## Tool Card Rendering

- `React.memo` with stable keys (toolCallId)
- Streaming updates (bash output, eval cells): append via ref, not state
- Completed cards: frozen (no re-render on parent updates)
- Large outputs (>10KB): truncated with "Show more" (lazy mount full content)
- Diff streaming: strip trailing unbalanced removals (matches TUI `stripTrailingUnbalancedRemoval`)

---

## Markdown Rendering

- During streaming: render raw text with minimal formatting (no parse)
- On `message_end`: full markdown parse + syntax highlight + KaTeX
- Mermaid: `import("mermaid")` dynamic, render in requestIdleCallback
- Code blocks: highlight.js with subset (ts, py, rs, go, bash, json, yaml, toml, sql)
- Cache parsed markdown per message (WeakMap<AgentMessage, ReactNode>)

---

## Memory Management

| Scenario | Strategy |
|---|---|
| Active session messages | Zustand store (structured objects, not raw JSON) |
| Scrollback beyond viewport | Virtualized, DOM unmounted |
| Completed tool outputs > 50KB | Truncated in store; full data on disk |
| Images | Object URLs, revoked on unmount |
| Session switch | Previous store cleared (GC eligible) |
| Background windows | `backgroundThrottling = true`, pause event forwarding |
| Main process | No retained references to old sessions |

---

## Startup Critical Path

```
T+0ms     Electron app ready
T+50ms    Create BrowserWindow (parallel: spawn sidecar)
T+200ms   Renderer HTML/JS loaded (bundled, code-split)
T+300ms   Sidecar stdout → ready frame received
T+310ms   negotiate_protocol v2 → success
T+350ms   get_state + session list (parallel IPC)
T+400ms   First paint (skeleton → populated)
─────────────────────────────────────────────────
Total:    ~400ms (optimistic) / ~1000ms (cold disk)
```

Optimizations:
- Window load and sidecar spawn run in parallel
- Renderer bundle code-split: critical layout first, panels lazy
- Session index cached in electron-store (instant sidebar on relaunch)
- Stats client lazy (only on stats tab open)
- Mermaid, CodeMirror, xterm.js: dynamic imports (not in initial bundle)

---

## IPC Performance

- Structured clone (Electron default) — no JSON.stringify overhead
- Event batches: typed arrays where feasible
- Large payloads (messages array): transferable ArrayBuffer
- Channel priority:
  - High: `rpc:events` (batched, 60fps max)
  - Medium: `rpc:response` (per command)
  - Low: `session:list`, `stats:data`, `settings:changed`

### Backpressure

If renderer can't consume:
1. Main buffers up to 1000 events
2. Beyond buffer: drop `tool_execution_update` (intermediate only)
3. Never drop: `message_update` text deltas, lifecycle events, `agent_end`
4. Renderer can resync: `get_state` + `get_messages_page`

---

## Disk I/O

### Session Watching

- chokidar: `awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }`
- Debounce: 500ms batch for rapid appends during streaming
- Parse only headers (first 4KB) on change, not full files
- LRU cache: 4096 entries keyed by (mtimeMs, size) — matches CLI behavior
- Title slot: 256-byte fixed-width first line (JSON + pad)

### Log Tailing

- `fs.watch` + `fs.createReadStream({ start: lastOffset })`
- Poll fallback (1s) for platforms where fs.watch unreliable
- Ring buffer: 1000 lines in memory
- Virtual scroll for display

---

## Benchmarks (`packages/gui/bench/`)

| File | Measures |
|---|---|
| `streaming-throughput.bench.ts` | Events/sec through IPC batcher |
| `virtual-list.bench.ts` | Scroll fps with N messages |
| `session-parse.bench.ts` | JSONL header/tail parse speed |
| `markdown-render.bench.ts` | Parse + highlight latency |
| `chunk-reassembly.bench.ts` | v2 chunk decode throughput |

Run: `bun bench` (vitest bench mode).
