import { create } from "zustand";
import type { RemoteHistorySession, RemoteHostCatalogEntry, RemoteHostCatalogSnapshot } from "../../shared/ipc-types";

export type RemoteHistoryStatus = "idle" | "loading" | "ready" | "unsupported" | "error";
export type RemoteCatalogStatus = "idle" | "loading" | "ready" | "error";

export interface RemoteHostState {
	host: RemoteHostCatalogEntry;
	history: RemoteHistorySession[];
	historyStatus: RemoteHistoryStatus;
	historyError: string | null;
	generation: number;
}

interface RemoteStore {
	hosts: Record<string, RemoteHostState>;
	catalogStatus: RemoteCatalogStatus;
	catalogError: string | null;
	loadCatalog(): Promise<void>;
	setCatalog(catalog: RemoteHostCatalogSnapshot): void;
	refreshHistory(alias: string): Promise<void>;
	noteWorkspace(alias: string, cwd: string): Promise<boolean>;
	reset(): void;
}

const initialState: Pick<RemoteStore, "hosts" | "catalogStatus" | "catalogError"> = {
	hosts: {},
	catalogStatus: "idle",
	catalogError: null,
};

let catalogGeneration = 0;
const hostLifetimes = new Map<string, number>();

const HOST_IDENTITY_KEYS = [
	"host",
	"username",
	"port",
	"keyPath",
	"compat",
	"os",
	"shell",
	"transferShell",
	"sourceId",
	"sourceLevel",
] as const;

function sameHostIdentity(left: RemoteHostCatalogEntry, right: RemoteHostCatalogEntry): boolean {
	return (
		left.executableOverride === right.executableOverride &&
		HOST_IDENTITY_KEYS.every(key => left.host[key] === right.host[key])
	);
}

function reconcileHosts(
	current: Record<string, RemoteHostState>,
	catalog: RemoteHostCatalogSnapshot,
): Record<string, RemoteHostState> {
	const hosts: Record<string, RemoteHostState> = {};
	for (const host of catalog.hosts) {
		const existing = current[host.alias];
		if (existing && sameHostIdentity(existing.host, host)) {
			hosts[host.alias] = { ...existing, host };
			continue;
		}
		const lifetime = (hostLifetimes.get(host.alias) ?? 0) + 1;
		hostLifetimes.set(host.alias, lifetime);
		hosts[host.alias] = {
			host,
			history: [],
			historyStatus: "idle",
			historyError: null,
			generation: 0,
		};
	}
	return hosts;
}

function isCurrentHistoryRequest(
	current: RemoteHostState | undefined,
	alias: string,
	generation: number,
	lifetime: number,
): current is RemoteHostState {
	return current !== undefined && current.generation === generation && hostLifetimes.get(alias) === lifetime;
}

export const useRemoteStore = create<RemoteStore>()((set, get) => ({
	...initialState,

	loadCatalog: async () => {
		const generation = ++catalogGeneration;
		set({ catalogStatus: "loading", catalogError: null });
		try {
			const result = await window.omp.remote.catalog();
			if (generation !== catalogGeneration) return;
			if (!result.ok) {
				set({ catalogStatus: "error", catalogError: result.error });
				return;
			}
			set(state => ({
				hosts: reconcileHosts(state.hosts, result.catalog),
				catalogStatus: "ready",
				catalogError: null,
			}));
		} catch (error) {
			if (generation !== catalogGeneration) return;
			set({ catalogStatus: "error", catalogError: String(error) });
		}
	},

	setCatalog: catalog => {
		catalogGeneration += 1;
		set(state => ({
			hosts: reconcileHosts(state.hosts, catalog),
			catalogStatus: "ready",
			catalogError: null,
		}));
	},

	refreshHistory: async alias => {
		const host = get().hosts[alias];
		const lifetime = hostLifetimes.get(alias);
		if (!host || lifetime === undefined) return;
		const generation = host.generation + 1;
		set(state => {
			const current = state.hosts[alias];
			if (!current || hostLifetimes.get(alias) !== lifetime) return state;
			return {
				hosts: {
					...state.hosts,
					[alias]: {
						...current,
						historyStatus: "loading",
						historyError: null,
						generation,
					},
				},
			};
		});
		try {
			const result = await window.omp.remote.listHistory(alias);
			set(state => {
				const current = state.hosts[alias];
				if (!isCurrentHistoryRequest(current, alias, generation, lifetime)) return state;
				if (result.ok) {
					return {
						hosts: {
							...state.hosts,
							[alias]: {
								...current,
								history: result.sessions,
								historyStatus: "ready",
								historyError: null,
							},
						},
					};
				}
				return {
					hosts: {
						...state.hosts,
						[alias]: {
							...current,
							historyStatus: result.unsupported === true ? "unsupported" : "error",
							historyError: result.error,
						},
					},
				};
			});
		} catch (error) {
			set(state => {
				const current = state.hosts[alias];
				if (!isCurrentHistoryRequest(current, alias, generation, lifetime)) return state;
				return {
					hosts: {
						...state.hosts,
						[alias]: {
							...current,
							historyStatus: "error",
							historyError: String(error),
						},
					},
				};
			});
		}
	},

	noteWorkspace: async (alias, cwd) => {
		const generation = ++catalogGeneration;
		try {
			const result = await window.omp.remote.noteWorkspace(alias, cwd);
			if (!result.ok) {
				if (generation === catalogGeneration) {
					set({ catalogStatus: "error", catalogError: result.error });
				}
				return false;
			}
			if (generation === catalogGeneration) {
				set(state => ({
					hosts: reconcileHosts(state.hosts, result.catalog),
					catalogStatus: "ready",
					catalogError: null,
				}));
			}
			return true;
		} catch (error) {
			if (generation === catalogGeneration) {
				set({ catalogStatus: "error", catalogError: String(error) });
			}
			return false;
		}
	},

	reset: () => {
		catalogGeneration += 1;
		set(initialState);
	},
}));
