/**
 * subagents store refresh(): the get_subagents poll MERGES instead of
 * replacing — the RPC registry deletes completed/failed agents on their
 * terminal lifecycle frame, so a wholesale replace would vanish finished
 * agents from the UI mid-poll. Live rows absent from the fetch are released.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, RpcResponse, SubagentSnapshot } from "../../shared/rpc-types";
import { useAgentViewStore } from "./agent-view";
import { historicalSubagentsFromMessages, useSubagentsStore } from "./subagents";

const getSubagents = vi.fn();
const getSubagentMessages = vi.fn();
(globalThis as Record<string, unknown>).window = { omp: { rpc: { getSubagents, getSubagentMessages } } };

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now(), ...overrides };
}

function ok(subagents: SubagentSnapshot[]): RpcResponse {
	return { type: "response", command: "get_subagents", success: true, data: { subagents } };
}

afterEach(() => {
	getSubagents.mockReset();
	getSubagentMessages.mockReset();
	useAgentViewStore.getState().reset();
	useSubagentsStore.getState().reset();
});

describe("subagents store", () => {
	it("reset clears both the roster and transcript tool-call ownership", () => {
		const store = useSubagentsStore.getState();
		store.setSnapshots([snap({ id: "parent" })]);
		store.registerToolCallOwners("parent", ["provider-call:0"]);

		useSubagentsStore.getState().reset();

		expect(useSubagentsStore.getState().subagents.size).toBe(0);
		expect(useSubagentsStore.getState().toolCallOwners.size).toBe(0);
	});

	it("maps a claimed-running row without a live turn to a cancellable stale status", () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "zombie", status: "running", live: false })]);
		expect(useSubagentsStore.getState().subagents.get("zombie")).toMatchObject({
			status: "stale",
			live: false,
		});
	});

	it("merges: keeps forgotten terminal rows, drops released live rows, updates the rest", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "done", status: "completed" }),
				snap({ id: "live", status: "running", task: "old label" }),
				snap({ id: "stale", status: "running" }),
			]);
		getSubagents.mockResolvedValue(ok([snap({ id: "live", status: "parked", task: "new label" })]));

		await useSubagentsStore.getState().refresh();

		const subagents = useSubagentsStore.getState().subagents;
		expect(subagents.get("done")?.status).toBe("completed");
		expect(subagents.has("stale")).toBe(false);
		expect(subagents.get("live")?.status).toBe("parked");
		expect(subagents.get("live")?.task).toBe("new label");
	});

	it("never blanks a populated label when the fetch row lacks it", async () => {
		useSubagentsStore.getState().setSnapshots([
			snap({
				id: "live",
				status: "running",
				task: "rendered template",
				assignment: "raw task",
				description: "Worker",
				sessionFile: "/tmp/a.jsonl",
				progress: {
					index: 1,
					id: "live",
					agent: "scout",
					agentSource: "bundled",
					status: "running",
					task: "rendered template",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 1,
					tokens: 0,
					cost: 0,
					durationMs: 19_800,
					resolvedModel: "openai/gpt-5.2",
				},
			}),
		]);
		// Bare AgentRegistry ref row: no task/assignment/description/progress.
		getSubagents.mockResolvedValue(ok([snap({ id: "live", status: "parked" })]));

		await useSubagentsStore.getState().refresh();

		const row = useSubagentsStore.getState().subagents.get("live");
		expect(row?.status).toBe("parked");
		expect(row?.task).toBe("rendered template");
		expect(row?.assignment).toBe("raw task");
		expect(row?.description).toBe("Worker");
		expect(row?.sessionFile).toBe("/tmp/a.jsonl");
		expect(row?.progress?.durationMs).toBe(19_800);
		expect(row?.progress?.resolvedModel).toBe("openai/gpt-5.2");
	});

	it("failed fetch leaves frame-driven state untouched", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "live", status: "running" })]);
		getSubagents.mockResolvedValue({ type: "response", command: "get_subagents", success: false, error: "boom" });
		await useSubagentsStore.getState().refresh();
		expect(useSubagentsStore.getState().subagents.has("live")).toBe(true);

		getSubagents.mockRejectedValue(new Error("sidecar gone"));
		await useSubagentsStore.getState().refresh();
		expect(useSubagentsStore.getState().subagents.has("live")).toBe(true);
	});

	it("falls back from a selected live target only after a successful authoritative poll omits it", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "selected", status: "running" })]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "selected" });
		getSubagents.mockResolvedValue(ok([]));

		await useSubagentsStore.getState().refresh();

		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
	});

	it("keeps a selected terminal row inspectable across a successful poll that retains it locally", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "done", status: "completed" })]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "done" });
		getSubagents.mockResolvedValue(ok([]));

		await useSubagentsStore.getState().refresh();

		expect(useSubagentsStore.getState().subagents.get("done")?.status).toBe("completed");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "done" });
	});

	it("does not fall back when the authoritative poll fails", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "selected", status: "running" })]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "selected" });
		getSubagents.mockResolvedValue({ type: "response", command: "get_subagents", success: false, error: "offline" });

		await useSubagentsStore.getState().refresh();

		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "selected" });
	});

	it("reloads the selected transcript with locator updates from live roster frames", async () => {
		const selected = snap({ id: "selected", status: "running", sessionFile: "/tmp/old.jsonl" });
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		getSubagentMessages.mockResolvedValue({
			type: "response",
			command: "get_subagent_messages",
			success: true,
			data: { messages: [], hasMore: false },
		});

		useSubagentsStore.getState().applyFrame({
			type: "subagent_lifecycle",
			payload: {
				id: selected.id,
				index: selected.index,
				agent: selected.agent,
				agentSource: "bundled",
				status: "started",
				sessionFile: "/tmp/current.jsonl",
			},
		});
		await useAgentViewStore.getState().reloadSelected();

		expect(getSubagentMessages).toHaveBeenCalledWith(selected.id, "/tmp/current.jsonl", 0);
	});

	it("rejects a delayed poll when a newer live frame updates the roster", async () => {
		const selected = snap({ id: "selected", status: "running" });
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		const delayed = Promise.withResolvers<RpcResponse>();
		getSubagents.mockReturnValue(delayed.promise);

		const polling = useSubagentsStore.getState().refresh();
		useSubagentsStore.getState().applyFrame({
			type: "subagent_lifecycle",
			payload: {
				id: selected.id,
				index: selected.index,
				agent: selected.agent,
				agentSource: "bundled",
				status: "started",
				sessionFile: selected.sessionFile,
			},
		});
		delayed.resolve(ok([]));
		await polling;

		expect(useSubagentsStore.getState().subagents.has(selected.id)).toBe(true);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: selected.id });
	});
});

describe("historical subagent reconstruction", () => {
	it("uses allocated result ids so repeated requested names retain distinct transcripts", () => {
		const taskCall = (toolCallId: string): AgentMessage => ({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: toolCallId,
					name: "task",
					arguments: { tasks: [{ name: "Scout", agent: "scout", task: "inspect" }] },
				},
			],
			timestamp: 1,
		});
		const taskResult = (toolCallId: string, id: string): AgentMessage => ({
			role: "toolResult",
			toolCallId,
			toolName: "task",
			content: [{ type: "text", text: "done" }],
			details: { results: [{ index: 0, id, agent: "scout", task: "inspect", exitCode: 0 }] },
			timestamp: 2,
		});

		const historical = historicalSubagentsFromMessages(
			[taskCall("task-1"), taskResult("task-1", "Scout"), taskCall("task-2"), taskResult("task-2", "Scout-2")],
			"/sessions/project/parent.jsonl",
		);

		expect(historical.map(snapshot => [snapshot.id, snapshot.sessionFile])).toEqual([
			["Scout", "/sessions/project/parent/Scout.jsonl"],
			["Scout-2", "/sessions/project/parent/Scout-2.jsonl"],
		]);
	});

	it("uses allocated progress ids and falls back to the requested name only when no canonical id exists", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "task-progress",
						name: "task",
						arguments: {
							tasks: [
								{ name: "Requested", agent: "task", task: "first" },
								{ name: "Fallback", agent: "task", task: "second" },
							],
						},
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "task-progress",
				toolName: "task",
				content: [{ type: "text", text: "interrupted" }],
				details: {
					progress: [{ index: 0, id: "Allocated", agent: "task", status: "failed", task: "first" }],
				},
				timestamp: 2,
			},
		];

		const historical = historicalSubagentsFromMessages(messages, "/sessions/project/parent.jsonl");

		expect(historical.map(snapshot => snapshot.id)).toEqual(["Allocated", "Fallback"]);
		expect(historical.map(snapshot => snapshot.sessionFile)).toEqual([
			"/sessions/project/parent/Allocated.jsonl",
			"/sessions/project/parent/Fallback.jsonl",
		]);
	});

	it("does not treat stale pending spawn progress as a live historical status", () => {
		const messages: AgentMessage[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "task-pending",
						name: "task",
						arguments: { tasks: [{ name: "Requested", agent: "scout", task: "inspect" }] },
					},
				],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "task-pending",
				toolName: "task",
				content: [{ type: "text", text: "spawned" }],
				details: {
					progress: [{ index: 0, id: "Allocated", agent: "scout", status: "pending", task: "inspect" }],
				},
				timestamp: 2,
			},
		];

		expect(historicalSubagentsFromMessages(messages, "/sessions/project/parent.jsonl")[0]).toMatchObject({
			id: "Allocated",
			status: "unknown",
			sessionFile: "/sessions/project/parent/Allocated.jsonl",
		});
	});
});
