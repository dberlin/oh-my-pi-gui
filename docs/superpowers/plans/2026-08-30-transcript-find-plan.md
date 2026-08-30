# Transcript Find Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every `TranscriptViewport` a real find — ⌘F opens a bar, typing indexes the whole row model (including content hidden inside collapsed disclosures), and ↵ walks matches backwards through history with highlighting, scroll-rail ticks, and a wrap indicator.

**Architecture:** Find runs over the row model, never the DOM, because `@tanstack/react-virtual` (overscan 8) keeps off-screen rows unmounted. A pure module builds a match index from `Row[]` + `rowKeys`; a hook owns query/ordinal/open state and drives `virtualizer.scrollToIndex(rowIndex, { align: "center" })`, disclosure reveal, and highlight repaint; a presentational bar and tick rail render from that state. `TranscriptViewport.tsx` (already 1076 lines) only wires these together.

**Tech Stack:** React 19, TypeScript 7 (`strict`, `lib: ES2024/DOM/DOM.Iterable`), Zustand 5, Tailwind 4, `@tanstack/react-virtual` 3.14, Vitest + linkedom, Electron 43 (Chromium with CSS Custom Highlight API), Biome (tabs).

**Spec:** `docs/superpowers/specs/2026-08-30-transcript-find-design.md`

## Global Constraints

- Work only inside `packages/gui`. No sidecar changes, no RPC commands, no wire-contract changes — everything searched already lives in renderer stores.
- The feature is additive. The only behavior change to existing surfaces is that an open find bar consumes <kbd>Esc</kbd> via `preventDefault()`, which `App.tsx`'s existing `!event.defaultPrevented` guard already honors. **Do not modify `App.tsx`'s Escape branch.**
- Component boundaries are fixed by the spec: `chat/transcript-find.ts` (pure — no React, no DOM), `chat/useTranscriptFind.ts` (hook), `chat/TranscriptFindBar.tsx` (presentational), `chat/transcript-find-highlight.ts` (`CSS.highlights` only). `TranscriptViewport.tsx` wires; it does not grow find logic.
- Matching is case-insensitive literal substring over a whitespace-normalized copy. **No regex** — a `(` in the query must find a literal `(`.
- The match count must not depend on what the user has expanded. Collapsed thinking blocks, capped tool results, and scrolled diffs all contribute matches.
- Match count and ordinals are in **document order**: match 1 is the oldest. Travel direction never renumbers.
- Default navigation direction is **backwards through history** (older). Forward is explicit.
- Three keymap actions with exact ids and defaults: `transcript.find` → `⌘F`, `⌃F`; `transcript.findNext` → `⌘G`; `transcript.findPrevious` → `⇧⌘G`. All three `overlaySafe: false`.
- <kbd>↵</kbd> / <kbd>⇧↵</kbd> are handled locally by the find input, **not** through `KEYMAP_ACTIONS` — `parseChord` rejects unmodified and shift-only chords by design.
- Every user-visible string must exist in BOTH `src/renderer/locales/en.ts` and `src/renderer/locales/zh.ts` under the same key. `src/renderer/locales/locales.test.ts` enforces key parity, non-empty values, placeholder subsetting, AND — because `chat.` and `hotkeys.` are in `TRANSLATED_NAMESPACES` — that no zh value is byte-identical to its en value. Never add a locale key whose value is a bare format string like `"{current} / {total}"`; render pure numerals in JSX instead.
- No `CSS.highlights` support must degrade to "navigation works, no paint" — never a throw.
- Indentation is tabs. Formatting is Biome. `scripts/lint-surfaces.mjs` rejects unprefixed `bg-(--omp-bg-primary|secondary|tertiary)` / `bg-[var(--omp-bg-*)]` in `.ts`/`.tsx`, and `text-[Npx]` below 16px. `--omp-bg-elevated` is permitted for floating overlays (the existing jump-to-latest button uses it).
- The gate is `npm run check` (`node scripts/lint-surfaces.mjs && biome check . && tsc --noEmit`) plus `npx vitest run`.
- This repo is a nested colocated **jj** repo. Do not run raw `git` write commands, and do not commit or push unless the user explicitly asks.

---

### Task 1: Row text extraction

**Files:**
- Create: `src/renderer/components/chat/transcript-find.ts`
- Create: `src/renderer/components/chat/transcript-find.test.ts`

**Interfaces:**
- Consumes `Row` from `./chat-stream-utils`, `ResolveToolCall` from `../../lib/read-group`, `ToolEntry` from `../../stores/tools`, `resultText` from `../../lib/format`, `messageText`/`isRenderableMessageText` from `../../lib/messages`, `thinkingDisclosureKey` from `../../stores/messages`, `TOOL_DISCLOSURE_PREFIX` from `../../stores/ui`.
- Produces:

```ts
export interface TranscriptFindContext {
	/** Same resolver the rows render with (main: resolveMainToolCall; projected: the projection's). */
	resolveToolCall: ResolveToolCall;
	/** Fallback entry lookup for read-group entries that carry no original call object. */
	lookupToolEntry: (toolKey: string) => ToolEntry | undefined;
}

/** One searchable text run inside a row, plus the disclosure that hides it (null = always visible). */
export interface FindSegment {
	text: string;
	disclosureKey: string | null;
}

export function normalizeFindText(raw: string): string;
export function extractRowSegments(row: Row, rowKey: string, context: TranscriptFindContext): FindSegment[];
```

`normalizeFindText` lowercases and collapses every run of whitespace to a single space, then trims. `extractRowSegments` returns segments in the order the row renders them, with **raw** (un-normalized) text — normalization happens in the matcher so the highlight module can reproduce the identical mapping.

Disclosure keys are **unscoped** here (the hook adds `scopedDisclosureKey`):
- thinking block inside a `message`/`process`/`streaming` row → `thinkingDisclosureKey(message, ordinal)`, where `ordinal` counts only *renderable* thinking blocks in that message, matching `MessageBubble`'s `thinkingOrdinal++`.
- tool-call name/arguments/result inside any message row → `` `${TOOL_DISCLOSURE_PREFIX}${resolveToolCall(block).key}` `` (i.e. `tool:<key>`), matching `ToolCard`'s `scopedDisclosureKey(scope, TOOL_DISCLOSURE_PREFIX + toolCallId)`.
- `todoSnapshot` row → `` `todo:${rowKey}` ``, matching `TranscriptViewport`'s `<TodoSnapshotCard disclosureKey={`todo:${item.key}`} />` where `item.key` is the row key.
- everything else → `null`.

Per-row-kind corpus (spec §Search corpus):

| Row kind | Segments |
| --- | --- |
| `message` | per content block: `text` → `block.text`; `thinking` → `block.thinking`; `toolCall` → `block.name`, `JSON.stringify(block.arguments)`, and `resultText(resolved.entry?.result ?? resolved.entry?.partialResult)`. Plus `message.output`, `message.code`, and `message.summary` when present. String-content messages contribute `messageText(message)`. |
| `process` | every message in `row.messages`, as for `message` |
| `readGroup` | per entry: `entry.path`, `entry.selector`, and the entry's result text via `entry.call ? context.resolveToolCall(entry.call).entry : context.lookupToolEntry(entry.toolKey)` |
| `todoSnapshot` | each `phase.name` and each `task.content` |
| `streaming` | as for `message`, over `row.message` |
| `queued` | `row.item.text` |
| `pending` | none |
| `expander` | **none** (deferred) |

Empty and non-renderable segments are dropped (`isRenderableMessageText` for text/thinking; a falsy string otherwise).

- [ ] **Step 1: Write the failing extraction tests**

Create `src/renderer/components/chat/transcript-find.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AgentMessage, ToolCallContent } from "../../../shared/rpc-types";
import type { ToolEntry } from "../../stores/tools";
import type { Row } from "./chat-stream-utils";
import { extractRowSegments, normalizeFindText, type TranscriptFindContext } from "./transcript-find";

const grepCall: ToolCallContent = {
	type: "toolCall",
	id: "call-1",
	name: "grep",
	arguments: { pattern: "needle", path: "src" },
};

const grepEntry: ToolEntry = {
	toolName: "grep",
	args: grepCall.arguments,
	status: "done",
	partialResult: null,
	streamingArgs: "",
	result: { content: [{ type: "text", text: "src/live.ts:9:const needle = true;" }], details: null },
	isError: false,
	startTime: 1,
	endTime: 2,
};

const context: TranscriptFindContext = {
	resolveToolCall: () => ({ key: "call-1", entry: grepEntry }),
	lookupToolEntry: key => (key === "call-1" ? grepEntry : undefined),
};

function assistant(content: AgentMessage["content"], timestamp = 100): AgentMessage {
	return { role: "assistant", content, timestamp };
}

describe("normalizeFindText", () => {
	it("lowercases, collapses whitespace runs, and trims", () => {
		expect(normalizeFindText("  Hello\n\n  WORLD\t(x)  ")).toBe("hello world (x)");
	});
});

describe("extractRowSegments", () => {
	it("extracts text, thinking, and tool name/args/result from a message row with their disclosure keys", () => {
		const message = assistant([
			{ type: "text", text: "Visible answer" },
			{ type: "thinking", thinking: "Hidden reasoning" },
			grepCall,
		]);
		const segments = extractRowSegments({ kind: "message", message }, "message-a", context);
		expect(segments.map(s => s.text)).toEqual([
			"Visible answer",
			"Hidden reasoning",
			"grep",
			JSON.stringify(grepCall.arguments),
			"src/live.ts:9:const needle = true;",
		]);
		expect(segments[0]?.disclosureKey).toBeNull();
		expect(segments[1]?.disclosureKey).toMatch(/:thinking:0$/);
		expect(segments[2]?.disclosureKey).toBe("tool:call-1");
		expect(segments[4]?.disclosureKey).toBe("tool:call-1");
	});

	it("numbers thinking disclosures only over renderable thinking blocks", () => {
		const message = assistant([
			{ type: "thinking", thinking: "   " },
			{ type: "thinking", thinking: "First real" },
			{ type: "thinking", thinking: "Second real" },
		]);
		const segments = extractRowSegments({ kind: "message", message }, "message-b", context);
		expect(segments.map(s => s.text)).toEqual(["First real", "Second real"]);
		expect(segments[0]?.disclosureKey).toMatch(/:thinking:0$/);
		expect(segments[1]?.disclosureKey).toMatch(/:thinking:1$/);
	});

	it("extracts read-group paths, selectors, and per-entry result text", () => {
		const row: Row = {
			kind: "readGroup",
			entries: [{ callId: "call-1", toolKey: "call-1", path: "src/live.ts", selector: "1-20", args: {} }],
		};
		const segments = extractRowSegments(row, "read-call-1", context);
		expect(segments.map(s => s.text)).toEqual(["src/live.ts", "1-20", "src/live.ts:9:const needle = true;"]);
		expect(segments.every(s => s.disclosureKey === null)).toBe(true);
	});

	it("extracts todo snapshot phase names and task content behind the row's todo disclosure key", () => {
		const row: Row = {
			kind: "todoSnapshot",
			entry: {
				id: "snap-1",
				ts: 5,
				phases: [{ name: "Build", tasks: [{ content: "Wire the needle", status: "pending" }] }],
			},
		};
		expect(extractRowSegments(row, "todo-snapshot-snap-1", context)).toEqual([
			{ text: "Build", disclosureKey: "todo:todo-snapshot-snap-1" },
			{ text: "Wire the needle", disclosureKey: "todo:todo-snapshot-snap-1" },
		]);
	});

	it("extracts streaming and queued text and never extracts the pre-compaction expander", () => {
		expect(
			extractRowSegments({ kind: "streaming", message: assistant([{ type: "text", text: "Live tail" }]) }, "s", context),
		).toEqual([{ text: "Live tail", disclosureKey: null }]);
		expect(
			extractRowSegments(
				{ kind: "queued", item: { id: "q1", text: "Queued prompt", editable: true, timestamp: 1 }, lane: "steering" },
				"queued-q1",
				context,
			),
		).toEqual([{ text: "Queued prompt", disclosureKey: null }]);
		expect(extractRowSegments({ kind: "expander", count: 214 }, "pre-compaction-expander", context)).toEqual([]);
		expect(extractRowSegments({ kind: "pending" }, "pending", context)).toEqual([]);
	});
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run src/renderer/components/chat/transcript-find.test.ts`

Expected: FAIL — `Failed to resolve import "./transcript-find"`.

- [ ] **Step 3: Implement extraction**

Create `src/renderer/components/chat/transcript-find.ts` with a file header comment explaining that find indexes the row model rather than the DOM because the virtualizer keeps off-screen rows unmounted, then:

```ts
export function normalizeFindText(raw: string): string {
	return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function push(segments: FindSegment[], text: string | undefined | null, disclosureKey: string | null): void {
	if (typeof text !== "string" || text.trim() === "") return;
	segments.push({ text, disclosureKey });
}

function toolSegments(block: ToolCallContent, segments: FindSegment[], context: TranscriptFindContext): void {
	const resolved = context.resolveToolCall(block);
	const key = `${TOOL_DISCLOSURE_PREFIX}${resolved.key}`;
	push(segments, block.name, key);
	try {
		push(segments, JSON.stringify(block.arguments), key);
	} catch {
		/* unserializable arguments contribute nothing */
	}
	push(segments, resultText(resolved.entry?.result ?? resolved.entry?.partialResult), key);
}

function messageSegments(message: AgentMessage, segments: FindSegment[], context: TranscriptFindContext): void {
	if (Array.isArray(message.content)) {
		let thinkingOrdinal = 0;
		for (const block of message.content) {
			if (block.type === "text") {
				if (isRenderableMessageText(block.text)) push(segments, block.text, null);
			} else if (block.type === "thinking") {
				if (!isRenderableMessageText(block.thinking)) continue;
				push(segments, block.thinking, thinkingDisclosureKey(message, thinkingOrdinal++));
			} else if (block.type === "toolCall") {
				toolSegments(block, segments, context);
			}
		}
	} else {
		push(segments, messageText(message), null);
	}
	push(segments, message.code, null);
	push(segments, message.output, null);
	push(segments, message.summary, null);
}
```

`extractRowSegments` switches on `row.kind` and delegates: `message`/`streaming` → `messageSegments(row.message, …)`; `process` → `messageSegments` over each of `row.messages`; `readGroup` → per entry push `entry.path`, `entry.selector`, then `resultText((entry.call ? context.resolveToolCall(entry.call).entry : context.lookupToolEntry(entry.toolKey))?.result ?? …partialResult)`, all with `disclosureKey: null`; `todoSnapshot` → phase names and task contents with `` `todo:${rowKey}` ``; `queued` → `row.item.text` with `null`; `pending`/`expander` → `[]`.

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `npx vitest run src/renderer/components/chat/transcript-find.test.ts`

Expected: PASS — all six tests.

- [ ] **Step 5: Confirm the module stays pure**

Run: `grep -nE "react|document|window|useState|CSS\." src/renderer/components/chat/transcript-find.ts`

Expected: no output. The module must import nothing from React and touch no DOM global.

---

### Task 2: Match index with incremental reindexing

**Files:**
- Modify: `src/renderer/components/chat/transcript-find.ts`
- Modify: `src/renderer/components/chat/transcript-find.test.ts`

**Interfaces:**
- Consumes `extractRowSegments`, `normalizeFindText`, `TranscriptFindContext` from Task 1.
- Produces:

```ts
/** Per-row match, cached by rowKey so appends do not rescan the transcript. */
export interface RowMatchSeed {
	disclosureKey: string | null;
	/** 0-based position of this match among the row's own matches, in render order. */
	occurrenceInRow: number;
}

export interface TranscriptMatch {
	rowIndex: number;
	rowKey: string;
	/** 0-based position in document order across the whole transcript. */
	ordinal: number;
	disclosureKey: string | null;
	locator: { occurrenceInRow: number };
}

export interface TranscriptFindIndex {
	/** The normalized needle this index was built for ("" = no matches by definition). */
	needle: string;
	matches: readonly TranscriptMatch[];
	/** rowKey → that row's seeds; carried forward when the needle is unchanged. */
	rowCache: ReadonlyMap<string, readonly RowMatchSeed[]>;
}

export const EMPTY_FIND_INDEX: TranscriptFindIndex;

export function buildTranscriptFindIndex(input: {
	rows: readonly Row[];
	rowKeys: readonly string[];
	query: string;
	context: TranscriptFindContext;
	previous?: TranscriptFindIndex | null;
}): TranscriptFindIndex;
```

Rules:
- An empty or whitespace-only query yields `EMPTY_FIND_INDEX` (`needle: ""`, no matches). Never "0 / 0 as an error".
- The needle is `normalizeFindText(query)`; each segment is matched as `normalizeFindText(segment.text).indexOf(needle, from)` in a loop advancing by `needle.length` (non-overlapping, document order).
- Reuse: when `previous.needle === needle` and `previous.rowCache.has(rowKey)`, reuse the cached seeds and do **not** call `extractRowSegments` for that row. This is what makes streaming appends O(new rows).
- The **streaming row must always be rescanned** even on a cache hit: its `rowKey` is stable across deltas (`message-<identity>`) while its text grows. Exclude `row.kind === "streaming"` from cache reuse.
- Ordinals are assigned by a single pass over rows in order, so removing rows renumbers deterministically.

- [ ] **Step 1: Write the failing index tests**

Append to `src/renderer/components/chat/transcript-find.test.ts`:

```ts
import { buildTranscriptFindIndex, EMPTY_FIND_INDEX } from "./transcript-find";

function textRow(text: string): Row {
	return { kind: "message", message: assistant([{ type: "text", text }]) };
}

function buildAll(rows: Row[], keys: string[], query: string, previous?: TranscriptFindIndex | null) {
	return buildTranscriptFindIndex({ rows, rowKeys: keys, query, context, previous });
}

describe("buildTranscriptFindIndex", () => {
	it("returns the empty index for a blank query", () => {
		expect(buildAll([textRow("needle")], ["r0"], "   ")).toBe(EMPTY_FIND_INDEX);
	});

	it("numbers matches 0..n-1 in document order across rows", () => {
		const index = buildAll(
			[textRow("needle and needle"), textRow("nothing"), textRow("one needle")],
			["r0", "r1", "r2"],
			"needle",
		);
		expect(index.matches.map(m => [m.ordinal, m.rowIndex, m.locator.occurrenceInRow])).toEqual([
			[0, 0, 0],
			[1, 0, 1],
			[2, 2, 0],
		]);
	});

	it("matches literally, never as a regex", () => {
		expect(buildAll([textRow("call foo(x) now")], ["r0"], "foo(x)").matches).toHaveLength(1);
		expect(buildAll([textRow("aaa")], ["r0"], "a.a").matches).toHaveLength(0);
	});

	it("is case-insensitive and whitespace-normalized on both sides", () => {
		expect(buildAll([textRow("The  Needle\nhere")], ["r0"], "  needle HERE ").matches).toHaveLength(1);
	});

	it("counts matches hidden behind collapsed disclosures and records their keys", () => {
		const message = assistant([{ type: "thinking", thinking: "the needle is here" }, grepCall]);
		const index = buildAll([{ kind: "message", message }], ["r0"], "needle");
		expect(index.matches).toHaveLength(2);
		expect(index.matches[0]?.disclosureKey).toMatch(/:thinking:0$/);
		expect(index.matches[1]?.disclosureKey).toBe("tool:call-1");
	});

	it("rescans only rows it has not seen when the transcript appends", () => {
		const rows = [textRow("needle one"), textRow("needle two")];
		const keys = ["r0", "r1"];
		const first = buildAll(rows, keys, "needle");
		const scanned: string[] = [];
		const spyContext: TranscriptFindContext = {
			resolveToolCall: context.resolveToolCall,
			lookupToolEntry: key => {
				scanned.push(key);
				return context.lookupToolEntry(key);
			},
		};
		const grouped: Row = { kind: "readGroup", entries: [{ callId: "c", toolKey: "call-1", path: "needle.ts", args: {} }] };
		const second = buildTranscriptFindIndex({
			rows: [...rows, grouped],
			rowKeys: [...keys, "r2"],
			query: "needle",
			context: spyContext,
			previous: first,
		});
		// Only the appended read-group row hit the resolver.
		expect(scanned).toEqual(["call-1"]);
		expect(second.matches.map(m => m.ordinal)).toEqual([0, 1, 2]);
	});

	it("drops matches for removed rows and renumbers the survivors", () => {
		const first = buildAll([textRow("needle a"), textRow("needle b")], ["r0", "r1"], "needle");
		const second = buildAll([textRow("needle b")], ["r1"], "needle", first);
		expect(second.matches).toHaveLength(1);
		expect(second.matches[0]).toMatchObject({ ordinal: 0, rowIndex: 0, rowKey: "r1" });
	});

	it("rescans the streaming row even when its key is already cached", () => {
		const key = ["s0"];
		const short: Row = { kind: "streaming", message: assistant([{ type: "text", text: "nee" }]) };
		const grown: Row = { kind: "streaming", message: assistant([{ type: "text", text: "needle" }]) };
		const first = buildAll([short], key, "needle");
		expect(first.matches).toHaveLength(0);
		expect(buildAll([grown], key, "needle", first).matches).toHaveLength(1);
	});
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run src/renderer/components/chat/transcript-find.test.ts`

Expected: FAIL with `buildTranscriptFindIndex is not a function` (or an import error for `EMPTY_FIND_INDEX`).

- [ ] **Step 3: Implement the index**

Add to `transcript-find.ts`:

```ts
export const EMPTY_FIND_INDEX: TranscriptFindIndex = { needle: "", matches: [], rowCache: new Map() };

function seedRow(row: Row, rowKey: string, needle: string, context: TranscriptFindContext): RowMatchSeed[] {
	const seeds: RowMatchSeed[] = [];
	for (const segment of extractRowSegments(row, rowKey, context)) {
		const haystack = normalizeFindText(segment.text);
		let from = haystack.indexOf(needle);
		while (from !== -1) {
			seeds.push({ disclosureKey: segment.disclosureKey, occurrenceInRow: seeds.length });
			from = haystack.indexOf(needle, from + needle.length);
		}
	}
	return seeds;
}

export function buildTranscriptFindIndex(input: {
	rows: readonly Row[];
	rowKeys: readonly string[];
	query: string;
	context: TranscriptFindContext;
	previous?: TranscriptFindIndex | null;
}): TranscriptFindIndex {
	const needle = normalizeFindText(input.query);
	if (!needle) return EMPTY_FIND_INDEX;
	const reusable = input.previous?.needle === needle ? input.previous.rowCache : null;
	const rowCache = new Map<string, readonly RowMatchSeed[]>();
	const matches: TranscriptMatch[] = [];
	for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex++) {
		const row = input.rows[rowIndex];
		if (!row) continue;
		const rowKey = input.rowKeys[rowIndex] ?? String(rowIndex);
		// The streaming row keeps one identity while its text grows, so its cache
		// entry is never trustworthy — rescan it on every rebuild.
		const cached = row.kind === "streaming" ? undefined : reusable?.get(rowKey);
		const seeds = cached ?? seedRow(row, rowKey, needle, input.context);
		rowCache.set(rowKey, seeds);
		for (const seed of seeds) {
			matches.push({
				rowIndex,
				rowKey,
				ordinal: matches.length,
				disclosureKey: seed.disclosureKey,
				locator: { occurrenceInRow: seed.occurrenceInRow },
			});
		}
	}
	return { needle, matches, rowCache };
}
```

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `npx vitest run src/renderer/components/chat/transcript-find.test.ts`

Expected: PASS — all Task 1 and Task 2 tests.

---

### Task 3: Navigation arithmetic and tick positions

**Files:**
- Modify: `src/renderer/components/chat/transcript-find.ts`
- Modify: `src/renderer/components/chat/transcript-find.test.ts`

**Interfaces:**
- Consumes `TranscriptMatch` from Task 2.
- Produces:

```ts
/** "older" travels backwards through history (down-ordinal); "newer" travels toward the live edge. */
export type FindDirection = "older" | "newer";

export interface FindStep {
	ordinal: number;
	/** True for exactly one step when the move crossed an end of the transcript. */
	wrapped: boolean;
}

/** Opening / re-querying: first match at or above `visibleEndRowIndex`, searching upward, wrapping once to the bottom. */
export function seedFindOrdinal(matches: readonly TranscriptMatch[], visibleEndRowIndex: number): FindStep | null;

/** ↵ / ⌘G ("older") and ⇧↵ / ⇧⌘G ("newer"), each wrapping once. */
export function stepFindOrdinal(
	matches: readonly TranscriptMatch[],
	current: number | null,
	direction: FindDirection,
): FindStep | null;

/** Keep a live ordinal in range after the index rebuilds; null when there are no matches. */
export function clampFindOrdinal(matches: readonly TranscriptMatch[], current: number | null): number | null;

export interface FindTick {
	ordinal: number;
	/** 0..1 down the scroll rail. */
	fraction: number;
}

/** Tick per match from measured virtualizer offsets; unmeasured rows are skipped, not guessed. */
export function findTickPositions(
	matches: readonly TranscriptMatch[],
	offsetForRow: (rowIndex: number) => number | null,
	totalSize: number,
): FindTick[];
```

Semantics, exactly:
- `seedFindOrdinal`: pick the **highest** ordinal whose `rowIndex <= visibleEndRowIndex`; if none exists, return the **last** match with `wrapped: true`. Empty matches → `null`.
- `stepFindOrdinal("older")`: `current - 1`; below 0 wraps to `matches.length - 1` with `wrapped: true`. A `null` current seeds at the last match, `wrapped: false`.
- `stepFindOrdinal("newer")`: `current + 1`; past the end wraps to `0` with `wrapped: true`. A `null` current seeds at `0`, `wrapped: false`.
- `clampFindOrdinal`: `null`/empty → `null`; otherwise `Math.min(Math.max(current, 0), matches.length - 1)`.
- `findTickPositions`: skip a match whose `offsetForRow` is `null`; `fraction = totalSize > 0 ? clamp01(offset / totalSize) : 0`.

- [ ] **Step 1: Write the failing navigation tests**

Append to `src/renderer/components/chat/transcript-find.test.ts`:

```ts
import { clampFindOrdinal, findTickPositions, seedFindOrdinal, stepFindOrdinal } from "./transcript-find";

const matches = [
	{ rowIndex: 2, rowKey: "r2", ordinal: 0, disclosureKey: null, locator: { occurrenceInRow: 0 } },
	{ rowIndex: 5, rowKey: "r5", ordinal: 1, disclosureKey: null, locator: { occurrenceInRow: 0 } },
	{ rowIndex: 9, rowKey: "r9", ordinal: 2, disclosureKey: null, locator: { occurrenceInRow: 0 } },
];

describe("seedFindOrdinal", () => {
	it("selects the newest match at or above the viewport's bottom edge", () => {
		expect(seedFindOrdinal(matches, 6)).toEqual({ ordinal: 1, wrapped: false });
		expect(seedFindOrdinal(matches, 5)).toEqual({ ordinal: 1, wrapped: false });
	});

	it("wraps to the newest match when everything visible is above the first match", () => {
		expect(seedFindOrdinal(matches, 1)).toEqual({ ordinal: 2, wrapped: true });
	});

	it("returns null with no matches", () => {
		expect(seedFindOrdinal([], 10)).toBeNull();
	});
});

describe("stepFindOrdinal", () => {
	it("walks backwards through history and wraps once at the top", () => {
		expect(stepFindOrdinal(matches, 2, "older")).toEqual({ ordinal: 1, wrapped: false });
		expect(stepFindOrdinal(matches, 0, "older")).toEqual({ ordinal: 2, wrapped: true });
	});

	it("walks toward the live edge and wraps once at the bottom", () => {
		expect(stepFindOrdinal(matches, 0, "newer")).toEqual({ ordinal: 1, wrapped: false });
		expect(stepFindOrdinal(matches, 2, "newer")).toEqual({ ordinal: 0, wrapped: true });
	});

	it("seeds from an end without reporting a wrap when nothing was selected", () => {
		expect(stepFindOrdinal(matches, null, "older")).toEqual({ ordinal: 2, wrapped: false });
		expect(stepFindOrdinal(matches, null, "newer")).toEqual({ ordinal: 0, wrapped: false });
		expect(stepFindOrdinal([], null, "older")).toBeNull();
	});
});

describe("clampFindOrdinal", () => {
	it("clamps a dangling ordinal into range instead of keeping it", () => {
		expect(clampFindOrdinal(matches, 7)).toBe(2);
		expect(clampFindOrdinal(matches, -3)).toBe(0);
		expect(clampFindOrdinal([], 1)).toBeNull();
		expect(clampFindOrdinal(matches, null)).toBeNull();
	});
});

describe("findTickPositions", () => {
	it("maps measured offsets to rail fractions and skips unmeasured rows", () => {
		const offsets: Record<number, number | null> = { 2: 100, 5: null, 9: 800 };
		expect(findTickPositions(matches, rowIndex => offsets[rowIndex] ?? null, 1000)).toEqual([
			{ ordinal: 0, fraction: 0.1 },
			{ ordinal: 2, fraction: 0.8 },
		]);
	});

	it("returns zero fractions rather than NaN before the transcript is measured", () => {
		expect(findTickPositions(matches, () => 0, 0)).toEqual([
			{ ordinal: 0, fraction: 0 },
			{ ordinal: 1, fraction: 0 },
			{ ordinal: 2, fraction: 0 },
		]);
	});
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run src/renderer/components/chat/transcript-find.test.ts`

Expected: FAIL with `seedFindOrdinal is not a function`.

- [ ] **Step 3: Implement the navigation helpers**

Add to `transcript-find.ts`:

```ts
export function seedFindOrdinal(matches: readonly TranscriptMatch[], visibleEndRowIndex: number): FindStep | null {
	if (matches.length === 0) return null;
	for (let ordinal = matches.length - 1; ordinal >= 0; ordinal--) {
		if ((matches[ordinal]?.rowIndex ?? 0) <= visibleEndRowIndex) return { ordinal, wrapped: false };
	}
	// Everything on screen is older than the oldest match: wrap once to the newest.
	return { ordinal: matches.length - 1, wrapped: true };
}

export function stepFindOrdinal(
	matches: readonly TranscriptMatch[],
	current: number | null,
	direction: FindDirection,
): FindStep | null {
	if (matches.length === 0) return null;
	if (current == null) return { ordinal: direction === "older" ? matches.length - 1 : 0, wrapped: false };
	const next = direction === "older" ? current - 1 : current + 1;
	if (next < 0) return { ordinal: matches.length - 1, wrapped: true };
	if (next >= matches.length) return { ordinal: 0, wrapped: true };
	return { ordinal: next, wrapped: false };
}
```

`clampFindOrdinal` and `findTickPositions` follow the semantics listed above; `findTickPositions` uses a local `clamp01`.

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `npx vitest run src/renderer/components/chat/transcript-find.test.ts`

Expected: PASS — Tasks 1–3.

- [ ] **Step 5: Typecheck the pure module**

Run: `npx tsc --noEmit`

Expected: exit 0.

---

### Task 4: Highlight painting, theme tokens, and `::highlight` styles

**Files:**
- Create: `src/renderer/components/chat/transcript-find-highlight.ts`
- Create: `src/renderer/components/chat/transcript-find-highlight.test.ts`
- Modify: `src/renderer/styles/theme-light.css`
- Modify: `src/renderer/styles/theme-dark.css`
- Modify: `src/renderer/styles/global.css`

**Interfaces:**
- Consumes `normalizeFindText` from Task 1.
- Produces:

```ts
export const FIND_HIGHLIGHT = "omp-find";
export const FIND_CURRENT_HIGHLIGHT = "omp-find-current";

/** True when this renderer implements the CSS Custom Highlight API. */
export function supportsFindHighlight(): boolean;

/** One mounted row and which of its occurrences to paint. */
export interface FindHighlightTarget {
	rowElement: Element;
	/** Occurrence indices within the row (ascending) that this needle produced. */
	occurrences: readonly number[];
	/** The occurrence index that is the current match, or null. */
	currentOccurrence: number | null;
}

/**
 * Flatten a subtree's text nodes into one whitespace-normalized lowercase
 * string plus a per-character (node, offset) source map — the same
 * normalization `normalizeFindText` applies, so model offsets and DOM offsets
 * agree.
 */
export function flattenTextNodes(root: Node): { text: string; nodes: Text[]; offsets: number[] };

/** Replace both named highlights with ranges for the given targets. No-op without CSS.highlights. */
export function paintFindHighlights(targets: readonly FindHighlightTarget[], needle: string): void;

/** Remove both named highlights. Safe to call unconditionally. */
export function clearFindHighlights(): void;
```

`supportsFindHighlight()` is `typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function"`, wrapped in a `try/catch` returning `false`. Because TypeScript 7's DOM lib may not declare `Highlight`/`CSS.highlights`, declare a **local** structural view rather than an ambient global:

```ts
interface HighlightRegistryLike {
	set: (name: string, highlight: object) => void;
	delete: (name: string) => void;
}
type HighlightCtor = new (...ranges: Range[]) => object;

function highlightApi(): { registry: HighlightRegistryLike; Highlight: HighlightCtor } | null {
	try {
		const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
		const ctor = (globalThis as { Highlight?: HighlightCtor }).Highlight;
		if (!css?.highlights || typeof ctor !== "function") return null;
		return { registry: css.highlights, Highlight: ctor };
	} catch {
		return null;
	}
}
```

`flattenTextNodes` walks `root.childNodes` recursively (no `TreeWalker` — linkedom's is unreliable). For each `Text` node it appends the node's `data` lowercased with whitespace runs collapsed to one space, recording `nodes[i]`/`offsets[i]` for every emitted character; a whitespace run emits one space mapped to the run's first character. Leading whitespace of the whole flattened string is dropped so the result equals `normalizeFindText` of the concatenation.

`paintFindHighlights` builds `Range`s per target by finding non-overlapping occurrences of `needle` in the flattened text and selecting only the indices listed in `target.occurrences`; the current occurrence goes into the `omp-find-current` highlight, the rest into `omp-find`. Ranges are built with `document.createRange()` and `setStart(nodes[s], offsets[s])` / `setEnd(nodes[e - 1], offsets[e - 1] + 1)`.

- [ ] **Step 1: Write the failing highlight tests**

Create `src/renderer/components/chat/transcript-find-highlight.test.ts`:

```ts
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearFindHighlights,
	FIND_CURRENT_HIGHLIGHT,
	FIND_HIGHLIGHT,
	flattenTextNodes,
	paintFindHighlights,
	supportsFindHighlight,
} from "./transcript-find-highlight";

const { document } = parseHTML("<html><body></body></html>");

interface FakeRange {
	startContainer: unknown;
	startOffset: number;
	endContainer: unknown;
	endOffset: number;
	setStart: (node: unknown, offset: number) => void;
	setEnd: (node: unknown, offset: number) => void;
}

const registry = new Map<string, FakeRange[]>();

function installHighlightApi(): void {
	(document as unknown as { createRange: () => FakeRange }).createRange = () => {
		const range: FakeRange = {
			startContainer: null,
			startOffset: 0,
			endContainer: null,
			endOffset: 0,
			setStart(node, offset) {
				range.startContainer = node;
				range.startOffset = offset;
			},
			setEnd(node, offset) {
				range.endContainer = node;
				range.endOffset = offset;
			},
		};
		return range;
	};
	Object.assign(globalThis as Record<string, unknown>, {
		document,
		Highlight: class {
			ranges: FakeRange[];
			constructor(...ranges: FakeRange[]) {
				this.ranges = ranges;
			}
		},
		CSS: {
			highlights: {
				set: (name: string, highlight: { ranges: FakeRange[] }) => registry.set(name, highlight.ranges),
				delete: (name: string) => registry.delete(name),
			},
		},
	});
}

beforeEach(() => {
	registry.clear();
	installHighlightApi();
});

afterEach(() => {
	Reflect.deleteProperty(globalThis as Record<string, unknown>, "CSS");
	Reflect.deleteProperty(globalThis as Record<string, unknown>, "Highlight");
});

function row(html: string): Element {
	const el = document.createElement("div");
	el.innerHTML = html;
	return el as unknown as Element;
}

describe("flattenTextNodes", () => {
	it("joins nested text nodes with the same normalization the index uses", () => {
		const flat = flattenTextNodes(row("<p>The  <strong>NEEDLE</strong>\n is here</p>") as unknown as Node);
		expect(flat.text).toBe("the needle is here");
		expect(flat.nodes).toHaveLength(flat.text.length);
		expect(flat.offsets).toHaveLength(flat.text.length);
	});
});

describe("paintFindHighlights", () => {
	it("registers non-current occurrences under omp-find and the current one under omp-find-current", () => {
		const element = row("<p>needle one needle two</p>");
		paintFindHighlights([{ rowElement: element, occurrences: [0, 1], currentOccurrence: 1 }], "needle");
		expect(registry.get(FIND_HIGHLIGHT)).toHaveLength(1);
		expect(registry.get(FIND_CURRENT_HIGHLIGHT)).toHaveLength(1);
		expect(registry.get(FIND_CURRENT_HIGHLIGHT)?.[0]?.startOffset).toBe(11);
	});

	it("spans element boundaries", () => {
		const element = row("<p>a nee<em>dle</em> b</p>");
		paintFindHighlights([{ rowElement: element, occurrences: [0], currentOccurrence: null }], "needle");
		const range = registry.get(FIND_HIGHLIGHT)?.[0];
		expect(range?.startContainer).not.toBe(range?.endContainer);
	});

	it("clears both highlights", () => {
		paintFindHighlights([{ rowElement: row("<p>needle</p>"), occurrences: [0], currentOccurrence: 0 }], "needle");
		clearFindHighlights();
		expect(registry.size).toBe(0);
	});

	it("degrades to a no-op without CSS.highlights instead of throwing", () => {
		Reflect.deleteProperty(globalThis as Record<string, unknown>, "CSS");
		expect(supportsFindHighlight()).toBe(false);
		expect(() =>
			paintFindHighlights([{ rowElement: row("<p>needle</p>"), occurrences: [0], currentOccurrence: 0 }], "needle"),
		).not.toThrow();
		expect(() => clearFindHighlights()).not.toThrow();
	});
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npx vitest run src/renderer/components/chat/transcript-find-highlight.test.ts`

Expected: FAIL — `Failed to resolve import "./transcript-find-highlight"`.

- [ ] **Step 3: Implement the highlight module**

Create `src/renderer/components/chat/transcript-find-highlight.ts` with the API above. `paintFindHighlights` shape:

```ts
export function paintFindHighlights(targets: readonly FindHighlightTarget[], needle: string): void {
	const api = highlightApi();
	if (!api || !needle) return;
	const plain: Range[] = [];
	const current: Range[] = [];
	for (const target of targets) {
		const flat = flattenTextNodes(target.rowElement);
		const wanted = new Set(target.occurrences);
		let occurrence = 0;
		let at = flat.text.indexOf(needle);
		while (at !== -1) {
			if (wanted.has(occurrence)) {
				const range = rangeFor(flat, at, at + needle.length);
				if (range) (occurrence === target.currentOccurrence ? current : plain).push(range);
			}
			occurrence++;
			at = flat.text.indexOf(needle, at + needle.length);
		}
	}
	api.registry.set(FIND_HIGHLIGHT, new api.Highlight(...plain));
	api.registry.set(FIND_CURRENT_HIGHLIGHT, new api.Highlight(...current));
}
```

`clearFindHighlights` deletes both names through `highlightApi()`, guarded by the same null check.

- [ ] **Step 4: Add the theme tokens**

In `src/renderer/styles/theme-light.css`, immediately after the `--omp-transcript-code-bg` line in the "Editorial transcript" block:

```css
	--omp-find-match: rgba(214, 152, 42, 0.22);
	--omp-find-current: #e0a33a;
	--omp-find-current-text: #1a1d29;
```

In `src/renderer/styles/theme-dark.css`, in the matching position of its "Editorial transcript" block:

```css
	--omp-find-match: rgba(224, 163, 58, 0.26);
	--omp-find-current: #d1912b;
	--omp-find-current-text: #0f1220;
```

Amber, per the spec: periwinkle already means "selected", green/red already mean tool success/failure.

- [ ] **Step 5: Add the `::highlight` rules**

In `src/renderer/styles/global.css`, directly after the existing `::selection` rule (around line 131):

```css
/* Transcript find (chat/transcript-find-highlight.ts registers the ranges). */
::highlight(omp-find) {
	background-color: var(--omp-find-match);
}

::highlight(omp-find-current) {
	background-color: var(--omp-find-current);
	color: var(--omp-find-current-text);
}
```

- [ ] **Step 6: Run the test and confirm GREEN**

Run: `npx vitest run src/renderer/components/chat/transcript-find-highlight.test.ts`

Expected: PASS — all five tests, including the no-`CSS.highlights` degradation case.

---

### Task 5: Find bar, tick rail, and locale strings

**Files:**
- Create: `src/renderer/components/chat/TranscriptFindBar.tsx`
- Create: `src/renderer/components/chat/TranscriptFindBar.test.tsx`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`

**Interfaces:**
- Consumes `FindTick` from Task 3, `useT` from `../../lib/i18n`, `cx` from `../../lib/format`, `ChevronUp`/`ChevronDown`/`X` from `lucide-react`.
- Produces:

```ts
export interface TranscriptFindBarProps {
	query: string;
	onQueryChange: (query: string) => void;
	/** Total matches in document order. */
	total: number;
	/** 0-based current ordinal, or null when nothing is selected. */
	current: number | null;
	/** True for one navigation step after a wrap. */
	wrapped: boolean;
	onOlder: () => void;
	onNewer: () => void;
	onClose: () => void;
	inputRef: RefObject<HTMLInputElement | null>;
}

export function TranscriptFindBar(props: TranscriptFindBarProps): ReactElement;

export interface TranscriptFindTicksProps {
	ticks: readonly FindTick[];
	currentOrdinal: number | null;
}

export function TranscriptFindTicks(props: TranscriptFindTicksProps): ReactElement | null;
```

Contents, left to right (spec §Find bar): the query input; the match counter with its wrap indicator; a 1px `bg-[var(--omp-border)]` separator (`aria-hidden`, `h-4 w-px`); the older button; the newer button; the close button.

Behavior the bar owns (nothing else):
- `role="search"` region, `aria-label={t("chat.find.label")}`, `data-transcript-find` on the root.
- The input is labelled by `aria-label={t("chat.find.placeholder")}` and carries `data-find-input`.
- <kbd>↵</kbd> → `onOlder()`, <kbd>⇧↵</kbd> → `onNewer()`, <kbd>Esc</kbd> → `onClose()`. All three call `event.preventDefault()` — Escape's `preventDefault` is what stops `App.tsx` aborting the running turn.
- The visible counter renders **numerals only** in JSX (`{current + 1} / {total}`, or `0 / 0`) with `tabular-nums`; it is never a locale format string. An empty query renders no counter at all.
- A non-empty query with zero matches puts `aria-invalid="true"` and the `--omp-error` border on the input and renders `0 / 0`.
- The wrap indicator renders `t("chat.find.wrapIndicator")` beside the counter while `wrapped` is true.
- A visually hidden `role="status" aria-live="polite" aria-atomic="true"` span carries `chat.find.statusNone`, `chat.find.status`, or `chat.find.statusWrapped`.
- Buttons are direction-explicit: older uses `ChevronUp` with `aria-label={t("chat.find.older")}`, newer uses `ChevronDown` with `aria-label={t("chat.find.newer")}`. Both are disabled when `total === 0`.
- `TranscriptFindTicks` returns `null` for an empty list; otherwise an `aria-hidden` absolutely-positioned column of 2px marks at `top: ${fraction * 100}%`, the current ordinal's mark widened and painted `--omp-find-current`.

- [ ] **Step 1: Add the locale strings**

In `src/renderer/locales/en.ts`, beside the existing `chat.navigator.*` keys:

```ts
	"chat.find.label": "Find in transcript",
	"chat.find.placeholder": "Find",
	"chat.find.older": "Older match",
	"chat.find.newer": "Newer match",
	"chat.find.close": "Close find",
	"chat.find.wrapIndicator": "wrapped",
	"chat.find.status": "Match {current} of {total}",
	"chat.find.statusWrapped": "Match {current} of {total}, wrapped",
	"chat.find.statusNone": "No matches",
```

In `src/renderer/locales/zh.ts`, at the matching position:

```ts
	"chat.find.label": "在对话记录中查找",
	"chat.find.placeholder": "查找",
	"chat.find.older": "更早的匹配",
	"chat.find.newer": "更新的匹配",
	"chat.find.close": "关闭查找",
	"chat.find.wrapIndicator": "已回绕",
	"chat.find.status": "第 {current} 个匹配，共 {total} 个",
	"chat.find.statusWrapped": "第 {current} 个匹配，共 {total} 个，已回绕",
	"chat.find.statusNone": "没有匹配项",
```

- [ ] **Step 2: Write the failing bar tests**

Create `src/renderer/components/chat/TranscriptFindBar.test.tsx`, reusing the linkedom mounting pattern from `src/renderer/components/tools/ToolCard.test.tsx` (install `document`, `window`, `Event`, `HTMLElement`, `Element`, `Node`, `IS_REACT_ACT_ENVIRONMENT` onto `globalThis` in `beforeAll`, restore in `afterAll`, mount through `createRoot` inside `act` wrapped in `<I18nProvider>`):

```tsx
it("renders the counter in document order with tabular figures", async () => {
	await mount(<TranscriptFindBar {...baseProps} query="needle" total={17} current={2} />);
	expect(container.querySelector("[data-find-counter]")?.textContent).toBe("3 / 17");
});

it("renders no counter and no error for an empty query", async () => {
	await mount(<TranscriptFindBar {...baseProps} query="" total={0} current={null} />);
	expect(container.querySelector("[data-find-counter]")).toBeNull();
	expect(container.querySelector("[data-find-input]")?.getAttribute("aria-invalid")).toBeNull();
});

it("marks the input invalid and reads 0 / 0 when a real query has no matches", async () => {
	await mount(<TranscriptFindBar {...baseProps} query="zzz" total={0} current={null} />);
	expect(container.querySelector("[data-find-counter]")?.textContent).toBe("0 / 0");
	expect(container.querySelector("[data-find-input]")?.getAttribute("aria-invalid")).toBe("true");
	expect(container.querySelector("[role='status']")?.textContent).toBe("No matches");
});

it("announces the wrap for one step", async () => {
	await mount(<TranscriptFindBar {...baseProps} query="needle" total={3} current={2} wrapped />);
	expect(container.querySelector("[role='status']")?.textContent).toBe("Match 3 of 3, wrapped");
	expect(container.textContent).toContain("wrapped");
});

it("labels the buttons by travel direction, not by previous/next", async () => {
	await mount(<TranscriptFindBar {...baseProps} query="needle" total={3} current={0} />);
	const labels = [...container.querySelectorAll("button")].map(b => b.getAttribute("aria-label"));
	expect(labels).toEqual(["Older match", "Newer match", "Close find"]);
});

it("routes Enter to older, Shift+Enter to newer, and Escape to close, preventing default each time", async () => {
	const onOlder = vi.fn();
	const onNewer = vi.fn();
	const onClose = vi.fn();
	await mount(<TranscriptFindBar {...baseProps} query="needle" total={3} current={0} {...{ onOlder, onNewer, onClose }} />);
	const input = container.querySelector("[data-find-input]");
	const fire = (init: { key: string; shiftKey?: boolean }) => {
		const event = new window.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
		input?.dispatchEvent(event);
		return event;
	};
	expect(fire({ key: "Enter" }).defaultPrevented).toBe(true);
	expect(onOlder).toHaveBeenCalledTimes(1);
	fire({ key: "Enter", shiftKey: true });
	expect(onNewer).toHaveBeenCalledTimes(1);
	expect(fire({ key: "Escape" }).defaultPrevented).toBe(true);
	expect(onClose).toHaveBeenCalledTimes(1);
});

it("renders one tick per match and emphasizes the current one", async () => {
	await mount(
		<TranscriptFindTicks ticks={[{ ordinal: 0, fraction: 0.1 }, { ordinal: 1, fraction: 0.8 }]} currentOrdinal={1} />,
	);
	const ticks = [...container.querySelectorAll("[data-find-tick]")];
	expect(ticks).toHaveLength(2);
	expect(ticks[1]?.getAttribute("data-find-tick-current")).toBe("true");
});
```

If linkedom's `KeyboardEvent` is unavailable, construct the event with `new window.CustomEvent(...)` plus assigned `key`/`shiftKey` properties — the same escape hatch the existing chat tests use for synthetic events.

- [ ] **Step 3: Run the tests and confirm RED**

Run: `npx vitest run src/renderer/components/chat/TranscriptFindBar.test.tsx src/renderer/locales/locales.test.ts`

Expected: the bar tests FAIL on the missing module; `locales.test.ts` PASSES (proving the new keys are parity-clean and genuinely translated).

- [ ] **Step 4: Implement the bar and the ticks**

Create `src/renderer/components/chat/TranscriptFindBar.tsx`. The root is `absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-xl border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-2 py-1.5 shadow-[var(--omp-shadow-md)]` — a floating overlay, so it never reflows the transcript and `lint-surfaces` permits `bg-elevated`. Keep every font size on the `text-omp-*` scale (`text-omp-md` for the input, `text-omp-sm` for the counter); never `text-[Npx]`.

- [ ] **Step 5: Run the tests and confirm GREEN**

Run: `npx vitest run src/renderer/components/chat/TranscriptFindBar.test.tsx src/renderer/locales/locales.test.ts`

Expected: PASS.

- [ ] **Step 6: Run the surface lint**

Run: `node scripts/lint-surfaces.mjs`

Expected: exit 0 with no violation naming `TranscriptFindBar.tsx`.

---

### Task 6: `useTranscriptFind` hook

**Files:**
- Create: `src/renderer/components/chat/useTranscriptFind.ts`
- Create: `src/renderer/components/chat/useTranscriptFind.test.tsx`

**Interfaces:**
- Consumes everything from Tasks 1–4, plus `scopedDisclosureKey` / `useDisclosureScope` / `useUiStore` from `../../stores/ui`.
- Produces:

```ts
export const TRANSCRIPT_FIND_EVENT = "omp:transcript-find";

export type TranscriptFindAction = "open" | "next" | "previous";

/**
 * Routing detail for the window event App.tsx dispatches. Round one: the
 * viewport containing document.activeElement claims it. If nothing claimed,
 * App re-dispatches with `fallback: true` and the main-mode viewport claims.
 */
export interface TranscriptFindEventDetail {
	action: TranscriptFindAction;
	fallback: boolean;
	claimed: boolean;
}

/** Structural view of the virtualizer — lets tests pass a stub. */
export interface TranscriptFindVirtualizer {
	scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void;
	scrollToOffset: (offset: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void;
	getOffsetForIndex: (index: number, align?: "start" | "center" | "end" | "auto") => readonly [number, string] | undefined;
	getTotalSize: () => number;
	range: { startIndex: number; endIndex: number } | null;
}

export interface TranscriptFindHost {
	transcriptId: string;
	isMain: boolean;
	rows: readonly Row[];
	rowKeys: readonly string[];
	context: TranscriptFindContext;
	/** The viewport root, for focus containment and mounted-row lookup. */
	rootRef: RefObject<HTMLDivElement | null>;
	/** The scroll container, for save/restore of scrollTop. */
	scrollRef: RefObject<HTMLDivElement | null>;
	virtualizer: TranscriptFindVirtualizer;
	pinned: boolean;
	setPinned: (pinned: boolean) => void;
	/** Mirrors jumpToConversation: clears userScrollIntentRef so a programmatic scroll never unpins. */
	clearUserScrollIntent: () => void;
}

export interface TranscriptFindState {
	open: boolean;
	query: string;
	setQuery: (query: string) => void;
	total: number;
	current: number | null;
	wrapped: boolean;
	ticks: readonly FindTick[];
	matches: readonly TranscriptMatch[];
	goOlder: () => void;
	goNewer: () => void;
	close: () => void;
	inputRef: RefObject<HTMLInputElement | null>;
}

export function useTranscriptFind(host: TranscriptFindHost): TranscriptFindState;
```

Responsibilities, in order:

1. **State:** `open`, `query` (persists after close, for the tab's lifetime), `current` ordinal, `wrapped`, and a `savedViewRef` holding `{ scrollTop, pinned }` captured at open.
2. **Index:** `useMemo(() => buildTranscriptFindIndex({ rows, rowKeys, query, context, previous: indexRef.current }), [query, rowKeys, rows, context])` with the result stored back into `indexRef` — memoized on `[query, rowKeys]` per the spec, and the `previous` handoff is what keeps appends O(new rows).
3. **Clamp:** after each rebuild, `setCurrent(c => clampFindOrdinal(index.matches, c))` so a compaction or session switch never leaves a dangling ordinal.
4. **Event routing:** one `window` listener for `TRANSCRIPT_FIND_EVENT`. Claim rule, exactly:
   - if `detail.claimed` → return;
   - if `!detail.fallback` → claim only when `host.rootRef.current?.contains(document.activeElement)`;
   - if `detail.fallback` → claim only when `host.isMain`;
   - on claim set `detail.claimed = true` and run the action.
5. **Actions:** `open` → capture `savedViewRef`, seed the query from `window.getSelection()?.toString()` when that selection is non-empty and inside `rootRef`, set `open`, then focus and `select()` the input on the next frame (opening while already open re-selects instead of clearing). `next` → `goOlder()`. `previous` → `goNewer()`.
6. **Seeding on query change:** when the query changes and `open`, apply `seedFindOrdinal(matches, virtualizer.range?.endIndex ?? rows.length - 1)`.
7. **Navigate:** `goOlder`/`goNewer` call `stepFindOrdinal`, store `{ ordinal, wrapped }`, then reveal + scroll.
8. **Reveal + scroll:** for the landed match, when `disclosureKey` is non-null call `useUiStore.getState().setDisclosureOpen(scopedDisclosureKey(scope, disclosureKey), true)` where `scope = useDisclosureScope()`; then `host.clearUserScrollIntent(); host.setPinned(false); host.virtualizer.scrollToIndex(match.rowIndex, { align: "center" })` — `center`, not `jumpToConversation`'s `start`, so a match near a row's end is not parked under the bar.
9. **Close:** clear `open` and `wrapped`, `clearFindHighlights()`, restore `savedViewRef` (`scrollRef.current.scrollTop = saved.scrollTop` via `virtualizer.scrollToOffset(saved.scrollTop)` then `setPinned(saved.pinned)`), and keep `query`.
10. **Transcript switch:** `useEffect(..., [host.transcriptId])` closes find, clears the query, resets `current`, and clears highlights — matching how the viewport already resets `pinned` and the size cache.
11. **Repaint:** an effect keyed on `[matches, current, open]` collects mounted rows via `rootRef.current.querySelectorAll("[data-index]")`, maps each `data-index` to its `rowIndex`, groups the matches for that row into `FindHighlightTarget`s (with `currentOccurrence` set only on the current match's row), and calls `paintFindHighlights(targets, index.needle)`. Returns `clearFindHighlights` when find closes.
12. **Ticks:** `findTickPositions(matches, rowIndex => virtualizer.getOffsetForIndex(rowIndex, "start")?.[0] ?? null, virtualizer.getTotalSize())`.

- [ ] **Step 1: Write the failing hook tests**

Create `src/renderer/components/chat/useTranscriptFind.test.tsx` with the linkedom globals pattern and a tiny probe component that renders the hook's state into `data-*` attributes and exposes the last-returned state through a module-level ref:

```tsx
function Probe({ host, onState }: { host: TranscriptFindHost; onState: (s: TranscriptFindState) => void }) {
	const state = useTranscriptFind(host);
	onState(state);
	return <div data-open={String(state.open)} data-total={state.total} data-current={String(state.current)} />;
}
```

with a stub virtualizer:

```ts
const scrolls: Array<{ index: number; align?: string }> = [];
const virtualizer: TranscriptFindVirtualizer = {
	scrollToIndex: (index, options) => scrolls.push({ index, align: options?.align }),
	scrollToOffset: offset => offsets.push(offset),
	getOffsetForIndex: index => [index * 100, "start"] as const,
	getTotalSize: () => 1000,
	range: { startIndex: 0, endIndex: 4 },
};
```

and these helpers, so no assertion depends on an undefined function:

```tsx
let state!: TranscriptFindState;

function dispatchFind(action: TranscriptFindAction, options: { fallback?: boolean } = {}) {
	const detail: TranscriptFindEventDetail = { action, fallback: options.fallback ?? false, claimed: false };
	act(() => {
		window.dispatchEvent(new CustomEvent(TRANSCRIPT_FIND_EVENT, { detail }));
	});
	return detail;
}

/** linkedom has no real focus model — drive activeElement directly. */
function focusInside(root: { contains: (node: unknown) => boolean }): void {
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => focusTarget });
	focusTarget = root;
}

function blurEverything(): void {
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => null });
}

function stubSelection(text: string): void {
	(window as unknown as { getSelection: () => { toString: () => string } }).getSelection = () => ({
		toString: () => text,
	});
}

/** Re-render the probe with new host fields; React keeps the hook state. */
async function rerenderHost(patch: Partial<TranscriptFindHost>): Promise<void> {
	await act(async () => {
		root?.render(<I18nProvider><Probe host={{ ...host, ...patch }} onState={s => (state = s)} /></I18nProvider>);
	});
}

const rerenderWithRows = (rows: Row[]) => rerenderHost({ rows, rowKeys: rows.map((_, i) => `r${i}`) });
const rerenderWithTranscriptId = (transcriptId: string) => rerenderHost({ transcriptId });
```

Assertions:

```tsx
it("opens on the routed event, seeds backwards from the viewport's bottom edge, and scrolls centered", async () => {
	// rows 0..9, matches at rowIndex 2 and 8; range.endIndex = 4.
	dispatchFind("open");
	expect(state.open).toBe(true);
	expect(state.current).toBe(0);
	expect(scrolls.at(-1)).toEqual({ index: 2, align: "center" });
});

it("claims the event only for the viewport containing focus, and falls back to the main viewport", async () => {
	// Two probes mounted: a focused subagent host and an unfocused main host.
	const detail = dispatchFind("open");
	expect(detail.claimed).toBe(true);
	expect(subagentState.open).toBe(true);
	expect(mainState.open).toBe(false);
	// Nothing focused: round one claims nothing, the fallback round goes to main.
	blurEverything();
	const first = dispatchFind("open");
	expect(first.claimed).toBe(false);
	const second = dispatchFind("open", { fallback: true });
	expect(second.claimed).toBe(true);
	expect(mainState.open).toBe(true);
});

it("opens the disclosure that hides the landed match", async () => {
	// One match inside a collapsed thinking block.
	dispatchFind("open");
	const key = scopedDisclosureKey(useTabsStore.getState().activeTabId, thinkingKey);
	expect(useUiStore.getState().disclosureOpen[key]).toBe(true);
});

it("sets pinned false and clears scroll intent on navigation, exactly like jumpToConversation", async () => {
	dispatchFind("open");
	expect(setPinned).toHaveBeenLastCalledWith(false);
	expect(clearUserScrollIntent).toHaveBeenCalled();
});

it("wraps once at the top and reports it for one step", async () => {
	dispatchFind("open");
	act(() => state.goOlder()); // ordinal 0 -> wrap
	expect(state.wrapped).toBe(true);
	act(() => state.goOlder());
	expect(state.wrapped).toBe(false);
});

it("restores the pre-find scroll offset and pinned state on close", async () => {
	// scrollRef.current.scrollTop = 640; pinned = true at open.
	dispatchFind("open");
	act(() => state.close());
	expect(offsets.at(-1)).toBe(640);
	expect(setPinned).toHaveBeenLastCalledWith(true);
	expect(state.query).toBe("needle"); // query survives close
});

it("closes and clears the query when the transcript id changes", async () => {
	dispatchFind("open");
	await rerenderWithTranscriptId("other-transcript");
	expect(state.open).toBe(false);
	expect(state.query).toBe("");
});

it("clamps a dangling ordinal when rows are removed rather than keeping it", async () => {
	dispatchFind("open");
	act(() => state.goNewer()); // land on the last match
	await rerenderWithRows(rowsWithLastMatchRemoved);
	expect(state.current).toBe(state.total - 1);
});

it("seeds the query from a non-empty transcript selection", async () => {
	stubSelection("Projected finalized");
	dispatchFind("open");
	expect(state.query).toBe("Projected finalized");
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npx vitest run src/renderer/components/chat/useTranscriptFind.test.tsx`

Expected: FAIL — `Failed to resolve import "./useTranscriptFind"`.

- [ ] **Step 3: Implement the hook**

Create `src/renderer/components/chat/useTranscriptFind.ts` implementing responsibilities 1–12 above. Two details that are easy to get wrong:

- The window listener must be registered once with a stable handler that reads live state through refs — re-registering on every keystroke would let a stale closure claim the event with an old query.
- The repaint effect must run **after** the scroll and after any disclosure reveal commits, so schedule it with `requestAnimationFrame` and cancel on cleanup, exactly as the viewport's existing pinned-follow effect does.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: `npx vitest run src/renderer/components/chat/useTranscriptFind.test.tsx`

Expected: PASS — all nine tests.

---

### Task 7: Wire find into `TranscriptViewport`

**Files:**
- Modify: `src/renderer/components/chat/TranscriptViewport.tsx`
- Modify: `src/renderer/components/chat/TranscriptViewport.test.tsx`

**Interfaces:**
- Consumes `useTranscriptFind`, `TranscriptFindHost` (Task 6), `TranscriptFindBar`, `TranscriptFindTicks` (Task 5), `TranscriptFindContext` (Task 1).
- Produces no new exports. The viewport gains: an outer `rootRef` on the existing `omp-transcript-editorial` div, a `clearUserScrollIntent` callback, a memoized `findContext`, the `useTranscriptFind(...)` call, and two rendered children.

Wiring, precisely:

```tsx
const rootRef = useRef<HTMLDivElement>(null);
const clearUserScrollIntent = useCallback(() => {
	userScrollIntentRef.current = false;
}, []);
const findContext = useMemo<TranscriptFindContext>(
	() => ({ resolveToolCall, lookupToolEntry: key => activeTools.get(key) }),
	[resolveToolCall, activeTools],
);
const find = useTranscriptFind({
	transcriptId,
	isMain,
	rows,
	rowKeys,
	context: findContext,
	rootRef,
	scrollRef: parentRef,
	virtualizer,
	pinned,
	setPinned,
	clearUserScrollIntent,
});
```

Render `{find.open ? <TranscriptFindBar … /> : null}` and `{find.open ? <TranscriptFindTicks ticks={find.ticks} currentOrdinal={find.current} /> : null}` as siblings of the jump-to-latest button, inside the `relative` root. **Add nothing else to this file** — no index building, no scroll math, no highlight calls.

- [ ] **Step 1: Write the failing integration tests**

Append to `src/renderer/components/chat/TranscriptViewport.test.tsx` a `describe("TranscriptViewport find")` block. It uses the file's existing `mount` helper and store-reset `afterEach`; add a helper that dispatches the routed event:

```tsx
function dispatchFind(action: "open" | "next" | "previous", fallback = false) {
	const detail = { action, fallback, claimed: false };
	act(() => {
		window.dispatchEvent(new CustomEvent("omp:transcript-find", { detail }));
	});
	return detail;
}
```

Assertions:

```tsx
/** Drive a React-controlled input the way the existing composer tests do. */
async function typeInto(input: TestElement | null, text: string): Promise<void> {
	await act(async () => {
		(input as unknown as { value: string }).value = text;
		(input as unknown as { dispatchEvent: (e: unknown) => void }).dispatchEvent(
			new Event("input", { bubbles: true }),
		);
	});
}

it("opens the find bar and reports a match whose row is not mounted", async () => {
	// 60 message rows; the needle lives only in row 3, far above the mounted window
	// (the virtualizer's overscan is 8, so row 3 has no DOM node at open time).
	await mount(<TranscriptViewport mode="main" projection={projection} main={augments} />);
	expect(container?.querySelector('[data-index="3"]')).toBeNull();
	dispatchFind("open", true);
	const input = container?.querySelector("[data-find-input]");
	expect(input).not.toBeNull();
	await typeInto(input, "needle");
	expect(container?.querySelector("[data-find-counter]")?.textContent).toBe("1 / 1");
});

it("counts matches inside a collapsed thinking block and opens that disclosure on landing", async () => {
	// Assistant message with a collapsed thinking block containing the needle.
	await mount(…);
	dispatchFind("open", true);
	await typeInto(input, "hidden needle");
	expect(container?.querySelector("[data-find-counter]")?.textContent).toBe("1 / 1");
	const key = scopedDisclosureKey(useTabsStore.getState().activeTabId, thinkingDisclosureKey(message, 0));
	expect(useUiStore.getState().disclosureOpen[key]).toBe(true);
});

it("keeps the match count stable when the user expands a tool card", async () => {
	dispatchFind("open", true);
	await typeInto(input, "needle");
	const before = container?.querySelector("[data-find-counter]")?.textContent;
	act(() => useUiStore.getState().setDisclosureOpen(toolKey, true));
	expect(container?.querySelector("[data-find-counter]")?.textContent).toBe(before);
});

it("restores pinned state when find closes", async () => {
	dispatchFind("open", true);
	await typeInto(input, "needle");
	expect(container?.querySelector("[aria-label='Jump to latest']")?.className).toContain("opacity-100");
	act(() => container?.querySelector("[aria-label='Close find']")?.click());
	expect(container?.querySelector("[data-find-input]")).toBeNull();
	expect(container?.querySelector("[aria-label='Jump to latest']")?.className).toContain("opacity-0");
});

it("closes and clears find when the transcript id changes", async () => {
	dispatchFind("open", true);
	await typeInto(input, "needle");
	await remountWithTranscriptId("subagent-2");
	expect(container?.querySelector("[data-find-input]")).toBeNull();
	dispatchFind("open", true);
	expect(container?.querySelector("[data-find-input]")?.getAttribute("value")).toBe("");
});

it("renders no find chrome until find is opened", async () => {
	await mount(…);
	expect(container?.querySelector("[data-transcript-find]")).toBeNull();
	expect(container?.querySelector("[data-find-tick]")).toBeNull();
});
```

`typeInto` sets `input.value` and dispatches a bubbling `input` event inside `act`, matching how the existing composer tests drive React-controlled inputs.

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npx vitest run src/renderer/components/chat/TranscriptViewport.test.tsx`

Expected: the new find tests FAIL on a null `[data-find-input]`; every pre-existing test in the file still PASSES.

- [ ] **Step 3: Wire the hook and the bar into the viewport**

Apply the wiring above. Attach `ref={rootRef}` to the existing outer `<div className="omp-transcript-editorial relative min-h-0 flex-1 bg-transparent">`.

- [ ] **Step 4: Run the full chat suite and confirm GREEN**

Run: `npx vitest run src/renderer/components/chat/ src/renderer/components/panels/SubagentTranscript.test.tsx`

Expected: PASS. In particular no regression in the existing pinning, streaming, or conversation-navigator tests.

- [ ] **Step 5: Confirm the viewport did not grow find logic**

Run: `grep -nE "buildTranscriptFindIndex|seedFindOrdinal|paintFindHighlights|CSS\.highlights" src/renderer/components/chat/TranscriptViewport.tsx`

Expected: no output — the viewport imports only `useTranscriptFind`, `TranscriptFindBar`, `TranscriptFindTicks`, and `TranscriptFindContext`.

---

### Task 8: Keymap actions, hotkeys rows, and App dispatch

**Files:**
- Modify: `src/renderer/lib/keymap.ts`
- Modify: `src/renderer/lib/keymap.test.ts`
- Modify: `src/renderer/components/dialogs/HotkeysDialog.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/App.test.tsx`
- Modify: `src/renderer/locales/en.ts`
- Modify: `src/renderer/locales/zh.ts`

**Interfaces:**
- Consumes `TRANSCRIPT_FIND_EVENT` and `TranscriptFindEventDetail` from Task 6.
- Produces three new `KeymapActionId` values: `"transcript.find"`, `"transcript.findNext"`, `"transcript.findPrevious"`.

If `src/renderer/lib/keymap.test.ts` or `src/renderer/App.test.tsx` does not exist, create it; check first with `ls src/renderer/lib/keymap.test.ts src/renderer/App.test.tsx` and mirror the nearest existing test file's setup.

- [ ] **Step 1: Add the hotkey locale strings**

In `src/renderer/locales/en.ts`, beside the other `hotkeys.row.*` keys:

```ts
	"hotkeys.row.find": "Find in transcript",
	"hotkeys.row.findNext": "Find older match",
	"hotkeys.row.findPrevious": "Find newer match",
```

In `src/renderer/locales/zh.ts`:

```ts
	"hotkeys.row.find": "在对话记录中查找",
	"hotkeys.row.findNext": "查找更早的匹配",
	"hotkeys.row.findPrevious": "查找更新的匹配",
```

- [ ] **Step 2: Write the failing keymap and dispatch tests**

In `src/renderer/lib/keymap.test.ts`:

```ts
it("compiles the three transcript find chords to their actions", () => {
	const map = compileKeymap(KEYMAP_ACTIONS, {});
	expect(map.get("⌘F")).toBe("transcript.find");
	expect(map.get("⌃F")).toBe("transcript.find");
	expect(map.get("⌘G")).toBe("transcript.findNext");
	expect(map.get("⇧⌘G")).toBe("transcript.findPrevious");
});

it("keeps the find actions suppressed while an overlay owns the keyboard", () => {
	for (const id of ["transcript.find", "transcript.findNext", "transcript.findPrevious"] as const) {
		expect(KEYMAP_ACTION_BY_ID[id].overlaySafe).toBe(false);
	}
});

it("reports a conflict when a user rebinds another action onto ⌘F", () => {
	const conflicts = detectConflicts(KEYMAP_ACTIONS, { palette: ["⌘F"] });
	expect(conflicts).toContainEqual({ kind: "warning", chord: "⌘F", actionIds: ["palette", "transcript.find"] });
});

it("introduces no duplicate default chords across the action table", () => {
	const seen = new Map<string, string>();
	for (const action of KEYMAP_ACTIONS) {
		for (const raw of action.defaults) {
			const chord = serializeChord(parseChord(raw)!);
			expect(seen.has(chord), `${chord} claimed by ${seen.get(chord)} and ${action.id}`).toBe(false);
			seen.set(chord, action.id);
		}
	}
});
```

In `src/renderer/App.test.tsx`, against `AppGlobalActions`:

```tsx
it("dispatches the routed find event for ⌘F, ⌘G, and ⇧⌘G", async () => {
	const seen: TranscriptFindEventDetail[] = [];
	window.addEventListener("omp:transcript-find", e => seen.push((e as CustomEvent).detail));
	await mount(<AppGlobalActions />);
	pressChord({ code: "KeyF", metaKey: true });
	pressChord({ code: "KeyG", metaKey: true });
	pressChord({ code: "KeyG", metaKey: true, shiftKey: true });
	expect(seen.map(d => [d.action, d.fallback])).toEqual([
		["open", false],
		["open", true],
		["next", false],
		["next", true],
		["previous", false],
		["previous", true],
	]);
});

it("does not dispatch find while an overlay owns the keyboard", async () => {
	useUiStore.setState({ commandPaletteOpen: true });
	pressChord({ code: "KeyF", metaKey: true });
	expect(seen).toHaveLength(0);
});
```

(The doubled entries are the two routing rounds: an unclaimed round one is always followed by the `fallback: true` round. When a viewport claims round one, `detail.claimed` is true and App skips the second dispatch.)

- [ ] **Step 3: Run the tests and confirm RED**

Run: `npx vitest run src/renderer/lib/keymap.test.ts src/renderer/App.test.tsx src/renderer/locales/locales.test.ts`

Expected: the keymap and App tests FAIL (unknown action ids / no event dispatched); `locales.test.ts` PASSES.

- [ ] **Step 4: Add the three keymap actions**

In `src/renderer/lib/keymap.ts`, append to `KEYMAP_ACTIONS` (⌘F, ⌃F, ⌘G are currently unbound, so nothing collides):

```ts
	{ id: "transcript.find", labelKey: "hotkeys.row.find", defaults: ["⌘F", "⌃F"], overlaySafe: false },
	{ id: "transcript.findNext", labelKey: "hotkeys.row.findNext", defaults: ["⌘G"], overlaySafe: false },
	{ id: "transcript.findPrevious", labelKey: "hotkeys.row.findPrevious", defaults: ["⇧⌘G"], overlaySafe: false },
```

- [ ] **Step 5: Add the HotkeysDialog rows**

`HOTKEY_GROUPS` in `src/renderer/components/dialogs/HotkeysDialog.tsx` is an explicit list — a new action does not appear automatically. Add `{ actionId: "transcript.find" }`, `{ actionId: "transcript.findNext" }`, and `{ actionId: "transcript.findPrevious" }` to the group that already carries the transcript/tool rows (the one holding `tools.expand`).

- [ ] **Step 6: Add the App dispatch cases**

Add the import to `src/renderer/App.tsx`:

```ts
import {
	TRANSCRIPT_FIND_EVENT,
	type TranscriptFindEventDetail,
} from "./components/chat/useTranscriptFind";
```

Then, in `dispatchKeymapAction`, add one case covering all three ids. Do **not** touch the Escape branch:

```ts
	case "transcript.find":
	case "transcript.findNext":
	case "transcript.findPrevious": {
		// Find lives in the transcript viewport, which App does not own. Round one
		// goes to whichever mounted viewport contains focus; if none claims it,
		// round two hands it to the main-mode viewport of the active tab.
		const action =
			actionId === "transcript.find" ? "open" : actionId === "transcript.findNext" ? "next" : "previous";
		const detail: TranscriptFindEventDetail = { action, fallback: false, claimed: false };
		window.dispatchEvent(new CustomEvent(TRANSCRIPT_FIND_EVENT, { detail }));
		if (!detail.claimed) {
			window.dispatchEvent(
				new CustomEvent(TRANSCRIPT_FIND_EVENT, { detail: { action, fallback: true, claimed: false } }),
			);
		}
		return;
	}
```

Find is not a Main-mutating action, so do **not** add these ids to `MAIN_MUTATING_KEYMAP_ACTIONS`.

- [ ] **Step 7: Run the tests and confirm GREEN**

Run: `npx vitest run src/renderer/lib/keymap.test.ts src/renderer/App.test.tsx src/renderer/components/dialogs/ src/renderer/locales/locales.test.ts`

Expected: PASS.

---

### Task 9: Full verification and changelog

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`

Expected: exit 0, no skipped find tests.

- [ ] **Step 2: Run the gate**

Run: `npm run check`

Expected: exit 0 from `lint-surfaces`, `biome check .`, and `tsc --noEmit`. If `tsc` rejects `CSS.highlights` or `Highlight`, the fix is inside `transcript-find-highlight.ts`'s local `highlightApi()` narrowing — never a global ambient declaration and never `any`.

- [ ] **Step 3: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`, add an `### Added` entry (create the heading if the section only has `### Fixed`):

```markdown
- **Find in transcript**: ⌘F opens a find bar over the transcript that searches the whole conversation — including text folded inside collapsed thinking blocks, tool results, and todo snapshots that are not currently on screen. ↵ walks matches backwards through history, ⇧↵ forwards, matches are highlighted with ticks on the scroll rail, and wrapping is announced rather than silent.
```

- [ ] **Step 4: Manual verification — the case that rules out every DOM-based approach**

Launch the app (`npm run dev`, or `bun run build` + `electron .`) and confirm, in a transcript long enough that the target row is unmounted at open time:

1. ⌘F opens the bar over the top-right of the transcript without reflowing it.
2. Typing a term present only in old, unmounted history reports the full count and jumps there — the failure mode `webContents.findInPage` would have as a silent `0 / 0`.
3. The landed match is centered, not tucked under the bar.
4. A match inside a collapsed thinking block opens that disclosure; collapsing it again afterwards works, and the counter does not change.
5. Expanding an unrelated tool card does not change the counter.
6. ↵ repeatedly reaches the top of the transcript and wraps once, with the wrap indicator visible for exactly one step; ⇧↵ travels back toward the live edge.
7. ⌘G / ⇧⌘G still navigate after clicking into the transcript body.
8. Esc closes find and does **not** abort a running turn; the pre-find scroll position and pinned state return.
9. The bar works identically in a projected subagent transcript and in the second pane of a split workspace.
10. Rebinding `transcript.find` in the Hotkeys dialog takes effect and reports a conflict when pointed at an already-claimed chord.

Record which of these were actually exercised. Do not claim an unobserved scenario.

---

## Deferred / not in this plan

Both were explicitly deferred by the approved design and are additive on top of it. **Create no tasks for them.**

- **Pre-compaction history in the corpus.** The `expander` row hides everything before the last compaction summary. `extractRowSegments` returns `[]` for `kind: "expander"` (Task 1), by design. The intended future shape is an opt-in secondary count ("214 more in collapsed history"), not automatic inclusion — unfolding thousands of messages from a single ↵ is too blunt.
- **Turn-stepping (⌥↵).** Jumping to the previous *turn* containing a match, reusing `buildConversationAnchors`, would tame a tool result holding dozens of matches. Not required for this version. `buildConversationAnchors` is untouched by this plan.

---

## Open questions

Places where the spec is underspecified or in tension with the code as it actually stands. Each has a provisional resolution baked into the tasks above; flag any that the reviewer wants decided differently before implementation.

1. **There is no scroll rail to hang ticks on.** The spec says "the scroll rail carries a tick per match", but `TranscriptViewport` renders no rail — `ConversationNavigator` is a sidebar list, and `--omp-transcript-rail` is only a dashed-border color token. *Provisional resolution:* Task 5 introduces `TranscriptFindTicks`, a new `aria-hidden` absolutely-positioned overlay column on the transcript's right edge, rendered only while find is open. If a persistent rail is wanted instead, that is a larger surface change and should be its own design.

2. **"Routed to the focused pane" has no existing mechanism.** `dispatchKeymapAction` lives inside a `useEffect` in `AppGlobalActions` and only ever touches global stores. There is no focused-pane concept: `SplitWorkspace` can mount two `TranscriptViewport`s and `SubagentTranscript` mounts a third, and `acceptsActiveTabEvents()` only guards tab routing. *Provisional resolution:* the two-round `omp:transcript-find` window event in Tasks 6 and 8 — round one claimed by the viewport containing `document.activeElement`, round two by the `mode: "main"` viewport. This is invented, not specified.

3. **`jumpToConversation` does not "leave `userScrollIntentRef` alone".** The spec says navigation should mirror `jumpToConversation` and leave `userScrollIntentRef` untouched, but that callback sets `userScrollIntentRef.current = false` before `setPinned(false)`. *Provisional resolution:* mirror the code, not the sentence — clear the intent flag, which is plainly what "as with `jumpToConversation`" intends (a programmatic scroll must not read as a user gesture).

4. **Matches inside a collapsed read group cannot be revealed.** `ReadGroupCard` holds its expansion in a local `useState`, not in the `ui` store's `disclosureOpen` map, so there is no key to set. *Provisional resolution:* `readGroup` segments carry `disclosureKey: null` (Task 1) — they are counted and navigable, the row scrolls into view, but the group does not auto-open. Moving `ReadGroupCard` onto the disclosure store would fix it and is a small, separable change if wanted.

5. **`scopedDisclosureKey(tabId, key)` — the spec names `tabId`, the code uses the disclosure scope.** `useDisclosureScope()` returns `useTabsStore(state => state.activeTabId)`, which is the active tab, not the tab owning a given viewport. For a background pane in a split workspace the two can differ. *Provisional resolution:* Task 6 uses `useDisclosureScope()`, matching every existing consumer (`ToolCard`, `ThinkingBlock`, `TodoSnapshotCard`); find inherits whatever scoping bug that has, rather than inventing a second scoping rule.

6. **"Rendered result text" is approximated by raw result text.** The spec's corpus table says `readGroup` contributes "each grouped entry's ... rendered result text", but renderers (`DiffView`, `CodeBlock`, `BashRenderer`'s trailer stripping) transform the payload before display. *Provisional resolution:* the index uses `resultText(entry.result ?? entry.partialResult)` from `lib/format.ts` — the same unwrapping every renderer starts from. Consequence: a match can exist in raw text that a renderer strips (a Bash trailer notice, for example), so the count can slightly exceed what is visibly highlightable.

7. **`TranscriptMatch.locator` is left as an occurrence index.** The spec says "enough to re-find the text node once mounted" without fixing a shape. *Provisional resolution:* `{ occurrenceInRow: number }`, with the highlight module re-running the same normalized match over the mounted row's flattened text nodes. This is robust to renderers restructuring their span trees, which a byte-offset locator would not be — but it means a row whose collapsed content is absent from the DOM has fewer DOM occurrences than model matches, so the *k*-th model match may paint nothing until its disclosure opens. Tasks 4 and 6 accept that: painting is best-effort, counting is authoritative.

8. **`CSS.highlights` may be absent from TypeScript 7's DOM lib.** The installed `typescript@^7.0.2` ships its libs inside the native binary and could not be inspected for `Highlight` / `HighlightRegistry`. *Provisional resolution:* Task 4 narrows through a local structural interface and a `globalThis` cast, so the module compiles either way. Task 9 Step 2 is where this actually gets confirmed.
