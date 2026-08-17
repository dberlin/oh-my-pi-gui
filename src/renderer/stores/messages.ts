import { create } from "zustand";
import type { AgentMessage, AgentSessionEvent, MessagesPage } from "../../shared/rpc-types";

export interface MessageProjection {
	messages: AgentMessage[];
	streamingMessage: AgentMessage | null;
	streamingText: string;
	streamingThinking: string;
	deliveredKeys: Set<string>;
}

/**
 * Session-tab snapshot of the message stream: the zustand fields PLUS the
 * streaming fields and run-dedupe set. The accumulated strings are sufficient
 * to resume after a tab switch; keeping a second chunk-array copy only made
 * every snapshot and every join progressively more expensive.
 */
export interface MessagesSnapshot {
	messages: AgentMessage[];
	lastAppended: AgentMessage[];
	streamingMessage: AgentMessage | null;
	streamingText: string;
	streamingThinking: string;
	totalMessages: number;
	nextCursor: string | undefined;
	isLoadingPage: boolean;
	deliveredKeys: string[];
}

interface MessagesStore {
	messages: AgentMessage[];
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
	/** Clear the live-stream slice and chunk buffers without touching history —
	 * for a run that settled unseen (background tab: its message_end/agent_end
	 * never forwarded), where hydrate's transcript merge owns the final content. */
	clearStreaming: () => void;
	/**
	 * Apply a fetched transcript. When delivery identities match the current
	 * prefix, patch in place instead of replacing the array (avoids a second
	 * paint after tab restore). A different identity sequence replaces wholesale.
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
	lastAppended: [] as AgentMessage[],
	streamingMessage: null as AgentMessage | null,
	streamingText: "",
	streamingThinking: "",
	totalMessages: 0,
	nextCursor: undefined as string | undefined,
	isLoadingPage: false,
};

function assistantToolCallIds(message: AgentMessage): string[] {
	if (message.role !== "assistant") return [];
	const content: unknown = message.content;
	if (!Array.isArray(content)) return [];
	const blocks: unknown[] = content;
	const ids: string[] = [];
	for (const block of blocks) {
		if (
			block !== null &&
			typeof block === "object" &&
			"type" in block &&
			block.type === "toolCall" &&
			"id" in block &&
			typeof block.id === "string"
		) {
			ids.push(block.id);
		}
	}
	return ids;
}

/**
 * Delivery identity for run-local dedupe. Message content is intentionally
 * excluded: post-turn maintenance may rewrite a tool result (for example,
 * replacing its full text with a shake marker) before `agent_end` re-delivers
 * the run. Those are two representations of one message, not two transcript
 * entries.
 *
 * Provider response ids and tool-call ids strengthen the timestamp identity
 * where the wire exposes them.
 */
export function messageIdentityKey(message: AgentMessage): string {
	const stableId =
		message.role === "assistant"
			? [message.responseId ?? null, assistantToolCallIds(message)]
			: message.role === "toolResult"
				? message.toolCallId
				: null;
	return JSON.stringify([message.role, stableId, message.timestamp]);
}
function isIrcTranscriptMessage(value: unknown): value is AgentMessage {
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

/** True when `fetched` starts with the same delivery identities as `current`. */
export function sameIdentityPrefix(current: AgentMessage[], fetched: AgentMessage[]): boolean {
	const limit = Math.min(current.length, fetched.length);
	if (limit === 0) return current.length === 0 && fetched.length === 0;
	for (let i = 0; i < limit; i++) {
		const left = current[i];
		const right = fetched[i];
		if (!left || !right || messageIdentityKey(left) !== messageIdentityKey(right)) return false;
	}
	return true;
}

/**
 * Merge run-scoped agent_end messages onto the transcript. Messages streamed
 * live via message_end (or hydrated mid-run) already form a suffix of the
 * current list, so find the longest delivery-identity prefix of `run` matching
 * that suffix and append only the remainder. History is never replaced.
 */
function mergeRunMessages(current: AgentMessage[], run: AgentMessage[]): AgentMessage[] {
	if (run.length === 0) return current;
	if (current.length === 0) return run;
	const maxOverlap = Math.min(current.length, run.length);
	const runKeys = run.map(messageIdentityKey);
	const currentTailKeys = current.slice(current.length - maxOverlap).map(messageIdentityKey);
	let overlap = 0;
	for (let k = maxOverlap; k > 0; k--) {
		let match = true;
		for (let i = 0; i < k; i++) {
			if (currentTailKeys[maxOverlap - k + i] !== runKeys[i]) {
				match = false;
				break;
			}
		}
		if (match) {
			overlap = k;
			break;
		}
	}
	if (overlap === run.length) return current;
	return [...current, ...run.slice(overlap)];
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
				newMessages.push(event.message);
				if (!deliveredKeysCopied) {
					deliveredKeys = new Set(deliveredKeys);
					deliveredKeysCopied = true;
				}
				deliveredKeys.add(messageIdentityKey(event.message));
				streamingEnd = true;
				break;
			}
			case "agent_end": {
				// Wire sends run-scoped newMessages, NOT the full transcript —
				// append-merge onto history, never replace.
				if (event.messages) {
					runMessages = event.messages;
				}
				break;
			}
			case "turn_end": {
				// turn_end re-delivers the turn's assistant message; append only
				// when this run has not already delivered it via message_end.
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
	if (textAccum) {
		streamingText = `${streamingStart ? "" : projection.streamingText}${textAccum}`;
	}
	if (thinkAccum) {
		streamingThinking = `${streamingStart ? "" : projection.streamingThinking}${thinkAccum}`;
	}

	let messages = projection.messages;
	if (newMessages.length > 0) {
		messages = [...messages, ...newMessages];
	}
	if (runMessages) {
		messages = mergeRunMessages(messages, runMessages);
	}

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

let storeProjection = createMessageProjection();

function synchronizeStoreProjection(state: MessagesStore): MessageProjection {
	return {
		messages: state.messages,
		streamingMessage: state.streamingMessage,
		streamingText: state.streamingText,
		streamingThinking: state.streamingThinking,
		deliveredKeys: storeProjection.deliveredKeys,
	};
}

export const useMessagesStore = create<MessagesStore>()((set, get) => ({
	...initialState,
	applyEvents: events => {
		const state = get();
		const projection = synchronizeStoreProjection(state);
		const nextProjection = applyMessageProjectionEvents(projection, events);
		storeProjection = nextProjection;

		// Single set() call per batch — one React re-render
		const patch: Partial<MessagesStore> = {};
		if (nextProjection.streamingMessage !== state.streamingMessage) {
			patch.streamingMessage = nextProjection.streamingMessage;
		}
		if (nextProjection.streamingText !== state.streamingText) {
			patch.streamingText = nextProjection.streamingText;
		}
		if (nextProjection.streamingThinking !== state.streamingThinking) {
			patch.streamingThinking = nextProjection.streamingThinking;
		}
		if (nextProjection.messages !== state.messages) {
			patch.messages = nextProjection.messages;
			patch.totalMessages = state.totalMessages + (nextProjection.messages.length - state.messages.length);
			// Projection event delivery is append-only, so everything beyond
			// the prior length is genuinely new.
			const appended = nextProjection.messages.slice(state.messages.length);
			if (appended.length > 0) patch.lastAppended = appended;
		}

		if (Object.keys(patch).length > 0) {
			set(patch);
		}
	},
	loadPage: page => {
		storeProjection = hydrateMessageProjection(synchronizeStoreProjection(get()), page.messages);
		set({
			messages: page.messages,
			lastAppended: [],
			totalMessages: page.totalMessages,
			nextCursor: page.nextCursor,
			isLoadingPage: false,
		});
	},
	appendMessage: message =>
		set(state => {
			const messages = [...state.messages, message];
			storeProjection = hydrateMessageProjection(synchronizeStoreProjection(state), messages);
			return { messages, lastAppended: [message], totalMessages: state.totalMessages + 1 };
		}),
	/** Drop a locally appended placeholder (e.g. the composer's running-eval bubble) by identity. */
	removeMessage: message =>
		set(state => {
			const messages = state.messages.filter(entry => entry !== message);
			const removed = state.messages.length - messages.length;
			storeProjection = hydrateMessageProjection(synchronizeStoreProjection(state), messages);
			if (removed === 0) return state;
			return { messages, totalMessages: Math.max(0, state.totalMessages - removed) };
		}),
	clearStreaming: () => {
		const projection = synchronizeStoreProjection(get());
		storeProjection = {
			...projection,
			streamingMessage: null,
			streamingText: "",
			streamingThinking: "",
		};
		set({ streamingMessage: null, streamingText: "", streamingThinking: "" });
	},
	reconcileFetched: fetched => {
		const state = get();
		const current = state.messages;
		storeProjection = synchronizeStoreProjection(state);
		let messages = fetched;
		if (sameIdentityPrefix(current, fetched)) {
			if (fetched.length === current.length) {
				let changed = false;
				const next = current.map((message, index) => {
					const incoming = fetched[index];
					if (!incoming || incoming === message) return message;
					changed = true;
					return incoming;
				});
				if (!changed) return;
				messages = next;
			} else if (fetched.length > current.length) {
				messages = [...current, ...fetched.slice(current.length)];
			}
		}
		storeProjection = hydrateMessageProjection(storeProjection, messages);
		set({ messages, totalMessages: messages.length });
	},
	snapshot: () => {
		const state = get();
		storeProjection = synchronizeStoreProjection(state);
		return {
			messages: state.messages,
			lastAppended: state.lastAppended,
			streamingMessage: state.streamingMessage,
			streamingText: state.streamingText,
			streamingThinking: state.streamingThinking,
			totalMessages: state.totalMessages,
			nextCursor: state.nextCursor,
			isLoadingPage: state.isLoadingPage,
			deliveredKeys: [...storeProjection.deliveredKeys],
		};
	},
	restoreSnapshot: snapshot => {
		if (!snapshot) {
			get().reset();
			return;
		}
		storeProjection = {
			messages: snapshot.messages,
			streamingMessage: snapshot.streamingMessage,
			streamingText: snapshot.streamingText,
			streamingThinking: snapshot.streamingThinking,
			deliveredKeys: new Set(snapshot.deliveredKeys),
		};
		set({
			messages: snapshot.messages,
			lastAppended: snapshot.lastAppended,
			streamingMessage: snapshot.streamingMessage,
			streamingText: snapshot.streamingText,
			streamingThinking: snapshot.streamingThinking,
			totalMessages: snapshot.totalMessages,
			nextCursor: snapshot.nextCursor,
			isLoadingPage: snapshot.isLoadingPage,
		});
	},
	reset: () => {
		storeProjection = createMessageProjection();
		set(initialState);
	},
}));
