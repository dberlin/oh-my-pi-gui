import { create } from "zustand";
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";

export interface ToolEntry {
	toolName: string;
	args: Record<string, unknown>;
	status: "pending" | "running" | "done" | "error";
	partialResult: unknown;
	/** Accumulated raw args JSON string during streaming (before execution starts). */
	streamingArgs: string;
	result: unknown;
	isError: boolean;
	startTime: number;
	endTime: number | null;
}

interface ToolsStore {
	activeTools: Map<string, ToolEntry>;
	hydrateMessages: (messages: AgentMessage[]) => void;
	applyEvents: (events: AgentSessionEvent[]) => void;
	reset: () => void;
}

function timestampMs(value: string | number | undefined, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

export const useToolsStore = create<ToolsStore>()((set, get) => ({
	activeTools: new Map(),
	hydrateMessages: messages => {
		const now = Date.now();
		const results = new Map<string, AgentMessage>();
		for (const message of messages) {
			if (message.role === "toolResult" && message.toolCallId) {
				results.set(message.toolCallId, message);
			}
		}

		const tools = new Map<string, ToolEntry>();
		for (const message of messages) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const result = results.get(block.id);
				const startTime = timestampMs(message.timestamp, now);
				tools.set(block.id, {
					toolName: block.name,
					args: block.arguments,
					status: result ? (result.isError ? "error" : "done") : "running",
					partialResult: null,
					streamingArgs: "",
					// Keep the same `{content, details}` envelope as the live path so
					// renderers read history identically (details: diffs, exit codes,
					// todo phases, counts — previously dropped here).
					result: result ? { content: result.content ?? null, details: result.details ?? null } : null,
					isError: result?.isError ?? false,
					startTime,
					endTime: result ? timestampMs(result.timestamp, startTime) : null,
				});
			}
		}
		set({ activeTools: tools });
	},
	applyEvents: events => {
		// Copy-on-first-write: batches without tool events (the common case —
		// text/thinking deltas) must not pay an O(tools) Map clone per batch.
		let tools: Map<string, ToolEntry> | null = null;
		const writable = () => (tools ??= new Map(get().activeTools));

		for (const event of events) {
			switch (event.type) {
				case "message_update": {
					const ame = event.assistantMessageEvent;
					if (ame.type === "toolcall_delta") {
						const map = writable();
						const existing = map.get(ame.toolCallId);
						if (existing) {
							map.set(ame.toolCallId, {
								...existing,
								toolName: ame.name ?? existing.toolName,
								streamingArgs: existing.streamingArgs + (ame.argsDelta ?? ""),
							});
						} else {
							map.set(ame.toolCallId, {
								toolName: ame.name ?? "unknown",
								args: {},
								status: "pending",
								partialResult: null,
								streamingArgs: ame.argsDelta ?? "",
								result: null,
								isError: false,
								startTime: Date.now(),
								endTime: null,
							});
						}
					}
					break;
				}
				case "tool_execution_start": {
					writable().set(event.toolCallId, {
						toolName: event.toolName,
						args: event.args,
						status: "running",
						partialResult: null,
						streamingArgs: "",
						result: null,
						isError: false,
						startTime: Date.now(),
						endTime: null,
					});
					break;
				}
				case "tool_execution_update": {
					const existing = (tools ?? get().activeTools).get(event.toolCallId);
					if (existing) {
						writable().set(event.toolCallId, { ...existing, partialResult: event.partialResult });
					}
					break;
				}
				case "tool_execution_end": {
					const existing = (tools ?? get().activeTools).get(event.toolCallId);
					if (existing) {
						writable().set(event.toolCallId, {
							...existing,
							status: event.isError ? "error" : "done",
							result: event.result,
							isError: event.isError ?? false,
							endTime: Date.now(),
						});
					}
					break;
				}
				default:
					break;
			}
		}

		if (tools) {
			set({ activeTools: tools });
		}
	},
	reset: () => set({ activeTools: new Map() }),
}));
