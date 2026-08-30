import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { thinkingDisclosureKey } from "../../stores/messages";
import { useTabsStore } from "../../stores/tabs";
import { scopedDisclosureKey, useUiStore } from "../../stores/ui";
import type { Row } from "./chat-stream-utils";
import type { TranscriptFindContext } from "./transcript-find";
import { clearFindHighlights, paintFindHighlights } from "./transcript-find-highlight";
import {
	TRANSCRIPT_FIND_EVENT,
	type TranscriptFindAction,
	type TranscriptFindEventDetail,
	type TranscriptFindHost,
	type TranscriptFindState,
	type TranscriptFindVirtualizer,
	useTranscriptFind,
} from "./useTranscriptFind";

vi.mock("./transcript-find-highlight", async () => {
	const actual = await vi.importActual<typeof import("./transcript-find-highlight")>("./transcript-find-highlight");
	return { ...actual, paintFindHighlights: vi.fn(), clearFindHighlights: vi.fn() };
});

const { document, window, Event, CustomEvent, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const installedGlobals = {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (handle: number) => clearTimeout(handle as unknown as number),
};
const priorGlobals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
	for (const [key, value] of Object.entries(installedGlobals)) {
		priorGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
});

afterAll(() => {
	for (const [key, descriptor] of priorGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

const mounts: Array<{ container: HTMLElement; root: Root }> = [];

async function mount(node: ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	const root = createRoot(container as unknown as Element);
	mounts.push({ container, root });
	await act(async () => {
		root.render(<I18nProvider>{node}</I18nProvider>);
	});
	return { container, root };
}

afterEach(async () => {
	while (mounts.length > 0) {
		const mounted = mounts.pop();
		if (!mounted) continue;
		await act(async () => {
			mounted.root.unmount();
		});
		mounted.container.remove();
	}
	useTabsStore.getState().reset();
	useUiStore.setState({ disclosureOpen: {} });
	vi.restoreAllMocks();
});

function Probe({ host, onState }: { host: TranscriptFindHost; onState: (s: TranscriptFindState) => void }) {
	const s = useTranscriptFind(host);
	onState(s);
	return <div data-open={String(s.open)} data-total={s.total} data-current={String(s.current)} />;
}

function agentMessage(content: AgentMessage["content"], timestamp = 100): AgentMessage {
	return { role: "assistant", content, timestamp };
}

function textRow(text: string, timestamp = 100): Row {
	return { kind: "message", message: agentMessage([{ type: "text", text }], timestamp) };
}

const BASE_ROWS: Row[] = Array.from({ length: 10 }, (_, i) => {
	if (i === 2) return textRow("needle sits here", 102);
	if (i === 8) return textRow("another needle appears", 108);
	return textRow(`filler row ${i}`, 100 + i);
});
const BASE_ROW_KEYS = BASE_ROWS.map((_, i) => `r${i}`);

const context: TranscriptFindContext = {
	resolveToolCall: () => ({ key: "unused", entry: undefined }),
	lookupToolEntry: () => undefined,
};

function makeVirtualizer(
	scrolls: Array<{ index: number; align?: string }>,
	offsets: number[],
): TranscriptFindVirtualizer {
	return {
		scrollToIndex: (index, options) => scrolls.push({ index, align: options?.align }),
		scrollToOffset: offset => offsets.push(offset),
		getOffsetForIndex: index => [index * 100, "start"] as const,
		getTotalSize: () => 1000,
		range: { startIndex: 0, endIndex: 4 },
	};
}

interface BuiltHost {
	host: TranscriptFindHost;
	rootDiv: HTMLDivElement;
	scrolls: Array<{ index: number; align?: string }>;
	offsets: number[];
	setPinned: ReturnType<typeof vi.fn>;
	clearUserScrollIntent: ReturnType<typeof vi.fn>;
}

function makeHost(overrides: Partial<TranscriptFindHost> = {}): BuiltHost {
	const rootDiv = document.createElement("div") as unknown as HTMLDivElement;
	const scrollDiv = { scrollTop: 640 } as unknown as HTMLDivElement;
	const scrolls: Array<{ index: number; align?: string }> = [];
	const offsets: number[] = [];
	const setPinned = vi.fn();
	const clearUserScrollIntent = vi.fn();
	const host: TranscriptFindHost = {
		transcriptId: "t1",
		isMain: true,
		rows: BASE_ROWS,
		rowKeys: BASE_ROW_KEYS,
		context,
		rootRef: { current: rootDiv },
		scrollRef: { current: scrollDiv },
		virtualizer: makeVirtualizer(scrolls, offsets),
		pinned: true,
		setPinned,
		clearUserScrollIntent,
		...overrides,
	};
	return { host, rootDiv, scrolls, offsets, setPinned, clearUserScrollIntent };
}

let state!: TranscriptFindState;
let host: TranscriptFindHost;
let root: Root | undefined;
let scrolls: Array<{ index: number; align?: string }>;
let offsets: number[];
let setPinned: ReturnType<typeof vi.fn>;
let clearUserScrollIntent: ReturnType<typeof vi.fn>;
let rootDiv: HTMLDivElement;
let focusTarget: unknown = null;

async function mountDefault(): Promise<void> {
	const built = makeHost();
	host = built.host;
	scrolls = built.scrolls;
	offsets = built.offsets;
	setPinned = built.setPinned;
	clearUserScrollIntent = built.clearUserScrollIntent;
	rootDiv = built.rootDiv;
	const mounted = await mount(<Probe host={host} onState={s => (state = s)} />);
	root = mounted.root;
	focusInside(rootDiv);
}

function dispatchFind(action: TranscriptFindAction, options: { fallback?: boolean } = {}): TranscriptFindEventDetail {
	const detail: TranscriptFindEventDetail = { action, fallback: options.fallback ?? false, claimed: false };
	act(() => {
		window.dispatchEvent(new CustomEvent(TRANSCRIPT_FIND_EVENT, { detail }));
	});
	return detail;
}

/** linkedom has no real focus model — drive activeElement directly. */
function focusInside(target: unknown): void {
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => focusTarget });
	focusTarget = target;
}

function blurEverything(): void {
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => null });
}

/**
 * A real `Selection` exposes containment through `getRangeAt(0).commonAncestorContainer`,
 * not through `document.activeElement` — text can be selected inside a non-focusable
 * transcript row without ever moving focus. `container` models that: when given, the
 * fake selection reports one range whose `commonAncestorContainer` is `container`,
 * exactly what `Range.commonAncestorContainer` returns on a real selection.
 */
function stubSelection(text: string, container: unknown = null): void {
	(
		window as unknown as {
			getSelection: () => {
				toString: () => string;
				rangeCount: number;
				getRangeAt: (index: number) => { commonAncestorContainer: unknown };
			};
		}
	).getSelection = () => ({
		toString: () => text,
		rangeCount: container ? 1 : 0,
		getRangeAt: () => ({ commonAncestorContainer: container }),
	});
}

/** Re-render the probe with new host fields; React keeps the hook state. */
async function rerenderHost(patch: Partial<TranscriptFindHost>): Promise<void> {
	host = { ...host, ...patch };
	await act(async () => {
		root?.render(
			<I18nProvider>
				<Probe host={host} onState={s => (state = s)} />
			</I18nProvider>,
		);
	});
}

const rerenderWithRows = (rows: Row[]) => rerenderHost({ rows, rowKeys: rows.map((_, i) => `r${i}`) });
const rerenderWithTranscriptId = (transcriptId: string) => rerenderHost({ transcriptId });

describe("useTranscriptFind", () => {
	it("opens on the routed event, seeds backwards from the viewport's bottom edge, and scrolls centered", async () => {
		// rows 0..9, matches at rowIndex 2 and 8; range.endIndex = 4.
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		expect(state.open).toBe(true);
		expect(state.current).toBe(0);
		expect(scrolls.at(-1)).toEqual({ index: 2, align: "center" });
	});

	it("claims the event only for the viewport containing focus, and falls back to the main viewport", async () => {
		// Two probes mounted: a focused subagent host and an unfocused main host.
		const sub = makeHost({ isMain: false, transcriptId: "sub" });
		const main = makeHost({ isMain: true, transcriptId: "main" });
		let subagentState!: TranscriptFindState;
		let mainState!: TranscriptFindState;
		await mount(<Probe host={sub.host} onState={s => (subagentState = s)} />);
		await mount(<Probe host={main.host} onState={s => (mainState = s)} />);
		focusInside(sub.rootDiv);

		const detail = dispatchFind("open");
		expect(detail.claimed).toBe(true);
		expect(subagentState.open).toBe(true);
		expect(mainState.open).toBe(false);

		// Nothing focused: round one claims nothing, the fallback round goes to main.
		blurEverything();
		const first = dispatchFind("open");
		expect(first.claimed).toBe(false);
		const second = dispatchFind("open", { fallback: true });
		expect(second.claimed).toBe(true);
		expect(mainState.open).toBe(true);
	});

	it("opens the disclosure that hides the landed match", async () => {
		// One match inside a collapsed thinking block.
		useTabsStore.setState({ activeTabId: "tab-1" });
		const thinkingMessage = agentMessage([{ type: "thinking", thinking: "needle reasoning" }], 300);
		const thinkingKey = thinkingDisclosureKey(thinkingMessage, 0);
		const rows: Row[] = [textRow("filler", 100), { kind: "message", message: thinkingMessage }];
		const built = makeHost({ rows, rowKeys: ["r0", "r1"], transcriptId: "disc" });
		let localState!: TranscriptFindState;
		await mount(<Probe host={built.host} onState={s => (localState = s)} />);
		focusInside(built.rootDiv);
		act(() => localState.setQuery("needle"));
		dispatchFind("open");
		const key = scopedDisclosureKey(useTabsStore.getState().activeTabId, thinkingKey);
		expect(useUiStore.getState().disclosureOpen[key]).toBe(true);
	});

	it("sets pinned false and clears scroll intent on navigation, exactly like jumpToConversation", async () => {
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		expect(setPinned).toHaveBeenLastCalledWith(false);
		expect(clearUserScrollIntent).toHaveBeenCalled();
	});

	it("wraps once at the top and reports it for one step", async () => {
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		act(() => state.goOlder()); // ordinal 0 -> wrap
		expect(state.wrapped).toBe(true);
		act(() => state.goOlder());
		expect(state.wrapped).toBe(false);
	});

	it("restores the pre-find scroll offset and pinned state on close", async () => {
		// scrollRef.current.scrollTop = 640; pinned = true at open.
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		act(() => state.close());
		expect(offsets.at(-1)).toBe(640);
		expect(setPinned).toHaveBeenLastCalledWith(true);
		expect(state.query).toBe("needle"); // query survives close
	});

	it("closes and clears the query when the transcript id changes", async () => {
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		await rerenderWithTranscriptId("other-transcript");
		expect(state.open).toBe(false);
		expect(state.query).toBe("");
	});

	it("clamps a dangling ordinal when rows are removed rather than keeping it", async () => {
		// A third match at rowIndex 5 (outside range.endIndex = 4) makes an
		// incorrect re-seed (which would land on ordinal 0, the only match with
		// rowIndex <= 4) diverge from the correct clamp (ordinal 1, the greatest
		// surviving ordinal) — so this test cannot pass by accidental agreement
		// between clampFindOrdinal and a stray seedFindOrdinal re-fire.
		await mountDefault();
		const rowsWithThirdMatch = BASE_ROWS.map((row, i) => (i === 5 ? textRow("needle three", 105) : row));
		await rerenderWithRows(rowsWithThirdMatch);
		act(() => state.setQuery("needle"));
		dispatchFind("open"); // seeds to ordinal 0 (rowIndex 2)
		act(() => state.goNewer()); // -> ordinal 1 (rowIndex 5)
		act(() => state.goNewer()); // -> ordinal 2 (rowIndex 8), the last match
		const rowsWithLastMatchRemoved = rowsWithThirdMatch.map((row, i) =>
			i === 8 ? textRow("no match here", 108) : row,
		);
		// The row's key must change along with its content: buildTranscriptFindIndex
		// caches a row's seeds by rowKey (see transcript-find.ts), so reusing "r8"
		// for genuinely different content would return the stale cached match
		// instead of exercising a real removal.
		const rowKeysAfterRemoval = rowsWithLastMatchRemoved.map((_, i) => (i === 8 ? "r8-edited" : `r${i}`));
		await rerenderHost({ rows: rowsWithLastMatchRemoved, rowKeys: rowKeysAfterRemoval });
		expect(state.total).toBe(2);
		expect(state.current).toBe(1);
		expect(state.current).toBe(state.total - 1);
	});

	it("seeds the query from a non-empty transcript selection", async () => {
		await mountDefault();
		stubSelection("Projected finalized", rootDiv);
		dispatchFind("open");
		expect(state.query).toBe("Projected finalized");
	});

	it("seeds from a selection inside rootRef even when nothing there is focused", async () => {
		// Dragging a text selection across a non-focusable row never moves
		// document.activeElement — and in the fallback round activeElement is
		// guaranteed not to be inside any rootRef at all, since that is the
		// entire reason the fallback round exists. Seeding must key off the
		// selection's own containment (via getRangeAt(0).commonAncestorContainer),
		// not focus.
		await mountDefault();
		blurEverything();
		stubSelection("Projected finalized", rootDiv);
		dispatchFind("open", { fallback: true });
		expect(state.query).toBe("Projected finalized");
	});

	it("repaints matches when the virtualizer's rendered range changes, even though matches/current/open are unchanged", async () => {
		// On a plain scroll, rows/rowKeys/context are memoized and the virtualizer
		// instance is stable, so matches/current/open never change — only the
		// mounted (rendered) range does. The repaint effect must still re-run, or
		// a match scrolled out of view and back stays unhighlighted.
		const paintMock = vi.mocked(paintFindHighlights);
		paintMock.mockClear();
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		const callsAfterOpen = paintMock.mock.calls.length;
		expect(callsAfterOpen).toBeGreaterThan(0);

		await rerenderHost({
			virtualizer: { ...host.virtualizer, range: { startIndex: 4, endIndex: 8 } },
		});
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		expect(paintMock.mock.calls.length).toBeGreaterThan(callsAfterOpen);
	});

	it("does not clear another instance's highlights just because a new instance mounts", async () => {
		// clearFindHighlights writes to the single process-wide CSS.highlights
		// registry. A second mounted instance (e.g. a newly expanded subagent
		// panel) must not wipe it out from under the first instance's open find
		// session just by mounting for the first time.
		const clearMock = vi.mocked(clearFindHighlights);
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0));
		});
		clearMock.mockClear();

		const second = makeHost({ transcriptId: "sub-panel" });
		await mount(<Probe host={second.host} onState={() => {}} />);

		expect(clearMock).not.toHaveBeenCalled();
	});

	it("recomputes tick fractions when the virtualizer's rendered range/measurements change, even though its instance identity is stable", async () => {
		// The real @tanstack/react-virtual instance keeps one object identity for
		// its whole life — only its fields (range, measured offsets) change on
		// scroll — so the ticks memo must not depend on that identity alone.
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		const before = state.ticks;

		const mutableVirtualizer = host.virtualizer as {
			getOffsetForIndex: TranscriptFindVirtualizer["getOffsetForIndex"];
			getTotalSize: () => number;
			range: { startIndex: number; endIndex: number } | null;
		};
		// Deliberately not a uniform rescaling of the original 100/1000 (which
		// would happen to reproduce the same fractions by coincidence).
		mutableVirtualizer.getOffsetForIndex = index => [index * 300, "start"] as const;
		mutableVirtualizer.getTotalSize = () => 4000;
		mutableVirtualizer.range = { startIndex: 4, endIndex: 8 };
		await rerenderHost({});

		expect(state.ticks).not.toEqual(before);
	});

	it("closes find on Escape even when focus is not in the query input (e.g. after clicking a transcript row)", async () => {
		// TranscriptFindBar's own Escape handler lives on the query input and
		// never sees this key once focus has moved elsewhere in the pane.
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		expect(state.open).toBe(true);

		focusInside(rootDiv);
		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "Escape" });
		act(() => {
			rootDiv.dispatchEvent(event);
		});

		expect(state.open).toBe(false);
		expect(event.defaultPrevented).toBe(true);
	});

	it("does not re-save the pre-find scroll position when opening while already open", async () => {
		// ⌘F → navigate → ⌘F → Esc must restore the *pre-find* view, not the
		// match position at the moment of the second ⌘F.
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open"); // saves scrollTop 640 (host.scrollRef.current.scrollTop at open)
		if (host.scrollRef.current) host.scrollRef.current.scrollTop = 999; // simulates landing on a match
		dispatchFind("open"); // re-select while already open — must not resave 999
		act(() => state.close());
		expect(offsets.at(-1)).toBe(640);
	});
});
