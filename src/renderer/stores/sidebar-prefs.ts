/**
 * Sidebar presentation prefs: pinned workspaces/sessions, explicit MRU access
 * times, and workspace display aliases (rename). Persisted as one JSON blob
 * under the "sidebar" prefs key via window.omp.prefs (electron-store in main);
 * hydrate once at App mount, write fire-and-forget on change.
 */
import { create } from "zustand";

const PREFS_KEY = "sidebar";

interface SidebarPrefsBlob {
	pinnedGroups?: string[];
	pinnedSessions?: string[];
	groupAliases?: Record<string, string>;
	workspaceLastUsed?: Record<string, number>;
	sessionLastUsed?: Record<string, number>;
}

interface SidebarPrefsStore {
	pinnedGroups: string[];
	pinnedSessions: string[];
	groupAliases: Record<string, string>;
	workspaceLastUsed: Record<string, number>;
	sessionLastUsed: Record<string, number>;
	hydrated: boolean;
	hydrate: () => Promise<void>;
	toggleGroupPin: (cwd: string) => void;
	toggleSessionPin: (path: string) => void;
	setGroupAlias: (cwd: string, alias: string | null) => void;
	touchWorkspace: (cwd: string) => void;
	touchSession: (path: string, cwd?: string) => void;
	reset: () => void;
}

const MAX_RECENT_WORKSPACES = 100;
const MAX_RECENT_SESSIONS = 500;

function validRecencyMap(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, number> = {};
	for (const [key, timestamp] of Object.entries(value)) {
		if (key && typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) {
			result[key] = timestamp;
		}
	}
	return result;
}

function nextTimestamp(...maps: Record<string, number>[]): number {
	let latest = 0;
	for (const map of maps) {
		for (const value of Object.values(map)) latest = Math.max(latest, value);
	}
	return Math.max(Date.now(), latest + 1);
}

function touchedMap(
	current: Record<string, number>,
	key: string,
	timestamp: number,
	limit: number,
): Record<string, number> {
	const entries = Object.entries({ ...current, [key]: timestamp }).sort((a, b) => b[1] - a[1]);
	return Object.fromEntries(entries.slice(0, limit));
}

function persist(get: () => SidebarPrefsStore): void {
	const blob: SidebarPrefsBlob = {
		pinnedGroups: get().pinnedGroups,
		pinnedSessions: get().pinnedSessions,
		groupAliases: get().groupAliases,
		workspaceLastUsed: get().workspaceLastUsed,
		sessionLastUsed: get().sessionLastUsed,
	};
	void window.omp.prefs.set(PREFS_KEY, blob).catch(() => {});
}

export const useSidebarPrefs = create<SidebarPrefsStore>()((set, get) => ({
	pinnedGroups: [],
	pinnedSessions: [],
	groupAliases: {},
	workspaceLastUsed: {},
	sessionLastUsed: {},
	hydrated: false,

	hydrate: async () => {
		if (get().hydrated) return;
		try {
			const blob = (await window.omp.prefs.get(PREFS_KEY)) as SidebarPrefsBlob | null | undefined;
			set({
				pinnedGroups: Array.isArray(blob?.pinnedGroups) ? blob.pinnedGroups : [],
				pinnedSessions: Array.isArray(blob?.pinnedSessions) ? blob.pinnedSessions : [],
				groupAliases: blob?.groupAliases && typeof blob.groupAliases === "object" ? blob.groupAliases : {},
				workspaceLastUsed: validRecencyMap(blob?.workspaceLastUsed),
				sessionLastUsed: validRecencyMap(blob?.sessionLastUsed),
				hydrated: true,
			});
		} catch {
			set({ hydrated: true });
		}
	},

	toggleGroupPin: cwd => {
		set(state => ({
			pinnedGroups: state.pinnedGroups.includes(cwd)
				? state.pinnedGroups.filter(item => item !== cwd)
				: [...state.pinnedGroups, cwd],
		}));
		persist(get);
	},

	toggleSessionPin: path => {
		set(state => ({
			pinnedSessions: state.pinnedSessions.includes(path)
				? state.pinnedSessions.filter(item => item !== path)
				: [...state.pinnedSessions, path],
		}));
		persist(get);
	},

	setGroupAlias: (cwd, alias) => {
		set(state => {
			const groupAliases = { ...state.groupAliases };
			if (alias?.trim()) groupAliases[cwd] = alias.trim();
			else delete groupAliases[cwd];
			return { groupAliases };
		});
		persist(get);
	},

	touchWorkspace: cwd => {
		if (!cwd) return;
		const state = get();
		const timestamp = nextTimestamp(state.workspaceLastUsed, state.sessionLastUsed);
		set({ workspaceLastUsed: touchedMap(state.workspaceLastUsed, cwd, timestamp, MAX_RECENT_WORKSPACES) });
		persist(get);
	},

	touchSession: (path, cwd) => {
		if (!path) return;
		const state = get();
		const timestamp = nextTimestamp(state.workspaceLastUsed, state.sessionLastUsed);
		set({
			sessionLastUsed: touchedMap(state.sessionLastUsed, path, timestamp, MAX_RECENT_SESSIONS),
			workspaceLastUsed: cwd
				? touchedMap(state.workspaceLastUsed, cwd, timestamp, MAX_RECENT_WORKSPACES)
				: state.workspaceLastUsed,
		});
		persist(get);
	},

	reset: () =>
		set({
			pinnedGroups: [],
			pinnedSessions: [],
			groupAliases: {},
			workspaceLastUsed: {},
			sessionLastUsed: {},
			hydrated: false,
		}),
}));
