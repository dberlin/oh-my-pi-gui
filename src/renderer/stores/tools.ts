import { create } from "zustand";
import type { AgentMessage, AgentSessionEvent, ToolCallContent } from "../../shared/rpc-types";

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

export interface ToolProjection {
	activeTools: Map<string, ToolEntry>;
	callEntryKeys: WeakMap<object, string>;
	nextOccurrenceByCallId: Map<string, number>;
	latestEntryKeyByCallId: Map<string, string>;
	streamEntryKeysByIndex: Map<number, string>;
	queuedExecutionKeysByCallId: Map<string, string[]>;
	runningEntryKeyByCallId: Map<string, string>;
}

export interface ResolvedToolCall {
	key: string;
	entry: ToolEntry | undefined;
}

function timestampMs(value: string | number | undefined, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function allocateProjectionEntryKey(projection: ToolProjection, callId: string): string {
	const occurrence = projection.nextOccurrenceByCallId.get(callId) ?? 0;
	projection.nextOccurrenceByCallId.set(callId, occurrence + 1);
	const key = occurrence === 0 ? callId : `\u0000omp-tool:${JSON.stringify([callId, occurrence])}`;
	projection.latestEntryKeyByCallId.set(callId, key);
	return key;
}

function bindCallEntryKey(projection: ToolProjection, call: object, callId: string, key: string): void {
	projection.callEntryKeys.set(call, key);
	projection.latestEntryKeyByCallId.set(callId, key);
}

function queueExecutionKey(projection: ToolProjection, callId: string, key: string): void {
	const queue = projection.queuedExecutionKeysByCallId.get(callId);
	if (queue) queue.push(key);
	else projection.queuedExecutionKeysByCallId.set(callId, [key]);
}

function takeExecutionKey(projection: ToolProjection, callId: string, tools: Map<string, ToolEntry>): string {
	const queue = projection.queuedExecutionKeysByCallId.get(callId);
	const queued = queue?.shift();
	if (queue?.length === 0) projection.queuedExecutionKeysByCallId.delete(callId);
	if (queued) return queued;

	const latest = projection.latestEntryKeyByCallId.get(callId);
	const latestEntry = latest ? tools.get(latest) : undefined;
	if (latest && (latestEntry?.status === "pending" || latestEntry?.status === "running")) return latest;
	return allocateProjectionEntryKey(projection, callId);
}

export function createToolProjection(): ToolProjection {
	return {
		activeTools: new Map(),
		callEntryKeys: new WeakMap(),
		nextOccurrenceByCallId: new Map(),
		latestEntryKeyByCallId: new Map(),
		streamEntryKeysByIndex: new Map(),
		queuedExecutionKeysByCallId: new Map(),
		runningEntryKeyByCallId: new Map(),
	};
}

/**
 * Rebuild a transcript projection from scratch. Hydration deliberately resets
 * every occurrence and routing map so one transcript can never inherit another
 * transcript's provider-ID bindings.
 */
export function hydrateToolProjection(_projection: ToolProjection, messages: AgentMessage[]): ToolProjection {
	const projection = createToolProjection();
	const now = Date.now();
	const results = new Map<string, AgentMessage[]>();
	for (const message of messages) {
		if (message.role !== "toolResult" || !message.toolCallId) continue;
		const list = results.get(message.toolCallId);
		if (list) list.push(message);
		else results.set(message.toolCallId, [message]);
	}
	const resultIndexes = new Map<string, number>();

	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const key = allocateProjectionEntryKey(projection, block.id);
			bindCallEntryKey(projection, block, block.id, key);
			const resultIndex = resultIndexes.get(block.id) ?? 0;
			const result = results.get(block.id)?.[resultIndex];
			resultIndexes.set(block.id, resultIndex + 1);
			const startTime = timestampMs(message.timestamp, now);
			projection.activeTools.set(key, {
				toolName: block.name,
				args: block.arguments,
				status: result ? (result.isError ? "error" : "done") : "running",
				partialResult: null,
				streamingArgs: "",
				result: result ? { content: result.content ?? null, details: result.details ?? null } : null,
				isError: result?.isError ?? false,
				startTime,
				endTime: result ? timestampMs(result.timestamp, startTime) : null,
			});
		}
	}
	return projection;
}

export function resolveProjectionToolCall(projection: ToolProjection, call: ToolCallContent): ResolvedToolCall {
	const key = projection.callEntryKeys.get(call) ?? projection.latestEntryKeyByCallId.get(call.id) ?? call.id;
	return { key, entry: projection.activeTools.get(key) };
}

let mainToolProjection = createToolProjection();

/** Resolve the occurrence-specific store key for one Main transcript tool call. */
export function toolEntryKey(call: { id: string }): string {
	return (
		mainToolProjection.callEntryKeys.get(call) ?? mainToolProjection.latestEntryKeyByCallId.get(call.id) ?? call.id
	);
}

/** Build read-only tool results for a secondary transcript without mutating Main. */
export function buildTranscriptToolEntries(messages: AgentMessage[]): WeakMap<ToolCallContent, ToolEntry> {
	const projection = hydrateToolProjection(createToolProjection(), messages);
	const entries = new WeakMap<ToolCallContent, ToolEntry>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const entry = resolveProjectionToolCall(projection, block).entry;
			if (entry) entries.set(block, entry);
		}
	}
	return entries;
}
export function applyToolProjectionEvents(projection: ToolProjection, events: AgentSessionEvent[]): ToolProjection {
	// Copy-on-first-write: batches without tool events (the common case —
	// text/thinking deltas) must not pay an O(tools) Map clone per batch.
	let tools: Map<string, ToolEntry> | null = null;
	const writable = () => (tools ??= new Map(projection.activeTools));

	for (const event of events) {
		switch (event.type) {
			case "message_start": {
				projection.streamEntryKeysByIndex.clear();
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
					let key = projection.streamEntryKeysByIndex.get(ame.contentIndex);
					if (!key) {
						key = allocateProjectionEntryKey(projection, block.id);
						projection.streamEntryKeysByIndex.set(ame.contentIndex, key);
					}
					bindCallEntryKey(projection, block, block.id, key);
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
				for (const [contentIndex, block] of event.message.content.entries()) {
					if (block.type !== "toolCall") continue;
					const key =
						projection.streamEntryKeysByIndex.get(contentIndex) ??
						allocateProjectionEntryKey(projection, block.id);
					bindCallEntryKey(projection, block, block.id, key);
					queueExecutionKey(projection, block.id, key);
					const map = writable();
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
				projection.streamEntryKeysByIndex.clear();
				break;
			}
			case "tool_execution_start": {
				const map = writable();
				const key = takeExecutionKey(projection, event.toolCallId, map);
				projection.latestEntryKeyByCallId.set(event.toolCallId, key);
				projection.runningEntryKeyByCallId.set(event.toolCallId, key);
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
					projection.runningEntryKeyByCallId.get(event.toolCallId) ??
					projection.latestEntryKeyByCallId.get(event.toolCallId);
				const existing = key ? (tools ?? projection.activeTools).get(key) : undefined;
				if (key && existing) {
					writable().set(key, { ...existing, partialResult: event.partialResult });
				}
				break;
			}
			case "tool_execution_end": {
				const key =
					projection.runningEntryKeyByCallId.get(event.toolCallId) ??
					projection.latestEntryKeyByCallId.get(event.toolCallId);
				const existing = key ? (tools ?? projection.activeTools).get(key) : undefined;
				if (key && existing) {
					writable().set(key, {
						...existing,
						status: event.isError ? "error" : "done",
						result: event.result,
						isError: event.isError ?? false,
						endTime: Date.now(),
					});
				}
				projection.runningEntryKeyByCallId.delete(event.toolCallId);
				break;
			}
			default:
				break;
		}
	}

	return tools ? { ...projection, activeTools: tools } : projection;
}

export const useToolsStore = create<ToolsStore>()((set, get) => ({
	activeTools: mainToolProjection.activeTools,
	hydrateMessages: messages => {
		mainToolProjection = hydrateToolProjection(mainToolProjection, messages);
		set({ activeTools: mainToolProjection.activeTools });
	},
	applyEvents: events => {
		const state = get();
		mainToolProjection = { ...mainToolProjection, activeTools: state.activeTools };
		const nextProjection = applyToolProjectionEvents(mainToolProjection, events);
		mainToolProjection = nextProjection;
		if (nextProjection.activeTools !== state.activeTools) {
			set({ activeTools: nextProjection.activeTools });
		}
	},
	reset: () => {
		mainToolProjection = createToolProjection();
		set({ activeTools: mainToolProjection.activeTools });
	},
}));
