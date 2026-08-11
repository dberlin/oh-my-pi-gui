/**
 * ChatStream pure helpers: transcript row construction, todo snapshot
 * interleaving, and timeline marker derivation. Extracted verbatim from
 * ChatStream.tsx so the renderer keeps only its UI and state wiring.
 */

import type { AgentMessage, MessageContent, RpcQueuedMessage } from "../../../shared/rpc-types";
import { isRenderableMessageText } from "../../lib/messages";
import type { ReadGroupEntry, ReadGroupUsage } from "../../lib/read-group";
import type { QueueLane } from "../../stores/queue";
import type { TodoSnapshot } from "../../stores/todo";
import { type ToolEntry, toolEntryKey } from "../../stores/tools";
import type { TranscriptDetail } from "../../stores/ui";

interface ProcessMeta {
	stepCount: number;
	toolCallIds: string[];
	toolNames: string[];
}

type TimelineState = "done" | "running" | "error" | "launch";

export interface TimelineMarkerSeed {
	state: TimelineState;
	timestamp?: number | string;
	toolIds: string[];
}

export type HistoryRow =
	| { kind: "message"; message: AgentMessage }
	| { kind: "readGroup"; entries: ReadGroupEntry[]; usage?: ReadGroupUsage[] }
	| ({ kind: "process"; messages: AgentMessage[] } & ProcessMeta)
	| { kind: "todoSnapshot"; entry: TodoSnapshot };

/** Virtualized row: finalized history or one of the live streaming rows. */
export type Row =
	| HistoryRow
	| { kind: "streaming" }
	| { kind: "pending" }
	| { kind: "expander"; count: number }
	| { kind: "queued"; item: RpcQueuedMessage; lane: QueueLane };
function messageKey(message: AgentMessage): string {
	if (typeof message.id === "string" && message.id.length > 0) return message.id;
	const firstTool = messageContent(message).find(block => block.type === "toolCall");
	if (firstTool?.type === "toolCall") return toolEntryKey(firstTool);
	return `${message.role}-${String(message.timestamp ?? "untimed")}`;
}

function transcriptRowBaseKey(row: Row): string {
	switch (row.kind) {
		case "queued":
			return `queued-${row.item.id}`;
		case "message":
			return `message-${messageKey(row.message)}`;
		case "process":
			return `process-${messageKey(row.messages[0]!)}`;
		case "readGroup":
			return `read-${row.entries.map(entry => entry.toolKey).join("-")}`;
		case "todoSnapshot":
			return `todo-snapshot-${row.entry.id}`;
		case "streaming":
		case "pending":
			return row.kind;
		case "expander":
			return "pre-compaction-expander";
	}
}

export function buildTranscriptRowKeys(rows: readonly Row[]): string[] {
	const occurrences = new Map<string, number>();
	return rows.map(row => {
		const base = transcriptRowBaseKey(row);
		const occurrence = occurrences.get(base) ?? 0;
		occurrences.set(base, occurrence + 1);
		return occurrence === 0 ? base : `${base}-${occurrence}`;
	});
}

/** Stable finalized-row identities used by the virtualizer and regression tests. */
export function buildHistoryRowKeys(rows: readonly HistoryRow[]): string[] {
	return buildTranscriptRowKeys(rows);
}

function messageContent(message: AgentMessage): MessageContent[] {
	if (Array.isArray(message.content)) return message.content;
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return [];
}

function messageToolIds(message: AgentMessage): string[] {
	return messageContent(message)
		.filter(block => block.type === "toolCall")
		.map(block => toolEntryKey(block));
}

/** A real narration/reasoning block starts a new visual execution phase. */
function hasProcessNarration(message: AgentMessage): boolean {
	return messageContent(message).some(block => {
		if (block.type === "text") return isRenderableMessageText(block.text);
		if (block.type === "thinking") return isRenderableMessageText(block.thinking);
		return false;
	});
}

function isLaunchMessage(message: AgentMessage): boolean {
	return message.customType === "async-result" || message.customType === "launch-completion";
}

/**
 * Keep zero-height/non-display messages out of the virtualizer. Estimating an
 * invisible toolResult row at 128px was the remaining source of blank bands
 * between cards; its content already lives in the matching ToolCard.
 */
function isVisibleTranscriptMessage(message: AgentMessage): boolean {
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

/** Whether the in-flight turn owns a real visible row right now. */
export function hasStreamingTranscriptContent(
	message: AgentMessage | null,
	streamingText: string,
	streamingThinking: string,
	activeTools: ReadonlyMap<string, ToolEntry>,
): boolean {
	if (!message) return false;
	if (isRenderableMessageText(streamingText) || isRenderableMessageText(streamingThinking)) return true;
	if (isVisibleTranscriptMessage(message)) return true;
	const streamStart = messageTimestampMs(message);
	for (const entry of activeTools.values()) {
		if ((entry.status === "pending" || entry.status === "running") && entry.startTime >= streamStart) return true;
	}
	return false;
}

function summarizeProcess(messages: AgentMessage[]): ProcessMeta {
	let thinkingCount = 0;
	const toolCallIds: string[] = [];
	const toolNames: string[] = [];
	for (const message of messages) {
		for (const block of messageContent(message)) {
			if (block.type === "thinking" && isRenderableMessageText(block.thinking)) thinkingCount++;
			if (block.type !== "toolCall") continue;
			toolCallIds.push(toolEntryKey(block));
			toolNames.push(block.name);
		}
	}
	return { stepCount: thinkingCount + toolCallIds.length, toolCallIds, toolNames };
}

/**
 * Build finalized transcript rows. Compact mode groups a run's reasoning and
 * tool-call messages into one visual phase while preserving the final answer.
 * A final assistant message containing both thinking and text is split: only
 * the thinking fragment joins the process row.
 */
export function buildHistoryRows(messages: AgentMessage[], detail: TranscriptDetail): HistoryRow[] {
	const rows: HistoryRow[] = [];
	let processMessages: AgentMessage[] = [];
	const flushProcess = () => {
		if (processMessages.length === 0) return;
		rows.push({ kind: "process", messages: processMessages, ...summarizeProcess(processMessages) });
		processMessages = [];
	};

	for (const message of messages) {
		// toolResult/display:false/empty-filler messages must not split a process
		// run — they are invisible transport records, not transcript boundaries.
		if (!isVisibleTranscriptMessage(message)) continue;
		if (
			detail !== "compact" ||
			message.role !== "assistant" ||
			message.errorMessage ||
			message.steering ||
			!Array.isArray(message.content)
		) {
			flushProcess();
			rows.push({ kind: "message", message });
			continue;
		}

		const hasToolCall = message.content.some(block => block.type === "toolCall");
		const hasImage = message.content.some(block => block.type === "image");
		if (hasToolCall && !hasImage) {
			// A narrated tool call is the semantic start of a new execution phase.
			// Punctuation-only tool messages (".", "…") keep accruing to the
			// current phase, matching the editorial timeline in both detail modes.
			if (processMessages.length > 0 && hasProcessNarration(message)) flushProcess();
			// Text accompanying a tool call is intermediate narration; the API
			// delivers the final answer in a later assistant message.
			processMessages.push(message);
			continue;
		}

		const thinking = message.content.filter(
			block => block.type === "thinking" && isRenderableMessageText(block.thinking),
		);
		if (thinking.length > 0) {
			processMessages.push({ ...message, content: thinking });
			const coreMessage: AgentMessage = {
				...message,
				content: message.content.filter(block => block.type !== "thinking"),
			};
			if (isVisibleTranscriptMessage(coreMessage)) {
				flushProcess();
				rows.push({ kind: "message", message: coreMessage });
			}
			continue;
		}

		flushProcess();
		rows.push({ kind: "message", message });
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

/**
 * Map finalized history rows onto semantic timeline phases. Full detail keeps
 * every tool message visible, but punctuation-only continuations share the
 * phase's first marker and timestamp. Tool state is aggregated so a later
 * running/error call still updates that one marker.
 */
export function buildTimelineMarkers(rows: readonly HistoryRow[]): Array<TimelineMarkerSeed | null> {
	const markers: Array<TimelineMarkerSeed | null> = rows.map(() => null);
	let phaseOwner: number | null = null;

	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (!row) continue;

		if (row.kind === "message" && (row.message.errorMessage || isLaunchMessage(row.message))) {
			phaseOwner = null;
			markers[index] = {
				state: row.message.errorMessage ? "error" : "launch",
				timestamp: row.message.timestamp,
				toolIds: messageToolIds(row.message),
			};
			continue;
		}

		let timestamp: number | string | undefined;
		let toolIds: string[] = [];
		let startsPhase = false;
		if (row.kind === "process") {
			timestamp = row.messages[0]?.timestamp;
			toolIds = row.toolCallIds;
			startsPhase = true;
		} else if (row.kind === "readGroup") {
			timestamp = row.usage?.[0]?.timestamp;
			toolIds = row.entries.map(entry => entry.toolKey);
		} else if (row.kind === "message") {
			timestamp = row.message.timestamp;
			toolIds = messageToolIds(row.message);
			startsPhase = hasProcessNarration(row.message);
		}

		if (toolIds.length === 0 && row.kind !== "process") {
			phaseOwner = null;
			continue;
		}

		if (phaseOwner === null || startsPhase) {
			phaseOwner = index;
			markers[index] = { state: "done", timestamp, toolIds: [...toolIds] };
			continue;
		}

		const owner = markers[phaseOwner];
		if (!owner) continue;
		owner.toolIds.push(...toolIds);
		owner.timestamp ??= timestamp;
	}

	return markers;
}
