import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { MenuAction, MenuActionPayload } from "../shared/ipc-types";
import { AppGlobalActions, AppWorkspace } from "./App";
import { I18nProvider } from "./lib/i18n";
import { resetTabRoute } from "./lib/tab-routing";
import { useActivitySidebarStore } from "./stores/activity-sidebar";
import { useAgentViewStore } from "./stores/agent-view";
import { useMessagesStore } from "./stores/messages";
import { useSessionStore } from "./stores/session";
import { useSubagentsStore } from "./stores/subagents";
import { useTabsStore } from "./stores/tabs";
import { useTodoStore } from "./stores/todo";
import { useUiStore } from "./stores/ui";
import { useUpdaterStore } from "./stores/updater";

const parsed = parseHTML("<html><body></body></html>");
const testWindow = parsed.window;
const testDocument = parsed.document;
const globals = globalThis as Record<string, unknown>;
const storage = new Map<string, string>();
class TestResizeObserver {
	disconnect(): void {}
	observe(_target: Element): void {}
	unobserve(_target: Element): void {}
}

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
	ResizeObserver: TestResizeObserver,
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
async function mountWorkspace(): Promise<void> {
	const rpc = {
		getAvailableCommands: vi.fn(async () => ok({ commands: [] })),
		getGitStatus: vi.fn(async () => ok()),
		getPlanMode: vi.fn(async () => ok({ enabled: false, planFilePath: null })),
		getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
		getSettings: vi.fn(async () => ok({ values: {} })),
	};
	(testWindow as unknown as Record<string, unknown>).omp = {
		events: {
			onCommandsUpdate: subscribe,
			onConfigUpdate: subscribe,
		},
		fs: {
			readPlan: vi.fn(async () => ({ ok: true, path: null, content: null })),
		},
		prefs: {
			get: vi.fn(async () => null),
			set: vi.fn(async () => ({})),
		},
		rpc,
	};
	useSessionStore.setState({ cwd: "/work/a", sessionId: "session-a", status: "ready" });
	useTabsStore.setState({
		tabs: [
			{
				id: "tab-a",
				cwd: "/work/a",
				status: "ready",
				kind: "agent",
				target: { type: "local" },
				unreadDone: false,
			},
		],
		activeTabId: "tab-a",
		bundles: new Map(),
	});
	useUiStore.setState({ sidecarError: "sidecar unavailable" });
	useUpdaterStore.setState({
		status: { state: "available", version: "9.9.9", mode: "automatic" },
		dismissedVersion: undefined,
	});

	container = testDocument.createElement("div") as unknown as Element;
	testDocument.body.appendChild(container as never);
	const mountedRoot = createRoot(container);
	root = mountedRoot;
	await act(async () => {
		mountedRoot.render(
			<I18nProvider>
				<AppWorkspace activeTabId="tab-a" />
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
		sidecarError: null,
		toolsExpandAll: { expanded: false, seq: 0 },
	});
}

beforeEach(() => {
	resetTabRoute();
	useAgentViewStore.getState().reset();
	resetUiState();
	composerFills = [];
	useActivitySidebarStore.getState().reset();
	useMessagesStore.getState().reset();
	useSessionStore.getState().reset();
	useSubagentsStore.getState().reset();
	useTabsStore.getState().reset();
	useTodoStore.getState().reset();
	useUpdaterStore.setState({ status: { state: "idle" }, dismissedVersion: undefined });
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
	useActivitySidebarStore.getState().reset();
	useMessagesStore.getState().reset();
	useSessionStore.getState().reset();
	useSubagentsStore.getState().reset();
	useTabsStore.getState().reset();
	useTodoStore.getState().reset();
	useUpdaterStore.setState({ status: { state: "idle" }, dismissedVersion: undefined });
	vi.restoreAllMocks();
});

describe("App workspace composition", () => {
	it("keeps banners, context, one canvas, composer, and footer in full-width DOM order", async () => {
		await mountWorkspace();

		const children = [...(container as Element).children] as HTMLElement[];
		expect(children).toHaveLength(6);
		expect(children[0]?.textContent).toContain("sidecar unavailable");
		expect(children[1]?.textContent).toContain("9.9.9");
		expect(children[2]?.getAttribute("data-agent-view")).toBe("main");
		expect(children[3]?.hasAttribute("data-workspace-canvas")).toBe(true);
		expect(children[4]?.querySelector("textarea")).not.toBeNull();
		expect(children[5]?.tagName).toBe("FOOTER");
		expect((container as Element).querySelectorAll("[data-chat-canvas]")).toHaveLength(1);
		expect((container as Element).querySelector('[data-testid="workspace-dock-scroll"]')).toBeNull();
	});

	it("hides Main session mutation badges while a subagent transcript is selected", async () => {
		useSessionStore.setState({
			planModeEnabled: true,
			goal: { objective: "Ship the activity dock" },
			goalState: { status: "active" },
			loopMode: { enabled: true, state: "waiting" },
			vibeModeEnabled: true,
			agentsPaused: true,
		});
		await selectSubagent();
		await mountWorkspace();

		const footerText = (container as Element).querySelector("footer")?.textContent ?? "";
		for (const label of ["Plan", "Goal", "Loop", "Vibe", "Paused"]) {
			expect(footerText).not.toContain(label);
		}
	});

	it("keeps the transcript and composer mounted when a complete activity section crashes", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		useTodoStore.setState({ phases: null as never });

		await mountWorkspace();

		expect((container as Element).querySelector("[data-chat-canvas]")).not.toBeNull();
		expect((container as Element).querySelector("textarea")).not.toBeNull();
		expect((container as Element).querySelector('[data-activity-section="agents"]')).not.toBeNull();
	});
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
