/**
 * DOM smoke tests for the workspace-directories dialog (TUI /dirs /add-dir
 * /remove-dir /move parity): list rendering with the primary badge, loading
 * and error states, add via the native picker, remove behind the inline
 * confirm, and the move flow (picker → move_session → toast + rehydrate +
 * refetch). Same linkedom harness as SessionTreeDialog.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	RemoteDirectoryListResult,
	RemoteDirectoryValidationResult,
	RemotePreflightResult,
	SshSessionTarget,
} from "../../../shared/ipc-types";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { WorkspaceDirsDialog } from "./WorkspaceDirsDialog";

const { document, window, Event, CustomEvent, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	textContent: string | null;
	className: string;
	disabled: boolean;
	remove: () => void;
	appendChild: (child: TestElement) => void;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

function failure(error: string): RpcResponse {
	return { type: "response", command: "test", success: false, error };
}

interface MockRpc {
	getDirectories: Mock<() => Promise<RpcResponse>>;
	addDirectory: Mock<(path: string) => Promise<RpcResponse>>;
	removeDirectory: Mock<(path: string) => Promise<RpcResponse>>;
	moveSession: Mock<(path: string) => Promise<RpcResponse>>;
	getState: Mock<() => Promise<RpcResponse>>;
	getMessages: Mock<() => Promise<RpcResponse>>;
	getSubagents: Mock<() => Promise<RpcResponse>>;
	getGoal: Mock<() => Promise<RpcResponse>>;
	setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
}

interface MockRemote {
	preflight: Mock<(target: SshSessionTarget, tabId?: string) => Promise<RemotePreflightResult>>;
	listDirectories: Mock<
		(
			target: SshSessionTarget,
			path: string,
			showHidden: boolean,
			tabId?: string,
		) => Promise<RemoteDirectoryListResult>
	>;
	validateDirectory: Mock<
		(target: SshSessionTarget, path: string, tabId?: string) => Promise<RemoteDirectoryValidationResult>
	>;
}

interface MockOmp {
	rpc: MockRpc;
	remote: MockRemote;
	system: { showOpenDialog: Mock<() => Promise<string[] | null>> };
}

const CWD = "/work/project";
const EXTRA = "/work/extra";
const REMOTE_CWD = "/srv/app";
const REMOTE_TARGET: SshSessionTarget = {
	type: "ssh",
	hostAlias: "build",
	host: {
		host: "build.example.com",
		username: "deploy",
		port: 2202,
		sourceId: "ssh-config",
		sourceLevel: "user",
	},
	originCwd: REMOTE_CWD,
	cwd: REMOTE_CWD,
};

function directories(...paths: string[]): { directories: { path: string; primary: boolean }[] } {
	return { directories: paths.map(path => ({ path, primary: path === CWD })) };
}

function installMockOmp(overrides: { rpc?: Partial<MockRpc>; pickedPath?: string | null } = {}): MockOmp {
	const rpc: MockRpc = {
		getDirectories: vi.fn(async () => success(directories(CWD, EXTRA))),
		addDirectory: vi.fn(async () => success(directories(CWD, EXTRA))),
		removeDirectory: vi.fn(async () => success(directories(CWD))),
		moveSession: vi.fn(async () => success({ cwd: EXTRA })),
		getState: vi.fn(async () => success({ sessionId: "s1", messageCount: 0, todoPhases: [] })),
		getMessages: vi.fn(async () => success({ messages: [] })),
		getSubagents: vi.fn(async () => success({ subagents: [] })),
		getGoal: vi.fn(async () => success({})),
		setSubagentSubscription: vi.fn(async () => success({})),
		...overrides.rpc,
	};
	const remote: MockRemote = {
		preflight: vi.fn(async target => ({
			ok: true,
			target,
			home: "/home/deploy",
			platform: "linux",
			executable: "/usr/local/bin/omp",
		})),
		listDirectories: vi.fn(async (_target, path) => ({ ok: true, path, parent: "/srv", entries: [] })),
		validateDirectory: vi.fn(async (_target, path) => ({ ok: true, path })),
	};
	const omp: MockOmp = {
		rpc,
		remote,
		system: {
			showOpenDialog: vi.fn(async () => (overrides.pickedPath === null ? null : [overrides.pickedPath ?? EXTRA])),
		},
	};
	// linkedom's window lacks the preload bridge; install the mock OmpApi on it.
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
}

function seedRemoteTab(): void {
	useRemoteStore.getState().setCatalog({
		hosts: [{ alias: "build", host: { ...REMOTE_TARGET.host }, recentWorkspaces: [REMOTE_CWD] }],
		updatedAt: "2026-08-13T00:00:00.000Z",
	});
	useTabsStore.setState({
		tabs: [
			{
				id: "remote-1",
				cwd: REMOTE_CWD,
				target: REMOTE_TARGET,
				status: "ready",
				kind: "agent",
				unreadDone: false,
			},
		],
		activeTabId: "remote-1",
		bundles: new Map(),
	});
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

function queryAll(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

function buttons(): TestElement[] {
	return queryAll("button");
}

function findButton(text: string): TestElement {
	const match = buttons().find(button => button.textContent?.includes(text));
	if (!match) throw new Error(`button not found: ${text}`);
	return match;
}

/** Dispatch an event inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useUiStore.getState().closeWorkspaceDirs();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useRemoteStore.getState().reset();
	useToastStore.setState({ toasts: [] });
});

describe("WorkspaceDirsDialog", () => {
	it("lists the workspace roots with the primary badge once loaded", async () => {
		installMockOmp();
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);
		const text = document.body.textContent ?? "";
		expect(text).toContain(CWD);
		expect(text).toContain(EXTRA);
		expect(text).toContain("Primary");
	});

	it("shows the server error when the directory listing fails", async () => {
		installMockOmp({ rpc: { getDirectories: vi.fn(async () => failure("sidecar down")) } });
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);
		expect(document.body.textContent ?? "").toContain("sidecar down");
	});

	it("adds a directory picked from the native dialog and refreshes the list", async () => {
		const omp = installMockOmp({ pickedPath: "/work/third" });
		omp.rpc.addDirectory = vi.fn(async () => success(directories(CWD, EXTRA, "/work/third")));
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);
		await click(findButton("Add directory"));
		await flush();
		expect(omp.rpc.addDirectory).toHaveBeenCalledWith("/work/third");
		expect(document.body.textContent ?? "").toContain("/work/third");
		const toasts = useToastStore.getState().toasts;
		expect(toasts.some(toast => toast.variant === "success")).toBe(true);
	});

	it("does not call the RPC when the picker is cancelled", async () => {
		const omp = installMockOmp({ pickedPath: null });
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);
		await click(findButton("Add directory"));
		await flush();
		expect(omp.rpc.addDirectory).not.toHaveBeenCalled();
	});

	it("adds an SSH directory through the remote picker without opening the native dialog", async () => {
		const omp = installMockOmp({
			rpc: {
				getDirectories: vi.fn(async () => success({ directories: [{ path: REMOTE_CWD, primary: true }] })),
				addDirectory: vi.fn(async () => success({ directories: [{ path: REMOTE_CWD, primary: true }] })),
			},
		});
		seedRemoteTab();
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);

		await click(findButton("Add directory"));
		expect(omp.remote.preflight).toHaveBeenCalledWith(REMOTE_TARGET, "remote-1", expect.any(String));
		expect(omp.remote.listDirectories).toHaveBeenCalledWith(
			REMOTE_TARGET,
			REMOTE_CWD,
			false,
			"remote-1",
			expect.any(String),
		);
		expect(omp.remote.validateDirectory).toHaveBeenCalledWith(
			REMOTE_TARGET,
			REMOTE_CWD,
			"remote-1",
			expect.any(String),
		);
		await act(async () => {
			useRemoteStore.getState().setCatalog({ hosts: [], updatedAt: "2026-08-13T00:01:00.000Z" });
		});
		await flush();
		expect(omp.system.showOpenDialog).not.toHaveBeenCalled();
		expect(document.body.textContent ?? "").toContain("Choose remote workspace");

		await click(findButton("Open workspace"));
		await flush();
		expect(omp.rpc.addDirectory).toHaveBeenCalledWith(REMOTE_CWD);
		expect(document.body.textContent ?? "").toContain(REMOTE_CWD);
	});

	it("keeps the SSH directory dialog open when the remote picker is cancelled", async () => {
		const omp = installMockOmp({
			rpc: {
				getDirectories: vi.fn(async () => success({ directories: [{ path: REMOTE_CWD, primary: true }] })),
			},
		});
		seedRemoteTab();
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);

		await click(findButton("Add directory"));
		await flush();
		await click(findButton("Cancel"));
		await flush();

		expect(omp.rpc.addDirectory).not.toHaveBeenCalled();
		expect(omp.system.showOpenDialog).not.toHaveBeenCalled();
		expect(document.body.textContent ?? "").toContain("Workspace Directories");
		expect(document.body.textContent ?? "").toContain(REMOTE_CWD);
	});

	it("cancels the remote picker when the owning tab target changes without mutating either sidecar", async () => {
		const omp = installMockOmp({
			rpc: {
				getDirectories: vi.fn(async () => success({ directories: [{ path: REMOTE_CWD, primary: true }] })),
			},
		});
		seedRemoteTab();
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);
		await click(findButton("Add directory"));
		await flush();

		await act(async () => {
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab =>
					tab.id === "remote-1"
						? {
								...tab,
								target: { ...REMOTE_TARGET, cwd: "/srv/changed", originCwd: "/srv/changed" },
							}
						: tab,
				),
			}));
		});
		await flush();

		expect(document.body.textContent ?? "").not.toContain("Choose remote workspace");
		expect(omp.rpc.addDirectory).not.toHaveBeenCalled();
		expect(omp.system.showOpenDialog).not.toHaveBeenCalled();
	});

	it("keeps removal behind the inline confirm until confirmed", async () => {
		const omp = installMockOmp();
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);

		// Only the non-primary row carries a remove affordance (title = "Remove").
		const removeButton = buttons().find(button => button.getAttribute("title") === "Remove");
		if (!removeButton) throw new Error("remove button not found");
		await click(removeButton);
		await flush();
		expect(omp.rpc.removeDirectory).not.toHaveBeenCalled();

		// Cancel collapses the confirm without an RPC; re-open and confirm.
		await click(findButton("Cancel"));
		await flush();
		expect(omp.rpc.removeDirectory).not.toHaveBeenCalled();
		const removeButtonAgain = buttons().find(button => button.getAttribute("title") === "Remove");
		if (!removeButtonAgain) throw new Error("remove button not found after cancel");
		await click(removeButtonAgain);
		await flush();
		await click(findButton("Confirm"));
		await flush();
		expect(omp.rpc.removeDirectory).toHaveBeenCalledWith(EXTRA);
		expect(document.body.textContent ?? "").not.toContain(EXTRA);
	});

	it("never offers removal for the primary directory", async () => {
		installMockOmp();
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);
		// Exactly one remove button: the additional root's row.
		expect(buttons().filter(button => button.getAttribute("title") === "Remove")).toHaveLength(1);
	});

	it("moves the session to the picked directory, toasts, and rehydrates", async () => {
		const omp = installMockOmp({ pickedPath: EXTRA });
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);
		await click(findButton("Move session"));
		await flush();
		expect(omp.rpc.moveSession).toHaveBeenCalledWith(EXTRA);
		// hydrateSession pulled the session state, and the dialog refetched roots.
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(omp.rpc.getDirectories.mock.calls.length).toBeGreaterThanOrEqual(2);
		const toasts = useToastStore.getState().toasts;
		expect(toasts.some(toast => toast.variant === "success")).toBe(true);
	});

	it("moves an SSH session through the remote picker without opening the native dialog", async () => {
		const omp = installMockOmp({
			rpc: {
				getDirectories: vi.fn(async () => success({ directories: [{ path: REMOTE_CWD, primary: true }] })),
				moveSession: vi.fn(async path => success({ cwd: path })),
			},
		});
		seedRemoteTab();
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);

		await click(findButton("Move session"));
		await flush();
		expect(omp.system.showOpenDialog).not.toHaveBeenCalled();
		await click(findButton("Open workspace"));
		await flush();

		expect(omp.rpc.moveSession).toHaveBeenCalledWith(REMOTE_CWD);
		expect(omp.rpc.getDirectories.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it("surfaces a primary-removal refusal as an error toast and keeps the list", async () => {
		const omp = installMockOmp();
		omp.rpc.removeDirectory = vi.fn(async () =>
			failure("Cannot remove the working directory; use /move to change it."),
		);
		useUiStore.getState().openWorkspaceDirs();
		await mount(<WorkspaceDirsDialog />);
		const removeButton = buttons().find(button => button.getAttribute("title") === "Remove");
		if (!removeButton) throw new Error("remove button not found");
		await click(removeButton);
		await flush();
		await click(findButton("Confirm"));
		await flush();
		const toasts = useToastStore.getState().toasts;
		expect(toasts.some(toast => toast.variant === "error" && (toast.message ?? "").includes("/move"))).toBe(true);
		expect(document.body.textContent ?? "").toContain(EXTRA);
	});
});
