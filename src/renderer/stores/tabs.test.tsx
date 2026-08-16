/**
 * tabs store contract tests:
 * - boot GET_TABS reconciliation (initial sidecar = tab 0, never duplicated)
 * - switchTab snapshots the current tab's session-scoped slices (messages,
 *   session meta, todos, subagents, queue, model, composer draft), restores
 *   the target's bundle for instant paint, fires SET_ACTIVE_TAB BEFORE
 *   hydrate, then hydrates from the target sidecar
 * - closeTab keeps ≥1 tab and activates a neighbor when the active tab closes
 * - applyTabStatus stamps unreadDone on background run completion
 * - useSessionTabs completes the open-in-new-tab flow (pending session path
 *   applied on the tab's first ready push while active)
 *
 * Harness: linkedom + react-dom (same as use-rpc-events.test.tsx) — the hook
 * test needs React; store tests just reuse the globals.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	IpcSpawnTabPayload,
	IpcSpawnTabResult,
	IpcTabInfo,
	IpcTabStatusPayload,
	SessionTarget,
	SshSessionTarget,
} from "../../shared/ipc-types";
import type {
	AgentMessage,
	AgentSessionEvent,
	ModelInfo,
	RpcResponse,
	RpcSessionState,
	SubagentSnapshot,
	TodoPhase,
	ToolCallContent,
} from "../../shared/rpc-types";
import { buildSubagentList } from "../components/chat/activity/agent-tree-model";
import { recoverReadySession } from "../hooks/use-rpc-events";
import { resolveMainToolCall } from "../lib/read-group";
import { acceptsActiveTabEvents } from "../lib/tab-routing";
import { useAgentViewStore } from "./agent-view";
import { useComposerStore } from "./composer";
import { useExtensionUiStore } from "./extension-ui";
import { useForkHandoffStore } from "./fork-handoff";
import { useMessagesStore } from "./messages";
import { useModelStore } from "./model";
import { usePlanApprovalStore } from "./plan-approval";
import { useQueueStore } from "./queue";
import { useSessionStore } from "./session";
import { useSubagentsStore } from "./subagents";
import {
	pushTabExtensionUiRequest,
	restoreTabComposer,
	type SessionTab,
	settleTabPlanApproval,
	tabChipLabel,
	useSessionTabs,
	useTabsStore,
} from "./tabs";
import { useToastStore } from "./toast";
import { useTodoStore } from "./todo";
import { useToolsStore } from "./tools";
import { useUiStore } from "./ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

function serverState(overrides: Partial<RpcSessionState> = {}): RpcSessionState {
	return {
		sessionId: "srv",
		sessionName: null,
		sessionFile: null,
		isStreaming: false,
		isCompacting: false,
		contextUsage: null,
		messageCount: 0,
		queuedMessageCount: 0,
		planModeEnabled: false,
		todoPhases: [],
		...overrides,
	} as RpcSessionState;
}

function msg(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function tabInfo(
	tabId: string,
	cwd: string,
	status: IpcTabInfo["status"] = "ready",
	target: SessionTarget = { type: "local" },
): IpcTabInfo {
	return { tabId, cwd, target, status, kind: "agent" };
}

function sshTarget(cwd = "/srv/app"): SshSessionTarget {
	return {
		type: "ssh",
		hostAlias: "build",
		host: {
			host: "build.example.com",
			username: "deploy",
			port: 2202,
			sourceId: "ssh-config",
			sourceLevel: "user",
		},
		originCwd: "/srv/origin",
		cwd,
		executableOverride: "/opt/omp",
	};
}
interface MockOmp {
	tabs: {
		list: Mock<() => Promise<IpcTabInfo[]>>;
		spawn: Mock<(payload: IpcSpawnTabPayload) => Promise<IpcSpawnTabResult | null>>;
		close: Mock<(tabId: string) => Promise<boolean>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
	};
	events: {
		onTabStatus: Mock<(callback: (payload: IpcTabStatusPayload) => void) => () => void>;
	};
	rpc: {
		getState: Mock<() => Promise<RpcResponse>>;
		getMessages: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		getSubagentMessages: Mock<(subagentId?: string, sessionFile?: string, fromByte?: number) => Promise<RpcResponse>>;
		getGoal: Mock<() => Promise<RpcResponse>>;
		getLoopMode: Mock<() => Promise<RpcResponse>>;
		getVibeMode: Mock<() => Promise<RpcResponse>>;
		getQueue: Mock<() => Promise<RpcResponse>>;
		switchSession: Mock<(sessionPath: string) => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
	};
}

type TabStatusHandler = (payload: IpcTabStatusPayload) => void;

function installMockOmp(): { omp: MockOmp; emitTabStatus: TabStatusHandler } {
	let tabStatusHandler: TabStatusHandler = () => {};
	const omp: MockOmp = {
		tabs: {
			list: vi.fn(async () => []),
			spawn: vi.fn(async () => null),
			close: vi.fn(async () => true),
			setActive: vi.fn(async () => true),
		},
		events: {
			onTabStatus: vi.fn((callback: TabStatusHandler) => {
				tabStatusHandler = callback;
				return () => {};
			}),
		},
		rpc: {
			getState: vi.fn(async () => ok(serverState())),
			getMessages: vi.fn(async () => ok({ messages: [] })),
			getSubagents: vi.fn(async () => ok({ subagents: [] })),
			getSubagentMessages: vi.fn(async () => ok({ messages: [], nextByte: 0, hasMore: false })),
			getGoal: vi.fn(async () => ok({ enabled: false })),
			getLoopMode: vi.fn(async () => ok({ enabled: false, state: "off" })),
			getVibeMode: vi.fn(async () => ok({ enabled: false })),
			getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
			switchSession: vi.fn(async () => ok({ cancelled: false })),
			setSubagentSubscription: vi.fn(async () => ok({})),
		},
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return { omp, emitTabStatus: payload => tabStatusHandler(payload) };
}

/** Seed two tabs without going through spawn: t0 active, t1 background. */
function seedTabs(active: "t0" | "t1" | "t2" = "t0"): void {
	useTabsStore.setState({
		tabs: [
			{ kind: "agent", id: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready", unreadDone: false },
			{ kind: "agent", id: "t1", cwd: "/beta", target: { type: "local" }, status: "ready", unreadDone: false },
			{ kind: "agent", id: "t2", cwd: "/gamma", target: { type: "local" }, status: "ready", unreadDone: false },
		],
		activeTabId: active,
		bundles: new Map(),
	});
}

/** Fill the live stores with t0's recognizable session state. */
function fillLiveStores(tag: string): void {
	useSessionStore.setState({
		sessionId: `s-${tag}`,
		sessionName: `Session ${tag}`,
		cwd: `/${tag}`,
		isStreaming: false,
		status: "ready",
		planModeEnabled: true,
		goal: { objective: `goal-${tag}` },
	});
	useMessagesStore.setState({ messages: [msg(`hello-${tag}`)], totalMessages: 1 });
	useTodoStore.getState().setPhases([{ name: `phase-${tag}`, tasks: [] } as TodoPhase]);
	useQueueStore.setState({
		steering: [{ id: `q-${tag}`, text: `steer-${tag}`, editable: true, timestamp: 1 }],
		followUp: [],
	});
	useSubagentsStore.setState({
		subagents: new Map<string, SubagentSnapshot>([
			[`a-${tag}`, { id: `a-${tag}`, index: 1, agent: "worker", status: "running", lastUpdate: 1, kind: "sub" }],
		]),
	});
	useModelStore.setState({
		model: { provider: "p", id: `m-${tag}` } as ModelInfo,
		fastModeEnabled: true,
	});
	useComposerStore.getState().setDraft(`draft-${tag}`);
	useComposerStore
		.getState()
		.setImages([
			{ content: { type: "image", data: `image-${tag}`, mimeType: "image/png" }, preview: `preview-${tag}` },
		]);
	usePlanApprovalStore.getState().showProposal({
		planFilePath: `/plan-${tag}.md`,
		planContent: `plan-${tag}`,
		options: ["execute"],
	});
	usePlanApprovalStore.getState().setFeedback(`feedback-${tag}`);
	useExtensionUiStore.getState().pushRequest({
		type: "extension_ui_request",
		id: `ui-${tag}`,
		method: "confirm",
		title: `Confirm ${tag}`,
		message: `Message ${tag}`,
	});
	useExtensionUiStore.getState().setStatus(`status-${tag}`, `Status ${tag}`);
	useExtensionUiStore.getState().setWidget(`widget-${tag}`, [`Widget ${tag}`]);
}

let omp: MockOmp;
let emitTabStatus: TabStatusHandler;

function resetAll(): void {
	useTabsStore.getState().reset();
	useAgentViewStore.getState().reset();
	useComposerStore.getState().reset();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useTodoStore.getState().reset();
	useQueueStore.setState({ steering: [], followUp: [] });
	useSubagentsStore.getState().reset();
	useModelStore.getState().reset();
	useToolsStore.getState().reset();
	usePlanApprovalStore.getState().clearProposal();
	useExtensionUiStore.getState().clearAll();
	useUiStore.getState().closeSessionOverlays();
	useUiStore.getState().closeStatsDashboard();
	useForkHandoffStore.getState().closeHandoffDialog();
}

afterEach(() => {
	resetAll();
	vi.useRealTimers();
	vi.restoreAllMocks();
	({ omp, emitTabStatus } = installMockOmp());
});

({ omp, emitTabStatus } = installMockOmp());

describe("tabs store boot reconciliation", () => {
	it("adopts the window's initial sidecar as tab 0 and never duplicates it", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);

		await useTabsStore.getState().reconcileTabs();
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0"]);
		expect(useTabsStore.getState().activeTabId).toBe("t0");

		// Reconcile again (and after a status push that pre-created the entry):
		// merge is by tabId, so the initial sidecar appears exactly once.
		await useTabsStore.getState().reconcileTabs();
		expect(useTabsStore.getState().tabs).toHaveLength(1);

		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			target: { type: "local" },
			status: "ready",
			title: "Alpha",
		});
		await useTabsStore.getState().reconcileTabs();
		const tabs = useTabsStore.getState().tabs;
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.title).toBe("Alpha");
	});

	it("defaults a missing legacy IPC target to local", async () => {
		omp.tabs.list.mockResolvedValue([
			{ tabId: "legacy", cwd: "/legacy", status: "ready", kind: "agent" } as IpcTabInfo,
		]);

		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().tabs[0]?.target).toEqual({ type: "local" });
	});

	it("keeps renderer-known tabs the reply misses and re-converges active on reload", async () => {
		seedTabs("t1");
		// Main knows only two of three tabs (the third spawned mid-reply).
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), tabInfo("t1", "/beta")]);

		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1", "t2"]);
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		// >1 tabs after a renderer reload: main re-converges to the renderer's pick.
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");
	});

	it("restores main's persisted active tab when renderer state is empty", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), { ...tabInfo("t1", "/beta"), active: true }]);

		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1"]);
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");
	});

	it("retains the restored transcript path before session metadata arrives", async () => {
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("t0", "/alpha"), sessionPath: "/sessions/restored.jsonl", active: true },
		]);

		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().tabs[0]).toMatchObject({
			id: "t0",
			sessionPath: "/sessions/restored.jsonl",
		});
	});

	it("invalidates a parked bundle when boot reconciliation observes a replacement session", async () => {
		seedTabs();
		fillLiveStores("old");
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			target: { type: "local" },
			status: "ready",
			title: "Old",
			sessionId: "s-old",
		});
		await useTabsStore.getState().switchTab("t1");
		expect(useTabsStore.getState().bundles.has("t0")).toBe(true);
		omp.tabs.list.mockResolvedValue([
			{
				kind: "agent",
				tabId: "t0",
				cwd: "/alpha",
				target: { type: "local" },
				status: "ready",
				title: null,
				sessionId: "s-new",
			},
			tabInfo("t1", "/beta"),
			tabInfo("t2", "/gamma"),
		]);

		await useTabsStore.getState().reconcileTabs();

		expect(useTabsStore.getState().bundles.has("t0")).toBe(false);
		expect(useTabsStore.getState().tabs[0]).toMatchObject({ sessionId: "s-new", title: undefined });
	});
	it("returns the active view to Main when reconciliation replaces its session", async () => {
		seedTabs();
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			target: { type: "local" },
			status: "ready",
			sessionId: "s-old",
		});
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "old-agent" });
		const generation = useAgentViewStore.getState().generation;
		omp.tabs.list.mockResolvedValue([
			{ ...tabInfo("t0", "/alpha"), sessionId: "s-new" },
			tabInfo("t1", "/beta"),
			tabInfo("t2", "/gamma"),
		]);

		await useTabsStore.getState().reconcileTabs();

		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(useAgentViewStore.getState().generation).toBe(generation + 1);
	});
});

describe("tabs store switch", () => {
	it("openTab spawns in the current cwd, registers the tab, and switches to it", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		await useTabsStore.getState().reconcileTabs();
		useSessionStore.setState({ cwd: "/alpha" });
		omp.tabs.spawn.mockResolvedValue({ tabId: "t1" });

		const tabId = await useTabsStore.getState().openTab();

		expect(tabId).toBe("t1");
		expect(omp.tabs.spawn).toHaveBeenCalledWith({ cwd: "/alpha", sessionPath: undefined, kind: "agent" });
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1"]);
		expect(useTabsStore.getState().activeTabId).toBe("t1");
	});

	it("forwards an SSH target and resume id and derives cwd from the target", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		await useTabsStore.getState().reconcileTabs();
		const target = sshTarget();
		omp.tabs.spawn.mockResolvedValue({ tabId: "remote-1" });

		const tabId = await useTabsStore.getState().openTab({
			target,
			resumeSessionId: "acp-session-1",
		});

		expect(tabId).toBe("remote-1");
		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/srv/app",
			sessionPath: undefined,
			kind: "agent",
			target,
			resumeSessionId: "acp-session-1",
		});
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "remote-1")?.target).toBe(target);
	});

	it("hydrates a fresh tab when its ready push beats full route wiring", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		await useTabsStore.getState().reconcileTabs();
		useSessionStore.setState({ cwd: "/alpha", status: "ready" });
		omp.tabs.spawn.mockResolvedValue({ tabId: "t1" });
		const route = Promise.withResolvers<boolean>();
		omp.tabs.setActive.mockReturnValueOnce(route.promise);

		const opening = useTabsStore.getState().openTab({ kind: "chat" });
		await Promise.resolve();
		await Promise.resolve();
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");

		// The light per-tab channel reports ready before main finishes attaching
		// the full active-tab channel, so no full ready event will replay.
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "chat", tabId: "t1", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		route.resolve(true);
		await opening;

		expect(useSessionStore.getState().status).toBe("ready");
		expect(useSessionStore.getState().sessionId).toBe("srv");
		expect(omp.rpc.getState).toHaveBeenCalled();
	});

	it("reports the pool cap without mutating the tab list", async () => {
		seedTabs();
		omp.tabs.spawn.mockResolvedValue(null);

		const tabId = await useTabsStore.getState().openTab();

		expect(tabId).toBeNull();
		expect(useTabsStore.getState().tabs).toHaveLength(3);
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(omp.tabs.setActive).not.toHaveBeenCalled();
	});

	it("surfaces a kind-mismatch refusal as an error toast and adds no tab", async () => {
		seedTabs();
		omp.tabs.spawn.mockResolvedValue({ tabId: null, refusal: "kind-mismatch" });

		const tabId = await useTabsStore.getState().openTab({ sessionPath: "/sessions/agent.jsonl", kind: "chat" });

		expect(tabId).toBeNull();
		expect(useTabsStore.getState().tabs).toHaveLength(3);
		expect(useToastStore.getState().toasts.some(toast => toast.variant === "error")).toBe(true);
		expect(omp.tabs.setActive).not.toHaveBeenCalled();
	});

	it("fires SET_ACTIVE_TAB before hydrating from the target sidecar", async () => {
		seedTabs();

		await useTabsStore.getState().switchTab("t1");

		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");
		expect(omp.rpc.getState).toHaveBeenCalled();
		const setActiveOrder = omp.tabs.setActive.mock.invocationCallOrder[0];
		const getStateOrder = omp.rpc.getState.mock.invocationCallOrder[0];
		expect(setActiveOrder).toBeDefined();
		expect(getStateOrder).toBeDefined();
		expect(setActiveOrder!).toBeLessThan(getStateOrder!);
	});

	it("keeps the target cwd when get_state omits it", async () => {
		seedTabs();

		await useTabsStore.getState().switchTab("t1");

		expect(useSessionStore.getState().cwd).toBe("/beta");
	});

	it("hydrates only the SSH target cwd while preserving its immutable identity", async () => {
		seedTabs();
		const target = sshTarget();
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, cwd: target.cwd, target } : tab)),
		}));
		omp.rpc.getState.mockResolvedValue(ok(serverState({ cwd: "/srv/new" })));

		await useTabsStore.getState().switchTab("t1");

		const hydrated = useTabsStore.getState().tabs.find(tab => tab.id === "t1");
		expect(hydrated?.cwd).toBe("/srv/new");
		expect(hydrated?.target).toEqual({
			...target,
			cwd: "/srv/new",
		});
		expect(hydrated?.target.type === "ssh" ? hydrated.target.host : null).toBe(target.host);
		expect(useSessionStore.getState().cwd).toBe("/srv/new");
	});

	it("closes outgoing session overlays while keeping global windows open", async () => {
		seedTabs();
		useUiStore.getState().openSettings();
		useUiStore.getState().openContextReport();
		useUiStore.getState().openModes("goal");
		useUiStore.getState().openStatsDashboard();
		useForkHandoffStore.getState().openHandoffDialog();

		await useTabsStore.getState().switchTab("t1");

		expect(useUiStore.getState().settingsOpen).toBe(false);
		expect(useUiStore.getState().contextReportOpen).toBe(false);
		expect(useUiStore.getState().modesOpen).toBe(false);
		expect(useForkHandoffStore.getState().handoffDialogOpen).toBe(false);
		expect(useUiStore.getState().statsDashboardOpen).toBe(true);
	});

	it("serializes rapid switches and hydrates only the latest visible tab", async () => {
		seedTabs();
		const firstRoute = Promise.withResolvers<boolean>();
		const secondRoute = Promise.withResolvers<boolean>();
		omp.tabs.setActive.mockReturnValueOnce(firstRoute.promise).mockReturnValueOnce(secondRoute.promise);

		const firstSwitch = useTabsStore.getState().switchTab("t1");
		const secondSwitch = useTabsStore.getState().switchTab("t2");
		await Promise.resolve();

		// UI selection remains immediate even while main-process routing catches up.
		expect(useTabsStore.getState().activeTabId).toBe("t2");
		expect(acceptsActiveTabEvents()).toBe(false);
		expect(omp.tabs.setActive).toHaveBeenCalledTimes(1);

		firstRoute.resolve(true);
		await firstSwitch;
		expect(omp.tabs.setActive).toHaveBeenCalledTimes(2);
		// The superseded t1 route must not hydrate into t2's visible stores.
		expect(acceptsActiveTabEvents()).toBe(false);
		expect(omp.rpc.getState).not.toHaveBeenCalled();

		secondRoute.resolve(true);
		await Promise.all([firstSwitch, secondSwitch]);

		expect(omp.tabs.setActive.mock.calls.map(call => call[0])).toEqual(["t1", "t2"]);
		expect(omp.rpc.getState).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().activeTabId).toBe("t2");
		expect(acceptsActiveTabEvents()).toBe(true);
	});

	it("snapshots the current tab's slices and restores the target's — draft included", async () => {
		seedTabs();
		fillLiveStores("t0");

		// Gate the transcript so the restored (pre-hydrate) state is observable.
		const gate = Promise.withResolvers<RpcResponse>();
		omp.rpc.getMessages.mockReturnValueOnce(gate.promise);
		const firstSwitch = useTabsStore.getState().switchTab("t1");

		// t1 has no bundle: stores reset to empty instantly, before any RPC settles.
		expect(useComposerStore.getState().draft).toBe("");
		expect(useComposerStore.getState().images).toEqual([]);
		expect(useMessagesStore.getState().messages).toEqual([]);
		expect(useSessionStore.getState().sessionId).toBe("");
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
		expect(useExtensionUiStore.getState().statusWidgets).toEqual({});

		gate.resolve(ok({ messages: [msg("server-t1")] }));
		await firstSwitch;

		// Hydrate applied the target sidecar's state; the (empty) draft is untouched.
		expect(useSessionStore.getState().sessionId).toBe("srv");
		expect(useMessagesStore.getState().messages.map(m => messageText(m))).toEqual(["server-t1"]);

		// t0's bundle is parked; t1 now gets its own recognizable live state.
		fillLiveStores("t1");
		pushTabExtensionUiRequest("t0", {
			type: "extension_ui_request",
			id: "ui-t0-late",
			method: "confirm",
			title: "Late t0 request",
			message: "Still belongs to t0",
		});
		expect(useExtensionUiStore.getState().pendingRequests.map(request => request.id)).toEqual(["ui-t1"]);
		const gate2 = Promise.withResolvers<RpcResponse>();
		omp.rpc.getMessages.mockReturnValueOnce(gate2.promise);
		const secondSwitch = useTabsStore.getState().switchTab("t0");

		// Instant restore of t0's parked bundle — every slice, before hydrate.
		expect(useComposerStore.getState().draft).toBe("draft-t0");
		expect(useComposerStore.getState().images[0]?.content.data).toBe("image-t0");
		expect(useMessagesStore.getState().messages.map(m => messageText(m))).toEqual(["hello-t0"]);
		expect(useSessionStore.getState().sessionId).toBe("s-t0");
		expect(useSessionStore.getState().sessionName).toBe("Session t0");
		expect(useSessionStore.getState().planModeEnabled).toBe(true);
		expect(useSessionStore.getState().goal?.objective).toBe("goal-t0");
		expect(useTodoStore.getState().phases.map(phase => phase.name)).toEqual(["phase-t0"]);
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["q-t0"]);
		expect(useSubagentsStore.getState().subagents.has("a-t0")).toBe(true);
		expect(useModelStore.getState().model?.id).toBe("m-t0");
		expect(useModelStore.getState().fastModeEnabled).toBe(true);
		expect(usePlanApprovalStore.getState().pending?.planContent).toBe("plan-t0");
		expect(usePlanApprovalStore.getState().feedback).toBe("feedback-t0");
		expect(useExtensionUiStore.getState().pendingRequests.map(request => request.id)).toEqual([
			"ui-t0",
			"ui-t0-late",
		]);
		expect(useExtensionUiStore.getState().statusWidgets).toEqual({ "status-t0": "Status t0" });
		expect(useExtensionUiStore.getState().widgetPanels).toEqual({ "widget-t0": ["Widget t0"] });

		gate2.resolve(ok({ messages: [msg("hello-t0")] }));
		await secondSwitch;

		// Hydrate never touches the composer draft: t0's draft survives the switch.
		expect(useComposerStore.getState().draft).toBe("draft-t0");

		// …and t1's bundle parked its own draft, restored on the way back.
		await useTabsStore.getState().switchTab("t1");
		expect(useComposerStore.getState().draft).toBe("draft-t1");
		expect(useComposerStore.getState().images[0]?.content.data).toBe("image-t1");
		expect(usePlanApprovalStore.getState().pending?.planContent).toBe("plan-t1");
		expect(useExtensionUiStore.getState().pendingRequests.map(request => request.id)).toEqual(["ui-t1"]);
	});

	it("restores the current tool projection generation and repeated-id routing with its tab bundle", async () => {
		seedTabs();
		const historicalCall: ToolCallContent = {
			type: "toolCall",
			id: "read:0",
			name: "read",
			arguments: { path: "/history" },
		};
		const historicalMessages: AgentMessage[] = [
			{ role: "assistant", content: [historicalCall], timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: historicalCall.id,
				toolName: historicalCall.name,
				content: [{ type: "text", text: "historical output" }],
				isError: false,
				timestamp: 2,
			},
		];
		const liveCall: ToolCallContent = {
			type: "toolCall",
			id: historicalCall.id,
			name: "read",
			arguments: { path: "/live" },
		};
		const liveMessage: AgentMessage = { role: "assistant", content: [liveCall] };
		const liveStart: AgentSessionEvent = { type: "message_start", message: liveMessage };
		const liveEnd: AgentSessionEvent = { type: "message_end", message: liveMessage };
		const deserializedAMessages = JSON.parse(JSON.stringify([...historicalMessages, liveMessage])) as AgentMessage[];

		useMessagesStore.getState().reconcileFetched(historicalMessages);
		useToolsStore.getState().hydrateMessages(historicalMessages);
		useMessagesStore.getState().applyEvents([liveStart, liveEnd]);
		useToolsStore.getState().applyEvents([liveStart, liveEnd]);
		useSessionStore.setState({ isStreaming: true, status: "ready" });

		omp.rpc.getState
			.mockResolvedValueOnce(ok(serverState()))
			.mockResolvedValueOnce(ok(serverState({ isStreaming: true })));
		omp.rpc.getMessages
			.mockResolvedValueOnce(ok({ messages: [] }))
			.mockResolvedValueOnce(ok({ messages: deserializedAMessages }));
		await useTabsStore.getState().switchTab("t1");
		await useTabsStore.getState().switchTab("t0");

		const restoredCalls = useMessagesStore
			.getState()
			.messages.flatMap(message =>
				message.role === "assistant" && Array.isArray(message.content)
					? message.content.filter((block): block is ToolCallContent => block.type === "toolCall")
					: [],
			);
		const restoredHistoricalCall = restoredCalls.find(call => call.arguments.path === "/history");
		const restoredLiveCall = restoredCalls.find(call => call.arguments.path === "/live");
		expect(restoredHistoricalCall).toEqual(historicalCall);
		expect(restoredHistoricalCall).not.toBe(historicalCall);
		expect(restoredLiveCall).toEqual(liveCall);
		expect(restoredLiveCall).not.toBe(liveCall);

		const restoredTools = useToolsStore.getState();
		const restoredHistorical = resolveMainToolCall(restoredHistoricalCall!);
		const restoredLive = resolveMainToolCall(restoredLiveCall!);
		expect(restoredTools.streamGeneration).toBe(1);
		expect(restoredTools.activeTools).toHaveLength(2);
		expect(restoredHistorical.entry).toMatchObject({
			args: { path: "/history" },
			status: "done",
			streamGeneration: 0,
			result: {
				content: [{ type: "text", text: "historical output" }],
				details: null,
			},
		});
		expect(restoredHistorical.entry?.streamGeneration).not.toBe(restoredTools.streamGeneration);
		expect(restoredLive.entry).toMatchObject({
			args: { path: "/live" },
			status: "pending",
			streamGeneration: 1,
		});
		expect(restoredHistorical.key).not.toBe(restoredLive.key);

		useToolsStore.getState().applyEvents([
			{
				type: "tool_execution_start",
				toolCallId: restoredLiveCall!.id,
				toolName: restoredLiveCall!.name,
				args: restoredLiveCall!.arguments,
			},
			{
				type: "tool_execution_update",
				toolCallId: restoredLiveCall!.id,
				toolName: restoredLiveCall!.name,
				args: restoredLiveCall!.arguments,
				partialResult: { bytes: 12 },
			},
			{
				type: "tool_execution_end",
				toolCallId: restoredLiveCall!.id,
				toolName: restoredLiveCall!.name,
				result: "live final output",
				isError: false,
			},
		]);
		const settledAfterRestore = useToolsStore.getState();
		const settledHistorical = resolveMainToolCall(restoredHistoricalCall!);
		const settledLive = resolveMainToolCall(restoredLiveCall!);

		expect(settledAfterRestore.streamGeneration).toBe(1);
		expect(settledAfterRestore.activeTools).toHaveLength(2);
		expect(settledHistorical.key).toBe(restoredHistorical.key);
		expect(settledHistorical.entry).toMatchObject({
			args: { path: "/history" },
			status: "done",
			partialResult: null,
			streamGeneration: 0,
			result: {
				content: [{ type: "text", text: "historical output" }],
				details: null,
			},
		});
		expect(settledLive.key).toBe(restoredLive.key);
		expect(settledLive.entry).toMatchObject({
			args: { path: "/live" },
			status: "done",
			partialResult: { bytes: 12 },
			result: "live final output",
			streamGeneration: 1,
		});
	});

	it("isolates transcript tool-call ownership across tab switches with reused ids", async () => {
		seedTabs();
		const sessionAParent: SubagentSnapshot = {
			id: "reused-parent",
			index: 1,
			agent: "worker",
			status: "running",
			lastUpdate: 1,
			kind: "sub",
		};
		useSubagentsStore.getState().setSnapshots([sessionAParent]);
		useSubagentsStore.getState().registerToolCallOwners(sessionAParent.id, ["provider-call:0"]);

		const firstGate = Promise.withResolvers<RpcResponse>();
		omp.rpc.getMessages.mockReturnValueOnce(firstGate.promise);
		const switchToB = useTabsStore.getState().switchTab("t1");

		expect(useSubagentsStore.getState().toolCallOwners.size).toBe(0);
		const sessionBParent: SubagentSnapshot = { ...sessionAParent, lastUpdate: 2 };
		const sessionBChild: SubagentSnapshot = {
			id: "session-b-child",
			index: 2,
			agent: "worker",
			status: "running",
			lastUpdate: 2,
			kind: "sub",
			parentToolCallId: "provider-call:0",
		};
		useSubagentsStore.getState().setSnapshots([sessionBParent, sessionBChild]);
		const sessionBRows = buildSubagentList(
			[sessionBParent, sessionBChild],
			new Set<string>(),
			useSubagentsStore.getState().toolCallOwners,
		);
		expect(sessionBRows.find(row => row.agent.id === sessionBChild.id)?.depth).toBe(0);

		firstGate.resolve(ok({ messages: [] }));
		await switchToB;
		useSubagentsStore.getState().setSnapshots([sessionBParent, sessionBChild]);

		const secondGate = Promise.withResolvers<RpcResponse>();
		omp.rpc.getMessages.mockReturnValueOnce(secondGate.promise);
		const switchBack = useTabsStore.getState().switchTab("t0");

		expect(useSubagentsStore.getState().toolCallOwners).toEqual(new Map([["provider-call:0", sessionAParent.id]]));
		secondGate.resolve(ok({ messages: [] }));
		await switchBack;
	});

	it("settles an approval in its background tab without mutating the visible session", async () => {
		seedTabs();
		fillLiveStores("t0");
		const proposal = usePlanApprovalStore.getState().pending;
		expect(proposal).not.toBeNull();

		await useTabsStore.getState().switchTab("t1");
		fillLiveStores("t1");
		settleTabPlanApproval("t0", "s-t0", proposal!, { clear: true, exitPlanMode: true });

		expect(useSessionStore.getState().sessionId).toBe("s-t1");
		expect(useSessionStore.getState().planModeEnabled).toBe(true);
		expect(usePlanApprovalStore.getState().pending?.planContent).toBe("plan-t1");

		await useTabsStore.getState().switchTab("t0");
		expect(useSessionStore.getState().planModeEnabled).toBe(false);
		expect(usePlanApprovalStore.getState().pending).toBeNull();
	});

	it("restores a failed submit to its background tab without touching the visible composer", async () => {
		seedTabs();
		fillLiveStores("t0");
		await useTabsStore.getState().switchTab("t1");
		useComposerStore.getState().setDraft("visible-t1");

		restoreTabComposer("t0", "replaced-session", "stale-submit", []);
		restoreTabComposer("t0", "s-t0", "failed-t0", [
			{ content: { type: "image", data: "failed-image", mimeType: "image/png" }, preview: "failed-preview" },
		]);

		expect(useComposerStore.getState().draft).toBe("visible-t1");
		expect(useComposerStore.getState().images).toEqual([]);

		await useTabsStore.getState().switchTab("t0");
		expect(useComposerStore.getState().draft).toBe("failed-t0\ndraft-t0");
		expect(useComposerStore.getState().images.map(image => image.content.data)).toEqual(["failed-image", "image-t0"]);
	});

	it("derives run state from the tab entry when restoring a background-running tab", async () => {
		seedTabs();
		// t1's run kept going in the background; the pool reported it.
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "running" });

		// Gate the hydrate so the restored (pre-hydrate) state is observable.
		const gate = Promise.withResolvers<RpcResponse>();
		omp.rpc.getMessages.mockReturnValueOnce(gate.promise);
		const switching = useTabsStore.getState().switchTab("t1");

		// Restore paints the run live before hydrate's get_state confirms it.
		expect(useSessionStore.getState().isStreaming).toBe(true);
		expect(useSessionStore.getState().status).toBe("ready");

		gate.resolve(ok({ messages: [] }));
		await switching;
		// Hydrate's get_state (mock: not streaming) is authoritative afterwards.
		expect(useSessionStore.getState().isStreaming).toBe(false);
	});

	it("stamps the outgoing tab's chip when it was streaming in the foreground", async () => {
		seedTabs();
		useSessionStore.setState({ isStreaming: true });

		await useTabsStore.getState().switchTab("t1");

		const t0 = useTabsStore.getState().tabs.find(tab => tab.id === "t0");
		expect(t0?.status).toBe("running");
	});

	it("surfaces a SET_ACTIVE_TAB failure, re-converges from GET_TABS, and hydrates after the retry", async () => {
		seedTabs();
		useToastStore.setState({ toasts: [] });
		omp.tabs.setActive.mockRejectedValueOnce(new Error("routing wedged"));
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), tabInfo("t1", "/beta"), tabInfo("t2", "/gamma")]);

		await useTabsStore.getState().switchTab("t1");

		// Surfaced, not swallowed…
		expect(useToastStore.getState().toasts.some(toast => toast.title === "Could not switch tab")).toBe(true);
		// …re-converged from GET_TABS — reconcile retries SET_ACTIVE_TAB for the
		// renderer's pick, so a transient failure re-points routing here…
		expect(omp.tabs.list).toHaveBeenCalled();
		expect(omp.tabs.setActive).toHaveBeenCalledTimes(2);
		// …then hydrate paints the target instead of leaving the restored empty
		// bundle on screen after the successful retry.
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
	});

	it("treats a false SET_ACTIVE_TAB reply as a routing failure and recovers on retry", async () => {
		seedTabs();
		useToastStore.setState({ toasts: [] });
		omp.tabs.setActive.mockResolvedValueOnce(false);
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), tabInfo("t1", "/beta"), tabInfo("t2", "/gamma")]);

		await useTabsStore.getState().switchTab("t1");

		expect(useToastStore.getState().toasts.some(toast => toast.title === "Could not switch tab")).toBe(true);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
	});

	it("does not hydrate when both the tab route and reconciliation route fail", async () => {
		seedTabs();
		omp.tabs.setActive.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), tabInfo("t1", "/beta"), tabInfo("t2", "/gamma")]);

		await useTabsStore.getState().switchTab("t1");

		expect(omp.rpc.getMessages).not.toHaveBeenCalled();
	});
	it("captures only agent target identity and reloads its projection after route hydration", async () => {
		seedTabs();
		const agent: SubagentSnapshot = {
			id: "agent-t0",
			index: 1,
			agent: "worker",
			status: "running",
			sessionFile: "/sessions/agent-t0.jsonl",
			lastUpdate: 1,
			kind: "sub",
		};
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: agent.id });
		useAgentViewStore.getState().applyFrame({
			type: "subagent_event",
			payload: { id: agent.id, event: { type: "message_end", message: msg("private transcript bytes") } },
		});

		await useTabsStore.getState().switchTab("t1");

		const parked = useTabsStore.getState().bundles.get("t0");
		expect(parked?.agentViewTarget).toEqual({ kind: "subagent", id: agent.id });
		expect(JSON.stringify(parked)).not.toContain("private transcript bytes");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });

		omp.rpc.getSubagents.mockResolvedValue(ok({ subagents: [agent] }));
		omp.rpc.getSubagentMessages.mockResolvedValue(
			ok({ messages: [msg("authoritative agent transcript")], nextByte: 12, hasMore: false }),
		);
		const hydrateGate = Promise.withResolvers<RpcResponse>();
		omp.rpc.getMessages.mockReturnValueOnce(hydrateGate.promise);
		const switchingBack = useTabsStore.getState().switchTab("t0");

		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: agent.id });
		expect(useAgentViewStore.getState().messages.messages).toEqual([]);
		hydrateGate.resolve(ok({ messages: [] }));
		await switchingBack;

		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledWith(agent.id, "/sessions/agent-t0.jsonl", 0);
		expect(useAgentViewStore.getState().messages.messages).toEqual([msg("authoritative agent transcript")]);
	});

	it("reloads a restored agent target after reconciliation recovers a failed route", async () => {
		seedTabs();
		const agent: SubagentSnapshot = {
			id: "agent-t0",
			index: 1,
			agent: "worker",
			status: "running",
			sessionFile: "/sessions/recovered.jsonl",
			lastUpdate: 1,
			kind: "sub",
		};
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: agent.id });
		await useTabsStore.getState().switchTab("t1");
		omp.tabs.setActive.mockRejectedValueOnce(new Error("route failed"));
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), tabInfo("t1", "/beta"), tabInfo("t2", "/gamma")]);
		omp.rpc.getSubagents.mockResolvedValue(ok({ subagents: [agent] }));
		omp.rpc.getSubagentMessages.mockResolvedValue(
			ok({ messages: [msg("recovered route transcript")], nextByte: 8, hasMore: false }),
		);

		await useTabsStore.getState().switchTab("t0");

		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledWith(agent.id, "/sessions/recovered.jsonl", 0);
		expect(useAgentViewStore.getState().messages.messages).toEqual([msg("recovered route transcript")]);
	});

	it("invalidates an in-flight selected-agent page when switching tabs", async () => {
		seedTabs();
		const selected: SubagentSnapshot = {
			id: "agent-t0",
			index: 1,
			agent: "worker",
			status: "running",
			sessionFile: "/sessions/agent-t0.jsonl",
			lastUpdate: 1,
			kind: "sub",
		};
		const stalePage = Promise.withResolvers<RpcResponse>();
		omp.rpc.getSubagentMessages.mockReturnValue(stalePage.promise);
		const loading = useAgentViewStore.getState().selectSubagent(selected);

		await useTabsStore.getState().switchTab("t1");
		stalePage.resolve(ok({ messages: [msg("stale t0 projection")], nextByte: 10, hasMore: false }));
		await loading;

		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(useAgentViewStore.getState().messages.messages).toEqual([]);
	});

	it("uses the same routed roster and transcript RPCs when restoring a selected target on an SSH tab", async () => {
		seedTabs("t1");
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, target: sshTarget("/srv/remote") } : tab)),
		}));
		const selected: SubagentSnapshot = {
			id: "remote-agent",
			index: 1,
			agent: "worker",
			status: "running",
			sessionFile: "/remote/sessions/agent.jsonl",
			lastUpdate: 1,
			kind: "sub",
		};
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		await useTabsStore.getState().switchTab("t0");
		omp.rpc.getSubagents.mockResolvedValue(ok({ subagents: [selected] }));
		omp.rpc.getSubagentMessages.mockResolvedValue(
			ok({ messages: [msg("remote transcript")], nextByte: 12, hasMore: false }),
		);
		omp.rpc.getSubagents.mockClear();
		omp.rpc.getSubagentMessages.mockClear();

		await useTabsStore.getState().switchTab("t1");

		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.target).toEqual(sshTarget("/srv/remote"));
		expect(omp.tabs.setActive).toHaveBeenLastCalledWith("t1");
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledWith(selected.id, selected.sessionFile, 0);
		expect(useAgentViewStore.getState().messages.messages).toEqual([msg("remote transcript")]);
	});
	it("rejects an old A recovery across an A-to-B-to-A route cycle", async () => {
		seedTabs();
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, status: "starting" } : tab)),
		}));
		const staleA = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState
			.mockReturnValueOnce(staleA.promise)
			.mockResolvedValue(ok(serverState({ sessionId: "fresh-a", cwd: "/fresh-a" })));

		const oldRecovery = recoverReadySession("t0");
		await useTabsStore.getState().switchTab("t1");
		const switchingBack = useTabsStore.getState().switchTab("t0");
		await Promise.resolve();
		staleA.resolve(ok(serverState({ sessionId: "stale-a", cwd: "/stale-a" })));
		await Promise.all([oldRecovery, switchingBack]);

		expect(omp.rpc.getState).toHaveBeenCalledTimes(2);
		expect(useSessionStore.getState().sessionId).toBe("fresh-a");
		expect(useSessionStore.getState().cwd).toBe("/fresh-a");
	});

	it("rejects a delayed roster poll after switching to a newer tab roster", async () => {
		seedTabs();
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, status: "starting" } : tab)),
		}));
		const delayed = Promise.withResolvers<RpcResponse>();
		omp.rpc.getSubagents.mockReturnValue(delayed.promise);
		const polling = useSubagentsStore.getState().refresh();

		await useTabsStore.getState().switchTab("t1");
		const selected: SubagentSnapshot = {
			id: "agent-t1",
			index: 1,
			agent: "worker",
			agentSource: "bundled",
			status: "running",
			sessionFile: "/sessions/agent-t1.jsonl",
			lastUpdate: 1,
			kind: "sub",
		};
		useSubagentsStore.getState().applyFrame({
			type: "subagent_lifecycle",
			payload: {
				id: selected.id,
				index: selected.index,
				agent: selected.agent,
				agentSource: "bundled",
				status: "started",
				sessionFile: selected.sessionFile,
			},
		});
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		delayed.resolve(ok({ subagents: [] }));
		await polling;

		expect(useSubagentsStore.getState().subagents.has(selected.id)).toBe(true);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: selected.id });
	});

	it("rejects a delayed queue refresh after switching to a starting tab", async () => {
		seedTabs();
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, status: "starting" } : tab)),
		}));
		const delayedQueue = Promise.withResolvers<RpcResponse>();
		omp.rpc.getQueue.mockReturnValue(delayedQueue.promise);
		const oldRecovery = recoverReadySession("t0");

		await useTabsStore.getState().switchTab("t1");
		delayedQueue.resolve(
			ok({
				steering: [{ id: "stale-a", text: "old route", editable: true, timestamp: 1 }],
				followUp: [],
			}),
		);
		await oldRecovery;

		expect(useQueueStore.getState().steering).toEqual([]);
		expect(useQueueStore.getState().followUp).toEqual([]);
	});
});

describe("tabs store close", () => {
	it("keeps the last tab open", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);
		await useTabsStore.getState().reconcileTabs();

		await useTabsStore.getState().closeTab("t0");

		expect(useTabsStore.getState().tabs).toHaveLength(1);
		expect(omp.tabs.close).not.toHaveBeenCalled();
	});

	it("closing the active tab activates its right neighbor first, then releases", async () => {
		seedTabs("t1");

		await useTabsStore.getState().closeTab("t1");

		const state = useTabsStore.getState();
		expect(state.tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		expect(state.activeTabId).toBe("t2");
		// Neighbor was activated BEFORE the release hit main.
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t2");
		expect(omp.tabs.close).toHaveBeenCalledWith("t1");
		const setActiveOrder = omp.tabs.setActive.mock.invocationCallOrder[0];
		const closeOrder = omp.tabs.close.mock.invocationCallOrder[0];
		expect(setActiveOrder!).toBeLessThan(closeOrder!);
		// The closed tab's parked bundle is gone.
		expect(state.bundles.has("t1")).toBe(false);
	});

	it("closing the last tab in the strip activates its left neighbor", async () => {
		seedTabs("t2");

		await useTabsStore.getState().closeTab("t2");

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t1"]);
		expect(useTabsStore.getState().activeTabId).toBe("t1");
	});

	it("closing a background tab leaves the active tab attached", async () => {
		seedTabs("t0");

		await useTabsStore.getState().closeTab("t1");

		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0", "t2"]);
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		expect(omp.tabs.setActive).not.toHaveBeenCalled();
		expect(omp.tabs.close).toHaveBeenCalledWith("t1");
	});
});

describe("tabs store applyTabStatus", () => {
	it("sets unreadDone when a background run settles, cleared on visit", async () => {
		seedTabs();

		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "running" });
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.unreadDone).toBe(false);

		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.unreadDone).toBe(true);

		await useTabsStore.getState().switchTab("t1");
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.unreadDone).toBe(false);
	});

	it("does not badge the active tab's own run settling", () => {
		seedTabs();
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "running" });
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t0")?.unreadDone).toBe(false);
	});

	it("mirrors only the active tab's keyed connection status into the composer", () => {
		seedTabs();
		useSessionStore.setState({ status: "starting", cwd: "" });

		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		expect(useSessionStore.getState().status).toBe("ready");
		expect(useSessionStore.getState().cwd).toBe("/alpha");

		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "exited" });
		expect(useSessionStore.getState().status).toBe("ready");
		expect(useSessionStore.getState().cwd).toBe("/alpha");
	});

	it("upserts unknown tabs and preserves title/sessionId across pushes", () => {
		seedTabs();
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t9", cwd: "/new", target: { type: "local" }, status: "starting" });
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toContain("t9");

		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t1",
			cwd: "/beta",
			target: { type: "local" },
			status: "ready",
			title: "Beta",
			sessionId: "s9",
		});
		useTabsStore
			.getState()
			.applyTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		const t1 = useTabsStore.getState().tabs.find(tab => tab.id === "t1");
		expect(t1?.title).toBe("Beta");
		expect(t1?.sessionId).toBe("s9");
	});

	it("clears a stale transcript path when main reports a fresh unsaved session", () => {
		seedTabs();
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			target: { type: "local" },
			status: "ready",
			sessionPath: "/sessions/old.jsonl",
		});
		expect(useTabsStore.getState().tabs[0]?.sessionPath).toBe("/sessions/old.jsonl");

		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			target: { type: "local" },
			status: "ready",
			sessionPath: null,
		});
		expect(useTabsStore.getState().tabs[0]?.sessionPath).toBeUndefined();
	});

	it("retains an established SSH target through status merges", () => {
		seedTabs();
		const target = sshTarget();
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "t1" ? { ...tab, cwd: target.cwd, target } : tab)),
		}));

		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t1",
			cwd: "/srv/status",
			target: { type: "local" },
			status: "running",
			title: "Remote run",
		});

		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")).toMatchObject({
			cwd: "/srv/status",
			title: "Remote run",
			target,
		});
	});

	it("defaults an unknown status snapshot with no target to local", () => {
		seedTabs();

		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "legacy-status",
			cwd: "/legacy",
			status: "ready",
		} as IpcTabStatusPayload);

		expect(useTabsStore.getState().tabs.find(tab => tab.id === "legacy-status")?.target).toEqual({ type: "local" });
	});

	it("drops a parked bundle when the sidecar replaces its session", async () => {
		seedTabs();
		fillLiveStores("old");
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/old",
			target: { type: "local" },
			status: "ready",
			title: "Old title",
			sessionId: "s-old",
		});
		await useTabsStore.getState().switchTab("t1");
		expect(useTabsStore.getState().bundles.has("t0")).toBe(true);

		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/old",
			target: { type: "local" },
			status: "ready",
			title: null,
			sessionId: "s-new",
		});

		const tab = useTabsStore.getState().tabs.find(entry => entry.id === "t0");
		expect(tab?.title).toBeUndefined();
		expect(tab?.sessionId).toBe("s-new");
		expect(useTabsStore.getState().bundles.has("t0")).toBe(false);
		omp.rpc.getState.mockResolvedValue(ok(serverState({ sessionId: "s-new", cwd: "/old" })));

		await useTabsStore.getState().switchTab("t0");
		expect(useComposerStore.getState().draft).toBe("");
		expect(useMessagesStore.getState().messages).toEqual([]);
		expect(usePlanApprovalStore.getState().pending).toBeNull();
	});
	it("returns the active view to Main when a status push replaces its session", () => {
		seedTabs();
		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			target: { type: "local" },
			status: "ready",
			sessionId: "s-old",
		});
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "old-agent" });
		const generation = useAgentViewStore.getState().generation;

		useTabsStore.getState().applyTabStatus({
			kind: "agent",
			tabId: "t0",
			cwd: "/alpha",
			target: { type: "local" },
			status: "ready",
			sessionId: "s-new",
		});

		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(useAgentViewStore.getState().generation).toBe(generation + 1);
	});
});

describe("tabs store reset", () => {
	it("returns the view to Main and invalidates its generation", () => {
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "old-agent" });
		const generation = useAgentViewStore.getState().generation;

		useTabsStore.getState().reset();

		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(useAgentViewStore.getState().generation).toBe(generation + 1);
	});
});
describe("useSessionTabs hook", () => {
	let container: { remove(): void };
	let root: Root;

	async function mount(): Promise<void> {
		const element = document.createElement("div") as unknown as { remove(): void };
		container = element;
		document.body.appendChild(element as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(<Probe />);
		});
	}

	function Probe(): null {
		useSessionTabs();
		return null;
	}

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root.unmount();
			});
		}
		container?.remove();
	});

	it("reconciles on mount and subscribes to TAB_STATUS", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha")]);

		await mount();

		expect(omp.tabs.list).toHaveBeenCalled();
		expect(omp.events.onTabStatus).toHaveBeenCalled();
		expect(useTabsStore.getState().tabs.map(tab => tab.id)).toEqual(["t0"]);
		expect(useTabsStore.getState().activeTabId).toBe("t0");
	});

	it("hydrates the restored active tab when it was ready before renderer subscriptions", async () => {
		omp.tabs.list.mockResolvedValue([tabInfo("t0", "/alpha"), { ...tabInfo("t1", "/beta"), active: true }]);
		omp.rpc.getState.mockResolvedValue(ok(serverState({ sessionId: "restored", cwd: "/beta" })));

		await mount();
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(useSessionStore.getState()).toMatchObject({ sessionId: "restored", cwd: "/beta", status: "ready" });
		expect(omp.rpc.getMessages).toHaveBeenCalled();
	});

	it("hydrates an active fresh tab when ready only arrives on the light channel", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "chat", id: "t1", cwd: "/beta", target: { type: "local" }, status: "starting", unreadDone: false },
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		useSessionStore.setState({ status: "starting" });
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "chat", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		});
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		expect(useSessionStore.getState().status).toBe("ready");
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(omp.rpc.getMessages).toHaveBeenCalled();
	});

	it("reloads a restored agent target after delayed ready-time hydration", async () => {
		const agent: SubagentSnapshot = {
			id: "agent-t1",
			index: 1,
			agent: "worker",
			status: "running",
			sessionFile: "/sessions/agent-t1.jsonl",
			lastUpdate: 1,
			kind: "sub",
		};
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t1", cwd: "/beta", target: { type: "local" }, status: "starting", unreadDone: false },
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: agent.id });
		useSessionStore.setState({ status: "starting" });
		omp.rpc.getSubagents.mockResolvedValue(ok({ subagents: [agent] }));
		omp.rpc.getSubagentMessages.mockResolvedValue(
			ok({ messages: [msg("ready-time agent transcript")], nextByte: 12, hasMore: false }),
		);
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		});
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledWith(agent.id, agent.sessionFile, 0);
		expect(useAgentViewStore.getState().messages.messages).toEqual([msg("ready-time agent transcript")]);
	});
	it("waits for authoritative ready hydration before reloading a restored target with cached session state", async () => {
		const agent: SubagentSnapshot = {
			id: "agent-t1",
			index: 1,
			agent: "worker",
			status: "running",
			sessionFile: "/sessions/agent-t1.jsonl",
			lastUpdate: 1,
			kind: "sub",
		};
		const roster = Promise.withResolvers<RpcResponse>();
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t1", cwd: "/beta", target: { type: "local" }, status: "starting", unreadDone: false },
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: agent.id });
		useSessionStore.setState({ status: "starting", sessionId: "cached-session" });
		omp.rpc.getSubagents.mockReturnValue(roster.promise);
		omp.rpc.getSubagentMessages.mockResolvedValue(
			ok({ messages: [msg("full-ready agent transcript")], nextByte: 12, hasMore: false }),
		);
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		});
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
		expect(omp.rpc.getSubagentMessages).not.toHaveBeenCalled();
		roster.resolve(ok({ subagents: [agent] }));
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledWith(agent.id, agent.sessionFile, 0);
		expect(useAgentViewStore.getState().messages.messages).toEqual([msg("full-ready agent transcript")]);
	});
	it("applies a tab's pending session path on its first ready push while active", async () => {
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t1",
					cwd: "/beta",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/s.json",
				},
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "old-session-agent" });
		const generation = useAgentViewStore.getState().generation;
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		});
		// The switch + hydrate run in a trailing microtask chain.
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/s.json");
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(useAgentViewStore.getState().generation).toBe(generation + 1);

		// A duplicate ready push must not re-enter the flow.
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		});
		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
	});
	it("does not route a delayed pending-session switch into a newly active tab", async () => {
		vi.useFakeTimers();
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready", unreadDone: false },
				{
					kind: "agent",
					id: "t1",
					cwd: "/beta",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/s.json",
				},
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		const pendingState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState
			.mockReturnValueOnce(pendingState.promise)
			.mockResolvedValue(ok(serverState({ sessionId: "tab-zero", cwd: "/alpha" })));
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		});
		await act(async () => {
			await vi.runAllTimersAsync();
		});
		await useTabsStore.getState().switchTab("t0");
		pendingState.resolve(ok(serverState({ sessionId: "tab-one", sessionFile: null, cwd: "/beta" })));
		await act(async () => {
			await Promise.resolve();
		});

		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.pendingSessionPath).toBe("/s.json");
		expect(useTabsStore.getState().activeTabId).toBe("t0");
	});

	it("skips the ready-time switchSession when the sidecar is already on the pending session", async () => {
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t1",
					cwd: "/beta",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/s.json",
				},
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		// Spawned WITH --session /s.json: get_state already reports that file,
		// so a second switch would only abort the in-flight resume.
		omp.rpc.getState.mockResolvedValue(ok(serverState({ sessionFile: "/s.json" })));
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		});
		// The gate + hydrate run in a trailing microtask chain.
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		// No redundant switch — but the transcript still hydrates and the
		// pending path is consumed.
		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		expect(omp.rpc.getMessages).toHaveBeenCalled();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("does not switch the session for a background tab's pending path", async () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready", unreadDone: false },
				{
					kind: "agent",
					id: "t1",
					cwd: "/beta",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/s.json",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		await mount();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		});

		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		// Pending path survives for when the user actually switches to t1.
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t1")?.pendingSessionPath).toBe("/s.json");
	});

	it("coalesces a route-time ready push with post-route hydration", async () => {
		seedTabs();
		await mount();
		const route = Promise.withResolvers<boolean>();
		omp.tabs.setActive.mockReset();
		omp.tabs.setActive.mockReturnValue(route.promise);
		omp.rpc.setSubagentSubscription.mockClear();
		omp.rpc.getMessages.mockClear();
		omp.rpc.getSubagents.mockClear();

		const switching = useTabsStore.getState().switchTab("t1");
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
			route.resolve(true);
			await switching;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});

		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
	});

	it("subscribes subagent frames on a tab's ready only while it is active (F-HYDRATE)", async () => {
		seedTabs();
		// Ready recovery is transition-driven: a duplicate ready for an already
		// hydrated session is intentionally a no-op. Model real connection-ready
		// transitions for both the background and active tabs.
		useTabsStore.setState(current => ({
			tabs: current.tabs.map(tab => (tab.id === "t0" || tab.id === "t1" ? { ...tab, status: "starting" } : tab)),
		}));
		useSessionStore.setState({ sessionId: "active" });
		await mount();

		// Background ready: renderer RPC routes through the ACTIVE tab, so a
		// background tab's ready must NOT fire the command (it would land on
		// the wrong sidecar). hydrateSession re-asserts on switch-in instead.
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "ready" });
		});
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();

		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledWith("events");
	});
});

describe("tabChipLabel (F-HYDRATE)", () => {
	function chip(id: string, cwd: string, title?: string): SessionTab {
		const tab: SessionTab = { id, cwd, target: { type: "local" }, status: "ready", kind: "agent", unreadDone: false };
		if (title !== undefined) tab.title = title;
		return tab;
	}

	function remoteChip(
		id: string,
		cwd: string,
		title?: string,
		os: NonNullable<SshSessionTarget["host"]["os"]> = "linux",
	): SessionTab {
		const target = sshTarget(cwd);
		target.host.os = os;
		const tab: SessionTab = { id, cwd, target, status: "ready", kind: "agent", unreadDone: false };
		if (title !== undefined) tab.title = title;
		return tab;
	}

	it("prefers the session title, then the cwd basename, then the new-session label", () => {
		expect(tabChipLabel(chip("t0", "/work/alpha", "Alpha plan"), [])).toBe("Alpha plan");
		expect(tabChipLabel(chip("t1", "/work/beta"), [])).toBe("beta");
		expect(tabChipLabel(chip("t2", ""), [])).toBe("New session");
		// Empty-string titles (never-generated auto-title slot) fall through too.
		expect(tabChipLabel(chip("t3", "/work/gamma", ""), [])).toBe("gamma");
	});

	it("keeps an untitled global chat unnamed instead of exposing its internal cwd as a workspace", () => {
		const chat = { ...chip("chat-0", "/Users/tester"), kind: "chat" as const };
		expect(tabChipLabel(chat, [chat])).toBe("New session");
	});

	it("suffixes identical untitled labels in tab order, first occurrence bare", () => {
		const tabs = [chip("t0", "/work/gui"), chip("t1", "/other/gui"), chip("t2", "/tmp/gui")];
		expect(tabs.map(tab => tabChipLabel(tab, tabs))).toEqual(["gui", "gui #2", "gui #3"]);
		// Distinct basenames never collide, even beside a suffixed group.
		const mixed = [chip("t0", "/work/gui"), chip("t1", "/work/beta"), chip("t2", "/other/gui")];
		expect(mixed.map(tab => tabChipLabel(tab, mixed))).toEqual(["gui", "beta", "gui #2"]);
	});

	it("never suffixes titled tabs — a title is itself the disambiguator", () => {
		const tabs = [chip("t0", "/work/gui"), chip("t1", "/other/gui", "Release plan")];
		// The titled tab left the collision set, so the untitled one stays bare.
		expect(tabs.map(tab => tabChipLabel(tab, tabs))).toEqual(["gui", "Release plan"]);
	});

	it("qualifies untitled SSH tabs by host while a hydrated title wins", () => {
		const untitled = remoteChip("ssh-0", "/srv/app");
		expect(tabChipLabel(untitled, [untitled])).toBe("build:app");

		const titled = remoteChip("ssh-1", "/srv/app", "Deploy release");
		expect(tabChipLabel(titled, [titled])).toBe("Deploy release");
	});

	it("derives remote basenames across platform separators and suffixes only true collisions", () => {
		const linux = remoteChip("ssh-0", "/srv/app/");
		const windows = remoteChip("ssh-1", "C:\\work\\app\\", undefined, "windows");
		const prodTarget = sshTarget("/srv/app");
		prodTarget.hostAlias = "prod";
		const distinctHost: SessionTab = {
			id: "ssh-2",
			cwd: "/srv/app",
			target: prodTarget,
			status: "ready",
			kind: "agent",
			unreadDone: false,
		};
		const tabs = [linux, windows, distinctHost];

		expect(tabs.map(tab => tabChipLabel(tab, tabs))).toEqual(["build:app", "build:app #2", "prod:app"]);
	});

	it("sanitizes control and bidi formatting characters in remote label components", () => {
		const tab = remoteChip("ssh-safe", "/srv/\u202eap\u0000p");
		if (tab.target.type !== "ssh") throw new Error("expected SSH test target");
		tab.target.hostAlias = "bu\u001b\u202eild";

		expect(tabChipLabel(tab, [tab])).toBe("bu ild:ap p");
		expect(tabChipLabel(tab, [tab])).not.toMatch(/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
	});

	it("caps each remote label component before collision suffix calculation", () => {
		const alias = "a".repeat(100);
		const directory = "b".repeat(100);
		const first = remoteChip("ssh-long-1", `/srv/${directory}`);
		const second = remoteChip("ssh-long-2", `C:\\work\\${directory}`, undefined, "windows");
		for (const tab of [first, second]) {
			if (tab.target.type !== "ssh") throw new Error("expected SSH test target");
			tab.target.hostAlias = alias;
		}

		const capped = `${"a".repeat(63)}…:${"b".repeat(63)}…`;
		expect(tabChipLabel(first, [first, second])).toBe(capped);
		expect(tabChipLabel(second, [first, second])).toBe(`${capped} #2`);
	});
});

function messageText(message: AgentMessage): string {
	const content = message.content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("");
}
