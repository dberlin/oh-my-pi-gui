import { describe, expect, it } from "vitest";
import { createSessionRpcClient } from "./rpc-client";
import type { RpcResponse } from "./rpc-types";

describe("model RPC timeouts", () => {
	it("gives model switches enough time for provider/session reconfiguration", async () => {
		const calls: Array<{ type: string; timeoutMs: number | undefined }> = [];
		const response: RpcResponse = { type: "response", command: "set_model", success: true };
		const rpc = createSessionRpcClient(async (command, timeoutMs) => {
			calls.push({ type: command.type, timeoutMs });
			return response;
		});

		await rpc.setModel("openai", "gpt-test");
		await rpc.cycleModel();

		expect(calls).toEqual([
			{ type: "set_model", timeoutMs: 30_000 },
			{ type: "cycle_model", timeoutMs: 30_000 },
		]);
	});
});

describe("message pagination", () => {
	it("reassembles paged messages without requesting the oversized snapshot", async () => {
		const messages = [
			{ role: "user" as const, content: "first", timestamp: 1 },
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "second" }], timestamp: 2 },
		];
		const calls: Array<{ type: string; cursor: string | undefined; timeoutMs: number | undefined }> = [];
		const rpc = createSessionRpcClient(async (command, timeoutMs) => {
			if (command.type !== "get_messages_page" || (command.cursor !== undefined && command.cursor !== "next"))
				return { type: "response", command: command.type, success: false, error: "unexpected command" };
			calls.push({ type: command.type, cursor: command.cursor, timeoutMs });
			return {
				type: "response",
				command: "get_messages_page",
				success: true,
				data:
					command.cursor === undefined
						? { messages: [messages[0]], totalMessages: messages.length, nextCursor: "next" }
						: { messages: [messages[1]], totalMessages: messages.length },
			};
		});

		expect(await rpc.getMessages()).toEqual({
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages },
		});
		expect(calls).toEqual([
			{ type: "get_messages_page", cursor: undefined, timeoutMs: 30_000 },
			{ type: "get_messages_page", cursor: "next", timeoutMs: 30_000 },
		]);
	});

	it("falls back to the canonical snapshot on sidecars without pagination", async () => {
		const calls: string[] = [];
		const messages = [{ role: "user" as const, content: "legacy", timestamp: 1 }];
		const rpc = createSessionRpcClient(async command => {
			calls.push(command.type);
			if (command.type === "get_messages_page") {
				return { type: "response", command: command.type, success: false, error: "Unknown command" };
			}
			return { type: "response", command: command.type, success: true, data: { messages } };
		});
		expect(await rpc.getMessages()).toEqual({
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages },
		});
		expect(calls).toEqual(["get_messages_page", "get_messages"]);
	});

	it("discards partial pages when the next page fails", async () => {
		const calls: string[] = [];
		const messages = [{ role: "user" as const, content: "authoritative", timestamp: 1 }];
		const rpc = createSessionRpcClient(async command => {
			calls.push(command.type);
			if (command.type === "get_messages_page") {
				return command.cursor === undefined
					? {
							type: "response",
							command: command.type,
							success: true,
							data: {
								messages: [{ role: "user", content: "stale", timestamp: 0 }],
								totalMessages: 2,
								nextCursor: "next",
							},
						}
					: { type: "response", command: command.type, success: false, error: "Cursor expired" };
			}
			return { type: "response", command: command.type, success: true, data: { messages } };
		});
		expect(await rpc.getMessages()).toEqual({
			type: "response",
			command: "get_messages",
			success: true,
			data: { messages },
		});
		expect(calls).toEqual(["get_messages_page", "get_messages_page", "get_messages"]);
	});
});
