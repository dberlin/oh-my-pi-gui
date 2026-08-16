import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent, ToolCallContent } from "../../shared/rpc-types";
import {
	applyToolProjectionEvents,
	createToolProjection,
	hydrateToolProjection,
	reconcileStreamingToolProjection,
	resolveProjectionToolCall,
	toolEntryKey,
	useToolsStore,
} from "./tools";

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

function result(label: string, timestamp: number): AgentMessage {
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
			result("first result a", 2),
			assistant(firstCallB, 3),
			result("first result b", 4),
		]);
		const second = hydrateToolProjection(createToolProjection(), [
			assistant(secondCallA, 5),
			result("second result a", 6),
			assistant(secondCallB, 7),
			result("second result b", 8),
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

	it("routes a streamed repeated ID through final execution events", () => {
		const historicalCall = toolCall("history");
		let projection = hydrateToolProjection(createToolProjection(), [
			assistant(historicalCall, 1),
			result("historical result", 2),
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
		useToolsStore.getState().hydrateMessages([assistant(mainCall, 1), result("main result", 2)]);
		const mainTools = useToolsStore.getState().activeTools;
		const mainKey = toolEntryKey(mainCall);

		const secondaryCall = toolCall("secondary");
		let secondary = hydrateToolProjection(createToolProjection(), [
			assistant(secondaryCall, 3),
			result("secondary result", 4),
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

	it("rebases mixed restored and streaming same-id occurrences independently", () => {
		const restoredCall = toolCall("restored-running");
		let projection = hydrateToolProjection(createToolProjection(), [assistant(restoredCall, 1)]);
		const streamingCall = toolCall("streaming");
		const streamingMessage = assistant(streamingCall, 2);
		projection = applyToolProjectionEvents(projection, [
			{
				type: "message_update",
				message: streamingMessage,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: '{"path":',
					partial: streamingMessage,
				},
			},
		]);
		const hydrationStartRevision = projection.toolEventRevision;
		const fetchedCall = toolCall("restored-running");

		projection = reconcileStreamingToolProjection(
			projection,
			[assistant(fetchedCall, 1)],
			hydrationStartRevision,
			true,
		);

		const fetched = resolveProjectionToolCall(projection, fetchedCall);
		const streamed = resolveProjectionToolCall(projection, streamingCall);
		expect(projection.activeTools).toHaveLength(2);
		expect(fetched.key).toBe("read:0");
		expect(streamed.key).not.toBe(fetched.key);
		expect(fetched.entry).toMatchObject({
			args: { path: "restored-running" },
			status: "running",
		});
		expect(streamed.entry).toMatchObject({
			status: "pending",
			streamingArgs: '{"path":',
		});

		const finalCall = toolCall("streaming-final");
		projection = applyToolProjectionEvents(projection, [
			{ type: "message_end", message: assistant(finalCall, 3) },
			{
				type: "tool_execution_start",
				toolCallId: finalCall.id,
				toolName: finalCall.name,
				args: finalCall.arguments,
			},
			{
				type: "tool_execution_end",
				toolCallId: finalCall.id,
				toolName: finalCall.name,
				result: "streaming result",
				isError: false,
			},
		]);

		expect(resolveProjectionToolCall(projection, fetchedCall).entry).toMatchObject({
			args: { path: "restored-running" },
			status: "running",
		});
		expect(resolveProjectionToolCall(projection, finalCall).entry).toMatchObject({
			args: { path: "streaming-final" },
			status: "done",
			result: "streaming result",
		});
	});

	it("trusts a fetched settled occurrence over an untouched restored running entry", () => {
		const restoredCall = toolCall("restored-running");
		const restored = hydrateToolProjection(createToolProjection(), [assistant(restoredCall, 1)]);
		const hydrationStartRevision = restored.toolEventRevision;
		const fetchedCall = toolCall("fetched-settled");

		const reconciled = reconcileStreamingToolProjection(
			restored,
			[assistant(fetchedCall, 1), result("fetched result", 2)],
			hydrationStartRevision,
			true,
		);

		expect(resolveProjectionToolCall(reconciled, fetchedCall).entry).toMatchObject({
			args: { path: "fetched-settled" },
			status: "done",
			result: {
				content: [{ type: "text", text: "fetched result" }],
				details: null,
			},
		});
	});

	it("does not copy active tools for batches without tool events", () => {
		const call = toolCall("kept");
		const projection = hydrateToolProjection(createToolProjection(), [assistant(call, 1)]);

		const next = applyToolProjectionEvents(projection, [{ type: "notice", level: "info", message: "unrelated" }]);

		expect(next).toBe(projection);
		expect(next.activeTools).toBe(projection.activeTools);
	});
});
