/**
 * Shared transcript helpers: row construction, todo snapshot interleaving,
 * stable identities, live-edge intent, and entrance claims.
 */

import type { AgentMessage, MessageContent, RpcQueuedMessage } from "../../../shared/rpc-types";
import { messageIdentity } from "../../lib/message-identity";
import { isRenderableMessageText, messageText, splitReaction } from "../../lib/messages";
import {
	type ReadGroupEntry,
	type ReadGroupUsage,
	type ResolveToolCall,
	resolveMainToolCall,
} from "../../lib/read-group";
import type { QueueLane } from "../../stores/queue";
import type { TodoSnapshot } from "../../stores/todo";
import type { ToolEntry } from "../../stores/tools";
import type { TranscriptDetail } from "../../stores/ui";
import { launchCompletionFailureCount } from "./completion-events";

interface ProcessMeta {
	identityKey: string;
	stepCount: number;
	failedEvents: number;
	toolCallIds: string[];
	toolNames: string[];
}


export interface ConversationAnchor {
	key: string;
	rowIndex: number;
	preview: string;
	timestamp?: number | string;
}

const CONVERSATION_PREVIEW_LIMIT = 180;

/** Slack still counted as "the live edge" when deciding whether to follow the tail.
 * A single CSS pixel was brittle: row re-measurement, font loading and fractional
 * scrollTop routinely leave a few pixels under the last row, which read as "the
 * user scrolled away" and stopped all tail following. */
export const LIVE_EDGE_SLACK_PX = 24;

/** True at the live edge, within the tail-following slack. */
export function isTranscriptAtLiveEdge(metrics: {
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
}): boolean {
	return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < LIVE_EDGE_SLACK_PX;
}

/** Direction of the reader's last viewport gesture: `true` toward the tail, `false`
 * away from it, `null` when the movement was not attributed to a gesture at all (a
 * restored view, a scrollbar press, a touch flick). */
export type GestureTowardTail = boolean | null;

/** Re-engaging the tail is a claim about reader intent, so it takes a gesture toward
 * the tail rather than a viewport that merely happens to sit there. A tail-follow
 * write that slips into the same frame as an upward gesture lands at the live edge;
 * re-pinning from that position clears the gesture latch, every later append then
 * follows the tail again, and the view the reader just took is lost for the rest of
 * the run. Unattributed moves stay unpinned — releasing a drag or a flick at the edge
 * is the gesture that re-engages there. */
export function shouldRePinTranscript(gestureTowardTail: GestureTowardTail, atLiveEdge: boolean): boolean {
	return atLiveEdge && gestureTowardTail === true;
}

/**
 * How far from the end of the transcript a live commit can hand over rows, and
 * the largest growth that still reads as one turn. A wider jump is a hydrate or
 * a page of history arriving.
 */
export const ROW_ENTRANCE_TAIL_ROWS = 6;

export interface MountedTranscriptRow {
	index: number;
	key: string;
}

/** Bookkeeping for which rows have already been treated as arriving content. */
export interface RowEntranceState {
	sessionId: string | undefined;
	rowCount: number;
	seen: Set<string>;
}

export interface RowEntrancePass {
	sessionId: string | undefined;
	/**
	 * Whether this commit grew the transcript out of a live run. Hydration and
	 * pagination replace the message list without announcing an arrival, so a
	 * restored view must never cascade.
	 */
	live: boolean;
	rowKeys: readonly string[];
	mounted: readonly MountedTranscriptRow[];
}

export function createRowEntranceState(sessionId: string | undefined, rowKeys: readonly string[]): RowEntranceState {
	return { sessionId, rowCount: rowKeys.length, seen: new Set(rowKeys) };
}

/**
 * Claim the mounted rows whose content just arrived at the tail.
 *
 * Rows are recycled through the viewport, so mounting is not an arrival: an
 * entrance keyed on mount replays on every scroll, which is what made the
 * transcript's entrance motion unusable. A claim therefore needs a live run, a
 * row set that moved by one turn's worth at most, a slot at the end of the
 * transcript, and a key that has never been mounted before.
 */
export function claimRowEntrances(state: RowEntranceState, pass: RowEntrancePass): string[] {
	const { sessionId, live, rowKeys, mounted } = pass;
	if (state.sessionId !== sessionId) {
		// Switching sessions restores a view; none of it is content arriving.
		state.sessionId = sessionId;
		state.rowCount = rowKeys.length;
		state.seen = new Set(rowKeys);
		return [];
	}
	const jumped = Math.abs(rowKeys.length - state.rowCount) > ROW_ENTRANCE_TAIL_ROWS;
	state.rowCount = rowKeys.length;
	const tailFrom = rowKeys.length - 1 - ROW_ENTRANCE_TAIL_ROWS;
	const admitting = live && !jumped;

	const claims: string[] = [];
	for (const row of mounted) {
		if (state.seen.has(row.key)) continue;
		state.seen.add(row.key);
		if (!admitting || row.index < tailFrom) continue;
		claims.push(row.key);
	}
	return claims;
}

export type HistoryRow =
	| { kind: "message"; message: AgentMessage; reaction?: string; identityKey?: string }
	| { kind: "readGroup"; entries: ReadGroupEntry[]; usage?: ReadGroupUsage[]; identityKey?: string }
	| ({ kind: "process"; messages: AgentMessage[] } & ProcessMeta)
	| { kind: "todoSnapshot"; entry: TodoSnapshot };

/** Virtualized row: finalized history or one of the live streaming rows. */
export type Row =
	| HistoryRow
	| { kind: "streaming"; message: AgentMessage }
	| { kind: "pending" }
	| { kind: "expander"; count: number }
	| { kind: "queued"; item: RpcQueuedMessage; lane: QueueLane };
function messageKey(message: AgentMessage, resolveToolCall: ResolveToolCall): string {
	if (typeof message.id === "string" && message.id.length > 0) return message.id;
	const firstTool = messageContent(message).find(block => block.type === "toolCall");
	if (firstTool?.type === "toolCall" && resolveToolCall !== resolveMainToolCall) return resolveToolCall(firstTool).key;
	const identity = messageIdentity(message);
	if (identity) return identity;
	if (firstTool?.type === "toolCall") return resolveToolCall(firstTool).key;
	return `${message.role}-untimed`;
}

function transcriptRowBaseKey(row: Row, resolveToolCall: ResolveToolCall): string {
	switch (row.kind) {
		case "queued":
			return `queued-${row.item.id}`;
		case "message":
			return `message-${row.identityKey ?? messageKey(row.message, resolveToolCall)}`;
		case "process":
			// Compact mode may replace one live assistant row with a process row,
			// or split it into process + answer rows. Key the first finalized row
			// by the same assistant identity so the viewport anchor survives both.
			return `message-${row.identityKey}`;
		case "readGroup":
			return row.identityKey
				? `message-${row.identityKey}`
				: `read-${row.entries.map(entry => entry.toolKey).join("-")}`;
		case "todoSnapshot":
			return `todo-snapshot-${row.entry.id}`;
		case "streaming":
			// message_start and message_end carry the same assistant identity.
			// Reusing it prevents the virtualizer from replacing one huge measured
			// streaming row with a fresh 72px estimate, briefly clamping scrollTop
			// to the end before the finalized row is measured.
			return `message-${messageKey(row.message, resolveToolCall)}`;
		case "pending":
			return row.kind;
		case "expander":
			return "pre-compaction-expander";
	}
}

export function buildTranscriptRowKeys(
	rows: readonly Row[],
	resolveToolCall: ResolveToolCall = resolveMainToolCall,
): string[] {
	const occurrences = new Map<string, number>();
	return rows.map(row => {
		const base = transcriptRowBaseKey(row, resolveToolCall);
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		return occurrence === 0 ? base : `${base}-${occurrence}`;
	});
}

/** One stable minimap anchor per user-authored turn in the rendered row set. */
export function buildConversationAnchors(rows: readonly Row[], rowKeys: readonly string[]): ConversationAnchor[] {
	const anchors: ConversationAnchor[] = [];
	for (const [rowIndex, row] of rows.entries()) {
		if (row.kind !== "message" || row.message.role !== "user") continue;
		anchors.push({
			key: rowKeys[rowIndex] ?? `conversation-${rowIndex}`,
			rowIndex,
			preview: conversationPreview(messageText(row.message)),
			timestamp: row.message.timestamp,
		});
	}
	return anchors;
}

function conversationPreview(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= CONVERSATION_PREVIEW_LIMIT) return normalized;
	return `${normalized.slice(0, CONVERSATION_PREVIEW_LIMIT - 1).trimEnd()}…`;
}

/** Current user turn at or immediately before the first visible transcript row. */
export function findConversationAnchorIndex(anchors: readonly ConversationAnchor[], visibleRowIndex: number): number {
	if (anchors.length === 0) return -1;
	let low = 0;
	let high = anchors.length - 1;
	let match = 0;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (anchors[middle]!.rowIndex <= visibleRowIndex) {
			match = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return match;
}

/** Stable finalized-row identities used by the virtualizer and regression tests. */
export function buildHistoryRowKeys(
	rows: readonly HistoryRow[],
	resolveToolCall: ResolveToolCall = resolveMainToolCall,
): string[] {
	return buildTranscriptRowKeys(rows, resolveToolCall);
}

function messageContent(message: AgentMessage): MessageContent[] {
	if (Array.isArray(message.content)) return message.content;
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return [];
}

function splitMessageReaction(message: AgentMessage): { message: AgentMessage; reaction?: string } {
	if (message.role !== "assistant") return { message };
	if (typeof message.content === "string") {
		const split = splitReaction(message.content);
		return split.emoji ? { message: { ...message, content: split.body }, reaction: split.emoji } : { message };
	}
	if (!Array.isArray(message.content)) return { message };
	const index = message.content.findIndex(block => block.type === "text" && block.text.length > 0);
	const block = message.content[index];
	if (block?.type !== "text") return { message };
	const split = splitReaction(block.text);
	if (!split.emoji) return { message };
	const content = message.content.slice();
	content[index] = { ...block, text: split.body };
	return { message: { ...message, content }, reaction: split.emoji };
}


/**
 * Keep zero-height/non-display messages out of the virtualizer. Estimating an
 * invisible toolResult row at 128px was the remaining source of blank bands
 * between cards; its content already lives in the matching ToolCard.
 */
export function isVisibleTranscriptMessage(message: AgentMessage): boolean {
	if (message.role === "toolResult") return false;
	if ((message.role === "custom" || message.role === "hookMessage") && message.display === false) return false;
	if (
		message.role === "user" ||
		message.role === "bashExecution" ||
		message.role === "pythonExecution" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary" ||
		message.role === "fileMention" ||
		message.role === "custom" ||
		message.role === "hookMessage"
	) {
		return true;
	}
	if (message.errorMessage || message.steering) return true;
	return messageContent(message).some(block => {
		switch (block.type) {
			case "text":
				return isRenderableMessageText(block.text);
			case "thinking":
				return isRenderableMessageText(block.thinking);
			case "toolCall":
			case "image":
				return true;
		}
		return false;
	});
}

export function messageTimestampMs(message: AgentMessage): number {
	const timestamp = message.timestamp;
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
	if (typeof timestamp === "string") {
		const parsed = Date.parse(timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

export function isCurrentStreamToolEntry(
	entry: ToolEntry,
	streamGeneration: number | undefined,
	streamStart: number,
): boolean {
	return entry.streamGeneration === undefined
		? entry.startTime >= streamStart
		: entry.streamGeneration > 0 && entry.streamGeneration === streamGeneration;
}

/** Whether the in-flight turn owns a real visible row right now. */
export function hasStreamingTranscriptContent(
	message: AgentMessage | null,
	streamingText: string,
	streamingThinking: string,
	activeTools: ReadonlyMap<string, ToolEntry>,
	streamGeneration?: number,
): boolean {
	if (!message) return false;
	if (isRenderableMessageText(streamingText) || isRenderableMessageText(streamingThinking)) return true;
	if (isVisibleTranscriptMessage(message)) return true;
	const streamStart = messageTimestampMs(message);
	for (const entry of activeTools.values()) {
		if (isCurrentStreamToolEntry(entry, streamGeneration, streamStart)) return true;
	}
	return false;
}

function summarizeProcess(messages: AgentMessage[], resolveToolCall: ResolveToolCall): ProcessMeta {
	let thinkingCount = 0;
	let failedEvents = 0;
	const toolCallIds: string[] = [];
	const toolNames: string[] = [];
	for (const message of messages) {
		failedEvents += launchCompletionFailureCount(message);
		for (const block of messageContent(message)) {
			if (block.type === "thinking" && isRenderableMessageText(block.thinking)) thinkingCount++;
			if (block.type !== "toolCall") continue;
			toolCallIds.push(resolveToolCall(block).key);
			toolNames.push(block.name);
		}
	}
	return {
		identityKey: messageKey(messages[0]!, resolveToolCall),
		stepCount: thinkingCount + toolCallIds.length,
		failedEvents,
		toolCallIds,
		toolNames,
	};
}

/**
 * Build finalized transcript rows. Compact mode groups only renderable
 * reasoning into process rows while keeping narration and tool calls visible
 * in chronological message rows.
 */
export function buildHistoryRows(
	messages: AgentMessage[],
	detail: TranscriptDetail,
	preservedProcessStarts?: ReadonlySet<string>,
	resolveToolCall: ResolveToolCall = resolveMainToolCall,
): HistoryRow[] {
	const rows: HistoryRow[] = [];
	let processMessages: AgentMessage[] = [];
	let reactionTargetIndex: number | undefined;
	const flushProcess = () => {
		if (processMessages.length === 0) return;
		rows.push({ kind: "process", messages: processMessages, ...summarizeProcess(processMessages, resolveToolCall) });
		processMessages = [];
	};

	for (let index = 0; index < messages.length; index++) {
		const incoming = messages[index];
		if (!incoming) continue;
		// Keep an explicitly opened live phase in place when it finalizes.
		if (preservedProcessStarts?.has(`message-${messageKey(incoming, resolveToolCall)}`)) flushProcess();
		let message = incoming;
		if (message.role === "assistant") {
			if (reactionTargetIndex !== undefined) {
				const split = splitMessageReaction(message);
				const target = rows[reactionTargetIndex];
				if (split.reaction && target?.kind === "message" && target.message.role === "user") {
					rows[reactionTargetIndex] = { ...target, reaction: split.reaction };
					message = split.message;
				}
			}
			reactionTargetIndex = undefined;
		}
		// toolResult/display:false/empty-filler messages must not split a process
		// run — they are invisible transport records, not transcript boundaries.
		if (!isVisibleTranscriptMessage(message)) continue;
		const identityKey = messageKey(message, resolveToolCall);
		if (
			detail !== "compact" ||
			message.role !== "assistant" ||
			message.errorMessage ||
			message.steering ||
			!Array.isArray(message.content)
		) {
			flushProcess();
			rows.push({ kind: "message", message, identityKey });
			if (message.role === "user") reactionTargetIndex = rows.length - 1;
			continue;
		}

		const thinking = message.content.filter(
			block => block.type === "thinking" && isRenderableMessageText(block.thinking),
		);
		const coreContent = message.content.filter(block => block.type !== "thinking");
		const coreMessage: AgentMessage | undefined =
			coreContent.length > 0 ? { ...message, content: coreContent } : undefined;
		const hasVisibleCore = coreMessage !== undefined && isVisibleTranscriptMessage(coreMessage);

		if (thinking.length > 0) {
			const thinkingMessage: AgentMessage = { ...message, content: thinking };
			if (hasVisibleCore) {
				delete thinkingMessage.usage;
				delete thinkingMessage.model;
				delete thinkingMessage.duration;
				delete thinkingMessage.ttft;
			}
			processMessages.push(thinkingMessage);
		}
		if (hasVisibleCore) {
			flushProcess();
			rows.push({ kind: "message", message: coreMessage, identityKey });
		}
	}
	flushProcess();
	return rows;
}

/**
 * Interleave archived todo snapshots into finalized history by timestamp:
 * each snapshot lands after the last row at or before its change time, and
 * leftovers (changes newer than every message) tail the history. Rows
 * without a reliable timestamp (read groups) never flush snapshots.
 */
export function mergeTodoSnapshots(rows: readonly HistoryRow[], snapshots: readonly TodoSnapshot[]): HistoryRow[] {
	if (snapshots.length === 0) return rows as HistoryRow[];
	const out: HistoryRow[] = [];
	let next = 0;
	for (const row of rows) {
		const ts =
			row.kind === "message"
				? messageTimestampMs(row.message)
				: row.kind === "process" && row.messages.length > 0
					? messageTimestampMs(row.messages[0]!)
					: undefined;
		if (ts !== undefined) {
			while (next < snapshots.length && (snapshots[next]?.ts ?? 0) < ts) {
				out.push({ kind: "todoSnapshot", entry: snapshots[next]! });
				next++;
			}
		}
		out.push(row);
	}
	while (next < snapshots.length) {
		out.push({ kind: "todoSnapshot", entry: snapshots[next]! });
		next++;
	}
	return out;
}

