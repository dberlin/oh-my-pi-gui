/**
 * switchSessionNow F-OWN owner-guard contract tests: a session already
 * attached to a tab routes to the owner (switch in-window / focus the foreign
 * window) instead of double-attaching; main's raced refusal
 * (session_owned_elsewhere) routes via the error payload; ordinary failures
 * still toast.
 *
 * Harness: linkedom globals (hydrateSession's store graph expects them) +
 * a mocked window.omp, same shape as tabs.test.tsx.
 */

import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSessionOwner, SessionInfo } from "../../shared/ipc-types";
import type { RpcResponse, RpcSessionState } from "../../shared/rpc-types";
import { useComposerStore } from "../stores/composer";
import { useMessagesStore } from "../stores/messages";
import { useModelStore } from "../stores/model";
import { useQueueStore } from "../stores/queue";
import { useSessionStore } from "../stores/session";
import { useSubagentsStore } from "../stores/subagents";
import { useTabsStore } from "../stores/tabs";
import { useToastStore } from "../stores/toast";
import { useTodoStore } from "../stores/todo";
import { useToolsStore } from "../stores/tools";
import { switchSessionNow } from "./use-session-switch";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

function serverState(overrides: Partial<RpcSessionState> = {}): RpcSessionState {
	return {
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
		...overrides,
	} as RpcSessionState;
}

function session(path: string): SessionInfo {
	return {
		path,
		id: path,
		title: "Session X",
		cwd: "/srv",
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
		messageCount: 3,
		size: 100,
		status: "complete",
		firstMessage: "hello",
	};
}

interface MockOmp {
	tabs: {
		getSessionOwner: Mock<(sessionPath: string) => Promise<IpcSessionOwner | null>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
	};
	sessions: {
		openInNewWindow: Mock<(payload: { sessionPath?: string; cwd?: string }) => Promise<boolean>>;
	};
	rpc: {
		getState: Mock<() => Promise<RpcResponse>>;
		getTranscript: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		getGoal: Mock<() => Promise<RpcResponse>>;
		getLoopMode: Mock<() => Promise<RpcResponse>>;
		getVibeMode: Mock<() => Promise<RpcResponse>>;
		getQueue: Mock<() => Promise<RpcResponse>>;
		switchSession: Mock<(sessionPath: string) => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
	};
}

function installMockOmp(): MockOmp {
	const omp: MockOmp = {
		tabs: {
			getSessionOwner: vi.fn(async () => null),
			setActive: vi.fn(async () => true),
		},
		sessions: {
			openInNewWindow: vi.fn(async () => true),
		},
		rpc: {
			getState: vi.fn(async () => ok(serverState())),
			getTranscript: vi.fn(async () => ok({ messages: [] })),
			getSubagents: vi.fn(async () => ok({ subagents: [] })),
			getGoal: vi.fn(async () => ok({ enabled: false })),
			getLoopMode: vi.fn(async () => ok({ enabled: false, state: "off" })),
			getVibeMode: vi.fn(async () => ok({ enabled: false })),
			getQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
			switchSession: vi.fn(async () => ok({})),
			setSubagentSubscription: vi.fn(async () => ok({})),
		},
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
}

/** Two tabs: t0 active, t1 background. */
function seedTabs(): void {
	useTabsStore.setState({
		tabs: [
			{ id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
			{ id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
		],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

function resetAll(): void {
	useTabsStore.getState().reset();
	useComposerStore.getState().reset();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useTodoStore.getState().reset();
	useQueueStore.setState({ steering: [], followUp: [] });
	useSubagentsStore.getState().reset();
	useModelStore.getState().reset();
	useToolsStore.getState().reset();
	useToastStore.setState({ toasts: [] });
}

let omp: MockOmp;

afterEach(() => {
	resetAll();
	vi.restoreAllMocks();
	omp = installMockOmp();
});

omp = installMockOmp();

describe("switchSessionNow F-OWN owner guard", () => {
	it("routes to the owning tab in this window without issuing switch_session", async () => {
		seedTabs();
		omp.tabs.getSessionOwner.mockResolvedValue({ tabId: "t1", winId: 1 });

		const result = await switchSessionNow(session("/sessions/x.jsonl"));

		expect(result).toBe(true);
		expect(omp.tabs.getSessionOwner).toHaveBeenCalledWith("/sessions/x.jsonl");
		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		// Routed via switchTab: SET_ACTIVE_TAB fired and the tab is foreground.
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("focuses the foreign owner window instead of attaching", async () => {
		seedTabs();
		omp.tabs.getSessionOwner.mockResolvedValue({ tabId: "zz", winId: 9 });
		omp.sessions.openInNewWindow.mockResolvedValue(true);

		const result = await switchSessionNow(session("/sessions/x.jsonl"));

		expect(result).toBe(true);
		expect(omp.sessions.openInNewWindow).toHaveBeenCalledWith({ sessionPath: "/sessions/x.jsonl" });
		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		expect(omp.tabs.setActive).not.toHaveBeenCalled();
		expect(useTabsStore.getState().activeTabId).toBe("t0");
	});

	it("switches in place when no tab owns the session", async () => {
		seedTabs();
		omp.tabs.getSessionOwner.mockResolvedValue(null);

		const result = await switchSessionNow(session("/sessions/x.jsonl"));

		expect(result).toBe(true);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/sessions/x.jsonl");
		// The existing flow hydrated after the switch.
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(omp.tabs.setActive).not.toHaveBeenCalled();
	});

	it("routes a raced session_owned_elsewhere refusal to the payload owner", async () => {
		seedTabs();
		// Pre-check saw no owner, but a parallel attach won the race → main refuses.
		omp.tabs.getSessionOwner.mockResolvedValue(null);
		omp.rpc.switchSession.mockResolvedValue({
			type: "response",
			command: "switch_session",
			success: false,
			error: "Session is already open in another tab",
			code: "session_owned_elsewhere",
			data: { ownerTabId: "t1", ownerWinId: 1 },
		});

		const result = await switchSessionNow(session("/sessions/x.jsonl"));

		expect(result).toBe(true);
		expect(omp.tabs.setActive).toHaveBeenCalledWith("t1");
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		// The refusal is a routing signal, not a failure — no error toast.
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("ignores a failed owner pre-check and lets main be the backstop", async () => {
		seedTabs();
		omp.tabs.getSessionOwner.mockRejectedValue(new Error("ipc down"));

		const result = await switchSessionNow(session("/sessions/x.jsonl"));

		expect(result).toBe(true);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/sessions/x.jsonl");
	});

	it("keeps ordinary switch failures as error toasts", async () => {
		seedTabs();
		omp.rpc.switchSession.mockResolvedValue({
			type: "response",
			command: "switch_session",
			success: false,
			error: "boom",
		});

		const result = await switchSessionNow(session("/sessions/x.jsonl"));

		expect(result).toBe(false);
		expect(useToastStore.getState().toasts.some(toast => toast.variant === "error")).toBe(true);
	});
});
