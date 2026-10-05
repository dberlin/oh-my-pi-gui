import { describe, expect, it } from "vitest";
import type { ModelInfo, RpcCommand, RpcResponse, RpcSessionState } from "../../shared/rpc-types";
import { createModelStore } from "./model";
import type { TabCommand } from "./session-runtime-context";

const model = { id: "reasoner", provider: "test" } as ModelInfo;
function state(nextModel = model): RpcSessionState {
	return { model: nextModel, thinkingLevel: "medium" } as RpcSessionState;
}
function levelsReply(levels: string[]): RpcResponse {
	return { type: "response", command: "get_available_thinking_levels", success: true, data: { levels } };
}

describe("authoritative thinking levels", () => {
	it("loads real levels even though get_state has no thinking metadata", async () => {
		const commands: RpcCommand[] = [];
		const command: TabCommand = async request => {
			commands.push(request);
			return levelsReply(["off", "low", "high"]);
		};
		const store = createModelStore(command);
		store.getState().setFromState(state());
		await store.getState().refreshThinkingLevels();
		expect(commands).toEqual([{ type: "get_available_thinking_levels" }]);
		expect(store.getState().availableThinkingLevels).toEqual(["off", "low", "high"]);
		store.getState().setFromState(state());
		expect(store.getState().availableThinkingLevels).toEqual(["off", "low", "high"]);
	});

	it("never invents levels when metadata is missing or fails", async () => {
		for (const response of [
			{ type: "response", command: "get_available_thinking_levels", success: true },
			{ type: "response", command: "get_available_thinking_levels", success: false, error: "offline" },
		] satisfies RpcResponse[]) {
			const store = createModelStore(async () => response);
			store.getState().setFromState(state());
			store.setState({ availableThinkingLevels: ["high"] });
			await store.getState().refreshThinkingLevels();
			expect(store.getState().availableThinkingLevels).toEqual([]);
		}
	});

	it("filters unsupported auto and unknown values from a malformed response", async () => {
		const store = createModelStore(async () => levelsReply(["auto", "high", "unknown"]));
		await store.getState().refreshThinkingLevels();
		expect(store.getState().availableThinkingLevels).toEqual(["high"]);
	});

	it("drops metadata belonging to a replaced model", async () => {
		const reply = Promise.withResolvers<RpcResponse>();
		const store = createModelStore(async () => reply.promise);
		store.getState().setFromState(state());
		const refresh = store.getState().refreshThinkingLevels();
		store.getState().setFromState(state({ ...model, id: "other" }));
		reply.resolve(levelsReply(["high"]));
		await refresh;
		expect(store.getState().availableThinkingLevels).toEqual([]);
	});

	it("drops metadata after a hydration guard retires the owning session", async () => {
		const reply = Promise.withResolvers<RpcResponse>();
		const store = createModelStore(async () => reply.promise);
		let current = true;
		const refresh = store.getState().refreshThinkingLevels(() => current);
		current = false;
		reply.resolve(levelsReply(["high"]));
		await refresh;
		expect(store.getState().availableThinkingLevels).toEqual([]);
	});

	it("keeps the newest metadata response when reads finish out of order", async () => {
		const older = Promise.withResolvers<RpcResponse>();
		const newer = Promise.withResolvers<RpcResponse>();
		let requests = 0;
		const store = createModelStore(async () => (++requests === 1 ? older.promise : newer.promise));
		const first = store.getState().refreshThinkingLevels();
		const second = store.getState().refreshThinkingLevels();
		newer.resolve(levelsReply(["high"]));
		await second;
		older.resolve(levelsReply(["low"]));
		await first;
		expect(store.getState().availableThinkingLevels).toEqual(["high"]);
	});
});
