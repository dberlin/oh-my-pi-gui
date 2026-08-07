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
import { useUiStore } from "../../stores/ui";
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
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
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
			setSubagentSubscription: vi.fn(async () => ok({})),
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
				{ kind: "agent", id: "t0", cwd: "/work/alpha", status: "ready", title: "Alpha plan", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/work/beta", status: "ready", unreadDone: false },
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
			tabs: [{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false }],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);
		expect(container.querySelectorAll('[role="tab"] button')).toHaveLength(0);

		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
			],
		});
		await flush();
		expect(container.querySelectorAll('[role="tab"] button').length).toBeGreaterThan(0);
	});

	it("renders the running dot and the unreadDone badge", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "running", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: true },
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
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
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

		const plus = container.querySelector('[aria-label="New Agent Tab"]');
		expect(plus).not.toBeNull();
		await click(plus!);
		// One click = agent tab directly (the dominant path).
		expect(omp.tabs.spawn).toHaveBeenCalledWith({ cwd: "/beta", sessionPath: undefined, kind: "agent" });
	});

	it("the chat button spawns a chat tab in one click — chat is a first-class, visible type", async () => {
		useTabsStore.setState({
			tabs: [{ kind: "agent", id: "t0", cwd: "/beta", status: "ready", unreadDone: false }],
			activeTabId: "t0",
			bundles: new Map(),
		});
		useSessionStore.setState({ cwd: "/beta" });
		await mount(<TabBar />);

		const chatButton = container.querySelector('[aria-label="New Chat Tab"]');
		expect(chatButton).not.toBeNull();
		await click(chatButton!);
		expect(omp.tabs.spawn).toHaveBeenCalledWith({ cwd: "/beta", sessionPath: undefined, kind: "chat" });
	});

	it("both creation buttons are visible with labeled affordances (no hidden menu)", async () => {
		useTabsStore.setState({
			tabs: [{ kind: "agent", id: "t0", cwd: "/beta", status: "ready", unreadDone: false }],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);

		// Discoverability contract: both types are one visible click away —
		// nothing behind right-click or a collapsed menu.
		expect(container.querySelector('[aria-label="New Agent Tab"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="New Chat Tab"]')).not.toBeNull();
		expect(container.querySelector('[role="menu"]')).toBeNull();
	});

	it("clicking a background chip's close releases it without switching", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
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

describe("TabBar close confirm", () => {
	const sleep = (ms: number) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	};

	function seedRunning(): void {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "running", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
	}

	it("closing a running tab arms an inline confirm; the ✓ executes the close", async () => {
		seedRunning();
		await mount(<TabBar />);

		await click(chips()[1]!.querySelector('[aria-label="Close tab"]')!);

		// Armed, not executed: the chip swaps its label for the warning + ✓/✕.
		expect(omp.tabs.close).not.toHaveBeenCalled();
		expect(chips()[1]?.textContent).toContain("Close tab? The running task will be aborted");
		expect(chips()[1]?.querySelector('[aria-label="Close tab"]')).toBeNull();

		await click(chips()[1]!.querySelector('[aria-label="Confirm"]')!);

		expect(omp.tabs.close).toHaveBeenCalledWith("t1");
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0"]);
	});

	it("the ✕ cancels the armed close and restores the chip", async () => {
		seedRunning();
		await mount(<TabBar />);

		await click(chips()[1]!.querySelector('[aria-label="Close tab"]')!);
		expect(chips()[1]?.textContent).toContain("Close tab? The running task will be aborted");

		await click(chips()[1]!.querySelector('[aria-label="Cancel"]')!);

		expect(omp.tabs.close).not.toHaveBeenCalled();
		expect(chips()[1]?.textContent).not.toContain("Close tab? The running task will be aborted");
		expect(chips()[1]?.querySelector('[aria-label="Close tab"]')).not.toBeNull();
	});

	it("the armed close auto-cancels after the timeout", async () => {
		// Real timers + a short injected window (bun-test compatible).
		seedRunning();
		await mount(<TabBar confirmCloseMs={25} />);

		await click(chips()[1]!.querySelector('[aria-label="Close tab"]')!);
		expect(chips()[1]?.textContent).toContain("Close tab? The running task will be aborted");

		await act(async () => {
			await sleep(60);
		});

		expect(omp.tabs.close).not.toHaveBeenCalled();
		expect(chips()[1]?.querySelector('[aria-label="Confirm"]')).toBeNull();
		expect(chips()[1]?.querySelector('[aria-label="Close tab"]')).not.toBeNull();
	});

	it("a starting tab arms, and so does the active tab's live stream", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "starting", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);

		// t1's sidecar is still booting — closing kills the launch, so it arms.
		await click(chips()[1]!.querySelector('[aria-label="Close tab"]')!);
		expect(omp.tabs.close).not.toHaveBeenCalled();
		expect(chips()[1]?.textContent).toContain("Close tab? The running task will be aborted");

		// The active tab's status push says ready, but the foreground stream is
		// live — foreground knowledge wins and the close arms.
		useSessionStore.setState({ isStreaming: true });
		await flush();
		await click(chips()[0]!.querySelector('[aria-label="Close tab"]')!);
		expect(omp.tabs.close).not.toHaveBeenCalled();
		expect(chips()[0]?.textContent).toContain("Close tab? The running task will be aborted");
	});

	it("closing an idle tab is immediate, active tab included", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);

		// The active-but-idle tab closes with no confirm interlude.
		await click(chips()[0]!.querySelector('[aria-label="Close tab"]')!);
		expect(omp.tabs.close).toHaveBeenCalledWith("t0");
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t1"]);
	});

	it("an idle worktree tab's × routes to the cleanup prompt, never straight to close (plan/20)", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{
					kind: "agent",
					id: "t1",
					cwd: "/wt/gui-fix-deadbeef",
					status: "ready",
					unreadDone: false,
					worktree: { name: "fix", branch: "omp/gui/fix", baseCwd: "/alpha" },
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);

		// The chip carries the worktree marker + branch tooltip…
		expect(chips()[1]?.getAttribute("title")).toBe("omp/gui/fix — /wt/gui-fix-deadbeef");
		expect(chips()[1]?.textContent).toContain("fix");

		// …and its × opens the cleanup prompt WITHOUT closing the tab.
		await click(chips()[1]!.querySelector('[aria-label="Close tab"]')!);
		expect(omp.tabs.close).not.toHaveBeenCalled();
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1"]);
		expect(useUiStore.getState().worktreeClosePrompt).toEqual({ tabId: "t1" });
	});
});

describe("TabBar chip labels (F-HYDRATE)", () => {
	it("disambiguates identical untitled labels with an index suffix in tab order", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/work/gui", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/other/gui", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t2", cwd: "/tmp/gui", status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);

		const rendered = chips();
		expect(rendered).toHaveLength(3);
		// First occurrence stays bare; later collisions number from #2.
		expect(rendered.map(chip => chip.textContent)).toEqual(["gui", "gui #2", "gui #3"]);
	});

	it("prefers the session title and never suffixes titled tabs", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/work/gui", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/other/gui", status: "ready", title: "Release plan", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);

		// The titled tab left the collision set, so the untitled chip stays bare.
		expect(chips().map(chip => chip.textContent)).toEqual(["gui", "Release plan"]);
	});

	it("drops the suffix once a colliding tab gains a title", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/work/gui", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/other/gui", status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount(<TabBar />);
		expect(chips().map(chip => chip.textContent)).toEqual(["gui", "gui #2"]);

		// The auto-title arrives via TAB_STATUS: labels recompute immediately.
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/other/gui", status: "ready", title: "Fix races" });
		await flush();
		expect(chips().map(chip => chip.textContent)).toEqual(["gui", "Fix races"]);
	});
});
