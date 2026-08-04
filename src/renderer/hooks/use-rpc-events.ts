import { useEffect } from "react";
import type { IpcSidecarStatusPayload } from "../../shared/ipc-types";
import type { AgentMessage, AgentSessionEvent, RpcGoalState, RpcSessionState, SubagentSnapshot } from "../../shared/rpc-types";
import { useExtensionUiStore } from "../stores/extension-ui";
import { messageIdentityKey, useMessagesStore } from "../stores/messages";
import { useModelStore } from "../stores/model";
import { usePlanApprovalStore } from "../stores/plan-approval";
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

/**
 * Extension-UI methods that block until the user responds — the "waiting for
 * input" surfaces worth a desktop notification. notify/setStatus/setWidget/
 * setTitle/set_editor_text/cancel requests resolve without user input.
 */
const BLOCKING_UI_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, open_url: true };

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
		if (!data || data.enabled !== true) {
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
	]);

	if (stateResult.status === "fulfilled" && stateResult.value.success && stateResult.value.data != null) {
		applySessionState(stateResult.value.data as RpcSessionState, fallbackName);
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
						useSessionStore.setState({ isStreaming: true });
						// Server-side mode changes (plan_approval accept exits plan
						// mode, then dispatches the execution turn) carry no event —
						// re-sync state-derived stores at turn start so the composer
						// chip / titlebar reflect the server.
						void refreshSessionState();
						break;
					}
					case "agent_end": {
						useSessionStore.setState({ isStreaming: false });
						notifyOnAgentEnd(event);
						// Re-fetch state so agent-side todo updates mid-turn reach the panel.
						void refreshSessionState();
						break;
					}
					case "auto_compaction_start": {
						useSessionStore.setState({ isCompacting: true });
						break;
					}
					case "auto_compaction_end": {
						useSessionStore.setState({ isCompacting: false });
						if (event.aborted) {
							useToastStore.getState().push({ variant: "warning", message: "Compaction aborted" });
						}
						break;
					}
					case "auto_retry_start": {
						retryPending = true;
						useToastStore.getState().push({
							variant: "warning",
							message: `Retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s: ${event.errorMessage}`,
							durationMs: event.delayMs + 2000,
						});
						break;
					}
					case "auto_retry_end": {
						retryPending = false;
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
						if (event.thinkingLevel !== undefined) {
							useModelStore.setState({ thinkingLevel: event.thinkingLevel });
						}
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
				void window.omp.rpc
					.getState()
					.then(res => {
						if (!res.success) {
							useUiStore.getState().setSidecarError("Sidecar ready but not responding to commands");
						} else {
							useUiStore.getState().clearSidecarError();
							void hydrateSession();
							void window.omp.rpc.setSubagentSubscription("events");
						}
					})
					.catch(() => {
						useUiStore.getState().setSidecarError("Sidecar health check failed — agent process may be stuck");
					});
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
			void useSettingsStore.getState().syncThinkingDisplay();
			void useSettingsStore.getState().syncApproval();
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
			unsubExtensionUi();
		};
	}, []);
}
