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
import type { IpcTabInfo, IpcTabStatusPayload, TabStatus } from "../../shared/ipc-types";
import type {
	ContextUsage,
	ModelInfo,
	RpcLoopModeState,
	RpcQueuedMessage,
	ThinkingLevel,
	TodoTask,
} from "../../shared/rpc-types";
import { hydrateSession } from "../hooks/use-rpc-events";
import { translate } from "../lib/i18n";
import { useComposerStore } from "./composer";
import { type MessagesSnapshot, useMessagesStore } from "./messages";
import { useModelStore } from "./model";
import { useQueueStore } from "./queue";
import { useSessionStore } from "./session";
import { type SubagentNode, useSubagentsStore } from "./subagents";
import { toast } from "./toast";
import { type UiTodoPhase, useTodoStore } from "./todo";
import { useToolsStore } from "./tools";

export interface SessionTab {
	id: string;
	cwd: string;
	status: TabStatus;
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
	todos: { phases: UiTodoPhase[]; reminderVisible: boolean; reminderTodos: TodoTask[] };
	subagents: Map<string, SubagentNode>;
	queue: { steering: RpcQueuedMessage[]; followUp: RpcQueuedMessage[] };
	model: ModelSlice;
	composerDraft: string;
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

/** Snapshot the session-scoped slices of the currently attached tab. */
function captureBundle(): SessionTabBundle {
	const session = useSessionStore.getState();
	const todos = useTodoStore.getState();
	const queue = useQueueStore.getState();
	const model = useModelStore.getState();
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
		todos: { phases: todos.phases, reminderVisible: todos.reminderVisible, reminderTodos: todos.reminderTodos },
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
		composerDraft: useComposerStore.getState().draft,
	};
}

/**
 * Restore a tab's bundle (null → empty session state). The tab ENTRY is the
 * fresher source for sidecar status/cwd/run-state: background status pushes
 * update the entry while the bundle froze at switch-away time.
 */
function restoreBundle(bundle: SessionTabBundle | null, tab: SessionTab | undefined): void {
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
	useTodoStore.setState(bundle?.todos ?? { phases: [], reminderVisible: false, reminderTodos: [] });
	useSubagentsStore.setState({ subagents: bundle ? new Map(bundle.subagents) : new Map() });
	useQueueStore.setState(bundle?.queue ?? { steering: [], followUp: [] });
	useModelStore.setState(bundle?.model ?? EMPTY_MODEL_SLICE);
	useComposerStore.getState().setDraft(bundle?.composerDraft ?? "");
	// Tool cards derive from the transcript; rebuild them for the restored
	// messages so the switch paints this tab's tools, not the previous tab's.
	useToolsStore.getState().hydrateMessages(useMessagesStore.getState().messages);
}

interface TabsStore {
	tabs: SessionTab[];
	activeTabId: string | null;
	/** Parked session state per background tab (the active tab's state is live in the stores). */
	bundles: Map<string, SessionTabBundle>;
	/** Boot reconciliation with the main-process pool: the window's initial
	 * sidecar arrives as tab 0 and must never be duplicated — entries merge by
	 * id, preserving local flags (unreadDone, pendingSessionPath). */
	reconcileTabs: () => Promise<void>;
	/** Spawn a new background tab (same cwd unless given) and switch to it.
	 * Returns the tabId, or null at the pool cap. */
	openTab: (args?: { cwd?: string; sessionPath?: string }) => Promise<string | null>;
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
			return;
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
		if (list.length > 1 && activeTabId) {
			try {
				await window.omp.tabs.setActive(activeTabId);
			} catch {
				// Best-effort — the next explicit switchTab re-points routing.
			}
		}
	},

	openTab: async args => {
		const cwd = args?.cwd ?? useSessionStore.getState().cwd;
		let result: { tabId: string } | null;
		try {
			result = await window.omp.tabs.spawn({ cwd: cwd || undefined, sessionPath: args?.sessionPath });
		} catch (error) {
			toast({ variant: "error", title: translate("tabs.newFailed"), message: String(error) });
			return null;
		}
		if (!result) {
			toast({ variant: "warning", message: translate("tabs.parallelCap") });
			return null;
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
			await window.omp.tabs.setActive(id);
		} catch {
			// Pre-tabs main (dev mismatch): hydrate still pulls the window's one
			// sidecar, the best available truth.
		}
		await hydrateSession();
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
			// Same dev-mismatch tolerance as switchTab; the entry is already gone.
		}
	},

	applyTabStatus: payload => {
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
	},

	reset: () => set({ tabs: [], activeTabId: null, bundles: new Map() }),
}));

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
			if (!tab?.pendingSessionPath || tab.id !== state.activeTabId) return;
			// Clear before the RPC so a duplicate ready push can't re-enter.
			const sessionPath = tab.pendingSessionPath;
			useTabsStore.setState(current => ({
				tabs: current.tabs.map(entry =>
					entry.id === tab.id ? { ...entry, pendingSessionPath: undefined } : entry,
				),
			}));
			void (async () => {
				const response = await window.omp.rpc.switchSession(sessionPath);
				if (!response.success) {
					toast({ variant: "error", title: translate("sidebar.openFailed"), message: response.error });
					return;
				}
				await hydrateSession();
			})();
		});
	}, []);
}
