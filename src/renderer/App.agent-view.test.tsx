import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { MenuAction, MenuActionPayload } from "../shared/ipc-types";
import { AppGlobalActions } from "./App";
import { I18nProvider } from "./lib/i18n";
import { resetTabRoute } from "./lib/tab-routing";
import { useAgentViewStore } from "./stores/agent-view";
import { useUiStore } from "./stores/ui";

const parsed = parseHTML("<html><body></body></html>");
const testWindow = parsed.window;
const testDocument = parsed.document;
const globals = globalThis as Record<string, unknown>;
const storage = new Map<string, string>();
Object.assign(globals, {
	window: testWindow,
	document: testDocument,
	Event: testWindow.Event,
	CustomEvent: testWindow.CustomEvent,
	HTMLElement: testWindow.HTMLElement,
	HTMLTextAreaElement: testWindow.HTMLTextAreaElement,
	Element: testWindow.Element,
	Node: testWindow.Node,
	MutationObserver: testWindow.MutationObserver,
	localStorage: {
		clear: () => storage.clear(),
		getItem: (key: string) => storage.get(key) ?? null,
		key: (index: number) => [...storage.keys()][index] ?? null,
		get length() {
			return storage.size;
		},
		removeItem: (key: string) => storage.delete(key),
		setItem: (key: string, value: string) => storage.set(key, value),
	},
	IS_REACT_ACT_ENVIRONMENT: true,
});

const ok = (data?: unknown) => ({ type: "response" as const, command: "test", success: true as const, data });
const subscribe = () => () => {};

type MenuListener = (action: MenuAction, payload?: MenuActionPayload) => void;

interface ComposerFillDetail {
	text: string;
	images?: unknown[];
	prepend?: boolean;
}

let container: Element | null = null;
let root: Root | null = null;
let menuListener: MenuListener;
let cycleModel: Mock;
let cycleThinkingLevel: Mock;
let dequeue: Mock;
let prefsSet: Mock;
let composerFills: ComposerFillDetail[];

function captureComposerFill(event: Event): void {
	composerFills.push((event as CustomEvent<ComposerFillDetail>).detail);
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mountApp(): Promise<void> {
	cycleModel = vi.fn(async () => ok());
	cycleThinkingLevel = vi.fn(async () => ok());
	dequeue = vi.fn(async () => ok({ messages: [{ text: "restored Main queue item", mode: "followUp" as const }] }));
	prefsSet = vi.fn(async () => ({}));
	const events = {
		onMenuAction: (listener: MenuListener) => {
			menuListener = listener;
			return subscribe();
		},
	};
	const rpc = { cycleModel, cycleThinkingLevel, dequeue };
	(testWindow as unknown as Record<string, unknown>).omp = {
		events,
		rpc,
		prefs: { get: vi.fn(async () => null), set: prefsSet },
	};

	container = testDocument.createElement("div") as unknown as Element;
	testDocument.body.appendChild(container as never);
	const mountedRoot = createRoot(container);
	root = mountedRoot;
	await act(async () => {
		mountedRoot.render(
			<I18nProvider>
				<AppGlobalActions />
			</I18nProvider>,
		);
	});
	await flush();
}

async function pressKey(init: KeyboardEventInit): Promise<void> {
	const event = new testWindow.Event("keydown", { bubbles: true, cancelable: true });
	for (const [key, value] of Object.entries(init)) {
		Object.defineProperty(event, key, { configurable: true, value });
	}
	await act(async () => testWindow.dispatchEvent(event));
}

async function selectSubagent(): Promise<void> {
	await act(async () => useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "sub-1" }));
}

async function runMenuAction(action: MenuAction): Promise<void> {
	await act(async () => menuListener(action));
}

function resetUiState(): void {
	useUiStore.setState({
		commandPaletteOpen: false,
		hotkeysOpen: false,
		keymapHydrated: false,
		keymapOverrides: {},
		modelPickerOpen: false,
		panelVisible: false,
		settingsOpen: false,
		sidebarVisible: false,
		toolsExpandAll: { expanded: false, seq: 0 },
	});
}

beforeEach(() => {
	resetTabRoute();
	useAgentViewStore.getState().reset();
	resetUiState();
	composerFills = [];
	testWindow.addEventListener("omp:fill-composer", captureComposerFill);
});

afterEach(async () => {
	if (root) {
		await flush();
		await act(async () => root?.unmount());
	}
	container?.remove();
	root = null;
	container = null;
	testWindow.removeEventListener("omp:fill-composer", captureComposerFill);
	resetTabRoute();
	useAgentViewStore.getState().reset();
	resetUiState();
	vi.restoreAllMocks();
});

describe("App global actions in selected-subagent mode", () => {
	it("runs a Main RPC shortcut on Main and ignores it for a selected subagent", async () => {
		await mountApp();
		await pressKey({ key: "p", code: "KeyP", ctrlKey: true });
		expect(cycleModel).toHaveBeenCalledTimes(1);

		await selectSubagent();
		await pressKey({ key: "p", code: "KeyP", ctrlKey: true });
		expect(cycleModel).toHaveBeenCalledTimes(1);
	});

	it("opens the Main model picker on Main but not for a selected subagent", async () => {
		await mountApp();
		await pressKey({ key: "m", code: "KeyM", altKey: true });
		expect(useUiStore.getState().modelPickerOpen).toBe(true);

		useUiStore.getState().closeModelPicker();
		await selectSubagent();
		await pressKey({ key: "m", code: "KeyM", altKey: true });
		expect(useUiStore.getState().modelPickerOpen).toBe(false);
	});

	it("dequeues into the hidden Main composer only while Main is selected", async () => {
		await mountApp();
		await pressKey({ key: "ArrowUp", code: "ArrowUp", altKey: true });
		await flush();
		expect(dequeue).toHaveBeenCalledTimes(1);
		expect(composerFills).toEqual([{ text: "restored Main queue item", images: undefined, prepend: true }]);

		await selectSubagent();
		await pressKey({ key: "ArrowUp", code: "ArrowUp", altKey: true });
		await flush();
		expect(dequeue).toHaveBeenCalledTimes(1);
		expect(composerFills).toHaveLength(1);
	});

	it("blocks native-menu Main mutation but keeps a window preference action available", async () => {
		await mountApp();
		await runMenuAction("cycle-thinking");
		expect(cycleThinkingLevel).toHaveBeenCalledTimes(1);

		await selectSubagent();
		await runMenuAction("cycle-thinking");
		expect(cycleThinkingLevel).toHaveBeenCalledTimes(1);

		await runMenuAction("toggle-language");
		await flush();
		expect(prefsSet).toHaveBeenCalledWith("language", "zh");
	});

	it("keeps view-only keyboard actions available for a selected subagent", async () => {
		await mountApp();
		await selectSubagent();

		await pressKey({ key: "o", code: "KeyO", ctrlKey: true });

		expect(useUiStore.getState().toolsExpandAll).toEqual({ expanded: true, seq: 1 });
	});
});
