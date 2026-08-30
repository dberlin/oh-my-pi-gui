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

/** A row's cached seeds, plus the row kind they were scanned from. */
interface RowCacheEntry {
	kind: Row["kind"];
	seeds: readonly RowMatchSeed[];
}

export interface TranscriptFindIndex {
	/** The normalized needle this index was built for ("" = no matches by definition). */
	needle: string;
	matches: readonly TranscriptMatch[];
	/** rowKey → that row's seeds; carried forward when the needle and context are unchanged. */
	rowCache: ReadonlyMap<string, RowCacheEntry>;
	/**
	 * The context this index was built against. A row's searchable text is not
	 * purely a function of its key: a `message` row's key does not move when a
	 * late tool result lands in the *tools* store, only `context` does (its
	 * memo depends on `activeTools`). Reusing cached seeds across a context
	 * change would silently keep serving text scanned before the result
	 * arrived, so the whole cache is dropped whenever `context` differs by
	 * reference from the build that produced it.
	 */
	context: TranscriptFindContext | null;
}

export const EMPTY_FIND_INDEX: TranscriptFindIndex = { needle: "", matches: [], rowCache: new Map(), context: null };

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
	const reusable =
		input.previous?.needle === needle && input.previous.context === input.context ? input.previous.rowCache : null;
	const rowCache = new Map<string, RowCacheEntry>();
	const matches: TranscriptMatch[] = [];
	for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex++) {
		const row = input.rows[rowIndex];
		if (!row) continue;
		const rowKey = input.rowKeys[rowIndex] ?? String(rowIndex);
		// The streaming row keeps one identity while its text grows, so its cache
		// entry is never trustworthy — rescan it on every rebuild. A cached entry
		// scanned under a different row kind (e.g. the row settled from
		// "streaming" to "message" while keeping the same base key) is equally
		// untrustworthy: its text is not the current row's text.
		const cached = reusable?.get(rowKey);
		const seeds =
			row.kind !== "streaming" && cached?.kind === row.kind
				? cached.seeds
				: seedRow(row, rowKey, needle, input.context);
		rowCache.set(rowKey, { kind: row.kind, seeds });
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
	return { needle, matches, rowCache, context: input.context };
}

/** "older" travels backwards through history (down-ordinal); "newer" travels toward the live edge. */
export type FindDirection = "older" | "newer";

export interface FindStep {
	ordinal: number;
	/** True for exactly one step when the move crossed an end of the transcript. */
	wrapped: boolean;
}

/** Opening / re-querying: first match at or above `visibleEndRowIndex`, searching upward, wrapping once to the bottom. */
export function seedFindOrdinal(matches: readonly TranscriptMatch[], visibleEndRowIndex: number): FindStep | null {
	if (matches.length === 0) return null;
	for (let ordinal = matches.length - 1; ordinal >= 0; ordinal--) {
		if ((matches[ordinal]?.rowIndex ?? 0) <= visibleEndRowIndex) return { ordinal, wrapped: false };
	}
	// Everything on screen is older than the oldest match: wrap once to the newest.
	return { ordinal: matches.length - 1, wrapped: true };
}

/** ↵ / ⌘G ("older") and ⇧↵ / ⇧⌘G ("newer"), each wrapping once. */
export function stepFindOrdinal(
	matches: readonly TranscriptMatch[],
	current: number | null,
	direction: FindDirection,
): FindStep | null {
	if (matches.length === 0) return null;
	if (current == null) return { ordinal: direction === "older" ? matches.length - 1 : 0, wrapped: false };
	const next = direction === "older" ? current - 1 : current + 1;
	if (next < 0) return { ordinal: matches.length - 1, wrapped: true };
	if (next >= matches.length) return { ordinal: 0, wrapped: true };
	return { ordinal: next, wrapped: false };
}

/** Keep a live ordinal in range after the index rebuilds; null when there are no matches. */
export function clampFindOrdinal(matches: readonly TranscriptMatch[], current: number | null): number | null {
	if (current == null || matches.length === 0) return null;
	return Math.min(Math.max(current, 0), matches.length - 1);
}

export interface FindTick {
	ordinal: number;
	/** 0..1 down the scroll rail. */
	fraction: number;
}

function clamp01(value: number): number {
	return Math.min(Math.max(value, 0), 1);
}

/** Tick per match from measured virtualizer offsets; unmeasured rows are skipped, not guessed. */
export function findTickPositions(
	matches: readonly TranscriptMatch[],
	offsetForRow: (rowIndex: number) => number | null,
	totalSize: number,
): FindTick[] {
	const ticks: FindTick[] = [];
	for (const match of matches) {
		const offset = offsetForRow(match.rowIndex);
		if (offset == null) continue;
		ticks.push({ ordinal: match.ordinal, fraction: totalSize > 0 ? clamp01(offset / totalSize) : 0 });
	}
	return ticks;
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
