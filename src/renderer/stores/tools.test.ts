import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent, ToolCallContent } from "../../shared/rpc-types";
import {
	applyToolProjectionEvents,
	createToolProjection,
	createToolsStore,
	hydrateToolProjection,
	resolveProjectionToolCall,
	toolEntryKey,
	useToolsStore,
} from "./tools";

function historyCall(id: string, timestamp = 1): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } }],
		timestamp,
	};
}

function historyResult(id: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: 2,
	};
}

const start = (toolCallId: string): AgentSessionEvent => ({
	type: "tool_execution_start",
	toolCallId,
	toolName: "read",
	args: { path: `${toolCallId}.ts` },
});

describe("tools store history rebuild", () => {
	it("ends an unanswered call from a finished turn instead of spinning forever", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([historyCall("read:0")]);

		expect(store.getState().activeTools.get("read:0")).toMatchObject({
			status: "aborted",
			endTime: null,
		});
	});

	it("keeps only the trailing unanswered call live while the turn is streaming", () => {
		const store = createToolsStore();
		const messages = [historyCall("first"), historyResult("first"), historyCall("last")];
		store.getState().hydrateMessages(messages, { turnIsLive: true });

		expect(store.getState().activeTools.get("first")).toMatchObject({ status: "done" });
		expect(store.getState().activeTools.get("last")).toMatchObject({ status: "running" });
	});

	it("aborts the trailing unanswered call once the session reports it is idle", () => {
		const store = createToolsStore();
		store
			.getState()
			.hydrateMessages([historyCall("first"), historyResult("first"), historyCall("last")], { turnIsLive: false });

		expect(store.getState().activeTools.get("last")).toMatchObject({ status: "aborted" });
	});

	it("promotes the aborted placeholder when a late execution event arrives", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([historyCall("read:0")]);
		store.getState().applyEvents([start("read:0")]);

		expect(store.getState().activeTools.size).toBe(1);
		expect(store.getState().activeTools.get("read:0")).toMatchObject({ status: "running" });

		store.getState().applyEvents([
			{
				type: "tool_execution_end",
				toolCallId: "read:0",
				toolName: "read",
				result: { content: [] },
				isError: false,
			},
		]);
		expect(store.getState().activeTools.get("read:0")).toMatchObject({ status: "done" });
	});

	it("does not resurrect an already answered call", () => {
		const store = createToolsStore();
		store.getState().hydrateMessages([historyCall("read:0"), historyResult("read:0")]);
		store.getState().applyEvents([start("read:0")]);

		expect(store.getState().activeTools.size).toBe(2);
		expect(store.getState().activeTools.get("read:0")).toMatchObject({ status: "done" });
	});
});


function toolCall(label: string): ToolCallContent {
	return {
		type: "toolCall",
		id: "read:0",
		name: "read",
		arguments: { path: label },
	};
}

function assistant(call: ToolCallContent, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [call],
		timestamp,
	};
}

function projectionResult(label: string, timestamp: number): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "read:0",
		toolName: "read",
		content: [{ type: "text", text: label }],
		isError: false,
		timestamp,
	};
}

beforeEach(() => useToolsStore.getState().reset());

describe("tool projections", () => {
	it("keeps repeated provider IDs occurrence-specific within each projection", () => {
		const firstCallA = toolCall("first-a");
		const firstCallB = toolCall("first-b");
		const secondCallA = toolCall("second-a");
		const secondCallB = toolCall("second-b");
		const first = hydrateToolProjection(createToolProjection(), [
			assistant(firstCallA, 1),
			projectionResult("first result a", 2),
			assistant(firstCallB, 3),
			projectionResult("first result b", 4),
		]);
		const second = hydrateToolProjection(createToolProjection(), [
			assistant(secondCallA, 5),
			projectionResult("second result a", 6),
			assistant(secondCallB, 7),
			projectionResult("second result b", 8),
		]);

		const firstA = resolveProjectionToolCall(first, firstCallA);
		const firstB = resolveProjectionToolCall(first, firstCallB);
		const secondA = resolveProjectionToolCall(second, secondCallA);
		const secondB = resolveProjectionToolCall(second, secondCallB);

		expect(first.activeTools).toHaveLength(2);
		expect(second.activeTools).toHaveLength(2);
		expect(firstA.key).toBe("read:0");
		expect(secondA.key).toBe("read:0");
		expect(firstB.key).not.toBe(firstA.key);
		expect(secondB.key).not.toBe(secondA.key);
		expect(firstB.entry?.args).toEqual({ path: "first-b" });
		expect(secondB.entry?.args).toEqual({ path: "second-b" });
		expect(firstB.entry?.result).toEqual({
			content: [{ type: "text", text: "first result b" }],
			details: null,
		});
		expect(secondB.entry?.result).toEqual({
			content: [{ type: "text", text: "second result b" }],
			details: null,
		});
	});

	it("keeps only the trailing unanswered occurrence live for an active projected turn", () => {
		const answered = toolCall("answered");
		const live = toolCall("live");
		const projection = hydrateToolProjection(
			createToolProjection(),
			[assistant(answered, 1), projectionResult("done", 2), assistant(live, 3)],
			{ turnIsLive: true },
		);

		expect(resolveProjectionToolCall(projection, answered).entry).toMatchObject({ status: "done" });
		expect(resolveProjectionToolCall(projection, live).entry).toMatchObject({ status: "running" });
	});

	it("settles unanswered projected calls as interrupted when the snapshot is idle", () => {
		const interrupted = toolCall("interrupted");
		const projection = hydrateToolProjection(createToolProjection(), [assistant(interrupted, 1)], {
			turnIsLive: false,
		});

		expect(resolveProjectionToolCall(projection, interrupted).entry).toMatchObject({ status: "aborted" });
	});

	it("routes a streamed repeated ID through final execution events", () => {
		const historicalCall = toolCall("history");
		let projection = hydrateToolProjection(createToolProjection(), [
			assistant(historicalCall, 1),
			projectionResult("historical result", 2),
		]);
		const partialCall = toolCall("streaming");
		const finalCall = toolCall("final");
		const partialMessage = assistant(partialCall, 3);
		const finalMessage = assistant(finalCall, 4);
		const events: AgentSessionEvent[] = [
			{
				type: "message_update",
				message: partialMessage,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: '{"path":',
					partial: partialMessage,
				},
			},
			{ type: "message_end", message: finalMessage },
			{
				type: "tool_execution_start",
				toolCallId: "read:0",
				toolName: "read",
				args: { path: "final" },
			},
			{
				type: "tool_execution_update",
				toolCallId: "read:0",
				toolName: "read",
				args: { path: "final" },
				partialResult: { bytes: 12 },
			},
			{
				type: "tool_execution_end",
				toolCallId: "read:0",
				toolName: "read",
				result: { content: "final output" },
				isError: false,
			},
		];

		projection = applyToolProjectionEvents(projection, events);

		const historical = resolveProjectionToolCall(projection, historicalCall);
		const streamed = resolveProjectionToolCall(projection, finalCall);
		expect(streamed.key).not.toBe(historical.key);
		expect(historical.entry?.result).toEqual({
			content: [{ type: "text", text: "historical result" }],
			details: null,
		});
		expect(streamed.entry).toMatchObject({
			toolName: "read",
			args: { path: "final" },
			status: "done",
			partialResult: { bytes: 12 },
			result: { content: "final output" },
			isError: false,
		});
	});

	it("does not let secondary hydration or reset alter Main", () => {
		const mainCall = toolCall("main");
		useToolsStore.getState().hydrateMessages([assistant(mainCall, 1), projectionResult("main result", 2)]);
		const mainTools = useToolsStore.getState().activeTools;
		const mainKey = toolEntryKey(mainCall);

		const secondaryCall = toolCall("secondary");
		let secondary = hydrateToolProjection(createToolProjection(), [
			assistant(secondaryCall, 3),
			projectionResult("secondary result", 4),
		]);
		secondary = createToolProjection();

		expect(secondary.activeTools).toHaveLength(0);
		expect(useToolsStore.getState().activeTools).toBe(mainTools);
		expect(useToolsStore.getState().activeTools.get(mainKey)?.args).toEqual({ path: "main" });
		expect(toolEntryKey(mainCall)).toBe(mainKey);
	});

	it("resolves the stable local key and entry for a concrete call object", () => {
		const firstCall = toolCall("first");
		const secondCall = toolCall("second");
		const projection = hydrateToolProjection(createToolProjection(), [
			assistant(firstCall, 1),
			assistant(secondCall, 2),
		]);

		const firstResolution = resolveProjectionToolCall(projection, secondCall);
		const secondResolution = resolveProjectionToolCall(projection, secondCall);

		expect(firstResolution.key).toBe(secondResolution.key);
		expect(firstResolution.entry).toBe(secondResolution.entry);
		expect(firstResolution.entry?.args).toEqual({ path: "second" });
	});

	it("does not copy active tools for batches without tool events", () => {
		const call = toolCall("kept");
		const projection = hydrateToolProjection(createToolProjection(), [assistant(call, 1)]);

		const next = applyToolProjectionEvents(projection, [{ type: "notice", level: "info", message: "unrelated" }]);

		expect(next).toBe(projection);
		expect(next.activeTools).toBe(projection.activeTools);
	});
});
