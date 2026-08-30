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

/** Per-row match, cached by rowKey so appends do not rescan the transcript. */
export interface RowMatchSeed {
	disclosureKey: string | null;
	/** 0-based position of this match among the row's own matches, in render order. */
	occurrenceInRow: number;
}

export interface TranscriptMatch {
	rowIndex: number;
	rowKey: string;
	/** 0-based position in document order across the whole transcript. */
	ordinal: number;
	disclosureKey: string | null;
	locator: { occurrenceInRow: number };
}

export interface TranscriptFindIndex {
	/** The normalized needle this index was built for ("" = no matches by definition). */
	needle: string;
	matches: readonly TranscriptMatch[];
	/** rowKey → that row's seeds; carried forward when the needle is unchanged. */
	rowCache: ReadonlyMap<string, readonly RowMatchSeed[]>;
}

export const EMPTY_FIND_INDEX: TranscriptFindIndex = { needle: "", matches: [], rowCache: new Map() };

function seedRow(row: Row, rowKey: string, needle: string, context: TranscriptFindContext): RowMatchSeed[] {
	const seeds: RowMatchSeed[] = [];
	for (const segment of extractRowSegments(row, rowKey, context)) {
		const haystack = normalizeFindText(segment.text);
		let from = haystack.indexOf(needle);
		while (from !== -1) {
			seeds.push({ disclosureKey: segment.disclosureKey, occurrenceInRow: seeds.length });
			from = haystack.indexOf(needle, from + needle.length);
		}
	}
	return seeds;
}

export function buildTranscriptFindIndex(input: {
	rows: readonly Row[];
	rowKeys: readonly string[];
	query: string;
	context: TranscriptFindContext;
	previous?: TranscriptFindIndex | null;
}): TranscriptFindIndex {
	const needle = normalizeFindText(input.query);
	if (!needle) return EMPTY_FIND_INDEX;
	const reusable = input.previous?.needle === needle ? input.previous.rowCache : null;
	const rowCache = new Map<string, readonly RowMatchSeed[]>();
	const matches: TranscriptMatch[] = [];
	for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex++) {
		const row = input.rows[rowIndex];
		if (!row) continue;
		const rowKey = input.rowKeys[rowIndex] ?? String(rowIndex);
		// The streaming row keeps one identity while its text grows, so its cache
		// entry is never trustworthy — rescan it on every rebuild.
		const cached = row.kind === "streaming" ? undefined : reusable?.get(rowKey);
		const seeds = cached ?? seedRow(row, rowKey, needle, input.context);
		rowCache.set(rowKey, seeds);
		for (const seed of seeds) {
			matches.push({
				rowIndex,
				rowKey,
				ordinal: matches.length,
				disclosureKey: seed.disclosureKey,
				locator: { occurrenceInRow: seed.occurrenceInRow },
			});
		}
	}
	return { needle, matches, rowCache };
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
