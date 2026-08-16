/**
 * Contract tests for the pending-model indicator: the chat must show a live
 * "waiting for model response" row between turn_start and the first streamed
 * message, because a stalled provider request (slow first event, transport
 * retry) is otherwise indistinguishable from a dead UI. Covers the
 * useRpcEvents event wiring (which events arm/clear `awaitingModelSince`) and
 * the PendingModelRow elapsed-time rendering. Rendered with react-dom/client
 * into a linkedom document (same harness as ForkHandoffDialogs.test.tsx).
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSidecarStatusPayload, IpcTabInfo, IpcTabStatusPayload } from "../../shared/ipc-types";
import type {
	AgentMessage,
	AgentSessionEvent,
	CommandOutputFrame,
	ExtensionErrorFrame,
	ModelCatalogUpdateFrame,
	PromptResultFrame,
	RpcResponse,
	RpcSessionState,
	SessionInfoUpdateFrame,
	SubagentFrame,
	SubagentSnapshot,
	TodoPhase,
	ToolCallContent,
} from "../../shared/rpc-types";
import { TurnStatusRow } from "../components/chat/TranscriptViewport";
import { I18nProvider } from "../lib/i18n";
import { useAgentViewStore } from "../stores/agent-view";
import { useMessagesStore } from "../stores/messages";
import { useModelStore } from "../stores/model";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { useSubagentsStore } from "../stores/subagents";
import { useSessionTabs, useTabsStore } from "../stores/tabs";
import { useToastStore } from "../stores/toast";
import { useTodoStore } from "../stores/todo";
import { toolEntryKey, useToolsStore } from "../stores/tools";
import { hydrateSession, recoverReadySession, useRpcEvents } from "./use-rpc-events";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

interface TestElement {
	textContent: string | null;
	remove: () => void;
	appendChild: (child: TestElement) => void;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

function sessionState(): RpcSessionState {
	return {
		model: null,
		thinkingLevel: undefined,
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		sessionFile: null,
		cwd: "/tmp",
		sessionId: "s1",
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
	};
}
type BatchHandler = (events: AgentSessionEvent[]) => void;
type CommandOutputHandler = (frame: CommandOutputFrame) => void;
type PromptResultHandler = (frame: PromptResultFrame) => void;
type SidecarStatusHandler = (payload: IpcSidecarStatusPayload) => void;
type SubagentFrameHandler = (frame: SubagentFrame) => void;
type TabStatusHandler = (payload: IpcTabStatusPayload) => void;
type ModelCatalogUpdateHandler = (frame: ModelCatalogUpdateFrame) => void;
interface MockOmp {
	tabs: {
		list: Mock<() => Promise<IpcTabInfo[]>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
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
		getSettings: Mock<(keys: string[]) => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
		switchSession: Mock<(sessionPath: string) => Promise<RpcResponse>>;
	};
	events: {
		onBatch: Mock<(callback: BatchHandler) => () => void>;
		onSidecarStatus: Mock<(callback: SidecarStatusHandler) => () => void>;
		onSubagentFrame: Mock<(callback: SubagentFrameHandler) => () => void>;
		onTabStatus: Mock<(callback: TabStatusHandler) => () => void>;
		onModelCatalogUpdate: Mock<(callback: ModelCatalogUpdateHandler) => () => void>;
		onConfigUpdate: Mock<() => () => void>;
		onExtensionUi: Mock<() => () => void>;
		onPromptResult: Mock<(callback: PromptResultHandler) => () => void>;
		onCommandOutput: Mock<(callback: CommandOutputHandler) => () => void>;
		onSessionInfoUpdate: Mock<(callback: (frame: SessionInfoUpdateFrame) => void) => () => void>;
		onExtensionError: Mock<(callback: (frame: ExtensionErrorFrame) => void) => () => void>;
	};
	sidecar: { getStatus: Mock<() => Promise<unknown>> };
	sessions: { consumePendingOpen: Mock<() => Promise<unknown>> };
	system: { notify: Mock<(title: string, body: string) => void> };
	prefs: {
		get: Mock<(key: string) => Promise<unknown>>;
		set: Mock<(key: string, value: unknown) => Promise<void>>;
	};
}

function installMockOmp(): {
	omp: MockOmp;
	emitBatch: BatchHandler;
	emitCommandOutput: CommandOutputHandler;
	emitPromptResult: PromptResultHandler;
	emitSidecarStatus: SidecarStatusHandler;
	emitSubagentFrame: SubagentFrameHandler;
	emitTabStatus: TabStatusHandler;
	emitModelCatalogUpdate: ModelCatalogUpdateHandler;
} {
	let batchHandler: BatchHandler = () => {};
	let commandOutputHandler: CommandOutputHandler = () => {};
	let promptResultHandler: PromptResultHandler = () => {};
	let sidecarStatusHandler: SidecarStatusHandler = () => {};
	let subagentFrameHandler: SubagentFrameHandler = () => {};
	let tabStatusHandler: TabStatusHandler = () => {};
	let modelCatalogUpdateHandler: ModelCatalogUpdateHandler = () => {};
	// Mirror the real server: get_state reports isStreaming=true mid-run, and
	// agent_start triggers refreshSessionState — a static mock would overwrite
	// the event-set flag with stale state and test a race production never has.
	let mockStreaming = false;
	const omp: MockOmp = {
		tabs: {
			list: vi.fn(async () => []),
			setActive: vi.fn(async () => true),
		},
		rpc: {
			getState: vi.fn(async () =>
				success({
					sessionId: "s1",
					sessionName: null,
					sessionFile: null,
					cwd: "/tmp",
					isStreaming: mockStreaming,
					isCompacting: false,
					contextUsage: null,
					messageCount: 0,
					queuedMessageCount: 0,
					planModeEnabled: false,
					todoPhases: [],
				}),
			),
			getMessages: vi.fn(async () => success({ messages: [] })),
			getSubagents: vi.fn(async () => success({ subagents: [] })),
			getSubagentMessages: vi.fn(async () => success({ messages: [], nextByte: 0, hasMore: false })),
			getGoal: vi.fn(async () => success({ enabled: false })),
			getLoopMode: vi.fn(async () => success({ enabled: false, state: "off" })),
			getVibeMode: vi.fn(async () => success({ enabled: false })),
			getQueue: vi.fn(async () => success({ steering: [], followUp: [] })),
			getSettings: vi.fn(async () => success({ values: {} })),
			switchSession: vi.fn(async () => success({ cancelled: false })),
			setSubagentSubscription: vi.fn(async () => success({})),
		},
		events: {
			onBatch: vi.fn((callback: BatchHandler) => {
				batchHandler = callback;
				return () => {};
			}),
			onSidecarStatus: vi.fn((callback: SidecarStatusHandler) => {
				sidecarStatusHandler = callback;
				return () => {};
			}),
			onSubagentFrame: vi.fn((callback: SubagentFrameHandler) => {
				subagentFrameHandler = callback;
				return () => {};
			}),
			onTabStatus: vi.fn((callback: TabStatusHandler) => {
				tabStatusHandler = callback;
				return () => {};
			}),
			onModelCatalogUpdate: vi.fn((callback: ModelCatalogUpdateHandler) => {
				modelCatalogUpdateHandler = callback;
				return () => {};
			}),
			onConfigUpdate: vi.fn(() => () => {}),
			onExtensionUi: vi.fn(() => () => {}),
			onPromptResult: vi.fn((callback: PromptResultHandler) => {
				promptResultHandler = callback;
				return () => {};
			}),
			onCommandOutput: vi.fn((callback: CommandOutputHandler) => {
				commandOutputHandler = callback;
				return () => {};
			}),
			onSessionInfoUpdate: vi.fn(() => () => {}),
			onExtensionError: vi.fn(() => () => {}),
		},
		sidecar: { getStatus: vi.fn(async () => ({ status: "ready", cwd: "/tmp" })) },
		// Boot pulls the pending "open in new window" session before hydrating;
		// null = none pending (the plain-attach path this suite drives).
		sessions: { consumePendingOpen: vi.fn(async () => null) },
		system: { notify: vi.fn() },
		prefs: {
			get: vi.fn(async () => null),
			set: vi.fn(async () => {}),
		},
	};
	const ompWindow = window as unknown as { omp: MockOmp };
	ompWindow.omp = omp;
	const emitBatch: BatchHandler = events => {
		for (const event of events) {
			if (event.type === "agent_start") mockStreaming = true;
			if (event.type === "agent_end") mockStreaming = false;
		}
		batchHandler(events);
	};
	return {
		omp,
		emitBatch,
		emitCommandOutput: frame => commandOutputHandler(frame),
		emitSidecarStatus: payload => sidecarStatusHandler(payload),
		emitSubagentFrame: frame => subagentFrameHandler(frame),
		emitTabStatus: payload => tabStatusHandler(payload),
		emitPromptResult: frame => promptResultHandler(frame),
		emitModelCatalogUpdate: frame => modelCatalogUpdateHandler(frame),
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

function turnStatusRow(): ReactElement {
	const { awaitingModelSince, compactionInfo, retryInfo } = useSessionStore.getState();
	return (
		<TurnStatusRow awaitingModelSince={awaitingModelSince} compactionInfo={compactionInfo} retryInfo={retryInfo} />
	);
}
/** Renders the hook under test with no visible chrome of its own. */
function RpcEventsProbe() {
	useRpcEvents();
	return null;
}

function RpcEventsAndTabsProbe() {
	useSessionTabs();
	useRpcEvents();
	return null;
}
const assistantMessage: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };

function subagentSnapshot(id = "agent-1"): SubagentSnapshot {
	return {
		id,
		index: 1,
		agent: "worker",
		agentSource: "project",
		status: "running",
		sessionFile: `/sessions/${id}.jsonl`,
		lastUpdate: 1,
		kind: "sub",
	};
}

function textMessage(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp } as AgentMessage;
}
afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	useAgentViewStore.getState().reset();
	useMessagesStore.getState().reset();
	useModelStore.getState().reset();
	useToolsStore.getState().reset();
	useSubagentsStore.getState().reset();
	useTodoStore.getState().reset();
	useSettingsStore.getState().reset();
	useTabsStore.getState().reset();
});

describe("useRpcEvents selected-agent forwarding and reconnect recovery", () => {
	it("uses the single roster subscription to forward matching live frames without mutating Main stores", async () => {
		const { omp, emitSubagentFrame } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);
		const selected = subagentSnapshot();
		useSubagentsStore.getState().setSnapshots([selected]);
		await useAgentViewStore.getState().selectSubagent(selected);
		const mainMessage = textMessage("Main transcript", 10);
		useMessagesStore.setState({ messages: [mainMessage] });
		const mainTools = useToolsStore.getState();

		await act(async () => {
			emitSubagentFrame({
				type: "subagent_lifecycle",
				payload: {
					id: selected.id,
					index: selected.index,
					agent: selected.agent,
					agentSource: "bundled",
					status: "completed",
					sessionFile: selected.sessionFile,
				},
			});
			emitSubagentFrame({
				type: "subagent_event",
				payload: { id: selected.id, event: { type: "message_end", message: textMessage("Agent transcript", 20) } },
			});
		});

		expect(omp.events.onSubagentFrame).toHaveBeenCalledTimes(1);
		expect(useSubagentsStore.getState().subagents.get(selected.id)?.status).toBe("completed");
		expect(useAgentViewStore.getState().messages.messages).toEqual([textMessage("Agent transcript", 20)]);
		expect(useMessagesStore.getState().messages).toEqual([mainMessage]);
		expect(useToolsStore.getState().activeTools).toBe(mainTools.activeTools);
	});

	it("reasserts events before Main hydration, awaits the authoritative roster, then reloads the selected target once", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);
		const selected = subagentSnapshot();
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		const subscription = Promise.withResolvers<RpcResponse>();
		const roster = Promise.withResolvers<RpcResponse>();
		const sequence: string[] = [];
		omp.rpc.setSubagentSubscription.mockClear();
		omp.rpc.getMessages.mockClear();
		omp.rpc.getSubagents.mockClear();
		omp.rpc.getSubagentMessages.mockClear();
		omp.rpc.setSubagentSubscription.mockImplementation(() => {
			sequence.push("subscribe");
			return subscription.promise;
		});
		omp.rpc.getMessages.mockImplementation(async () => {
			sequence.push("main");
			return success({ messages: [] });
		});
		omp.rpc.getSubagents.mockImplementation(() => {
			sequence.push("roster");
			return roster.promise;
		});

		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/tmp" });
		});
		await flush();

		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
		expect(sequence).toEqual(["subscribe", "main", "roster"]);
		expect(omp.rpc.getSubagentMessages).not.toHaveBeenCalled();

		roster.resolve(success({ subagents: [selected] }));
		await flush();

		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledWith(selected.id, selected.sessionFile, 0);
		subscription.resolve(success({}));
	});

	it("does not replace newer live roster state with a stale hydration response", async () => {
		const { omp, emitSubagentFrame } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);
		const selected = subagentSnapshot("newer-live-roster");
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		const staleRoster = Promise.withResolvers<RpcResponse>();
		omp.rpc.getSubagents.mockReturnValue(staleRoster.promise);
		omp.rpc.getSubagentMessages.mockClear();

		const recovery = recoverReadySession(null);
		await act(async () => {
			emitSubagentFrame({
				type: "subagent_lifecycle",
				payload: {
					id: selected.id,
					index: selected.index,
					agent: selected.agent,
					agentSource: "project",
					status: "completed",
					sessionFile: selected.sessionFile,
				},
			});
		});
		staleRoster.resolve(success({ subagents: [] }));
		await recovery;

		expect(useSubagentsStore.getState().subagents.get(selected.id)?.status).toBe("completed");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: selected.id });
		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledWith(selected.id, selected.sessionFile, 0);
	});

	it("coalesces concurrent full and light ready recovery into one subscription, roster fetch, and reload", async () => {
		const { omp } = installMockOmp();
		const selected = subagentSnapshot("coalesced-ready");
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		const roster = Promise.withResolvers<RpcResponse>();
		omp.rpc.setSubagentSubscription.mockClear();
		omp.rpc.getMessages.mockClear();
		omp.rpc.getSubagents.mockClear();
		omp.rpc.getSubagentMessages.mockClear();
		omp.rpc.getSubagents.mockReturnValue(roster.promise);

		const fullReady = recoverReadySession(null);
		const lightReady = recoverReadySession(null);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
		roster.resolve(success({ subagents: [selected] }));
		await Promise.all([fullReady, lightReady]);

		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledTimes(1);
	});

	it("starts a fresh recovery when starting interrupts an older ready recovery for the same tab", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);
		const selected = subagentSnapshot("reconnected-generation");
		useSubagentsStore.getState().setSnapshots([selected]);
		await useAgentViewStore.getState().selectSubagent(selected);
		const oldRoster = Promise.withResolvers<RpcResponse>();
		omp.rpc.getSubagents.mockClear();
		omp.rpc.getSubagentMessages.mockClear();
		omp.rpc.getSubagents.mockReturnValueOnce(oldRoster.promise).mockResolvedValue(success({ subagents: [selected] }));

		const interrupted = recoverReadySession(null);
		await act(async () => {
			emitSidecarStatus({ status: "starting", cwd: "/tmp" });
			emitSidecarStatus({ status: "ready", cwd: "/tmp" });
		});
		await flush();
		await flush();

		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(2);
		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledTimes(1);
		oldRoster.resolve(success({ subagents: [] }));
		await interrupted;
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: selected.id });
	});

	it("cancels an older hydration as soon as the sidecar starts reconnecting", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);
		const staleState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValue(staleState.promise);

		const interrupted = recoverReadySession(null);
		await act(async () => {
			emitSidecarStatus({ status: "starting", cwd: "/tmp" });
		});
		staleState.resolve(
			success({
				sessionId: "stale-session",
				sessionName: "Stale",
				sessionFile: "/stale.jsonl",
				cwd: "/stale",
				isStreaming: false,
				isCompacting: false,
				contextUsage: null,
				messageCount: 0,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		await interrupted;

		expect(useSessionStore.getState().sessionId).toBe("");
		expect(useSessionStore.getState().cwd).toBe("/tmp");
	});

	it("switches a pending session before the joined full and light ready hydration", async () => {
		const { omp, emitSidecarStatus, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/fresh" });
		omp.tabs.list.mockResolvedValue([
			{
				tabId: "t0",
				cwd: "/fresh",
				target: { type: "local" },
				status: "starting",
				kind: "agent",
			},
		]);
		await mount(<RpcEventsAndTabsProbe />);
		const pendingOpen = Promise.withResolvers<unknown>();
		const targetAgent = subagentSnapshot("target-agent");
		omp.sessions.consumePendingOpen.mockReturnValue(pendingOpen.promise);
		omp.rpc.getState
			.mockResolvedValueOnce(success({ ...sessionState(), sessionFile: "/fresh.jsonl" }))
			.mockResolvedValue(
				success({
					...sessionState(),
					sessionId: "target-session",
					sessionName: "Target",
					sessionFile: "/target.jsonl",
					cwd: "/target",
					messageCount: 1,
				}),
			);
		omp.rpc.getMessages.mockResolvedValue(success({ messages: [textMessage("target transcript", 2)] }));
		omp.rpc.getSubagents.mockResolvedValue(success({ subagents: [targetAgent] }));
		omp.rpc.setSubagentSubscription.mockClear();

		await act(async () => {
			emitTabStatus({
				kind: "agent",
				tabId: "t0",
				cwd: "/fresh",
				target: { type: "local" },
				status: "ready",
			});
			emitSidecarStatus({ status: "ready", cwd: "/fresh" });
		});
		await flush();
		expect(omp.rpc.getState).not.toHaveBeenCalled();
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();

		pendingOpen.resolve("/target.jsonl");
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/target.jsonl");
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(useSessionStore.getState().sessionId).toBe("target-session");
		expect(useMessagesStore.getState().messages).toEqual([textMessage("target transcript", 2)]);
		expect(useSubagentsStore.getState().subagents.has(targetAgent.id)).toBe(true);
	});

	it("parks a delayed pending open on its original tab and retries after switching back", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", target: { type: "local" }, status: "starting", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		const pendingOpen = Promise.withResolvers<unknown>();
		omp.sessions.consumePendingOpen.mockReturnValue(pendingOpen.promise);

		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
		});
		await useTabsStore.getState().switchTab("t1");
		pendingOpen.resolve("/alpha-session.jsonl");
		await flush();

		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		expect(useTabsStore.getState().activeTabId).toBe("t1");
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t0")?.pendingSessionPath).toBe(
			"/alpha-session.jsonl",
		);

		omp.rpc.switchSession.mockClear();
		const messagesBefore = omp.rpc.getMessages.mock.calls.length;
		const subscriptionsBefore = omp.rpc.setSubagentSubscription.mock.calls.length;
		await useTabsStore.getState().switchTab("t0");

		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/alpha-session.jsonl");
		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t0")?.pendingSessionPath).toBeUndefined();
		expect(omp.rpc.getMessages.mock.calls.length).toBe(messagesBefore + 1);
		expect(omp.rpc.setSubagentSubscription.mock.calls.length).toBe(subscriptionsBefore + 1);
	});

	it("parks pending open when tabs reconcile during the initial ready wait", async () => {
		const { omp } = installMockOmp();
		const tabs = Promise.withResolvers<IpcTabInfo[]>();
		const pendingOpen = Promise.withResolvers<unknown>();
		omp.tabs.list.mockReturnValue(tabs.promise);
		omp.sidecar.getStatus.mockResolvedValue({ status: "ready", cwd: "/alpha" });
		omp.sessions.consumePendingOpen.mockReturnValue(pendingOpen.promise);
		await mount(<RpcEventsAndTabsProbe />);

		tabs.resolve([
			{
				tabId: "t0",
				cwd: "/alpha",
				target: { type: "local" },
				status: "ready",
				kind: "agent",
			},
		]);
		await flush();
		expect(useTabsStore.getState().activeTabId).toBe("t0");
		const messagesBefore = omp.rpc.getMessages.mock.calls.length;
		const subscriptionsBefore = omp.rpc.setSubagentSubscription.mock.calls.length;
		pendingOpen.resolve("/boot-session.jsonl");
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/boot-session.jsonl");
		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
		expect(omp.rpc.getMessages.mock.calls.length).toBe(messagesBefore + 1);
		expect(omp.rpc.setSubagentSubscription.mock.calls.length).toBe(subscriptionsBefore + 1);
	});

	it("keeps the boot-selected pending-open owner across a later tab switch", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		const tabs = Promise.withResolvers<IpcTabInfo[]>();
		const pendingOpen = Promise.withResolvers<unknown>();
		omp.tabs.list.mockReturnValue(tabs.promise);
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		omp.sessions.consumePendingOpen.mockReturnValue(pendingOpen.promise);
		await mount(<RpcEventsAndTabsProbe />);

		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
		});
		tabs.resolve([
			{ tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready", kind: "agent" },
			{ tabId: "t1", cwd: "/beta", target: { type: "local" }, status: "starting", kind: "agent" },
		]);
		await flush();
		await useTabsStore.getState().switchTab("t1");
		pendingOpen.resolve("/owned-at-boot.jsonl");
		await flush();

		expect(useTabsStore.getState().tabs.find(tab => tab.id === "t0")?.pendingSessionPath).toBe(
			"/owned-at-boot.jsonl",
		);
		omp.rpc.switchSession.mockClear();
		await useTabsStore.getState().switchTab("t0");
		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/owned-at-boot.jsonl");
	});

	it("joins a light pending-session switch before full ready recovery", async () => {
		const { omp, emitSidecarStatus, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/joined.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		const switched = Promise.withResolvers<RpcResponse>();
		omp.rpc.switchSession.mockReturnValue(switched.promise);
		await act(async () => {
			emitTabStatus({
				kind: "agent",
				tabId: "t0",
				cwd: "/alpha",
				target: { type: "local" },
				status: "ready",
			});
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
		});
		await flush();
		switched.resolve(success({ cancelled: false }));
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
	});

	it("joins a pending claim when a second light ready arrives before its reply", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "ready",
					unreadDone: false,
					pendingSessionPath: "/second-ready.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		const oldState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(oldState.promise);
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		oldState.resolve(success(sessionState()));
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
	});

	it("does not recover on running-to-ready but recovers once on starting-to-ready", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "running",
					sessionId: "active-session",
					unreadDone: false,
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		useSessionStore.setState({ sessionId: "active-session" });
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();
		expect(omp.rpc.getMessages).not.toHaveBeenCalled();
		await act(async () => {
			emitTabStatus({
				kind: "agent",
				tabId: "t0",
				cwd: "/alpha",
				target: { type: "local" },
				status: "ready",
				sessionId: "active-session",
			});
		});
		await flush();
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();
		expect(omp.rpc.getMessages).not.toHaveBeenCalled();
		expect(omp.rpc.getSubagents).not.toHaveBeenCalled();

		useTabsStore.setState(current => ({
			tabs: current.tabs.map(tab => (tab.id === "t0" ? { ...tab, status: "starting" } : tab)),
		}));
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
	});

	it("recovers once when ready tab status replaces the active session identity", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "ready",
					sessionId: "old-session",
					unreadDone: false,
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		useSessionStore.setState({ sessionId: "old-session" });
		await act(async () => {
			emitTabStatus({
				kind: "agent",
				tabId: "t0",
				cwd: "/alpha",
				target: { type: "local" },
				status: "ready",
				sessionId: "new-session",
			});
		});
		await flush();

		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
	});

	it("joins light ready to a full recovery claimed before delayed health checks", async () => {
		const { omp, emitSidecarStatus, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		const selected = subagentSnapshot("joined-reload");
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		omp.rpc.getSubagents.mockResolvedValue(success({ subagents: [selected] }));
		const pendingOpen = Promise.withResolvers<unknown>();
		const health = Promise.withResolvers<RpcResponse>();
		omp.sessions.consumePendingOpen.mockReturnValue(pendingOpen.promise);
		omp.rpc.getState.mockResolvedValueOnce(success(sessionState())).mockReturnValueOnce(health.promise);
		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		pendingOpen.resolve(null);
		await flush();
		health.resolve(success(sessionState()));
		await flush();

		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledTimes(1);
	});

	it("promotes a boot-time full prelude so reconciled light ready joins it", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		const tabs = Promise.withResolvers<IpcTabInfo[]>();
		const pendingOpen = Promise.withResolvers<unknown>();
		const health = Promise.withResolvers<RpcResponse>();
		const selected = subagentSnapshot("boot-promoted-agent");
		omp.tabs.list.mockReturnValue(tabs.promise);
		omp.sidecar.getStatus.mockResolvedValue({ status: "ready", cwd: "/alpha" });
		omp.sessions.consumePendingOpen.mockReturnValue(pendingOpen.promise);
		omp.rpc.getState.mockReturnValueOnce(health.promise);
		omp.rpc.getSubagents.mockResolvedValue(success({ subagents: [selected] }));
		await mount(<RpcEventsAndTabsProbe />);
		tabs.resolve([{ tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "starting", kind: "agent" }]);
		await flush();
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();

		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();
		expect(omp.rpc.getMessages).not.toHaveBeenCalled();
		pendingOpen.resolve("/boot-promoted.jsonl");
		await flush();
		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();
		health.resolve(success(sessionState()));
		await flush();
		expect(omp.rpc.switchSession.mock.invocationCallOrder[0]).toBeLessThan(
			omp.rpc.setSubagentSubscription.mock.invocationCallOrder[0] ?? 0,
		);

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledTimes(1);
	});

	it("waits for the reconciled boot owner when pending-open resolves first", async () => {
		const { omp } = installMockOmp();
		const tabs = Promise.withResolvers<IpcTabInfo[]>();
		const pendingOpen = Promise.withResolvers<unknown>();
		omp.tabs.list.mockReturnValue(tabs.promise);
		omp.sidecar.getStatus.mockResolvedValue({ status: "ready", cwd: "/alpha" });
		omp.sessions.consumePendingOpen.mockReturnValue(pendingOpen.promise);
		omp.rpc.getState
			.mockResolvedValueOnce(success({ ...sessionState(), sessionFile: "/fresh.jsonl" }))
			.mockResolvedValue(success({ ...sessionState(), sessionFile: "/pending-first.jsonl" }));
		await mount(<RpcEventsAndTabsProbe />);
		pendingOpen.resolve("/pending-first.jsonl");
		await flush();
		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();
		tabs.resolve([{ tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready", kind: "agent" }]);
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/pending-first.jsonl");
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("retains pending-first boot work across a starting generation before owner reconciliation", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		const tabs = Promise.withResolvers<IpcTabInfo[]>();
		const pendingOpen = Promise.withResolvers<unknown>();
		omp.tabs.list.mockReturnValue(tabs.promise);
		omp.sidecar.getStatus.mockResolvedValue({ status: "ready", cwd: "/alpha" });
		omp.sessions.consumePendingOpen.mockReturnValueOnce(pendingOpen.promise).mockResolvedValue(null);
		omp.rpc.getState
			.mockResolvedValueOnce(success({ ...sessionState(), sessionFile: "/fresh.jsonl" }))
			.mockResolvedValue(success({ ...sessionState(), sessionFile: "/retained-boot.jsonl" }));
		await mount(<RpcEventsAndTabsProbe />);
		pendingOpen.resolve("/retained-boot.jsonl");
		await flush();
		await act(async () => {
			emitSidecarStatus({ status: "starting", cwd: "/alpha" });
		});
		tabs.resolve([{ tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "starting", kind: "agent" }]);
		await flush();
		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
		});
		await flush();

		expect(omp.sessions.consumePendingOpen).toHaveBeenCalledTimes(1);
		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/retained-boot.jsonl");
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
	});

	it("hands a delayed boot pending read to replacement ready after invalidation", async () => {
		const { omp, emitSidecarStatus, emitTabStatus } = installMockOmp();
		const tabs = Promise.withResolvers<IpcTabInfo[]>();
		const pendingOpen = Promise.withResolvers<unknown>();
		omp.tabs.list.mockReturnValue(tabs.promise);
		omp.sidecar.getStatus.mockResolvedValue({ status: "ready", cwd: "/alpha" });
		omp.sessions.consumePendingOpen.mockReturnValueOnce(pendingOpen.promise).mockResolvedValue(null);
		omp.rpc.getState
			.mockResolvedValueOnce(success({ ...sessionState(), sessionFile: "/fresh.jsonl" }))
			.mockResolvedValue(success({ ...sessionState(), sessionFile: "/delayed-retained.jsonl" }));
		await mount(<RpcEventsAndTabsProbe />);
		await act(async () => {
			emitSidecarStatus({ status: "starting", cwd: "/alpha" });
		});
		tabs.resolve([{ tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "starting", kind: "agent" }]);
		await flush();
		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
		});
		await flush();
		expect(omp.sessions.consumePendingOpen).toHaveBeenCalledTimes(1);
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();
		pendingOpen.resolve("/delayed-retained.jsonl");
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/delayed-retained.jsonl");
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
	});

	it("restores a boot pending path after a failed switch response and retries on light ready", async () => {
		const { omp, emitSidecarStatus, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		omp.sessions.consumePendingOpen.mockResolvedValue("/boot-failed.jsonl");
		omp.rpc.switchSession
			.mockResolvedValueOnce({ type: "response", command: "switch_session", success: false, error: "refused" })
			.mockResolvedValue(success({ cancelled: false }));
		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
		});
		await flush();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBe("/boot-failed.jsonl");
		expect(useToastStore.getState().toasts.at(-1)?.message).toBe("refused");
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(2);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("restores a boot pending path after cancellation and retries on light ready", async () => {
		const { omp, emitSidecarStatus, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		omp.sessions.consumePendingOpen.mockResolvedValue("/boot-cancelled.jsonl");
		omp.rpc.switchSession
			.mockResolvedValueOnce(success({ cancelled: true }))
			.mockResolvedValue(success({ cancelled: false }));
		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
		});
		await flush();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBe("/boot-cancelled.jsonl");
		expect(useToastStore.getState().toasts.at(-1)?.variant).toBe("info");
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(2);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("restores a boot pending path after switch rejection and retries on light ready", async () => {
		const { omp, emitSidecarStatus, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		omp.sessions.consumePendingOpen.mockResolvedValue("/boot-rejected.jsonl");
		omp.rpc.switchSession
			.mockRejectedValueOnce(new Error("switch unavailable"))
			.mockResolvedValue(success({ cancelled: false }));
		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
		});
		await flush();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBe("/boot-rejected.jsonl");
		expect(useToastStore.getState().toasts.at(-1)?.message).toContain("switch unavailable");
		expect(omp.rpc.setSubagentSubscription).not.toHaveBeenCalled();
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(2);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("restores a failed pending switch response and retries on the next real ready", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/failed-response.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		omp.rpc.switchSession
			.mockResolvedValueOnce({ type: "response", command: "switch_session", success: false, error: "refused" })
			.mockResolvedValue(success({ cancelled: false }));
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBe("/failed-response.jsonl");
		expect(useToastStore.getState().toasts.at(-1)?.message).toBe("refused");
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(2);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("restores a cancelled pending switch response and retries on the next real ready", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "starting",
					unreadDone: false,
					pendingSessionPath: "/cancelled-response.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		omp.rpc.switchSession
			.mockResolvedValueOnce(success({ cancelled: true }))
			.mockResolvedValue(success({ cancelled: false }));
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBe("/cancelled-response.jsonl");
		expect(useToastStore.getState().toasts.at(-1)?.variant).toBe("info");
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(2);
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("hydrates the boot-selected tab when delayed pending-open resolves empty", async () => {
		const { omp } = installMockOmp();
		const tabs = Promise.withResolvers<IpcTabInfo[]>();
		const pendingOpen = Promise.withResolvers<unknown>();
		omp.tabs.list.mockReturnValue(tabs.promise);
		omp.sidecar.getStatus.mockResolvedValue({ status: "ready", cwd: "/alpha" });
		omp.sessions.consumePendingOpen.mockReturnValue(pendingOpen.promise);
		await mount(<RpcEventsAndTabsProbe />);
		tabs.resolve([{ tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready", kind: "agent" }]);
		await flush();
		pendingOpen.resolve(null);
		await flush();

		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
		expect(omp.rpc.getSubagents).toHaveBeenCalledTimes(1);
	});

	it("joins the full ready prelude before boot fallback recovery", async () => {
		const { omp } = installMockOmp();
		const tabs = Promise.withResolvers<IpcTabInfo[]>();
		const pendingOpen = Promise.withResolvers<unknown>();
		omp.tabs.list.mockReturnValue(tabs.promise);
		omp.sidecar.getStatus.mockResolvedValue({ status: "ready", cwd: "/alpha" });
		omp.sessions.consumePendingOpen.mockReturnValue(pendingOpen.promise);
		await mount(<RpcEventsAndTabsProbe />);
		tabs.resolve([{ tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready", kind: "agent" }]);
		await flush();
		await flush();

		expect(omp.rpc.getMessages).not.toHaveBeenCalled();
		pendingOpen.resolve("/boot-pending.jsonl");
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/boot-pending.jsonl");
		expect(omp.rpc.getMessages).toHaveBeenCalledTimes(1);
	});

	it("retries a stale pending consumer restored after an A-to-B-to-A route cycle", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "ready",
					unreadDone: false,
					pendingSessionPath: "/aba.jsonl",
				},
				{ kind: "agent", id: "t1", cwd: "/beta", target: { type: "local" }, status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		const oldState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(oldState.promise);
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		await useTabsStore.getState().switchTab("t1");
		await useTabsStore.getState().switchTab("t0");
		omp.rpc.switchSession.mockClear();
		oldState.resolve(success(sessionState()));
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/aba.jsonl");
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("retries a restored pending consumer when its stale reply rejects after an A-to-B-to-A route cycle", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "ready",
					unreadDone: false,
					pendingSessionPath: "/aba-rejected.jsonl",
				},
				{ kind: "agent", id: "t1", cwd: "/beta", target: { type: "local" }, status: "ready", unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		const oldState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(oldState.promise);
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		await useTabsStore.getState().switchTab("t1");
		await useTabsStore.getState().switchTab("t0");
		omp.rpc.switchSession.mockClear();
		oldState.reject(new Error("stale state unavailable"));
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/aba-rejected.jsonl");
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("rejects a pending consumer reply after the active sidecar starts restarting", async () => {
		const { omp, emitSidecarStatus, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "ready",
					unreadDone: false,
					pendingSessionPath: "/restart.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		const oldState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(oldState.promise);
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
			emitSidecarStatus({ status: "starting", cwd: "/alpha" });
		});
		oldState.resolve(success(sessionState()));
		await flush();

		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBe("/restart.jsonl");
	});

	it("retries a restarted pending consumer when ready returns before its old reply", async () => {
		const { omp, emitSidecarStatus, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "ready",
					unreadDone: false,
					pendingSessionPath: "/restart-ready.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		const oldState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(oldState.promise);
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
			emitSidecarStatus({ status: "starting", cwd: "/alpha" });
			emitSidecarStatus({ status: "ready", cwd: "/alpha" });
		});
		await flush();
		oldState.resolve(success(sessionState()));
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/restart-ready.jsonl");
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("retries only after a session replacement invalidates the pending reply", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "ready",
					sessionId: "old",
					unreadDone: false,
					pendingSessionPath: "/replacement.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		const oldState = Promise.withResolvers<RpcResponse>();
		const newState = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockReturnValueOnce(oldState.promise).mockReturnValueOnce(newState.promise);
		await act(async () => {
			emitTabStatus({
				kind: "agent",
				tabId: "t0",
				cwd: "/alpha",
				target: { type: "local" },
				status: "ready",
				sessionId: "old",
			});
		});
		await flush();
		await act(async () => {
			emitTabStatus({
				kind: "agent",
				tabId: "t0",
				cwd: "/alpha",
				target: { type: "local" },
				status: "ready",
				sessionId: "new",
			});
		});
		oldState.resolve(success(sessionState()));
		await flush();
		expect(omp.rpc.switchSession).not.toHaveBeenCalled();
		newState.resolve(success(sessionState()));
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/replacement.jsonl");
	});

	it("restores and retries after pending getState rejects", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "ready",
					unreadDone: false,
					pendingSessionPath: "/get-state-retry.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		omp.rpc.getState.mockRejectedValueOnce(new Error("get_state unavailable"));
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBe("/get-state-retry.jsonl");
		expect(useToastStore.getState().toasts.at(-1)?.message).toContain("get_state unavailable");
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledWith("/get-state-retry.jsonl");
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("restores and retries after pending switchSession rejects", async () => {
		const { omp, emitTabStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/alpha" });
		await mount(<RpcEventsAndTabsProbe />);
		useTabsStore.setState({
			tabs: [
				{
					kind: "agent",
					id: "t0",
					cwd: "/alpha",
					target: { type: "local" },
					status: "ready",
					unreadDone: false,
					pendingSessionPath: "/switch-retry.jsonl",
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		omp.rpc.switchSession
			.mockRejectedValueOnce(new Error("switch unavailable"))
			.mockResolvedValue(success({ cancelled: false }));
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBe("/switch-retry.jsonl");
		expect(useToastStore.getState().toasts.at(-1)?.message).toContain("switch unavailable");
		await act(async () => {
			emitTabStatus({ kind: "agent", tabId: "t0", cwd: "/alpha", target: { type: "local" }, status: "ready" });
		});
		await flush();

		expect(omp.rpc.switchSession).toHaveBeenCalledTimes(2);
		expect(useTabsStore.getState().tabs[0]?.pendingSessionPath).toBeUndefined();
	});

	it("falls back to Main only after a successful reconnect roster omits the selected target", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);
		const selected = subagentSnapshot("missing-after-reconnect");
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		omp.rpc.getSubagents.mockResolvedValue(success({ subagents: [] }));
		omp.rpc.getSubagentMessages.mockClear();

		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/tmp" });
		});
		await flush();
		await flush();

		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(omp.rpc.getSubagentMessages).not.toHaveBeenCalled();
	});

	it("preserves the selected locator as a retryable error when Main transcript hydration fails", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);
		const selected = subagentSnapshot("main-transcript-offline");
		useSubagentsStore.getState().setSnapshots([selected]);
		await useAgentViewStore.getState().selectSubagent(selected);
		omp.rpc.getSubagentMessages.mockClear();
		omp.rpc.getMessages.mockResolvedValue({
			type: "response",
			command: "get_messages",
			success: false,
			error: "Main transcript offline",
		});
		omp.rpc.getSubagents.mockResolvedValue(success({ subagents: [] }));

		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/tmp" });
		});
		await flush();
		await flush();

		expect(useAgentViewStore.getState()).toMatchObject({
			target: { kind: "subagent", id: selected.id },
			loadState: "error",
		});
		expect(useAgentViewStore.getState().error).toContain("Main transcript offline");
		expect(omp.rpc.getSubagentMessages).not.toHaveBeenCalled();

		await useAgentViewStore.getState().reloadSelected();
		expect(useAgentViewStore.getState()).toMatchObject({
			target: { kind: "subagent", id: selected.id },
			loadState: "ready",
			error: null,
		});
		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledWith(selected.id, selected.sessionFile, 0);
	});

	it("rehydrates a completed agent from the persisted task call when the live roster is empty", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		omp.rpc.getState.mockResolvedValue(success({ ...sessionState(), sessionFile: "/tmp/current.jsonl" }));
		await mount(<RpcEventsProbe />);
		const selected = subagentSnapshot("PackageNameScout");
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		omp.rpc.getMessages.mockResolvedValue(
			success({
				messages: [
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "spawn-package-scout",
								name: "task",
								arguments: {
									tasks: [
										{
											name: selected.id,
											agent: "scout",
											task: "Read package.json and report the package name.",
										},
									],
								},
							},
						],
						timestamp: 1,
					},
				],
			}),
		);
		omp.rpc.getSubagents.mockResolvedValue(success({ subagents: [] }));
		omp.rpc.getSubagentMessages.mockResolvedValue(success({ messages: [], hasMore: false }));
		omp.rpc.getSubagentMessages.mockClear();

		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/tmp" });
		});
		await flush();
		await flush();

		expect(useSubagentsStore.getState().subagents.get(selected.id)).toMatchObject({
			id: selected.id,
			agent: "scout",
			task: "Read package.json and report the package name.",
		});
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: selected.id });
		expect(omp.rpc.getSubagentMessages).toHaveBeenCalledWith(selected.id, "/tmp/current/PackageNameScout.jsonl", 0);
	});

	it("does not reload or fall back when reconnect roster reconciliation fails", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);
		const selected = subagentSnapshot("roster-offline");
		useSubagentsStore.getState().setSnapshots([selected]);
		await useAgentViewStore.getState().selectSubagent(selected);
		omp.rpc.getSubagentMessages.mockClear();
		omp.rpc.getSubagents.mockResolvedValue({
			type: "response",
			command: "get_subagents",
			success: false,
			error: "roster offline",
		});

		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/tmp" });
		});
		await flush();
		await flush();

		expect(useAgentViewStore.getState()).toMatchObject({
			target: { kind: "subagent", id: selected.id },
			loadState: "error",
		});
		expect(useAgentViewStore.getState().error).toContain("roster offline");
		expect(omp.rpc.getSubagentMessages).not.toHaveBeenCalled();
	});

	it("keeps the selected target in error state when reconnect transcript reload fails", async () => {
		const { omp, emitSidecarStatus } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);
		const selected = subagentSnapshot("reload-error");
		useSubagentsStore.getState().setSnapshots([selected]);
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selected.id });
		omp.rpc.getSubagents.mockResolvedValue(success({ subagents: [selected] }));
		omp.rpc.getSubagentMessages.mockResolvedValue({
			type: "response",
			command: "get_subagent_messages",
			success: false,
			error: "transcript offline",
		});

		await act(async () => {
			emitSidecarStatus({ status: "ready", cwd: "/tmp" });
		});
		await flush();
		await flush();

		expect(useAgentViewStore.getState()).toMatchObject({
			target: { kind: "subagent", id: selected.id },
			loadState: "error",
			error: "transcript offline",
		});
	});
});

describe("useRpcEvents thinking selection sync", () => {
	it("replaces a stale auto selector when an explicit level event omits configured", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useModelStore.setState({ thinkingLevel: "low", thinkingConfigured: "auto" });

		await act(async () => {
			emitBatch([{ type: "thinking_level_changed", thinkingLevel: "high" }]);
		});

		expect(useModelStore.getState().thinkingLevel).toBe("high");
		expect(useModelStore.getState().thinkingConfigured).toBe("high");
	});

	it("keeps auto selected while updating its effective resolved level", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useModelStore.setState({ thinkingLevel: "medium", thinkingConfigured: "medium" });

		await act(async () => {
			emitBatch([{ type: "thinking_level_changed", thinkingLevel: "xhigh", configured: "auto" }]);
		});

		expect(useModelStore.getState().thinkingLevel).toBe("xhigh");
		expect(useModelStore.getState().thinkingConfigured).toBe("auto");
	});
});

describe("useRpcEvents awaiting-model marker", () => {
	it("arms on agent/turn start and clears when the assistant message finalizes", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		expect(useSessionStore.getState().awaitingModelSince).toBeNull();

		await act(async () => {
			emitBatch([{ type: "agent_start", sessionId: "s1" }]);
		});
		expect(useSessionStore.getState().isStreaming).toBe(true);
		const armedAt = useSessionStore.getState().awaitingModelSince;
		expect(typeof armedAt).toBe("number");

		// The empty-shell phase keeps the marker: message_start fires before
		// the first token, and the status row must survive it.
		await act(async () => {
			emitBatch([{ type: "message_start", message: assistantMessage }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "message_end", message: assistantMessage }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
	});

	it("re-arms per turn and clears on turn_end and agent_end", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		await act(async () => {
			emitBatch([{ type: "agent_start", sessionId: "s1" }, { type: "turn_start" }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		// Tool execution window: running tool cards carry the activity signal.
		await act(async () => {
			emitBatch([{ type: "turn_end" }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
		expect(useSessionStore.getState().isStreaming).toBe(true);

		await act(async () => {
			emitBatch([{ type: "turn_start" }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "agent_end", messages: [], isTerminal: false }]);
		});
		expect(useSessionStore.getState().isStreaming).toBe(false);
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
	});

	it("drives the retry row state and re-arms the model wait on success", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		await act(async () => {
			emitBatch([{ type: "agent_start", sessionId: "s1" }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		// Retry delay window: not a model wait — the inline retry row owns the chat.
		await act(async () => {
			emitBatch([
				{ type: "auto_retry_start", attempt: 2, maxAttempts: 5, delayMs: 9000, errorMessage: "stream stalled" },
			]);
		});
		const retryInfo = useSessionStore.getState().retryInfo;
		expect(retryInfo?.attempt).toBe(2);
		expect(retryInfo?.maxAttempts).toBe(5);
		expect(retryInfo?.delayMs).toBe(9000);
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();

		// Mirror of the TUI's #ensureWorkingLoaderWhileStreaming: a succeeded
		// retry re-arms the wait for the re-dispatched turn's first content.
		await act(async () => {
			emitBatch([{ type: "auto_retry_end", success: true, attempt: 2 }]);
		});
		expect(useSessionStore.getState().retryInfo).toBeNull();
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "agent_end", messages: [], isTerminal: false }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
	});

	it("drives the compaction row state across the maintenance window", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		await act(async () => {
			emitBatch([{ type: "auto_compaction_start", reason: "overflow", action: "compact" }]);
		});
		expect(useSessionStore.getState().isCompacting).toBe(true);
		expect(useSessionStore.getState().compactionInfo).toEqual({ reason: "overflow", action: "compact" });

		await act(async () => {
			emitBatch([
				{ type: "auto_compaction_end", action: "compact", result: null, aborted: false, willRetry: false },
			]);
		});
		expect(useSessionStore.getState().isCompacting).toBe(false);
		expect(useSessionStore.getState().compactionInfo).toBeNull();
	});

	it("keeps the marker through the user-prompt echo, clearing only on assistant message_end", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);

		// Wire order per agent-loop: turn_start → user echo (message_start/end)
		// → model wait → assistant stream → assistant message_end. Neither the
		// echo nor the assistant's empty-shell message_start may clear the row.
		await act(async () => {
			emitBatch([
				{ type: "agent_start", sessionId: "s1" },
				{ type: "turn_start" },
				{ type: "message_start", message: { role: "user", content: [], timestamp: Date.now() } },
				{ type: "message_end", message: { role: "user", content: [], timestamp: Date.now() } },
			]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "message_start", message: assistantMessage }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();

		await act(async () => {
			emitBatch([{ type: "message_end", message: assistantMessage }]);
		});
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
	});

	it("arms the marker when attaching to an already-streaming session", async () => {
		const { omp } = installMockOmp();
		// Server reports a run already in flight at attach time — agent_start
		// was missed, so hydration must re-arm the status row (TUI guest-attach
		// parity).
		omp.rpc.getState.mockImplementation(async () =>
			success({
				sessionId: "s1",
				sessionName: null,
				sessionFile: null,
				cwd: "/tmp",
				isStreaming: true,
				isCompacting: false,
				contextUsage: null,
				messageCount: 3,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		await mount(<RpcEventsProbe />);
		expect(useSessionStore.getState().isStreaming).toBe(true);
		expect(useSessionStore.getState().awaitingModelSince).not.toBeNull();
	});
});

describe("useRpcEvents todo lifecycle", () => {
	it("archives a todo tool result immediately without waiting for agent_end", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		const pending: TodoPhase[] = [{ name: "Build", tasks: [{ content: "scaffold", status: "pending" }] }];

		await act(async () => {
			emitBatch([
				{
					type: "tool_execution_end",
					toolCallId: "todo-1",
					toolName: "todo",
					result: {
						content: [{ type: "text", text: "Todo list updated" }],
						details: { op: "init", phases: pending, storage: "session" },
					},
					isError: false,
				},
			]);
		});

		const state = useTodoStore.getState();
		expect(state.phases[0]?.tasks[0]?.status).toBe("pending");
		expect(state.history).toHaveLength(1);
		expect(state.history[0]?.phases).toEqual(pending);
	});

	it("keeps one completed snapshot when automatic cleanup clears the live todos", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useTodoStore.getState().reset();
		const pending: TodoPhase[] = [{ name: "Build", tasks: [{ content: "scaffold", status: "pending" }] }];
		const completed: TodoPhase[] = [{ name: "Build", tasks: [{ content: "scaffold", status: "completed" }] }];
		useTodoStore.getState().setPhases(pending);
		useTodoStore.getState().showReminder(completed[0]!.tasks);
		useTodoStore.getState().setPhases(completed);

		await act(async () => {
			emitBatch([{ type: "todo_auto_clear" }]);
		});

		const state = useTodoStore.getState();
		expect(state.phases).toEqual([]);
		expect(state.reminderVisible).toBe(false);
		expect(state.reminderTodos).toEqual([]);
		expect(state.history).toHaveLength(1);
		expect(state.history[0]?.phases[0]?.tasks[0]?.status).toBe("completed");
	});
});

describe("useRpcEvents non-transcript frames", () => {
	it("surfaces text-mode slash-command output as a local custom message", async () => {
		const { emitCommandOutput } = installMockOmp();
		await mount(<RpcEventsProbe />);

		await act(async () => {
			emitCommandOutput({ type: "command_output", text: "Enabled models: gpt-5.6" });
		});

		expect(useMessagesStore.getState().messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: "command",
				content: [{ type: "text", text: "Enabled models: gpt-5.6" }],
			}),
		);
	});

	it("rehydrates when a deferred prompt result reports a local-only extension command", async () => {
		const { omp, emitPromptResult } = installMockOmp();
		await mount(<RpcEventsProbe />);
		const stateCallsBefore = omp.rpc.getState.mock.calls.length;
		const transcriptCallsBefore = omp.rpc.getMessages.mock.calls.length;

		await act(async () => {
			emitPromptResult({ type: "prompt_result", id: "extension-command", agentInvoked: false });
			await Promise.resolve();
		});
		await flush();

		expect(omp.rpc.getState.mock.calls.length).toBeGreaterThan(stateCallsBefore);
		expect(omp.rpc.getMessages.mock.calls.length).toBeGreaterThan(transcriptCallsBefore);
	});

	it("applies a model catalog completion frame without reopening the picker", async () => {
		const { emitModelCatalogUpdate } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useModelStore.setState({ catalogRefreshPending: true, catalogGeneration: 1, availableModels: [] });

		await act(async () => {
			emitModelCatalogUpdate({
				type: "model_catalog_update",
				models: [{ provider: "custom", id: "new-model" }],
				providers: [],
				discoveryStates: [
					{ provider: "custom", status: "ok", optional: false, stale: false, models: ["new-model"] },
				],
				refreshPending: false,
				generation: 2,
			});
		});

		expect(useModelStore.getState()).toMatchObject({
			availableModels: [{ provider: "custom", id: "new-model" }],
			catalogRefreshPending: false,
			catalogGeneration: 2,
		});
	});

	it("drops session events while the selected tab and main-process route disagree", async () => {
		const { omp, emitCommandOutput } = installMockOmp();
		await mount(<RpcEventsProbe />);
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", target: { type: "local" }, unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", target: { type: "local" }, unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		const route = Promise.withResolvers<boolean>();
		omp.tabs.setActive.mockReturnValueOnce(route.promise);

		const switching = useTabsStore.getState().switchTab("t1");
		await act(async () => {
			emitCommandOutput({ type: "command_output", text: "belongs to t0" });
		});
		expect(useMessagesStore.getState().messages).toEqual([]);

		route.resolve(true);
		await act(async () => switching);
		await act(async () => {
			emitCommandOutput({ type: "command_output", text: "belongs to t1" });
		});

		expect(useMessagesStore.getState().messages).toContainEqual(
			expect.objectContaining({ content: [{ type: "text", text: "belongs to t1" }] }),
		);
	});
});

describe("useRpcEvents mode-state sync", () => {
	it("hydrates loop, vibe, and project-scoped display settings into the active tab", async () => {
		const { omp } = installMockOmp();
		// Loop/vibe aren't on the get_state wire — hydration must pull the
		// dedicated RPCs so composer chips and footer badges are right at boot.
		omp.rpc.getLoopMode.mockImplementation(async () =>
			success({
				enabled: true,
				state: "running",
				prompt: "keep going",
				limit: { kind: "iterations", initial: 10, remaining: 7 },
			}),
		);
		omp.rpc.getVibeMode.mockImplementation(async () => success({ enabled: true }));
		omp.rpc.getSettings.mockImplementation(async () =>
			success({
				values: {
					"display.showTokenUsage": false,
					"tools.approvalMode": "always-ask",
				},
			}),
		);
		await mount(<RpcEventsProbe />);

		expect(useSessionStore.getState().loopMode).toEqual({
			enabled: true,
			state: "running",
			prompt: "keep going",
			limit: { kind: "iterations", initial: 10, remaining: 7 },
		});
		expect(useSessionStore.getState().vibeModeEnabled).toBe(true);
		expect(useSettingsStore.getState().showTokenUsage).toBe(false);
		expect(useSettingsStore.getState().approvalMode).toBe("always-ask");
	});

	it("applies loop_mode_update frames to the session store, including disable", async () => {
		const { emitBatch } = installMockOmp();
		await mount(<RpcEventsProbe />);
		expect(useSessionStore.getState().loopMode).toEqual({ enabled: false, state: "off" });

		await act(async () => {
			emitBatch([
				{
					type: "loop_mode_update",
					state: { enabled: true, state: "waiting", prompt: "poll the queue" },
				},
			]);
		});
		expect(useSessionStore.getState().loopMode).toEqual({
			enabled: true,
			state: "waiting",
			prompt: "poll the queue",
		});

		// Auto-disable arrives as a frame too — the chip/badge must clear.
		await act(async () => {
			emitBatch([{ type: "loop_mode_update", state: { enabled: false, state: "off" } }]);
		});
		expect(useSessionStore.getState().loopMode).toEqual({ enabled: false, state: "off" });
	});
});

describe("retryPending reset on tab switch", () => {
	it("clears the auto-retry gate so the restored tab's failed turns still toast", async () => {
		const { emitBatch } = installMockOmp();
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", target: { type: "local" }, unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", target: { type: "local" }, unreadDone: false },
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		useToastStore.setState({ toasts: [] });
		await mount(<RpcEventsProbe />);

		// Arm the retry gate on the outgoing tab: while it is set, agent_end
		// error toasts are suppressed as mid-saga noise.
		await act(async () => {
			emitBatch([
				{ type: "agent_start", sessionId: "s1" },
				{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 5000, errorMessage: "boom" },
			]);
		});

		// The switch parks t0 and restores t1 — restoreBundle resets the gate,
		// which is module-level and would otherwise leak across tabs.
		await act(async () => {
			await useTabsStore.getState().switchTab("t1");
		});

		await act(async () => {
			emitBatch([
				{
					type: "agent_end",
					messages: [{ role: "assistant", content: [], timestamp: 1, stopReason: "error", errorMessage: "kaput" }],
				},
			]);
		});

		// The restored tab's failure surfaces; the leaked gate would have eaten it.
		expect(useToastStore.getState().toasts.some(toast => toast.title === "Turn failed")).toBe(true);

		useTabsStore.getState().reset();
		useToastStore.setState({ toasts: [] });
	});
});

describe("TurnStatusRow", () => {
	it("renders the waiting label with elapsed seconds and the interrupt hint", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 5000 });
		await mount(turnStatusRow());
		expect(document.body.textContent).toContain("Waiting for model response");
		expect(document.body.textContent).toContain("5s");
		expect(document.body.textContent).toContain("(press Esc to interrupt)");
		expect(document.body.textContent).not.toContain("Slow response");
	});

	it("escalates to the slow-response hint after 30s", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 35_000 });
		await mount(turnStatusRow());
		expect(document.body.textContent).toContain("35s");
		expect(document.body.textContent).toContain("Slow response");
	});

	it("escalates to the stalled-connection hint after 90s, replacing the generic interrupt hint", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 95_000 });
		await mount(turnStatusRow());
		expect(document.body.textContent).toContain("95s");
		// The stalled copy explains the ~5min watchdog + retry and names Esc
		// itself, so the generic interrupt hint would be redundant noise.
		expect(document.body.textContent).toContain("auto-times-out");
		expect(document.body.textContent).not.toContain("(press Esc to interrupt)");
	});

	it("renders the retry countdown with the failure detail", async () => {
		useSessionStore.setState({
			retryInfo: {
				attempt: 2,
				maxAttempts: 5,
				delayMs: 9000,
				errorMessage: "stream stalled",
				startedAt: Date.now(),
			},
		});
		await mount(turnStatusRow());
		expect(document.body.textContent).toContain("Retrying (2/5) in 9s…");
		expect(document.body.textContent).toContain("stream stalled");
	});

	it("renders the in-flight retry once the delay elapses", async () => {
		useSessionStore.setState({
			retryInfo: {
				attempt: 2,
				maxAttempts: 5,
				delayMs: 9000,
				errorMessage: "stream stalled",
				startedAt: Date.now() - 10_000,
			},
		});
		await mount(turnStatusRow());
		expect(document.body.textContent).toContain("Retrying (2/5)…");
		expect(document.body.textContent).not.toContain("in 9s");
	});

	it("renders the compaction loader with TUI reason/action text", async () => {
		useSessionStore.setState({ compactionInfo: { reason: "overflow", action: "handoff" } });
		await mount(turnStatusRow());
		expect(document.body.textContent).toContain("Context overflow detected, Auto-handoff…");
	});
});

describe("hydrateSession streaming reconcile (F-HYDRATE)", () => {
	it("discards an older hydration when a newer session finishes first", async () => {
		const { omp } = installMockOmp();
		const oldState = Promise.withResolvers<RpcResponse>();
		const oldTranscript = Promise.withResolvers<RpcResponse>();
		const oldGoal = Promise.withResolvers<RpcResponse>();
		const oldMessage: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "old transcript" }],
			timestamp: 1,
		};
		const newMessage: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "new transcript" }],
			timestamp: 2,
		};
		omp.rpc.getState.mockReturnValueOnce(oldState.promise).mockResolvedValue(
			success({
				sessionId: "new-session",
				sessionName: "New",
				sessionFile: "/new.jsonl",
				cwd: "/new",
				isStreaming: false,
				isCompacting: false,
				contextUsage: null,
				messageCount: 1,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		omp.rpc.getMessages
			.mockReturnValueOnce(oldTranscript.promise)
			.mockResolvedValue(success({ messages: [newMessage] }));
		omp.rpc.getGoal.mockReturnValueOnce(oldGoal.promise).mockResolvedValue(success({ enabled: false }));

		const olderHydration = hydrateSession();
		await hydrateSession();
		oldState.resolve(
			success({
				sessionId: "old-session",
				sessionName: "Old",
				sessionFile: "/old.jsonl",
				cwd: "/old",
				isStreaming: false,
				isCompacting: false,
				contextUsage: null,
				messageCount: 1,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		oldTranscript.resolve(success({ messages: [oldMessage] }));
		oldGoal.resolve(success({ enabled: true, objective: "old goal", status: "active" }));
		await olderHydration;

		expect(useSessionStore.getState().sessionId).toBe("new-session");
		expect(useSessionStore.getState().goal).toBeNull();
		expect(useMessagesStore.getState().messages).toEqual([newMessage]);
	});

	it("paints the core transcript before slower subagent and secondary hydration settles", async () => {
		const { omp } = installMockOmp();
		const subagents = Promise.withResolvers<RpcResponse>();
		const goal = Promise.withResolvers<RpcResponse>();
		const hydrated: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "new session transcript" }],
			timestamp: 2,
		};
		omp.rpc.getMessages.mockResolvedValue(success({ messages: [hydrated] }));
		omp.rpc.getSubagents.mockReturnValue(subagents.promise);
		omp.rpc.getGoal.mockReturnValue(goal.promise);
		const transcriptPainted = Promise.withResolvers<void>();
		const unsubscribe = useMessagesStore.subscribe(state => {
			if (state.messages.length === 1 && state.messages[0] === hydrated) transcriptPainted.resolve();
		});

		let settled = false;
		const hydration = hydrateSession().then(() => {
			settled = true;
		});
		await transcriptPainted.promise;
		unsubscribe();
		expect(useMessagesStore.getState().messages).toEqual([hydrated]);

		expect(settled).toBe(false);
		subagents.resolve(success({ subagents: [] }));
		goal.resolve(success({ enabled: false }));
		await hydration;
	});

	it("clears the stale streaming bubble when the hydrated tab has settled", async () => {
		const { omp } = installMockOmp();
		const finalized: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "settled reply" }],
			timestamp: 2,
		};
		// Zombie state: the tab's run settled in the background, so its
		// message_end/agent_end never forwarded — the restored bundle still
		// carries the mid-run slice while the transcript holds the final text.
		useMessagesStore.setState({
			messages: [],
			streamingMessage: assistantMessage,
			streamingText: "partial reply",
			streamingThinking: "partial thinking",
		});
		omp.rpc.getMessages.mockResolvedValue(success({ messages: [finalized] }));

		await hydrateSession();

		const messages = useMessagesStore.getState();
		expect(messages.streamingMessage).toBeNull();
		expect(messages.streamingText).toBe("");
		expect(messages.streamingThinking).toBe("");
		// The finalized content arrives via the transcript merge, not the bubble.
		expect(messages.messages).toEqual([finalized]);
		// Hydrate re-asserts the per-tab subagent subscription (switch-in path).
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledWith("events");
	});

	it("keeps the live stream while the hydrated tab is still streaming", async () => {
		const { omp } = installMockOmp();
		omp.rpc.getState.mockImplementation(async () =>
			success({
				sessionId: "s1",
				sessionName: null,
				sessionFile: null,
				cwd: "/tmp",
				isStreaming: true,
				isCompacting: false,
				contextUsage: null,
				messageCount: 3,
				queuedMessageCount: 0,
				planModeEnabled: false,
				todoPhases: [],
			}),
		);
		useMessagesStore.setState({
			streamingMessage: assistantMessage,
			streamingText: "partial reply",
			streamingThinking: "partial thinking",
		});

		await hydrateSession();

		// Mid-run attach: live deltas resume onto the restored buffers, so the
		// streaming slice must survive hydration untouched.
		const messages = useMessagesStore.getState();
		expect(messages.streamingMessage).toBe(assistantMessage);
		expect(messages.streamingText).toBe("partial reply");
		expect(messages.streamingThinking).toBe("partial thinking");
		expect(omp.rpc.setSubagentSubscription).toHaveBeenCalledWith("events");
	});

	it("excludes restored completed repeated-id entries that merely share the live stream generation", async () => {
		const { omp, emitBatch } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);

		const callId = "read:restored-repeated";
		const restoredOldCall: ToolCallContent = {
			type: "toolCall",
			id: callId,
			name: "read",
			arguments: { path: "/restored-old" },
		};
		const restoredStaleCall: ToolCallContent = {
			type: "toolCall",
			id: callId,
			name: "read",
			arguments: { path: "/restored-stale" },
		};
		await act(async () => {
			emitBatch([
				{ type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } },
				{
					type: "message_end",
					message: { role: "assistant", content: [restoredOldCall, restoredStaleCall], timestamp: 1 },
				},
				{
					type: "tool_execution_start",
					toolCallId: callId,
					toolName: "read",
					args: restoredOldCall.arguments,
				},
				{
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: "read",
					result: "restored old result",
					isError: false,
				},
				{
					type: "tool_execution_start",
					toolCallId: callId,
					toolName: "read",
					args: restoredStaleCall.arguments,
				},
				{
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: "read",
					result: "restored stale result",
					isError: false,
				},
			]);
		});
		expect(useToolsStore.getState().streamGeneration).toBe(1);

		const messages = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockResolvedValue(success({ ...sessionState(), isStreaming: true, messageCount: 3 }));
		omp.rpc.getMessages.mockReturnValue(messages.promise);
		const freshOldCall: ToolCallContent = {
			type: "toolCall",
			id: callId,
			name: "read",
			arguments: { path: "/fresh-old" },
		};
		const liveEventCall: ToolCallContent = {
			type: "toolCall",
			id: callId,
			name: "read",
			arguments: { path: "/live" },
		};
		const freshLiveCall: ToolCallContent = {
			type: "toolCall",
			id: callId,
			name: "read",
			arguments: { path: "/live" },
		};
		const fetched: AgentMessage[] = [
			{ role: "assistant", content: [freshOldCall], timestamp: 2 },
			{
				role: "toolResult",
				toolCallId: callId,
				toolName: "read",
				content: [{ type: "text", text: "fresh old result" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "assistant", content: [freshLiveCall], timestamp: 4 },
		];

		const hydration = hydrateSession();
		await act(async () => {
			emitBatch([
				{
					type: "message_end",
					message: { role: "assistant", content: [liveEventCall], timestamp: 4 },
				},
				{
					type: "tool_execution_start",
					toolCallId: callId,
					toolName: "read",
					args: liveEventCall.arguments,
				},
			]);
		});

		messages.resolve(success({ messages: fetched }));
		await hydration;

		const oldKey = toolEntryKey(freshOldCall);
		const liveKey = toolEntryKey(freshLiveCall);
		expect(liveKey).not.toBe(oldKey);
		expect(useToolsStore.getState().activeTools).toHaveLength(2);
		expect(useToolsStore.getState().activeTools.get(oldKey)).toMatchObject({
			args: { path: "/fresh-old" },
			status: "done",
			result: {
				content: [{ type: "text", text: "fresh old result" }],
				details: null,
			},
		});
		expect(useToolsStore.getState().activeTools.get(liveKey)).toMatchObject({
			args: { path: "/live" },
			status: "running",
			result: null,
		});

		await act(async () => {
			emitBatch([
				{
					type: "tool_execution_update",
					toolCallId: callId,
					toolName: "read",
					args: liveEventCall.arguments,
					partialResult: { bytes: 17 },
				},
				{
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: "read",
					result: { content: "exact live result" },
					isError: false,
				},
			]);
		});

		expect(useToolsStore.getState().activeTools.get(oldKey)).toMatchObject({
			args: { path: "/fresh-old" },
			status: "done",
		});
		expect(useToolsStore.getState().activeTools.get(liveKey)).toMatchObject({
			args: { path: "/live" },
			status: "done",
			partialResult: { bytes: 17 },
			result: { content: "exact live result" },
		});
	});

	it("keeps a generation-zero tool settled when all live events beat cold hydration", async () => {
		const { omp, emitBatch } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);

		const messages = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockResolvedValue(success({ ...sessionState(), isStreaming: true, messageCount: 1 }));
		omp.rpc.getMessages.mockReturnValue(messages.promise);
		const liveEventCall: ToolCallContent = {
			type: "toolCall",
			id: "read:cold-attach",
			name: "read",
			arguments: { path: "/cold-live" },
		};
		const freshLiveCall: ToolCallContent = {
			type: "toolCall",
			id: liveEventCall.id,
			name: liveEventCall.name,
			arguments: liveEventCall.arguments,
		};

		const hydration = hydrateSession();
		await act(async () => {
			emitBatch([
				{
					type: "message_end",
					message: { role: "assistant", content: [liveEventCall], timestamp: 1 },
				},
				{
					type: "tool_execution_start",
					toolCallId: liveEventCall.id,
					toolName: liveEventCall.name,
					args: liveEventCall.arguments,
				},
				{
					type: "tool_execution_end",
					toolCallId: liveEventCall.id,
					toolName: liveEventCall.name,
					result: { content: "exact cold live result" },
					isError: false,
				},
			]);
		});
		expect(useToolsStore.getState().streamGeneration).toBe(0);

		messages.resolve(
			success({
				messages: [{ role: "assistant", content: [freshLiveCall], timestamp: 1 }],
			}),
		);
		await hydration;

		const liveKey = toolEntryKey(freshLiveCall);
		expect(useToolsStore.getState().activeTools).toHaveLength(1);
		expect(useToolsStore.getState().activeTools.get(liveKey)).toMatchObject({
			args: { path: "/cold-live" },
			status: "done",
			result: { content: "exact cold live result" },
			isError: false,
		});
	});

	it("rebases an in-flight repeated tool occurrence onto freshly hydrated messages", async () => {
		const { omp, emitBatch } = installMockOmp();
		omp.sidecar.getStatus.mockResolvedValue({ status: "starting", cwd: "/tmp" });
		await mount(<RpcEventsProbe />);

		const messages = Promise.withResolvers<RpcResponse>();
		omp.rpc.getState.mockResolvedValue(success({ ...sessionState(), isStreaming: true, messageCount: 3 }));
		omp.rpc.getMessages.mockReturnValue(messages.promise);

		const historicalCall: ToolCallContent = {
			type: "toolCall",
			id: "read:repeated",
			name: "read",
			arguments: { path: "historical" },
		};
		const liveEventCall: ToolCallContent = {
			type: "toolCall",
			id: "read:repeated",
			name: "read",
			arguments: { path: "live" },
		};
		const freshLiveCall: ToolCallContent = {
			type: "toolCall",
			id: "read:repeated",
			name: "read",
			arguments: { path: "live" },
		};
		const fetched: AgentMessage[] = [
			{ role: "assistant", content: [historicalCall], timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "read:repeated",
				toolName: "read",
				content: [{ type: "text", text: "historical result" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "assistant", content: [freshLiveCall], timestamp: 3 },
		];

		const hydration = hydrateSession();
		await act(async () => {
			emitBatch([
				{ type: "message_start", message: { role: "assistant", content: [], timestamp: 3 } },
				{ type: "message_end", message: { role: "assistant", content: [liveEventCall], timestamp: 3 } },
				{
					type: "tool_execution_start",
					toolCallId: "read:repeated",
					toolName: "read",
					args: { path: "live" },
				},
			]);
		});
		expect(useToolsStore.getState().activeTools.get(toolEntryKey(liveEventCall))).toMatchObject({
			status: "running",
			args: { path: "live" },
		});

		messages.resolve(success({ messages: fetched }));
		await hydration;

		const historicalKey = toolEntryKey(historicalCall);
		const liveKey = toolEntryKey(freshLiveCall);
		expect(liveKey).not.toBe(historicalKey);
		expect(useToolsStore.getState().activeTools).toHaveLength(2);
		expect(useToolsStore.getState().activeTools.get(historicalKey)).toMatchObject({
			status: "done",
			result: {
				content: [{ type: "text", text: "historical result" }],
				details: null,
			},
		});
		expect(useToolsStore.getState().activeTools.get(liveKey)).toMatchObject({
			status: "running",
			args: { path: "live" },
			result: null,
		});

		await act(async () => {
			emitBatch([
				{
					type: "tool_execution_update",
					toolCallId: "read:repeated",
					toolName: "read",
					args: { path: "live" },
					partialResult: { bytes: 12 },
				},
				{
					type: "tool_execution_end",
					toolCallId: "read:repeated",
					toolName: "read",
					result: { content: "live result" },
					isError: false,
				},
			]);
		});

		expect(useToolsStore.getState().activeTools.get(historicalKey)).toMatchObject({
			status: "done",
			result: {
				content: [{ type: "text", text: "historical result" }],
				details: null,
			},
		});
		expect(useToolsStore.getState().activeTools.get(liveKey)).toMatchObject({
			status: "done",
			partialResult: { bytes: 12 },
			result: { content: "live result" },
		});
	});
});
