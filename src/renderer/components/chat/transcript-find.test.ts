import { describe, expect, it } from "vitest";
import type { AgentMessage, ToolCallContent } from "../../../shared/rpc-types";
import type { ToolEntry } from "../../stores/tools";
import type { Row } from "./chat-stream-utils";
import {
	buildTranscriptFindIndex,
	clampFindOrdinal,
	EMPTY_FIND_INDEX,
	extractRowSegments,
	findTickPositions,
	normalizeFindText,
	seedFindOrdinal,
	stepFindOrdinal,
	type TranscriptFindContext,
	type TranscriptFindIndex,
} from "./transcript-find";

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
			extractRowSegments(
				{ kind: "streaming", message: assistant([{ type: "text", text: "Live tail" }]) },
				"s",
				context,
			),
		).toEqual([{ text: "Live tail", disclosureKey: null }]);
		expect(
			extractRowSegments(
				{
					kind: "queued",
					item: { id: "q1", text: "Queued prompt", editable: true, timestamp: 1 },
					lane: "steering",
				},
				"queued-q1",
				context,
			),
		).toEqual([{ text: "Queued prompt", disclosureKey: null }]);
		expect(extractRowSegments({ kind: "expander", count: 214 }, "pre-compaction-expander", context)).toEqual([]);
		expect(extractRowSegments({ kind: "pending" }, "pending", context)).toEqual([]);
	});
});

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
		// grepCall's arguments ({ pattern: "needle", ... }) and grepEntry's result text both
		// contain "needle" literally, in addition to the thinking block, so this row yields
		// three matches: the thinking block plus both tool-disclosure segments.
		expect(index.matches).toHaveLength(3);
		expect(index.matches[0]?.disclosureKey).toMatch(/:thinking:0$/);
		expect(index.matches[1]?.disclosureKey).toBe("tool:call-1");
		expect(index.matches[2]?.disclosureKey).toBe("tool:call-1");
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
		const grouped: Row = {
			kind: "readGroup",
			entries: [{ callId: "c", toolKey: "call-1", path: "needle.ts", args: {} }],
		};
		const second = buildTranscriptFindIndex({
			rows: [...rows, grouped],
			rowKeys: [...keys, "r2"],
			query: "needle",
			context: spyContext,
			previous: first,
		});
		// Only the appended read-group row hit the resolver.
		expect(scanned).toEqual(["call-1"]);
		// The read-group row contributes two matches of its own: its path ("needle.ts")
		// and the resolved entry's result text (which also contains "needle").
		expect(second.matches.map(m => m.ordinal)).toEqual([0, 1, 2, 3]);
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

	it("rescans a row when the context identity changes, even though the row's key and query are unchanged (late-arriving tool result)", () => {
		// The row's key never moves when a tool result lands — only `context`
		// (`resolveToolCall`/`lookupToolEntry`) changes, exactly as `findContext`'s
		// memo produces a new object whenever `activeTools` updates.
		const pendingEntry: ToolEntry = { ...grepEntry, status: "pending", result: null, partialResult: null };
		const pendingContext: TranscriptFindContext = {
			resolveToolCall: () => ({ key: "call-1", entry: pendingEntry }),
			lookupToolEntry: () => pendingEntry,
		};
		const row: Row = { kind: "message", message: assistant([grepCall]) };
		const first = buildTranscriptFindIndex({
			rows: [row],
			rowKeys: ["r0"],
			query: "needle",
			context: pendingContext,
		});
		// Only the serialized arguments ({ pattern: "needle", ... }) match yet —
		// the result text hasn't arrived.
		expect(first.matches).toHaveLength(1);

		const settledContext: TranscriptFindContext = {
			resolveToolCall: () => ({ key: "call-1", entry: grepEntry }),
			lookupToolEntry: () => grepEntry,
		};
		const second = buildTranscriptFindIndex({
			rows: [row],
			rowKeys: ["r0"],
			query: "needle",
			context: settledContext,
			previous: first,
		});
		// The result text ("...const needle...") must now also be indexed.
		expect(second.matches).toHaveLength(2);
	});

	it("rescans a row whose kind changed since it was cached, even though its key is unchanged (streaming settling into a message)", () => {
		// transcriptRowBaseKey deliberately keeps one key across a streaming row
		// and its finalized message row.
		const streamingRow: Row = { kind: "streaming", message: assistant([{ type: "text", text: "nee" }]) };
		const first = buildAll([streamingRow], ["shared-key"], "needle");
		expect(first.matches).toHaveLength(0);

		const settledRow: Row = { kind: "message", message: assistant([{ type: "text", text: "needle" }]) };
		const second = buildAll([settledRow], ["shared-key"], "needle", first);
		expect(second.matches).toHaveLength(1);
	});
});

// These `matches` are hand-written literals (not built via buildTranscriptFindIndex), so
// none of the grepCall/grepEntry "needle" fixture traps from Task 2 apply here — the
// expected values below were re-derived by hand against the semantics in the brief and
// all matched the brief's supplied values exactly.
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
