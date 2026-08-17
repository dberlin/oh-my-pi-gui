import { createStore } from "zustand/vanilla";
import type { AgentMessage, AgentSessionEvent, MessagesPage } from "../../shared/rpc-types";
import { messageIdentity, sameMessageContent } from "../lib/message-identity";
import { createScopedStoreHook } from "./session-runtime-context";
export interface MessageProjection {
	messages: AgentMessage[];
	streamingMessage: AgentMessage | null;
	streamingText: string;
	streamingThinking: string;
	deliveredKeys: Set<string>;
}


function assistantToolCallIds(message: AgentMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall" && typeof block.id === "string") ids.push(block.id);
	}
	return ids;
}

/** Match fetched and live projections without depending on newly assigned entry IDs. */
export function messageIdentityKey(message: AgentMessage): string {
	if (isIrcTranscriptMessage(message)) return ircMessageIdentityKey(message);
	const stableId =
		message.role === "assistant"
			? [message.responseId ?? null, assistantToolCallIds(message)]
			: message.role === "toolResult"
				? message.toolCallId
				: null;
	return JSON.stringify([message.role, stableId, message.timestamp]);
}

/**
 * Session-tab snapshot of committed history plus the active run overlay. The
 * accumulated strings are sufficient
 * to resume after a tab switch; keeping a second chunk-array copy only made
 * every snapshot and every join progressively more expensive.
 */
export interface MessagesSnapshot {
	messages: AgentMessage[];
	liveMessages: AgentMessage[];
	lastAppended: AgentMessage[];
	streamingMessage: AgentMessage | null;
	streamingText: string;
	streamingThinking: string;
	totalMessages: number;
	nextCursor: string | undefined;
	isLoadingPage: boolean;
}

export interface MessagesStore {
	messages: AgentMessage[];
	/** Uncommitted local echo and message_end deliveries for the active run. */
	liveMessages: AgentMessage[];
	/**
	 * Messages appended by the most recent applyEvents/appendMessage call —
	 * the voice auto-speak watcher's clean signal: hydration/pagination
	 * replaces `messages` wholesale without touching this field, so watchers
	 * only ever see genuinely new finalized messages (never history).
	 */
	lastAppended: AgentMessage[];
	streamingMessage: AgentMessage | null;
	streamingText: string;
	streamingThinking: string;
	totalMessages: number;
	nextCursor: string | undefined;
	isLoadingPage: boolean;
	applyEvents: (events: AgentSessionEvent[]) => void;
	loadPage: (page: MessagesPage) => void;
	appendMessage: (message: AgentMessage) => void;
	removeMessage: (message: AgentMessage) => void;
	appendLiveMessage: (message: AgentMessage) => void;
	removeLiveMessage: (message: AgentMessage) => void;
	/** Clear partial assistant stream buffers without touching committed or live rows. */
	clearStreaming: () => void;
	/** Drop delivered live rows after an idle transcript hydrate; keep unsent local echo. */
	clearDeliveredLiveMessages: () => void;
	/**
	 * Apply a fetched committed transcript. In-flight stable rows are merged by
	 * mergeFetchedTranscript before this replacement.
	 */
	reconcileFetched: (fetched: AgentMessage[]) => void;
	/** Capture the full stream state (fields + buffers) for a session-tab switch. */
	snapshot: () => MessagesSnapshot;
	/** Restore a captured snapshot; null resets to the empty initial state. */
	restoreSnapshot: (snapshot: MessagesSnapshot | null) => void;
	reset: () => void;
}

const initialState = {
	messages: [] as AgentMessage[],
	liveMessages: [] as AgentMessage[],
	lastAppended: [] as AgentMessage[],
	streamingMessage: null as AgentMessage | null,
	streamingText: "",
	streamingThinking: "",
	totalMessages: 0,
	nextCursor: undefined as string | undefined,
	isLoadingPage: false,
};

function isOptimisticUser(message: AgentMessage): boolean {
	return message.role === "user" && message.optimistic === true;
}

function appendLiveMessages(messages: AgentMessage[], delivered: AgentMessage[]): AgentMessage[] {
	let next = messages;
	for (const message of delivered) {
		const optimisticIndex =
			message.role === "user" && !message.steering
				? next.findIndex(entry => isOptimisticUser(entry) && !entry.optimisticDelivered)
				: -1;
		if (optimisticIndex >= 0) {
			const optimistic = next[optimisticIndex];
			next = [...next];
			next[optimisticIndex] = {
				...message,
				optimistic: true,
				optimisticDelivered: true,
				optimisticAfterEntryId: optimistic?.optimisticAfterEntryId,
			};
			continue;
		}
		next = [...next, message];
	}
	return next;
}

/** Match the delivered prompt after its anchor, without consuming an unrelated queued prompt. */
function optimisticUserWasCommitted(message: AgentMessage, fetched: AgentMessage[]): boolean {
	if (!isOptimisticUser(message) || message.optimisticAfterEntryId === undefined) return false;
	const anchorIndex =
		message.optimisticAfterEntryId === null
			? -1
			: fetched.findIndex(entry => entry.entryId === message.optimisticAfterEntryId);
	if (message.optimisticAfterEntryId !== null && anchorIndex < 0) return false;
	return fetched
		.slice(anchorIndex + 1)
		.some(entry => entry.entryId !== undefined && sameMessageContent(message, entry));
}

function upsertCommittedMessages(current: AgentMessage[], committed: AgentMessage[]): AgentMessage[] {
	const persisted = committed.filter(message => message.entryId);
	if (persisted.length === 0) return current;
	const indexByEntryId = new Map<string, number>();
	current.forEach((message, index) => {
		if (message.entryId) indexByEntryId.set(message.entryId, index);
	});
	const next = [...current];
	for (const message of persisted) {
		if (!message.entryId) continue;
		const index = indexByEntryId.get(message.entryId);
		if (index === undefined) {
			indexByEntryId.set(message.entryId, next.length);
			next.push(message);
		} else {
			next[index] = message;
		}
	}
	return next;
}

interface IrcTranscriptMessage extends AgentMessage {
	role: "custom";
	customType: "irc:incoming" | "irc:autoreply" | "irc:relay";
}

function isIrcTranscriptMessage(value: unknown): value is IrcTranscriptMessage {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		record.role === "custom" &&
		(record.customType === "irc:incoming" ||
			record.customType === "irc:autoreply" ||
			record.customType === "irc:relay") &&
		"content" in record
	);
}

function ircMessageIdentityKey(message: AgentMessage): string {
	if (!isIrcTranscriptMessage(message)) return "";
	const details =
		message.details != null && typeof message.details === "object" && !Array.isArray(message.details)
			? (message.details as Record<string, unknown>)
			: undefined;
	const stableId =
		typeof details?.id === "string"
			? details.id
			: [details?.from ?? null, details?.to ?? null, details?.replyTo ?? null, message.content];
	return JSON.stringify([message.customType, stableId, message.timestamp]);
}

function hasProjectedIrcMessage(
	current: readonly AgentMessage[],
	pending: readonly AgentMessage[],
	message: AgentMessage,
): boolean {
	const key = ircMessageIdentityKey(message);
	return (
		key.length > 0 &&
		(current.some(item => isIrcTranscriptMessage(item) && ircMessageIdentityKey(item) === key) ||
			pending.some(item => isIrcTranscriptMessage(item) && ircMessageIdentityKey(item) === key))
	);
}

/** Preserve only committed rows appended after a transcript request began. */
export function mergeFetchedTranscript(
	fetched: AgentMessage[],
	before: AgentMessage[],
	current: AgentMessage[],
): AgentMessage[] {
	const prefixIntact =
		current.length >= before.length &&
		before.every((message, index) => {
			const currentMessage = current[index];
			if (!currentMessage) return false;
			return message.entryId || currentMessage.entryId
				? message.entryId !== undefined && message.entryId === currentMessage.entryId
				: message === currentMessage;
		});
	if (!prefixIntact) return fetched;
	const fetchedIds = new Set(fetched.flatMap(message => (message.entryId ? [message.entryId] : [])));
	const tail = current.slice(before.length).filter(message => message.entryId && !fetchedIds.has(message.entryId));
	return tail.length === 0 ? fetched : [...fetched, ...tail];
}

/**
 * Live deliveries already form the transcript suffix. Attach persisted ids to
 * that overlap and append only the remaining run rows, never replacing history.
 */
function mergeRunMessages(current: AgentMessage[], run: AgentMessage[]): AgentMessage[] {
	if (run.length === 0) return current;
	if (current.length === 0) return run;
	const runKeys = run.map(messageIdentityKey);
	// Maintenance may rewrite a streamed row's identity. A full run aligned to
	// the current tail still owns those rows; preserve their live representation.
	const runStart = current.findLastIndex(message => messageIdentityKey(message) === runKeys[0]);
	if (runStart >= 0 && current.length - runStart === run.length) {
		let merged = current;
		for (let index = runStart; index < current.length; index++) {
			const entryId = run[index - runStart]?.entryId;
			if (!entryId || current[index].entryId === entryId) continue;
			if (merged === current) merged = [...current];
			merged[index] = { ...current[index], entryId };
		}
		return merged;
	}
	const maxOverlap = Math.min(current.length, run.length);
	const currentTailKeys = current.slice(current.length - maxOverlap).map(messageIdentityKey);
	let overlap = 0;
	for (let count = maxOverlap; count > 0; count--) {
		let matches = true;
		for (let index = 0; index < count; index++) {
			if (currentTailKeys[maxOverlap - count + index] !== runKeys[index]) {
				matches = false;
				break;
			}
		}
		if (matches) {
			overlap = count;
			break;
		}
	}
	let merged = current;
	for (let index = 0; index < overlap; index++) {
		const currentIndex = current.length - overlap + index;
		const entryId = run[index].entryId;
		if (!entryId || current[currentIndex].entryId === entryId) continue;
		if (merged === current) merged = [...current];
		merged[currentIndex] = { ...current[currentIndex], entryId };
	}
	if (overlap < run.length) {
		if (merged === current) merged = [...current];
		merged.push(...run.slice(overlap));
	}
	return merged;
}
export function createMessageProjection(): MessageProjection {
	return {
		messages: [],
		streamingMessage: null,
		streamingText: "",
		streamingThinking: "",
		deliveredKeys: new Set(),
	};
}

export function hydrateMessageProjection(projection: MessageProjection, messages: AgentMessage[]): MessageProjection {
	if (messages === projection.messages) return projection;
	return { ...projection, messages };
}

export function applyMessageProjectionEvents(
	projection: MessageProjection,
	events: AgentSessionEvent[],
): MessageProjection {
	let deliveredKeys = projection.deliveredKeys;
	let deliveredKeysCopied = false;
	let textAccum = "";
	let thinkAccum = "";
	const newMessages: AgentMessage[] = [];
	let runMessages: AgentMessage[] | null = null;
	let streamingStart: AgentMessage | null = null;
	let streamingEnd = false;

	for (const event of events) {
		switch (event.type) {
			case "agent_start": {
				deliveredKeys = new Set();
				deliveredKeysCopied = true;
				break;
			}
			case "irc_message": {
				if (!isIrcTranscriptMessage(event.message)) break;
				if (hasProjectedIrcMessage(projection.messages, newMessages, event.message)) break;
				newMessages.push(event.message);
				if (!deliveredKeysCopied) {
					deliveredKeys = new Set(deliveredKeys);
					deliveredKeysCopied = true;
				}
				deliveredKeys.add(messageIdentityKey(event.message));
				break;
			}
			case "message_start": {
				if (
					isIrcTranscriptMessage(event.message) &&
					hasProjectedIrcMessage(projection.messages, newMessages, event.message)
				) {
					break;
				}
				streamingStart =
					event.message.timestamp === undefined || event.message.timestamp === null
						? { ...event.message, timestamp: Date.now() }
						: event.message;
				textAccum = "";
				thinkAccum = "";
				break;
			}
			case "message_update": {
				const { assistantMessageEvent } = event;
				if (assistantMessageEvent.type === "text_delta") {
					textAccum += assistantMessageEvent.delta;
				} else if (assistantMessageEvent.type === "thinking_delta") {
					thinkAccum += assistantMessageEvent.delta;
				}
				break;
			}
			case "message_end": {
				if (
					isIrcTranscriptMessage(event.message) &&
					hasProjectedIrcMessage(projection.messages, newMessages, event.message)
				) {
					break;
				}
				const key = messageIdentityKey(event.message);
				if (!deliveredKeys.has(key)) newMessages.push(event.message);
				if (!deliveredKeysCopied) {
					deliveredKeys = new Set(deliveredKeys);
					deliveredKeysCopied = true;
				}
				deliveredKeys.add(key);
				streamingEnd = true;
				break;
			}
			case "agent_end": {
				if (event.messages) {
					runMessages = event.messages;
					if (!deliveredKeysCopied) {
						deliveredKeys = new Set(deliveredKeys);
						deliveredKeysCopied = true;
					}
					for (const message of event.messages) deliveredKeys.add(messageIdentityKey(message));
				}
				break;
			}
			case "turn_end": {
				if (event.message) {
					const key = messageIdentityKey(event.message);
					if (!deliveredKeys.has(key)) {
						newMessages.push(event.message);
						if (!deliveredKeysCopied) {
							deliveredKeys = new Set(deliveredKeys);
							deliveredKeysCopied = true;
						}
						deliveredKeys.add(key);
					}
				}
				break;
			}
			default:
				break;
		}
	}

	let streamingMessage = projection.streamingMessage;
	let streamingText = projection.streamingText;
	let streamingThinking = projection.streamingThinking;
	if (streamingStart) {
		streamingMessage = streamingStart;
		streamingText = "";
		streamingThinking = "";
	}
	if (textAccum) streamingText = `${streamingStart ? "" : projection.streamingText}${textAccum}`;
	if (thinkAccum) streamingThinking = `${streamingStart ? "" : projection.streamingThinking}${thinkAccum}`;

	let messages = projection.messages;
	if (newMessages.length > 0) messages = [...messages, ...newMessages];
	if (runMessages) messages = mergeRunMessages(messages, runMessages);
	if (streamingEnd || runMessages) {
		streamingMessage = null;
		streamingText = "";
		streamingThinking = "";
	}

	return {
		messages,
		streamingMessage,
		streamingText,
		streamingThinking,
		deliveredKeys,
	};
}


export const createMessagesStore = () =>
	createStore<MessagesStore>()((set, get) => ({
		...initialState,
		applyEvents: events => {
			const state = get();
			let { messages, liveMessages, streamingMessage, streamingText, streamingThinking } = state;
			for (const event of events) {
				switch (event.type) {
					case "message_start":
						// Only assistant messages stream. Other deliveries are atomic.
						if (event.message.role !== "assistant") break;
						streamingMessage = event.message;
						streamingText = "";
						streamingThinking = "";
						break;
					case "message_update": {
						const update = event.assistantMessageEvent;
						if (update.type === "text_delta") streamingText += update.delta;
						else if (update.type === "thinking_delta") streamingThinking += update.delta;
						break;
					}
					case "message_end":
						liveMessages = appendLiveMessages(liveMessages, [event.message]);
						if (event.message.role === "assistant") {
							streamingMessage = null;
							streamingText = "";
							streamingThinking = "";
						}
						break;
					case "agent_end":
						if (event.messages) {
							messages = upsertCommittedMessages(messages, event.messages);
							if (event.messages.some(message => message.entryId)) {
								// A prompt queued locally after this run ended is not part of its commit.
								liveMessages = liveMessages.filter(
									message =>
										isOptimisticUser(message) &&
										!message.optimisticDelivered &&
										!optimisticUserWasCommitted(message, messages),
								);
							}
						}
						streamingMessage = null;
						streamingText = "";
						streamingThinking = "";
						break;
				}
			}
			if (
				messages === state.messages &&
				liveMessages === state.liveMessages &&
				streamingMessage === state.streamingMessage &&
				streamingText === state.streamingText &&
				streamingThinking === state.streamingThinking
			)
				return;
			// Preserve wire order above; publish only once per presentation frame.
			const appended = messages.slice(state.messages.length);
			set({
				messages,
				liveMessages,
				streamingMessage,
				streamingText,
				streamingThinking,
				...(messages !== state.messages ? { totalMessages: messages.length } : {}),
				...(appended.length > 0 ? { lastAppended: appended } : {}),
			});
		},
		loadPage: page =>
			set({
				messages: page.messages,
				liveMessages: [],
				lastAppended: [],
				totalMessages: page.totalMessages,
				nextCursor: page.nextCursor,
				isLoadingPage: false,
			}),
		appendMessage: message =>
			set(s => ({
				messages: [...s.messages, message],
				lastAppended: [message],
				totalMessages: s.totalMessages + 1,
			})),
		/** Drop a locally appended placeholder (e.g. the composer's running-eval bubble) by identity. */
		removeMessage: message =>
			set(s => {
				const messages = s.messages.filter(entry => entry !== message);
				const removed = s.messages.length - messages.length;
				if (removed === 0) return s;
				return { messages, totalMessages: Math.max(0, s.totalMessages - removed) };
			}),
		appendLiveMessage: message => set(s => ({ liveMessages: [...s.liveMessages, message] })),
		removeLiveMessage: message => set(s => ({ liveMessages: s.liveMessages.filter(entry => entry !== message) })),
		clearStreaming: () => set({ streamingMessage: null, streamingText: "", streamingThinking: "" }),
		clearDeliveredLiveMessages: () =>
			set(s => ({
				liveMessages: s.liveMessages.filter(message => isOptimisticUser(message) && !message.optimisticDelivered),
			})),
		reconcileFetched: fetched => {
			const state = get();
			const committedByIdentity = new Map<string, AgentMessage[]>();
			for (const message of fetched) {
				const identity = messageIdentity(message);
				if (!message.entryId || !identity) continue;
				const matches = committedByIdentity.get(identity);
				if (matches) matches.push(message);
				else committedByIdentity.set(identity, [message]);
			}
			const liveMessages = state.liveMessages.filter(message => {
				const identity = messageIdentity(message);
				const matches = identity ? committedByIdentity.get(identity) : undefined;
				const index = matches?.findIndex(entry => sameMessageContent(message, entry)) ?? -1;
				if (index >= 0) {
					matches?.splice(index, 1);
					return false;
				}
				return !optimisticUserWasCommitted(message, fetched);
			});
			const messagesUnchanged =
				fetched.length === state.messages.length &&
				fetched.every((message, index) => message === state.messages[index]);
			if (messagesUnchanged && liveMessages.length === state.liveMessages.length) return;
			set({
				messages: fetched,
				liveMessages: liveMessages.length === state.liveMessages.length ? state.liveMessages : liveMessages,
				totalMessages: fetched.length,
			});
		},
		snapshot: () => {
			const state = get();
			return {
				messages: state.messages,
				liveMessages: state.liveMessages,
				lastAppended: state.lastAppended,
				streamingMessage: state.streamingMessage,
				streamingText: state.streamingText,
				streamingThinking: state.streamingThinking,
				totalMessages: state.totalMessages,
				nextCursor: state.nextCursor,
				isLoadingPage: state.isLoadingPage,
			};
		},
		restoreSnapshot: snapshot => {
			if (!snapshot) {
				get().reset();
				return;
			}
			set({
				messages: snapshot.messages,
				liveMessages: snapshot.liveMessages,
				lastAppended: snapshot.lastAppended,
				streamingMessage: snapshot.streamingMessage,
				streamingText: snapshot.streamingText,
				streamingThinking: snapshot.streamingThinking,
				totalMessages: snapshot.totalMessages,
				nextCursor: snapshot.nextCursor,
				isLoadingPage: snapshot.isLoadingPage,
			});
		},
		reset: () => set(initialState),
	}));

const defaultMessagesStore = createMessagesStore();
export const useMessagesStore = createScopedStoreHook("messages", defaultMessagesStore);
