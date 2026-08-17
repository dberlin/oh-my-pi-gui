import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";
import {
	applyMessageProjectionEvents,
	createMessageProjection,
	type MessageProjection,
	useMessagesStore,
} from "./messages";

const streamingMessage: AgentMessage = {
	role: "assistant",
	content: [],
	timestamp: 1,
};

function delta(text: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: streamingMessage,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta: text,
			partial: streamingMessage,
		},
	};
}

function thinkingDelta(text: string): AgentSessionEvent {
	return {
		type: "message_update",
		message: streamingMessage,
		assistantMessageEvent: {
			type: "thinking_delta",
			contentIndex: 0,
			delta: text,
			partial: streamingMessage,
		},
	};
}

function userMessage(id: string): AgentMessage {
	return { role: "user", content: id, timestamp: Number(id.length), id };
}

beforeEach(() => useMessagesStore.getState().reset());

describe("message projections", () => {
	it("isolates interleaved streaming deltas and finalization", () => {
		let first = createMessageProjection();
		let second = createMessageProjection();
		const finalized: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "first answer" }],
			responseId: "response-1",
			timestamp: 2,
		};

		first = applyMessageProjectionEvents(first, [
			{ type: "message_start", message: streamingMessage },
			delta("first "),
			thinkingDelta("think first "),
		]);
		second = applyMessageProjectionEvents(second, [
			{ type: "message_start", message: streamingMessage },
			delta("second "),
			thinkingDelta("think second "),
		]);
		first = applyMessageProjectionEvents(first, [delta("answer"), thinkingDelta("done")]);
		second = applyMessageProjectionEvents(second, [delta("answer"), thinkingDelta("done")]);

		expect(first.streamingText).toBe("first answer");
		expect(first.streamingThinking).toBe("think first done");
		expect(second.streamingText).toBe("second answer");
		expect(second.streamingThinking).toBe("think second done");

		first = applyMessageProjectionEvents(first, [{ type: "message_end", message: finalized }]);

		expect(first.messages).toEqual([finalized]);
		expect(first.streamingMessage).toBeNull();
		expect(first.streamingText).toBe("");
		expect(first.streamingThinking).toBe("");
		expect(second.messages).toEqual([]);
		expect(second.streamingMessage).toBe(streamingMessage);
		expect(second.streamingText).toBe("second answer");
		expect(second.streamingThinking).toBe("think second done");
	});

	it("scopes delivery-key deduplication to each projection", () => {
		let first = createMessageProjection();
		let second = createMessageProjection();
		const finalized: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "shared delivery" }],
			responseId: "shared-response",
			timestamp: 3,
		};

		first = applyMessageProjectionEvents(first, [
			{ type: "agent_start" },
			{ type: "message_end", message: finalized },
			{ type: "turn_end", message: finalized },
		]);
		second = applyMessageProjectionEvents(second, [{ type: "turn_end", message: finalized }]);

		expect(first.messages).toEqual([finalized]);
		expect(second.messages).toEqual([finalized]);
	});

	it("resets one projection without changing another", () => {
		let first = applyMessageProjectionEvents(createMessageProjection(), [
			{ type: "message_start", message: streamingMessage },
			delta("discard"),
		]);
		const second = applyMessageProjectionEvents(createMessageProjection(), [
			{ type: "message_start", message: streamingMessage },
			delta("keep"),
		]);

		first = createMessageProjection();

		expect(first).toEqual<MessageProjection>({
			messages: [],
			streamingMessage: null,
			streamingText: "",
			streamingThinking: "",
			deliveredKeys: new Set(),
		});
		expect(second.streamingText).toBe("keep");
		expect(second.streamingMessage).toBe(streamingMessage);
	});
});
it("projects live IRC traffic immediately and deduplicates its later persisted delivery", () => {
	const incoming: AgentMessage = {
		role: "custom",
		customType: "irc:incoming",
		content: "[IRC from PlanReviewer]",
		display: true,
		details: { id: "irc-1", from: "PlanReviewer", message: "Review complete." },
		timestamp: 100,
	};
	let projection = applyMessageProjectionEvents(createMessageProjection(), [
		{ type: "irc_message", message: incoming },
	]);

	expect(projection.messages).toEqual([incoming]);

	projection = applyMessageProjectionEvents(projection, [
		{ type: "agent_start" },
		{ type: "message_start", message: incoming },
		{ type: "message_end", message: incoming },
	]);

	expect(projection.messages).toEqual([incoming]);
	expect(projection.streamingMessage).toBeNull();
});

describe("messages streaming snapshots", () => {
	it("resumes the accumulated prefix after switching away and back", () => {
		useMessagesStore.getState().applyEvents([{ type: "message_start", message: streamingMessage }, delta("hel")]);
		const snapshot = useMessagesStore.getState().snapshot();

		useMessagesStore.getState().applyEvents([delta("discarded")]);
		useMessagesStore.getState().restoreSnapshot(snapshot);
		useMessagesStore.getState().applyEvents([delta("lo")]);

		expect(useMessagesStore.getState().streamingText).toBe("hello");
	});

	it("starts a new stream from an empty buffer even when the start and delta share a batch", () => {
		useMessagesStore.setState({ streamingText: "old stream" });

		useMessagesStore.getState().applyEvents([{ type: "message_start", message: streamingMessage }, delta("new")]);

		expect(useMessagesStore.getState().streamingText).toBe("new");
	});
});

describe("agent-end delivery dedupe", () => {
	it("does not append a maintenance-rewritten copy of an already delivered tool result", () => {
		const original: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "full tool output" }],
			isError: false,
			timestamp: 10,
		};
		const shaken: AgentMessage = {
			...original,
			content: [{ type: "text", text: "[Shaken] 35 tokens – recover: artifact://0" }],
		};
		const next: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "read",
			content: [{ type: "text", text: "next result" }],
			isError: false,
			timestamp: 11,
		};

		useMessagesStore.getState().applyEvents([{ type: "agent_start" }, { type: "message_end", message: original }]);
		useMessagesStore.getState().applyEvents([{ type: "agent_end", messages: [shaken, next] }]);

		expect(useMessagesStore.getState().messages).toEqual([original, next]);
		expect(useMessagesStore.getState().totalMessages).toBe(2);
	});

	it("keeps response-id-less assistant tool calls distinct when their wire call ids differ", () => {
		const first: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-a", name: "read", arguments: {} }],
			timestamp: 20,
		};
		const second: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-b", name: "read", arguments: {} }],
			timestamp: 20,
		};

		useMessagesStore.getState().applyEvents([{ type: "message_end", message: first }]);
		useMessagesStore.getState().applyEvents([{ type: "agent_end", messages: [second] }]);

		expect(useMessagesStore.getState().messages).toEqual([first, second]);
	});
});

describe("reconcileFetched", () => {
	it("keeps the array identity when delivery keys match and contents are the same references", () => {
		const a = userMessage("a");
		const b = userMessage("b");
		useMessagesStore.setState({ messages: [a, b], totalMessages: 2 });
		const before = useMessagesStore.getState().messages;
		useMessagesStore.getState().reconcileFetched([a, b]);
		expect(useMessagesStore.getState().messages).toBe(before);
	});

	it("replaces wholesale when the identity sequence changes", () => {
		const a = userMessage("a");
		useMessagesStore.setState({ messages: [a], totalMessages: 1 });
		const next = userMessage("other");
		useMessagesStore.getState().reconcileFetched([next]);
		expect(useMessagesStore.getState().messages).toEqual([next]);
	});
});
