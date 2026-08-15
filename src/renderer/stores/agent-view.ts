import { create } from "zustand";
import type { IpcSubagentTranscriptReadResult } from "../../shared/ipc-types";
import type {
	AgentMessage,
	AgentSessionEvent,
	RpcResponse,
	SubagentFrame,
	SubagentSnapshot,
} from "../../shared/rpc-types";
import {
	applyMessageProjectionEvents,
	createMessageProjection,
	hydrateMessageProjection,
	type MessageProjection,
	messageIdentityKey,
} from "./messages";
import { applyToolProjectionEvents, createToolProjection, hydrateToolProjection, type ToolProjection } from "./tools";

export type AgentViewTarget = { kind: "main" } | { kind: "subagent"; id: string };

export interface AgentViewLoader {
	getSubagentMessages: (subagentId?: string, sessionFile?: string, fromByte?: number) => Promise<RpcResponse>;
	readPersistedSubagentTranscript: (sessionFile: string) => Promise<IpcSubagentTranscriptReadResult>;
}

export interface AgentViewStore {
	target: AgentViewTarget;
	loadState: "idle" | "loading" | "ready" | "error";
	error: string | null;
	messages: MessageProjection;
	tools: ToolProjection;
	generation: number;
	selectMain: () => void;
	selectSubagent: (snapshot: SubagentSnapshot) => Promise<void>;
	reloadSelected: () => Promise<void>;
	markSelectedLoadError: (error: string) => void;
	/** Update the selected locator or fall back when a successful authoritative roster omits it. */
	reconcileRoster: (snapshots: Iterable<SubagentSnapshot>) => void;
	/** Refresh the selected locator from a non-authoritative live roster update. */
	updateSnapshot: (snapshot: SubagentSnapshot) => void;
	applyFrame: (frame: SubagentFrame) => void;
	restoreTarget: (target: AgentViewTarget) => void;
	reset: () => void;
}

interface SubagentMessagesPage {
	messages?: AgentMessage[];
	nextByte?: number;
	hasMore?: boolean;
	reset?: boolean;
}

interface EmptyProjectionState {
	loadState: "idle";
	error: null;
	messages: MessageProjection;
	tools: ToolProjection;
}

function emptyProjectionState(): EmptyProjectionState {
	return {
		loadState: "idle",
		error: null,
		messages: createMessageProjection(),
		tools: createToolProjection(),
	};
}

function toolEventsMissingFromFetchedMessages(
	events: AgentSessionEvent[],
	fetchedMessages: AgentMessage[],
): AgentSessionEvent[] {
	const fetchedMessageKeys = new Set(fetchedMessages.map(messageIdentityKey));
	const resultCountByCallId = new Map<string, number>();
	for (const message of fetchedMessages) {
		if (message.role !== "toolResult" || !message.toolCallId) continue;
		resultCountByCallId.set(message.toolCallId, (resultCountByCallId.get(message.toolCallId) ?? 0) + 1);
	}
	const callIndexById = new Map<string, number>();
	const completionByMessageKey = new Map<string, Map<string, boolean[]>>();
	for (const message of fetchedMessages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const completionByCallId = new Map<string, boolean[]>();
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const callIndex = callIndexById.get(block.id) ?? 0;
			callIndexById.set(block.id, callIndex + 1);
			const fetchedComplete = callIndex < (resultCountByCallId.get(block.id) ?? 0);
			const completions = completionByCallId.get(block.id);
			if (completions) completions.push(fetchedComplete);
			else completionByCallId.set(block.id, [fetchedComplete]);
		}
		completionByMessageKey.set(messageIdentityKey(message), completionByCallId);
	}

	const suppressedIndexes = new Set<number>();
	const overlapQueueByCallId = new Map<string, boolean[]>();
	const runningFetchedCompletionByCallId = new Map<string, boolean>();
	let streamEventIndexes: number[] = [];

	for (const [index, event] of events.entries()) {
		switch (event.type) {
			case "message_start":
				streamEventIndexes = [index];
				break;
			case "message_update":
				streamEventIndexes.push(index);
				break;
			case "message_end": {
				const messageKey = messageIdentityKey(event.message);
				const overlapsFetched = fetchedMessageKeys.has(messageKey);
				if (overlapsFetched) {
					for (const streamIndex of streamEventIndexes) suppressedIndexes.add(streamIndex);
					suppressedIndexes.add(index);
				}
				streamEventIndexes = [];
				if (event.message.role !== "assistant" || !Array.isArray(event.message.content)) break;
				const fetchedCompletions = completionByMessageKey.get(messageKey);
				for (const block of event.message.content) {
					if (block.type !== "toolCall") continue;
					const fetchedComplete = fetchedCompletions?.get(block.id)?.shift() ?? false;
					const queue = overlapQueueByCallId.get(block.id);
					if (queue) queue.push(fetchedComplete);
					else overlapQueueByCallId.set(block.id, [fetchedComplete]);
				}
				break;
			}
			case "tool_execution_start": {
				const queue = overlapQueueByCallId.get(event.toolCallId);
				const fetchedComplete = queue?.shift() ?? false;
				if (queue?.length === 0) overlapQueueByCallId.delete(event.toolCallId);
				runningFetchedCompletionByCallId.set(event.toolCallId, fetchedComplete);
				if (fetchedComplete) suppressedIndexes.add(index);
				break;
			}
			case "tool_execution_update":
				if (runningFetchedCompletionByCallId.get(event.toolCallId)) suppressedIndexes.add(index);
				break;
			case "tool_execution_end":
				if (runningFetchedCompletionByCallId.get(event.toolCallId)) suppressedIndexes.add(index);
				runningFetchedCompletionByCallId.delete(event.toolCallId);
				break;
			default:
				break;
		}
	}

	return events.filter((_event, index) => !suppressedIndexes.has(index));
}

const defaultAgentViewLoader: AgentViewLoader = {
	getSubagentMessages: (subagentId, sessionFile, fromByte) =>
		window.omp.rpc.getSubagentMessages(subagentId, sessionFile, fromByte),
	readPersistedSubagentTranscript: sessionFile => window.omp.sessions.readSubagentTranscript(sessionFile),
};

export function createAgentViewStore(loader: AgentViewLoader = defaultAgentViewLoader) {
	let activeSnapshot: SubagentSnapshot | null = null;
	let rosterSnapshot: SubagentSnapshot | null = null;
	let loadingEvents: AgentSessionEvent[] = [];

	return create<AgentViewStore>()((set, get) => {
		const loadSnapshot = async (snapshot: SubagentSnapshot, generation: number): Promise<void> => {
			let fromByte = 0;
			let loadedMessages: AgentMessage[] = [];
			let loadedKeys = new Set<string>();
			const isCurrent = (): boolean => {
				const state = get();
				return (
					state.generation === generation &&
					state.target.kind === "subagent" &&
					state.target.id === snapshot.id &&
					activeSnapshot === snapshot
				);
			};

			try {
				for (;;) {
					const response = await loader.getSubagentMessages(snapshot.id, snapshot.sessionFile, fromByte);
					if (!isCurrent()) return;
					let page: SubagentMessagesPage | undefined;
					if (response.success) {
						page = response.data as SubagentMessagesPage | undefined;
					} else if (
						fromByte === 0 &&
						snapshot.sessionFile &&
						(snapshot.status === "unknown" ||
							snapshot.status === "completed" ||
							snapshot.status === "failed" ||
							snapshot.status === "aborted")
					) {
						const persisted = await loader.readPersistedSubagentTranscript(snapshot.sessionFile);
						if (!isCurrent()) return;
						if (!persisted.ok) throw new Error(persisted.error);
						page = { messages: persisted.messages, hasMore: false };
					} else {
						throw new Error(response.error);
					}
					const incoming = page?.messages ?? [];
					if (page?.reset) {
						loadedMessages = [];
						loadedKeys = new Set();
					}
					for (const message of incoming) {
						const key = messageIdentityKey(message);
						if (loadedKeys.has(key)) continue;
						loadedKeys.add(key);
						loadedMessages.push(message);
					}

					const liveProjection = applyMessageProjectionEvents(createMessageProjection(), loadingEvents);
					const projectedMessages = [...loadedMessages];
					const projectedKeys = new Set(loadedKeys);
					for (const message of liveProjection.messages) {
						const key = messageIdentityKey(message);
						if (projectedKeys.has(key)) continue;
						projectedKeys.add(key);
						projectedMessages.push(message);
					}
					const deliveredKeys = new Set(liveProjection.deliveredKeys);
					for (const key of loadedKeys) deliveredKeys.add(key);
					const messages = hydrateMessageProjection({ ...liveProjection, deliveredKeys }, projectedMessages);
					const toolEvents = toolEventsMissingFromFetchedMessages(loadingEvents, loadedMessages);
					const hydratedTools = hydrateToolProjection(createToolProjection(), loadedMessages);
					const tools = applyToolProjectionEvents(hydratedTools, toolEvents);
					if (!isCurrent()) return;
					set({ messages, tools });

					const nextByte = page?.nextByte ?? fromByte;
					const hasMore = page?.hasMore === true;
					if (!hasMore) break;
					if (nextByte <= fromByte) throw new Error("Subagent transcript pagination did not advance");
					fromByte = nextByte;
				}

				if (!isCurrent()) return;
				loadingEvents = [];
				set({ loadState: "ready", error: null });
			} catch (error) {
				if (!isCurrent()) return;
				set({ loadState: "error", error: error instanceof Error ? error.message : String(error) });
			}
		};

		return {
			target: { kind: "main" },
			...emptyProjectionState(),
			generation: 0,
			selectMain: () => {
				activeSnapshot = null;
				rosterSnapshot = null;
				loadingEvents = [];
				set(state => ({ target: { kind: "main" }, generation: state.generation + 1, ...emptyProjectionState() }));
			},
			selectSubagent: async snapshot => {
				const current = get();
				const preservePendingEvents =
					current.target.kind === "subagent" && current.target.id === snapshot.id && current.loadState !== "ready";
				rosterSnapshot = snapshot;
				activeSnapshot = snapshot;
				if (!preservePendingEvents) loadingEvents = [];
				const generation = current.generation + 1;
				set({
					target: { kind: "subagent", id: snapshot.id },
					generation,
					...emptyProjectionState(),
					loadState: "loading",
				});
				await loadSnapshot(snapshot, generation);
			},
			reloadSelected: async () => {
				const target = get().target;
				if (target.kind !== "subagent") return;
				const snapshot = rosterSnapshot;
				if (!snapshot || snapshot.id !== target.id) return;
				await get().selectSubagent(snapshot);
			},
			markSelectedLoadError: error => {
				if (get().target.kind === "subagent") set({ loadState: "error", error });
			},
			reconcileRoster: snapshots => {
				const target = get().target;
				if (target.kind !== "subagent") return;
				let selected: SubagentSnapshot | null = null;
				for (const snapshot of snapshots) {
					if (snapshot.id === target.id) {
						selected = snapshot;
						break;
					}
				}
				if (!selected) {
					get().selectMain();
					return;
				}
				rosterSnapshot = selected;
			},
			updateSnapshot: snapshot => {
				const target = get().target;
				if (target.kind === "subagent" && target.id === snapshot.id) rosterSnapshot = snapshot;
			},
			applyFrame: frame => {
				if (frame.type !== "subagent_event") return;
				const state = get();
				if (state.target.kind !== "subagent" || state.target.id !== frame.payload.id) return;
				const generation = state.generation;
				if (state.loadState !== "ready") loadingEvents.push(frame.payload.event);
				const messages = applyMessageProjectionEvents(state.messages, [frame.payload.event]);
				const tools = applyToolProjectionEvents(state.tools, [frame.payload.event]);
				const current = get();
				if (
					current.generation !== generation ||
					current.target.kind !== "subagent" ||
					current.target.id !== frame.payload.id
				) {
					return;
				}
				set({ messages, tools });
			},
			restoreTarget: target => {
				rosterSnapshot = null;
				activeSnapshot = null;
				loadingEvents = [];
				set(state => ({ target, generation: state.generation + 1, ...emptyProjectionState() }));
			},
			reset: () => {
				rosterSnapshot = null;
				activeSnapshot = null;
				loadingEvents = [];
				set(state => ({ target: { kind: "main" }, generation: state.generation + 1, ...emptyProjectionState() }));
			},
		};
	});
}

export const useAgentViewStore = createAgentViewStore();
