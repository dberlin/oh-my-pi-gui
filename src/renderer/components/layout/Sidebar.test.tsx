/**
 * Sidebar integration contracts: the "+" type dropdown, workspace group
 * context menu (6 items), session row context menu (6 items), pinned-first
 * ordering for groups and sessions, and the rename item's attached-only gate.
 * Same linkedom + react-dom harness as TabBar.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SessionInfo } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { Sidebar } from "./Sidebar";

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
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

interface MockOmp {
	sessions: {
		list: Mock<(scope: string) => Promise<SessionInfo[]>>;
		delete: Mock<(path: string) => Promise<void>>;
		search: Mock<(query: string, scope: string) => Promise<string[]>>;
		openInNewWindow: Mock<(payload: { sessionPath?: string }) => Promise<boolean>>;
	};
	events: {
		onSessionsChanged: Mock<() => () => void>;
		onTabStatus: Mock<() => () => void>;
		onMenuAction: Mock<() => () => void>;
	};
	tabs: {
		list: Mock<() => Promise<unknown[]>>;
		spawn: Mock<(payload: unknown) => Promise<{ tabId: string } | null>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
		close: Mock<(tabId: string) => Promise<boolean>>;
		getSessionOwner: Mock<(path: string) => Promise<null>>;
	};
	prefs: {
		get: Mock<(key: string) => Promise<unknown>>;
		set: Mock<(key: string, value: unknown) => Promise<void>>;
	};
	rpc: Record<string, Mock<(...args: unknown[]) => Promise<unknown>>>;
}

function installMockOmp(sessionList: SessionInfo[]): MockOmp {
	const omp: MockOmp = {
		sessions: {
			list: vi.fn(async () => sessionList),
			delete: vi.fn(async () => {}),
			search: vi.fn(async () => []),
			openInNewWindow: vi.fn(async () => true),
		},
		events: {
			onSessionsChanged: vi.fn(() => () => {}),
			onTabStatus: vi.fn(() => () => {}),
			onMenuAction: vi.fn(() => () => {}),
		},
		tabs: {
			list: vi.fn(async () => []),
			spawn: vi.fn(async () => ({ tabId: "t-new" })),
			setActive: vi.fn(async () => true),
			close: vi.fn(async () => true),
			getSessionOwner: vi.fn(async () => null),
		},
		prefs: {
			get: vi.fn(async () => null),
			set: vi.fn(async () => {}),
		},
		rpc: new Proxy({} as MockOmp["rpc"], {
			get: (target, prop) => {
				if (!(prop in target)) {
					(target as Record<string | symbol, unknown>)[prop] = vi.fn(async () => ({
						type: "response",
						command: "mock",
						success: true,
						data: {},
					}));
				}
				return (target as Record<string | symbol, unknown>)[prop];
			},
		}),
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
}

function session(path: string, cwd: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path,
		id: path,
		title: `Session ${path}`,
		cwd,
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
		messageCount: 3,
		size: 100,
		status: "complete",
		firstMessage: "hello",
		...overrides,
	};
}

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

/** Drive a React onClick/onContextMenu prop on an element. */
async function fire(element: Element | TestElement | null, prop: "onClick" | "onContextMenu"): Promise<void> {
	if (!element) throw new Error("fire: element is null");
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as Record<string, (event: unknown) => void> | undefined) : undefined;
	const handler = props?.[prop];
	if (!handler) throw new Error(`fire: ${prop} not found on element`);
	await act(async () =>
		handler({
			stopPropagation: () => {},
			preventDefault: () => {},
			clientX: 20,
			clientY: 30,
			currentTarget: element,
		}),
	);
	await flush();
}

function menuItemLabels(): string[] {
	return [...document.body.querySelectorAll('[role="menu"] button')].map(b => (b.textContent ?? "").trim());
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useSidebarPrefs.getState().reset();
	useUiStore.setState({ panelVisible: false });
});

const LIST = [
	session("/work/alpha/one.jsonl", "/work/alpha", { modified: "2026-01-02T00:00:00Z" }),
	session("/work/alpha/two.jsonl", "/work/alpha", { modified: "2026-01-01T00:00:00Z" }),
	session("/work/beta/three.jsonl", "/work/beta", { modified: "2026-01-03T00:00:00Z" }),
];

function seedStores(): void {
	useSessionStore.setState({ sessionId: "attached-id", cwd: "/work/alpha", isStreaming: false });
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work/alpha", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

describe("Sidebar menus and pinned ordering", () => {
	it("+ button opens the type dropdown with agent and chat entries", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const plus = container.querySelector('[aria-label="New session"], [aria-label="新建会话"]');
		expect(plus).not.toBeNull();
		await fire(plus, "onClick");

		const labels = menuItemLabels();
		expect(labels.some(label => label.includes("New agent session"))).toBe(true);
		expect(labels.some(label => label.includes("New chat session"))).toBe(true);
		expect(labels).toHaveLength(2);
	});

	it("right-click on a workspace header opens the 6-item group menu", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const header = container.querySelector('[data-workspace-group="/work/alpha"]');
		expect(header).not.toBeUndefined();
		await fire(header as unknown as TestElement, "onContextMenu");

		const labels = menuItemLabels();
		expect(labels.some(label => label.includes("New agent session here"))).toBe(true);
		expect(labels.some(label => label.includes("New chat session here"))).toBe(true);
		expect(labels.some(label => label.includes("New worktree tab here"))).toBe(true);
		expect(labels.some(label => label.includes("Rename"))).toBe(true);
		expect(labels.some(label => label.includes("Pin to top"))).toBe(true);
		expect(labels.some(label => label.includes("Delete"))).toBe(true);
		expect(labels).toHaveLength(6);
	});

	it("right-click on a session row opens the 6-item session menu", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		);
		expect(row).not.toBeUndefined();
		await fire(row as Element, "onContextMenu");

		const labels = menuItemLabels();
		for (const expected of ["Open", "Open in new tab", "Open in new window", "Rename", "Pin to top", "Delete"]) {
			expect(
				labels.some(label => label.includes(expected)),
				`missing item: ${expected}`,
			).toBe(true);
		}
		expect(labels).toHaveLength(6);
	});

	it("rename is enabled only for the attached session", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id" });
		installMockOmp([attached, ...LIST]);
		seedStores();
		await mount(<Sidebar />);

		// Attached session → rename enabled.
		const attachedRow = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/mine"),
		);
		await fire(attachedRow as Element, "onContextMenu");
		const renameItem = [...document.body.querySelectorAll('[role="menu"] button')].find(b =>
			(b.textContent ?? "").includes("Rename"),
		);
		expect((renameItem as HTMLButtonElement | undefined)?.disabled).toBe(false);
		await fire(document.body.querySelector('[role="menu"] button') as Element, "onClick");

		// Foreign session → rename disabled with a reason.
		const foreignRow = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		);
		await fire(foreignRow as Element, "onContextMenu");
		const disabledRename = [...document.body.querySelectorAll('[role="menu"] button')].find(b =>
			(b.textContent ?? "").includes("Rename"),
		);
		expect((disabledRename as HTMLButtonElement | undefined)?.disabled).toBe(true);
	});

	it("collapsed groups stay mounted for animation but become inert and hidden from accessibility", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const alphaHeader = [...container.querySelectorAll("button")].find(button =>
			(button.textContent ?? "").includes("alpha"),
		);
		const alphaContent = container.querySelector('[data-session-group="/work/alpha"]') as unknown as Element;
		const betaContent = container.querySelector('[data-session-group="/work/beta"]') as unknown as Element;

		expect(alphaContent.getAttribute("data-state")).toBe("expanded");
		expect(alphaContent.getAttribute("aria-hidden")).toBe("false");
		expect(alphaContent.hasAttribute("inert")).toBe(false);
		expect(betaContent.getAttribute("data-state")).toBe("collapsed");
		expect(betaContent.getAttribute("aria-hidden")).toBe("true");
		expect(betaContent.hasAttribute("inert")).toBe(true);

		await fire(alphaHeader as unknown as TestElement, "onClick");
		expect(alphaContent.getAttribute("data-state")).toBe("collapsed");
		expect(alphaContent.getAttribute("aria-hidden")).toBe("true");
		expect(alphaContent.hasAttribute("inert")).toBe(true);

		await fire(alphaHeader as unknown as TestElement, "onClick");
		expect(alphaContent.getAttribute("data-state")).toBe("expanded");
		expect(alphaContent.getAttribute("aria-hidden")).toBe("false");
		expect(alphaContent.hasAttribute("inert")).toBe(false);
	});

	it("pinned groups sort before unpinned; pinned sessions sort first inside their group", async () => {
		installMockOmp(LIST);
		seedStores();
		useSidebarPrefs.setState({
			pinnedGroups: ["/work/alpha"],
			pinnedSessions: ["/work/alpha/two.jsonl"],
			hydrated: true,
		});
		await mount(<Sidebar />);

		const headers = [...container.querySelectorAll("button")]
			.filter(b => (b.textContent ?? "").match(/alpha|beta/i))
			.map(b => (b.textContent ?? "").trim());
		expect(headers[0]).toContain("alpha");

		const rows = [...document.querySelectorAll('div[role="button"]')].map(el => (el.textContent ?? "").trim());
		const oneIndex = rows.findIndex(text => text.includes("Session /work/alpha/one"));
		const twoIndex = rows.findIndex(text => text.includes("Session /work/alpha/two"));
		expect(twoIndex).toBeGreaterThanOrEqual(0);
		expect(oneIndex).toBeGreaterThanOrEqual(0);
		expect(twoIndex).toBeLessThan(oneIndex);
	});
});
