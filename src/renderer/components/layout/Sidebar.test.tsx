/**
 * Sidebar integration contracts: the "+" type dropdown, workspace group
 * context menu (5 items), global Chat/workspace separation, session row
 * context menu (6 items), pinned-first ordering, per-task busy gates, and
 * tab-first opening.
 * Same linkedom + react-dom harness as TabBar.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	RemoteCatalogResult,
	RemoteDirectoryListResult,
	RemoteDirectoryValidationResult,
	RemoteHistoryResult,
	RemoteHistorySession,
	RemoteHostCatalogEntry,
	RemoteHostCatalogSnapshot,
	RemotePreflightResult,
	SessionInfo,
	SshSessionTarget,
} from "../../../shared/ipc-types";
import { useSidebarRecency } from "../../hooks/use-sidebar-recency";
import { I18nProvider } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
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
(HTMLElement.prototype as unknown as { select: () => void }).select = () => {};

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
		rename: Mock<(path: string, name: string) => Promise<void>>;
		search: Mock<(query: string, scope: string) => Promise<string[]>>;
		openInNewWindow: Mock<(payload: { sessionPath?: string }) => Promise<boolean>>;
	};
	remote: {
		catalog: Mock<() => Promise<RemoteCatalogResult>>;
		cancel: Mock<(requestId: string) => Promise<boolean>>;
		listDirectories: Mock<
			(
				target: SshSessionTarget,
				path: string,
				showHidden: boolean,
				tabId?: string,
				requestId?: string,
			) => Promise<RemoteDirectoryListResult>
		>;
		listHistory: Mock<(hostAlias: string) => Promise<RemoteHistoryResult>>;
		noteWorkspace: Mock<(hostAlias: string, cwd: string) => Promise<RemoteCatalogResult>>;
		preflight: Mock<(target: SshSessionTarget, tabId?: string, requestId?: string) => Promise<RemotePreflightResult>>;
		validateDirectory: Mock<
			(
				target: SshSessionTarget,
				path: string,
				tabId?: string,
				requestId?: string,
			) => Promise<RemoteDirectoryValidationResult>
		>;
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
			rename: vi.fn(async () => {}),
			search: vi.fn(async () => []),
			openInNewWindow: vi.fn(async () => true),
		},
		remote: {
			catalog: vi.fn(async () => ({ ok: true, catalog: { hosts: [], updatedAt: null } })),
			cancel: vi.fn(async () => true),
			listDirectories: vi.fn(async (_target, path) => ({ ok: true, path, parent: "/", entries: [] })),
			listHistory: vi.fn(async () => ({ ok: true, sessions: [] })),
			noteWorkspace: vi.fn(async () => ({ ok: true, catalog: { hosts: [], updatedAt: null } })),
			preflight: vi.fn(async target => ({
				ok: true,
				target,
				home: "/home/danny",
				platform: "linux",
				executable: "/usr/bin/omp",
			})),
			validateDirectory: vi.fn(async (_target, path) => ({ ok: true, path })),
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

function remoteHost(alias: string): RemoteHostCatalogEntry {
	return {
		alias,
		host: {
			host: `${alias}.example.com`,
			sourceId: `source-${alias}`,
			sourceLevel: "user",
		},
		recentWorkspaces: [],
	};
}

function remoteCatalog(...aliases: string[]): RemoteHostCatalogSnapshot {
	return { hosts: aliases.map(remoteHost), updatedAt: "2026-08-12T12:00:00.000Z" };
}

function remoteTarget(alias: string, cwd: string): SshSessionTarget {
	return {
		type: "ssh",
		hostAlias: alias,
		host: remoteHost(alias).host,
		originCwd: cwd,
		cwd,
	};
}

function remoteSession(
	alias: string,
	sessionId: string,
	cwd: string,
	title: string | null,
	meta?: Record<string, unknown>,
): RemoteHistorySession {
	return {
		target: remoteTarget(alias, cwd),
		sessionId,
		cwd,
		title,
		updatedAt: "2026-08-12T11:00:00.000Z",
		...(meta === undefined ? {} : { meta }),
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

async function change(element: Element | TestElement | null, value: string): Promise<void> {
	if (!element) throw new Error("change: element is null");
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: unknown) => void } | undefined) : undefined;
	if (!props?.onChange) throw new Error("change: onChange not found on element");
	await act(async () => {
		props.onChange?.({ target: { value } });
	});
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
	useRemoteStore.getState().reset();
	vi.restoreAllMocks();
});

const LIST = [
	session("/work/alpha/one.jsonl", "/work/alpha", { modified: "2026-01-02T00:00:00Z" }),
	session("/work/alpha/two.jsonl", "/work/alpha", { modified: "2026-01-01T00:00:00Z" }),
	session("/work/beta/three.jsonl", "/work/beta", { modified: "2026-01-03T00:00:00Z" }),
];

function seedStores(): void {
	useSessionStore.setState({ sessionId: "attached-id", cwd: "/work/alpha", isStreaming: false });
	useTabsStore.setState({
		tabs: [
			{
				id: "t0",
				cwd: "/work/alpha",
				target: { type: "local" },
				status: "ready",
				kind: "agent",
				unreadDone: false,
			},
		],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

function SidebarWithRecency() {
	useSidebarRecency();
	return <Sidebar />;
}

describe("Sidebar menus and pinned ordering", () => {
	it("moves the most recently used session and its workspace to the front immediately", async () => {
		const omp = installMockOmp(LIST);
		useSessionStore.setState({ sessionId: "", cwd: "/neutral", isStreaming: false });
		useTabsStore.setState({
			tabs: [
				{
					id: "chat",
					cwd: "/neutral",
					target: { type: "local" },
					status: "ready",
					kind: "chat",
					unreadDone: false,
				},
			],
			activeTabId: "chat",
			bundles: new Map(),
		});
		useSidebarPrefs.setState({ hydrated: true });
		await mount(<SidebarWithRecency />);
		// Non-active workspaces start collapsed and render no rows; expand alpha
		// so its session order is inspectable.
		const alphaToggle = [...container.querySelectorAll("button")].find(button =>
			(button.textContent ?? "").includes("alpha"),
		);
		await fire(alphaToggle as unknown as TestElement, "onClick");

		const workspaceOrder = () =>
			[...container.querySelectorAll("[data-workspace-group]")].map(element =>
				(element as unknown as Element).getAttribute("data-workspace-group"),
			);
		const alphaSessionOrder = () =>
			[...container.querySelectorAll('[data-session-group="/work/alpha"] .omp-sidebar-session-row')].map(
				element => element.textContent ?? "",
			);

		expect(workspaceOrder()).toEqual(["/work/beta", "/work/alpha"]);
		expect(alphaSessionOrder()[0]).toContain("Session /work/alpha/one");

		await act(async () => {
			useTabsStore.setState({
				tabs: [
					{
						id: "agent",
						cwd: "/work/alpha",
						target: { type: "local" },
						status: "ready",
						kind: "agent",
						unreadDone: false,
					},
				],
				activeTabId: "agent",
			});
			useSessionStore.setState({
				sessionId: "/work/alpha/two.jsonl",
				sessionFile: "/work/alpha/two.jsonl",
				cwd: "/work/alpha",
			});
		});
		await flush();

		expect(workspaceOrder()).toEqual(["/work/alpha", "/work/beta"]);
		expect(alphaSessionOrder()[0]).toContain("Session /work/alpha/two");
		expect(useSidebarPrefs.getState().sessionLastUsed["/work/alpha/two.jsonl"]).toBeGreaterThan(0);
		expect(useSidebarPrefs.getState().workspaceLastUsed["/work/alpha"]).toBeGreaterThan(0);
		expect(omp.prefs.set).toHaveBeenCalledWith(
			"sidebar",
			expect.objectContaining({
				sessionLastUsed: expect.objectContaining({ "/work/alpha/two.jsonl": expect.any(Number) }),
			}),
		);
	});

	it("+ button offers explicit local, remote, and chat creation paths", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const plus = container.querySelector('[aria-label="New session"], [aria-label="新建会话"]');
		expect(plus).not.toBeNull();
		// Dispatch a real bubbling click instead of calling React's onClick prop
		// directly. The real event must finish bubbling without the newly-mounted
		// menu mistaking its own trigger click for an outside dismissal.
		await act(async () => {
			(plus as unknown as Element).dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();

		const labels = menuItemLabels();
		expect(labels.some(label => label.includes("New local session"))).toBe(true);
		expect(labels.some(label => label.includes("New remote session"))).toBe(true);
		expect(labels.some(label => label.includes("New chat session"))).toBe(true);
		expect(labels).toHaveLength(3);
	});

	it("global remote creation opens a host-only chooser", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		omp.remote.catalog.mockResolvedValue({ ok: true, catalog: remoteCatalog("build") });
		useRemoteStore.getState().setCatalog(remoteCatalog("build"));
		await mount(<Sidebar />);

		const plus = container.querySelector('[aria-label="New session"], [aria-label="新建会话"]');
		await act(async () => {
			(plus as unknown as Element).dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();
		const remote = [...document.body.querySelectorAll('[role="menu"] button')].find(button =>
			(button.textContent ?? "").includes("New remote session"),
		);
		expect(remote).not.toBeUndefined();
		await fire(remote as unknown as TestElement, "onClick");

		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("Remote hosts");
		expect(dialog?.textContent).toContain("build");
		expect(dialog?.textContent).not.toContain("/work/alpha");
	});

	it("uses visible vertical signal lights for session state", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const rows = container.querySelectorAll(".omp-sidebar-session-row");
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.every(row => row.querySelector(".omp-signal-light") !== null)).toBe(true);
		expect(rows.every(row => row.querySelector(".omp-signal-light--active") === null)).toBe(true);
		expect(rows[0]?.querySelector('[aria-label="Completed"]')).not.toBeNull();
	});

	it("right-click on a workspace header opens the agent-only 5-item group menu", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const header = container.querySelector('[data-workspace-group="/work/alpha"]');
		expect(header).not.toBeUndefined();
		await fire(header as unknown as TestElement, "onContextMenu");

		const labels = menuItemLabels();
		expect(labels.some(label => label.includes("New agent session here"))).toBe(true);
		expect(labels.some(label => label.includes("New chat session here"))).toBe(false);
		expect(labels.some(label => label.includes("New worktree tab here"))).toBe(true);
		expect(labels.some(label => label.includes("Rename"))).toBe(true);
		expect(labels.some(label => label.includes("Pin to top"))).toBe(true);
		expect(labels.some(label => label.includes("Delete"))).toBe(true);
		expect(labels).toHaveLength(5);
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

	it("rename and delete stay enabled for idle tasks while another task runs", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id" });
		const omp = installMockOmp([attached, ...LIST]);
		seedStores();
		useSessionStore.setState({ isStreaming: true });
		await mount(<Sidebar />);

		// The attached running task stays protected.
		const attachedRow = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/mine"),
		);
		await fire(attachedRow as Element, "onContextMenu");
		const renameItem = [...document.body.querySelectorAll('[role="menu"] button')].find(b =>
			(b.textContent ?? "").includes("Rename"),
		);
		expect((renameItem as HTMLButtonElement | undefined)?.disabled).toBe(true);
		await fire(document.body.querySelector('[role="menu"] button') as Element, "onClick");

		// An idle sibling remains editable and deletable despite the active run.
		const foreignRow = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		);
		await fire(foreignRow as Element, "onContextMenu");
		const foreignMenu = [...document.body.querySelectorAll('[role="menu"] button')];
		const idleRename = foreignMenu.find(b => (b.textContent ?? "").includes("Rename"));
		const idleDelete = foreignMenu.find(b => (b.textContent ?? "").includes("Delete"));
		expect((idleRename as HTMLButtonElement | undefined)?.disabled).toBe(false);
		expect((idleDelete as HTMLButtonElement | undefined)?.disabled).toBe(false);
		await fire(idleRename as Element, "onClick");
		const input = container.querySelector(
			'input[value="Session /work/alpha/one.jsonl"]',
		) as unknown as HTMLInputElement;
		expect(input).not.toBeNull();
		const inputRecord = input as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(inputRecord).find(key => key.startsWith("__reactProps$"));
		const inputProps = propsKey
			? (inputRecord[propsKey] as {
					onChange: (event: { target: { value: string } }) => void;
					onBlur: (event: { currentTarget: { value: string } }) => void;
				})
			: undefined;
		if (!inputProps) throw new Error("rename input React props missing");
		await act(async () => {
			inputProps.onChange({ target: { value: "Renamed idle task" } });
		});
		await act(async () => {
			inputProps.onBlur({ currentTarget: { value: "Renamed idle task" } });
		});
		await flush();
		expect(omp.sessions.rename).toHaveBeenCalledWith("/work/alpha/one.jsonl", "Renamed idle task");
	});

	it("clicking an idle task opens it in a new tab by default", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		useSessionStore.setState({ isStreaming: true });
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		);
		await fire(row as unknown as Element, "onClick");

		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/work/alpha",
			kind: "agent",
			sessionPath: "/work/alpha/one.jsonl",
			worktree: undefined,
		});
		expect(omp.sessions.openInNewWindow).not.toHaveBeenCalled();
	});

	it("renders chats globally outside workspaces and opens them in chat tabs", async () => {
		const chat = session("/work/alpha/chat.jsonl", "/work/alpha", { kind: "chat" });
		const agent = session("/work/alpha/agent.jsonl", "/work/alpha");
		const omp = installMockOmp([chat, agent]);
		seedStores();
		await mount(<Sidebar />);

		const chatSection = container.querySelector("[data-chat-section]");
		const workspace = container.querySelector('[data-session-group="/work/alpha"]');
		expect(chatSection?.textContent).toContain("Session /work/alpha/chat");
		expect(chatSection?.textContent).not.toContain("Session /work/alpha/agent");
		expect(workspace?.textContent).toContain("Session /work/alpha/agent");
		expect(workspace?.textContent).not.toContain("Session /work/alpha/chat");

		const row = [...chatSection!.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/chat"),
		);
		await fire(row as unknown as Element, "onClick");

		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/work/alpha",
			kind: "chat",
			sessionPath: "/work/alpha/chat.jsonl",
			worktree: undefined,
		});
	});

	it("keeps the active task protected while it is compacting", async () => {
		const attached = session("/work/alpha/mine.jsonl", "/work/alpha", { id: "attached-id" });
		installMockOmp([attached]);
		seedStores();
		useSessionStore.setState({ isCompacting: true });
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll('div[role="button"]')].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/mine"),
		);
		await fire(row as Element, "onContextMenu");
		const items = [...document.body.querySelectorAll('[role="menu"] button')];
		expect((items.find(item => (item.textContent ?? "").includes("Rename")) as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((items.find(item => (item.textContent ?? "").includes("Delete")) as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	it("workspace rows expose a hover action that creates an agent tab in that workspace", async () => {
		const omp = installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const header = container.querySelector('[data-workspace-group="/work/alpha"]') as unknown as Element;
		const add = header.querySelector('[aria-label="New agent session here"]');
		expect(add).not.toBeNull();
		await fire(add, "onClick");
		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/work/alpha",
			kind: "agent",
			sessionPath: undefined,
			worktree: undefined,
		});
	});

	it("renders collapsed groups as absent from the DOM instead of inert subtrees", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const alphaHeader = [...container.querySelectorAll("button")].find(button =>
			(button.textContent ?? "").includes("alpha"),
		);
		// Active workspace expanded; other groups render nothing at all — a
		// long-lived install must not build hundreds of hidden rows per refresh.
		const alphaContent = () =>
			container.querySelector('[data-session-group="/work/alpha"]') as unknown as Element | null;
		expect(alphaContent()?.getAttribute("data-state")).toBe("expanded");
		expect(container.querySelector('[data-session-group="/work/beta"]')).toBeNull();

		await fire(alphaHeader as unknown as TestElement, "onClick");
		expect(alphaContent()).toBeNull();

		await fire(alphaHeader as unknown as TestElement, "onClick");
		expect(alphaContent()?.getAttribute("data-state")).toBe("expanded");
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

	it("session titles truncate in place and hover actions do not claim row width", async () => {
		installMockOmp(LIST);
		seedStores();
		await mount(<Sidebar />);

		const row = [...document.querySelectorAll(".omp-sidebar-session-row")].find(el =>
			(el.textContent ?? "").includes("Session /work/alpha/one"),
		);
		expect(row).toBeDefined();
		const title = row?.querySelector(".omp-sidebar-title");
		const actions = row?.querySelector(".omp-sidebar-session-actions");
		expect(title).not.toBeNull();
		expect(title?.className).toContain("truncate");
		expect(actions).not.toBeNull();
		expect(actions?.className).not.toMatch(/\bw-\d|\bwidth/);
		expect(row?.querySelector("[data-overflow]")).toBeNull();
	});
});

describe("Sidebar remote history", () => {
	it("loads one host lazily and refreshes only that host", async () => {
		const omp = installMockOmp([]);
		useRemoteStore.getState().setCatalog(remoteCatalog("build", "prod"));
		omp.remote.listHistory.mockImplementation(async alias => ({
			ok: true,
			sessions: [remoteSession(alias, `${alias}-1`, alias === "build" ? "/srv/app" : "/opt/prod", null)],
		}));

		await mount(<Sidebar />);
		expect(omp.remote.listHistory).not.toHaveBeenCalled();

		await fire(container.querySelector('[data-remote-host="build"] [data-remote-host-toggle]'), "onClick");
		expect(omp.remote.listHistory).toHaveBeenCalledTimes(1);
		expect(omp.remote.listHistory).toHaveBeenLastCalledWith("build");
		expect(container.querySelector('[data-remote-session="build-1"]')).not.toBeNull();
		expect(useRemoteStore.getState().hosts.prod?.historyStatus).toBe("idle");

		await fire(
			container.querySelector('[data-remote-host="build"] [aria-label="Refresh remote history"]'),
			"onClick",
		);
		expect(omp.remote.listHistory).toHaveBeenCalledTimes(2);
		expect(omp.remote.listHistory).toHaveBeenLastCalledWith("build");
		expect(useRemoteStore.getState().hosts.prod?.historyStatus).toBe("idle");
	});

	it("remote host headers open a scoped directory picker at the most recent workspace", async () => {
		const omp = installMockOmp([]);
		const host = remoteHost("build");
		host.recentWorkspaces = ["/srv/recent"];
		useRemoteStore.getState().setCatalog({ hosts: [host], updatedAt: "2026-08-12T12:00:00.000Z" });

		await mount(<Sidebar />);
		const add = container.querySelector('[data-remote-host="build"] [data-remote-host-add]');
		expect(add).not.toBeNull();
		await fire(add, "onClick");

		expect(document.body.textContent).toContain("Choose remote workspace");
		expect(omp.remote.preflight).toHaveBeenCalledWith(
			expect.objectContaining({ hostAlias: "build", cwd: "/srv/recent" }),
			undefined,
			expect.any(String),
		);
		const confirm = [...document.body.querySelectorAll("button")].find(button =>
			(button.textContent ?? "").includes("Open workspace"),
		);
		await fire(confirm as unknown as TestElement, "onClick");
		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/srv/recent",
			kind: "agent",
			sessionPath: undefined,
			target: remoteTarget("build", "/srv/recent"),
		});
		expect(omp.remote.noteWorkspace).toHaveBeenCalledWith("build", "/srv/recent");
	});

	it("filters loaded alias, cwd, and title metadata without searching journals", async () => {
		const omp = installMockOmp([]);
		useRemoteStore.getState().setCatalog(remoteCatalog("build"));
		omp.remote.listHistory.mockResolvedValue({
			ok: true,
			sessions: [
				remoteSession("build", "release", "/srv/app", "Release\ntrain", { journal: "private needle" }),
				remoteSession("build", "database", "/opt/database", null),
			],
		});
		await useRemoteStore.getState().refreshHistory("build");
		omp.remote.listHistory.mockClear();

		await mount(<Sidebar />);
		const search = container.querySelector('input[placeholder="Search sessions…"]');

		await change(search, "private needle");
		expect(container.querySelector('[data-remote-session="release"]')).toBeNull();
		expect(container.querySelector('[data-remote-session="database"]')).toBeNull();

		await change(search, "release train");
		expect(container.querySelector('[data-remote-session="release"]')?.textContent).toContain("Release train");
		expect(container.querySelector('[data-remote-session="database"]')).toBeNull();

		await change(search, "/opt/database");
		expect(container.querySelector('[data-remote-session="database"]')).not.toBeNull();

		await change(search, "build");
		expect(container.querySelectorAll("[data-remote-session]")).toHaveLength(2);
		expect(omp.sessions.search).not.toHaveBeenCalled();
		expect(omp.remote.listHistory).not.toHaveBeenCalled();
	});

	it("resumes and starts another session with only target-aware remote payloads", async () => {
		const omp = installMockOmp([]);
		const target = remoteTarget("build", "/srv/app");
		useRemoteStore.getState().setCatalog(remoteCatalog("build"));
		omp.remote.listHistory.mockResolvedValue({
			ok: true,
			sessions: [{ ...remoteSession("build", "s-1", "/srv/app", "Deploy"), target }],
		});
		await useRemoteStore.getState().refreshHistory("build");
		const openTab = vi.spyOn(useTabsStore.getState(), "openTab").mockResolvedValue("remote-tab");

		await mount(<Sidebar />);
		await fire(container.querySelector('[data-remote-host="build"] [data-remote-host-toggle]'), "onClick");
		const row = container.querySelector('[data-remote-session="s-1"]');
		await fire(row, "onClick");
		expect(openTab).toHaveBeenLastCalledWith({ target, cwd: "/srv/app", resumeSessionId: "s-1" });

		openTab.mockClear();
		await fire(row, "onContextMenu");
		const buttons = [...document.body.querySelectorAll('[role="menu"] button')];
		const startAnother = buttons.find(button => (button.textContent ?? "").includes("Start another session"));
		await fire(startAnother as unknown as TestElement, "onClick");
		expect(openTab).toHaveBeenCalledWith({ target, cwd: "/srv/app" });
		expect(openTab).toHaveBeenCalledTimes(1);
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		expect(omp.sessions.rename).not.toHaveBeenCalled();
		expect(omp.sessions.search).not.toHaveBeenCalled();
	});

	it("shows localized disabled explanations for unsupported remote actions", async () => {
		const omp = installMockOmp([]);
		useRemoteStore.getState().setCatalog(remoteCatalog("legacy"));
		omp.remote.listHistory.mockResolvedValue({
			ok: true,
			sessions: [remoteSession("legacy", "old-1", "/srv/legacy", "Legacy deploy")],
		});
		await useRemoteStore.getState().refreshHistory("legacy");

		await mount(<Sidebar />);
		await fire(container.querySelector('[data-remote-host="legacy"] [data-remote-host-toggle]'), "onClick");
		await fire(container.querySelector('[data-remote-session="old-1"]'), "onContextMenu");

		const buttons = [...document.body.querySelectorAll('[role="menu"] button')];
		const unsupported = buttons.filter(button =>
			["Rename closed remote session", "Delete remote session", "Search remote transcript"].some(label =>
				(button.textContent ?? "").includes(label),
			),
		);
		expect(unsupported).toHaveLength(3);
		expect(unsupported.every(button => button.hasAttribute("disabled"))).toBe(true);
		expect(unsupported.map(button => button.getAttribute("title"))).toEqual([
			"Closed remote sessions cannot be renamed because the remote ACP server does not expose that operation.",
			"Remote sessions cannot be deleted because the remote ACP server does not expose that operation.",
			"Remote transcript search is unavailable because only session metadata is loaded.",
		]);
		expect(omp.sessions.delete).not.toHaveBeenCalled();
		expect(omp.sessions.rename).not.toHaveBeenCalled();
		expect(omp.sessions.search).not.toHaveBeenCalled();
	});

	it("renders unsupported history and retries a failed host without touching peers", async () => {
		const omp = installMockOmp([]);
		useRemoteStore.getState().setCatalog(remoteCatalog("legacy", "build", "prod"));
		omp.remote.listHistory.mockImplementation(async alias => {
			if (alias === "legacy") return { ok: false, unsupported: true, error: "ACP session/list unavailable" };
			if (alias === "build" && omp.remote.listHistory.mock.calls.filter(call => call[0] === "build").length === 1) {
				return { ok: false, error: "build disconnected" };
			}
			return { ok: true, sessions: [remoteSession(alias, `${alias}-1`, "/srv/app", null)] };
		});

		await mount(<Sidebar />);
		await fire(container.querySelector('[data-remote-host="legacy"] [data-remote-host-toggle]'), "onClick");
		expect(container.querySelector('[data-remote-host="legacy"]')?.textContent).toContain(
			"Remote history requires a newer remote OMP",
		);

		await fire(container.querySelector('[data-remote-host="build"] [data-remote-host-toggle]'), "onClick");
		expect(container.querySelector('[data-remote-host="build"]')?.textContent).toContain(
			"Could not load remote history",
		);
		await fire(container.querySelector('[data-remote-host="build"] [data-remote-history-retry]'), "onClick");
		expect(container.querySelector('[data-remote-session="build-1"]')).not.toBeNull();
		expect(omp.remote.listHistory.mock.calls.map(call => call[0])).toEqual(["legacy", "build", "build"]);
		expect(useRemoteStore.getState().hosts.prod?.historyStatus).toBe("idle");
	});
});
