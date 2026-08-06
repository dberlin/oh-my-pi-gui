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

/**
 * Provider tool-call ids are only required to be unique inside one assistant
 * message. Some providers therefore reuse ids such as `read:0` on every turn.
 * The GUI keeps the full transcript in one map, so raw ids cannot be map keys
 * on their own: later calls would overwrite earlier results.
 *
 * Call objects are bound to occurrence-specific store keys. The first
 * occurrence retains the raw id for compatibility; later occurrences get an
 * internal suffix. Live execution events still arrive with the raw id and are
 * routed through the queues below.
 */
let callEntryKeys = new WeakMap<object, string>();
let nextOccurrenceByCallId = new Map<string, number>();
let latestEntryKeyByCallId = new Map<string, string>();
let streamEntryKeysByIndex = new Map<number, string>();
let queuedExecutionKeysByCallId = new Map<string, string[]>();
let runningEntryKeyByCallId = new Map<string, string>();

function resetEntryKeyTracking(): void {
	callEntryKeys = new WeakMap();
	nextOccurrenceByCallId = new Map();
	latestEntryKeyByCallId = new Map();
	streamEntryKeysByIndex = new Map();
	queuedExecutionKeysByCallId = new Map();
	runningEntryKeyByCallId = new Map();
}

function allocateEntryKey(callId: string): string {
	const occurrence = nextOccurrenceByCallId.get(callId) ?? 0;
	nextOccurrenceByCallId.set(callId, occurrence + 1);
	const key = occurrence === 0 ? callId : `\u0000omp-tool:${JSON.stringify([callId, occurrence])}`;
	latestEntryKeyByCallId.set(callId, key);
	return key;
}

function bindCallEntryKey(call: object, callId: string, key: string): void {
	callEntryKeys.set(call, key);
	latestEntryKeyByCallId.set(callId, key);
}

/** Resolve the occurrence-specific store key for one transcript tool call. */
export function toolEntryKey(call: { id: string }): string {
	return callEntryKeys.get(call) ?? latestEntryKeyByCallId.get(call.id) ?? call.id;
}

function queueExecutionKey(callId: string, key: string): void {
	const queue = queuedExecutionKeysByCallId.get(callId);
	if (queue) queue.push(key);
	else queuedExecutionKeysByCallId.set(callId, [key]);
}

function takeExecutionKey(callId: string, tools: Map<string, ToolEntry>): string {
	const queue = queuedExecutionKeysByCallId.get(callId);
	const queued = queue?.shift();
	if (queue?.length === 0) queuedExecutionKeysByCallId.delete(callId);
	if (queued) return queued;

	const latest = latestEntryKeyByCallId.get(callId);
	const latestEntry = latest ? tools.get(latest) : undefined;
	if (latest && (latestEntry?.status === "pending" || latestEntry?.status === "running")) return latest;
	return allocateEntryKey(callId);
}

export const useToolsStore = create<ToolsStore>()((set, get) => ({
	activeTools: new Map(),
	hydrateMessages: messages => {
		const now = Date.now();
		resetEntryKeyTracking();

		// Pair repeated raw ids by occurrence, not with a last-write-wins map.
		const results = new Map<string, AgentMessage[]>();
		for (const message of messages) {
			if (message.role !== "toolResult" || !message.toolCallId) continue;
			const list = results.get(message.toolCallId);
			if (list) list.push(message);
			else results.set(message.toolCallId, [message]);
		}
		const resultIndexes = new Map<string, number>();

		const tools = new Map<string, ToolEntry>();
		for (const message of messages) {
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const key = allocateEntryKey(block.id);
				bindCallEntryKey(block, block.id, key);
				const resultIndex = resultIndexes.get(block.id) ?? 0;
				const result = results.get(block.id)?.[resultIndex];
				resultIndexes.set(block.id, resultIndex + 1);
				const startTime = timestampMs(message.timestamp, now);
				tools.set(key, {
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
				case "message_start": {
					streamEntryKeysByIndex.clear();
					break;
				}
				case "message_update": {
					const ame = event.assistantMessageEvent;
					if (ame.type === "toolcall_delta") {
						// The wire shape is `{contentIndex, delta, partial}` (pi-ai):
						// `partial` is the full streamed message so far and its
						// content[contentIndex] toolCall block carries the final
						// tool-call id from the very first delta.
						const block = Array.isArray(ame.partial?.content) ? ame.partial.content[ame.contentIndex] : null;
						if (block?.type !== "toolCall") break;
						let key = streamEntryKeysByIndex.get(ame.contentIndex);
						if (!key) {
							key = allocateEntryKey(block.id);
							streamEntryKeysByIndex.set(ame.contentIndex, key);
						}
						bindCallEntryKey(block, block.id, key);
						const map = writable();
						const existing = map.get(key);
						if (existing) {
							map.set(key, { ...existing, streamingArgs: existing.streamingArgs + (ame.delta ?? "") });
						} else {
							map.set(key, {
								toolName: block.name ?? "unknown",
								args: {},
								status: "pending",
								partialResult: null,
								streamingArgs: ame.delta ?? "",
								result: null,
								isError: false,
								startTime: Date.now(),
								endTime: null,
							});
						}
					}
					break;
				}
				case "message_end": {
					if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) break;
					const map = writable();
					for (const [contentIndex, block] of event.message.content.entries()) {
						if (block.type !== "toolCall") continue;
						const key = streamEntryKeysByIndex.get(contentIndex) ?? allocateEntryKey(block.id);
						bindCallEntryKey(block, block.id, key);
						queueExecutionKey(block.id, key);
						const existing = map.get(key);
						if (existing) {
							map.set(key, { ...existing, toolName: block.name, args: block.arguments });
						} else {
							map.set(key, {
								toolName: block.name,
								args: block.arguments,
								status: "pending",
								partialResult: null,
								streamingArgs: "",
								result: null,
								isError: false,
								startTime: timestampMs(event.message.timestamp, Date.now()),
								endTime: null,
							});
						}
					}
					streamEntryKeysByIndex.clear();
					break;
				}
				case "tool_execution_start": {
					const map = writable();
					const key = takeExecutionKey(event.toolCallId, map);
					latestEntryKeyByCallId.set(event.toolCallId, key);
					runningEntryKeyByCallId.set(event.toolCallId, key);
					map.set(key, {
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
					const key =
						runningEntryKeyByCallId.get(event.toolCallId) ?? latestEntryKeyByCallId.get(event.toolCallId);
					const existing = key ? (tools ?? get().activeTools).get(key) : undefined;
					if (key && existing) {
						writable().set(key, { ...existing, partialResult: event.partialResult });
					}
					break;
				}
				case "tool_execution_end": {
					const key =
						runningEntryKeyByCallId.get(event.toolCallId) ?? latestEntryKeyByCallId.get(event.toolCallId);
					const existing = key ? (tools ?? get().activeTools).get(key) : undefined;
					if (key && existing) {
						writable().set(key, {
							...existing,
							status: event.isError ? "error" : "done",
							result: event.result,
							isError: event.isError ?? false,
							endTime: Date.now(),
						});
					}
					runningEntryKeyByCallId.delete(event.toolCallId);
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
	reset: () => {
		resetEntryKeyTracking();
		set({ activeTools: new Map() });
	},
}));
