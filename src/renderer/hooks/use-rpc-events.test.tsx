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
import type {
	AgentMessage,
	AgentSessionEvent,
	CommandOutputFrame,
	ExtensionErrorFrame,
	PromptResultFrame,
	RpcResponse,
	SessionInfoUpdateFrame,
} from "../../shared/rpc-types";
import { TurnStatusRow } from "../components/chat/ChatStream";
import { I18nProvider } from "../lib/i18n";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { useToastStore } from "../stores/toast";
import { useToolsStore } from "../stores/tools";
import { hydrateSession, useRpcEvents } from "./use-rpc-events";

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

type BatchHandler = (events: AgentSessionEvent[]) => void;
type CommandOutputHandler = (frame: CommandOutputFrame) => void;
type PromptResultHandler = (frame: PromptResultFrame) => void;

interface MockOmp {
	tabs: {
		setActive: Mock<(tabId: string) => Promise<boolean>>;
	};
	rpc: {
		getState: Mock<() => Promise<RpcResponse>>;
		getTranscript: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		getGoal: Mock<() => Promise<RpcResponse>>;
		getLoopMode: Mock<() => Promise<RpcResponse>>;
		getVibeMode: Mock<() => Promise<RpcResponse>>;
		getQueue: Mock<() => Promise<RpcResponse>>;
		getSettings: Mock<(keys: string[]) => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
	};
	events: {
		onBatch: Mock<(callback: BatchHandler) => () => void>;
		onSidecarStatus: Mock<() => () => void>;
		onSubagentFrame: Mock<() => () => void>;
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
}

function installMockOmp(): {
	omp: MockOmp;
	emitBatch: BatchHandler;
	emitCommandOutput: CommandOutputHandler;
	emitPromptResult: PromptResultHandler;
} {
	let batchHandler: BatchHandler = () => {};
	let commandOutputHandler: CommandOutputHandler = () => {};
	let promptResultHandler: PromptResultHandler = () => {};
	// Mirror the real server: get_state reports isStreaming=true mid-run, and
	// agent_start triggers refreshSessionState — a static mock would overwrite
	// the event-set flag with stale state and test a race production never has.
	let mockStreaming = false;
	const omp: MockOmp = {
		tabs: { setActive: vi.fn(async () => true) },
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
			getTranscript: vi.fn(async () => success({ messages: [] })),
			getSubagents: vi.fn(async () => success({ subagents: [] })),
			getGoal: vi.fn(async () => success({ enabled: false })),
			getLoopMode: vi.fn(async () => success({ enabled: false, state: "off" })),
			getVibeMode: vi.fn(async () => success({ enabled: false })),
			getQueue: vi.fn(async () => success({ steering: [], followUp: [] })),
			getSettings: vi.fn(async () => success({ values: {} })),
			setSubagentSubscription: vi.fn(async () => success({})),
		},
		events: {
			onBatch: vi.fn((callback: BatchHandler) => {
				batchHandler = callback;
				return () => {};
			}),
			onSidecarStatus: vi.fn(() => () => {}),
			onSubagentFrame: vi.fn(() => () => {}),
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
		emitPromptResult: frame => promptResultHandler(frame),
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

/** Renders the hook under test with no visible chrome of its own. */
function RpcEventsProbe() {
	useRpcEvents();
	return null;
}

const assistantMessage: AgentMessage = { role: "assistant", content: [], timestamp: Date.now() };

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useToolsStore.getState().reset();
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
		const transcriptCallsBefore = omp.rpc.getTranscript.mock.calls.length;

		await act(async () => {
			emitPromptResult({ type: "prompt_result", id: "extension-command", agentInvoked: false });
			await Promise.resolve();
		});
		await flush();

		expect(omp.rpc.getState.mock.calls.length).toBeGreaterThan(stateCallsBefore);
		expect(omp.rpc.getTranscript.mock.calls.length).toBeGreaterThan(transcriptCallsBefore);
	});
});

describe("useRpcEvents mode-state sync", () => {
	it("hydrates loop and vibe mode into the session store", async () => {
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
		await mount(<RpcEventsProbe />);

		expect(useSessionStore.getState().loopMode).toEqual({
			enabled: true,
			state: "running",
			prompt: "keep going",
			limit: { kind: "iterations", initial: 10, remaining: 7 },
		});
		expect(useSessionStore.getState().vibeModeEnabled).toBe(true);
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
				{ kind: "agent", id: "t0", cwd: "/alpha", status: "ready", unreadDone: false },
				{ kind: "agent", id: "t1", cwd: "/beta", status: "ready", unreadDone: false },
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
		await mount(<TurnStatusRow />);
		expect(document.body.textContent).toContain("Waiting for model response");
		expect(document.body.textContent).toContain("5s");
		expect(document.body.textContent).toContain("(press Esc to interrupt)");
		expect(document.body.textContent).not.toContain("Slow response");
	});

	it("escalates to the slow-response hint after 30s", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 35_000 });
		await mount(<TurnStatusRow />);
		expect(document.body.textContent).toContain("35s");
		expect(document.body.textContent).toContain("Slow response");
	});

	it("escalates to the stalled-connection hint after 90s, replacing the generic interrupt hint", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 95_000 });
		await mount(<TurnStatusRow />);
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
		await mount(<TurnStatusRow />);
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
		await mount(<TurnStatusRow />);
		expect(document.body.textContent).toContain("Retrying (2/5)…");
		expect(document.body.textContent).not.toContain("in 9s");
	});

	it("renders the compaction loader with TUI reason/action text", async () => {
		useSessionStore.setState({ compactionInfo: { reason: "overflow", action: "handoff" } });
		await mount(<TurnStatusRow />);
		expect(document.body.textContent).toContain("Context overflow detected, Auto-handoff…");
	});
});

describe("hydrateSession streaming reconcile (F-HYDRATE)", () => {
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
		omp.rpc.getTranscript.mockResolvedValue(success({ messages: [finalized] }));

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
});
