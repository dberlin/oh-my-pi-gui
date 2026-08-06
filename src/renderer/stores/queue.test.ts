/**
 * queue store: queue_update frames are the authoritative update channel
 * (setFromFrame) — they cover enqueue, drain/consume, remove, move, and
 * clear with zero RPC traffic. get_queue survives only as the hydrate
 * fallback (refresh), deduped while in flight and tolerant of failures.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useQueueStore } from "./queue";

const getQueue = vi.fn();
(globalThis as Record<string, unknown>).window = { omp: { rpc: { getQueue } } };

function queued(id: string, text: string) {
	return { id, text, timestamp: 1 };
}

function ok(data: unknown) {
	return { type: "response", command: "get_queue", success: true, data };
}

afterEach(() => {
	getQueue.mockReset();
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
});

describe("queue store", () => {
	it("applies queue_update snapshots with no RPC traffic, including drain-to-empty", () => {
		useQueueStore
			.getState()
			.setFromFrame({ steering: [queued("s1", "steer me")], followUp: [queued("f2", "later")] });
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1"]);
		expect(useQueueStore.getState().followUp.map(entry => entry.text)).toEqual(["later"]);

		// The drain-consumption frame empties the store on its own — the gap
		// that previously froze the strip/panel/bubbles on consumed items.
		useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
		expect(useQueueStore.getState().steering).toEqual([]);
		expect(useQueueStore.getState().followUp).toEqual([]);
		expect(getQueue).not.toHaveBeenCalled();
	});

	it("refresh hydrates from get_queue and dedupes overlapping pulls", async () => {
		getQueue.mockResolvedValue(ok({ steering: [queued("s1", "one")], followUp: [] }));

		await Promise.all([useQueueStore.getState().refresh(), useQueueStore.getState().refresh()]);

		expect(getQueue).toHaveBeenCalledTimes(1);
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1"]);
	});

	it("failed refresh keeps the last frame-driven snapshot", async () => {
		useQueueStore.getState().setFromFrame({ steering: [], followUp: [queued("f9", "keep")] });
		getQueue.mockRejectedValue(new Error("sidecar down"));

		await useQueueStore.getState().refresh();

		expect(useQueueStore.getState().followUp.map(entry => entry.id)).toEqual(["f9"]);
	});
});
