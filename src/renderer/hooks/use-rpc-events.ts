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
	type RpcResponse,
	type RpcSessionState,
	type RpcVibeModeState,
	type SessionInfoUpdateFrame,
	type SubagentSnapshot,
	type TodoPhase,
} from "../../shared/rpc-types";
import { translate } from "../lib/i18n";
import { normalizeLoopUpdate } from "../lib/loop-mode";
import { acceptsActiveTabEvents, onActiveTabRouteSettled } from "../lib/tab-routing";
import { useAgentViewStore } from "../stores/agent-view";
import { useExtensionUiStore } from "../stores/extension-ui";
import { messageIdentityKey, useMessagesStore } from "../stores/messages";
import { useModelStore } from "../stores/model";
import { usePlanApprovalStore } from "../stores/plan-approval";
import { useQueueStore } from "../stores/queue";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { historicalSubagentsFromMessages, useSubagentsStore } from "../stores/subagents";
import { consumePendingSession, invalidatePendingSessionGeneration, useTabsStore } from "../stores/tabs";
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

function isTodoStatus(value: unknown): value is TodoPhase["tasks"][number]["status"] {
	return (
		value === "pending" ||
		value === "in_progress" ||
		value === "completed" ||
		value === "abandoned" ||
		value === "blocked"
	);
}

function isTodoTask(value: unknown): value is TodoPhase["tasks"][number] {
	return (
		typeof value === "object" &&
		value !== null &&
		"content" in value &&
		typeof value.content === "string" &&
		"status" in value &&
		isTodoStatus(value.status) &&
		(!("blocker" in value) || value.blocker === undefined || typeof value.blocker === "string")
	);
}

function isTodoPhase(value: unknown): value is TodoPhase {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		typeof value.name === "string" &&
		"tasks" in value &&
		Array.isArray(value.tasks) &&
		value.tasks.every(isTodoTask)
	);
}

function todoPhasesFromToolResult(result: unknown): TodoPhase[] | undefined {
	if (typeof result !== "object" || result === null || !("details" in result)) return undefined;
	const details = result.details;
	if (typeof details !== "object" || details === null || !("phases" in details)) return undefined;
	return Array.isArray(details.phases) && details.phases.every(isTodoPhase) ? details.phases : undefined;
}
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
		const message =
			typeof last.errorMessage === "string" && last.errorMessage
				? translate("events.notificationErrorDetail", {
						error: last.errorMessage.replace(/\s+/g, " ").slice(0, 120),
					})
				: translate("events.notificationError");
		void maybeNotify("error", sessionName, message);
		return;
	}
	void maybeNotify("completion", sessionName, translate("events.notificationComplete"));
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
			: translate("common.unknownError");
	useToastStore.getState().push({ variant: "error", title: translate("events.turnFailed"), message: detail });
}

/** Apply a get_state snapshot to every state-derived store. */
function applySessionState(state: RpcSessionState, fallbackName?: string): void {
	useModelStore.getState().setFromState(state);
	useSessionStore.getState().setFromState(state);
	useTabsStore.getState().applyHydratedCwd(state.cwd);
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
	if (!acceptsActiveTabEvents()) return;
	const tabId = useTabsStore.getState().activeTabId;
	const sessionId = useSessionStore.getState().sessionId;
	try {
		const res = await window.omp.rpc.getState();
		if (
			acceptsActiveTabEvents() &&
			useTabsStore.getState().activeTabId === tabId &&
			useSessionStore.getState().sessionId === sessionId &&
			res.success &&
			res.data != null
		) {
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

type HydrationGuard = () => boolean;

/** Fetch the live goal state (get_goal) into the session store; clears when no goal is active. */
async function syncGoal(isCurrent: HydrationGuard): Promise<void> {
	try {
		const res = await window.omp.rpc.getGoal();
		if (!isCurrent() || !res.success) return;
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
async function syncLoopMode(isCurrent: HydrationGuard): Promise<void> {
	try {
		const res = await window.omp.rpc.getLoopMode();
		if (!isCurrent() || !res.success) return;
		// get_loop_mode wire payload is RpcLoopModeState; `data` crosses the bridge as unknown.
		useSessionStore.setState({ loopMode: (res.data as RpcLoopModeState | undefined) ?? null });
	} catch {
		// Transient — the next loop_mode_update event or hydration retries.
	}
}

/** Fetch the live vibe-mode state (get_vibe_mode) into the session store; no event exists. */
async function syncVibeMode(isCurrent: HydrationGuard): Promise<void> {
	try {
		const res = await window.omp.rpc.getVibeMode();
		if (!isCurrent() || !res.success) return;
		const data = res.data as RpcVibeModeState | undefined;
		useSessionStore.setState({ vibeModeEnabled: data?.enabled === true });
	} catch {
		// Transient — the next hydration retries.
	}
}

let hydrationVersion = 0;

function hydrationFailureMessage(result: PromiseSettledResult<RpcResponse>, fallback: string): string {
	if (result.status === "rejected")
		return result.reason instanceof Error ? result.reason.message : String(result.reason);
	return result.value.success ? fallback : result.value.error;
}
/** Hydrate Main stores and report whether this route committed an authoritative roster. */
async function hydrateSessionWithRoster(fallbackName?: string): Promise<boolean> {
	const version = ++hydrationVersion;
	if (!acceptsActiveTabEvents()) return false;
	const tabId = useTabsStore.getState().activeTabId;
	const isCurrent = (): boolean =>
		version === hydrationVersion &&
		acceptsActiveTabEvents() &&
		(tabId === null || useTabsStore.getState().activeTabId === tabId);
	try {
		void window.omp.rpc.setSubagentSubscription("events").catch(() => {
			// Best-effort: the next ready/switch retries.
		});
	} catch {
		// A synchronous preload failure must not block Main hydration.
	}
	// Capture before the fetch: messages the live stream appends while the
	// transcript RPC is in flight must survive the merge below.
	const beforeMessages = useMessagesStore.getState().messages;
	const beforeRoster = useSubagentsStore.getState().subagents;
	const beforeAgentViewGeneration = useAgentViewStore.getState().generation;
	const hydrationStartToolEventRevision = useToolsStore.getState().snapshotProjection().toolEventRevision;
	let hydratedMessages = beforeMessages;
	let authoritativeStreaming = false;

	const coreResult = Promise.allSettled([window.omp.rpc.getState(), window.omp.rpc.getMessages()]);
	const subagentsResult = Promise.allSettled([window.omp.rpc.getSubagents()]);
	const secondaryResult = Promise.allSettled([
		// Goal state isn't on the get_state wire — fetch alongside so the
		// composer chip reflects an active goal after boot/session switches,
		// not only on goal_updated events.
		syncGoal(isCurrent),
		// Loop and vibe mode likewise: loop_mode_update frames keep loop fresh
		// afterwards; vibe emits nothing, so the Modes window mirrors toggles.
		syncLoopMode(isCurrent),
		syncVibeMode(isCurrent),
		// Queue snapshot: queue_update frames keep it fresh afterwards;
		// get_queue is only the hydrate fallback (boot/reconnect/session
		// switch all land here). refresh() swallows its own failures.
		useQueueStore.getState().refresh(),
		// Project-scoped agent settings can differ between tab workspaces. The
		// settings store is renderer-global, so re-read the active sidecar on
		// every hydrate; both methods already reject stale out-of-order replies.
		useSettingsStore.getState().syncDisplaySettings(),
		useSettingsStore.getState().syncApproval(),
	]);
	const [stateResult, messagesResult] = await coreResult;
	if (!isCurrent()) return false;

	if (stateResult.status === "fulfilled" && stateResult.value.success && stateResult.value.data != null) {
		const wire = stateResult.value.data as RpcSessionState;
		authoritativeStreaming = wire.isStreaming;
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
		// The events subscription was reasserted before hydration began, so
		// live subagent frames can join the projection while roster/transcript
		// requests are in flight.
	}

	const mainTranscriptReady = messagesResult.status === "fulfilled" && messagesResult.value.success;
	if (mainTranscriptReady) {
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
		useMessagesStore.getState().reconcileFetched(merged);
		hydratedMessages = useMessagesStore.getState().messages;
		const tools = useToolsStore.getState();
		const currentToolEventRevision = tools.snapshotProjection().toolEventRevision;
		if (authoritativeStreaming || currentToolEventRevision > hydrationStartToolEventRevision) {
			tools.reconcileStreamingMessages(hydratedMessages, hydrationStartToolEventRevision, authoritativeStreaming);
		} else {
			tools.hydrateMessages(hydratedMessages);
		}
	}

	// Subagents and secondary chips do not hold the transcript hostage. Their
	// requests still begin in parallel, but the core session can paint first.
	const [settledSubagents] = await subagentsResult;
	const rosterReady = isCurrent() && settledSubagents.status === "fulfilled" && settledSubagents.value.success;
	const authoritativeRosterReady = mainTranscriptReady && rosterReady;
	if (authoritativeRosterReady) {
		const data = settledSubagents.value.data as { subagents?: SubagentSnapshot[] } | undefined;
		const roster = new Map(
			historicalSubagentsFromMessages(hydratedMessages, useSessionStore.getState().sessionFile).map(snapshot => [
				snapshot.id,
				snapshot,
			]),
		);
		for (const snapshot of data?.subagents ?? []) roster.set(snapshot.id, snapshot);
		if (useSubagentsStore.getState().subagents === beforeRoster) {
			useSubagentsStore.getState().setSnapshots([...roster.values()]);
		}
	} else if (isCurrent()) {
		const view = useAgentViewStore.getState();
		if (view.generation === beforeAgentViewGeneration && view.target.kind === "subagent") {
			const error = !mainTranscriptReady
				? hydrationFailureMessage(messagesResult, "Main transcript hydration failed")
				: hydrationFailureMessage(settledSubagents, "Subagent roster hydration failed");
			view.markSelectedLoadError(error);
		}
	}
	await secondaryResult;
	return authoritativeRosterReady && isCurrent();
}
/** Reload every renderer store that belongs to the active sidecar session. */
export async function hydrateSession(fallbackName?: string): Promise<void> {
	invalidateReadyRecovery();
	useSubagentsStore.getState().invalidateRefresh();
	await hydrateSessionWithRoster(fallbackName);
}

interface ReadyRecovery {
	tabId: string | null;
	generation: number;
	promise: Promise<void>;
}

interface FullReadyPrelude {
	tabId: string | null;
	claimId: number;
	promise: Promise<void>;
}

interface RetainedBootPending {
	claimId: number;
	path: string;
}

interface PendingBootOwnerWait {
	claimId: number;
	resolve: (tabId: string | null) => void;
}

interface BootPendingRead {
	claim: { value: RetainedBootPending | null };
	promise: Promise<void>;
}
let readyRecovery: ReadyRecovery | null = null;
let readyRecoveryGeneration = 0;
let fullReadyPrelude: FullReadyPrelude | null = null;
let fullReadyPreludeClaimId = 0;
let retainedBootPending: RetainedBootPending | null = null;
let retainedBootPendingClaimId = 0;
let pendingBootOwnerWait: PendingBootOwnerWait | null = null;
let bootPendingRead: BootPendingRead | null = null;

/** Invalidate hydration/recovery when the active route or session generation changes. */
export function invalidateReadyRecovery(preserveFullReadyPrelude = false): void {
	hydrationVersion += 1;
	readyRecoveryGeneration += 1;
	readyRecovery = null;
	const ownerWait = pendingBootOwnerWait;
	pendingBootOwnerWait = null;
	ownerWait?.resolve(null);
	if (!preserveFullReadyPrelude) fullReadyPrelude = null;
}

function claimFullReadyPrelude(
	tabId: string | null,
	operation: (promoteToTab: (tabId: string) => void) => Promise<void>,
): Promise<void> {
	if (fullReadyPrelude?.tabId === tabId) return fullReadyPrelude.promise;
	fullReadyPreludeClaimId += 1;
	const claimId = fullReadyPreludeClaimId;
	const promoteToTab = (promotedTabId: string): void => {
		if (fullReadyPrelude?.claimId === claimId && fullReadyPrelude.tabId === null) {
			fullReadyPrelude.tabId = promotedTabId;
		}
	};
	const promise = operation(promoteToTab);
	fullReadyPrelude = { tabId, claimId, promise };
	const clear = () => {
		if (fullReadyPrelude?.claimId === claimId) fullReadyPrelude = null;
	};
	void promise.then(clear, clear);
	return promise;
}

function getBootPendingRead(): BootPendingRead {
	if (bootPendingRead !== null) return bootPendingRead;
	const claim = { value: null as RetainedBootPending | null };
	const promise = window.omp.sessions.consumePendingOpen().then(pending => {
		if (pending) {
			retainedBootPendingClaimId += 1;
			claim.value = {
				claimId: retainedBootPendingClaimId,
				path: pending,
			};
		}
	});
	bootPendingRead = { claim, promise };
	return bootPendingRead;
}

/** Join full ready's pending-open and health prelude before light recovery. */
export function joinFullReadyPrelude(tabId: string): Promise<void> | null {
	return fullReadyPrelude?.tabId === tabId ? fullReadyPrelude.promise : null;
}

/**
 * Coalesce the full active-sidecar ready event with the light per-tab ready
 * event. Both channels can report the same transition; one authoritative
 * hydrate/reload sequence is enough and prevents duplicate subscriptions and
 * transcript/roster fetches.
 */
export function recoverReadySession(tabId: string | null = useTabsStore.getState().activeTabId): Promise<void> {
	const generation = readyRecoveryGeneration;
	if (readyRecovery?.tabId === tabId && readyRecovery.generation === generation) return readyRecovery.promise;
	const promise = (async () => {
		const rosterReady = await hydrateSessionWithRoster();
		if (!rosterReady || generation !== readyRecoveryGeneration) return;
		if (!acceptsActiveTabEvents() || useTabsStore.getState().activeTabId !== tabId) return;
		await useAgentViewStore.getState().reloadSelected();
	})();
	readyRecovery = { tabId, generation, promise };
	const clear = () => {
		setTimeout(() => {
			if (readyRecovery?.promise === promise) readyRecovery = null;
		}, 0);
	};
	void promise.then(clear, clear);
	return promise;
}
/**
 * Subscribes to batched RPC events from the sidecar and dispatches
 * them to the appropriate stores. Call once in App.tsx.
 * Also handles sidecar-ready initialization (get_state, subagent subscription).
 */
export function useRpcEvents(): void {
	useEffect(() => {
		const unsubscribe = window.omp.events.onBatch((events: AgentSessionEvent[]) => {
			if (!acceptsActiveTabEvents()) return;
			// Incoming session events belong to the target sidecar. Drop them
			// until hydrate commits so they cannot append onto the outgoing transcript.
			if (useUiStore.getState().switchPending) return;
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
					case "tool_execution_end": {
						if (event.toolName !== "todo" || event.isError) break;
						const phases = todoPhasesFromToolResult(event.result);
						if (phases) useTodoStore.getState().setPhases(phases);
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
							useToastStore
								.getState()
								.push({ variant: "warning", message: translate("events.compactionAborted") });
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
							message: translate("events.retryScheduled", {
								attempt: event.attempt,
								max: event.maxAttempts,
								seconds: Math.round(event.delayMs / 1000),
								error: event.errorMessage,
							}),
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
							useToastStore.getState().push({ variant: "success", message: translate("events.retrySucceeded") });
						} else {
							useToastStore.getState().push({
								variant: "error",
								message: translate("events.retryFailed", {
									error: event.finalError ?? translate("common.unknownError"),
								}),
							});
						}
						break;
					}
					case "retry_fallback_applied": {
						useToastStore.getState().push({
							variant: "info",
							message: translate("events.fallbackApplied", { from: event.from, to: event.to }),
						});
						break;
					}
					case "retry_fallback_succeeded": {
						useToastStore.getState().push({
							variant: "success",
							message: translate("events.fallbackSucceeded", { model: event.model }),
						});
						break;
					}
					case "todo_reminder": {
						useTodoStore.getState().showReminder(event.todos);
						break;
					}
					case "todo_auto_clear": {
						// Automatic cleanup is not a second user-visible todo change:
						// keep the completed snapshot and only clear the live state.
						useTodoStore.getState().autoClearCompleted();
						break;
					}
					case "thinking_level_changed": {
						const configured =
							typeof event.configured === "string" &&
							(event.configured === "auto" || isThinkingLevel(event.configured))
								? event.configured
								: event.thinkingLevel;
						// Explicit changes omit `configured` because it equals the effective
						// level. Treat that omission as data, not as "keep the old selector";
						// otherwise cycle/hotkey changes leave a stale checked menu item.
						useModelStore.setState({
							thinkingLevel: event.thinkingLevel,
							thinkingConfigured: configured,
						});
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
							message: translate("events.ttsrInjected"),
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
				if (!acceptsActiveTabEvents()) return;
				if (useSessionStore.getState().status !== "ready") return;
				probing = true;
				const probeTabId = useTabsStore.getState().activeTabId;
				void window.omp.rpc
					.getState()
					.then(res => {
						probing = false;
						if (!acceptsActiveTabEvents() || useTabsStore.getState().activeTabId !== probeTabId) return;
						if (res.success) useUiStore.getState().clearSidecarError();
						else useUiStore.getState().setSidecarError(brickMessage);
					})
					.catch(() => {
						probing = false;
						if (!acceptsActiveTabEvents() || useTabsStore.getState().activeTabId !== probeTabId) return;
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
			if (!acceptsActiveTabEvents()) return;
			const statusTabId = useTabsStore.getState().activeTabId;
			if (statusTabId !== null && (payload.status === "starting" || payload.status === "ready")) {
				useTabsStore.setState(current => ({
					tabs: current.tabs.map(tab => (tab.id === statusTabId ? { ...tab, status: payload.status } : tab)),
				}));
			}
			if (payload.status === "starting") {
				stopHeartbeat();
				invalidatePendingSessionGeneration();
				invalidateReadyRecovery();
				retryPending = false;
				useMessagesStore.getState().reset();
				useModelStore.getState().reset();
				useSessionStore.getState().reset();
				useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
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
				void claimFullReadyPrelude(statusTabId, async promoteFullReadyPrelude => {
					const statusGeneration = readyRecoveryGeneration;
					let pendingOwnerTabId = statusTabId;
					const pendingOwnerReady = statusTabId === null ? Promise.withResolvers<string | null>() : null;
					const stopPendingOwnerCapture =
						statusTabId === null
							? onActiveTabRouteSettled(() => {
									if (pendingOwnerTabId === null && statusGeneration === readyRecoveryGeneration) {
										const reconciledTabId = useTabsStore.getState().activeTabId;
										if (reconciledTabId !== null) {
											pendingOwnerTabId = reconciledTabId;
											pendingOwnerReady?.resolve(reconciledTabId);
											promoteFullReadyPrelude(reconciledTabId);
										}
									}
								})
							: null;
					const isStatusCurrent = (): boolean =>
						statusGeneration === readyRecoveryGeneration &&
						acceptsActiveTabEvents() &&
						useTabsStore.getState().activeTabId === statusTabId;
					try {
						// A window opened "in new window" for a specific session
						// switches to it BEFORE hydrating, so the first transcript
						let pendingClaim = retainedBootPending;
						if (pendingClaim !== null) retainedBootPending = null;
						try {
							if (pendingClaim === null) {
								const pendingRead = getBootPendingRead();
								try {
									await pendingRead.promise;
								} catch (error) {
									if (bootPendingRead === pendingRead) bootPendingRead = null;
									throw error;
								}
								if (statusGeneration !== readyRecoveryGeneration && pendingOwnerTabId === null) {
									return;
								}
								pendingClaim = pendingRead.claim.value;
								pendingRead.claim.value = null;
								if (bootPendingRead === pendingRead) bootPendingRead = null;
							}
							if (pendingClaim !== null && pendingOwnerTabId === null && pendingOwnerReady !== null) {
								retainedBootPending = pendingClaim;
								pendingBootOwnerWait = {
									claimId: pendingClaim.claimId,
									resolve: pendingOwnerReady.resolve,
								};
								const reconciledOwner = await pendingOwnerReady.promise;
								if (pendingBootOwnerWait?.claimId === pendingClaim.claimId) {
									pendingBootOwnerWait = null;
								}
								if (reconciledOwner === null) return;
								pendingOwnerTabId = reconciledOwner;
								if (retainedBootPending?.claimId === pendingClaim.claimId) {
									retainedBootPending = null;
								}
							}
						} finally {
							stopPendingOwnerCapture?.();
						}
						const pendingTabId = statusTabId ?? pendingOwnerTabId;
						if (pendingClaim !== null) {
							if (pendingTabId !== null) {
								useTabsStore.setState(current => ({
									tabs: current.tabs.map(tab =>
										tab.id === pendingTabId && tab.pendingSessionPath === undefined
											? { ...tab, pendingSessionPath: pendingClaim.path }
											: tab,
									),
								}));
								await consumePendingSession(pendingTabId);
							}
							return;
						}
						if (!isStatusCurrent()) {
							if (pendingOwnerTabId !== null) {
								const currentTabs = useTabsStore.getState();
								const owner = currentTabs.tabs.find(tab => tab.id === pendingOwnerTabId);
								if (
									currentTabs.activeTabId === pendingOwnerTabId &&
									(owner?.status === "ready" || owner?.status === "running") &&
									acceptsActiveTabEvents()
								) {
									await recoverReadySession(pendingOwnerTabId);
								}
							}
							return;
						}
						const res = await window.omp.rpc.getState();
						if (!isStatusCurrent()) return;
						if (!res.success) {
							useUiStore.getState().setSidecarError(translate("events.sidecarNoResponse"));
						} else {
							useUiStore.getState().clearSidecarError();
							if (statusTabId !== null && (await consumePendingSession(statusTabId))) return;
							await recoverReadySession(statusTabId);
						}
					} catch {
						stopPendingOwnerCapture?.();
						if (!isStatusCurrent()) return;
						useUiStore.getState().setSidecarError(translate("events.sidecarHealthFailed"));
					}
				});
			} else if (payload.status === "error" || payload.status === "exited") {
				stopHeartbeat();
				useUiStore.getState().setSidecarError(payload.message ?? translate("events.sidecarProcessFailed"));
			}
		};

		const unsubStatus = window.omp.events.onSidecarStatus(handleStatus);
		void window.omp.sidecar.getStatus().then(handleStatus);

		const unsubSubagent = window.omp.events.onSubagentFrame(frame => {
			if (!acceptsActiveTabEvents()) return;
			useSubagentsStore.getState().applyFrame(frame);
			useAgentViewStore.getState().applyFrame(frame);
		});

		const unsubModelCatalog = window.omp.events.onModelCatalogUpdate(frame => {
			if (!acceptsActiveTabEvents()) return;
			useModelStore.getState().applyCatalogUpdate(frame);
		});

		// Agent config edits (set_setting from any client, slash-command config
		// changes) push config_update — re-read the thinking-display settings so
		// ThinkingBlock re-renders with the live hide/prose-only policy.
		const unsubConfig = window.omp.events.onConfigUpdate(() => {
			if (!acceptsActiveTabEvents()) return;
			void useSettingsStore.getState().syncDisplaySettings();
			void useSettingsStore.getState().syncApproval();
		});
		// Extension slash commands can settle locally after the prompt response
		// has already resolved; prompt_result carries the deferred rehydrate signal.
		const unsubPromptResult = window.omp.events.onPromptResult((frame: PromptResultFrame) => {
			if (!acceptsActiveTabEvents()) return;
			if (!frame.agentInvoked) void hydrateSession();
		});
		// Text-mode slash commands write outside the transcript. Surface their
		// output as local custom messages instead of silently dropping the frame.
		const unsubCommandOutput = window.omp.events.onCommandOutput((frame: CommandOutputFrame) => {
			if (!acceptsActiveTabEvents()) return;
			if (!frame.text) return;
			useMessagesStore.getState().appendMessage({
				role: "custom",
				customType: "command",
				content: [{ type: "text", text: frame.text }],
				timestamp: Date.now(),
			});
		});

		const unsubSessionInfo = window.omp.events.onSessionInfoUpdate((frame: SessionInfoUpdateFrame) => {
			if (!acceptsActiveTabEvents()) return;
			useSessionStore.setState(state => ({
				sessionName: frame.title === undefined ? state.sessionName : frame.title,
				sessionId: frame.sessionId ?? state.sessionId,
			}));
		});

		const unsubExtensionError = window.omp.events.onExtensionError((frame: ExtensionErrorFrame) => {
			if (!acceptsActiveTabEvents()) return;
			useToastStore.getState().push({
				variant: "error",
				title: translate("events.extensionError"),
				message: `${frame.extensionPath} (${frame.event}): ${frame.error}`,
			});
		});

		// Ask/extension-UI requests that block for input (ask tool, approvals,
		// confirms, …) — notify when the window is unfocused.
		const unsubExtensionUi = window.omp.events.onExtensionUi((request, tabId) => {
			if (!BLOCKING_UI_METHODS[request.method]) return;
			const tab = useTabsStore.getState().tabs.find(item => item.id === tabId);
			const sessionName = tab?.title || "Oh My Pi";
			const body =
				"title" in request && typeof request.title === "string" && request.title
					? request.title
					: "Waiting for input";
			void maybeNotify("ask", sessionName, body);
		});

		return () => {
			const ownerWait = pendingBootOwnerWait;
			pendingBootOwnerWait = null;
			ownerWait?.resolve(null);
			retainedBootPending = null;
			bootPendingRead = null;
			stopHeartbeat();
			unsubscribe();
			unsubStatus();
			unsubSubagent();
			unsubModelCatalog();
			unsubConfig();
			unsubPromptResult();
			unsubExtensionUi();
			unsubCommandOutput();
			unsubSessionInfo();
			unsubExtensionError();
		};
	}, []);
}
