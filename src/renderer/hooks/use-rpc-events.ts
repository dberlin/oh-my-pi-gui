import { useEffect } from "react";
import type { IpcSidecarStatusPayload } from "../../shared/ipc-types";
import {
	type AgentMessage,
	type AgentSessionEvent,
	BLOCKING_UI_METHODS,
	type CommandOutputFrame,
	type ExtensionErrorFrame,
	isThinkingLevel,
	type PromptResultFrame,
	type RpcGoalState,
	type RpcLoopModeState,
	type RpcSessionState,
	type RpcVibeModeState,
	type SessionInfoUpdateFrame,
	type SubagentSnapshot,
	type ThinkingLevel,
} from "../../shared/rpc-types";
import { normalizeLoopUpdate } from "../components/panels/ModesPanel";
import { useExtensionUiStore } from "../stores/extension-ui";
import { messageIdentityKey, useMessagesStore } from "../stores/messages";
import { useModelStore } from "../stores/model";
import { usePlanApprovalStore } from "../stores/plan-approval";
import { useQueueStore } from "../stores/queue";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { useSubagentsStore } from "../stores/subagents";
import { useToastStore } from "../stores/toast";
import { useTodoStore } from "../stores/todo";
import { useToolsStore } from "../stores/tools";
import { useUiStore } from "../stores/ui";

/**
 * Routine informational notice sources suppressed from the toast stack — they
 * fire on every model switch (tool mount/unmount reconciliation) and need no
 * user action. Only their info-level notices are dropped; warnings/errors and
 * notices from any other source still surface as toasts.
 */
const QUIET_NOTICE_SOURCES = new Set(["vision", "xdev"]);

/** Schema defaults for the agent's notify settings (settings-schema.ts). */
const NOTIFY_DEFAULTS = { completion: "on", error: "off", ask: "on" } as const;
type NotifyKind = keyof typeof NOTIFY_DEFAULTS;

/**
 * True while an auto-retry is outstanding. `AgentSession` defers/coalesces the
 * wire-level `agent_end` while a prompt is in flight, so a whole retry saga
 * usually settles with ONE `agent_end` — but any that do arrive mid-saga are
 * intermediate attempts, not the final outcome (mirrors the TUI's gate in
 * event-controller.ts).
 */
let retryPending = false;

/**
 * Clear the auto-retry gate. retryPending is module-level, so it survives the
 * per-tab bundle park/restore in tabs.ts — a tab switched away mid-retry would
 * otherwise keep suppressing agent_end notifications/toasts for the tab being
 * restored. restoreBundle calls this on every switch.
 */
export function resetRetryPending(): void {
	retryPending = false;
}

/**
 * Desktop-notification gate, mirroring the TUI's notify policy: the GUI master
 * pref (Settings → GUI, default on), then the agent's `<kind>.notify` setting
 * (read live via get_settings so edits from either the TUI or the GUI's
 * Interaction tab apply immediately), and finally window focus — never notify
 * while the user is watching.
 */
async function maybeNotify(kind: NotifyKind, title: string, body: string): Promise<void> {
	try {
		if (document.hasFocus()) return;
		if (!useUiStore.getState().notifications) return;
		const key = `${kind}.notify`;
		const res = await window.omp.rpc.getSettings([key]);
		const values = res.success ? (res.data as { values?: Record<string, unknown> } | undefined)?.values : undefined;
		const setting = values?.[key];
		const effective = typeof setting === "string" ? setting : NOTIFY_DEFAULTS[kind];
		if (effective === "off") return;
		window.omp.system.notify(title, body);
	} catch {
		// Best-effort: a failed notification must never break event dispatch.
	}
}

/**
 * Notify on a settled turn, reading the outcome from the event's own messages
 * (the mutable stores can already have raced ahead — the TUI reads
 * `agent_end.messages` for the same reason). Completion and error are mutually
 * exclusive for one settled turn.
 */
function notifyOnAgentEnd(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
	// `isTerminal === false` marks a deferred mid-run settle, not the final one.
	if (event.isTerminal === false) return;
	if (retryPending) return;
	const last = event.messages?.findLast(message => message.role === "assistant");
	if (last?.stopReason === "aborted") return;
	const sessionName = useSessionStore.getState().sessionName || "Oh My Pi";
	if (last?.stopReason === "error") {
		const detail =
			typeof last.errorMessage === "string" && last.errorMessage
				? `: ${last.errorMessage.replace(/\s+/g, " ").slice(0, 120)}`
				: "";
		void maybeNotify("error", sessionName, `Stopped with error${detail}`);
		return;
	}
	void maybeNotify("completion", sessionName, "Complete");
}

/**
 * Toast a failed turn in-app regardless of the desktop-notification policy
 * (error notifications default off). The chat bubble carries the message, but
 * a failure with no visible output — e.g. the provider rejects the first
 * request right after a model switch — otherwise looks like a silent no-op.
 * Same guards as notifyOnAgentEnd: deferred mid-run settles and live
 * auto-retries stay quiet (the retry row and its final-failure toast cover
 * those), and aborted turns are user-initiated.
 */
function toastOnAgentError(event: Extract<AgentSessionEvent, { type: "agent_end" }>): void {
	if (event.isTerminal === false) return;
	if (retryPending) return;
	const last = event.messages?.findLast(message => message.role === "assistant");
	if (last?.stopReason !== "error") return;
	const detail =
		typeof last.errorMessage === "string" && last.errorMessage
			? last.errorMessage.replace(/\s+/g, " ").slice(0, 200)
			: "Unknown error";
	useToastStore.getState().push({ variant: "error", title: "Turn failed", message: detail });
}

/** Apply a get_state snapshot to every state-derived store. */
function applySessionState(state: RpcSessionState, fallbackName?: string): void {
	useModelStore.getState().setFromState(state);
	useSessionStore.getState().setFromState(state);
	if (!state.sessionName && fallbackName) {
		useSessionStore.setState({ sessionName: fallbackName });
	}
	useSettingsStore.getState().setFromState(state);
	useTodoStore.getState().setPhases(state.todoPhases);
}

/**
 * Light re-sync of session state (no transcript/subagent fetch). Used for
 * model_changed: a model switch does not rewrite history, so refetching the
 * transcript mid-run would only race the live stream. Also fired on
 * agent_start: server-side plan-mode exits (plan_approval accept) emit no
 * event, so turn start is the sync point that keeps planModeEnabled honest.
 */
async function refreshSessionState(): Promise<void> {
	try {
		const res = await window.omp.rpc.getState();
		if (res.success && res.data != null) {
			applySessionState(res.data as RpcSessionState);
		}
	} catch {
		// Transient — the next heartbeat or hydration retries.
	}
}

/** Goal statuses past which no live goal remains — the composer chip must clear. */
const TERMINAL_GOAL_STATUSES: Record<string, true> = { dropped: true, complete: true };

/** Narrow an untyped goal payload to the fields the session store tracks. */
function goalFields(value: unknown): { objective?: string; status?: string } | null {
	if (!value || typeof value !== "object") return null;
	const objective = "objective" in value && typeof value.objective === "string" ? value.objective : undefined;
	const status = "status" in value && typeof value.status === "string" ? value.status : undefined;
	return { objective, status };
}

/**
 * Normalize a goal_updated frame into a session-store patch. A drop/complete
 * emits the TERMINAL goal object (status "dropped"/"complete") alongside
 * state.enabled=false — storing it verbatim leaves the composer chip stuck
 * ON (`!!goal`), so terminal/disabled frames clear the store instead.
 */
function goalPatchFromEvent(
	goal: unknown,
	state: unknown,
): { goal: { objective?: string } | null; goalState: { status?: string } | null } {
	const goalInfo = goalFields(goal);
	const stateGoal = state && typeof state === "object" && "goal" in state ? goalFields(state.goal) : null;
	const enabled =
		state && typeof state === "object" && "enabled" in state && typeof state.enabled === "boolean"
			? state.enabled
			: undefined;
	const status = stateGoal?.status ?? goalInfo?.status;
	const terminal = status !== undefined && TERMINAL_GOAL_STATUSES[status] === true;
	if (terminal || enabled === false || !goalInfo) return { goal: null, goalState: null };
	return { goal: { objective: goalInfo.objective }, goalState: { status } };
}

/** Fetch the live goal state (get_goal) into the session store; clears when no goal is active. */
async function syncGoal(): Promise<void> {
	try {
		const res = await window.omp.rpc.getGoal();
		if (!res.success) return;
		// get_goal wire payload is RpcGoalState; `data` crosses the bridge as unknown.
		const data = res.data as RpcGoalState | undefined;
		if (data?.enabled !== true) {
			useSessionStore.setState({ goal: null, goalState: null });
			return;
		}
		useSessionStore.setState({
			goal: typeof data.objective === "string" ? { objective: data.objective } : null,
			goalState: { status: data.status },
		});
	} catch {
		// Transient — the next goal_updated event or hydration retries.
	}
}

/** Fetch the live loop-mode state (get_loop_mode) into the session store; null on failure. */
async function syncLoopMode(): Promise<void> {
	try {
		const res = await window.omp.rpc.getLoopMode();
		if (!res.success) return;
		// get_loop_mode wire payload is RpcLoopModeState; `data` crosses the bridge as unknown.
		useSessionStore.setState({ loopMode: (res.data as RpcLoopModeState | undefined) ?? null });
	} catch {
		// Transient — the next loop_mode_update event or hydration retries.
	}
}

/** Fetch the live vibe-mode state (get_vibe_mode) into the session store; no event exists. */
async function syncVibeMode(): Promise<void> {
	try {
		const res = await window.omp.rpc.getVibeMode();
		if (!res.success) return;
		const data = res.data as RpcVibeModeState | undefined;
		useSessionStore.setState({ vibeModeEnabled: data?.enabled === true });
	} catch {
		// Transient — the next hydration retries.
	}
}

/** Reload every renderer store that belongs to the active sidecar session. */
export async function hydrateSession(fallbackName?: string): Promise<void> {
	// Capture before the fetch: messages the live stream appends while the
	// transcript RPC is in flight must survive the merge below.
	const beforeMessages = useMessagesStore.getState().messages;

	const [stateResult, messagesResult, subagentsResult] = await Promise.allSettled([
		window.omp.rpc.getState(),
		window.omp.rpc.getTranscript(),
		window.omp.rpc.getSubagents(),
		// Goal state isn't on the get_state wire — fetch alongside so the
		// composer chip reflects an active goal after boot/session switches,
		// not only on goal_updated events.
		syncGoal(),
		// Loop and vibe mode likewise: loop_mode_update frames keep loop fresh
		// afterwards; vibe emits nothing, so the Modes window mirrors toggles.
		syncLoopMode(),
		syncVibeMode(),
		// Queue snapshot: queue_update frames keep it fresh afterwards;
		// get_queue is only the hydrate fallback (boot/reconnect/session
		// switch all land here). refresh() swallows its own failures.
		useQueueStore.getState().refresh(),
	]);

	if (stateResult.status === "fulfilled" && stateResult.value.success && stateResult.value.data != null) {
		const wire = stateResult.value.data as RpcSessionState;
		applySessionState(wire, fallbackName);
		// Mid-run attach (launch/reconnect/session switch while the agent is
		// streaming) missed the agent_start that arms the status row — re-arm
		// it like the TUI's ensureLoadingAnimation on guest attach, unless a
		// live marker already carries a more accurate start time. When content
		// is actively streaming the row stays hidden behind StreamingRows.
		if (wire.isStreaming && useSessionStore.getState().awaitingModelSince === null) {
			useSessionStore.setState({ awaitingModelSince: Date.now() });
		}
		if (!wire.isStreaming) {
			// Zombie settle: the run finished while this tab sat in the
			// background, so its message_end/agent_end never forwarded and the
			// restored bundle still paints a live bubble. The transcript merge
			// below already carries the finalized content — drop the stale
			// stream slice wholesale. While streaming, keep it: live deltas
			// resume onto the restored buffers.
			useMessagesStore.getState().clearStreaming();
		}
		// Per-tab subagent subscription (F-HYDRATE), re-asserted on every
		// successful hydrate: RPC commands route through the ACTIVE tab's
		// sidecar, so this lands on the tab just switched to. Tabs that report
		// ready while active also subscribe via the status handlers — this
		// covers tabs that booted or settled in the background, whose frames
		// would otherwise stay silent on return. Idempotent server-side.
		void window.omp.rpc.setSubagentSubscription("events");
	}

	if (messagesResult.status === "fulfilled" && messagesResult.value.success) {
		const data = messagesResult.value.data as { messages?: AgentMessage[] } | undefined;
		const fetched = data?.messages ?? [];
		const current = useMessagesStore.getState().messages;
		// Streamed tail: whatever the live stream appended beyond the captured
		// prefix. If the prefix was replaced meanwhile (pagination, another
		// hydration), the transcript fetch alone wins.
		let tail: AgentMessage[] = [];
		if (current.length >= beforeMessages.length) {
			let prefixIntact = true;
			for (let i = 0; i < beforeMessages.length; i++) {
				if (current[i] !== beforeMessages[i]) {
					prefixIntact = false;
					break;
				}
			}
			if (prefixIntact) tail = current.slice(beforeMessages.length);
		}
		const fetchedKeys = new Set(fetched.map(messageIdentityKey));
		const merged =
			tail.length > 0
				? [...fetched, ...tail.filter(message => !fetchedKeys.has(messageIdentityKey(message)))]
				: fetched;
		useMessagesStore.setState({ messages: merged, totalMessages: merged.length });
		useToolsStore.getState().hydrateMessages(merged);
	}

	if (subagentsResult.status === "fulfilled" && subagentsResult.value.success) {
		const data = subagentsResult.value.data as { subagents?: SubagentSnapshot[] } | undefined;
		useSubagentsStore.getState().setSnapshots(data?.subagents ?? []);
	}
}

/**
 * Subscribes to batched RPC events from the sidecar and dispatches
 * them to the appropriate stores. Call once in App.tsx.
 * Also handles sidecar-ready initialization (get_state, subagent subscription).
 */
export function useRpcEvents(): void {
	useEffect(() => {
		const unsubscribe = window.omp.events.onBatch((events: AgentSessionEvent[]) => {
			useMessagesStore.getState().applyEvents(events);
			useToolsStore.getState().applyEvents(events);

			for (const event of events) {
				switch (event.type) {
					case "agent_start": {
						useSessionStore.setState({ isStreaming: true, awaitingModelSince: Date.now() });
						// Server-side mode changes (plan_approval accept exits plan
						// mode, then dispatches the execution turn) carry no event —
						// re-sync state-derived stores at turn start so the composer
						// chip / titlebar reflect the server.
						void refreshSessionState();
						break;
					}
					case "turn_start": {
						// Model request dispatched; the chat renders a pending-model
						// indicator from this timestamp until message_start (or a
						// running tool card) takes over. Without it a stalled provider
						// (slow first event, transport retry) looks like dead air.
						useSessionStore.setState({ awaitingModelSince: Date.now() });
						break;
					}
					case "message_end": {
						// The finalized assistant message replaces the pending
						// indicator — tools run next and their cards carry the
						// activity signal. message_start is NOT the clear point: it
						// fires with an empty shell before the first token streams,
						// and clearing there would reopen the dead-air window.
						if (event.message.role === "assistant") {
							useSessionStore.setState({ awaitingModelSince: null });
						}
						break;
					}
					case "turn_end": {
						// Tool execution follows; running tool cards carry the
						// activity signal until the next turn_start.
						useSessionStore.setState({ awaitingModelSince: null });
						break;
					}
					case "agent_end": {
						useSessionStore.setState({ isStreaming: false, awaitingModelSince: null });
						notifyOnAgentEnd(event);
						toastOnAgentError(event);
						// Re-fetch state so agent-side todo updates mid-turn reach the panel.
						void refreshSessionState();
						break;
					}
					case "auto_compaction_start": {
						// TUI parity: swap the status row to the maintenance loader
						// ("Context overflow detected, Auto context-full maintenance…")
						// for the whole compaction window, not just a flag.
						useSessionStore.setState({
							isCompacting: true,
							compactionInfo: { reason: event.reason, action: event.action },
						});
						break;
					}
					case "auto_compaction_end": {
						useSessionStore.setState({ isCompacting: false, compactionInfo: null });
						if (event.aborted) {
							useToastStore.getState().push({ variant: "warning", message: "Compaction aborted" });
						}
						break;
					}
					case "auto_retry_start": {
						retryPending = true;
						// TUI parity: inline retry loader for the delay+attempt window.
						// Not a model wait, so the pending-model marker stays clear until
						// auto_retry_end re-arms it.
						useSessionStore.setState({
							retryInfo: {
								attempt: event.attempt,
								maxAttempts: event.maxAttempts,
								delayMs: event.delayMs,
								errorMessage: event.errorMessage,
								startedAt: Date.now(),
							},
							awaitingModelSince: null,
						});
						useToastStore.getState().push({
							variant: "warning",
							message: `Retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage}`,
							durationMs: event.delayMs + 2000,
						});
						break;
					}
					case "auto_retry_end": {
						retryPending = false;
						// Mirror the TUI's #ensureWorkingLoaderWhileStreaming: a succeeded
						// retry re-dispatches the turn, so the wait for first content is
						// visible again even if no fresh turn_start arrives.
						useSessionStore.setState({
							retryInfo: null,
							...(event.success && useSessionStore.getState().isStreaming
								? { awaitingModelSince: Date.now() }
								: {}),
						});
						if (event.success) {
							useToastStore.getState().push({ variant: "success", message: "Retry succeeded" });
						} else {
							useToastStore.getState().push({
								variant: "error",
								message: `Retry failed: ${event.finalError ?? "unknown error"}`,
							});
						}
						break;
					}
					case "retry_fallback_applied": {
						useToastStore.getState().push({
							variant: "info",
							message: `Fell back from ${event.from} to ${event.to}`,
						});
						break;
					}
					case "retry_fallback_succeeded": {
						useToastStore.getState().push({
							variant: "success",
							message: `Fallback to ${event.model} succeeded`,
						});
						break;
					}
					case "todo_reminder": {
						useTodoStore.getState().showReminder(event.todos);
						break;
					}
					case "todo_auto_clear": {
						useTodoStore.getState().clearReminder();
						// Agent auto-cleared completed todos — drop the stale list too.
						useTodoStore.getState().setPhases([]);
						break;
					}
					case "thinking_level_changed": {
						const patch: Partial<{ thinkingLevel: ThinkingLevel; thinkingConfigured: ThinkingLevel | "auto" }> =
							{};
						if (event.thinkingLevel !== undefined) patch.thinkingLevel = event.thinkingLevel;
						if (
							typeof event.configured === "string" &&
							(event.configured === "auto" || isThinkingLevel(event.configured))
						) {
							patch.thinkingConfigured = event.configured;
						}
						if (Object.keys(patch).length > 0) useModelStore.setState(patch);
						break;
					}
					case "model_changed": {
						void refreshSessionState();
						break;
					}
					case "notice": {
						// Suppress routine informational churn from chatty sources — vision/xdev
						// mount/unmount notices fire on every model switch and need no action,
						// flooding the toast stack. Warnings/errors and other sources still toast.
						if (event.level === "info" && event.source && QUIET_NOTICE_SOURCES.has(event.source)) break;
						useToastStore.getState().push({
							variant: event.level === "error" ? "error" : event.level === "warning" ? "warning" : "info",
							message: event.message,
							title: event.source,
						});
						break;
					}
					case "ttsr_triggered": {
						useToastStore.getState().push({
							variant: "info",
							message: "Time-traveling rules injected",
							durationMs: 3000,
						});
						break;
					}
					case "goal_updated": {
						// Goal state is passive display — store in session store for the
						// sidebar card / composer chip. Normalized: drop/complete frames
						// carry the terminal goal object, which must CLEAR the store.
						useSessionStore.setState(goalPatchFromEvent(event.goal, event.state));
						break;
					}
					case "loop_mode_update": {
						// Loop state is passive display too — the composer chip and
						// footer badge read it from the session store. Reuse the Modes
						// window's normalizer: frames may arrive flat or nested.
						const next = normalizeLoopUpdate(event);
						if (next) useSessionStore.setState({ loopMode: next });
						break;
					}
					case "queue_update": {
						// Authoritative queue snapshot — fires on every queue mutation
						// (enqueue, drain/consume, remove, move, clear), so the strip,
						// panel, and pending bubbles never poll mid-run.
						useQueueStore.getState().setFromFrame({ steering: event.steering, followUp: event.followUp });
						break;
					}
					case "irc_message": {
						// IRC messages are rendered in the subagent/notification feed
						useToastStore.getState().push({
							variant: "info",
							message:
								typeof event.message === "object" && event.message !== null && "content" in event.message
									? String((event.message as { content: unknown }).content)
									: "IRC message received",
							durationMs: 4000,
						});
						break;
					}
					default:
						break;
				}
			}
		});

		// Heartbeat: a wedged command queue (e.g. a stalled discovery await on
		// the serial server queue) leaves status "ready" but blocks every
		// command, including a lightweight get_state. A periodic probe detects
		// that post-boot brick and surfaces the SidecarBanner (with Restart),
		// which the one-shot boot health check cannot catch.
		let heartbeat: ReturnType<typeof setInterval> | null = null;
		let probing = false;
		const brickMessage = "Agent stopped responding — the command queue may be wedged. Restart the agent.";
		const startHeartbeat = () => {
			if (heartbeat) return;
			heartbeat = setInterval(() => {
				if (probing) return;
				if (useSessionStore.getState().status !== "ready") return;
				probing = true;
				void window.omp.rpc
					.getState()
					.then(res => {
						probing = false;
						if (res.success) useUiStore.getState().clearSidecarError();
						else useUiStore.getState().setSidecarError(brickMessage);
					})
					.catch(() => {
						probing = false;
						useUiStore.getState().setSidecarError(brickMessage);
					});
			}, 15_000);
		};
		const stopHeartbeat = () => {
			if (heartbeat) {
				clearInterval(heartbeat);
				heartbeat = null;
			}
		};

		const handleStatus = (payload: IpcSidecarStatusPayload) => {
			if (payload.status === "starting") {
				stopHeartbeat();
				retryPending = false;
				useMessagesStore.getState().reset();
				useModelStore.getState().reset();
				useSessionStore.getState().reset();
				useSettingsStore.getState().reset();
				useSubagentsStore.getState().reset();
				useTodoStore.getState().reset();
				useToolsStore.getState().reset();
				useExtensionUiStore.getState().clearAll();
				usePlanApprovalStore.getState().clearProposal();
				useUiStore.getState().clearSidecarError();
			}
			useSessionStore.getState().setStatus(payload.status, payload.cwd);

			if (payload.status === "ready") {
				startHeartbeat();
				// One-shot boot health check: verify the command loop is live.
				void (async () => {
					try {
						// A window opened "in new window" for a specific session
						// switches to it BEFORE hydrating, so the first transcript
						// it pulls is the target session, not the fresh empty one.
						const pending = await window.omp.sessions.consumePendingOpen();
						if (pending) {
							const sw = await window.omp.rpc.switchSession(pending);
							if (!sw.success) {
								useToastStore
									.getState()
									.push({ variant: "error", message: `Could not open session: ${sw.error}` });
							}
						}
						const res = await window.omp.rpc.getState();
						if (!res.success) {
							useUiStore.getState().setSidecarError("Sidecar ready but not responding to commands");
						} else {
							useUiStore.getState().clearSidecarError();
							void hydrateSession();
							void window.omp.rpc.setSubagentSubscription("events");
						}
					} catch {
						useUiStore.getState().setSidecarError("Sidecar health check failed — agent process may be stuck");
					}
				})();
			} else if (payload.status === "error" || payload.status === "exited") {
				stopHeartbeat();
				useUiStore.getState().setSidecarError(payload.message ?? "Sidecar process failed");
			}
		};

		const unsubStatus = window.omp.events.onSidecarStatus(handleStatus);
		void window.omp.sidecar.getStatus().then(handleStatus);

		const unsubSubagent = window.omp.events.onSubagentFrame(frame => {
			useSubagentsStore.getState().applyFrame(frame);
		});

		// Agent config edits (set_setting from any client, slash-command config
		// changes) push config_update — re-read the thinking-display settings so
		// ThinkingBlock re-renders with the live hide/prose-only policy.
		const unsubConfig = window.omp.events.onConfigUpdate(() => {
			void useSettingsStore.getState().syncDisplaySettings();
			void useSettingsStore.getState().syncApproval();
		});
		// Extension slash commands can settle locally after the prompt response
		// has already resolved; prompt_result carries the deferred rehydrate signal.
		const unsubPromptResult = window.omp.events.onPromptResult((frame: PromptResultFrame) => {
			if (!frame.agentInvoked) void hydrateSession();
		});
		// Text-mode slash commands write outside the transcript. Surface their
		// output as local custom messages instead of silently dropping the frame.
		const unsubCommandOutput = window.omp.events.onCommandOutput((frame: CommandOutputFrame) => {
			if (!frame.text) return;
			useMessagesStore.getState().appendMessage({
				role: "custom",
				customType: "command",
				content: [{ type: "text", text: frame.text }],
				timestamp: Date.now(),
			});
		});

		const unsubSessionInfo = window.omp.events.onSessionInfoUpdate((frame: SessionInfoUpdateFrame) => {
			useSessionStore.setState(state => ({
				sessionName: frame.title ?? state.sessionName,
				sessionId: frame.sessionId ?? state.sessionId,
			}));
		});

		const unsubExtensionError = window.omp.events.onExtensionError((frame: ExtensionErrorFrame) => {
			useToastStore.getState().push({
				variant: "error",
				title: "Extension error",
				message: `${frame.extensionPath} (${frame.event}): ${frame.error}`,
			});
		});

		// Ask/extension-UI requests that block for input (ask tool, approvals,
		// confirms, …) — notify when the window is unfocused.
		const unsubExtensionUi = window.omp.events.onExtensionUi(request => {
			if (!BLOCKING_UI_METHODS[request.method]) return;
			const sessionName = useSessionStore.getState().sessionName || "Oh My Pi";
			const body =
				"title" in request && typeof request.title === "string" && request.title
					? request.title
					: "Waiting for input";
			void maybeNotify("ask", sessionName, body);
		});

		return () => {
			stopHeartbeat();
			unsubscribe();
			unsubStatus();
			unsubSubagent();
			unsubConfig();
			unsubPromptResult();
			unsubExtensionUi();
			unsubCommandOutput();
			unsubSessionInfo();
			unsubExtensionError();
		};
	}, []);
}
