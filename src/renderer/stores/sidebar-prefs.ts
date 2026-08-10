/**
 * Sidebar presentation prefs: pinned workspaces/sessions (pinned-first
 * ordering) and workspace display aliases (rename). Persisted as one JSON
 * blob under the "sidebar" prefs key via window.omp.prefs (electron-store in
 * main); hydrate once at Sidebar mount, write fire-and-forget on change.
 */
import { create } from "zustand";

const PREFS_KEY = "sidebar";

interface SidebarPrefsBlob {
	pinnedGroups?: string[];
	pinnedSessions?: string[];
	groupAliases?: Record<string, string>;
}

interface SidebarPrefsStore {
	pinnedGroups: string[];
	pinnedSessions: string[];
	groupAliases: Record<string, string>;
	hydrated: boolean;
	hydrate: () => Promise<void>;
	toggleGroupPin: (cwd: string) => void;
	toggleSessionPin: (path: string) => void;
	setGroupAlias: (cwd: string, alias: string | null) => void;
	reset: () => void;
}

function persist(get: () => SidebarPrefsStore): void {
	const blob: SidebarPrefsBlob = {
		pinnedGroups: get().pinnedGroups,
		pinnedSessions: get().pinnedSessions,
		groupAliases: get().groupAliases,
	};
	void window.omp.prefs.set(PREFS_KEY, blob).catch(() => {});
}

export const useSidebarPrefs = create<SidebarPrefsStore>()((set, get) => ({
	pinnedGroups: [],
	pinnedSessions: [],
	groupAliases: {},
	hydrated: false,

	hydrate: async () => {
		if (get().hydrated) return;
		try {
			const blob = (await window.omp.prefs.get(PREFS_KEY)) as SidebarPrefsBlob | null | undefined;
			set({
				pinnedGroups: Array.isArray(blob?.pinnedGroups) ? blob.pinnedGroups : [],
				pinnedSessions: Array.isArray(blob?.pinnedSessions) ? blob.pinnedSessions : [],
				groupAliases: blob?.groupAliases && typeof blob.groupAliases === "object" ? blob.groupAliases : {},
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

	reset: () => set({ pinnedGroups: [], pinnedSessions: [], groupAliases: {}, hydrated: false }),
}));
