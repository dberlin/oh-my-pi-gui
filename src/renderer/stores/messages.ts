import { create } from "zustand";
import type { AgentMessage, AgentSessionEvent, MessagesPage } from "../../shared/rpc-types";

/**
 * Session-tab snapshot of the message stream: the zustand fields PLUS the
 * module-level streaming buffers and run-dedupe set. Without the buffers a
 * mid-stream switch-away would lose the already-streamed prefix — deltas
 * landing after switch-back join onto whatever the chunks still hold.
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
	textChunks: string[];
	thinkingChunks: string[];
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

/**
 * Structural identity for dedupe: the wire assigns no message id, so a message
 * re-delivered across events (message_end → turn_end/agent_end) or fetched
 * while it was streaming (hydration racing the live stream) is matched on the
 * fields that distinguish two transcript entries.
 */
export function messageIdentityKey(message: AgentMessage): string {
	return JSON.stringify([
		message.role,
		message.toolCallId ?? null,
		message.timestamp ?? null,
		message.content ?? null,
	]);
}

/**
 * Append-only streaming buffers. Delta batches land many times per second;
 * re-concatenating the whole accumulated string from state on every batch is
 * O(total) each time — quadratic over a long stream. Chunks push in O(1) and
 * the joined view is materialized once per batch that actually carries deltas.
 */
let streamTextChunks: string[] = [];
let streamThinkingChunks: string[] = [];

function resetStreamingBuffers(): void {
	streamTextChunks = [];
	streamThinkingChunks = [];
}

/**
 * Keys of messages appended during the current agent run. turn_end re-sends
 * the turn's assistant message (already appended via message_end), and batch
 * boundaries make a batch-local guard insufficient — dedupe run-wide.
 */
let deliveredThisRun = new Set<string>();

/**
 * Merge run-scoped agent_end messages onto the transcript. Messages streamed
 * live via message_end (or hydrated mid-run) already form a suffix of the
 * current list, so find the longest prefix of `run` matching that suffix and
 * append only the remainder. History is never replaced.
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

export const useMessagesStore = create<MessagesStore>()((set, get) => ({
	...initialState,
	applyEvents: events => {
		let textAccum = "";
		let thinkAccum = "";
		const newMessages: AgentMessage[] = [];
		let runMessages: AgentMessage[] | null = null;
		let streamingStart: AgentMessage | null = null;
		let streamingEnd = false;

		for (const event of events) {
			switch (event.type) {
				case "agent_start": {
					deliveredThisRun = new Set();
					break;
				}
				case "message_start": {
					streamingStart = event.message;
					resetStreamingBuffers();
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
					newMessages.push(event.message);
					deliveredThisRun.add(messageIdentityKey(event.message));
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
						if (!deliveredThisRun.has(key)) {
							newMessages.push(event.message);
							deliveredThisRun.add(key);
						}
					}
					break;
				}
				default:
					break;
			}
		}

		// Single set() call per batch — one React re-render
		const state = get();
		const patch: Partial<MessagesStore> = {};

		if (streamingStart) {
			patch.streamingMessage = streamingStart;
			patch.streamingText = "";
			patch.streamingThinking = "";
		}
		if (textAccum) {
			streamTextChunks.push(textAccum);
			patch.streamingText = streamTextChunks.join("");
		}
		if (thinkAccum) {
			streamThinkingChunks.push(thinkAccum);
			patch.streamingThinking = streamThinkingChunks.join("");
		}

		let messages = state.messages;
		if (newMessages.length > 0) {
			messages = [...messages, ...newMessages];
		}
		if (runMessages) {
			messages = mergeRunMessages(messages, runMessages);
		}
		if (messages !== state.messages) {
			patch.messages = messages;
			patch.totalMessages = state.totalMessages + (messages.length - state.messages.length);
			// Both paths above are append-only, so everything beyond the prior
			// length is new (message_end/turn_end/agent_end deliveries).
			const appended = messages.slice(state.messages.length);
			if (appended.length > 0) patch.lastAppended = appended;
		}

		if (streamingEnd || runMessages) {
			patch.streamingMessage = null;
			patch.streamingText = "";
			patch.streamingThinking = "";
			resetStreamingBuffers();
		}

		if (Object.keys(patch).length > 0) {
			set(patch);
		}
	},
	loadPage: page =>
		set({
			messages: page.messages,
			lastAppended: [],
			totalMessages: page.totalMessages,
			nextCursor: page.nextCursor,
			isLoadingPage: false,
		}),
	appendMessage: message =>
		set(s => ({ messages: [...s.messages, message], lastAppended: [message], totalMessages: s.totalMessages + 1 })),
	/** Drop a locally appended placeholder (e.g. the composer's running-eval bubble) by identity. */
	removeMessage: message =>
		set(s => {
			const messages = s.messages.filter(entry => entry !== message);
			const removed = s.messages.length - messages.length;
			if (removed === 0) return s;
			return { messages, totalMessages: Math.max(0, s.totalMessages - removed) };
		}),
	snapshot: () => {
		const state = get();
		return {
			messages: state.messages,
			lastAppended: state.lastAppended,
			streamingMessage: state.streamingMessage,
			streamingText: state.streamingText,
			streamingThinking: state.streamingThinking,
			totalMessages: state.totalMessages,
			nextCursor: state.nextCursor,
			isLoadingPage: state.isLoadingPage,
			textChunks: [...streamTextChunks],
			thinkingChunks: [...streamThinkingChunks],
			deliveredKeys: [...deliveredThisRun],
		};
	},
	restoreSnapshot: snapshot => {
		if (!snapshot) {
			get().reset();
			return;
		}
		streamTextChunks = [...snapshot.textChunks];
		streamThinkingChunks = [...snapshot.thinkingChunks];
		deliveredThisRun = new Set(snapshot.deliveredKeys);
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
		resetStreamingBuffers();
		deliveredThisRun = new Set();
		set(initialState);
	},
}));
