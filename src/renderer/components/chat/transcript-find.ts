/**
 * Find indexes the row model rather than the DOM: the transcript virtualizer
 * keeps off-screen rows unmounted, so there is nothing in the DOM to search
 * for most of a long transcript. This module is pure (no React, no DOM) so it
 * can run against every row regardless of mount state; the hook that drives
 * ⌘F indexes its output and the highlight module reproduces the same
 * normalization to map a match back onto rendered text.
 */

import type { AgentMessage, ToolCallContent } from "../../../shared/rpc-types";
import { resultText } from "../../lib/format";
import { isRenderableMessageText, messageText } from "../../lib/messages";
import type { ResolveToolCall } from "../../lib/read-group";
import { thinkingDisclosureKey } from "../../stores/messages";
import type { ToolEntry } from "../../stores/tools";
import { TOOL_DISCLOSURE_PREFIX } from "../../stores/ui";
import type { Row } from "./chat-stream-utils";

export interface TranscriptFindContext {
	/** Same resolver the rows render with (main: resolveMainToolCall; projected: the projection's). */
	resolveToolCall: ResolveToolCall;
	/** Fallback entry lookup for read-group entries that carry no original call object. */
	lookupToolEntry: (toolKey: string) => ToolEntry | undefined;
}

/** One searchable text run inside a row, plus the disclosure that hides it (null = always visible). */
export interface FindSegment {
	text: string;
	disclosureKey: string | null;
}

export function normalizeFindText(raw: string): string {
	return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function push(segments: FindSegment[], text: string | undefined | null, disclosureKey: string | null): void {
	if (typeof text !== "string" || text.trim() === "") return;
	segments.push({ text, disclosureKey });
}

function toolSegments(block: ToolCallContent, segments: FindSegment[], context: TranscriptFindContext): void {
	const resolved = context.resolveToolCall(block);
	const key = `${TOOL_DISCLOSURE_PREFIX}${resolved.key}`;
	push(segments, block.name, key);
	try {
		push(segments, JSON.stringify(block.arguments), key);
	} catch {
		/* unserializable arguments contribute nothing */
	}
	push(segments, resultText(resolved.entry?.result ?? resolved.entry?.partialResult), key);
}

function messageSegments(message: AgentMessage, segments: FindSegment[], context: TranscriptFindContext): void {
	if (Array.isArray(message.content)) {
		let thinkingOrdinal = 0;
		for (const block of message.content) {
			if (block.type === "text") {
				if (isRenderableMessageText(block.text)) push(segments, block.text, null);
			} else if (block.type === "thinking") {
				if (!isRenderableMessageText(block.thinking)) continue;
				push(segments, block.thinking, thinkingDisclosureKey(message, thinkingOrdinal++));
			} else if (block.type === "toolCall") {
				toolSegments(block, segments, context);
			}
		}
	} else {
		push(segments, messageText(message), null);
	}
	push(segments, message.code, null);
	push(segments, message.output, null);
	push(segments, message.summary, null);
}

export function extractRowSegments(row: Row, rowKey: string, context: TranscriptFindContext): FindSegment[] {
	const segments: FindSegment[] = [];
	switch (row.kind) {
		case "message":
		case "streaming":
			messageSegments(row.message, segments, context);
			break;
		case "process":
			for (const message of row.messages) messageSegments(message, segments, context);
			break;
		case "readGroup":
			for (const entry of row.entries) {
				push(segments, entry.path, null);
				push(segments, entry.selector, null);
				const resolved = entry.call
					? context.resolveToolCall(entry.call).entry
					: context.lookupToolEntry(entry.toolKey);
				push(segments, resultText(resolved?.result ?? resolved?.partialResult), null);
			}
			break;
		case "todoSnapshot": {
			const key = `todo:${rowKey}`;
			for (const phase of row.entry.phases) {
				push(segments, phase.name, key);
				for (const task of phase.tasks) push(segments, task.content, key);
			}
			break;
		}
		case "queued":
			push(segments, row.item.text, null);
			break;
		case "pending":
		case "expander":
			break;
	}
	return segments;
}
