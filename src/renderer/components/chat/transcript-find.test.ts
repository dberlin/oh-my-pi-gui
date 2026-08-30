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
