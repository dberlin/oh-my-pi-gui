/**
 * Coverage for `AppGlobalActions`'s global keydown → keymap dispatch boundary,
 * scoped to the transcript find chords (⌘F/⌃F, ⌘G, ⇧⌘G). The full dispatch
 * switch for the rest of `KEYMAP_ACTIONS` is exercised indirectly by the
 * feature tests for each action's effect; this file only needs to prove the
 * find chords reach `TRANSCRIPT_FIND_EVENT` with the right routing detail,
 * and that the overlay-suppression guard still applies to them.
 */

import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppGlobalActions } from "./App";
import type { TranscriptFindEventDetail } from "./components/chat/useTranscriptFind";
import { TRANSCRIPT_FIND_EVENT } from "./components/chat/useTranscriptFind";
import { I18nProvider } from "./lib/i18n";
import { useUiStore } from "./stores/ui";

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
};
const priorGlobals = new Map<string, PropertyDescriptor | undefined>();
const mounts: Array<{ container: HTMLElement; root: Root }> = [];

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

// AppGlobalActions' second effect unconditionally subscribes
// `window.omp.events.onMenuAction` on mount (unrelated to find, but it runs
// in the same component) — stub the minimal surface it and `hydrateKeymap`'s
// prefs read touch so mounting doesn't throw.
(window as unknown as { omp: unknown }).omp = {
	events: { onMenuAction: () => () => {} },
	prefs: { get: async () => undefined, set: async () => undefined },
};

async function mount(node: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	const root = createRoot(container as unknown as Element);
	mounts.push({ container, root });
	await act(async () => {
		root.render(<I18nProvider>{node}</I18nProvider>);
	});
	return container;
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
	useUiStore.setState({ commandPaletteOpen: false });
});

interface ChordInit {
	code: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
}

/**
 * Synthesize a keydown the way `App.tsx`'s global handler reads it. linkedom
 * has no `KeyboardEvent` constructor — same escape hatch as
 * TranscriptFindBar.test.tsx / TranscriptViewport.test.tsx: build a plain
 * `Event` and stamp on the fields `chordFromEvent`/`onKey` actually read.
 */
function pressChord(init: ChordInit): void {
	const event = new window.Event("keydown", { bubbles: true, cancelable: true }) as Event & {
		key: string;
		code: string;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
		metaKey: boolean;
		repeat: boolean;
		isComposing: boolean;
		keyCode: number;
	};
	event.key = init.code.replace(/^Key/, "").toLowerCase();
	event.code = init.code;
	event.ctrlKey = init.ctrlKey ?? false;
	event.altKey = init.altKey ?? false;
	event.shiftKey = init.shiftKey ?? false;
	event.metaKey = init.metaKey ?? false;
	event.repeat = false;
	event.isComposing = false;
	event.keyCode = 0;
	act(() => {
		window.dispatchEvent(event);
	});
}

describe("AppGlobalActions transcript find dispatch", () => {
	let seen: TranscriptFindEventDetail[];
	let onFindEvent: (event: Event) => void;

	beforeEach(() => {
		seen = [];
		onFindEvent = event => seen.push((event as CustomEvent<TranscriptFindEventDetail>).detail);
		window.addEventListener(TRANSCRIPT_FIND_EVENT, onFindEvent);
	});

	afterEach(() => {
		window.removeEventListener(TRANSCRIPT_FIND_EVENT, onFindEvent);
	});

	// The brief's pseudo-code has this pair share one `seen` array declared
	// inside the first `it` and mount only once; that reads as a stray "shared
	// describe fixture" sketch, not runnable code — `seen` would be out of
	// scope in the second `it`, and an unmounted-between-tests component would
	// leak DOM/listener state across tests. Rebuilt as two independent tests,
	// each with its own listener registration (beforeEach/afterEach above) and
	// its own mount, that assert the same behavior.
	it("dispatches the routed find event for ⌘F, ⌘G, and ⇧⌘G", async () => {
		await mount(<AppGlobalActions />);

		pressChord({ code: "KeyF", metaKey: true });
		pressChord({ code: "KeyG", metaKey: true });
		pressChord({ code: "KeyG", metaKey: true, shiftKey: true });

		expect(seen.map(d => [d.action, d.fallback])).toEqual([
			["open", false],
			["open", true],
			["next", false],
			["next", true],
			["previous", false],
			["previous", true],
		]);
	});

	it("does not dispatch find while an overlay owns the keyboard", async () => {
		useUiStore.setState({ commandPaletteOpen: true });
		await mount(<AppGlobalActions />);

		pressChord({ code: "KeyF", metaKey: true });

		expect(seen).toHaveLength(0);
	});
});
