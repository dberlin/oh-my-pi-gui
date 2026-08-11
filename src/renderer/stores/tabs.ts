/**
 * Session tabs: in-window multi-session parallelism. Each tab owns a sidecar
 * in the main-process pool; every tab keeps running in the background while
 * exactly one is attached to this window's stores.
 *
 * Renderer-side pieces:
 * - The tab list (title/cwd/status/unreadDone) fed by GET_TABS boot
 *   reconciliation plus the light TAB_STATUS channel (fires for EVERY tab,
 *   unlike the full event channels which only forward the active tab's).
 * - switchTab: snapshot the current tab's session-scoped store slices into a
 *   per-tab bundle, restore the target's bundle (or empty) for instant paint,
 *   SET_ACTIVE_TAB so main re-wires event routing, then hydrateSession for
 *   the authoritative pull. The bundle is what makes the switch instant and
 *   preserves the composer draft.
 *
 * Wire shapes (IpcTabInfo / IpcTabStatusPayload / IpcSpawnTabPayload) and the
 * main-process pool live in the main slice — this store only consumes
 * window.omp.tabs.* and window.omp.events.onTabStatus.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type {
	IpcSpawnTabResult,
	IpcTabInfo,
	IpcTabStatusPayload,
	IpcTabWorktree,
	SessionKind,
	TabStatus,
} from "../../shared/ipc-types";
import type {
	ContextUsage,
	ExtensionUIRequest,
	ModelInfo,
	RpcLoopModeState,
	RpcQueuedMessage,
	RpcSessionState,
	ThinkingLevel,
	TodoTask,
} from "../../shared/rpc-types";
import { hydrateSession, resetRetryPending } from "../hooks/use-rpc-events";
import { basename } from "../lib/format";
import { translate } from "../lib/i18n";
import {
	acceptsActiveTabEvents,
	beginTabRoute,
	reconcileTabRoute,
	resetTabRoute,
	settleTabRoute,
} from "../lib/tab-routing";
import { type ComposerImage, useComposerStore } from "./composer";
import { applyExtensionUiRequest, type ExtensionUiSnapshot, useExtensionUiStore } from "./extension-ui";
import { useForkHandoffStore } from "./fork-handoff";
import { type MessagesSnapshot, useMessagesStore } from "./messages";
import { useModelStore } from "./model";
import {
	type PendingPlanProposal,
	type PlanApprovalSnapshot,
	type PlanApprovalSubmitState,
	usePlanApprovalStore,
} from "./plan-approval";
import { useQueueStore } from "./queue";
import { useSessionStore } from "./session";
import { type SubagentNode, useSubagentsStore } from "./subagents";
import { toast } from "./toast";
import { type TodoSnapshot, type UiTodoPhase, useTodoStore } from "./todo";
import { useToolsStore } from "./tools";
import { useUiStore } from "./ui";

export interface SessionTab {
	id: string;
	cwd: string;
	status: TabStatus;
	/** Immutable session kind, fixed when this tab's sidecar was spawned. */
	kind: SessionKind;
	/**
	 * Git-worktree binding (plan/20), immutable from spawn. Drives the chip's
	 * GitBranch marker, the untitled label (worktree name over the hash-suffixed
	 * basename), and the close-time cleanup prompt.
	 */
	worktree?: IpcTabWorktree;
	/** Session title when known (session_info_update via TAB_STATUS). */
	title?: string;
	sessionId?: string;
	/** A run completed while this tab was in the background. */
	unreadDone: boolean;
	/** Session to open once this tab's sidecar first reports ready (the
	 * open-session-in-new-tab flow — the sidecar starts on a fresh session and
	 * must be switched over before its transcript hydrates). */
	pendingSessionPath?: string;
}

/** Session-store fields that survive a tab switch. Transient loaders
 * (awaitingModelSince/retryInfo/compactionInfo) are deliberately excluded —
 * they re-arm from live events and hydration on return. */
interface SessionSlice {
	sessionId: string;
	sessionName: string | null;
	sessionFile: string | null;
	cwd: string;
	isStreaming: boolean;
	isCompacting: boolean;
	contextUsage: ContextUsage | null;
	messageCount: number;
	queuedMessageCount: number;
	planModeEnabled: boolean;
	prewalkArmed: boolean;
	agentsPaused: boolean;
	agentsPausedAt: number | null;
	goal: { objective?: string } | null;
	goalState: { status?: string } | null;
	loopMode: RpcLoopModeState | null;
	vibeModeEnabled: boolean;
}

interface ModelSlice {
	model: ModelInfo | null;
	thinkingLevel: ThinkingLevel | undefined;
	thinkingConfigured: ThinkingLevel | "auto" | undefined;
	availableThinkingLevels: ThinkingLevel[];
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	availableModels: ModelInfo[];
}

/** Per-tab bundle: every session-scoped store slice captured on switch-away. */
interface SessionTabBundle {
	session: SessionSlice;
	messages: MessagesSnapshot;
	todos: {
		phases: UiTodoPhase[];
		reminderVisible: boolean;
		reminderTodos: TodoTask[];
		history: TodoSnapshot[];
		historyHydrated: boolean;
	};
	subagents: Map<string, SubagentNode>;
	queue: { steering: RpcQueuedMessage[]; followUp: RpcQueuedMessage[] };
	model: ModelSlice;
	composer: { draft: string; images: ComposerImage[] };
	planApproval: PlanApprovalSnapshot;
	extensionUi: ExtensionUiSnapshot;
}

const EMPTY_MODEL_SLICE: ModelSlice = {
	model: null,
	thinkingLevel: undefined,
	thinkingConfigured: undefined,
	availableThinkingLevels: [],
	fastModeEnabled: false,
	fastModeActive: false,
	tokensPerSecond: null,
	availableModels: [],
};

// IPC routing is window-global. Serialize switches so rapid tab clicks cannot
// resolve out of order and leave main forwarding the wrong sidecar. The version
// makes superseded switches skip hydration; only the latest visible tab may
// project sidecar state back into the shared renderer stores.
let switchVersion = 0;
let routingChain: Promise<void> = Promise.resolve();

function routeActiveTab(tabId: string): Promise<boolean> {
	const request = routingChain.then(() => window.omp.tabs.setActive(tabId));
	routingChain = request.then(
		() => undefined,
		() => undefined,
	);
	return request;
}

/** Snapshot the session-scoped slices of the currently attached tab. */
function captureBundle(): SessionTabBundle {
	const session = useSessionStore.getState();
	const todos = useTodoStore.getState();
	const queue = useQueueStore.getState();
	const model = useModelStore.getState();
	const composer = useComposerStore.getState();
	const planApproval = usePlanApprovalStore.getState();
	const extensionUi = useExtensionUiStore.getState();
	return {
		session: {
			sessionId: session.sessionId,
			sessionName: session.sessionName,
			sessionFile: session.sessionFile,
			cwd: session.cwd,
			isStreaming: session.isStreaming,
			isCompacting: session.isCompacting,
			contextUsage: session.contextUsage,
			messageCount: session.messageCount,
			queuedMessageCount: session.queuedMessageCount,
			planModeEnabled: session.planModeEnabled,
			prewalkArmed: session.prewalkArmed,
			agentsPaused: session.agentsPaused,
			agentsPausedAt: session.agentsPausedAt,
			goal: session.goal,
			goalState: session.goalState,
			loopMode: session.loopMode,
			vibeModeEnabled: session.vibeModeEnabled,
		},
		messages: useMessagesStore.getState().snapshot(),
		todos: {
			phases: todos.phases,
			reminderVisible: todos.reminderVisible,
			reminderTodos: todos.reminderTodos,
			history: todos.history,
			historyHydrated: todos.historyHydrated,
		},
		subagents: new Map(useSubagentsStore.getState().subagents),
		queue: { steering: queue.steering, followUp: queue.followUp },
		model: {
			model: model.model,
			thinkingLevel: model.thinkingLevel,
			thinkingConfigured: model.thinkingConfigured,
			availableThinkingLevels: model.availableThinkingLevels,
			fastModeEnabled: model.fastModeEnabled,
			fastModeActive: model.fastModeActive,
			tokensPerSecond: model.tokensPerSecond,
			availableModels: model.availableModels,
		},
		composer: {
			draft: composer.draft,
			images: composer.images,
		},
		planApproval: {
			pending: planApproval.pending,
			feedback: planApproval.feedback,
			notice: planApproval.notice,
			submitting: planApproval.submitting,
		},
		extensionUi: {
			pendingRequests: extensionUi.pendingRequests,
			statusWidgets: { ...extensionUi.statusWidgets },
			widgetPanels: { ...extensionUi.widgetPanels },
		},
	};
}

/**
 * Restore a tab's bundle (null → empty session state). The tab ENTRY is the
 * fresher source for sidecar status/cwd/run-state: background status pushes
 * update the entry while the bundle froze at switch-away time.
 */
function restoreBundle(bundle: SessionTabBundle | null, tab: SessionTab | undefined): void {
	// The auto-retry gate lives outside the stores (module-level in
	// use-rpc-events), so bundles can't carry it: clear it on every switch to
	// keep the outgoing tab's mid-retry state from suppressing the restored
	// tab's agent_end notification/toast.
	resetRetryPending();
	const session = bundle?.session;
	useSessionStore.setState({
		sessionId: session?.sessionId ?? "",
		sessionName: session?.sessionName ?? null,
		sessionFile: session?.sessionFile ?? null,
		cwd: tab?.cwd || session?.cwd || "",
		isStreaming: tab?.status === "running",
		isCompacting: session?.isCompacting ?? false,
		awaitingModelSince: null,
		retryInfo: null,
		compactionInfo: null,
		status: tab ? (tab.status === "running" ? "ready" : tab.status) : "starting",
		contextUsage: session?.contextUsage ?? null,
		messageCount: session?.messageCount ?? 0,
		queuedMessageCount: session?.queuedMessageCount ?? 0,
		planModeEnabled: session?.planModeEnabled ?? false,
		prewalkArmed: session?.prewalkArmed ?? false,
		agentsPaused: session?.agentsPaused ?? false,
		agentsPausedAt: session?.agentsPausedAt ?? null,
		goal: session?.goal ?? null,
		goalState: session?.goalState ?? null,
		loopMode: session?.loopMode ?? null,
		vibeModeEnabled: session?.vibeModeEnabled ?? false,
	});
	useMessagesStore.getState().restoreSnapshot(bundle?.messages ?? null);
	useTodoStore.setState(
		bundle?.todos ?? { phases: [], reminderVisible: false, reminderTodos: [], history: [], historyHydrated: false },
	);
	useSubagentsStore.setState({ subagents: bundle ? new Map(bundle.subagents) : new Map() });
	useQueueStore.setState(bundle?.queue ?? { steering: [], followUp: [] });
	useModelStore.setState(bundle?.model ?? EMPTY_MODEL_SLICE);
	useComposerStore.setState(bundle?.composer ?? { draft: "", images: [] });
	usePlanApprovalStore.setState(
		bundle?.planApproval ?? { pending: null, feedback: "", notice: null, submitting: null },
	);
	useExtensionUiStore.setState(bundle?.extensionUi ?? { pendingRequests: [], statusWidgets: {}, widgetPanels: {} });
	// Tool cards derive from the transcript; rebuild them for the restored
	// messages so the switch paints this tab's tools, not the previous tab's.
	useToolsStore.getState().hydrateMessages(useMessagesStore.getState().messages);
}

/**
 * Chip label for the tab strip (F-HYDRATE): session title when known, else
 * the cwd basename (both empty → the localized "New session"). Identical
 * UNTITLED labels disambiguate with a short index suffix ("gui #2") — the
 * common same-cwd parallel-tabs case. Titled tabs are never suffixed: an
 * explicit title is itself the disambiguator, and the suffix disappears as
 * soon as a title arrives.
 */
export function tabChipLabel(tab: SessionTab, tabs: readonly SessionTab[]): string {
	// `||` everywhere: empty-string titles (never-generated auto-title slot)
	// fall through like null. Worktree tabs label by their worktree NAME — the
	// cwd basename is the hash-suffixed dir (gui-<name>-<hash7>), unreadable.
	const base = tab.title || tab.worktree?.name || basename(tab.cwd) || translate("sidebar.newSession");
	if (tab.title) return base;
	let occurrence = 0;
	for (const entry of tabs) {
		if (entry.title) continue;
		if ((entry.worktree?.name || basename(entry.cwd) || translate("sidebar.newSession")) !== base) continue;
		occurrence += 1;
		if (entry.id === tab.id) break;
	}
	return occurrence > 1 ? `${base} #${occurrence}` : base;
}

/**
 * Kind of the window's active tab ("agent" default). THE single read point
 * for every chat-mode UI gate — components must never re-derive kind from
 * session state, argv, or the session file.
 */
export function useActiveTabKind(): SessionKind {
	return useTabsStore(state => state.tabs.find(tab => tab.id === state.activeTabId)?.kind ?? "agent");
}

interface TabsStore {
	tabs: SessionTab[];
	activeTabId: string | null;
	/** Parked session state per background tab (the active tab's state is live in the stores). */
	bundles: Map<string, SessionTabBundle>;
	/** Boot reconciliation with the main-process pool: the window's initial
	 * sidecar arrives as tab 0 and must never be duplicated — entries merge by
	 * id, preserving local flags (unreadDone, pendingSessionPath). */
	reconcileTabs: () => Promise<boolean>;
	/** Spawn a new background tab (same cwd unless given) and switch to it.
	 * Returns the tabId, or null at the pool cap. `kind` is immutable once
	 * the tab's sidecar is spawned ("agent" default; "chat" = tool-free).
	 * `worktree` binds the tab to a git worktree created by a prior
	 * worktree_create RPC (cwd must be the worktree path). */
	openTab: (args?: {
		cwd?: string;
		sessionPath?: string;
		kind?: SessionKind;
		worktree?: IpcTabWorktree;
	}) => Promise<string | null>;
	/** Park the current tab's session state, restore the target's, re-point
	 * main's event routing (SET_ACTIVE_TAB), then hydrate from its sidecar. */
	switchTab: (id: string) => Promise<void>;
	/** Close a tab (keeps ≥1). Closing the active tab activates its neighbor first. */
	closeTab: (id: string) => Promise<void>;
	/** Merge a TAB_STATUS push: upsert the entry, stamp unreadDone when a
	 * background run settles (running → ready while not active). */
	applyTabStatus: (payload: IpcTabStatusPayload) => void;
	reset: () => void;
}

export const useTabsStore = create<TabsStore>()((set, get) => ({
	tabs: [],
	activeTabId: null,
	bundles: new Map(),

	reconcileTabs: async () => {
		let list: IpcTabInfo[];
		try {
			list = await window.omp.tabs.list();
		} catch {
			// Pre-tabs main (dev mismatch) or bridge down — the tab strip simply
			// stays empty and TAB_STATUS pushes rebuild it.
			return false;
		}
		set(state => {
			const leftovers = new Map(state.tabs.map(tab => [tab.id, tab]));
			const merged: SessionTab[] = list.map(info => {
				const existing = leftovers.get(info.tabId);
				leftovers.delete(info.tabId);
				return {
					id: info.tabId,
					cwd: info.cwd || existing?.cwd || "",
					status: info.status,
					kind: info.kind ?? existing?.kind ?? "agent",
					worktree: info.worktree ?? existing?.worktree,
					title: info.title ?? existing?.title,
					sessionId: info.sessionId ?? existing?.sessionId,
					unreadDone: existing?.unreadDone ?? false,
					pendingSessionPath: existing?.pendingSessionPath,
				};
			});
			// Entries the reply doesn't know (a spawn reply raced this reconcile)
			// survive appended at the end.
			const tabs = [...merged, ...leftovers.values()];
			const activeTabId =
				state.activeTabId && tabs.some(tab => tab.id === state.activeTabId)
					? state.activeTabId
					: (tabs[0]?.id ?? null);
			return { tabs, activeTabId };
		});
		// After a renderer reload with multiple tabs, re-converge main's active
		// tab with the renderer's pick (main defaults to the oldest).
		const activeTabId = get().activeTabId;
		const needsRoute = get().tabs.length > 1 && activeTabId !== null;
		reconcileTabRoute(activeTabId, !needsRoute);
		if (needsRoute && activeTabId) {
			try {
				const routed = await routeActiveTab(activeTabId);
				if (routed) settleTabRoute(activeTabId);
				return routed;
			} catch {
				// Best-effort — the next explicit switchTab re-points routing.
				return false;
			}
		}
		return true;
	},

	openTab: async args => {
		const cwd = args?.cwd ?? useSessionStore.getState().cwd;
		const kind = args?.kind ?? "agent";
		let result: IpcSpawnTabResult | null;
		try {
			result = await window.omp.tabs.spawn({
				cwd: cwd || undefined,
				sessionPath: args?.sessionPath,
				kind,
				worktree: args?.worktree,
			});
		} catch (error) {
			toast({ variant: "error", title: translate("tabs.newFailed"), message: String(error) });
			return null;
		}
		if (!result) {
			toast({ variant: "warning", message: translate("tabs.parallelCap") });
			return null;
		}
		// Cross-kind refusal: the target session file carries a different kind —
		// no conversion path exists (I2), so surface it and stay put.
		if (result.tabId === null && result.refusal === "kind-mismatch") {
			toast({ variant: "error", title: translate("tabs.newFailed"), message: translate("tabs.kindMismatch") });
			return null;
		}
		// F-OWN belt guard: the session file is already attached to a tab, so
		// main refused the double-attach. Owner lives in THIS window → switch
		// to it; a foreign window's tab → focus that window (main focuses the
		// owner window for an owned sessionPath instead of spawning).
		if (result.tabId === null) {
			const ownerTabId = result.ownerTabId ?? null;
			if (ownerTabId && get().tabs.some(tab => tab.id === ownerTabId)) {
				await get().switchTab(ownerTabId);
				return ownerTabId;
			}
			if (args?.sessionPath) {
				try {
					await window.omp.sessions.openInNewWindow({ sessionPath: args.sessionPath });
				} catch {
					// Best-effort focus — the owner window may be mid-teardown.
				}
			}
			return ownerTabId;
		}
		const { tabId } = result;
		// Upsert eagerly — the fresh sidecar's first TAB_STATUS can beat the reply.
		set(state => {
			const existing = state.tabs.find(tab => tab.id === tabId);
			if (existing) {
				if (!args?.sessionPath || existing.pendingSessionPath === args.sessionPath) return state;
				return {
					tabs: state.tabs.map(tab => (tab.id === tabId ? { ...tab, pendingSessionPath: args.sessionPath } : tab)),
				};
			}
			const tab: SessionTab = {
				id: tabId,
				cwd,
				status: "starting",
				kind,
				worktree: args?.worktree,
				unreadDone: false,
				pendingSessionPath: args?.sessionPath,
			};
			return { tabs: [...state.tabs, tab] };
		});
		await get().switchTab(tabId);
		return tabId;
	},

	switchTab: async id => {
		const state = get();
		if (id === state.activeTabId) return;
		const target = state.tabs.find(tab => tab.id === id);
		if (!target) return;
		const version = ++switchVersion;
		beginTabRoute(state.activeTabId, id);
		// Live voice owns the currently routed sidecar and audio device. Close it
		// immediately, then stop that sidecar before routing the window elsewhere.
		const ui = useUiStore.getState();
		const stopLive = ui.liveOpen ? window.omp.rpc.liveStop() : null;
		ui.closeSessionOverlays();
		useForkHandoffStore.getState().closeHandoffDialog();
		// 1. Park the CURRENT tab's session state; stamp its run state from
		//    foreground knowledge so the chip keeps the streaming dot until the
		//    pool's next status push for that tab.
		const wasStreaming = useSessionStore.getState().isStreaming;
		const bundles = new Map(state.bundles);
		if (state.activeTabId) bundles.set(state.activeTabId, captureBundle());
		set({
			activeTabId: id,
			bundles,
			tabs: state.tabs.map(tab => {
				if (tab.id === id) return { ...tab, unreadDone: false };
				if (tab.id === state.activeTabId && wasStreaming && tab.status === "ready") {
					return { ...tab, status: "running" };
				}
				return tab;
			}),
		});
		// 2. Restore the target's bundle (or empty) for instant paint.
		restoreBundle(bundles.get(id) ?? null, target);
		// 3. Re-point main's event routing at the target's sidecar, THEN hydrate
		//    (hydrate's RPCs resolve through the active tab server-side).
		try {
			if (stopLive) {
				const stopped = await stopLive;
				if (!stopped.success) {
					toast({ variant: "error", title: translate("tabs.switchFailed"), message: stopped.error });
				}
			}
			const routed = await routeActiveTab(id);
			if (!routed) throw new Error(`Tab ${id} is no longer available`);
			settleTabRoute(id);
		} catch (error) {
			if (version !== switchVersion) return;
			// Routing never re-pointed: main still forwards the PREVIOUS tab's
			// events, so hydrating here would pull that sidecar's session into
			// this tab's restored stores. Surface the failure and re-converge
			// from GET_TABS — reconcile also retries SET_ACTIVE_TAB for the
			// renderer's pick, re-pointing routing when the failure was
			// transient — instead of silently diverging.
			toast({ variant: "error", title: translate("tabs.switchFailed"), message: String(error) });
			const converged = await get().reconcileTabs();
			if (version !== switchVersion) return;
			if (converged && get().activeTabId === id) await hydrateSession();
			return;
		}
		if (version !== switchVersion) return;
		// A freshly spawned sidecar can become ready on the light TAB_STATUS
		// channel before SET_ACTIVE_TAB wires its full status channel. In that
		// case no ready event will replay after routing, so hydrate from the
		// tab's latest status here. A still-starting sidecar will deliver its
		// normal full ready event after the route is attached.
		const routedTab = get().tabs.find(tab => tab.id === id);
		if (routedTab?.status === "ready" || routedTab?.status === "running") {
			useSessionStore.getState().setStatus("ready", routedTab.cwd);
			await hydrateSession();
		}
	},

	closeTab: async id => {
		const state = get();
		if (state.tabs.length <= 1) return;
		const index = state.tabs.findIndex(tab => tab.id === id);
		if (index === -1) return;
		if (id === state.activeTabId) {
			// Activate a neighbor BEFORE releasing — main's routing needs a live
			// target and the window keeps painting a real session. Prefer the
			// right neighbor (it shifts into the closed slot), else the left.
			const neighbor = state.tabs[index + 1] ?? state.tabs[index - 1];
			if (neighbor) await get().switchTab(neighbor.id);
		}
		set(current => {
			const bundles = new Map(current.bundles);
			bundles.delete(id);
			return { tabs: current.tabs.filter(tab => tab.id !== id), bundles };
		});
		try {
			await window.omp.tabs.close(id);
		} catch {
			// Pre-tabs main (dev mismatch) tolerance; the entry is already gone.
		}
	},

	applyTabStatus: payload => {
		const active = get().activeTabId === payload.tabId;
		set(state => {
			const index = state.tabs.findIndex(tab => tab.id === payload.tabId);
			const previous = index >= 0 ? state.tabs[index] : undefined;
			// A background tab's run settled → done badge until the user visits.
			const completedInBackground =
				payload.tabId !== state.activeTabId && previous?.status === "running" && payload.status === "ready";
			const next: SessionTab = {
				id: payload.tabId,
				cwd: payload.cwd || previous?.cwd || "",
				status: payload.status,
				kind: payload.kind ?? previous?.kind ?? "agent",
				worktree: payload.worktree ?? previous?.worktree,
				title: payload.title ?? previous?.title,
				sessionId: payload.sessionId ?? previous?.sessionId,
				unreadDone: completedInBackground ? true : (previous?.unreadDone ?? false),
				pendingSessionPath: previous?.pendingSessionPath,
			};
			if (index === -1) return { tabs: [...state.tabs, next] };
			const tabs = [...state.tabs];
			tabs[index] = next;
			return { tabs };
		});
		// TAB_STATUS is keyed, so it remains safe while the window-global route
		// is converging. Keep the visible session's connection state aligned with
		// its chip; routeReady still prevents commands until SET_ACTIVE_TAB lands.
		if (active) {
			useSessionStore.getState().setStatus(payload.status === "running" ? "ready" : payload.status, payload.cwd);
		}
	},

	reset: () => {
		switchVersion += 1;
		resetTabRoute();
		set({ tabs: [], activeTabId: null, bundles: new Map() });
	},
}));

/** Route an extension UI frame into the tab that raised it. Blocking dialogs,
 * status text, and widgets disappear while that tab is parked and return with
 * it; a late IPC delivery can never leak into the newly selected tab. */
export function pushTabExtensionUiRequest(tabId: string, request: ExtensionUIRequest): void {
	const state = useTabsStore.getState();
	if (state.activeTabId === tabId) {
		useExtensionUiStore.getState().pushRequest(request);
		return;
	}
	const bundle = state.bundles.get(tabId);
	if (!bundle) return;
	const bundles = new Map(state.bundles);
	bundles.set(tabId, { ...bundle, extensionUi: applyExtensionUiRequest(bundle.extensionUi, request) });
	useTabsStore.setState({ bundles });
}

/** Restore a failed submit to the tab that issued it, even when that tab is now
 * parked in the background. A response from one sidecar must never inject its
 * draft or attachments into whichever tab happens to be visible later. */
export function restoreTabComposer(
	tabId: string | null,
	sessionId: string,
	draft: string,
	images: ComposerImage[],
): void {
	if (!tabId) return;
	const prependDraft = (current: string): string => (current ? `${draft}\n${current}` : draft);
	const state = useTabsStore.getState();
	if (state.activeTabId === tabId) {
		if (useSessionStore.getState().sessionId !== sessionId) return;
		useComposerStore.setState(current => ({
			draft: prependDraft(current.draft),
			images: [...images, ...current.images],
		}));
		return;
	}
	const bundle = state.bundles.get(tabId);
	if (!bundle || bundle.session.sessionId !== sessionId) return;
	const bundles = new Map(state.bundles);
	bundles.set(tabId, {
		...bundle,
		composer: {
			draft: prependDraft(bundle.composer.draft),
			images: [...images, ...bundle.composer.images],
		},
	});
	useTabsStore.setState({ bundles });
}

/** Finish a plan-approval request in the tab that issued it. The response may
 * arrive after the user switched elsewhere, so both the proposal UI and the
 * plan-mode flag are updated in that tab's parked bundle instead of whichever
 * session happens to be visible. */
export function settleTabPlanApproval(
	tabId: string | null,
	sessionId: string,
	target: PendingPlanProposal,
	result: {
		clear?: boolean;
		notice?: string | null;
		submitting?: PlanApprovalSubmitState | null;
		exitPlanMode?: boolean;
	},
): void {
	const tabs = useTabsStore.getState();
	if (tabId === null || tabs.activeTabId === tabId) {
		if (useSessionStore.getState().sessionId !== sessionId) return;
		const plan = usePlanApprovalStore.getState();
		if (plan.pending !== target) return;
		usePlanApprovalStore.setState({
			pending: result.clear ? null : target,
			feedback: result.clear ? "" : plan.feedback,
			notice: result.clear ? null : result.notice === undefined ? plan.notice : result.notice,
			submitting: result.clear ? null : result.submitting === undefined ? plan.submitting : result.submitting,
		});
		if (result.exitPlanMode) useSessionStore.setState({ planModeEnabled: false });
		return;
	}
	const bundle = tabs.bundles.get(tabId);
	if (!bundle || bundle.session.sessionId !== sessionId || bundle.planApproval.pending !== target) return;
	const bundles = new Map(tabs.bundles);
	bundles.set(tabId, {
		...bundle,
		session: result.exitPlanMode ? { ...bundle.session, planModeEnabled: false } : bundle.session,
		planApproval: {
			pending: result.clear ? null : target,
			feedback: result.clear ? "" : bundle.planApproval.feedback,
			notice: result.clear ? null : result.notice === undefined ? bundle.planApproval.notice : result.notice,
			submitting: result.clear
				? null
				: result.submitting === undefined
					? bundle.planApproval.submitting
					: result.submitting,
		},
	});
	useTabsStore.setState({ bundles });
}

/**
 * Boot wiring for session tabs: GET_TABS reconciliation (the window's initial
 * sidecar arrives as tab 0) plus the TAB_STATUS subscription. Also completes
 * the open-in-new-tab flow: when a tab spawned with a sessionPath first
 * reports ready while active, switch its sidecar to that session and hydrate.
 * Call once in App.tsx alongside useRpcEvents().
 */
export function useSessionTabs(): void {
	useEffect(() => {
		void useTabsStore.getState().reconcileTabs();
		const subscribe = window.omp.events.onTabStatus;
		if (typeof subscribe !== "function") return;
		return subscribe.call(window.omp.events, payload => {
			useTabsStore.getState().applyTabStatus(payload);
			if (payload.status !== "ready") return;
			const state = useTabsStore.getState();
			const tab = state.tabs.find(entry => entry.id === payload.tabId);
			// Per-tab subagent subscription (F-HYDRATE): a sidecar only forwards
			// subagent frames once subscribed, and RPC commands route through
			// the ACTIVE tab — so subscribe at each tab's ready-while-active
			// moment. Background tabs can't be routed to; hydrateSession
			// re-asserts the subscription on switch-in.
			if (payload.tabId === state.activeTabId) {
				void window.omp.rpc.setSubagentSubscription("events");
				if (!tab?.pendingSessionPath) {
					// Light TAB_STATUS is registered before the full active-tab channel.
					// If ready raced SET_ACTIVE_TAB, the full ready event was already
					// missed. Give a concurrently delivered full event one turn to run;
					// otherwise make the light event authoritative and hydrate here.
					setTimeout(() => {
						if (!acceptsActiveTabEvents() || useTabsStore.getState().activeTabId !== payload.tabId) return;
						if (useSessionStore.getState().sessionId) return;
						void hydrateSession();
					}, 0);
				}
			}
			if (!tab?.pendingSessionPath || tab.id !== state.activeTabId) return;
			// Clear before the RPC so a duplicate ready push can't re-enter.
			const sessionPath = tab.pendingSessionPath;
			useTabsStore.setState(current => ({
				tabs: current.tabs.map(entry =>
					entry.id === tab.id ? { ...entry, pendingSessionPath: undefined } : entry,
				),
			}));
			void (async () => {
				// A sidecar spawned WITH --session is already on the pending
				// session by the time it reports ready: switching again would
				// abort the in-flight resume. Gate on get_state and only switch
				// when the sidecar's sessionFile differs (a failed read keeps
				// the old behavior — switch unconditionally).
				const state = await window.omp.rpc.getState();
				const currentFile =
					state.success && state.data != null ? (state.data as RpcSessionState).sessionFile : undefined;
				if (currentFile !== sessionPath) {
					const response = await window.omp.rpc.switchSession(sessionPath);
					if (!response.success) {
						toast({ variant: "error", title: translate("sidebar.openFailed"), message: response.error });
						return;
					}
				}
				await hydrateSession();
			})();
		});
	}, []);
}
