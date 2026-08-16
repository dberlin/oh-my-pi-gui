# Adaptive Tool Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default GUI transcript show expandable, tool-specific Adaptive Hybrid presentations for direct and `xd://`-dispatched built-ins, MCP calls, and dynamic tools.

**Architecture:** Normalize every occurrence into one effective invocation before summary, shell, or renderer selection. Route Main and subagent transcripts through the shared `TranscriptViewport`, keep reasoning collapsible without swallowing tool calls, and extend the runtime renderer registry with adaptive shell metadata. Existing Grep, LSP, and Bash bodies remain; MCP and dynamic structured output gain dedicated presentation.

**Tech Stack:** React 19, TypeScript 7, Zustand, Tailwind/CSS custom properties, Vitest + linkedom, Vite/Electron, bundled omp RPC sidecar.

**Spec:** `docs/superpowers/specs/2026-08-15-adaptive-tool-rendering-design.md`

## Global Constraints

- All product changes stay inside `packages/gui`; do not modify the enclosing monorepo or bundled sidecar source.
- Do not add a custom RPC command or a second tool-result store.
- Existing Grep, LSP, and Bash renderer bodies remain the baseline; change only what the shared disclosure/preview contract requires.
- Every user-visible string must use `useT()` and exist in both `src/renderer/locales/en.ts` and `src/renderer/locales/zh.ts`.
- Model/MCP text must use the existing sanitized `MarkdownRenderer`; never use raw `dangerouslySetInnerHTML` for untrusted output.
- No `any`, `ReturnType<>`, inline imports, or `mock.module()`.
- Do not commit unless the user explicitly requests it. Each task ends at a review checkpoint with focused verification.

---

## File Structure

### New files

- `src/renderer/components/tools/tool-presentation.ts` — pure direct/`xd://` normalization, effective identity, summary inputs, and MCP recognition.
- `src/renderer/components/tools/tool-presentation.test.ts` — normalization and fallback contracts.
- `src/renderer/components/tools/ToolCard.test.tsx` — adaptive shell, disclosure, live update, fallback, and expand-all contracts.
- `src/renderer/components/tools/StructuredDataView.tsx` — bounded accessible JSON/object tree shared by MCP and Generic renderers.
- `src/renderer/components/tools/StructuredDataView.test.tsx` — scalar, object, array, depth, and disclosure behavior.
- `src/renderer/components/tools/McpRenderer.tsx` — MCP identity, args, JSON/Markdown/image/error/truncation presentation.
- `src/renderer/components/tools/McpRenderer.test.tsx` — MCP observable contracts.
- `src/renderer/components/tools/ThinkRenderer.tsx` — missing TUI registry parity for explicit `think` tool calls.

### Existing files with focused changes

- `src/renderer/components/tools/index.tsx` — renderer descriptors (`component`, adaptive `shell`) and shape-aware MCP fallback.
- `src/renderer/components/tools/ToolCard.tsx` — invoke normalization, own summary/identity, choose shell, preserve disclosure state, and catch renderer failures locally.
- `src/renderer/components/chat/MessageBubble.tsx` — stop computing summaries from the outer transport name; pass original call data only.
- `src/renderer/components/tools/GrepRenderer.tsx` — bounded collapsed preview and full expanded match list.
- `src/renderer/components/tools/LspRenderer.tsx` — bounded collapsed preview and full expanded typed result.
- `src/renderer/components/tools/GlobRenderer.tsx` — bounded collapsed preview.
- `src/renderer/components/tools/AstGrepRenderer.tsx` — bounded collapsed preview.
- `src/renderer/components/tools/WebSearchRenderer.tsx` — bounded collapsed preview.
- `src/renderer/components/tools/GenericRenderer.tsx` — structured JSON/image/truncation treatment for dynamic tools.
- `src/renderer/components/chat/ChatStream.tsx` — thin Main-store adapter over shared `TranscriptViewport`; remove duplicated viewport implementation.
- `src/renderer/components/chat/TranscriptViewport.tsx` — shared live/final Adaptive Hybrid row composition.
- `src/renderer/components/chat/chat-stream-utils.ts` — compact mode groups reasoning only; tool-containing messages stay visible.
- `src/renderer/components/chat/ExecutionGroup.tsx` — reasoning-only disclosure semantics; no tool/error aggregation.
- `src/renderer/components/chat/ExecutionGroup.test.tsx` — reasoning disclosure contract.
- `src/renderer/components/chat/ChatStream.test.tsx` — Main adapter and compact-history behavior.
- `src/renderer/components/chat/TranscriptViewport.test.tsx` — live and projected visible-tool behavior.
- `src/renderer/components/panels/SubagentTranscript.test.tsx` — projected effective invocation parity.
- `src/renderer/stores/settings.ts` — synchronize `mcp.renderMarkdownResults` (default `true`) into renderer state.
- `src/renderer/locales/en.ts`, `src/renderer/locales/zh.ts` — MCP, structured-data, preview, and reasoning labels.
- `src/renderer/styles/components.css` — compact/framed/domain shell styling and preview/expanded layout.
- `CHANGELOG.md` — replace the contradictory Unreleased “Quieter execution history” entry with Adaptive Hybrid behavior.

---

### Task 1: Normalize Direct and `xd://` Invocations

**Files:**
- Create: `src/renderer/components/tools/tool-presentation.ts`
- Create: `src/renderer/components/tools/tool-presentation.test.ts`
- Read for wire contract only: `src/renderer/stores/tools.ts`, `src/renderer/lib/format.ts`

**Interfaces:**
- Produces:

```ts
export type ToolPresentationMode = "execute" | "help";

export interface ToolPresentationInput {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	partialResult: unknown;
	isError: boolean;
	streamingArgs?: string;
}

export interface McpIdentity {
	serverName: string;
	toolName: string;
}

export interface EffectiveToolInvocation {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	partialResult: unknown;
	isError: boolean;
	transport: "direct" | "xdev";
	mode: ToolPresentationMode;
	mcp?: McpIdentity;
}

export function resolveToolPresentation(input: ToolPresentationInput): EffectiveToolInvocation;
export function toolPresentationSummary(invocation: EffectiveToolInvocation): string;
```

- Consumed by Tasks 4 and 5 from `ToolCard` and registry dispatch.

- [ ] **Step 1: Write failing direct and device normalization tests**

Use complete AgentToolResult-style envelopes rather than source-text assertions:

```ts
it("unwraps a completed xd device into the effective tool contract", () => {
	const invocation = resolveToolPresentation({
		name: "write",
		args: { path: "xd://lsp", content: '{"action":"references","file":"src/a.ts"}' },
		result: {
			content: [{ type: "text", text: "Found 2 reference(s)" }],
			details: {
				xdev: {
					tool: "lsp",
					mode: "execute",
					args: { action: "references", file: "src/a.ts" },
					inner: { action: "references", success: true },
				},
			},
		},
		partialResult: null,
		isError: false,
	});

	expect(invocation).toMatchObject({
		name: "lsp",
		args: { action: "references", file: "src/a.ts" },
		transport: "xdev",
		mode: "execute",
	});
	expect(invocation.result).toEqual({
		content: [{ type: "text", text: "Found 2 reference(s)" }],
		details: { action: "references", success: true },
	});
});
```

Add separate tests for:

- direct Bash passthrough;
- pending `write xd://browser` identity + complete inner JSON decoding;
- incomplete inner JSON returning `{ __partialJson: raw }` rather than throwing;
- partial result `details.xdev.inner` normalization;
- `mode: "help"` staying documentation mode;
- malformed/non-device Write fallback;
- MCP identity from authoritative inner details;
- effective-name summary (never `Write` for an LSP device).

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run:

```bash
bunx vitest run src/renderer/components/tools/tool-presentation.test.ts
```

Expected: FAIL because `tool-presentation.ts` does not exist.

- [ ] **Step 3: Implement conservative normalization helpers**

Use narrowed records and complete-JSON parsing only; partial content remains explicitly labeled instead of repaired speculatively:

```ts
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function deviceName(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const match = /^xd:\/\/([^/?#]+)\/?$/.exec(path);
	return match?.[1];
}

function decodeInnerArgs(content: unknown): Record<string, unknown> {
	if (typeof content !== "string" || content.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(content);
		return asRecord(parsed) ?? { __partialJson: content };
	} catch {
		return { __partialJson: content };
	}
}

function replaceDetails(result: unknown, details: unknown): unknown {
	const envelope = asRecord(result);
	return envelope ? { ...envelope, details: details ?? null } : result;
}
```

Resolution precedence:

1. `partialResult.details.xdev` while running;
2. `result.details.xdev` after settle;
3. outer `write` path/content while the result envelope is absent;
4. direct passthrough.

For an authoritative Xdev envelope, use `xdev.tool`, `xdev.args`, and `xdev.inner`; preserve outer content and error state. Detect MCP from valid `serverName` + `mcpToolName` in effective details. Never infer MCP identity from arbitrary output text.

- [ ] **Step 4: Run normalization tests**

Run:

```bash
bunx vitest run src/renderer/components/tools/tool-presentation.test.ts
```

Expected: all direct/device/help/malformed/MCP cases PASS.

- [ ] **Step 5: Run TypeScript and Biome on the new unit**

Run:

```bash
bun run check:types
bunx biome check src/renderer/components/tools/tool-presentation.ts src/renderer/components/tools/tool-presentation.test.ts
```

Expected: no diagnostics in the new files. Stop at a review checkpoint; do not commit.

---

### Task 2: Cut Main Over to the Shared Transcript Viewport

**Files:**
- Modify: `src/renderer/components/chat/ChatStream.tsx`
- Modify: `src/renderer/components/chat/TranscriptViewport.tsx`
- Modify: `src/renderer/components/chat/ChatStream.test.tsx`
- Verify: `src/renderer/components/panels/SubagentTranscript.tsx`
- Verify: `src/renderer/components/panels/SubagentTranscript.test.tsx`

**Interfaces:**
- Consumes: existing `TranscriptProjectionView`, `MainTranscriptAugments`, and `resolveMainToolCall`.
- Produces: one shared viewport implementation for Main and projected subagent transcripts; `ChatCanvas` remains the public workspace adapter.

- [ ] **Step 1: Add a failing Main/shared-viewport regression**

Mount `ChatStream` with Main stores populated and assert contracts that currently exist in the duplicated implementation and must survive the cutover:

```ts
it("routes Main messages and occurrence-specific tools through the shared viewport", async () => {
	useMessagesStore.setState({ messages: toolRun });
	useSessionStore.setState({ sessionId: "main-session", status: "ready" });
	await mount(<ChatStream />);

	expect(container?.querySelector(".omp-transcript-editorial")).not.toBeNull();
	expect(container?.textContent).toContain("Implemented and verified.");
});
```

Keep existing queue, compaction-expander, waiting-row, transcript-detail, scrolling, and starter-state tests. Add a projected test asserting Main and subagent both render `TranscriptViewport` behavior without sharing tool maps.

- [ ] **Step 2: Run focused transcript tests before the cutover**

Run:

```bash
bunx vitest run src/renderer/components/chat/ChatStream.test.tsx src/renderer/components/chat/TranscriptViewport.test.tsx src/renderer/components/panels/SubagentTranscript.test.tsx
```

Expected: the new shared-viewport assertion FAILS or exposes duplicated-path behavior; pre-existing contracts remain green.

- [ ] **Step 3: Replace the duplicated Main viewport with a thin adapter**

Keep `ChatCanvas` and reduce `ChatStream` to store selection plus this shape:

```tsx
export function ChatStream() {
	const messages = useMessagesStore(state => state.messages);
	const streamingMessage = useMessagesStore(state => state.streamingMessage);
	const streamingText = useMessagesStore(state => state.streamingText);
	const streamingThinking = useMessagesStore(state => state.streamingThinking);
	const activeTools = useToolsStore(state => state.activeTools);
	const isStreaming = useSessionStore(state => state.isStreaming);
	const awaitingModelSince = useSessionStore(state => state.awaitingModelSince);
	const retryInfo = useSessionStore(state => state.retryInfo);
	const compactionInfo = useSessionStore(state => state.compactionInfo);
	const status = useSessionStore(state => state.status);
	const sessionId = useSessionStore(state => state.sessionId) ?? "main";
	const activeTab = useTabsStore(state => state.tabs.find(tab => tab.id === state.activeTabId));
	const remoteStartingTarget =
		status === "starting" && activeTab?.target.type === "ssh" ? activeTab.target : undefined;
	const collapseCompacted = useSettingsStore(state => state.collapseCompacted);
	const transcriptDetail = useUiStore(state => state.transcriptDetail);
	const switchPending = useUiStore(state => state.switchPending);
	const todoHistory = useTodoStore(state => state.history);
	const queued = useQueuedMessages();
	const isChat = useActiveTabKind() === "chat";

	return (
		<TranscriptViewport
			mode="main"
			projection={{
				transcriptId: sessionId,
				messages,
				streamingMessage,
				streamingText,
				streamingThinking,
				activeTools,
				resolveToolCall: resolveMainToolCall,
				transcriptDetail,
			}}
			main={{
				isStreaming,
				awaitingModelSince,
				retryInfo,
				compactionInfo,
				status,
				remoteStartingTarget,
				collapseCompacted,
				switchPending,
				todoHistory,
				queued,
				isChat,
			}}
		/>
	);
}
```

Use existing store hooks (`useQueuedMessages`, `useActiveTabKind`) rather than recreating queue or tab logic. Delete the duplicate virtualizer, history rows, live rows, process group, timeline marker, todo snapshot, queue bubble, and status-row implementations from `ChatStream.tsx`. Do not keep compatibility aliases.

- [ ] **Step 4: Re-run shared transcript tests**

Run the three focused files from Step 2.

Expected: all pass through one `TranscriptViewport` implementation, including Main-only queue/todo/compaction behavior and projected subagent isolation.

- [ ] **Step 5: Type-check and inspect the cutover files**

Run:

```bash
bun run check:types
bunx biome check src/renderer/components/chat/ChatStream.tsx src/renderer/components/chat/TranscriptViewport.tsx src/renderer/components/chat/ChatStream.test.tsx src/renderer/components/panels/SubagentTranscript.test.tsx
```

Expected: no stale imports or duplicate helper declarations. Stop at a review checkpoint; do not commit.

---

### Task 3: Keep Tools Visible in Compact History and Live Turns

**Files:**
- Modify: `src/renderer/components/chat/chat-stream-utils.ts`
- Modify: `src/renderer/components/chat/TranscriptViewport.tsx`
- Modify: `src/renderer/components/chat/ExecutionGroup.tsx`
- Modify: `src/renderer/components/chat/ExecutionGroup.test.tsx`
- Modify: `src/renderer/components/chat/ChatStream.test.tsx`
- Modify: `src/renderer/components/chat/TranscriptViewport.test.tsx`

**Interfaces:**
- Consumes: shared viewport from Task 2.
- Produces: compact rows where `process` contains reasoning only and tool-containing assistant messages remain visible `message` rows.

- [ ] **Step 1: Replace the old compact-group expectations with visible-tool failures**

Change the current `toolRun` contract from `['process', 'message']` to first-class tool rows:

```ts
it("keeps completed tool calls visible in compact history", () => {
	const rows = buildHistoryRows(toolRun, "compact");
	expect(rows.map(row => row.kind)).toEqual(["message", "message", "message"]);

	const tools = rows
		.filter((row): row is Extract<HistoryRow, { kind: "message" }> => row.kind === "message")
		.flatMap(row => (Array.isArray(row.message.content) ? row.message.content : []))
		.filter(block => block.type === "toolCall")
		.map(block => block.name);
	expect(tools).toEqual(["read", "write"]);
});
```

Add cases for:

- a message containing thinking + narration + tool call splits reasoning into `process` and keeps narration/tool in a visible `message`;
- consecutive thinking-only messages may remain one process row;
- a finalized Grep tool is present without clicking an outer Process disclosure;
- live compact mode renders thinking in its disclosure and tool cards as visible siblings;
- settling a live tool does not make it disappear.

- [ ] **Step 2: Run compact transcript tests and confirm failures**

Run:

```bash
bunx vitest run src/renderer/components/chat/ChatStream.test.tsx src/renderer/components/chat/TranscriptViewport.test.tsx src/renderer/components/chat/ExecutionGroup.test.tsx
```

Expected: old process-folding implementation fails the new visible-tool assertions.

- [ ] **Step 3: Split reasoning from tool-bearing messages in `buildHistoryRows`**

For compact assistant messages with array content:

1. Extract visible `thinking` blocks.
2. Put only those blocks into the pending process run.
3. Build a core message without thinking.
4. Flush reasoning before pushing the visible core message so chronology remains stable.
5. Never add a tool-call block to a process row.

The core branch should follow this form:

```ts
const thinking = message.content.filter(
	block => block.type === "thinking" && isRenderableMessageText(block.thinking),
);
const coreContent = message.content.filter(block => block.type !== "thinking");

if (thinking.length > 0) processMessages.push({ ...message, content: thinking });
if (coreContent.length > 0) {
	flushProcess();
	const coreMessage: AgentMessage = { ...message, content: coreContent };
	if (isVisibleTranscriptMessage(coreMessage)) rows.push({ kind: "message", message: coreMessage });
}
```

Do not classify narration + tool calls as hidden process work. Apply `groupReadRows` in both compact and full modes now that compact no longer folds all tools.

- [ ] **Step 4: Make the live compact layout mirror finalized history**

In `StreamingRows`:

- render live thinking inside `ExecutionGroup`;
- render `toolCards` outside that group as sibling Adaptive Hybrid entries;
- render streaming answer text after both;
- keep grouped reads working in compact and full modes;
- stop passing tool IDs/status maps into the reasoning-only group.

Simplify `ExecutionGroup` to status only its reasoning children: open while `live`, collapse after settle, and remove tool failure/running aggregation. Keep its native disclosure semantics and one reasoning spinner.

- [ ] **Step 5: Re-run compact transcript tests**

Run the three files from Step 2.

Expected: completed and live tools remain visible; reasoning disclosure tests pass; no generic Process card contains tool cards.

- [ ] **Step 6: Verify formatting and types**

Run:

```bash
bun run check:types
bunx biome check src/renderer/components/chat/chat-stream-utils.ts src/renderer/components/chat/TranscriptViewport.tsx src/renderer/components/chat/ExecutionGroup.tsx src/renderer/components/chat/ExecutionGroup.test.tsx src/renderer/components/chat/ChatStream.test.tsx src/renderer/components/chat/TranscriptViewport.test.tsx
```

Stop at a review checkpoint; do not commit.

---

### Task 4: Add Adaptive Registry Metadata, Shells, and Lookup Previews

**Files:**
- Modify: `src/renderer/components/tools/index.tsx`
- Modify: `src/renderer/components/tools/ToolCard.tsx`
- Create: `src/renderer/components/tools/ToolCard.test.tsx`
- Modify: `src/renderer/components/chat/MessageBubble.tsx`
- Modify: `src/renderer/components/tools/GrepRenderer.tsx`
- Modify: `src/renderer/components/tools/LspRenderer.tsx`
- Modify: `src/renderer/components/tools/GlobRenderer.tsx`
- Modify: `src/renderer/components/tools/AstGrepRenderer.tsx`
- Modify: `src/renderer/components/tools/WebSearchRenderer.tsx`
- Create: `src/renderer/components/tools/ThinkRenderer.tsx`
- Modify: `src/renderer/styles/components.css`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`

**Interfaces:**
- Consumes: `resolveToolPresentation()` and `toolPresentationSummary()` from Task 1.
- Produces:

```ts
export type ToolShell = "compact" | "framed" | "domain";
export type ToolRendererView = "preview" | "expanded";

export interface ToolRendererProps {
	args: Record<string, unknown>;
	result: unknown;
	isError?: boolean;
	isPartial?: boolean;
	partialResult?: unknown;
	view: ToolRendererView;
}

export interface ToolRendererDefinition {
	component: ComponentType<ToolRendererProps>;
	shell: ToolShell;
}

export function getToolRenderer(invocation: EffectiveToolInvocation): ToolRendererDefinition;
```

- [ ] **Step 1: Write failing ToolCard disclosure and effective-routing tests**

Cover observable DOM behavior:

```ts
it("renders an xd lsp call with the effective identity and compact shell", async () => {
	await mountTool({
		toolName: "write",
		args: { path: "xd://lsp", content: '{"action":"references","symbol":"ToolCard"}' },
		entry: completedXdevLspEntry,
	});

	const card = container.querySelector('[data-tool-name="lsp"]');
	expect(card?.getAttribute("data-tool-shell")).toBe("compact");
	expect(card?.textContent).toContain("references");
	expect(card?.textContent).not.toContain("xd://lsp");
});
```

Add tests for:

- Grep collapsed preview + click revealing all four fixture matches;
- Bash framed shell and body hidden until expanded;
- renderer-local exception falling back to Generic content;
- live partial update preserving open state;
- shared expand/collapse-all affecting compact and framed cards;
- `think` selecting a dedicated descriptor;
- direct tool behavior unchanged.

- [ ] **Step 2: Run the new ToolCard test and confirm failures**

Run:

```bash
bunx vitest run src/renderer/components/tools/ToolCard.test.tsx
```

Expected: FAIL because descriptors, effective routing, shell attributes, and preview view do not exist.

- [ ] **Step 3: Convert the registry to runtime descriptors**

Replace `Record<string, ComponentType<...>>` with `Record<string, ToolRendererDefinition>`. Use these shell assignments:

- compact: `read`, `grep`, `glob`, `lsp`, `ast_grep`, `web_search`;
- framed: `write`, `edit`, `apply_patch`, `ast_edit`, `resolve`, `reject`, `bash`, `eval`, `browser`, `computer`, `debug`, image tools, fallback Generic;
- domain: `task`, `todo` aliases, `goal`, `hub`, `ask`, `github` aliases, memory tools, vibe tools, `think`.

Keep all current aliases. Add `think: { component: ThinkRenderer, shell: "domain" }`. If `invocation.mcp` is present, Task 5 will override to MCP; until then return Generic framed.

- [ ] **Step 4: Move identity and summary ownership into `ToolCard`**

`MessageBubble` must no longer call its local outer-name `toolSummary()`. Remove that helper and the `summary` prop from `ToolCardProps`.

In `ToolCardContent`, build the Task 1 input from the original call and occurrence entry:

```ts
const invocation = resolveToolPresentation({
	name: toolName,
	args: entry ? { ...args, ...entry.args } : args,
	result: entry?.result,
	partialResult: entry?.partialResult,
	isError: Boolean(entry?.isError),
	streamingArgs: entry?.streamingArgs,
});
const definition = getToolRenderer(invocation);
const summary = toolPresentationSummary(invocation);
```

Expose `data-tool-name={invocation.name}` and `data-tool-shell={definition.shell}`. The header always uses the effective name and summary.

Add a small class error boundary around the specialized component. Import the GUI dependency with `import log from "electron-log/renderer"` and call `log.error("Tool renderer failed", { tool: invocation.name, error: String(error), componentStack: info.componentStack })` from `componentDidCatch`. Render `GenericRenderer` for this entry only. Do not use `console.*`.

- [ ] **Step 5: Implement shell-specific body behavior**

- compact: render the specialized component in both states; pass `view="preview"` while collapsed and `view="expanded"` while expanded;
- framed/domain: render the body only while expanded and pass `view="expanded"`;
- all shells retain native header disclosure, duration, status, running updates, and expand-all synchronization.

Add CSS keyed by `[data-tool-shell]`:

- compact: lightweight rail/row, transparent surface, preview body aligned under the header;
- framed: border, radius, status rail, inset result surface;
- domain: preserve existing domain component character without the generic Process wrapper.

Do not restore the universal border for compact lookup rows.

- [ ] **Step 6: Bound compact renderer previews without changing expanded bodies**

Use explicit local preview budgets:

- Grep: first 2 match lines plus file headers/context needed to understand them; expanded uses current `MAX_MATCHES` behavior.
- LSP: first 3 diagnostics/references/symbols; hover keeps the signature and first prose block.
- Glob: first 6 paths.
- AST Grep: first 6 matches.
- Web Search: first 3 results.
- Read: existing grouped/read preview contract remains authoritative; do not introduce nested duplicate previews.

Each preview must show an existing localized “N more” count when data is omitted. `view="expanded"` renders the current body behavior.

- [ ] **Step 7: Implement explicit ThinkRenderer parity**

Render the operation label and sanitized result text in the domain shell. It is a tool-call renderer, distinct from assistant `ThinkingBlock`; do not merge their state.

- [ ] **Step 8: Run renderer and transcript tests**

Run:

```bash
bunx vitest run src/renderer/components/tools/ToolCard.test.tsx src/renderer/components/chat/MessageBubble.test.tsx src/renderer/components/chat/ChatStream.test.tsx src/renderer/components/chat/TranscriptViewport.test.tsx src/renderer/components/tools/ReadGroupCard.test.tsx src/renderer/locales/locales.test.ts
```

Expected: direct and Xdev identity, shells, disclosure, previews, aliases, and locale parity PASS.

- [ ] **Step 9: Type-check and style-check touched renderer files**

Run `bun run check:types` and `bunx biome check` with every file listed in this task. Stop at a review checkpoint; do not commit.

---

### Task 5: Add MCP and Structured Dynamic-Tool Presentation

**Files:**
- Create: `src/renderer/components/tools/StructuredDataView.tsx`
- Create: `src/renderer/components/tools/StructuredDataView.test.tsx`
- Create: `src/renderer/components/tools/McpRenderer.tsx`
- Create: `src/renderer/components/tools/McpRenderer.test.tsx`
- Modify: `src/renderer/components/tools/GenericRenderer.tsx`
- Modify: `src/renderer/components/tools/index.tsx`
- Modify: `src/renderer/stores/settings.ts`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`

**Interfaces:**
- Consumes: `EffectiveToolInvocation.mcp`, `ToolRendererDefinition`, `MarkdownRenderer`, `extractImageDataUrl()`, `resultBodyText()`, `resultDetails()`.
- Produces:

```ts
export interface StructuredDataViewProps {
	value: unknown;
	defaultExpandedDepth?: number;
	maxDepth?: number;
	maxChildren?: number;
}

export function StructuredDataView(props: StructuredDataViewProps): ReactElement;
export function McpRenderer(props: ToolRendererProps): ReactElement;
```

- [ ] **Step 1: Write failing structured-data behavior tests**

Prove consumer-visible behavior:

- object keys and scalar values are shown;
- nested arrays/objects use semantic disclosure controls;
- depth 6 emits a localized bounded marker at the configured depth;
- more than 100 children emits an explicit omitted-count row;
- strings, booleans, numbers, and null have distinct semantic text;
- cyclic defensive input cannot recurse forever, even though JSON payloads should be acyclic.

Run:

```bash
bunx vitest run src/renderer/components/tools/StructuredDataView.test.tsx
```

Expected: missing component failure.

- [ ] **Step 2: Implement the bounded accessible tree**

Use recursive rows with a `WeakSet<object>` guard. Objects and arrays render a native button/disclosure with `aria-expanded`; scalars render as text. Defaults:

```ts
const DEFAULT_EXPANDED_DEPTH = 1;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_CHILDREN = 100;
```

Do not stringify the entire payload before applying limits. Keep nested controls outside parent disclosure buttons.

- [ ] **Step 3: Write failing MCP renderer tests**

Fixtures must cover:

```ts
const mcpDetails = {
	serverName: "context-mode",
	mcpToolName: "ctx_execute",
	isError: false,
	meta: { truncation: { totalLines: 80, outputLines: 20, artifactId: "42" } },
};
```

Assert:

- collapsed/header identity is `context-mode/ctx_execute`;
- expanded args use `StructuredDataView`;
- parseable JSON result uses `StructuredDataView` and not Markdown;
- non-JSON text uses sanitized `MarkdownRenderer` when the preference is true;
- false preference uses plain preformatted text;
- image content produces a safe data-URL image;
- errors preserve identity and error styling;
- truncation and `artifact://42` remain visible;
- direct MCP and `xd://` MCP fixtures render equivalently.

- [ ] **Step 4: Synchronize the MCP Markdown setting**

Add `mcpRenderMarkdownResults: boolean` to `SettingsStore`, default `true`, and map it in `DISPLAY_BOOL_MAP`:

```ts
const DISPLAY_BOOL_MAP = {
	// existing mappings
	"mcp.renderMarkdownResults": "mcpRenderMarkdownResults",
} as const;
```

The existing settings sync fetch remains the source; do not add a new RPC request.

- [ ] **Step 5: Implement `McpRenderer`**

Behavior order:

1. obtain effective text/details from the normalized result;
2. show server/tool identity from MCP details;
3. render args through `StructuredDataView` in expanded view;
4. if trimmed output parses as JSON, use `StructuredDataView`;
5. otherwise use sanitized Markdown when enabled, plain preformatted text when disabled;
6. render one safe inline image from `rawContent`/result when present;
7. render error and truncation/artifact metadata explicitly.

Do not reproduce TUI ANSI formatting. Use existing GUI colors and `CodeBlock`/Markdown surfaces.

- [ ] **Step 6: Route shape-aware MCP and improve Generic fallback**

`getToolRenderer(invocation)` returns `{ component: McpRenderer, shell: "framed" }` whenever `invocation.mcp` exists, regardless of whether the call was direct or device-dispatched.

Update `GenericRenderer`:

- parse JSON body to `StructuredDataView`;
- show effective args through the same tree;
- use `extractImageDataUrl()` for recognized image content;
- preserve plain text, error, details, and truncation information;
- never label the card `write` after Task 1 resolves a dynamic device.

- [ ] **Step 7: Run MCP, structured, generic, settings, and locale tests**

Run:

```bash
bunx vitest run src/renderer/components/tools/StructuredDataView.test.tsx src/renderer/components/tools/McpRenderer.test.tsx src/renderer/components/tools/ToolCard.test.tsx src/renderer/stores/settings.test.ts src/renderer/locales/locales.test.ts
```

Expected: JSON/Markdown/image/error/truncation/direct/device contracts PASS.

- [ ] **Step 8: Type-check and Biome-check Task 5 files**

Run `bun run check:types` and `bunx biome check` with every file listed in this task. Stop at a review checkpoint; do not commit.

---

### Task 6: Close Parity Gaps, Update Changelog, and Verify the Real GUI

**Files:**
- Modify as failures require: files from Tasks 1–5 only
- Modify: `CHANGELOG.md`
- Verify: `src/renderer/components/chat/ChatStream.test.tsx`
- Verify: `src/renderer/components/chat/TranscriptViewport.test.tsx`
- Verify: `src/renderer/components/panels/SubagentTranscript.test.tsx`
- Verify: `src/renderer/components/tools/ToolCard.test.tsx`
- Verify: `src/renderer/components/tools/McpRenderer.test.tsx`

**Interfaces:**
- Consumes: complete Adaptive Hybrid implementation.
- Produces: end-to-end evidence for live/hydrated/Main/subagent parity and an accurate Unreleased changelog.

- [ ] **Step 1: Add one cross-path integration fixture**

Create a representative message sequence containing:

- direct Grep with four structured matches;
- `write xd://lsp` with `details.xdev`;
- direct Bash with output/exit/wall-time details;
- `write xd://browser` result;
- `write xd://mcp__context_mode_ctx_execute` with MCP inner details;
- malformed unknown device fallback.

Use the same sequence through Main hydration and a transcript-local `ToolProjection`. Assert equivalent `data-tool-name`, `data-tool-shell`, summary text, and expanded body semantics—not implementation class names or source text.

- [ ] **Step 2: Run the focused parity suite**

Run:

```bash
bunx vitest run \
  src/renderer/components/tools/tool-presentation.test.ts \
  src/renderer/components/tools/ToolCard.test.tsx \
  src/renderer/components/tools/StructuredDataView.test.tsx \
  src/renderer/components/tools/McpRenderer.test.tsx \
  src/renderer/components/chat/ExecutionGroup.test.tsx \
  src/renderer/components/chat/ChatStream.test.tsx \
  src/renderer/components/chat/TranscriptViewport.test.tsx \
  src/renderer/components/panels/SubagentTranscript.test.tsx \
  src/renderer/locales/locales.test.ts
```

Expected: all pass.

- [ ] **Step 3: Update the Unreleased changelog without contradiction**

Replace the current Unreleased Changed bullet beginning `**Quieter execution history**` with one accurate entry:

```markdown
- **Adaptive tool activity**: the default transcript now keeps completed tool calls visible as compact lookup rows or expandable rich cards instead of hiding them behind a generic process summary; `xd://` dispatches use the underlying built-in renderer, and MCP/dynamic tools show structured arguments, results, errors, images, and truncation metadata.
```

Do not modify released sections.

- [ ] **Step 4: Run full static and behavioral verification**

Run through context-mode so only failures/summaries enter the session:

```bash
bun run check:types
bunx biome check <all touched files>
bunx vitest run
bun run build
```

Expected:

- TypeScript: zero errors.
- Biome: touched files clean.
- Vitest: full suite passes.
- Vite/Electron build exits 0 and produces the normal `out/` layout.

- [ ] **Step 5: Exercise the actual GUI surface through the bundled sidecar**

Launch the built/development Electron app, open a real agent session, and execute:

1. Grep with exactly four matches.
2. LSP through its mounted `xd://` device.
3. Bash with stdout and a successful exit.
4. Browser action with text or screenshot output.
5. MCP call returning JSON.
6. MCP call returning Markdown/plain text.

For each call verify:

- no outer generic Process/task card hides the tool;
- collapsed presentation matches Adaptive Hybrid;
- click/keyboard expansion reveals the full received result;
- Grep reveals all four matches;
- effective identity is LSP/Browser/MCP rather than Write;
- running updates do not collapse an open entry;
- error and truncation metadata are visible.

Switch to Full mode and back, reload the session to test hydrated history, and select a subagent transcript containing a tool call. Confirm the same effective presentation in every path.

- [ ] **Step 6: Capture visual evidence and inspect renderer logs**

Capture the final compact transcript with representative compact and framed entries. Check the GUI log for renderer-boundary warnings; expected: none for valid fixtures. If a malformed fixture triggers fallback, confirm only that invocation falls back and the surrounding transcript remains interactive.

- [ ] **Step 7: Final scope review**

Confirm:

- no files outside `packages/gui` changed;
- no bundled `resources/omp*` artifact was modified or staged;
- no duplicate Main/subagent viewport implementation remains;
- every affected callsite, test, locale, and Unreleased changelog entry is updated;
- no commit was created without explicit user instruction.

Stop at the final review checkpoint with exact command results and screenshots/behavior observed.
