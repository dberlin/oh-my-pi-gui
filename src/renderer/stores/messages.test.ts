import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";
import { useMessagesStore } from "./messages";

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

beforeEach(() => useMessagesStore.getState().reset());

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
