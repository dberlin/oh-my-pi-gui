import { create } from "zustand";

export const ACTIVITY_SIDEBAR_DEFAULT_WIDTH = 300;
export const ACTIVITY_SIDEBAR_MIN_WIDTH = 240;
export const ACTIVITY_SIDEBAR_MAX_WIDTH = 420;
export const ACTIVITY_SIDEBAR_COMPACT_WIDTH = 40;
export const ACTIVITY_TRANSCRIPT_MIN_WIDTH = 560;
export const ACTIVITY_TREE_MIN_BODY_HEIGHT = 48;

export type ActivitySectionId = "plan" | "goal" | "todo" | "agents";
export type ActivityTreeId = "todo" | "agents";

export interface ActivitySidebarStore {
	width: number;
	hydrated: boolean;
	manualCollapsed: boolean;
	splitRatio: number;
	treeCollapsed: Record<ActivityTreeId, boolean>;
	expandedMeta: "plan" | "goal" | null;
	focusRequest: { id: ActivitySectionId; seq: number } | null;
	narrowOverrideTabId: string | null;
	hydrate: () => Promise<void>;
	commitWidth: (width: number) => void;
	setManualCollapsed: (collapsed: boolean) => void;
	setSplitRatio: (ratio: number) => void;
	resetSplitRatio: () => void;
	toggleTree: (id: ActivityTreeId) => void;
	toggleMeta: (id: "plan" | "goal") => void;
	revealSection: (id: ActivitySectionId | null, tabId: string) => void;
	clearNarrowOverride: (activeTabId: string | null) => void;
	reset: () => void;
}

const PREFS_KEY = "activity-sidebar-v1";
const DEFAULT_SPLIT_RATIO = 0.5;
let widthRevision = 0;
let resetRevision = 0;

interface ActivitySidebarPrefs {
	width: number;
}

interface ActivitySidebarState {
	width: number;
	hydrated: boolean;
	manualCollapsed: boolean;
	splitRatio: number;
	treeCollapsed: Record<ActivityTreeId, boolean>;
	expandedMeta: "plan" | "goal" | null;
	focusRequest: { id: ActivitySectionId; seq: number } | null;
	narrowOverrideTabId: string | null;
}

function initialState(): ActivitySidebarState {
	return {
		width: ACTIVITY_SIDEBAR_DEFAULT_WIDTH,
		hydrated: false,
		manualCollapsed: false,
		splitRatio: DEFAULT_SPLIT_RATIO,
		treeCollapsed: { todo: false, agents: false },
		expandedMeta: null,
		focusRequest: null,
		narrowOverrideTabId: null,
	};
}

function clampWidth(width: unknown): number {
	if (typeof width !== "number" || !Number.isFinite(width)) return ACTIVITY_SIDEBAR_DEFAULT_WIDTH;
	return Math.min(ACTIVITY_SIDEBAR_MAX_WIDTH, Math.max(ACTIVITY_SIDEBAR_MIN_WIDTH, width));
}

function clampSplitRatio(ratio: number): number {
	if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
	return Math.min(1, Math.max(0, ratio));
}

export const useActivitySidebarStore = create<ActivitySidebarStore>()((set, get) => ({
	...initialState(),

	hydrate: async () => {
		if (get().hydrated) return;
		const widthRevisionAtStart = widthRevision;
		const resetRevisionAtStart = resetRevision;
		let hydratedWidth = ACTIVITY_SIDEBAR_DEFAULT_WIDTH;
		try {
			const stored = (await window.omp.prefs.get(PREFS_KEY)) as Partial<ActivitySidebarPrefs> | null | undefined;
			hydratedWidth = clampWidth(stored?.width);
		} catch {
			// Preference I/O is best-effort; the default remains available.
		}
		if (resetRevision !== resetRevisionAtStart) return;
		set(state => ({
			width: widthRevision === widthRevisionAtStart ? hydratedWidth : state.width,
			hydrated: true,
		}));
	},

	commitWidth: width => {
		widthRevision += 1;
		const committedWidth = clampWidth(width);
		set({ width: committedWidth });
		void window.omp.prefs.set(PREFS_KEY, { width: committedWidth }).catch(() => {});
	},

	setManualCollapsed: collapsed => {
		set(collapsed ? { manualCollapsed: true, narrowOverrideTabId: null } : { manualCollapsed: false });
	},

	setSplitRatio: ratio => set({ splitRatio: clampSplitRatio(ratio) }),
	resetSplitRatio: () => set({ splitRatio: DEFAULT_SPLIT_RATIO }),

	toggleTree: id => {
		set(state => ({ treeCollapsed: { ...state.treeCollapsed, [id]: !state.treeCollapsed[id] } }));
	},

	toggleMeta: id => {
		set(state => ({ expandedMeta: state.expandedMeta === id ? null : id }));
	},

	revealSection: (id, tabId) => {
		set(state => {
			const revealed: Partial<ActivitySidebarState> = {
				manualCollapsed: false,
				narrowOverrideTabId: tabId,
			};
			if (id === null) return revealed;
			revealed.focusRequest = { id, seq: (state.focusRequest?.seq ?? 0) + 1 };
			if (id === "plan" || id === "goal") revealed.expandedMeta = id;
			else revealed.treeCollapsed = { ...state.treeCollapsed, [id]: false };
			return revealed;
		});
	},

	clearNarrowOverride: activeTabId => {
		set(state => (state.narrowOverrideTabId !== activeTabId ? { narrowOverrideTabId: null } : state));
	},

	reset: () => {
		widthRevision += 1;
		resetRevision += 1;
		set(initialState());
	},
}));
