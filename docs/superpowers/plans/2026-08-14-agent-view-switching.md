# Agent View Switching Implementation Plan

> **Execution note:** Use `superpowers:executing-plans` for inline execution or `superpowers:subagent-driven-development` for delegated execution. Do not commit unless the user explicitly asks.

**Goal:** Let each GUI session tab switch the main transcript canvas between Main and any current subagent, with live read-only subagent rendering, one shared transcript presentation, and no embedded transcript previews in roster/graph/Hub surfaces.

**Architecture:** Keep the existing attached sidecar and latest-omp RPC contract. Add a per-tab `AgentViewTarget` (`Main` or subagent ID), an isolated subagent transcript projection fed by `get_subagent_messages` plus matching `subagent_event` frames, and a shared transcript viewport extracted from `ChatStream`. Main stores remain authoritative and untouched while a subagent is viewed. The composer becomes explicitly read-only for subagents; list, graph, and Hub actions only change the view target.

**Tech stack:** React 19, Zustand 5, TypeScript 7, Vitest/linkedom, Tailwind 4, Electron preload RPC bridge.

## Constraints and invariants

- Change only files under `packages/gui/`.
- Do not add or modify sidecar RPC commands. Use `get_subagent_messages`, `get_subagents`, `set_subagent_subscription("events")`, `abort_subagent`, and `revive_subagent` as already exposed by preload.
- Main `messages`, `tools`, `session`, `queue`, `todo`, model, extension UI, and composer stores remain the only mutable Main-session state.
- A subagent projection owns independent message identity, streaming buffers, and tool-call occurrence tracking. It must not bind tool keys into Main's module-global projection state.
- `subagent_event` frames affect the displayed projection only when `frame.payload.id` equals the active subagent target and the current load generation is still valid.
- Target selection is remembered per GUI session tab. Transcript bytes are not duplicated into tab bundles; returning to a tab restores its target and rehydrates that target after routing.
- Main remains the only editable target. No input can silently route to Main while a subagent is displayed.
- Main-only rows stay Main-only: queue, todo history/live state, compaction controls, branch/fork actions, session retry/status, model controls, and extension UI.
- Every new visible string exists in both `src/renderer/locales/en.ts` and `src/renderer/locales/zh.ts`.

---

### Task 1: Make message accumulation projection-local

**Files:**
- Modify: `src/renderer/stores/messages.ts`
- Modify: `src/renderer/stores/messages.test.ts`

**Step 1: Write failing projection-isolation tests**

Add tests that create two independent message projections, feed interleaved `message_start` / `message_update` / `message_end` event sequences, and assert:

- each projection receives only its own text/thinking deltas;
- delivery-key deduplication in one projection does not suppress the same provider identity in the other;
- finalized `message_end` replaces only that projection's streaming shell;
- resetting one projection does not reset the other.

Use real `AgentSessionEvent` fixtures; do not mock Zustand or source-grep.

**Step 2: Run the test and confirm RED**

Run:

```bash
bunx vitest run src/renderer/stores/messages.test.ts
```

Expected: failures because the accumulator/delivery-key tracking is currently module-global and no projection API exists.

**Step 3: Extract a named message projection API**

In `messages.ts`, introduce named types and pure operations similar to:

```ts
export interface MessageProjection {
	messages: AgentMessage[];
	streamingMessage: AgentMessage | null;
	streamingText: string;
	streamingThinking: string;
	deliveredKeys: Set<string>;
}

export function createMessageProjection(): MessageProjection;
export function hydrateMessageProjection(projection: MessageProjection, messages: AgentMessage[]): MessageProjection;
export function applyMessageProjectionEvents(
	projection: MessageProjection,
	events: AgentSessionEvent[],
): MessageProjection;
```

Move `deliveredKeys`, message identity reconciliation, and streaming-buffer mutation behind the passed projection. Keep the existing `useMessagesStore` public surface, but make it own one projection and delegate `hydrateMessages`, `applyEvents`, and `reset` to the shared operations.

Do not use `ReturnType<>`, `any`, inline imports, or a second message-normalization algorithm.

**Step 4: Run the focused test and confirm GREEN**

Run the command from Step 2. Expected: all existing message-store tests plus the isolation regression pass.

---

### Task 2: Make tool projection and repeated IDs projection-local

**Files:**
- Modify: `src/renderer/stores/tools.ts`
- Create: `src/renderer/stores/tools.test.ts`
- Modify: `src/renderer/components/tools/ToolCard.test.tsx` if its fixtures depend on the old resolver shape

**Step 1: Write failing tests for isolated tool projections**

Cover the observable failure modes:

1. Two projections may both receive provider tool-call ID `read:0`; the second call in either transcript gets an occurrence-specific key without overwriting the other projection.
2. `toolcall_delta` → `message_end` → `tool_execution_start` → `tool_execution_update` → `tool_execution_end` updates the correct local entry.
3. Hydrating or resetting a subagent projection does not alter Main's `activeTools` or Main's `toolEntryKey` bindings.
4. A resolver returns both the stable local key and local `ToolEntry` for a concrete `ToolCallContent` object.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/stores/tools.test.ts src/renderer/components/tools/ToolCard.test.tsx
```

Expected: no projection-local tracker/resolver exists yet.

**Step 3: Replace module-global tracking with an owned tracker**

Introduce named structures such as:

```ts
export interface ToolProjection {
	activeTools: Map<string, ToolEntry>;
	callEntryKeys: WeakMap<object, string>;
	nextOccurrenceByCallId: Map<string, number>;
	latestEntryKeyByCallId: Map<string, string>;
	streamEntryKeysByIndex: Map<number, string>;
	queuedExecutionKeysByCallId: Map<string, string[]>;
	runningEntryKeyByCallId: Map<string, string>;
}

export interface ResolvedToolCall {
	key: string;
	entry: ToolEntry | undefined;
}
```

Add `createToolProjection`, `hydrateToolProjection`, `applyToolProjectionEvents`, and `resolveProjectionToolCall`. Make the Main Zustand store own one tracker and keep `toolEntryKey` as the Main resolver for existing consumers. Preserve copy-on-first-write behavior for event batches without tool events.

Update the newly added transcript-local `MessageBubble`/`ToolCard` integration from the earlier transcript-parity work to consume a `ResolvedToolCall` rather than querying Main implicitly when a projection resolver is supplied.

**Step 4: Run and confirm GREEN**

Run Step 2's command. Expected: repeated-ID and isolation tests pass without regressing Main tool cards.

---

### Task 3: Add the per-tab agent-view store and loading contract

**Files:**
- Create: `src/renderer/stores/agent-view.ts`
- Create: `src/renderer/stores/agent-view.test.ts`
- Modify: `src/renderer/stores/tabs.ts`
- Modify: `src/renderer/stores/tabs.test.tsx`

**Step 1: Write failing store tests**

Define the desired public contract in tests:

```ts
export type AgentViewTarget = { kind: "main" } | { kind: "subagent"; id: string };
```

Test:

- initial target is Main;
- selecting a subagent increments a generation, enters `loading`, and calls `getSubagentMessages(id, sessionFile, 0)` using the current roster snapshot;
- all pages are appended by `nextByte` until `hasMore` is false, without duplicate deliveries;
- a later target selection makes earlier page responses stale and unable to repaint the new target;
- a load error leaves the selected subagent visible with `error` and supports Retry;
- selecting Main cancels local work and immediately restores Main;
- `subagent_event` for the selected ID applies live message/tool events; another ID is ignored;
- when the selected ID disappears from a successfully refreshed authoritative roster, target falls back to Main;
- each tab bundle captures/restores only `AgentViewTarget`, not transcript bytes.

Use injected RPC functions or a narrow exported loader dependency; do not mutate `window.omp` globally across files when a local seam works.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/stores/agent-view.test.ts src/renderer/stores/tabs.test.tsx
```

Expected: store and bundle field do not exist.

**Step 3: Implement the store**

The store should own:

```ts
interface AgentViewStore {
	target: AgentViewTarget;
	loadState: "idle" | "loading" | "ready" | "error";
	error: string | null;
	messages: MessageProjection;
	tools: ToolProjection;
	generation: number;
	selectMain: () => void;
	selectSubagent: (snapshot: SubagentSnapshot) => Promise<void>;
	reloadSelected: () => Promise<void>;
	applyFrame: (frame: SubagentFrame) => void;
	restoreTarget: (target: AgentViewTarget) => void;
	reset: () => void;
}
```

Keep the active snapshot/session-file locator outside persisted target identity; IDs are session-scoped. `reloadSelected` resolves the current snapshot from `useSubagentsStore` each time.

`applyFrame` must dispatch the single `frame.payload.event` through both projection reducers only for a matching `subagent_event` frame.

**Step 4: Persist target identity in tab bundles**

Add `agentViewTarget` to `SessionTabBundle`, `captureBundle`, and `restoreBundle`. On restore, clear projection data and restore target identity for instant chrome paint. After `routeActiveTab` and `hydrateSession` complete, call `reloadSelected` if the restored target is a subagent. Apply the same post-hydration reload on the reconciliation recovery path.

On tab/session replacement and full reset, fall back to Main and invalidate the old generation.

**Step 5: Run and confirm GREEN**

Run Step 2's command.

---

### Task 4: Make row construction accept an explicit tool resolver

**Files:**
- Modify: `src/renderer/lib/read-group.ts`
- Modify: `src/renderer/lib/read-group.test.ts`
- Modify: `src/renderer/components/chat/chat-stream-utils.ts`
- Modify: `src/renderer/components/chat/ChatStream.test.tsx`
- Modify: `src/renderer/components/chat/MessageBubble.tsx`
- Modify: `src/renderer/components/chat/MessageBubble.test.tsx`
- Modify: `src/renderer/components/chat/ReadGroupCard.tsx`

**Step 1: Add failing resolver tests**

Prove that when two tool calls have the same raw ID:

- `groupReadRows` uses caller-supplied occurrence keys in `ReadGroupEntry.toolKey`;
- `buildHistoryRows` and `buildTimelineMarkers` preserve those keys;
- `MessageBubble` passes the explicit key and entry to `ToolCard`;
- `ReadGroupCard` resolves entries from the supplied projection rather than `useToolsStore`.

Keep default Main behavior tests unchanged.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/lib/read-group.test.ts src/renderer/components/chat/ChatStream.test.tsx src/renderer/components/chat/MessageBubble.test.tsx
```

**Step 3: Thread one resolver through the shared presentation**

Use a named function type, for example:

```ts
export type ResolveToolCall = (call: ToolCallContent) => ResolvedToolCall;
```

- `groupReadRows(rows, resolveToolCall)` derives local keys from it.
- `buildHistoryRows`, `buildTimelineMarkers`, and any process summary accept the resolver with the Main resolver as the default.
- `MessageBubble`, `ProcessGroup`, streaming rows, and `ReadGroupCard` receive the same resolver/entry map.
- `ToolCard` keeps its explicit `entry` override and does not query Main when one is provided.

Do not create separate subagent row-building or read-group code.

**Step 4: Run and confirm GREEN**

Run Step 2's command.

---

### Task 5: Extract one transcript viewport without changing Main behavior

**Files:**
- Create: `src/renderer/components/chat/TranscriptViewport.tsx`
- Create: `src/renderer/components/chat/TranscriptViewport.test.tsx`
- Modify: `src/renderer/components/chat/ChatStream.tsx`
- Modify: `src/renderer/components/chat/ChatStream.test.tsx`

**Step 1: Add a characterization test before moving code**

Mount Main `ChatStream` with representative finalized and streaming content. Assert observable behavior that the extraction could break:

- user/assistant Markdown bubbles render;
- full/compact process grouping follows `transcriptDetail`;
- live thinking/text and running tool card render;
- jump-to-latest and conversation navigation remain attached to the scroll container;
- Main queue/todo/status rows still render only for Main.

**Step 2: Run and confirm the characterization is GREEN before refactor**

```bash
bunx vitest run src/renderer/components/chat/ChatStream.test.tsx src/renderer/components/chat/TranscriptViewport.test.tsx
```

The new file's direct test may initially fail because the component does not exist; the existing `ChatStream` characterization must pass.

**Step 3: Extract the shared viewport**

Move the transcript presentation/virtualization code from `ChatStream.tsx` into `TranscriptViewport.tsx`: history-row construction, row keys, virtualization, scroll anchoring, conversation anchors, timeline markers, process groups, streaming rows, read grouping, jump-to-latest, and message rendering.

Use a discriminated prop union so Main-only capabilities are explicit rather than a broad bag of unrelated optionals:

```ts
type TranscriptViewportProps =
	| { mode: "main"; projection: TranscriptProjectionView; main: MainTranscriptAugments }
	| { mode: "subagent"; projection: TranscriptProjectionView };
```

`TranscriptProjectionView` contains the messages, streaming buffers, tool map, and resolver. `MainTranscriptAugments` contains queue, todo, retry/compaction/status, compaction boundaries, and other Main-only row inputs already used by `ChatStream`.

Keep `ChatStream` as a thin Main-store adapter. Do not change CSS class names or rendering semantics during extraction.

**Step 4: Run and confirm GREEN**

Run Step 2's command. Main behavior must be byte/DOM-equivalent for the covered contracts.

---

### Task 6: Render the selected subagent in the main canvas

**Files:**
- Modify: `src/renderer/components/panels/SubagentTranscript.tsx`
- Modify: `src/renderer/components/panels/SubagentTranscript.test.tsx` (currently untracked; preserve and evolve this regression coverage)
- Modify: `src/renderer/components/chat/ChatStream.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/styles/global.css` only if an existing viewport class cannot express the loading/error state

**Step 1: Extend the failing transcript parity test**

Adapt the existing subagent transcript regression so it exercises the main-canvas path, not a drawer. It must assert:

- Markdown syntax highlighting, reasoning blocks, images, usage, and completed tool output match Main presentation;
- a live `subagent_event` text/thinking/tool sequence updates without refetching;
- Main message/tool stores remain unchanged;
- queue, todo, retry, compaction, branch/fork, and extension controls do not appear in subagent mode;
- load failure renders inline Retry while retaining the selected identity.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/components/panels/SubagentTranscript.test.tsx
```

Expected: no main-canvas selection path/live projection exists.

**Step 3: Implement the selected-target canvas adapter**

Repurpose `SubagentTranscript` as a full-canvas adapter around `TranscriptViewport`, or rename it through LSP if a clearer name is chosen. It reads `useAgentViewStore`, supplies the isolated projection and resolver, and renders bounded loading/empty/error states.

At the `ChatStream`/App composition point, render Main `ChatStream` for `{kind:"main"}` and the subagent canvas for `{kind:"subagent"}`. Keep both under the same parent sizing/layout contract so switching does not move the composer or dock.

**Step 4: Run and confirm GREEN**

Run Step 2's command plus:

```bash
bunx vitest run src/renderer/components/chat/ChatStream.test.tsx
```

---

### Task 7: Add the persistent active-agent context bar

**Files:**
- Create: `src/renderer/components/chat/AgentViewContextBar.tsx`
- Create: `src/renderer/components/chat/AgentViewContextBar.test.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`

**Step 1: Write failing chrome tests**

Assert:

- Main mode shows compact Main identity and current session status;
- subagent mode shows display label, agent type, lifecycle status, and live indicator;
- the bar remains above the transcript regardless of dock collapse;
- no model/context controls are duplicated;
- status updates from roster frames repaint the bar.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/components/chat/AgentViewContextBar.test.tsx
```

**Step 3: Implement with existing status helpers**

Reuse the existing subagent label/status ordering helpers by moving them to a small adjacent shared module if necessary; do not fork status normalization. Add identical locale keys in English and Chinese.

Mount the bar immediately above the transcript canvas, not inside the Agents dock.

**Step 4: Run and confirm GREEN**

Run Step 2's command and the locale parity test:

```bash
bunx vitest run src/renderer/locales/locales.test.ts
```

Use the actual existing locale-test path if LSP shows a different location.

---

### Task 8: Make the composer explicitly read-only for subagents

**Files:**
- Modify: `src/renderer/components/layout/InputArea.tsx`
- Modify: `src/renderer/components/layout/InputArea.queue-shorthand.test.tsx`
- Create or modify: `src/renderer/components/layout/InputArea.agent-view.test.tsx`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`

**Step 1: Write failing interaction tests**

For a selected subagent, assert:

- textarea/editor is disabled or replaced by a non-editable state;
- send, attach, voice, mode, model, approval, and queue actions cannot fire;
- visible text names the viewed agent and says Main must be selected to send;
- a provided action returns directly to Main;
- unsent Main draft/images survive Main → subagent → Main.

For Main, retain all existing queue shorthand and submission behavior.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/components/layout/InputArea.agent-view.test.tsx src/renderer/components/layout/InputArea.queue-shorthand.test.tsx
```

**Step 3: Implement a hard target gate**

Read `useAgentViewStore` at the top-level composer boundary. Render the existing composer unchanged for Main. For subagents, render a dedicated read-only panel with no hidden submit handler and a localized “Select Main” action. Do not merely disable one button while leaving keyboard or paste submission paths active.

**Step 4: Run and confirm GREEN**

Run Step 2's command.

---

### Task 9: Turn the Agents dock into navigation

**Files:**
- Modify: `src/renderer/components/chat/dock/AgentsDockCard.tsx`
- Modify: `src/renderer/components/chat/dock/AgentsDockCard.test.tsx`
- Modify: `src/renderer/components/chat/dock/WorkspaceDockFocus.tsx` only if focus ownership currently conflates focus with the viewed target

**Step 1: Write failing row-activation tests**

Cover:

- Main appears as the first/root row;
- single-click changes only list focus/selection;
- double-click activates Main or a subagent target;
- Enter activates the selected row;
- the currently viewed target has a persistent `Viewing` marker/accent independent of ordinary focus;
- activating a row closes dock focus mode but does not collapse the Agents card;
- polling and roster summarization remain unchanged.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/components/chat/dock/AgentsDockCard.test.tsx
```

**Step 3: Implement one activation callback**

Represent Main and subagents as one local row union. Route double-click and Enter through a shared `activateAgentView(row)` function. Use the store's `selectMain`/`selectSubagent`; do not fetch messages inside the component.

Remove embedded `SubagentTranscript` rendering from the dock. The dock remains visible above the composer and keeps lifecycle actions/statuses.

**Step 4: Run and confirm GREEN**

Run Step 2's command.

---

### Task 10: Keep the graph, remove its transcript inspector

**Files:**
- Modify: `src/renderer/components/panels/SubagentDag.tsx`
- Modify: `src/renderer/components/panels/SubagentDag.test.tsx` (create if no behavioral test exists)
- Modify: `src/renderer/components/chat/dock/AgentsDockCard.tsx` if graph activation is wired there

**Step 1: Write failing graph navigation tests**

Assert:

- graph nodes retain hierarchy, status, timing, progress, and lifecycle actions;
- single-click selects only;
- double-click and Enter activate the same agent-view store target as list rows;
- the current view target is visually marked;
- no lower transcript inspector is mounted.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/components/panels/SubagentDag.test.tsx src/renderer/components/chat/dock/AgentsDockCard.test.tsx
```

**Step 3: Implement shared activation semantics**

Pass the same `onActivate`/viewed-ID contract used by the list into `SubagentDag`. Remove `SubagentTranscript` from the graph panel and let the graph use the full available panel height.

**Step 4: Run and confirm GREEN**

Run Step 2's command.

---

### Task 11: Convert Agent Hub transcript actions into main-view navigation

**Files:**
- Modify: `src/renderer/components/panels/AgentHubWindow.tsx`
- Modify: `src/renderer/components/panels/AgentHubWindow.test.tsx`

**Step 1: Replace the drawer test with failing navigation tests**

Change the current “View messages opens a transcript slide-over” contract to:

- Hub no longer mounts `AgentTranscriptDrawer` or fetches transcript pages itself;
- the row action activates the chosen agent in `useAgentViewStore` and closes the Hub;
- double-click/Enter on Hub rows use the same activation path;
- abort/revive remain available and keep their current confirmation/direct-call behavior;
- activating a row is independent from abort/revive button clicks.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/components/panels/AgentHubWindow.test.tsx
```

**Step 3: Remove the secondary renderer**

Delete `AgentTranscriptDrawer` and its byte-pagination state from `AgentHubWindow.tsx`. Keep definition/prewalk/Hub tabs and lifecycle controls. Call the agent-view store, close the modal, and let the main canvas own loading/error state.

**Step 4: Run and confirm GREEN**

Run Step 2's command.

---

### Task 12: Wire live events, reconnect hydration, and missing-agent fallback

**Files:**
- Modify: `src/renderer/hooks/use-rpc-events.ts`
- Modify: `src/renderer/hooks/use-rpc-events.test.tsx`
- Modify: `src/renderer/stores/subagents.ts`
- Modify: `src/renderer/stores/subagents.test.ts` if present
- Modify: `src/renderer/stores/tabs.ts`
- Modify: `src/renderer/stores/tabs.test.tsx`
- Modify: `src/renderer/stores/agent-view.ts`
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/ipc-types.ts`

**Step 1: Write failing integration tests**

Prove:

1. `onSubagentFrame` still updates the roster and also forwards matching `subagent_event` frames to the isolated projection.
2. Main message/tool stores never receive those frames.
3. A tab switch during an in-flight subagent page load rejects the stale generation.
4. A ready/reconnect cycle reasserts the existing `events` subscription, hydrates Main normally, then reloads the selected subagent target.
5. If authoritative `get_subagents` omits the selected ID and the persisted Main transcript does not identify it, target falls back to Main.
6. A failed transcript reload leaves the target selected with inline Retry rather than silently switching.
7. Completed agents omitted by the live registry are reconstructed from persisted `task` tool-call names, remain listed after tab/history hydration, and load from their persisted child session after a sidecar restart.

**Step 2: Run and confirm RED**

```bash
bunx vitest run src/renderer/hooks/use-rpc-events.test.tsx src/renderer/stores/tabs.test.tsx
```

**Step 3: Wire the event/recovery sequence**

In the existing `onSubagentFrame` callback:

```ts
useSubagentsStore.getState().applyFrame(frame);
useAgentViewStore.getState().applyFrame(frame);
```

Do not add another preload subscription. In the ready handler, retain `setSubagentSubscription("events")`, roster refresh, and Main `hydrateSession`; trigger `reloadSelected` only after the active tab route is stable and the roster has refreshed.

Have authoritative roster replacement notify the view store only after a successful fetch. Lifecycle completion/failure does not remove a row and must not force fallback; only actual roster absence does.

Merge the successful live roster with deterministic historical rows extracted from persisted Main `task` tool calls before authoritative replacement. Live snapshots win on matching IDs. Historical rows use the task's stable `name` as the lookup ID, retain its agent/task metadata, and derive the standard sibling child-session path from the active parent session. Try the existing `get_subagent_messages` RPC first; if a restarted sidecar no longer recognizes the released agent, read that exact child file through a guarded GUI-internal local/SSH transport and feed its persisted messages into the same projection. Do not invent a sidecar RPC or scan the session tree in the renderer.

**Step 4: Run and confirm GREEN**

Run Step 2's command.

---

### Task 13: Remove obsolete secondary transcript code and document the product change

**Files:**
- Modify or remove after LSP reference check: `src/renderer/components/panels/SubagentTranscript.tsx` only if its implementation was renamed/replaced in Task 6
- Modify: `src/renderer/components/panels/SubagentDag.tsx`
- Modify: `src/renderer/components/panels/AgentHubWindow.tsx`
- Modify: `src/renderer/components/chat/dock/AgentsDockCard.tsx`
- Modify: `CHANGELOG.md`

**Step 1: Use LSP references before removal**

Run references for `SubagentTranscript` and `AgentTranscriptDrawer`. Confirm all old dock/graph/Hub callsites migrated. Remove obsolete pagination effects, state, imports, CSS selectors, and tests only when their behavior has been replaced by the main-canvas tests.

Preserve the existing untracked `SubagentTranscript.test.tsx` by migrating its regression assertions; do not discard it.

**Step 2: Add the Unreleased changelog entry**

Under `## [Unreleased]` → `### Changed`, add one concrete entry: agent rows and graph/Hub actions now switch the main transcript canvas to a live read-only subagent view, with Main as the send target.

Do not edit released sections.

**Step 3: Run focused affected tests**

```bash
bunx vitest run \
  src/renderer/stores/agent-view.test.ts \
  src/renderer/stores/messages.test.ts \
  src/renderer/stores/tools.test.ts \
  src/renderer/stores/tabs.test.tsx \
  src/renderer/hooks/use-rpc-events.test.tsx \
  src/renderer/components/chat/ChatStream.test.tsx \
  src/renderer/components/chat/TranscriptViewport.test.tsx \
  src/renderer/components/panels/SubagentTranscript.test.tsx \
  src/renderer/components/chat/AgentViewContextBar.test.tsx \
  src/renderer/components/layout/InputArea.agent-view.test.tsx \
  src/renderer/components/chat/dock/AgentsDockCard.test.tsx \
  src/renderer/components/panels/SubagentDag.test.tsx \
  src/renderer/components/panels/AgentHubWindow.test.tsx
```

Expected: all pass.

---

### Task 14: Run full verification and live GUI smoke

**Files:**
- No planned source changes; fix only failures caused by this feature.

**Step 1: Run full automated verification**

```bash
bunx vitest run
bun run check:types
bunx biome check \
  src/renderer/stores/agent-view.ts \
  src/renderer/stores/messages.ts \
  src/renderer/stores/tools.ts \
  src/renderer/stores/tabs.ts \
  src/renderer/hooks/use-rpc-events.ts \
  src/renderer/components/chat/TranscriptViewport.tsx \
  src/renderer/components/chat/ChatStream.tsx \
  src/renderer/components/chat/MessageBubble.tsx \
  src/renderer/components/chat/AgentViewContextBar.tsx \
  src/renderer/components/layout/InputArea.tsx \
  src/renderer/components/chat/dock/AgentsDockCard.tsx \
  src/renderer/components/panels/SubagentDag.tsx \
  src/renderer/components/panels/AgentHubWindow.tsx \
  src/renderer/locales/en.ts \
  src/renderer/locales/zh.ts
bun run build
```

Expected: full suite green, typecheck green, touched files clean, production renderer/main/preload build succeeds.

**Step 2: Smoke-test the actual Electron surface with the browser device**

Launch the built/dev Electron app with a remote debugging port through `hub`, then attach with `browser`. Exercise the actual feature:

1. Start a real local Main prompt that spawns a subagent through the task tool.
2. In Agents dock, single-click a row and verify only selection changes.
3. Double-click the row; verify context bar identity, same main-canvas layout, live Markdown/reasoning/tool updates, and read-only composer.
4. Return to Main through the Main row and verify the prior Main transcript and draft are intact and sending works.
5. Repeat activation from graph and Agent Hub; confirm no embedded drawer/inspector remains.
6. Switch to another GUI session tab and back; verify target restoration and rehydration.
7. If an SSH tab with latest omp is available, repeat Main → subagent → Main there and confirm the same RPC/UI path.
8. Capture screenshots of Main and subagent modes for visual comparison.

**Step 3: Report exact evidence**

Report command results, test counts, build result, and which live scenarios were actually exercised. If SSH is unavailable, state that explicitly rather than implying it was verified.
