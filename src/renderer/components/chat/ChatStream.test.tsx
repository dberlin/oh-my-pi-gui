import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import {
	buildHistoryRowKeys,
	buildHistoryRows,
	buildTimelineMarkers,
	hasStreamingTranscriptContent,
} from "./ChatStream";

const at = "2026-08-05T04:00:00.000Z";

function assistant(content: AgentMessage["content"]): AgentMessage {
	return { role: "assistant", content, timestamp: at };
}

function toolResult(toolCallId: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "test",
		content: [{ type: "text", text: "result" }],
		isError,
		timestamp: at,
	};
}

const toolRun: AgentMessage[] = [
	assistant([
		{ type: "text", text: "I will inspect the source." },
		{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/a.ts" } },
	]),
	toolResult("call-read"),
	assistant([{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "src/a.ts" } }]),
	toolResult("call-write"),
	assistant([{ type: "text", text: "Implemented and verified." }]),
];

describe("compact transcript rows", () => {
	it("folds consecutive tool work into one process row and keeps the final answer visible", () => {
		const rows = buildHistoryRows(toolRun, "compact");
		expect(rows.map(row => row.kind)).toEqual(["process", "message"]);

		const process = rows[0];
		if (process?.kind !== "process") throw new Error("process row missing");
		expect(process.stepCount).toBe(2);
		expect(process.toolNames).toEqual(["read", "write"]);
		expect(process.messages).toHaveLength(2);

		const answer = rows[1];
		if (answer?.kind !== "message") throw new Error("final answer row missing");
		expect(answer.message.content).toEqual([{ type: "text", text: "Implemented and verified." }]);
	});

	it("splits final reasoning from final text so only the answer stays outside the process row", () => {
		const rows = buildHistoryRows(
			[
				assistant([
					{ type: "thinking", thinking: "Check the boundary first." },
					{ type: "text", text: "The public answer." },
				]),
			],
			"compact",
		);
		expect(rows.map(row => row.kind)).toEqual(["process", "message"]);

		const process = rows[0];
		const answer = rows[1];
		if (process?.kind !== "process" || answer?.kind !== "message") throw new Error("split rows missing");
		expect(process.stepCount).toBe(1);
		expect(process.messages[0]?.content).toEqual([{ type: "thinking", thinking: "Check the boundary first." }]);
		expect(answer.message.content).toEqual([{ type: "text", text: "The public answer." }]);
	});

	it("omits punctuation filler instead of allocating an invisible virtual row", () => {
		expect(
			buildHistoryRows(
				[
					assistant([
						{ type: "thinking", thinking: "." },
						{ type: "text", text: "." },
					]),
				],
				"compact",
			),
		).toEqual([]);
	});

	it("starts a new process phase at meaningful narration and keeps filler tool calls in that phase", () => {
		const rows = buildHistoryRows(
			[
				assistant([
					{ type: "text", text: "Validate the updater." },
					{ type: "toolCall", id: "call-check", name: "bash", arguments: { command: "bun check" } },
				]),
				assistant([
					{ type: "text", text: "." },
					{ type: "toolCall", id: "call-format", name: "bash", arguments: { command: "bun format" } },
				]),
				assistant([
					{ type: "thinking", thinking: "The checks passed; launch the audit build." },
					{ type: "text", text: "Launch the audit build." },
					{ type: "toolCall", id: "call-build", name: "bash", arguments: { command: "bun run build" } },
				]),
				assistant([
					{ type: "text", text: "." },
					{ type: "toolCall", id: "call-launch", name: "hub", arguments: { name: "gui-final" } },
				]),
			],
			"compact",
		);

		expect(rows.map(row => row.kind)).toEqual(["process", "process"]);
		const first = rows[0];
		const second = rows[1];
		if (first?.kind !== "process" || second?.kind !== "process") throw new Error("process phases missing");
		expect(first.toolNames).toEqual(["bash", "bash"]);
		expect(second.toolNames).toEqual(["bash", "hub"]);
	});
});

describe("full transcript rows", () => {
	it("keeps individual process messages but removes standalone tool-result transport rows", () => {
		const rows = buildHistoryRows(toolRun, "full");
		expect(rows.map(row => row.kind)).toEqual(["message", "message", "message"]);
		for (const row of rows) {
			if (row.kind !== "message") throw new Error("full mode unexpectedly folded a process row");
			expect(row.message.role).toBe("assistant");
		}
	});

	it("renders one marker per narrated phase and aggregates continuation tool state", () => {
		const phaseRows = buildHistoryRows(
			[
				assistant([
					{ type: "text", text: "Validate the updater." },
					{ type: "toolCall", id: "call-check", name: "bash", arguments: { command: "bun check" } },
				]),
				assistant([
					{ type: "text", text: "." },
					{ type: "toolCall", id: "call-format", name: "bash", arguments: { command: "bun format" } },
				]),
				assistant([
					{ type: "thinking", thinking: "The checks passed; launch the audit build." },
					{ type: "text", text: "Launch the audit build." },
					{ type: "toolCall", id: "call-build", name: "bash", arguments: { command: "bun run build" } },
				]),
				assistant([
					{ type: "text", text: "." },
					{ type: "toolCall", id: "call-hub", name: "hub", arguments: { name: "gui-final" } },
				]),
				assistant([
					{ type: "text", text: "." },
					{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "xd://browser" } },
				]),
				{ role: "custom", customType: "launch-completion", content: "gui-final exited with code 0", timestamp: at },
			],
			"full",
		);

		const markers = buildTimelineMarkers(phaseRows);
		expect(markers.map(marker => marker?.state ?? null)).toEqual(["done", null, "done", null, null, "launch"]);
		expect(markers[0]?.toolIds).toEqual(["call-check", "call-format"]);
		expect(markers[2]?.toolIds).toEqual(["call-build", "call-hub", "call-write"]);
	});
});

describe("streaming transcript visibility", () => {
	const shell = assistant([]);

	it("does not allocate a blank row for punctuation-only deltas", () => {
		expect(hasStreamingTranscriptContent(shell, ".", "…", new Map())).toBe(false);
	});

	it("shows a tool-only turn as soon as its live tool starts", () => {
		expect(
			hasStreamingTranscriptContent(
				shell,
				"",
				"",
				new Map([
					[
						"call-read",
						{
							toolName: "read",
							args: { path: "src/a.ts" },
							status: "running",
							partialResult: null,
							streamingArgs: "",
							result: null,
							isError: false,
							startTime: Date.parse(at),
							endTime: null,
						},
					],
				]),
			),
		).toBe(true);
	});
});

describe("virtual transcript identity", () => {
	it("keeps existing row keys stable when a new message is inserted before them", () => {
		const existingRows = buildHistoryRows(
			[assistant([{ type: "text", text: "First" }]), assistant([{ type: "text", text: "Second" }])],
			"full",
		);
		const existingKeys = buildHistoryRowKeys(existingRows);
		const prependedRows = buildHistoryRows(
			[
				{ role: "user", content: [{ type: "text", text: "Prompt" }], timestamp: "2026-08-05T03:59:59.000Z" },
				assistant([{ type: "text", text: "First" }]),
				assistant([{ type: "text", text: "Second" }]),
			],
			"full",
		);
		expect(buildHistoryRowKeys(prependedRows).slice(1)).toEqual(existingKeys);
	});
});
