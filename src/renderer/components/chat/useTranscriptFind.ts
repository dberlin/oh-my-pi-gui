/**
 * Owns ⌘F find state and drives the pure modules from Tasks 1-4: builds the
 * index from `transcript-find.ts`, paints matches via
 * `transcript-find-highlight.ts`, and exposes props/callbacks for the
 * presentational `TranscriptFindBar`. Task 7 wires this hook into
 * `TranscriptViewport` and dispatches `TRANSCRIPT_FIND_EVENT` from `App.tsx`.
 *
 * Two-round event routing: `App.tsx` dispatches one `window` CustomEvent per
 * ⌘F/⌘G/⇧⌘G press. Round one lets the viewport containing focus claim it;
 * if nothing claims (nothing focused inside any transcript), `App.tsx`
 * re-dispatches with `fallback: true` and only the main-mode viewport may
 * claim that round. Every mounted `useTranscriptFind` instance runs the same
 * claim rule against the same event.
 */

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { scopedDisclosureKey, useDisclosureScope, useUiStore } from "../../stores/ui";
import type { Row } from "./chat-stream-utils";
import {
	buildTranscriptFindIndex,
	clampFindOrdinal,
	EMPTY_FIND_INDEX,
	type FindStep,
	type FindTick,
	findTickPositions,
	seedFindOrdinal,
	stepFindOrdinal,
	type TranscriptFindContext,
	type TranscriptFindIndex,
	type TranscriptMatch,
} from "./transcript-find";
import { clearFindHighlights, type FindHighlightTarget, paintFindHighlights } from "./transcript-find-highlight";

export const TRANSCRIPT_FIND_EVENT = "omp:transcript-find";

export type TranscriptFindAction = "open" | "next" | "previous";

/**
 * Routing detail for the window event App.tsx dispatches. Round one: the
 * viewport containing document.activeElement claims it. If nothing claimed,
 * App re-dispatches with `fallback: true` and the main-mode viewport claims.
 */
export interface TranscriptFindEventDetail {
	action: TranscriptFindAction;
	fallback: boolean;
	claimed: boolean;
}

/** Structural view of the virtualizer — lets tests pass a stub. */
export interface TranscriptFindVirtualizer {
	scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void;
	scrollToOffset: (offset: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void;
	getOffsetForIndex: (
		index: number,
		align?: "start" | "center" | "end" | "auto",
	) => readonly [number, string] | undefined;
	getTotalSize: () => number;
	range: { startIndex: number; endIndex: number } | null;
}

export interface TranscriptFindHost {
	transcriptId: string;
	isMain: boolean;
	rows: readonly Row[];
	rowKeys: readonly string[];
	context: TranscriptFindContext;
	/** The viewport root, for focus containment and mounted-row lookup. */
	rootRef: RefObject<HTMLDivElement | null>;
	/** The scroll container, for save/restore of scrollTop. */
	scrollRef: RefObject<HTMLDivElement | null>;
	virtualizer: TranscriptFindVirtualizer;
	pinned: boolean;
	setPinned: (pinned: boolean) => void;
	/** Mirrors jumpToConversation: clears userScrollIntentRef so a programmatic scroll never unpins. */
	clearUserScrollIntent: () => void;
}

export interface TranscriptFindState {
	open: boolean;
	query: string;
	setQuery: (query: string) => void;
	total: number;
	current: number | null;
	wrapped: boolean;
	ticks: readonly FindTick[];
	matches: readonly TranscriptMatch[];
	goOlder: () => void;
	goNewer: () => void;
	close: () => void;
	inputRef: RefObject<HTMLInputElement | null>;
}

interface SavedView {
	scrollTop: number;
	pinned: boolean;
}

/** Everything the stable window listener and the query-seeding effect need, kept fresh via a no-deps effect. */
interface LiveState {
	host: TranscriptFindHost;
	matches: readonly TranscriptMatch[];
	needle: string;
	landOn: (step: FindStep) => void;
	doOpen: () => void;
	goOlder: () => void;
	goNewer: () => void;
}

export function useTranscriptFind(host: TranscriptFindHost): TranscriptFindState {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [current, setCurrent] = useState<number | null>(null);
	const [wrapped, setWrapped] = useState(false);

	const indexRef = useRef<TranscriptFindIndex>(EMPTY_FIND_INDEX);
	const savedViewRef = useRef<SavedView | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const scope = useDisclosureScope();

	const index = useMemo(() => {
		const built = buildTranscriptFindIndex({
			rows: host.rows,
			rowKeys: host.rowKeys,
			query,
			context: host.context,
			previous: indexRef.current,
		});
		indexRef.current = built;
		return built;
	}, [query, host.rowKeys, host.rows, host.context]);

	const matches = index.matches;

	// A compaction or session switch can shrink the match list out from under a
	// live ordinal; clamp rather than strand it or silently keep a stale index.
	useEffect(() => {
		setCurrent(c => clampFindOrdinal(matches, c));
	}, [matches]);

	const landOn = useCallback(
		(step: FindStep) => {
			const match = matches[step.ordinal];
			if (!match) return;
			setCurrent(step.ordinal);
			setWrapped(step.wrapped);
			if (match.disclosureKey != null) {
				useUiStore.getState().setDisclosureOpen(scopedDisclosureKey(scope, match.disclosureKey), true);
			}
			// Mirrors jumpToConversation: clear scroll intent and unpin before a
			// programmatic scroll, so it is never mistaken for the user's own
			// gesture. `center`, not `start`, so a match near a row's end is not
			// parked under the find bar.
			host.clearUserScrollIntent();
			host.setPinned(false);
			host.virtualizer.scrollToIndex(match.rowIndex, { align: "center" });
		},
		[matches, scope, host],
	);

	const goOlder = useCallback(() => {
		const step = stepFindOrdinal(matches, current, "older");
		if (step) landOn(step);
	}, [matches, current, landOn]);

	const goNewer = useCallback(() => {
		const step = stepFindOrdinal(matches, current, "newer");
		if (step) landOn(step);
	}, [matches, current, landOn]);

	const doOpen = useCallback(() => {
		savedViewRef.current = { scrollTop: host.scrollRef.current?.scrollTop ?? 0, pinned: host.pinned };
		const selection = window.getSelection?.();
		const selectionText = selection?.toString() ?? "";
		// Containment is checked through the selection's own range, not
		// document.activeElement: dragging a selection across a non-focusable
		// row never moves focus, and in the fallback round activeElement is
		// guaranteed not to be inside any rootRef (that is the entire reason
		// the fallback round exists), so a focus-based check could never seed
		// there at all.
		const selectionNode =
			selection && selection.rangeCount > 0 ? selection.getRangeAt(0).commonAncestorContainer : null;
		if (selectionText.trim().length > 0 && host.rootRef.current?.contains(selectionNode)) {
			setQuery(selectionText);
		}
		setOpen(true);
		// Opening while already open re-selects instead of clearing: focus/select
		// run unconditionally on every "open" action.
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
	}, [host]);

	const close = useCallback(() => {
		setOpen(false);
		setWrapped(false);
		clearFindHighlights();
		const saved = savedViewRef.current;
		if (saved) {
			host.virtualizer.scrollToOffset(saved.scrollTop);
			host.setPinned(saved.pinned);
		}
	}, [host]);

	// Kept fresh every render (no deps) so the stable window listener and the
	// query-seeding effect below never close over a stale host/query/action.
	const liveRef = useRef<LiveState>({ host, matches, needle: index.needle, landOn, doOpen, goOlder, goNewer });
	useEffect(() => {
		liveRef.current = { host, matches, needle: index.needle, landOn, doOpen, goOlder, goNewer };
	});

	// Registered once. Re-registering on every keystroke would let a stale
	// closure claim the event with an old query — reads everything through
	// liveRef instead.
	useEffect(() => {
		function handleFindEvent(event: Event): void {
			const detail = (event as CustomEvent<TranscriptFindEventDetail>).detail;
			if (!detail || detail.claimed) return;
			const liveHost = liveRef.current.host;
			if (!detail.fallback) {
				if (!liveHost.rootRef.current?.contains(document.activeElement)) return;
			} else if (!liveHost.isMain) {
				return;
			}
			detail.claimed = true;
			if (detail.action === "open") liveRef.current.doOpen();
			else if (detail.action === "next") liveRef.current.goOlder();
			else liveRef.current.goNewer();
		}
		window.addEventListener(TRANSCRIPT_FIND_EVENT, handleFindEvent);
		return () => window.removeEventListener(TRANSCRIPT_FIND_EVENT, handleFindEvent);
	}, []);

	// Seeding on query change: only re-seeds when the query itself changes (or
	// find opens) — an unrelated rows change (e.g. a streamed append) must not
	// rip the current match away, which is why matches/host/landOn are read
	// through liveRef rather than listed as deps.
	// biome-ignore lint/correctness/useExhaustiveDependencies: query is the explicit re-seed trigger, read through liveRef so unrelated matches/host changes don't also trigger it
	useEffect(() => {
		if (!open) return;
		const { matches: liveMatches, host: liveHost, landOn: liveLandOn } = liveRef.current;
		const visibleEnd = liveHost.virtualizer.range?.endIndex ?? liveHost.rows.length - 1;
		const step = seedFindOrdinal(liveMatches, visibleEnd);
		if (step) liveLandOn(step);
		else setCurrent(null);
	}, [query, open]);

	// Transcript switch: scroll intent, pinned state, and the size cache already
	// reset elsewhere in the viewport on transcriptId change — find state must
	// follow the same rule rather than carrying a stale query/highlight across.
	// biome-ignore lint/correctness/useExhaustiveDependencies: transcriptId is the explicit reset trigger, not read in the body
	useEffect(() => {
		setOpen(false);
		setQuery("");
		setCurrent(null);
		setWrapped(false);
		clearFindHighlights();
	}, [host.transcriptId]);

	// Repaint: must run after the scroll and after any disclosure reveal
	// commits, so it is scheduled with requestAnimationFrame and cancelled on
	// cleanup, exactly like the viewport's existing pinned-follow effect.
	// host/needle come through liveRef so the effect's own deps can stay
	// exactly [matches, current, open] as specified.
	// biome-ignore lint/correctness/useExhaustiveDependencies: matches is the explicit repaint trigger; host/needle are read through liveRef
	useEffect(() => {
		if (!open) return;
		const { host: liveHost, matches: liveMatches, needle } = liveRef.current;
		const root = liveHost.rootRef.current;
		if (!root) return;
		const frame = requestAnimationFrame(() => {
			const currentMatch = current != null ? liveMatches[current] : undefined;
			const byRow = new Map<number, FindHighlightTarget>();
			for (const element of Array.from(root.querySelectorAll("[data-index]"))) {
				const rowIndex = Number((element as HTMLElement).dataset.index);
				if (!Number.isFinite(rowIndex)) continue;
				const rowMatches = liveMatches.filter(m => m.rowIndex === rowIndex);
				if (rowMatches.length === 0) continue;
				const currentOccurrence =
					currentMatch && currentMatch.rowIndex === rowIndex ? currentMatch.locator.occurrenceInRow : null;
				byRow.set(rowIndex, {
					rowElement: element,
					occurrences: rowMatches.map(m => m.locator.occurrenceInRow),
					currentOccurrence,
				});
			}
			paintFindHighlights(Array.from(byRow.values()), needle);
		});
		return () => {
			cancelAnimationFrame(frame);
			clearFindHighlights();
		};
	}, [matches, current, open]);

	const ticks = useMemo(
		() =>
			findTickPositions(
				matches,
				rowIndex => host.virtualizer.getOffsetForIndex(rowIndex, "start")?.[0] ?? null,
				host.virtualizer.getTotalSize(),
			),
		[matches, host.virtualizer],
	);

	return {
		open,
		query,
		setQuery,
		total: matches.length,
		current,
		wrapped,
		ticks,
		matches,
		goOlder,
		goNewer,
		close,
		inputRef,
	};
}
