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
import {
	TRANSCRIPT_FIND_EVENT,
	type TranscriptFindAction,
	type TranscriptFindEventDetail,
	type TranscriptFindHost,
	type TranscriptFindState,
	type TranscriptFindVirtualizer,
	useTranscriptFind,
} from "./useTranscriptFind";

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

function stubSelection(text: string): void {
	(window as unknown as { getSelection: () => { toString: () => string } }).getSelection = () => ({
		toString: () => text,
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
		await mountDefault();
		act(() => state.setQuery("needle"));
		dispatchFind("open");
		act(() => state.goNewer()); // land on the last match
		const rowsWithLastMatchRemoved = BASE_ROWS.map((row, i) => (i === 8 ? textRow("no match here", 108) : row));
		await rerenderWithRows(rowsWithLastMatchRemoved);
		expect(state.current).toBe(state.total - 1);
	});

	it("seeds the query from a non-empty transcript selection", async () => {
		await mountDefault();
		stubSelection("Projected finalized");
		dispatchFind("open");
		expect(state.query).toBe("Projected finalized");
	});
});
