/**
 * Owns ⌘F find state and drives the pure modules that build the index
 * (`transcript-find.ts`) and paint matches (`transcript-find-highlight.ts`),
 * exposing props/callbacks for the presentational `TranscriptFindBar`. This
 * hook is wired into `TranscriptViewport`; `App.tsx` owns the keybindings and
 * dispatches `TRANSCRIPT_FIND_EVENT` on ⌘F/⌘G/⇧⌘G.
 *
 * Two-round event routing: `App.tsx` dispatches one `window` CustomEvent per
 * ⌘F/⌘G/⇧⌘G press. Round one lets the viewport containing focus claim it;
 * if nothing claims (nothing focused inside any transcript), `App.tsx`
 * re-dispatches with `fallback: true` and only the main-mode viewport may
 * claim that round. Every mounted `useTranscriptFind` instance runs the same
 * claim rule against the same event.
 */

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
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

/**
 * Broadcast on the same window-event channel whenever one instance opens its
 * own find session. `paintFindHighlights`/`clearFindHighlights` write to a
 * single process-wide `CSS.highlights` registry, so a split workspace with
 * several mounted `TranscriptViewport`s must never have two find sessions
 * open at once — their repaints would clobber each other. Not exported: this
 * is a private channel between `useTranscriptFind` instances, not part of the
 * public find API.
 */
const TRANSCRIPT_FIND_OPENED_EVENT = "omp:transcript-find-opened";

export type TranscriptFindAction = "open" | "next" | "previous";

/**
 * Routing detail for the window event App.tsx dispatches. Round one: the
 * viewport containing document.activeElement claims it. If nothing claimed,
 * App re-dispatches with `fallback: true` and the focused pane's main viewport claims.
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
	/** Mount an enclosing process before revealing a disclosure inside it. */
	expandProcess: (rowKey: string) => void;
}

export interface TranscriptFindState {
	open: boolean;
	query: string;
	setQuery: (query: string) => void;
	total: number;
	current: number | null;
	wrapped: boolean;
	ticks: readonly FindTick[];
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
	runtimeTabId: string | null;
	matches: readonly TranscriptMatch[];
	needle: string;
	open: boolean;
	landOn: (step: FindStep) => void;
	doOpen: () => void;
	doClose: () => void;
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
	// Guards the transcriptId reset effect against running on this instance's
	// own mount — see the comment above that effect.
	const didMountRef = useRef(false);
	const scope = useDisclosureScope();
	const runtimeTabId = useRuntimeTabId();
	// Stable per-instance identity for the single-open-session broadcast below.
	// A plain object (not a string) is enough: it never leaves this same JS
	// realm, so reference equality is all `handleOpenedElsewhere` needs.
	const instanceIdRef = useRef<object>({});

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
			const row = host.rows[match.rowIndex];
			if (row?.kind === "process") host.expandProcess(match.rowKey);
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
		// Only the transition into find saves the pre-find view. Opening while
		// already open (re-selecting the query) must not overwrite it with the
		// current match position, or ⌘F → navigate → ⌘F → Esc would restore the
		// match instead of where the user actually was before find opened.
		if (!open) {
			savedViewRef.current = { scrollTop: host.scrollRef.current?.scrollTop ?? 0, pinned: host.pinned };
		}
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
		// Tell every other mounted instance a find session just opened here, so at
		// most one stays open — see TRANSCRIPT_FIND_OPENED_EVENT above.
		window.dispatchEvent(new CustomEvent(TRANSCRIPT_FIND_OPENED_EVENT, { detail: instanceIdRef.current }));
		// Opening while already open re-selects instead of clearing. Only that
		// case is handled here: the input is already mounted, so the frame is
		// just letting a selection-seeded `setQuery` commit before `select()`.
		// A first open mounts the bar, and TranscriptFindBar claims focus in its
		// own mount effect — scheduling that focus here would race React's
		// commit and land on a null ref (⌘F appearing to need two presses).
		if (open) {
			requestAnimationFrame(() => {
				inputRef.current?.focus();
				inputRef.current?.select();
			});
		}
	}, [host, open]);

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
	const liveRef = useRef<LiveState>({
		host,
		runtimeTabId,
		matches,
		needle: index.needle,
		open,
		landOn,
		doOpen,
		doClose: close,
		goOlder,
		goNewer,
	});
	useEffect(() => {
		liveRef.current = {
			host,
			runtimeTabId,
			matches,
			needle: index.needle,
			open,
			landOn,
			doOpen,
			doClose: close,
			goOlder,
			goNewer,
		};
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
			} else if (
				!liveHost.isMain ||
				(liveRef.current.runtimeTabId ?? useTabsStore.getState().activeTabId) !== useTabsStore.getState().activeTabId
			) {
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

	// At most one find session may be open at a time across every mounted
	// viewport (main plus any split-workspace subagent projections): they all
	// share the process-wide CSS.highlights registry that paintFindHighlights
	// writes to, so two open sessions would repaint over each other. Whichever
	// instance opens most recently wins; every other currently-open instance
	// closes itself in response to that instance's TRANSCRIPT_FIND_OPENED_EVENT.
	useEffect(() => {
		function handleOpenedElsewhere(event: Event): void {
			const detail = (event as CustomEvent<object>).detail;
			if (detail === instanceIdRef.current) return;
			if (liveRef.current.open) liveRef.current.doClose();
		}
		window.addEventListener(TRANSCRIPT_FIND_OPENED_EVENT, handleOpenedElsewhere);
		return () => window.removeEventListener(TRANSCRIPT_FIND_OPENED_EVENT, handleOpenedElsewhere);
	}, []);

	// Seeding on query change: only re-seeds when the query itself changes (or
	// find opens) — an unrelated rows change (e.g. a streamed append) must not
	// rip the current match away, which is why matches/host/landOn are read
	// through liveRef rather than listed as deps.
	// Deps are deliberate: query is the explicit re-seed trigger, read through liveRef so unrelated matches/host changes don't also trigger it
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
	// Skipped on mount (didMountRef): this effect runs unconditionally the first
	// time any effect runs, transcriptId change or not, and clearFindHighlights
	// writes to the single process-wide CSS.highlights registry — a *new*
	// instance mounting (e.g. expanding a subagent panel while find is already
	// open in the main transcript) must not wipe another instance's highlights
	// just because it mounted.
	// Deps are deliberate: transcriptId is the explicit reset trigger, not read in the body
	useEffect(() => {
		if (!didMountRef.current) {
			didMountRef.current = true;
			return;
		}
		setOpen(false);
		setQuery("");
		setCurrent(null);
		setWrapped(false);
		clearFindHighlights();
	}, [host.transcriptId]);

	// Escape closes find even when focus has moved elsewhere in the pane (e.g.
	// after clicking a message row) — TranscriptFindBar's own Escape handler
	// only fires while the query input itself has focus. A listener on rootRef
	// intercepts the key during the native DOM bubble phase, which reaches this
	// node before it reaches the window-level listener in App.tsx that aborts
	// the running turn, so preventDefault() here reliably wins regardless of
	// listener registration order (App.tsx itself is not modified).
	useEffect(() => {
		const root = host.rootRef.current;
		if (!root) return;
		function handleKeyDown(event: KeyboardEvent): void {
			if (event.key !== "Escape" || !liveRef.current.open) return;
			event.preventDefault();
			liveRef.current.doClose();
		}
		root.addEventListener("keydown", handleKeyDown);
		return () => root.removeEventListener("keydown", handleKeyDown);
	}, [host.rootRef]);

	// The virtualizer instance itself is stable (@tanstack/react-virtual keeps
	// one object identity for its whole life), so a plain scroll changes only
	// its `range` field, not its reference. Both the repaint effect below and
	// the ticks memo must react to that field directly, or a match scrolled out
	// of view and back stays unhighlighted, and tick fractions freeze.
	const rangeStart = host.virtualizer.range?.startIndex ?? null;
	const rangeEnd = host.virtualizer.range?.endIndex ?? null;

	// Repaint: must run after the scroll and after any disclosure reveal
	// commits, so it is scheduled with requestAnimationFrame and cancelled on
	// cleanup, exactly like the viewport's existing pinned-follow effect.
	// host/needle come through liveRef so the effect doesn't need them as deps;
	// rangeStart/rangeEnd are read directly (not through liveRef) purely to
	// retrigger the effect when the mounted row set changes.
	// Deps are deliberate: matches/rangeStart/rangeEnd are the explicit repaint triggers; host/needle are read through liveRef
	useEffect(() => {
		if (!open) return;
		const { host: liveHost, matches: liveMatches, needle } = liveRef.current;
		const root = liveHost.rootRef.current;
		if (!root) return;
		const frame = requestAnimationFrame(() => {
			const currentMatch = current != null ? liveMatches[current] : undefined;
			const matchesByRow = new Map<number, TranscriptMatch[]>();
			for (const match of liveMatches) {
				const list = matchesByRow.get(match.rowIndex);
				if (list) list.push(match);
				else matchesByRow.set(match.rowIndex, [match]);
			}
			const byRow = new Map<number, FindHighlightTarget>();
			for (const element of Array.from(root.querySelectorAll("[data-index]"))) {
				const rowIndex = Number((element as HTMLElement).dataset.index);
				if (!Number.isFinite(rowIndex) || !matchesByRow.has(rowIndex)) continue;
				const currentOccurrence =
					currentMatch && currentMatch.rowIndex === rowIndex ? currentMatch.locator.occurrenceInRow : null;
				byRow.set(rowIndex, { rowElement: element, currentOccurrence });
			}
			paintFindHighlights(Array.from(byRow.values()), needle);
		});
		return () => {
			cancelAnimationFrame(frame);
			clearFindHighlights();
		};
	}, [matches, current, open, rangeStart, rangeEnd]);

	// rangeStart/rangeEnd aren't read in the body below — they force a
	// recompute when measurements settle on scroll, since host.virtualizer's
	// identity doesn't change (see comment above rangeStart/rangeEnd).
	// Deps are deliberate: rangeStart/rangeEnd retrigger recompute as measurements settle; not read in the body
	const ticks = useMemo(
		() =>
			findTickPositions(
				matches,
				rowIndex => host.virtualizer.getOffsetForIndex(rowIndex, "start")?.[0] ?? null,
				host.virtualizer.getTotalSize(),
			),
		[matches, host.virtualizer, rangeStart, rangeEnd],
	);

	return {
		open,
		query,
		setQuery,
		total: matches.length,
		current,
		wrapped,
		ticks,
		goOlder,
		goNewer,
		close,
		inputRef,
	};
}
