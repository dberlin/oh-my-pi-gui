import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { buildHistoryRows } from "./ChatStream";

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
		expect(buildHistoryRows([assistant([{ type: "text", text: "." }])], "compact")).toEqual([]);
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
});
