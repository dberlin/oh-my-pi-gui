/**
 * subagents store refresh(): the get_subagents poll MERGES instead of
 * replacing — the RPC registry deletes completed/failed agents on their
 * terminal lifecycle frame, so a wholesale replace would vanish finished
 * agents from the UI mid-poll. Live rows absent from the fetch are released.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentSnapshot } from "../../shared/rpc-types";
import { useSubagentsStore } from "./subagents";

const getSubagents = vi.fn();
(globalThis as Record<string, unknown>).window = { omp: { rpc: { getSubagents } } };

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now(), ...overrides };
}

function ok(subagents: SubagentSnapshot[]) {
	return { type: "response", command: "get_subagents", success: true, data: { subagents } };
}

afterEach(() => {
	getSubagents.mockReset();
	useSubagentsStore.getState().reset();
});

describe("subagents store refresh", () => {
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
});
