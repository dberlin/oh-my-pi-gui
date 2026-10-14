import { describe, expect, it } from "vitest";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { createModelRecoveryGuard, prepareModelRecoveryCommand, prepareModelRestoreOrigin } from "./model-recovery";

const command = {
	type: "switch_session" as const,
	sessionPath: "/sessions/target.jsonl",
	provider: "openai",
	modelId: "current",
	expectedSessionId: "working",
};

function state(sessionId = "working", model: unknown = { provider: "openai", id: "current" }): RpcResponse {
	return { type: "response", command: "get_state", success: true, data: { sessionId, model } };
}

describe("explicit current-model recovery", () => {
	it("forwards the exact approved vanilla model binding without GUI origin metadata", async () => {
		const reads: RpcCommand[] = [];
		const result = await prepareModelRecoveryCommand(
			command,
			async request => {
				reads.push(request);
				return state();
			},
			() => true,
		);
		expect(reads).toEqual([{ type: "get_state" }]);
		expect(result).toEqual({
			command: {
				type: "switch_session",
				sessionPath: "/sessions/target.jsonl",
				provider: "openai",
				modelId: "current",
			},
		});
	});

	it.each([
		["changed session", state("replacement")],
		["changed model", state("working", { provider: "openai", id: "different" })],
		["missing current model", state("working", null)],
		["failed authoritative read", { type: "response", command: "get_state", success: false, error: "Disconnected" }],
	])("refuses %s before changing the working session", async (_name, response) => {
		const result = await prepareModelRecoveryCommand(
			command,
			async () => response as RpcResponse,
			() => true,
		);
		expect(result).toMatchObject({ response: { success: false } });
		expect(result).not.toHaveProperty("command");
	});

	it("refuses a replaced sidecar after the authoritative read", async () => {
		let current = true;
		const result = await prepareModelRecoveryCommand(
			command,
			async () => {
				current = false;
				return state();
			},
			() => current,
		);
		expect(result).toMatchObject({ response: { success: false, code: "session_model_recovery_stale" } });
	});

	it("does not invent a model binding for a normal saved-model restore", async () => {
		const normal = { type: "switch_session" as const, sessionPath: "/sessions/target.jsonl" };
		let reads = 0;
		expect(
			await prepareModelRecoveryCommand(
				normal,
				async () => {
					reads++;
					return state();
				},
				() => true,
			),
		).toEqual({ command: normal });
		expect(reads).toBe(0);
	});

	it("refuses a same-client session mutation queued while the authoritative get_state is pending", async () => {
		const guard = createModelRecoveryGuard();
		const client = {};
		guard.observe(client, command);
		const isCurrent = guard.capture(client);
		const reply = Promise.withResolvers<RpcResponse>();
		const started = Promise.withResolvers<void>();
		const preparing = prepareModelRecoveryCommand(
			command,
			async () => {
				started.resolve();
				return reply.promise;
			},
			isCurrent,
		);
		await started.promise;
		guard.observe(client, { type: "new_session" });
		reply.resolve(state());

		expect(await preparing).toMatchObject({
			response: { success: false, code: "session_model_recovery_stale" },
		});
	});

	it.each([
		{ type: "set_model", provider: "openai", modelId: "replacement" },
		{ type: "cycle_model" },
	] satisfies RpcCommand[])(
		"refuses queued $type while get_state still reports the previously current model",
		async mutation => {
			const guard = createModelRecoveryGuard();
			const client = {};
			guard.observe(client, command);
			const isCurrent = guard.capture(client);
			const reply = Promise.withResolvers<RpcResponse>();
			const started = Promise.withResolvers<void>();
			const preparing = prepareModelRecoveryCommand(
				command,
				async () => {
					started.resolve();
					return reply.promise;
				},
				isCurrent,
			);
			await started.promise;
			guard.observe(client, mutation);
			reply.resolve(state());

			expect(await preparing).toMatchObject({
				response: { success: false, code: "session_model_recovery_stale" },
			});
		},
	);

	it("keeps an origin valid across unrelated reads and another client's mutation", async () => {
		const guard = createModelRecoveryGuard();
		const client = {};
		guard.observe(client, command);
		const isCurrent = guard.capture(client);
		const reply = Promise.withResolvers<RpcResponse>();
		const started = Promise.withResolvers<void>();
		const preparing = prepareModelRecoveryCommand(
			command,
			async () => {
				started.resolve();
				return reply.promise;
			},
			isCurrent,
		);
		await started.promise;
		guard.observe(client, { type: "get_messages" });
		guard.observe({}, { type: "new_session" });
		reply.resolve(state());

		expect(await preparing).toMatchObject({
			command: { type: "switch_session", provider: "openai", modelId: "current" },
		});
	});
});

describe("background restore working-origin capture", () => {
	const metadata = {
		sessionPath: "/sessions/saved.jsonl",
		modelOrigin: { tabId: "working-tab", sessionId: "working" },
	};

	it("supports a metadata-only initial open even when no current model is selected", async () => {
		const prepared = await prepareModelRestoreOrigin(
			metadata,
			async () => state("working", null),
			() => true,
		);
		if ("error" in prepared) throw new Error(prepared.error);
		expect(await prepared.check()).toBe(true);
	});

	it("rejects a metadata-only origin that changed model while the target was loading", async () => {
		let current = state();
		const prepared = await prepareModelRestoreOrigin(
			metadata,
			async () => current,
			() => true,
		);
		if ("error" in prepared) throw new Error(prepared.error);
		current = state("working", { provider: "openai", id: "changed" });
		expect(await prepared.check()).toBe(false);
	});

	it("rejects an explicit binding that was not the authoritative current model", async () => {
		const prepared = await prepareModelRestoreOrigin(
			{
				...metadata,
				model: { provider: "openai", modelId: "other" },
			},
			async () => state(),
			() => true,
		);
		expect(prepared).toHaveProperty("error");
	});

	it("preserves native initial-read and final-read failure causes", async () => {
		const unavailable = await prepareModelRestoreOrigin(
			metadata,
			async () => ({
				type: "response",
				command: "get_state",
				success: false,
				error: "Native origin refused state",
			}),
			() => true,
		);
		expect(unavailable).toEqual({ error: "Native origin refused state" });
		let fail = false;
		const prepared = await prepareModelRestoreOrigin(
			metadata,
			async () => {
				if (fail) throw new Error("SSH channel closed");
				return state();
			},
			() => true,
		);
		if ("error" in prepared) throw new Error(prepared.error);
		fail = true;
		await expect(prepared.check()).rejects.toThrow("SSH channel closed");
	});

	it("rejects an origin generation superseded during an authoritative read", async () => {
		const guard = createModelRecoveryGuard();
		const client = {};
		const unchanged = guard.capture(client);
		const prepared = await prepareModelRestoreOrigin(
			metadata,
			async () => {
				guard.observe(client, { type: "cycle_model" });
				return state();
			},
			unchanged,
		);
		expect(prepared).toHaveProperty("error");
	});
});

it("notifies only subscribers of a genuinely changed client and detaches retired restore watchers", () => {
	const guard = createModelRecoveryGuard();
	const working = {};
	const unrelated = {};
	let invalidations = 0;
	const stop = guard.subscribe(working, () => {
		invalidations++;
	});
	guard.observe(unrelated, { type: "set_model", provider: "openai", modelId: "other" });
	guard.observe(working, { type: "get_state" });
	expect(invalidations).toBe(0);
	guard.observe(working, { type: "cycle_model" });
	expect(invalidations).toBe(1);
	stop();
	guard.observe(working, { type: "new_session" });
	expect(invalidations).toBe(1);
});
