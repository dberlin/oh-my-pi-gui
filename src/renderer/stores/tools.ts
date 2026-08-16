import { create } from "zustand";
import type { AgentMessage, AgentSessionEvent, ToolCallContent } from "../../shared/rpc-types";
import { messageIdentityKey } from "./messages";

export interface ToolEntry {
	toolName: string;
	args: Record<string, unknown>;
	status: "pending" | "running" | "done" | "error";
	partialResult: unknown;
	/** Accumulated raw args JSON string during streaming (before execution starts). */
	streamingArgs: string;
	result: unknown;
	isError: boolean;
	streamGeneration?: number;
	lastToolEventRevision?: number;
	assistantMessageIdentity?: string;
	assistantContentIndex?: number;
	startTime: number;
	endTime: number | null;
}

interface ToolsStore {
	activeTools: Map<string, ToolEntry>;
	streamGeneration: number;
	snapshotProjection: () => ToolProjection;
	restoreProjection: (projection: ToolProjection | null) => void;
	hydrateMessages: (messages: AgentMessage[]) => void;
	reconcileStreamingMessages: (
		messages: AgentMessage[],
		hydrationStartToolEventRevision: number,
		authoritativeStreaming: boolean,
	) => void;
	applyEvents: (events: AgentSessionEvent[]) => void;
	reset: () => void;
}

export interface ToolProjection {
	activeTools: Map<string, ToolEntry>;
	streamGeneration: number;
	toolEventRevision: number;
	callEntryKeys: WeakMap<object, string>;
	nextOccurrenceByCallId: Map<string, number>;
	latestEntryKeyByCallId: Map<string, string>;
	streamEntryKeysByIndex: Map<number, string>;
	streamCallObjectsByIndex: Map<number, ToolCallContent>;
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

function occurrenceEntryKey(callId: string, occurrence: number): string {
	return occurrence === 0 ? callId : `\u0000omp-tool:${JSON.stringify([callId, occurrence])}`;
}

function allocateProjectionEntryKey(projection: ToolProjection, callId: string): string {
	const occurrence = projection.nextOccurrenceByCallId.get(callId) ?? 0;
	projection.nextOccurrenceByCallId.set(callId, occurrence + 1);
	const key = occurrenceEntryKey(callId, occurrence);
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
		streamGeneration: 0,
		toolEventRevision: 0,
		callEntryKeys: new WeakMap(),
		nextOccurrenceByCallId: new Map(),
		latestEntryKeyByCallId: new Map(),
		streamEntryKeysByIndex: new Map(),
		streamCallObjectsByIndex: new Map(),
		queuedExecutionKeysByCallId: new Map(),
		runningEntryKeyByCallId: new Map(),
	};
}

/**
 * Rebuild a transcript projection from scratch. Hydration deliberately resets
 * every occurrence and routing map so one transcript can never inherit another
 * transcript's provider-ID bindings.
 */
export function hydrateToolProjection(source: ToolProjection, messages: AgentMessage[]): ToolProjection {
	const projection = createToolProjection();
	projection.toolEventRevision = source.toolEventRevision;
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
		for (const [contentIndex, block] of message.content.entries()) {
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
				streamGeneration: 0,
				lastToolEventRevision: 0,
				assistantMessageIdentity: messageIdentityKey(message),
				assistantContentIndex: contentIndex,
				startTime,
				endTime: result ? timestampMs(result.timestamp, startTime) : null,
			});
		}
	}
	return projection;
}

export function reconcileStreamingToolProjection(
	projection: ToolProjection,
	messages: AgentMessage[],
	hydrationStartToolEventRevision: number,
	authoritativeStreaming: boolean,
): ToolProjection {
	const reconciled = hydrateToolProjection(createToolProjection(), messages);
	const rebasedKeys = new Map<string, string>();
	const currentEntriesByCallId = new Map<string, { key: string; entry: ToolEntry; occurrence: number }[]>();

	for (const [callId, count] of projection.nextOccurrenceByCallId) {
		for (let occurrence = 0; occurrence < count; occurrence++) {
			const key = occurrenceEntryKey(callId, occurrence);
			const entry = projection.activeTools.get(key);
			if (!entry) continue;
			const isAuthoritativeActive =
				authoritativeStreaming && (entry.status === "pending" || entry.status === "running");
			const wasTouchedDuringHydration = (entry.lastToolEventRevision ?? 0) > hydrationStartToolEventRevision;
			if (!isAuthoritativeActive && !wasTouchedDuringHydration) continue;
			const entries = currentEntriesByCallId.get(callId);
			if (entries) entries.push({ key, entry, occurrence });
			else currentEntriesByCallId.set(callId, [{ key, entry, occurrence }]);
		}
	}

	const streamingKeys = new Set(projection.streamEntryKeysByIndex.values());
	for (const [callId, entries] of currentEntriesByCallId) {
		const hydratedCount = reconciled.nextOccurrenceByCallId.get(callId) ?? 0;
		const hydratedEntries: { key: string; entry: ToolEntry }[] = [];
		for (let occurrence = 0; occurrence < hydratedCount; occurrence++) {
			const key = occurrenceEntryKey(callId, occurrence);
			const entry = reconciled.activeTools.get(key);
			if (entry) hydratedEntries.push({ key, entry });
		}

		const claimedHydratedKeys = new Set<string>();
		const matchedHydratedKeyByCurrentKey = new Map<string, string>();
		const identityCandidates: typeof entries = [];
		const fallbackCandidates: typeof entries = [];
		for (const candidate of entries) {
			if (streamingKeys.has(candidate.key)) continue;
			if (
				candidate.entry.assistantMessageIdentity !== undefined &&
				candidate.entry.assistantContentIndex !== undefined
			) {
				identityCandidates.push(candidate);
			} else {
				fallbackCandidates.push(candidate);
			}
		}

		for (let candidateIndex = identityCandidates.length - 1; candidateIndex >= 0; candidateIndex--) {
			const candidate = identityCandidates[candidateIndex];
			if (!candidate) continue;
			for (let hydratedIndex = hydratedEntries.length - 1; hydratedIndex >= 0; hydratedIndex--) {
				const hydrated = hydratedEntries[hydratedIndex];
				if (
					!hydrated ||
					claimedHydratedKeys.has(hydrated.key) ||
					hydrated.entry.assistantMessageIdentity !== candidate.entry.assistantMessageIdentity ||
					hydrated.entry.assistantContentIndex !== candidate.entry.assistantContentIndex
				) {
					continue;
				}
				claimedHydratedKeys.add(hydrated.key);
				matchedHydratedKeyByCurrentKey.set(candidate.key, hydrated.key);
				break;
			}
		}

		let fallbackHydratedIndex = hydratedEntries.length - 1;
		for (let candidateIndex = fallbackCandidates.length - 1; candidateIndex >= 0; candidateIndex--) {
			const candidate = fallbackCandidates[candidateIndex];
			if (!candidate) continue;
			while (
				fallbackHydratedIndex >= 0 &&
				claimedHydratedKeys.has(hydratedEntries[fallbackHydratedIndex]?.key ?? "")
			) {
				fallbackHydratedIndex -= 1;
			}
			const hydrated = hydratedEntries[fallbackHydratedIndex];
			if (!hydrated) break;
			claimedHydratedKeys.add(hydrated.key);
			matchedHydratedKeyByCurrentKey.set(candidate.key, hydrated.key);
			fallbackHydratedIndex -= 1;
		}

		let nextOccurrence = hydratedCount;
		for (const { key, entry } of entries) {
			let rebasedKey = matchedHydratedKeyByCurrentKey.get(key);
			const isRepresented = rebasedKey !== undefined;
			if (rebasedKey === undefined) {
				rebasedKey = occurrenceEntryKey(callId, nextOccurrence);
				nextOccurrence += 1;
			}
			const fetchedEntry = isRepresented ? reconciled.activeTools.get(rebasedKey) : undefined;
			const wasTouchedDuringHydration = (entry.lastToolEventRevision ?? 0) > hydrationStartToolEventRevision;
			if (
				isRepresented &&
				!wasTouchedDuringHydration &&
				(fetchedEntry?.status === "done" || fetchedEntry?.status === "error")
			) {
				continue;
			}
			rebasedKeys.set(key, rebasedKey);
			reconciled.activeTools.set(rebasedKey, entry);
			reconciled.latestEntryKeyByCallId.set(callId, rebasedKey);
		}
		reconciled.nextOccurrenceByCallId.set(callId, nextOccurrence);
	}

	reconciled.streamGeneration = projection.streamGeneration;
	reconciled.toolEventRevision = projection.toolEventRevision;
	reconciled.streamEntryKeysByIndex = new Map();
	reconciled.streamCallObjectsByIndex = new Map();
	for (const [index, key] of projection.streamEntryKeysByIndex) {
		const rebasedKey = rebasedKeys.get(key);
		const call = projection.streamCallObjectsByIndex.get(index);
		if (rebasedKey === undefined || call === undefined) continue;
		reconciled.streamEntryKeysByIndex.set(index, rebasedKey);
		reconciled.streamCallObjectsByIndex.set(index, call);
		bindCallEntryKey(reconciled, call, call.id, rebasedKey);
	}
	reconciled.queuedExecutionKeysByCallId = new Map();
	for (const [callId, keys] of projection.queuedExecutionKeysByCallId) {
		const rebased: string[] = [];
		for (const key of keys) {
			const rebasedKey = rebasedKeys.get(key);
			if (rebasedKey !== undefined) rebased.push(rebasedKey);
		}
		if (rebased.length > 0) reconciled.queuedExecutionKeysByCallId.set(callId, rebased);
	}
	reconciled.runningEntryKeyByCallId = new Map();
	for (const [callId, key] of projection.runningEntryKeyByCallId) {
		const rebasedKey = rebasedKeys.get(key);
		if (rebasedKey !== undefined) reconciled.runningEntryKeyByCallId.set(callId, rebasedKey);
	}
	for (const [callId, key] of projection.latestEntryKeyByCallId) {
		const rebasedKey = rebasedKeys.get(key);
		if (rebasedKey !== undefined) reconciled.latestEntryKeyByCallId.set(callId, rebasedKey);
	}

	return reconciled;
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
	let streamGeneration = projection.streamGeneration;
	let toolEventRevision = projection.toolEventRevision;
	const writable = () => (tools ??= new Map(projection.activeTools));

	for (const event of events) {
		switch (event.type) {
			case "message_start": {
				streamGeneration += 1;
				projection.streamEntryKeysByIndex.clear();
				projection.streamCallObjectsByIndex.clear();
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
					const revision = ++toolEventRevision;
					let key = projection.streamEntryKeysByIndex.get(ame.contentIndex);
					if (!key) {
						key = allocateProjectionEntryKey(projection, block.id);
						projection.streamEntryKeysByIndex.set(ame.contentIndex, key);
					}
					bindCallEntryKey(projection, block, block.id, key);
					projection.streamCallObjectsByIndex.set(ame.contentIndex, block);
					const map = writable();
					const existing = map.get(key);
					if (existing) {
						map.set(key, {
							...existing,
							streamingArgs: existing.streamingArgs + (ame.delta ?? ""),
							lastToolEventRevision: revision,
							assistantMessageIdentity: messageIdentityKey(event.message),
							assistantContentIndex: ame.contentIndex,
						});
					} else {
						map.set(key, {
							toolName: block.name ?? "unknown",
							args: {},
							status: "pending",
							partialResult: null,
							streamingArgs: ame.delta ?? "",
							result: null,
							isError: false,
							streamGeneration,
							lastToolEventRevision: revision,
							assistantMessageIdentity: messageIdentityKey(event.message),
							assistantContentIndex: ame.contentIndex,
							startTime: Date.now(),
							endTime: null,
						});
					}
				}
				break;
			}
			case "message_end": {
				if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) break;
				let revision: number | undefined;
				for (const [contentIndex, block] of event.message.content.entries()) {
					if (block.type !== "toolCall") continue;
					revision ??= ++toolEventRevision;
					const key =
						projection.streamEntryKeysByIndex.get(contentIndex) ??
						allocateProjectionEntryKey(projection, block.id);
					bindCallEntryKey(projection, block, block.id, key);
					queueExecutionKey(projection, block.id, key);
					const map = writable();
					const existing = map.get(key);
					if (existing) {
						map.set(key, {
							...existing,
							toolName: block.name,
							args: block.arguments,
							lastToolEventRevision: revision,
							assistantMessageIdentity: messageIdentityKey(event.message),
							assistantContentIndex: contentIndex,
						});
					} else {
						map.set(key, {
							toolName: block.name,
							args: block.arguments,
							status: "pending",
							partialResult: null,
							streamingArgs: "",
							result: null,
							isError: false,
							streamGeneration,
							lastToolEventRevision: revision,
							assistantMessageIdentity: messageIdentityKey(event.message),
							assistantContentIndex: contentIndex,
							startTime: timestampMs(event.message.timestamp, Date.now()),
							endTime: null,
						});
					}
				}
				projection.streamEntryKeysByIndex.clear();
				projection.streamCallObjectsByIndex.clear();
				break;
			}
			case "tool_execution_start": {
				const revision = ++toolEventRevision;
				const map = writable();
				const key = takeExecutionKey(projection, event.toolCallId, map);
				const existing = map.get(key);
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
					streamGeneration,
					lastToolEventRevision: revision,
					assistantMessageIdentity: existing?.assistantMessageIdentity,
					assistantContentIndex: existing?.assistantContentIndex,
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
					const revision = ++toolEventRevision;
					writable().set(key, {
						...existing,
						partialResult: event.partialResult,
						lastToolEventRevision: revision,
					});
				}
				break;
			}
			case "tool_execution_end": {
				const key =
					projection.runningEntryKeyByCallId.get(event.toolCallId) ??
					projection.latestEntryKeyByCallId.get(event.toolCallId);
				const existing = key ? (tools ?? projection.activeTools).get(key) : undefined;
				if (key && existing) {
					const revision = ++toolEventRevision;
					writable().set(key, {
						...existing,
						status: event.isError ? "error" : "done",
						result: event.result,
						isError: event.isError ?? false,
						endTime: Date.now(),
						lastToolEventRevision: revision,
					});
				}
				projection.runningEntryKeyByCallId.delete(event.toolCallId);
				break;
			}
			default:
				break;
		}
	}

	return tools ||
		streamGeneration !== projection.streamGeneration ||
		toolEventRevision !== projection.toolEventRevision
		? {
				...projection,
				activeTools: tools ?? projection.activeTools,
				streamGeneration,
				toolEventRevision,
			}
		: projection;
}

export const useToolsStore = create<ToolsStore>()((set, get) => ({
	activeTools: mainToolProjection.activeTools,
	streamGeneration: mainToolProjection.streamGeneration,
	snapshotProjection: () => {
		const state = get();
		if (
			mainToolProjection.activeTools !== state.activeTools ||
			mainToolProjection.streamGeneration !== state.streamGeneration
		) {
			mainToolProjection = {
				...mainToolProjection,
				activeTools: state.activeTools,
				streamGeneration: state.streamGeneration,
			};
		}
		return mainToolProjection;
	},
	restoreProjection: projection => {
		mainToolProjection = projection ?? createToolProjection();
		set({
			activeTools: mainToolProjection.activeTools,
			streamGeneration: mainToolProjection.streamGeneration,
		});
	},
	hydrateMessages: messages => {
		mainToolProjection = hydrateToolProjection(mainToolProjection, messages);
		set({
			activeTools: mainToolProjection.activeTools,
			streamGeneration: mainToolProjection.streamGeneration,
		});
	},
	reconcileStreamingMessages: (messages, hydrationStartToolEventRevision, authoritativeStreaming) => {
		mainToolProjection = reconcileStreamingToolProjection(
			mainToolProjection,
			messages,
			hydrationStartToolEventRevision,
			authoritativeStreaming,
		);
		set({
			activeTools: mainToolProjection.activeTools,
			streamGeneration: mainToolProjection.streamGeneration,
		});
	},
	applyEvents: events => {
		const state = get();
		mainToolProjection = {
			...mainToolProjection,
			activeTools: state.activeTools,
			streamGeneration: state.streamGeneration,
		};
		const nextProjection = applyToolProjectionEvents(mainToolProjection, events);
		mainToolProjection = nextProjection;
		if (
			nextProjection.activeTools !== state.activeTools ||
			nextProjection.streamGeneration !== state.streamGeneration
		) {
			set({
				activeTools: nextProjection.activeTools,
				streamGeneration: nextProjection.streamGeneration,
			});
		}
	},
	reset: () => {
		mainToolProjection = createToolProjection();
		set({
			activeTools: mainToolProjection.activeTools,
			streamGeneration: mainToolProjection.streamGeneration,
		});
	},
}));
