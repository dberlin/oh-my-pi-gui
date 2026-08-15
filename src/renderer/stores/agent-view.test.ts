import { describe, expect, it, vi } from "vitest";
import type { AgentMessage, RpcResponse, SubagentSnapshot } from "../../shared/rpc-types";
import { type AgentViewLoader, createAgentViewStore } from "./agent-view";

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "get_subagent_messages", success: true, data };
}

function fail(error: string): RpcResponse {
	return { type: "response", command: "get_subagent_messages", success: false, error };
}

function snapshot(id: string, sessionFile = `/tmp/${id}.jsonl`): SubagentSnapshot {
	return { id, index: 1, agent: "worker", status: "running", sessionFile, lastUpdate: 1, kind: "sub" };
}

function message(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}

function loader(
	getSubagentMessages: AgentViewLoader["getSubagentMessages"],
	readPersistedSubagentTranscript: AgentViewLoader["readPersistedSubagentTranscript"] = async () => ({
		ok: false,
		error: "Persisted transcript unavailable",
	}),
): AgentViewLoader {
	return { getSubagentMessages, readPersistedSubagentTranscript };
}

describe("agent view store", () => {
	it("starts on Main with empty idle projections", () => {
		const store = createAgentViewStore(loader(async () => ok({ messages: [], nextByte: 0, hasMore: false })));

		const state = store.getState();
		expect(state.target).toEqual({ kind: "main" });
		expect(state.loadState).toBe("idle");
		expect(state.error).toBeNull();
		expect(state.generation).toBe(0);
		expect(state.messages.messages).toEqual([]);
		expect(state.tools.activeTools.size).toBe(0);
	});

	it("loads every page from the selected snapshot and deduplicates overlapping deliveries", async () => {
		const firstPage = Promise.withResolvers<RpcResponse>();
		const one = message("one", 1);
		const two = message("two", 2);
		const getSubagentMessages = vi.fn(
			async (_id?: string, _sessionFile?: string, fromByte?: number): Promise<RpcResponse> => {
				if (fromByte === 0) return firstPage.promise;
				return ok({ messages: [one, two], nextByte: 20, hasMore: false });
			},
		);
		const store = createAgentViewStore(loader(getSubagentMessages));
		const selected = snapshot("a1", "/sessions/a1.jsonl");

		const loading = store.getState().selectSubagent(selected);
		expect(store.getState()).toMatchObject({
			target: { kind: "subagent", id: "a1" },
			loadState: "loading",
			generation: 1,
		});
		expect(getSubagentMessages).toHaveBeenCalledWith("a1", "/sessions/a1.jsonl", 0);

		firstPage.resolve(ok({ messages: [one], nextByte: 10, hasMore: true }));
		await loading;

		expect(getSubagentMessages.mock.calls).toEqual([
			["a1", "/sessions/a1.jsonl", 0],
			["a1", "/sessions/a1.jsonl", 10],
		]);
		expect(store.getState().messages.messages).toEqual([one, two]);
		expect(store.getState().loadState).toBe("ready");
	});

	it("preserves live frames received during pagination without redelivering messages already on a page", async () => {
		const page = Promise.withResolvers<RpcResponse>();
		const history = message("history", 1);
		const onPageAndLive = message("on page and live", 2);
		const liveOnly = message("live only", 3);
		const store = createAgentViewStore(loader(async () => page.promise));

		const loading = store.getState().selectSubagent(snapshot("a1"));
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "message_end", message: onPageAndLive } },
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "message_end", message: liveOnly } },
		});
		page.resolve(ok({ messages: [history, onPageAndLive], nextByte: 12, hasMore: false }));
		await loading;

		expect(store.getState().messages.messages).toEqual([history, onPageAndLive, liveOnly]);
	});
	it("does not redeliver a hydrated tool-call message when its live turn ends", async () => {
		const callMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-activation", name: "read", arguments: { path: "/tmp" } }],
			responseId: "response-activation",
			timestamp: 4,
		} as AgentMessage;
		const store = createAgentViewStore(
			loader(async () => ok({ messages: [callMessage], nextByte: 12, hasMore: false })),
		);

		await store.getState().selectSubagent(snapshot("a1"));
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: {
					type: "tool_execution_start",
					toolCallId: "call-activation",
					toolName: "read",
					args: { path: "/tmp" },
				},
			},
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: {
					type: "tool_execution_end",
					toolCallId: "call-activation",
					toolName: "read",
					result: "done",
				},
			},
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "turn_end", message: callMessage } },
		});

		expect(store.getState().messages.messages).toEqual([callMessage]);
		expect(store.getState().tools.activeTools.size).toBe(1);
		expect(store.getState().tools.activeTools.get("call-activation")?.status).toBe("done");
	});

	it("closes a live stream and retains its delivery identity when hydration already contains the final message", async () => {
		const page = Promise.withResolvers<RpcResponse>();
		const finalized = {
			role: "assistant",
			content: [{ type: "text", text: "finalized" }],
			timestamp: 4,
		} as AgentMessage;
		const store = createAgentViewStore(loader(async () => page.promise));

		const loading = store.getState().selectSubagent(snapshot("a1"));
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "message_start", message: finalized } },
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "message_end", message: finalized } },
		});
		page.resolve(ok({ messages: [finalized], nextByte: 12, hasMore: false }));
		await loading;

		expect(store.getState().messages.streamingMessage).toBeNull();
		expect(store.getState().messages.messages).toEqual([finalized]);
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "turn_end", message: finalized } },
		});
		expect(store.getState().messages.messages).toEqual([finalized]);
	});

	it("does not duplicate a live tool execution already finalized in fetched history", async () => {
		const page = Promise.withResolvers<RpcResponse>();
		const callMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp" } }],
			timestamp: 6,
		} as AgentMessage;
		const resultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 7,
		} as AgentMessage;
		const store = createAgentViewStore(loader(async () => page.promise));

		const loading = store.getState().selectSubagent(snapshot("a1"));
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: {
					type: "message_update",
					message: callMessage,
					assistantMessageEvent: {
						type: "toolcall_delta",
						contentIndex: 0,
						delta: '{"path":',
						partial: callMessage,
					},
				},
			},
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "message_end", message: callMessage } },
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/tmp" } },
			},
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "done" },
			},
		});
		page.resolve(ok({ messages: [callMessage, resultMessage], nextByte: 12, hasMore: false }));
		await loading;

		expect(store.getState().tools.activeTools.size).toBe(1);
		expect(store.getState().tools.activeTools.get("call-1")?.status).toBe("done");
	});
	it("matches a streamed live occurrence to the same fetched call even before its result is written", async () => {
		const page = Promise.withResolvers<RpcResponse>();
		const callMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/current" } }],
			timestamp: 8,
		} as AgentMessage;
		const store = createAgentViewStore(loader(async () => page.promise));

		const loading = store.getState().selectSubagent(snapshot("a1"));
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: {
					type: "message_update",
					message: callMessage,
					assistantMessageEvent: {
						type: "toolcall_delta",
						contentIndex: 0,
						delta: '{"path":',
						partial: callMessage,
					},
				},
			},
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "message_end", message: callMessage } },
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: {
					type: "tool_execution_start",
					toolCallId: "call-1",
					toolName: "read",
					args: { path: "/current" },
				},
			},
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: {
					type: "tool_execution_end",
					toolCallId: "call-1",
					toolName: "read",
					result: "completed live",
				},
			},
		});
		page.resolve(ok({ messages: [callMessage], nextByte: 12, hasMore: false }));
		await loading;

		expect(store.getState().tools.activeTools.size).toBe(1);
		expect(store.getState().tools.activeTools.get("call-1")).toMatchObject({
			status: "done",
			result: "completed live",
		});
	});

	it("keeps a new repeated live occurrence when only the earlier provider-ID occurrence was fetched", async () => {
		const page = Promise.withResolvers<RpcResponse>();
		const historicalCall = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/old" } }],
			timestamp: 9,
		} as AgentMessage;
		const historicalResult = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "old done" }],
			isError: false,
			timestamp: 10,
		} as AgentMessage;
		const liveCall = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/new" } }],
			timestamp: 11,
		} as AgentMessage;
		const store = createAgentViewStore(loader(async () => page.promise));

		const loading = store.getState().selectSubagent(snapshot("a1"));
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: {
					type: "message_update",
					message: liveCall,
					assistantMessageEvent: {
						type: "toolcall_delta",
						contentIndex: 0,
						delta: '{"path":',
						partial: liveCall,
					},
				},
			},
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "message_end", message: liveCall } },
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/new" } },
			},
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "new done" },
			},
		});
		page.resolve(ok({ messages: [historicalCall, historicalResult], nextByte: 12, hasMore: false }));
		await loading;

		expect(Array.from(store.getState().tools.activeTools.values()).map(entry => entry.status)).toEqual([
			"done",
			"done",
		]);
		expect(Array.from(store.getState().tools.activeTools.values()).map(entry => entry.args)).toEqual([
			{ path: "/old" },
			{ path: "/new" },
		]);
	});
	it("treats a page without hasMore as the complete legacy all-remainder response", async () => {
		const one = message("one legacy page", 5);
		const getSubagentMessages = vi
			.fn<AgentViewLoader["getSubagentMessages"]>()
			.mockResolvedValueOnce(ok({ messages: [one], nextByte: 12 }))
			.mockResolvedValueOnce(fail("unexpected second page"));
		const store = createAgentViewStore(loader(getSubagentMessages));

		await store.getState().selectSubagent(snapshot("a1"));

		expect(getSubagentMessages).toHaveBeenCalledTimes(1);
		expect(store.getState().loadState).toBe("ready");
		expect(store.getState().messages.messages).toEqual([one]);
	});
	it("loads a reconstructed historical agent from its persisted child session", async () => {
		const historical = message("persisted child result", 6);
		const getSubagentMessages = vi
			.fn<AgentViewLoader["getSubagentMessages"]>()
			.mockResolvedValue(fail("Unknown subagent"));
		const readPersistedSubagentTranscript = vi
			.fn<AgentViewLoader["readPersistedSubagentTranscript"]>()
			.mockResolvedValue({ ok: true, messages: [historical] });
		const store = createAgentViewStore(loader(getSubagentMessages, readPersistedSubagentTranscript));
		const selected = { ...snapshot("finished"), status: "unknown" };

		await store.getState().selectSubagent(selected);

		expect(readPersistedSubagentTranscript).toHaveBeenCalledWith("/tmp/finished.jsonl");
		expect(store.getState().loadState).toBe("ready");
		expect(store.getState().messages.messages).toEqual([historical]);
	});
	it("rejects stale pages after a later target selection", async () => {
		const aPage = Promise.withResolvers<RpcResponse>();
		const bPage = Promise.withResolvers<RpcResponse>();
		const getSubagentMessages = vi.fn(async (id?: string): Promise<RpcResponse> => {
			return id === "a" ? aPage.promise : bPage.promise;
		});
		const store = createAgentViewStore(loader(getSubagentMessages));

		const loadingA = store.getState().selectSubagent(snapshot("a"));
		const loadingB = store.getState().selectSubagent(snapshot("b"));
		bPage.resolve(ok({ messages: [message("new target", 2)], nextByte: 4, hasMore: false }));
		await loadingB;
		aPage.resolve(ok({ messages: [message("stale target", 1)], nextByte: 4, hasMore: false }));
		await loadingA;

		expect(store.getState().target).toEqual({ kind: "subagent", id: "b" });
		expect(store.getState().messages.messages).toEqual([message("new target", 2)]);
		expect(store.getState().loadState).toBe("ready");
	});

	it("keeps a failed selection visible and retries from the latest authoritative roster locator", async () => {
		const selected = snapshot("a1", "/sessions/old.jsonl");
		const refreshed = snapshot("a1", "/sessions/current.jsonl");
		const getSubagentMessages = vi
			.fn<AgentViewLoader["getSubagentMessages"]>()
			.mockResolvedValueOnce(fail("transcript unavailable"))
			.mockResolvedValueOnce(ok({ messages: [message("recovered", 3)], nextByte: 8, hasMore: false }));
		const store = createAgentViewStore(loader(getSubagentMessages));

		await store.getState().selectSubagent(selected);
		expect(store.getState()).toMatchObject({ target: { kind: "subagent", id: "a1" }, loadState: "error" });
		expect(store.getState().error).toBe("transcript unavailable");

		store.getState().reconcileRoster([refreshed]);
		await store.getState().reloadSelected();

		expect(getSubagentMessages).toHaveBeenLastCalledWith("a1", "/sessions/current.jsonl", 0);
		expect(store.getState().generation).toBe(2);
		expect(store.getState().loadState).toBe("ready");
		expect(store.getState().messages.messages).toEqual([message("recovered", 3)]);
	});

	it("selecting Main invalidates an in-flight load and restores Main immediately", async () => {
		const page = Promise.withResolvers<RpcResponse>();
		const store = createAgentViewStore(loader(async () => page.promise));

		const loading = store.getState().selectSubagent(snapshot("a1"));
		store.getState().selectMain();
		expect(store.getState()).toMatchObject({ target: { kind: "main" }, loadState: "idle", generation: 2 });
		page.resolve(ok({ messages: [message("late", 9)], nextByte: 4, hasMore: false }));
		await loading;

		expect(store.getState().target).toEqual({ kind: "main" });
		expect(store.getState().messages.messages).toEqual([]);
	});

	it("applies selected subagent events to isolated message and tool projections only", async () => {
		const store = createAgentViewStore(loader(async () => ok({ messages: [], nextByte: 0, hasMore: false })));
		await store.getState().selectSubagent(snapshot("a1"));
		const selectedMessage = message("selected", 5);

		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "other", event: { type: "message_end", message: message("ignored", 4) } },
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: { id: "a1", event: { type: "message_end", message: selectedMessage } },
		});
		store.getState().applyFrame({
			type: "subagent_event",
			payload: {
				id: "a1",
				event: { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "/tmp" } },
			},
		});

		expect(store.getState().messages.messages).toEqual([selectedMessage]);
		expect(store.getState().tools.activeTools.get("call-1")).toMatchObject({ toolName: "read", status: "running" });
	});

	it("falls back to Main immediately when an authoritative roster no longer contains the restored target", () => {
		const getSubagentMessages = vi.fn(
			async (): Promise<RpcResponse> => ok({ messages: [], nextByte: 0, hasMore: false }),
		);
		const store = createAgentViewStore(loader(getSubagentMessages));
		store.getState().restoreTarget({ kind: "subagent", id: "missing" });

		store.getState().reconcileRoster([]);

		expect(store.getState().target).toEqual({ kind: "main" });
		expect(store.getState().loadState).toBe("idle");
		expect(getSubagentMessages).not.toHaveBeenCalled();
	});

	it("retains a selected terminal target when it remains in the authoritative roster", () => {
		const store = createAgentViewStore(loader(async () => ok({ messages: [], nextByte: 0, hasMore: false })));
		store.getState().restoreTarget({ kind: "subagent", id: "done" });

		store.getState().reconcileRoster([{ ...snapshot("done"), status: "completed" }]);

		expect(store.getState().target).toEqual({ kind: "subagent", id: "done" });
	});

	it("does not infer authoritative absence when reload has no reconciled locator", async () => {
		const getSubagentMessages = vi.fn(
			async (): Promise<RpcResponse> => ok({ messages: [], nextByte: 0, hasMore: false }),
		);
		const store = createAgentViewStore(loader(getSubagentMessages));
		store.getState().restoreTarget({ kind: "subagent", id: "unconfirmed" });

		await store.getState().reloadSelected();

		expect(store.getState().target).toEqual({ kind: "subagent", id: "unconfirmed" });
		expect(getSubagentMessages).not.toHaveBeenCalled();
	});

	it("restores target identity while clearing projection bytes and reset invalidates it", async () => {
		const store = createAgentViewStore(
			loader(async () => ok({ messages: [message("transcript bytes", 6)], nextByte: 4, hasMore: false })),
		);
		await store.getState().selectSubagent(snapshot("a1"));
		const loadedGeneration = store.getState().generation;

		store.getState().restoreTarget({ kind: "subagent", id: "a1" });
		expect(store.getState().target).toEqual({ kind: "subagent", id: "a1" });
		expect(store.getState().messages.messages).toEqual([]);
		expect(store.getState().loadState).toBe("idle");
		expect(store.getState().generation).toBe(loadedGeneration + 1);

		store.getState().reset();
		expect(store.getState().target).toEqual({ kind: "main" });
		expect(store.getState().generation).toBe(loadedGeneration + 2);
	});
});
