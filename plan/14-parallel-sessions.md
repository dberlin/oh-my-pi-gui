# 14 — Multi-Window Parallel Sessions (Window ↔ Sidecar Pool)

**Status**: plan, not yet implemented. Source-verified against current `packages/gui` (2026-08-05).
**Goal**: true parallel sessions — up to **10** sidecars running concurrently, each bound 1:1 to a window. Switching/creating a session must never disturb a session that is running in another window.

---

## 1. Problem

The GUI is a **single-sidecar** app: one `SidecarManager` global singleton (`index.ts:110,122`), one agent process, one active session. Every window is just another view of the same agent — all sidecar events are `broadcast()` to every window (`ipc.ts:667-673`), and the 14 zustand stores in each window mirror the *same* session.

Consequences today:

- "Parallel work" is impossible: switching a session aborts the in-flight turn (`agent-session.ts` `switchSession → abort`).
- Multiple windows show the *same* session, not independent ones.
- The renderer is already per-window autonomous (each window hydrates itself via `getStatus` + `use-rpc-events`), but the main process routes every window's IPC to the one global sidecar.

**Decision (confirmed with user)**: multi-window parallelism. Each window owns its own sidecar. Max 10 concurrent. Default open/switch still replaces the current window's session (server aborts, as today); parallelism is an explicit "open in new window" action.

### Confirmed decisions

| Question | Choice |
|---|---|
| Default new/open session behavior | **(a)** Replace the current window's session (server abort + switch, as today). Parallelism is an explicit "open in new window" action. |
| At the 10-window cap | **(a)** Refuse with a toast ("已达 10 个并行上限"), never auto-kill. |
| Closing a window | Its sidecar is killed → that session's turn stops (unavoidable; accepted). |

---

## 2. Architecture

```
WindowManager (per-window registry)        SidecarPool (per-window agent processes)
┌──────────────────┐                      ┌────────────────────┐
│ Window 1 (id w1) │◄──── 1:1 owner ─────►│ Sidecar s1 (cwd A) │
│ Window 2 (id w2) │◄──── 1:1 owner ─────►│ Sidecar s2 (cwd B) │
│ Window N (N≤10)  │◄──── 1:1 owner ─────►│ Sidecar sN (cwd ?) │
└──────────────────┘                      └────────────────────┘
        ▲                                          │
        │  events routed per-window (not broadcast)│
        └──────────────────────────────────────────┘
```

**Key insight that makes this tractable**: the renderer needs **almost no changes**. Each window already runs its own `useRpcEvents`, pulls `getStatus()`, and hydrates its own 14 stores. If the main process routes each window's IPC to *that window's* sidecar, each renderer is automatically correct — it just sees "its" sidecar.

The entire refactor lives in the **main process**:

1. `SidecarManager` → instantiated per-window by a new `SidecarPool`.
2. `broadcast()` → per-sidecar targeted send to that sidecar's owning window.
3. The 12 sidecar-dependent IPC handlers resolve `event.sender → BrowserWindow → sidecar`.
4. `WindowManager` grows a window↔sidecar binding (id, cwd, sidecar ref).
5. "Open in new window" action spawns window + sidecar for a chosen session/cwd.

### What stays global (not pooled)

- **StatsServer / StatsClient** — global singleton, one dashboard, sidecar-agnostic. Unchanged.
- **SessionIndex** — global watcher over `~/.omp/agent/sessions`, but its single `#cwd` "local" filter must become per-window (§5.4).
- **LogWatcher** — global tail of the shared log dir. Logs from N sidecars interleave; routed to all windows but tagged with source if feasible (§7, non-blocking).
- **RpcClient / EventBatcher / rpc-bridge** — already per-instance (created inside `SidecarManager.#spawn`), pool-safe as-is.
- **BrokerClient** — dead code (never instantiated). Ignore.

---

## 3. Interface contracts

### 3.1 Window identity

The refactor's linchpin: every IPC handler must know *which window* (thus which sidecar) called it. Electron gives this for free — `event.sender` is the calling window's `webContents`; `BrowserWindow.fromWebContents(event.sender)` recovers the window. No new protocol needed for commands.

For **events** (main → renderer), `broadcast()` becomes targeted: each sidecar's events go only to its owning window's `webContents.send`.

```ts
// window.ts — new binding
interface WindowRecord {
	win: BrowserWindow;
	/** stable id for logging/routing; = webContents.id */
	id: number;
	sidecar: SidecarManager | null; // null only during construction race
	cwd: string;
}

class WindowManager {
	#records = new Map<number, WindowRecord>(); // key: win.webContents.id
	createWindow(opts: { cwd?: string }): BrowserWindow;
	recordFor(win: BrowserWindow): WindowRecord | undefined;
	recordForContents(contents: WebContents): WindowRecord | undefined;
	all(): WindowRecord[];
	count(): number; // live windows, for the 10 cap
	bindSidecar(win: BrowserWindow, sidecar: SidecarManager, cwd: string): void;
}
```

### 3.2 SidecarPool

```ts
// sidecar-pool.ts — NEW
class SidecarPool {
	constructor(factory: (cwd: string) => SidecarManager, max = 10);
	/**
	 * Spawn + register a sidecar for `cwd`. Returns null at cap.
	 * MUST be atomic w.r.t. the cap: reserve the slot before the async spawn,
	 * so N concurrent acquires cannot all observe `size() < max` and overshoot.
	 */
	acquire(cwd: string): SidecarManager | null; // null at cap
	/** Kill + remove the sidecar bound to a window (on window close). */
	release(sidecar: SidecarManager): void;
	size(): number;
	disposeAll(): void; // before-quit
}
```

`SidecarManager` itself needs **no internal changes** — it is already instance-scoped. The pool just owns N of them. Its `restart(cwd)` semantics (kill + respawn same instance) stay per-instance.

### 3.3 IPC routing contract

Every sidecar-dependent handler changes from reading the closure-global `sidecar` to:

```ts
function sidecarFor(deps: IpcDeps, event: IpcMainInvokeEvent): SidecarManager | null {
	const win = BrowserWindow.fromWebContents(event.sender);
	return win ? (deps.windowManager.recordFor(win)?.sidecar ?? null) : null;
}
```

Applied to: `RPC_COMMAND`, `SIDECAR_RESTART`, `SIDECAR_SELECT_PROJECT`, `SIDECAR_SET_PROJECT`, `SIDECAR_STATUS_GET`, `FS_LIST`, `FS_READ`, `FS_READ_PLAN`, `EXTENSION_UI_RESPOND`, `HOST_TOOL_RESULT`, `HOST_TOOL_UPDATE`, `HOST_URI_RESULT`.

`HOST_TOOL_RESULT` / `HOST_TOOL_UPDATE` / `HOST_URI_RESULT` are renderer-initiated replies (the user answered a host-tool prompt), so they route by `sidecarFor(event)` like every other handler — NOT via the emitting-sidecar closure used for the main-process `executeGuiHostTool` path (§4.3). Both directions must resolve to the same sidecar or a reply lands on the wrong agent.

A null result returns the existing "Sidecar not connected" error shape (never throws — the renderer's `res.success` checks stay valid).

### 3.4 Event routing contract

`broadcast()` is replaced by per-sidecar subscription that targets the owning window:

```ts
function forwardToWindow(win: BrowserWindow, channel: string, data: unknown): void {
	if (!win.isDestroyed()) win.webContents.send(channel, data);
}
// per pooled sidecar:
sidecar.on("events", ev => forwardToWindow(ownerWin, IPC_EVENTS.EVENTS_BATCH, { events: ev }));
sidecar.on("status", p => forwardToWindow(ownerWin, IPC_EVENTS.SIDECAR_STATUS, { ...p, cwd: sidecar.cwd }));
// … all 8 sidecar.on channels, same pattern
```

Genuinely-global events keep broadcasting to all windows: `SESSIONS_CHANGED`, `LOG_LINE`, `updater:*`, `TRAY_STATE_PUSH`-driven tray, `MENU_ACTION`, `DEEP_LINK`.

### 3.5 New/open session flows

- **Replace (default, unchanged UX)**: sidebar click / `+` → current window's sidecar does `switch_session`/`new_session` (server aborts, as today). No new window.
- **Parallel (new action)**: "在新窗口打开" on a session row, on a workspace group, and a menu/⌘-modifier variant → `spawnWindowForSession(sessionPath | cwd)`:
  1. `SidecarPool.acquire(cwd)` → null at cap ⇒ toast, abort.
  2. `WindowManager.createWindow({ cwd })`.
  3. `bindSidecar(win, sidecar, cwd)`; `sidecar.start()`.
  4. Once that window's sidecar is `ready`, issue `switch_session(sessionPath)` (for a specific session) scoped to *that* window.

---

## 4. File-by-file changes

### 4.1 NEW `src/main/sidecar-pool.ts`
Pool per §3.2. Owns cap logic (10), acquire/release/disposeAll, and the per-sidecar event-forward wiring (takes the owning window at `acquire` time and attaches the 8 `sidecar.on` forwarders).

**Listener cleanup order (`release`)**: the pool attaches 8 forwarding listeners at acquire time. `release()` MUST call `sidecar.removeAllListeners()` **before** `sidecar.dispose()`. Otherwise stale forwarders survive into a `restart()` and push events at a destroyed window (leak + mis-route).

**Cap atomicity**: `acquire` reserves its slot synchronously (before the spawn) and rolls the reservation back on spawn failure. Without this, closing 2 windows then opening 3 in quick succession lets three `acquire` calls all read the pre-release `size()` and exceed the cap.

### 4.2 `src/main/window.ts` — window↔sidecar binding
- `#windows: Set` → `#records: Map<number, WindowRecord>` keyed by `webContents.id`.
- `createWindow({ cwd })` — actually use the cwd (param currently ignored at `window.ts:37`).
- Add `recordFor`, `recordForContents`, `all`, `count`, `bindSidecar`.
- On `closed`: look up the record, call a `onWindowClosed(win)` hook (provided by index.ts) → pool releases that window's sidecar.
- `setRunProgress` stays global (dock badge is app-level; per §7 noted limitation).
- Window geometry persistence: keep single `window-state` (acceptable; §7 note).

### 4.3 NEW/REFACTOR `src/main/ipc.ts`
- `IpcDeps.sidecar: SidecarManager` → `IpcDeps.pool: SidecarPool`.
- Add `sidecarFor(deps, event)` helper (§3.3); rewire the 12 handlers.
- Replace `broadcast()` sidecar fan-out with pool-driven per-window forwarding (§3.4); keep `broadcastAll()` for the genuinely-global channels.
- `hostToolCall` main-exec path (`executeGuiHostTool`) uses the *emitting* sidecar for `sendSideChannel` — available in the forwarder closure.
- `SIDECAR_SELECT_PROJECT` / `SIDECAR_SET_PROJECT`: drop the global `sessionIndex.setCwd` triple; set the **window's** cwd and restart **that window's** sidecar (per-window project switch, no global restart). Also stop broadcasting `SESSIONS_CHANGED` on success — notify only the calling window, or a window on another project sees its list churn for a switch it did not make.
- `SYSTEM_NOTIFY` dedupe key gains a source-window id so two windows' legitimate distinct notifications aren't collapsed (§7).

### 4.4 `src/main/index.ts` — composition root
- Replace the single `sidecar` with `const pool = new SidecarPool(cwd => new SidecarManager({ binaryPath, sourceCli, cwd }), 10)`.
- Startup: create first window via a new `spawnWindow(initialCwd)` helper (pool.acquire + createWindow + bindSidecar + start).
- Move the ready-health-check into the pool's per-sidecar wiring (applies to every sidecar, not one).
- `before-quit`: `pool.disposeAll()` (replaces `sidecar.dispose()`).
- Global shortcut (`Cmd+Shift+O`) decision tree, replacing today's `getMainWindow()` toggle: (1) focused window is one of ours → toggle its visibility; (2) else → show + focus the most-recently-active omp window; (3) no windows at all → `spawnWindow(initialCwd)` (cap-aware). `activate` / menu "New Window" route through `spawnWindow` too.
- `resolveInitialCwd` unchanged (only seeds the *first* window).

### 4.5 `src/main/tray.ts`, `menu.ts`, `deep-link.ts`, `updater.ts`
- Tray `send()` / menu `sendMenuAction()`: keep `getTargetWindow()` (focused window) semantics — now that maps to that window's sidecar automatically. No logic change beyond the record lookup.
- Tray `trayState` is a single global blob today; with N projects it can only show one. Keep showing the **focused** window's state (§7 limitation, documented). `use-tray-sync` already pushes per-window; main keeps the latest from the focused window only.
- "New Window" menu / tray create-window fallbacks → `spawnWindow` (cap-aware).
- deep-link `omp://new` → `spawnWindow(initialCwd)`; `omp://session/<id>` → target window's sidecar `switch_session` (replace-in-window), or a new window if none exists.
- updater: unchanged (global, already fan-out).

### 4.6 `src/main/session-index.ts`
- `setCwd` becomes obsolete as a global; `list("local")` must filter per **calling window's** cwd. Move the cwd argument into the IPC call: `SESSIONS_LIST`/`SESSIONS_SEARCH` handlers pass `sidecarFor(event).cwd` (or the window record's cwd) instead of reading the singleton `#cwd`.
- **Remove the watcher restart from `setCwd`.** Today `setCwd` tears down and re-creates the chokidar watcher; per-window project switches would then restart a *shared* watcher, making every other window's session list flicker. The watcher stays global and permanent over the sessions root (it already watches all projects); only the per-call cwd filter changes.

### 4.7 `src/preload/index.ts` + `src/shared/ipc-types.ts`
- Add `window.omp.session.openInNewWindow(payload: { sessionPath?: string; cwd?: string }): Promise<boolean>` → new `IPC_COMMANDS.SESSION_OPEN_NEW_WINDOW` returning `false` at cap.
- No other API change — routing is implicit via `event.sender`, so `rpc.*` / `sidecar.*` signatures are unchanged (huge renderer win).

### 4.8 Renderer (minimal)
- `Sidebar.tsx`: add an "open in new window" affordance on session rows + workspace groups (icon button beside delete/rename), calling `openInNewWindow`. Default click/`+` behavior unchanged (replace-in-window).
- `App.tsx` MENU_ACTION "new-window" handler → `openInNewWindow({})` (or keep calling the new spawn path).
- `use-tray-sync.ts`: only push tray state when its window is focused (avoid N windows fighting the tray).
- No store changes. No `use-rpc-events` changes (it already self-hydrates per window).

### 4.9 Shared types
- `IpcSidecarStatusPayload` already carries `cwd` — sufficient; renderer keys off it.
- Add `IpcSessionOpenNewWindowPayload` type.

---

## 5. Correctness concerns (the "考虑周全" part)

### 5.1 Construction race
A window exists before its sidecar is acquired/bound. Guard: `recordFor` may return a record with `sidecar: null`; `sidecarFor` returns null → handlers return the standard "not connected" error. The window's renderer shows its normal "starting" state until the sidecar is bound and reaches `ready`. Order at spawn: `acquire → createWindow → bindSidecar → start`, and events only forward after bind.

### 5.2 Window close ordering
`closed` fires after the window is gone. Release the sidecar in `close` (before destroy) via the record, not after — ensures the pool frees the slot and the cap count stays accurate even if the renderer hangs.

### 5.3 Two windows, same cwd
Allowed (user may want two sessions in one project). The pool keys sidecars **by window, not by cwd** — cwd is not a uniqueness constraint. Only the *count* is capped.

### 5.4 Per-window "local" session scope
`SessionIndex.list("local")` must use the calling window's cwd (§4.6), otherwise a window on project A sees project B's "local" sessions. This is the one place the singleton assumption leaks into *data*.

### 5.5 Notifications, tray, dock badge
These are app-global OS surfaces. With N active agents they can only reflect one source. Policy: reflect the **focused** window's agent; ignore pushes from unfocused windows (tray state, progress). Desktop notifications stay per-window-event but dedupe by (windowId + title + body) so the *same* window's multi-renderer dupes collapse while distinct windows' notifications both show.

### 5.6 Logs
All sidecars write the same `~/.omp/logs` dir. `LogWatcher` interleaves them; each window's Logs panel shows the merged stream (acceptable; true per-window log filtering needs sidecar-pid tagging in the agent, out of scope).

### 5.7 Memory ceiling
Each sidecar ≈ one omp process (~120MB binary + runtime heap). Cap 10 → bounded. The cap refusal is the only memory guard needed; no auto-eviction (per decision).

### 5.8 Same session in two windows
Two sidecars appending to the *same* session file concurrently is the one genuinely unsafe overlap. **Decision: accept it, do not police it (non-goal).** Rationale: tracking `sessionPath → windowId` requires the pool to observe every successful `switch_session` (a new mutable index that can desync from the agent's real state), while the actual blast radius is limited — the agent appends JSONL through its own session writer, the OS serializes the writes, and the visible symptom is two windows showing divergent transcripts rather than a corrupt file. Users who do it get confusing history, not data loss. If field reports show real corruption, revisit by adding `currentSessionPath` to `WindowRecord` (updated on `switch_session` success) and focus-redirecting instead of spawning.

### 5.9 stats-server single instance
One stats dashboard serves all windows (it reads the global session dir, not a sidecar). Unchanged — already correct for multi-sidecar.

---

## 6. Implementation phases (with verification gates)

**Phase 0 — test harness for parallelism** *(prereq)*
A scripted way to spawn 2 windows + 2 sidecars and assert isolation (reusing the `verify-fixes.mjs` pattern but driving 2 real Electron windows via CDP). Without this, later phases are unverifiable.
*Gate*: harness launches 2 windows, each reports a distinct sidecar cwd.

**Phase 1 — SidecarPool + WindowManager binding (main, no behavior change yet)**
§4.1, §4.2, §4.4. Single window still works exactly as today (pool of 1).
*Gate*: `tsc`, `bun run build`, app boots, single window chat works, `verify-fixes` passes.

**Phase 2 — IPC routing (event.sender → window → sidecar)**
§3.3, §4.3 handlers; keep broadcast for now (still correct at 1 window).
*Gate*: single window: all sidebar/fs/rpc/project-switch flows unchanged.

**Phase 3 — Per-sidecar event forwarding**
§3.4. Replace sidecar broadcast with targeted send. Global channels stay broadcast.
*Gate*: 2 windows on 2 cwds — each shows its own transcript/status; no cross-talk (Phase-0 harness asserts).

**Phase 4 — "Open in new window" + cap**
§3.5, §4.5, §4.7, §4.8. Session-row/group affordance, pool cap=10 with toast, session-collision focus-redirect (§5.8).
*Gate*: open 2 parallel sessions, both stream independently; 11th open → toast, no spawn; reopening an open session focuses it.

**Phase 5 — Per-window project switch + session scope**
§4.3 (SELECT/SET_PROJECT per-window), §4.6 (local scope per window).
*Gate*: window A switches project, window B unaffected; each sidebar's "local" list is correct.

**Phase 6 — Tray/notify/dock focus policy + logs note**
§4.5, §5.5.
*Gate*: tray shows focused window's agent; notifications from two windows both arrive (dedupe keyed by window).

**Phase 7 — Docs, changelog, cleanup**
CHANGELOG entry, plan cross-link from `plan/README.md`, remove the now-dead `sessionIndex.setCwd` global path.
*Gate*: full `check:types` + `build` + manual 3-window parallel smoke.

---

## 7. Risks & explicit non-goals

| Risk | Mitigation |
|---|---|
| IPC mis-routing (a window talks to the wrong sidecar) | All routing derives from `event.sender` (unforgeable), never from a client-supplied window id. Phase-0 harness asserts isolation. |
| Cap bypass via menu/deep-link create paths | All window creation funnels through `spawnWindow`, the single cap-enforcement point. |
| Tray/dock can't represent N agents | Accepted limitation (§5.5): focused-window-wins, documented. |
| Session file corruption by concurrent editors | §5.8 focus-redirect prevents the same session in two windows. |
| Windows restore overwrites (single `window-state`) | Accepted: last-closed window's geometry wins; per-window geometry is a follow-up. |
| Per-window log filtering | Non-goal: merged log stream; needs agent-side pid tagging (out of scope). |
| True per-window *paused* agents at cap | Non-goal: cap refuses, never auto-sleeps (sidecar has no sleep concept). |
| `restart()` racing window close (orphan process) | `SidecarManager.restart()` is `void`, not awaitable (`sidecar.ts:153`), so the pool cannot join an in-flight respawn before disposing. Extreme timing (restart, then close the window mid-spawn) can leak an orphan sidecar. **Pre-existing** in the single-window build; accepted here rather than widening the change to `sidecar.ts`. Mitigation if it surfaces: make `restart()` async and have `release()` await the pending respawn before `dispose()`. |

**Explicit non-goals**: single-window tabbed sessions (rejected — would require rewriting all 14 global stores per-session); >10 parallel; cross-window session drag-and-drop; per-window stats dashboards.

---

## 8. Estimated touch surface

- **New files**: `sidecar-pool.ts` (+1).
- **Heavy edits**: `window.ts`, `ipc.ts`, `index.ts` (+3).
- **Medium edits**: `session-index.ts`, `tray.ts`, `menu.ts`, `deep-link.ts`, `preload/index.ts`, `shared/ipc-types.ts`, `Sidebar.tsx`, `App.tsx`, `use-tray-sync.ts` (+9).
- **Unchanged**: `sidecar.ts`, `rpc-client.ts`, `event-batcher.ts`, `rpc-bridge.ts`, `stats-*`, `log-watcher.ts`, all 14 renderer stores, `use-rpc-events.ts`, all tool/markdown renderers.

No changes to `packages/coding-agent` — the agent already supports everything needed (`switch_session`/`new_session` with abort, per-session RPC). The GUI is purely additive, honoring the repo's hard constraint.
