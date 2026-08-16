import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent, ToolCallContent } from "../../shared/rpc-types";
import {
	applyToolProjectionEvents,
	buildTranscriptToolEntries,
	createToolProjection,
	createToolsStore,
	hydrateToolProjection,
	reconcileStreamingToolProjection,
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

	it("does not revive an earlier unanswered occurrence during a later live turn", () => {
		const store = createToolsStore();
		const interrupted = toolCall("interrupted");
		const live = toolCall("live");
		store.getState().hydrateMessages([assistant(interrupted, 1), assistant(live, 2)], { turnIsLive: true });

		expect(store.getState().activeTools.get(toolEntryKey(interrupted))).toMatchObject({ status: "aborted" });
		expect(store.getState().activeTools.get(toolEntryKey(live))).toMatchObject({ status: "running" });
		expect(toolEntryKey(interrupted)).not.toBe(toolEntryKey(live));
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

	it("preserves historical and live occurrence state in read-only transcript entries", () => {
		const interrupted = toolCall("interrupted");
		const live = toolCall("live");
		const entries = buildTranscriptToolEntries([assistant(interrupted, 1), assistant(live, 2)], {
			turnIsLive: true,
		});

		expect(entries.get(interrupted)).toMatchObject({ args: { path: "interrupted" }, status: "aborted" });
		expect(entries.get(live)).toMatchObject({ args: { path: "live" }, status: "running" });
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

	it("rebases mixed restored and streaming same-id occurrences independently", () => {
		const restoredCall = toolCall("restored-running");
		let projection = hydrateToolProjection(createToolProjection(), [assistant(restoredCall, 1)], {
			turnIsLive: true,
		});
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
		const restored = hydrateToolProjection(createToolProjection(), [assistant(restoredCall, 1)], {
			turnIsLive: true,
		});
		const hydrationStartRevision = restored.toolEventRevision;
		const fetchedCall = toolCall("fetched-settled");

		const reconciled = reconcileStreamingToolProjection(
			restored,
			[assistant(fetchedCall, 1), projectionResult("fetched result", 2)],
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

	it("settles an untouched restored call when a newer fetched turn is live", () => {
		const restoredCall = toolCall("interrupted");
		const restored = hydrateToolProjection(createToolProjection(), [assistant(restoredCall, 1)], {
			turnIsLive: true,
		});
		const fetchedInterrupted = toolCall("interrupted");
		const fetchedLive = toolCall("live");
		const reconciled = reconcileStreamingToolProjection(
			restored,
			[assistant(fetchedInterrupted, 1), assistant(fetchedLive, 2)],
			restored.toolEventRevision,
			true,
		);

		expect(resolveProjectionToolCall(reconciled, fetchedInterrupted).entry).toMatchObject({ status: "aborted" });
		expect(resolveProjectionToolCall(reconciled, fetchedLive).entry).toMatchObject({ status: "running" });
	});

	it.each(["pending", "running", "done", "error"] as const)(
		"keeps a finalized %s call bound when a stale fetch inserts an older reused ID",
		status => {
			const live = toolCall("live");
			let projection = createToolProjection();
			const hydrationStartRevision = projection.toolEventRevision;
			projection = applyToolProjectionEvents(projection, [{ type: "message_end", message: assistant(live, 3) }]);
			if (status !== "pending") {
				projection = applyToolProjectionEvents(projection, [start(live.id)]);
			}
			if (status === "done" || status === "error") {
				projection = applyToolProjectionEvents(projection, [
					{
						type: "tool_execution_end",
						toolCallId: live.id,
						toolName: live.name,
						result: { content: "live result" },
						isError: status === "error",
					},
				]);
			}
			const historical = toolCall("historical");
			projection = reconcileStreamingToolProjection(
				projection,
				[assistant(historical, 1), projectionResult("historical result", 2)],
				hydrationStartRevision,
				status === "pending" || status === "running",
			);

			const resolvedLive = resolveProjectionToolCall(projection, live);
			const resolvedHistorical = resolveProjectionToolCall(projection, historical);
			expect(resolvedLive.key).not.toBe(resolvedHistorical.key);
			expect(toolEntryKey(live)).toBe(resolvedLive.key);
			expect(resolvedLive.entry).toMatchObject({
				status,
				result: status === "done" || status === "error" ? { content: "live result" } : null,
			});
			expect(resolvedHistorical.entry).toMatchObject({
				status: "done",
				result: { content: [{ type: "text", text: "historical result" }], details: null },
			});

			if (status === "pending" || status === "running") {
				projection = applyToolProjectionEvents(projection, [
					...(status === "pending" ? [start(live.id)] : []),
					{
						type: "tool_execution_update",
						toolCallId: live.id,
						toolName: live.name,
						args: live.arguments,
						partialResult: { bytes: 12 },
					},
					{
						type: "tool_execution_end",
						toolCallId: live.id,
						toolName: live.name,
						result: { content: "live result" },
						isError: false,
					},
				]);
				expect(resolveProjectionToolCall(projection, live).entry).toMatchObject({
					status: "done",
					partialResult: { bytes: 12 },
					result: { content: "live result" },
				});
				expect(resolveProjectionToolCall(projection, historical).entry?.result).toEqual({
					content: [{ type: "text", text: "historical result" }],
					details: null,
				});
			}
		},
	);

	it("keeps original and fetched call objects together across later occurrence rebases", () => {
		const live = toolCall("live");
		let projection = applyToolProjectionEvents(createToolProjection(), [
			{ type: "message_end", message: assistant(live, 5) },
		]);
		const fetchedLive = toolCall("live");
		projection = reconcileStreamingToolProjection(projection, [assistant(fetchedLive, 5)], 0, true);
		const historical = toolCall("historical");
		const refetchedLive = toolCall("live");
		projection = reconcileStreamingToolProjection(
			projection,
			[assistant(historical, 1), projectionResult("historical result", 2), assistant(refetchedLive, 5)],
			0,
			true,
		);
		projection = applyToolProjectionEvents(projection, [
			start(live.id),
			{
				type: "tool_execution_end",
				toolCallId: live.id,
				toolName: live.name,
				result: { content: "live result" },
				isError: false,
			},
		]);

		for (const call of [live, fetchedLive, refetchedLive]) {
			expect(resolveProjectionToolCall(projection, call).entry).toMatchObject({
				status: "done",
				result: { content: "live result" },
			});
			expect(toolEntryKey(call)).toBe(resolveProjectionToolCall(projection, call).key);
		}
		expect(resolveProjectionToolCall(projection, historical).entry?.result).toEqual({
			content: [{ type: "text", text: "historical result" }],
			details: null,
		});
	});

	it("preserves finalized duplicate execution queue order after an older occurrence is fetched", () => {
		const first = toolCall("first");
		const second = toolCall("second");
		let projection = applyToolProjectionEvents(createToolProjection(), [
			{ type: "message_end", message: assistant(first, 3) },
			{ type: "message_end", message: assistant(second, 4) },
		]);
		const historical = toolCall("historical");
		projection = reconcileStreamingToolProjection(
			projection,
			[assistant(historical, 1), projectionResult("historical result", 2)],
			0,
			true,
		);

		for (const [call, result] of [[first, "first result"], [second, "second result"]] as const) {
			projection = applyToolProjectionEvents(projection, [
				{
					type: "tool_execution_start",
					toolCallId: call.id,
					toolName: call.name,
					args: call.arguments,
				},
				{
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result,
					isError: false,
				},
			]);
		}

		expect(resolveProjectionToolCall(projection, first).entry).toMatchObject({
			args: { path: "first" },
			status: "done",
			result: "first result",
		});
		expect(resolveProjectionToolCall(projection, second).entry).toMatchObject({
			args: { path: "second" },
			status: "done",
			result: "second result",
		});
		expect(resolveProjectionToolCall(projection, historical).entry?.result).toEqual({
			content: [{ type: "text", text: "historical result" }],
			details: null,
		});
	});

	it("keeps a completion arriving during an idle transcript fetch attached to its occurrence", () => {
		const historical = toolCall("historical");
		const live = toolCall("live");
		let projection = hydrateToolProjection(
			createToolProjection(),
			[assistant(historical, 1), projectionResult("historical result", 2), assistant(live, 3)],
			{ turnIsLive: true },
		);
		const hydrationStartRevision = projection.toolEventRevision;
		projection = applyToolProjectionEvents(projection, [
			start(live.id),
			{
				type: "tool_execution_end",
				toolCallId: live.id,
				toolName: live.name,
				result: { content: "late completion" },
				isError: false,
			},
		]);
		const fetchedHistorical = toolCall("historical");
		const fetchedLive = toolCall("live");
		const reconciled = reconcileStreamingToolProjection(
			projection,
			[assistant(fetchedHistorical, 1), projectionResult("historical result", 2), assistant(fetchedLive, 3)],
			hydrationStartRevision,
			false,
		);

		expect(resolveProjectionToolCall(reconciled, fetchedHistorical).entry).toMatchObject({
			status: "done",
			result: { content: [{ type: "text", text: "historical result" }], details: null },
		});
		expect(resolveProjectionToolCall(reconciled, fetchedLive).entry).toMatchObject({
			args: { path: "read:0.ts" },
			status: "done",
			result: { content: "late completion" },
		});
		expect(resolveProjectionToolCall(reconciled, fetchedLive).key).not.toBe(
			resolveProjectionToolCall(reconciled, fetchedHistorical).key,
		);
	});
});
