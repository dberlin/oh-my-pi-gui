import { createSessionRpcClient } from "../../shared/rpc-client";
import type {
	AgentMessage,
	ModelInfo,
	RpcGoalState,
	RpcLoopModeState,
	RpcResponse,
	RpcSessionState,
	SubagentSnapshot,
	RpcVibeModeState,
} from "../../shared/rpc-types";
import { acceptsActiveTabEvents } from "../lib/tab-routing";
import { type AgentViewStore, useAgentViewStore } from "../stores/agent-view";
import { type MessagesStore, mergeFetchedTranscript, useMessagesStore } from "../stores/messages";
import { type ModelStore, useModelStore } from "../stores/model";
import { type QueueStore, useQueueStore } from "../stores/queue";
import { type SessionStore, useSessionStore } from "../stores/session";
import {
	activeTabCommand,
	focusedSessionRuntime,
	type SessionRuntime,
	sessionRuntime,
	sessionRuntimeStore,
	type TabCommand,
	withSessionRuntime,
} from "../stores/session-runtime-context";
import { type SettingsStore, useSettingsStore } from "../stores/settings";
import { historicalSubagentsFromMessages, type SubagentsStore, useSubagentsStore } from "../stores/subagents";
import { useSubagentGraphStore } from "../stores/subagent-graph";
import { ensureTabRuntime } from "../stores/tab-runtime";
import { isTabClosed, useTabsStore } from "../stores/tabs";
import { useTodoStore } from "../stores/todo";
import { type ToolsStore, useToolsStore } from "../stores/tools";

/** Apply the usage half of a snapshot; caller must already be runtime-scoped. */
function writeUsage(state: RpcSessionState): void {
	// A snapshot without usage proves nothing — the ring renders from this field,
	// so overwriting a good reading with null would make it vanish.
	if (!state.contextUsage) return;
	useSessionStore.setState(session => ({
		contextUsage: state.contextUsage ?? null,
		statsPulse: session.statsPulse + 1,
	}));
}

/**
 * Land the context-usage reading from a `get_state` snapshot.
 *
 * No session event carries usage, so unlike the rest of a snapshot it is not
 * invalidated by events that arrived while the round trip was in flight.
 */
export function applyUsageSnapshot(state: RpcSessionState, tabId: string): void {
	withSessionRuntime(tabId, () => writeUsage(state));
}

interface MetadataOwnership {
	model: boolean;
	thinkingLevel: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: boolean;
	sessionId: boolean;
	sessionName: boolean;
	sessionFile: boolean;
	cwd: boolean;
	contextUsage: boolean;
}

/** Track field changes, not just final equality: a newer ABA update still wins. */
function captureMetadataOwnership(runtime: SessionRuntime) {
	const fields: MetadataOwnership = {
		model: true,
		thinkingLevel: true,
		fastModeEnabled: true,
		fastModeActive: true,
		tokensPerSecond: true,
		sessionId: true,
		sessionName: true,
		sessionFile: true,
		cwd: true,
		contextUsage: true,
	};
	const stopModel = sessionRuntimeStore<ModelStore>(runtime.tabId, "model")?.subscribe((state, previous) => {
		if (state.model !== previous.model) fields.model = false;
		if (state.thinkingLevel !== previous.thinkingLevel) fields.thinkingLevel = false;
		if (state.fastModeEnabled !== previous.fastModeEnabled) fields.fastModeEnabled = false;
		if (state.fastModeActive !== previous.fastModeActive) fields.fastModeActive = false;
		if (state.tokensPerSecond !== previous.tokensPerSecond) fields.tokensPerSecond = false;
	});
	const stopSession = sessionRuntimeStore<SessionStore>(runtime.tabId, "session")?.subscribe((state, previous) => {
		if (state.sessionId !== previous.sessionId) fields.sessionId = false;
		if (state.sessionName !== previous.sessionName) fields.sessionName = false;
		if (state.sessionFile !== previous.sessionFile) fields.sessionFile = false;
		if (state.cwd !== previous.cwd) fields.cwd = false;
		if (state.contextUsage !== previous.contextUsage) fields.contextUsage = false;
	});
	return {
		fields,
		stop: () => {
			stopModel?.();
			stopSession?.();
		},
	};
}

/** Apply owned metadata independently from lifecycle snapshot freshness. */
export function applySessionState(
	state: RpcSessionState,
	fallbackName?: string,
	ownership?: { metadata: Readonly<MetadataOwnership>; lifecycle: boolean },
): void {
	const runtime = focusedSessionRuntime();
	const model = useModelStore.getState();
	const session = useSessionStore.getState();
	const metadata = ownership?.metadata;
	const sameModel =
		!metadata ||
		metadata.model ||
		(state.model?.provider === model.model?.provider && state.model?.id === model.model?.id);
	const fullyOwned =
		!metadata ||
		(metadata.model &&
			metadata.thinkingLevel &&
			metadata.fastModeEnabled &&
			metadata.fastModeActive &&
			metadata.tokensPerSecond &&
			metadata.sessionId &&
			metadata.sessionName &&
			metadata.sessionFile &&
			metadata.cwd &&
			metadata.contextUsage);
	const snapshot: RpcSessionState =
		metadata && !fullyOwned
			? {
					...state,
					model: metadata.model ? state.model : model.model,
					thinkingLevel: sameModel && metadata.thinkingLevel ? state.thinkingLevel : model.thinkingLevel,
					fastModeEnabled: sameModel && metadata.fastModeEnabled ? state.fastModeEnabled : model.fastModeEnabled,
					fastModeActive: sameModel && metadata.fastModeActive ? state.fastModeActive : model.fastModeActive,
					tokensPerSecond: sameModel && metadata.tokensPerSecond ? state.tokensPerSecond : model.tokensPerSecond,
					sessionId: metadata.sessionId ? state.sessionId : session.sessionId,
					sessionName: metadata.sessionName ? state.sessionName : session.sessionName,
					sessionFile: metadata.sessionFile ? state.sessionFile : session.sessionFile,
					cwd: metadata.cwd ? state.cwd : session.cwd,
					contextUsage: sameModel && metadata.contextUsage ? state.contextUsage : session.contextUsage,
				}
			: state;
	const lifecycle = ownership?.lifecycle ?? true;
	if (runtime) runtime.recovering = false;
	// Initial identity discovery belongs to the live stream already painting.
	// A genuinely different established session still retires its old graph.
	if (session.sessionId !== snapshot.sessionId && (lifecycle || session.sessionId)) {
		useSubagentGraphStore.getState().reset();
	}
	model.setFromState(snapshot);
	if (lifecycle) {
		session.setFromState(snapshot);
		if (snapshot.queuedMessages) useQueueStore.getState().setFromFrame(snapshot.queuedMessages);
		useSettingsStore.getState().setFromState(snapshot);
		useTodoStore.getState().setPhases(snapshot.todoPhases);
	} else {
		useSessionStore.setState({
			sessionId: snapshot.sessionId,
			sessionName: metadata?.sessionName ? snapshot.sessionName || null : session.sessionName,
			sessionFile: snapshot.sessionFile ?? null,
			cwd: snapshot.cwd ?? session.cwd,
		});
	}
	if (!metadata || metadata.cwd) {
		useTabsStore.getState().applyHydratedCwd(snapshot.cwd, runtime?.tabId ?? useTabsStore.getState().activeTabId);
	}
	if (!metadata || (sameModel && metadata.contextUsage)) writeUsage(snapshot);
	if ((!metadata || metadata.sessionName) && !snapshot.sessionName && fallbackName) {
		useSessionStore.setState({ sessionName: fallbackName });
	}
}

/**
 * Light re-sync of session state (no transcript/subagent fetch). Used for
 * agent_start: server-side plan-mode exits (plan_approval accept) emit no
 * event, so turn start is the sync point that keeps planModeEnabled honest.
 * Model switches go through refreshModelState instead.
 */
export async function refreshSessionState(tabId = useTabsStore.getState().activeTabId): Promise<void> {
	if (!tabId) return;
	// Closed tabs keep their tombstone: never resurrect a runtime for them.
	// Live tabs may legitimately lack one yet (boot race) — create on demand.
	const runtime = isTabClosed(tabId) ? sessionRuntime(tabId) : ensureTabRuntime(tabId);
	if (!runtime) return;
	const sessionId = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId;
	const eventVersion = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().eventVersion;
	try {
		const res = await runtime.command({ type: "get_state" });
		if (
			sessionRuntime(tabId) !== runtime ||
			sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId !== sessionId ||
			!res.success ||
			res.data == null
		)
			return;
		const state = res.data as RpcSessionState;
		// Events that landed during the round trip already updated the stores, so
		// this snapshot is behind on everything they carry. Usage has no event
		// carrier, so it stays the freshest reading we have either way.
		const churned = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().eventVersion !== eventVersion;
		withSessionRuntime(tabId, () => {
			if (churned) writeUsage(state);
			else applySessionState(state);
		});
	} catch {
		// Transient — the next heartbeat or hydration retries.
	}
}

/** Re-sync the model-derived stores after a model switch, ignoring event churn. */
export async function refreshModelState(tabId = useTabsStore.getState().activeTabId): Promise<void> {
	if (!tabId) return;
	const runtime = isTabClosed(tabId) ? sessionRuntime(tabId) : ensureTabRuntime(tabId);
	if (!runtime) return;
	const sessionId = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId;
	try {
		const res = await runtime.command({ type: "get_state" });
		if (
			sessionRuntime(tabId) !== runtime ||
			sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId !== sessionId ||
			!res.success ||
			res.data == null
		)
			return;
		const state = res.data as RpcSessionState;
		withSessionRuntime(tabId, () => {
			useModelStore.getState().setFromState(state);
			// Another model means another context window, so the usage ring has to
			// follow the switch even though the token count did not change.
			writeUsage(state);
		});
		await sessionRuntimeStore<ModelStore>(tabId, "model")
			?.getState()
			.refreshThinkingLevels(
				() =>
					sessionRuntime(tabId) === runtime &&
					sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId === sessionId,
			);
	} catch {
		// Transient — the next hydration retries.
	}
}

function asModelInfo(value: unknown): ModelInfo | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as ModelInfo;
	return typeof candidate.provider === "string" && typeof candidate.id === "string" ? candidate : undefined;
}

/**
 * Apply an out-of-band authoritative model: the `set_model` response and
 * `config_update` frames both carry the sidecar's live model. This is the only
 * channel for a switch that emits no `model_changed` at all — re-selecting the
 * current provider+id is a no-op server-side, so without it a stale label can
 * never be corrected.
 */
export function applyModelInfo(model: unknown, tabId: string | null): void {
	const info = asModelInfo(model);
	if (!info || !tabId) return;
	withSessionRuntime(tabId, () => useModelStore.setState({ model: info }));
}

type HydrationGuard = () => boolean;

/** Fetch the live goal state (get_goal) into the session store; clears when no goal is active. */
export async function syncGoal(tabId: string, command: TabCommand, isCurrent: HydrationGuard): Promise<void> {
	const before = withSessionRuntime(tabId, () => useSessionStore.getState());
	try {
		const res = await command({ type: "get_goal" });
		if (!isCurrent() || !res.success) return;
		const current = withSessionRuntime(tabId, () => useSessionStore.getState());
		if (
			current.eventVersion !== before.eventVersion ||
			current.goal !== before.goal ||
			current.goalState !== before.goalState
		)
			return;
		// get_goal wire payload is RpcGoalState; `data` crosses the bridge as unknown.
		const data = res.data as RpcGoalState | undefined;
		withSessionRuntime(tabId, () => {
			if (data?.enabled !== true) {
				useSessionStore.setState({ goal: null, goalState: null });
				return;
			}
			useSessionStore.setState({
				goal: typeof data.objective === "string" ? { objective: data.objective } : null,
				goalState: { status: data.status },
			});
		});
	} catch {
		// Transient — the next goal_updated event or hydration retries.
	}
}

/** Fetch the live loop-mode state (get_loop_mode) into the session store; null on failure. */
export async function syncLoopMode(tabId: string, command: TabCommand, isCurrent: HydrationGuard): Promise<void> {
	const before = withSessionRuntime(tabId, () => useSessionStore.getState().loopMode);
	try {
		const res = await command({ type: "get_loop_mode" });
		if (!isCurrent() || !res.success) return;
		if (withSessionRuntime(tabId, () => useSessionStore.getState().loopMode) !== before) return;
		// get_loop_mode wire payload is RpcLoopModeState; `data` crosses the bridge as unknown.
		withSessionRuntime(tabId, () => {
			useSessionStore.setState({ loopMode: (res.data as RpcLoopModeState | undefined) ?? null });
		});
	} catch {
		// Transient — the next loop_mode_update event or hydration retries.
	}
}

/** Fetch the live vibe-mode state (get_vibe_mode) into the session store; no event exists. */
export async function syncVibeMode(tabId: string, command: TabCommand, isCurrent: HydrationGuard): Promise<void> {
	try {
		const res = await command({ type: "get_vibe_mode" });
		if (!isCurrent() || !res.success) return;
		const data = res.data as RpcVibeModeState | undefined;
		withSessionRuntime(tabId, () => {
			useSessionStore.setState({ vibeModeEnabled: data?.enabled === true });
		});
	} catch {
		// Transient — the next hydration retries.
	}
}

const hydrationVersions = new WeakMap<SessionRuntime, number>();
let legacyHydrationVersion = 0;

/** Retire snapshots fetched before the owning sidecar restarted. */
export function invalidateSessionHydration(tabId: string | null = useTabsStore.getState().activeTabId): void {
	if (tabId === null) {
		legacyHydrationVersion++;
		return;
	}
	const runtime = sessionRuntime(tabId);
	if (runtime) hydrationVersions.set(runtime, (hydrationVersions.get(runtime) ?? 0) + 1);
}

export async function hydrateLegacySession(fallbackName?: string, initialState?: RpcResponse): Promise<void> {
	const version = ++legacyHydrationVersion;
	const originRuntime = focusedSessionRuntime();
	const isCurrent = () =>
		version === legacyHydrationVersion && focusedSessionRuntime() === originRuntime && acceptsActiveTabEvents();
	// This path has no tab runtime to scope to, so its stores are resolved by
	// focus at apply time. Remember who we fetched for and refuse to write that
	// snapshot into a pane the user switched to while the RPC was in flight.
	const beforeMessages = useMessagesStore.getState().messages;
	const beforeLiveMessages = useMessagesStore.getState().liveMessages;
	const beforeSessionId = useSessionStore.getState().sessionId;
	const beforeEventVersion = useSessionStore.getState().eventVersion;
	const tools = useToolsStore.getState();
	const hydrationStartToolEventRevision = tools.snapshotProjection().toolEventRevision;
	const agentViewGeneration = useAgentViewStore.getState().generation;
	const subagents = useSubagentsStore.getState();
	subagents.invalidateRefresh();
	const beforeRoster = subagents.subagents;
	try {
		void activeTabCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
	} catch {
		// Best-effort: the next ready transition retries.
	}
	const stateResponse = initialState ? Promise.resolve(initialState) : activeTabCommand({ type: "get_state" });
	const core = Promise.allSettled([stateResponse, createSessionRpcClient(activeTabCommand).getMessages()]);
	const subagentsResult = Promise.allSettled([activeTabCommand({ type: "get_subagents" })]);
	const secondary = Promise.allSettled([
		syncGoal("", activeTabCommand, isCurrent),
		syncLoopMode("", activeTabCommand, isCurrent),
		syncVibeMode("", activeTabCommand, isCurrent),
		useQueueStore
			.getState()
			.refresh(stateResponse, () => isCurrent() && useSessionStore.getState().eventVersion === beforeEventVersion),
		useSettingsStore.getState().syncDisplaySettings(),
		useSettingsStore.getState().syncApproval(),
	]);
	const [stateResult, messagesResult] = await core;
	if (!isCurrent()) return;
	const eventsUnchanged = useSessionStore.getState().eventVersion === beforeEventVersion;
	const focusUnchanged = focusedSessionRuntime() === originRuntime;
	// `get_state` is the only witness to a live turn. A failed read counts as not
	// live: a card left spinning never resolves, while a wrongly aborted card is
	// repaired by the next execution event.
	const stateIsStreaming =
		stateResult.status === "fulfilled" &&
		stateResult.value.success &&
		(stateResult.value.data as RpcSessionState | null)?.isStreaming === true;
	const stateIsIdle =
		eventsUnchanged &&
		stateResult.status === "fulfilled" &&
		stateResult.value.success &&
		stateResult.value.data != null &&
		!stateIsStreaming;
	if (
		eventsUnchanged &&
		focusUnchanged &&
		stateResult.status === "fulfilled" &&
		stateResult.value.success &&
		stateResult.value.data != null
	) {
		const wire = stateResult.value.data as RpcSessionState;
		applySessionState(wire, fallbackName);
		if (wire.isStreaming && useSessionStore.getState().awaitingModelSince === null) {
			useSessionStore.setState({ awaitingModelSince: Date.now() });
		}
		if (!wire.isStreaming) useMessagesStore.getState().clearStreaming();
	}
	const thinkingLevels = isCurrent() ? useModelStore.getState().refreshThinkingLevels(isCurrent) : undefined;
	const mainTranscriptReady = focusUnchanged && messagesResult.status === "fulfilled" && messagesResult.value.success;
	if (mainTranscriptReady) {
		const fetched = (messagesResult.value.data as { messages?: AgentMessage[] } | undefined)?.messages ?? [];
		const current = useMessagesStore.getState().messages;
		useMessagesStore.getState().reconcileFetched(mergeFetchedTranscript(fetched, beforeMessages, current));
		if (stateIsIdle && useMessagesStore.getState().liveMessages === beforeLiveMessages) {
			useMessagesStore.getState().clearDeliveredLiveMessages();
		}
		const authoritativeStreaming = eventsUnchanged ? stateIsStreaming : useSessionStore.getState().isStreaming;
		if (!authoritativeStreaming && tools.snapshotProjection().toolEventRevision === hydrationStartToolEventRevision) {
			tools.hydrateMessages(useMessagesStore.getState().messages, { turnIsLive: stateIsStreaming });
		} else {
			tools.reconcileStreamingMessages(
				useMessagesStore.getState().messages,
				hydrationStartToolEventRevision,
				authoritativeStreaming,
			);
		}
	}
	const [settledSubagents] = await subagentsResult;
	const authoritativeRosterReady =
		isCurrent() && mainTranscriptReady && settledSubagents.status === "fulfilled" && settledSubagents.value.success;
	if (authoritativeRosterReady) {
		const data = settledSubagents.value.data as { subagents?: SubagentSnapshot[] } | undefined;
		const roster = new Map(
			historicalSubagentsFromMessages(
				useMessagesStore.getState().messages,
				useSessionStore.getState().sessionFile,
			).map(snapshot => [snapshot.id, snapshot]),
		);
		for (const snapshot of data?.subagents ?? []) roster.set(snapshot.id, snapshot);
		if (useSubagentsStore.getState().subagents === beforeRoster) {
			subagents.setSnapshots([...roster.values()], useSessionStore.getState().sessionId === beforeSessionId);
		}
	}
	if (isCurrent()) {
		const selectedView = useAgentViewStore.getState();
		if (selectedView.generation === agentViewGeneration && selectedView.target.kind === "subagent") {
			if (authoritativeRosterReady) await selectedView.reloadSelected();
			else {
				selectedView.markSelectedLoadError(
					!mainTranscriptReady
						? hydrationFailureMessage(messagesResult, "Main transcript hydration failed")
						: hydrationFailureMessage(settledSubagents, "Subagent roster hydration failed"),
				);
			}
		}
	}
	await Promise.all([secondary, thinkingLevels]);
}

function hydrationFailureMessage(result: PromiseSettledResult<RpcResponse>, fallback: string): string {
	if (result.status === "rejected")
		return result.reason instanceof Error ? result.reason.message : String(result.reason);
	return result.value.success ? fallback : result.value.error;
}

/** Reload every renderer store that belongs to the active sidecar session. */
export async function hydrateSession(fallbackName?: string): Promise<void> {
	const tabId = useTabsStore.getState().activeTabId;
	if (!tabId || !sessionRuntime(tabId)) return hydrateLegacySession(fallbackName);
	return hydrateTabSession(tabId, fallbackName);
}

/** Reload every renderer store belonging to one visible tab. */
export async function hydrateTabSession(tabId: string, fallbackName?: string): Promise<void> {
	if (isTabClosed(tabId)) return;
	const runtime = ensureTabRuntime(tabId);
	const session = sessionRuntimeStore<SessionStore>(tabId, "session");
	if (session && !session.getState().cwd) {
		const targetCwd = useTabsStore.getState().tabs.find(tab => tab.id === tabId)?.cwd;
		// Bind the owning target before capturing metadata precedence. This is
		// an absence fallback, not a later route hint superseding native cwd.
		if (targetCwd) session.setState({ cwd: targetCwd });
	}
	const commandGeneration = runtime.commandGeneration;
	const version = (hydrationVersions.get(runtime) ?? 0) + 1;
	hydrationVersions.set(runtime, version);
	const isCurrent = (): boolean =>
		hydrationVersions.get(runtime) === version &&
		sessionRuntime(tabId) === runtime &&
		runtime.commandGeneration === commandGeneration;
	try {
		void runtime.command({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
	} catch {
		// Best-effort: the next ready transition retries.
	}
	// Capture before the fetch: committed agent_end rows arriving while the
	// transcript RPC is in flight must survive the merge below.
	const initialMessagesStore = sessionRuntimeStore<MessagesStore>(tabId, "messages")?.getState();
	const beforeMessages = initialMessagesStore?.messages ?? [];
	const beforeLiveMessages = initialMessagesStore?.liveMessages ?? [];
	const subagents = sessionRuntimeStore<SubagentsStore>(tabId, "subagents");
	const beforeRoster = subagents?.getState().subagents;
	subagents?.getState().invalidateRefresh();
	const tools = sessionRuntimeStore<ToolsStore>(tabId, "tools");
	const agentView = sessionRuntimeStore<AgentViewStore>(tabId, "agentView");
	const beforeAgentViewGeneration = agentView?.getState().generation;
	const hydrationStartToolEventRevision = tools?.getState().snapshotProjection().toolEventRevision ?? 0;
	let hydratedMessages = beforeMessages;

	const beforeSessionId = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId;
	const beforeEventVersion = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().eventVersion;
	const metadata = captureMetadataOwnership(runtime);
	const stateResponse = runtime.command({ type: "get_state" });
	const coreResult = Promise.allSettled([stateResponse, createSessionRpcClient(runtime.command).getMessages()]);
	const subagentsResult = Promise.allSettled([runtime.command({ type: "get_subagents" })]);
	const queue = sessionRuntimeStore<QueueStore>(tabId, "queue")?.getState();
	const settings = sessionRuntimeStore<SettingsStore>(tabId, "settings")?.getState();
	const secondaryResult = Promise.allSettled([
		// Goal state isn't on the get_state wire — fetch alongside so the
		// composer chip reflects an active goal after boot/session switches,
		// not only on goal_updated events.
		syncGoal(tabId, runtime.command, isCurrent),
		// Loop and vibe mode likewise: loop_mode_update frames keep loop fresh
		// afterwards; vibe emits nothing, so the Modes window mirrors toggles.
		syncLoopMode(tabId, runtime.command, isCurrent),
		syncVibeMode(tabId, runtime.command, isCurrent),
		// Reuse the core state snapshot so queue and turn state describe the
		// same read. New events or a replaced hydration retire both together.
		queue?.refresh(
			stateResponse,
			() =>
				isCurrent() &&
				sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().eventVersion === beforeEventVersion,
		),
		// Project-scoped agent settings can differ between tab workspaces. The
		// settings store is per-tab (each runtime owns one bound to its own
		// command channel), so re-read this tab's sidecar on every hydrate; both
		// methods already reject stale out-of-order replies.
		settings?.syncDisplaySettings(),
		settings?.syncApproval(),
	]);
	let core: Awaited<typeof coreResult>;
	try {
		core = await coreResult;
	} finally {
		// Ownership covers the read only; no subscriptions survive cancellation,
		// stale generations, failure, or the subsequent rendering commit.
		metadata.stop();
	}
	const [stateResult, messagesResult] = core;
	if (!isCurrent()) return;
	if (stateResult.status === "fulfilled" && stateResult.value.success && stateResult.value.data != null) {
		const wire = stateResult.value.data as RpcSessionState;
		const currentSessionId = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId;
		// Only identity changes DURING the read retire this snapshot. An
		// unchanged cached identity may legitimately be corrected by native state.
		if (!metadata.fields.sessionId && currentSessionId && currentSessionId !== wire.sessionId) return;
	}
	const eventsUnchanged =
		sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().eventVersion === beforeEventVersion;
	// `get_state` is the only witness to a live turn. A failed read counts as not
	// live: a card left spinning never resolves, while a wrongly aborted card is
	// repaired by the next execution event.
	const stateIsStreaming =
		stateResult.status === "fulfilled" &&
		stateResult.value.success &&
		(stateResult.value.data as RpcSessionState | null)?.isStreaming === true;
	const stateIsIdle =
		eventsUnchanged &&
		stateResult.status === "fulfilled" &&
		stateResult.value.success &&
		stateResult.value.data != null &&
		!stateIsStreaming;

	if (stateResult.status === "fulfilled" && stateResult.value.success && stateResult.value.data != null) {
		const wire = stateResult.value.data as RpcSessionState;
		withSessionRuntime(tabId, () =>
			applySessionState(wire, fallbackName, {
				metadata: metadata.fields,
				lifecycle: eventsUnchanged,
			}),
		);
		// Mid-run attach (launch/reconnect/session switch while the agent is
		// streaming) missed the agent_start that arms the status row — re-arm
		// it like the TUI's ensureLoadingAnimation on guest attach, unless a
		// live marker already carries a more accurate start time. When content
		// is actively streaming the row stays hidden behind StreamingRows.
		const session = sessionRuntimeStore<SessionStore>(tabId, "session");
		const messages = sessionRuntimeStore<MessagesStore>(tabId, "messages");
		if (eventsUnchanged && wire.isStreaming && session?.getState().awaitingModelSince === null) {
			session.setState({ awaitingModelSince: Date.now() });
		}
		if (eventsUnchanged && !wire.isStreaming) {
			// Zombie settle: the run finished while this tab sat in the
			// background, so its message_end/agent_end never forwarded and the
			// restored bundle still paints partial assistant content. Clear only
			// those stream buffers here; the transcript merge below separately
			// removes delivered live rows while preserving an unsent local prompt.
			messages?.getState().clearStreaming();
		}
	}
	const thinkingLevels = isCurrent()
		? sessionRuntimeStore<ModelStore>(tabId, "model")?.getState().refreshThinkingLevels(isCurrent)
		: undefined;

	const mainTranscriptReady = isCurrent() && messagesResult.status === "fulfilled" && messagesResult.value.success;
	if (mainTranscriptReady) {
		const data = messagesResult.value.data as { messages?: AgentMessage[] } | undefined;
		const fetched = data?.messages ?? [];
		const messages = sessionRuntimeStore<MessagesStore>(tabId, "messages");
		const current = messages?.getState().messages ?? [];
		messages?.getState().reconcileFetched(mergeFetchedTranscript(fetched, beforeMessages, current));
		if (stateIsIdle && messages?.getState().liveMessages === beforeLiveMessages) {
			messages.getState().clearDeliveredLiveMessages();
		}
		hydratedMessages = messages?.getState().messages ?? [];
		const currentTools = tools?.getState();
		const authoritativeStreaming = eventsUnchanged
			? stateIsStreaming
			: sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().isStreaming === true;
		if (
			currentTools &&
			!authoritativeStreaming &&
			currentTools.snapshotProjection().toolEventRevision === hydrationStartToolEventRevision
		) {
			currentTools.hydrateMessages(hydratedMessages, { turnIsLive: stateIsStreaming });
		} else {
			currentTools?.reconcileStreamingMessages(
				hydratedMessages,
				hydrationStartToolEventRevision,
				authoritativeStreaming,
			);
		}
	}

	// Subagents and secondary chips do not hold the transcript hostage. Their
	// requests still begin in parallel, but the core session can paint first.
	const [settledSubagents] = await subagentsResult;
	const rosterReady = isCurrent() && settledSubagents.status === "fulfilled" && settledSubagents.value.success;
	const authoritativeRosterReady = mainTranscriptReady && rosterReady;
	if (authoritativeRosterReady) {
		const data = settledSubagents.value.data as { subagents?: SubagentSnapshot[] } | undefined;
		const sessionFile = sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionFile;
		const roster = new Map(
			historicalSubagentsFromMessages(hydratedMessages, sessionFile).map(snapshot => [snapshot.id, snapshot]),
		);
		for (const snapshot of data?.subagents ?? []) roster.set(snapshot.id, snapshot);
		if (subagents && subagents.getState().subagents === beforeRoster) {
			const sameSession =
				sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId === beforeSessionId;
			subagents.getState().setSnapshots([...roster.values()], sameSession);
		}
	}
	const selectedView = agentView?.getState();
	if (
		isCurrent() &&
		selectedView &&
		selectedView.generation === beforeAgentViewGeneration &&
		selectedView.target.kind === "subagent"
	) {
		if (authoritativeRosterReady) {
			await selectedView.reloadSelected();
		} else {
			const error = !mainTranscriptReady
				? hydrationFailureMessage(messagesResult, "Main transcript hydration failed")
				: hydrationFailureMessage(settledSubagents, "Subagent roster hydration failed");
			selectedView.markSelectedLoadError(error);
		}
	}
	await Promise.all([secondaryResult, thinkingLevels]);
}
