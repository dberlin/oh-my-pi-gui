/**
 * Linkedom interaction coverage for local and SSH New Session workspace choices.
 * The preload bridge is replaced at the IPC boundary; the real remote picker,
 * remote catalog store, and tabs store remain in the exercised path.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	IpcSpawnTabPayload,
	IpcSpawnTabResult,
	RemoteDirectoryListResult,
	RemoteDirectoryValidationResult,
	RemoteHostCatalogSnapshot,
	RemotePreflightResult,
	SessionInfo,
	SshSessionTarget,
} from "../../../shared/ipc-types";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { WorkspaceDialog } from "./WorkspaceDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

interface TestElement {
	textContent: string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

const LOCAL_CWD = "/local/project";
const REMOTE_CWD = "/srv/app";
const CATALOG: RemoteHostCatalogSnapshot = {
	hosts: [
		{
			alias: "build",
			host: {
				host: "build.example.com",
				username: "deploy",
				port: 2202,
				sourceId: "ssh-config",
				sourceLevel: "user",
				os: "linux",
				shell: "bash",
			},
			recentWorkspaces: [REMOTE_CWD],
		},
	],
	updatedAt: "2026-08-13T00:00:00.000Z",
};

const LOCAL_SESSION: SessionInfo = {
	id: "local-1",
	path: "/sessions/local-1.jsonl",
	cwd: LOCAL_CWD,
	modified: "2026-08-13T00:00:00.000Z",
	created: "2026-08-13T00:00:00.000Z",
	messageCount: 3,
	title: null,
	size: 128,
	status: "complete",
	firstMessage: "Open the local project",
};

interface WorkspaceMockOmp {
	sessions: {
		list: Mock<() => Promise<SessionInfo[]>>;
	};
	events: {
		onSessionsChanged: Mock<(listener: () => void) => () => void>;
	};
	rpc: {
		moveSession: Mock<(path: string) => Promise<RpcResponse>>;
		getState: Mock<() => Promise<RpcResponse>>;
		getMessages: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
	};
	sidecar: {
		setProject: Mock<(cwd: string) => Promise<boolean>>;
		selectProject: Mock<() => Promise<string | null>>;
	};
	remote: {
		catalog: Mock<() => Promise<{ ok: true; catalog: RemoteHostCatalogSnapshot }>>;
		preflight: Mock<(target: SshSessionTarget, tabId?: string, requestId?: string) => Promise<RemotePreflightResult>>;
		listDirectories: Mock<
			(
				target: SshSessionTarget,
				path: string,
				showHidden: boolean,
				tabId?: string,
			) => Promise<RemoteDirectoryListResult>
		>;
		validateDirectory: Mock<
			(
				target: SshSessionTarget,
				path: string,
				tabId?: string,
				requestId?: string,
			) => Promise<RemoteDirectoryValidationResult>
		>;
		noteWorkspace: Mock<
			(hostAlias: string, cwd: string) => Promise<{ ok: true; catalog: RemoteHostCatalogSnapshot }>
		>;
	};
	tabs: {
		spawn: Mock<(payload: IpcSpawnTabPayload) => Promise<IpcSpawnTabResult | null>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
	};
}

function installOmp(): WorkspaceMockOmp {
	const success = (data: unknown): RpcResponse => ({ type: "response", command: "test", success: true, data });
	const omp: WorkspaceMockOmp = {
		sessions: { list: vi.fn(async () => [LOCAL_SESSION]) },
		events: { onSessionsChanged: vi.fn(() => () => {}) },
		rpc: {
			moveSession: vi.fn(async path => success({ cwd: path })),
			getState: vi.fn(async () =>
				success({
					model: null,
					thinkingLevel: undefined,
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					interruptMode: "immediate",
					sessionFile: "/home/deploy/.omp/sessions/remote.jsonl",
					cwd: REMOTE_CWD,
					sessionId: "remote-session",
					sessionName: null,
					fastModeEnabled: false,
					fastModeActive: false,
					tokensPerSecond: null,
					autoCompactionEnabled: true,
					autoRetryEnabled: true,
					messageCount: 0,
					queuedMessageCount: 0,
					todoPhases: [],
					systemPrompt: [],
					dumpTools: [],
					contextUsage: null,
					planModeEnabled: false,
					agentsPaused: false,
				}),
			),
			getMessages: vi.fn(async () => success({ messages: [] })),
			setSubagentSubscription: vi.fn(async () => success({})),
			getSubagents: vi.fn(async () => success({ subagents: [] })),
		},
		sidecar: {
			setProject: vi.fn(async () => true),
			selectProject: vi.fn(async () => null),
		},
		remote: {
			catalog: vi.fn(async () => ({ ok: true, catalog: CATALOG })),
			preflight: vi.fn(async target => ({
				ok: true,
				target,
				home: "/home/deploy",
				platform: "linux",
				executable: "/usr/local/bin/omp",
			})),
			listDirectories: vi.fn(async (_target, path) => ({ ok: true, path, parent: "/srv", entries: [] })),
			validateDirectory: vi.fn(async (_target, path) => ({ ok: true, path })),
			noteWorkspace: vi.fn(async () => ({ ok: true, catalog: CATALOG })),
		},
		tabs: {
			spawn: vi.fn(async () => ({ tabId: "remote-1" })),
			setActive: vi.fn(async () => true),
		},
	};
	const ompWindow = window as unknown as { omp: WorkspaceMockOmp };
	ompWindow.omp = omp;
	return omp;
}

let container: TestElement | undefined;
let root: Root | undefined;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(
	onClose = vi.fn(),
	intent: "switch" | "new-session" = "new-session",
	location: "all" | "local" | "remote" = "all",
): Promise<Mock<() => void>> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<WorkspaceDialog intent={intent} location={location} onClose={onClose} open />
			</I18nProvider>,
		);
	});
	await flush();
	return onClose;
}

function buttons(): TestElement[] {
	return Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
}

function findButton(text: string): TestElement {
	const button = buttons().find(candidate => candidate.textContent?.includes(text));
	if (!button) throw new Error(`button not found: ${text}`);
	return button;
}

async function click(element: TestElement): Promise<void> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		element.dispatchEvent(event);
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
		root = undefined;
	}
	container?.remove();
	container = undefined;
	useRemoteStore.getState().reset();
	useTabsStore.getState().reset();
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("WorkspaceDialog New Session", () => {
	it("opens an explicitly local session on a local target while an SSH tab is active", async () => {
		const omp = installOmp();
		useSessionStore.setState({ cwd: REMOTE_CWD });
		useTabsStore.setState({
			activeTabId: "remote-active",
			tabs: [
				{
					id: "remote-active",
					cwd: REMOTE_CWD,
					target: {
						type: "ssh",
						hostAlias: "build",
						host: { ...CATALOG.hosts[0].host },
						originCwd: REMOTE_CWD,
						cwd: REMOTE_CWD,
					},
					status: "ready",
					kind: "agent",
					unreadDone: false,
				},
			],
		});
		await mount(vi.fn(), "new-session", "local");
		expect(document.body.textContent ?? "").not.toContain(REMOTE_CWD);

		await click(findButton(LOCAL_CWD));
		await flush();

		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: LOCAL_CWD,
			sessionPath: undefined,
			kind: "agent",
			target: { type: "local" },
		});
		expect(omp.sidecar.setProject).not.toHaveBeenCalled();
		expect(omp.sidecar.selectProject).not.toHaveBeenCalled();
		expect(omp.remote.noteWorkspace).not.toHaveBeenCalled();
	});

	it("loads remote hosts, opens the controlled picker, and starts through the tabs store", async () => {
		const omp = installOmp();
		const onClose = await mount();
		expect(omp.remote.catalog).toHaveBeenCalledTimes(1);

		await click(findButton("build"));
		await flush();
		expect(document.body.textContent ?? "").toContain("Choose remote workspace");
		await click(findButton("Open workspace"));
		await flush();

		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: "build",
			host: { ...CATALOG.hosts[0].host },
			originCwd: REMOTE_CWD,
			cwd: REMOTE_CWD,
		};
		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: REMOTE_CWD,
			sessionPath: undefined,
			kind: "agent",
			target,
		});
		expect(omp.remote.noteWorkspace).toHaveBeenCalledWith("build", REMOTE_CWD);
		expect(omp.sidecar.setProject).not.toHaveBeenCalled();
		expect(omp.sidecar.selectProject).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("cancels only the remote picker and keeps the New Session dialog intact", async () => {
		const omp = installOmp();
		const onClose = await mount();
		await click(findButton("build"));
		await flush();
		await click(findButton("Cancel"));
		await flush();

		expect(omp.tabs.spawn).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(document.body.textContent ?? "").toContain("New session — choose workspace");
		expect(document.body.textContent ?? "").toContain(LOCAL_CWD);
	});

	it("keeps New Session open and does not note a workspace when tab spawn is refused", async () => {
		const omp = installOmp();
		omp.tabs.spawn.mockResolvedValue(null);
		const onClose = await mount();
		await click(findButton("build"));
		await flush();
		await click(findButton("Open workspace"));
		await flush();

		expect(omp.remote.noteWorkspace).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		expect(document.body.textContent ?? "").toContain("New session — choose workspace");
		expect(document.body.textContent ?? "").toContain(LOCAL_CWD);
	});
});

describe("WorkspaceDialog title-bar SSH flow", () => {
	it("validates and moves the active SSH tab without calling local project APIs", async () => {
		const omp = installOmp();
		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: "build",
			host: { ...CATALOG.hosts[0].host },
			originCwd: "/srv/origin",
			cwd: REMOTE_CWD,
			executableOverride: "/opt/omp",
		};
		useTabsStore.setState({
			tabs: [
				{
					id: "remote-1",
					cwd: REMOTE_CWD,
					target,
					status: "ready",
					kind: "agent",
					unreadDone: false,
				},
			],
			activeTabId: "remote-1",
			bundles: new Map(),
		});
		useSessionStore.setState({ cwd: REMOTE_CWD });
		const onClose = await mount(vi.fn(), "switch");

		expect(document.body.textContent ?? "").toContain("Choose remote workspace");
		await click(findButton("Open workspace"));
		await flush();
		await flush();

		expect(omp.remote.preflight).toHaveBeenCalledWith(target, "remote-1", expect.any(String));
		expect(omp.remote.validateDirectory).toHaveBeenCalledWith(target, REMOTE_CWD, "remote-1", expect.any(String));
		expect(omp.rpc.moveSession).toHaveBeenCalledWith(REMOTE_CWD);
		expect(omp.sidecar.setProject).not.toHaveBeenCalled();
		expect(omp.sidecar.selectProject).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
