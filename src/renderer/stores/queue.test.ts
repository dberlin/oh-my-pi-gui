import { describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import { createQueueStore } from "./queue";

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "get_state", success: true, data };
}

function queued(id: string, text: string) {
	return { id, text, editable: true, timestamp: 1 };
}

describe("queue store", () => {
	it("renders vanilla text snapshots, preserving duplicates and replacing previous lanes", () => {
		const command = vi.fn();
		const store = createQueueStore(command);
		store.getState().setFromFrame({ steering: ["steer me", "steer me"], followUp: ["later"] });
		expect(store.getState().steering.map(entry => entry.text)).toEqual(["steer me", "steer me"]);
		expect(new Set(store.getState().steering.map(entry => entry.id)).size).toBe(2);
		expect(store.getState().steering.every(entry => !entry.editable)).toBe(true);
		expect(store.getState().idOperations).toBe(false);
		store.getState().setFromFrame({ steering: [], followUp: ["replacement"] });
		expect(store.getState().steering).toEqual([]);
		expect(store.getState().followUp.map(entry => entry.text)).toEqual(["replacement"]);
		store.getState().setFromFrame({ steering: [], followUp: [] });
		expect(store.getState().followUp).toEqual([]);
		expect(command).not.toHaveBeenCalled();
	});

	it("hydrates vanilla queuedMessages via get_state without extension commands", async () => {
		const command = vi.fn(async () => ok({ queuedMessages: { steering: ["now"], followUp: ["next"] } }));
		const store = createQueueStore(command);
		await store.getState().refresh();
		expect(command.mock.calls).toEqual([[{ type: "get_state" }]]);
		expect(store.getState().steering.map(entry => entry.text)).toEqual(["now"]);
		expect(store.getState().followUp.map(entry => entry.text)).toEqual(["next"]);
	});

	it("reuses a hydration state read without issuing a second snapshot request", async () => {
		const command = vi.fn();
		const store = createQueueStore(command);
		const pending = Promise.withResolvers<RpcResponse>();
		const refresh = store.getState().refresh(pending.promise);
		pending.resolve(ok({ queuedMessages: { steering: ["hydrated work"], followUp: ["later"] } }));
		await refresh;
		expect(command).not.toHaveBeenCalled();
		expect(store.getState().steering.map(entry => entry.text)).toEqual(["hydrated work"]);
		expect(store.getState().followUp.map(entry => entry.text)).toEqual(["later"]);
		expect(store.getState().idOperations).toBe(false);
	});

	it("drops a shared snapshot when its owning hydration has been invalidated", async () => {
		const command = vi.fn();
		const store = createQueueStore(command);
		store.getState().setFromFrame({ steering: ["keep"], followUp: [] });
		const pending = Promise.withResolvers<RpcResponse>();
		let current = true;
		const refresh = store.getState().refresh(pending.promise, () => current);
		current = false;
		pending.resolve(ok({ queuedMessages: { steering: ["retired work"], followUp: [] } }));
		await refresh;
		expect(store.getState().steering.map(entry => entry.text)).toEqual(["keep"]);
		expect(command).not.toHaveBeenCalled();
	});

	it("keeps a newer queue event while a shared hydration snapshot is pending", async () => {
		const store = createQueueStore(vi.fn());
		const pending = Promise.withResolvers<RpcResponse>();
		const refresh = store.getState().refresh(pending.promise);
		store.getState().setFromFrame({ steering: [], followUp: ["latest"] });
		pending.resolve(ok({ queuedMessages: { steering: ["stale"], followUp: [] } }));
		await refresh;
		expect(store.getState().steering).toEqual([]);
		expect(store.getState().followUp.map(entry => entry.text)).toEqual(["latest"]);
	});

	it("does not let an older state response overwrite an authoritative queue event", async () => {
		const pending = Promise.withResolvers<RpcResponse>();
		const store = createQueueStore(() => pending.promise);
		const refresh = store.getState().refresh();
		store.getState().setFromFrame({ steering: ["latest"], followUp: [] });
		pending.resolve(ok({ queuedMessages: { steering: ["stale"], followUp: [] } }));
		await refresh;
		expect(store.getState().steering.map(entry => entry.text)).toEqual(["latest"]);
	});

	it("applies only the latest of overlapping hydration responses", async () => {
		const old = Promise.withResolvers<RpcResponse>();
		const current = Promise.withResolvers<RpcResponse>();
		const command = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
		const store = createQueueStore(command);
		const first = store.getState().refresh();
		const second = store.getState().refresh();
		current.resolve(ok({ queuedMessages: { steering: ["new"], followUp: [] } }));
		await second;
		old.resolve(ok({ queuedMessages: { steering: ["old"], followUp: [] } }));
		await first;
		expect(store.getState().steering.map(entry => entry.text)).toEqual(["new"]);
	});

	it("keeps each tab's text queue and pending refresh isolated", async () => {
		const pending = Promise.withResolvers<RpcResponse>();
		const a = createQueueStore(() => pending.promise);
		const b = createQueueStore(async () => ok({ queuedMessages: { steering: [], followUp: ["tab B"] } }));
		const refreshA = a.getState().refresh();
		await b.getState().refresh();
		pending.resolve(ok({ queuedMessages: { steering: ["tab A"], followUp: [] } }));
		await refreshA;
		expect(a.getState().steering.map(entry => entry.text)).toEqual(["tab A"]);
		expect(a.getState().followUp).toEqual([]);
		expect(b.getState().steering).toEqual([]);
		expect(b.getState().followUp.map(entry => entry.text)).toEqual(["tab B"]);
	});

	it("preserves the last snapshot on rejected or failed refresh", async () => {
		const command = vi
			.fn()
			.mockResolvedValueOnce({ type: "response", command: "get_state", success: false, error: "offline" })
			.mockRejectedValueOnce(new Error("offline"));
		const store = createQueueStore(command);
		store.getState().setFromFrame({ steering: [], followUp: ["keep"] });
		await store.getState().refresh();
		await store.getState().refresh();
		expect(store.getState().followUp.map(entry => entry.text)).toEqual(["keep"]);
	});

	it("does not probe extension APIs when optional vanilla queue state is absent", async () => {
		const command = vi.fn(async () => ok({}));
		const store = createQueueStore(command);
		store.getState().setFromFrame({ steering: ["keep until next event"], followUp: [] });
		await store.getState().refresh();
		expect(command.mock.calls).toEqual([[{ type: "get_state" }]]);
		expect(store.getState().steering.map(entry => entry.text)).toEqual(["keep until next event"]);
		expect(store.getState().idOperations).toBe(false);
	});
	it("retains genuine stable IDs only for extension snapshots", async () => {
		const snapshot = { steering: [queued("server-id", "legacy")], followUp: [] };
		const command = vi.fn().mockResolvedValueOnce(ok({})).mockResolvedValueOnce(ok(snapshot));
		const store = createQueueStore(command);
		store.getState().setFromFrame(snapshot);
		await store.getState().refresh();
		expect(command.mock.calls).toEqual([[{ type: "get_state" }], [{ type: "get_queue" }]]);
		expect(store.getState().steering[0]?.id).toBe("server-id");
		expect(store.getState().idOperations).toBe(true);
		store.getState().setFromFrame({ steering: ["vanilla"], followUp: [] });
		expect(store.getState().idOperations).toBe(false);
	});
});
