/**
 * TabBar render contract: one chip per session tab (title or cwd basename),
 * streaming dot while a tab runs, done badge on unreadDone, close × hidden at
 * the single-tab floor, "+" spawns a new tab in the current cwd. Same
 * linkedom + react-dom harness as the InputArea tests.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSpawnTabPayload, IpcTabInfo, IpcTabStatusPayload } from "../../../shared/ipc-types";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useComposerStore } from "../../stores/composer";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { useTabsStore } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";
import { useToolsStore } from "../../stores/tools";
import { TabBar } from "./TabBar";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	remove(): void;
	getAttribute(name: string): string | null;
	querySelector(selector: string): TestElement | null;
	querySelectorAll(selector: string): TestElement[];
	appendChild(child: TestElement): void;
}

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

interface MockOmp {
	tabs: {
		list: Mock<() => Promise<IpcTabInfo[]>>;
		spawn: Mock<(payload: IpcSpawnTabPayload) => Promise<{ tabId: string } | null>>;
		close: Mock<(tabId: string) => Promise<boolean>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
	};
	events: {
		onTabStatus: Mock<(callback: (payload: IpcTabStatusPayload) => void) => () => void>;
	};
	rpc: {
		getState: Mock<() => Promise<RpcResponse>>;
		getTranscript: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		getGoal: Mock<() => Promise<RpcResponse>>;
		getLoopMode: Mock<() => Promise<RpcResponse>>;
		getVibeMode: Mock<() => Promise<RpcResponse>>;
		getQueue: Mock<() => Promise<RpcResponse>>;
	};
}

function installMockOmp(): MockOmp {
	const omp: MockOmp = {
		tabs: {
			list: vi.fn(async () => []),
			spawn: vi.fn(async () => ({ tabId: "t9" })),
			close: vi.fn(async () => true),
			setActive: vi.fn(async () => true),
		},
		events: { onTabStatus: vi.fn(() => () => {}) },
		rpc: {
			getState: vi.fn(async () =>
				ok({
					sessionId: "srv",
					sessionName: null,
					sessionFile: null,
					cwd: "/srv",
					isStreaming: false,
					isCompacting: false,
					contextUsage: null,
					messageCount: 0,
					queuedMessageCount: 0,
					planModeEnabled: false,
					todoPhases: [],
				}),
			),
			getTranscript: vi.fn(async () => ok({ messages: [] })),
			getSubagents: vi.fn(async () => ok({ subagents: [] })),
			getGoal: vi.fn(async () => ok({ enabled: false })),
			getLoopMode: vi.fn(async () => ok({ enabled: false, state: "off" })),
			getVibeMode: vi.fn(async () => ok({ enabled: false })),
			getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
		},
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
}

let omp: MockOmp;
let container: TestElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

/** Drive an element's React onClick (linkedom has no synthetic event system). */
async function click(element: TestElement): Promise<void> {
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey
		? (record[propsKey] as
				| { onClick?: (event: { stopPropagation(): void; preventDefault(): void }) => void }
				| undefined)
		: undefined;
	if (!props?.onClick) throw new Error("element onClick not found");
	await act(async () => props.onClick?.({ stopPropagation: () => {}, preventDefault: () => {} }));
	await flush();
}

function chips(): TestElement[] {
	return container.querySelectorAll('[role="tab"]');
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useTabsStore.getState().reset();
	useComposerStore.getState().reset();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useTodoStore.getState().reset();
	useQueueStore.setState({ steering: [], followUp: [] });
	useSubagentsStore.getState().reset();
	useModelStore.getState().reset();
	useToolsStore.getState().reset();
	vi.restoreAllMocks();
	omp = installMockOmp();
});

omp = installMockOmp();

describe("TabBar", () => {
	it("renders one chip per tab with title or cwd basename and marks the active tab", async () => {
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/work/alpha", status: "ready", title: "Alpha plan", unreadDone: false },
				{ id: "t1", cwd: "/work/beta", status: "ready", unreadDone: false },
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		await mount(<TabBar />);

		const rendered = chips();
		expect(rendered).toHaveLength(2);
		expect(rendered[0]?.textContent).toContain("Alpha plan");
		// No title → cwd basename fallback.
		expect(rendered[1]?.textContent).toContain("beta");
		expect(rendered[1]?.getAttribute("aria-selected")).toBe("true");
		expect(rendered[0]?.getAttribute("aria-selected")).toBe("false");
	});

	it("hides the close button at the single-tab floor and shows it with two tabs", async () => {
		useTabsStore.setState({
			tabs: [{ id: "t0", cwd: "/alpha", status: "ready", unreadDone: false }],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);
		expect(container.querySelectorAll('[role="tab"] button')).toHaveLength(0);

		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
			],
		});
		await flush();
		expect(container.querySelectorAll('[role="tab"] button').length).toBeGreaterThan(0);
	});

	it("renders the running dot and the unreadDone badge", async () => {
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/alpha", status: "running", unreadDone: false },
				{ id: "t1", cwd: "/beta", status: "ready", unreadDone: true },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);

		const rendered = chips();
		expect(rendered[0]?.querySelector(".animate-pulse")).not.toBeNull();
		// The done badge carries the localized label as its aria-label.
		expect(rendered[1]?.querySelector('[aria-label="Run completed"]')).not.toBeNull();
		expect(rendered[0]?.querySelector('[aria-label="Run completed"]')).toBeNull();
	});

	it("clicking a chip switches tabs; the + button spawns a new tab in the current cwd", async () => {
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		// Hydrate on the switch pulls the target sidecar's state — its cwd is
		// what the + button reuses for the fresh tab.
		omp.rpc.getState.mockResolvedValue(
			ok({
				sessionId: "srv",
				sessionName: null,
				sessionFile: null,
				cwd: "/beta",
				isStreaming: false,
				isCompacting: false,
				contextUsage: null,
				messageCount: 0,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		await mount(<TabBar />);

		await click(chips()[1]!);
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");
		expect(useTabsStore.getState().activeTabId).toBe("t1");

		const plus = container.querySelector('[aria-label="New tab"]');
		expect(plus).not.toBeNull();
		await click(plus!);
		expect(omp.tabs.spawn).toHaveBeenCalledWith({ cwd: "/beta", sessionPath: undefined });
	});

	it("clicking a background chip's close releases it without switching", async () => {
		useTabsStore.setState({
			tabs: [
				{ id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);

		const close = chips()[1]?.querySelector("button");
		expect(close).not.toBeNull();
		await click(close!);

		expect(omp.tabs.close).toHaveBeenCalledWith("t1");
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0"]);
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(omp.tabs.setActive).not.toHaveBeenCalled();
	});
});
