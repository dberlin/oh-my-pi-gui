import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	RemoteCatalogResult,
	RemoteHistoryResult,
	RemoteHistorySession,
	RemoteHostCatalogEntry,
	RemoteHostCatalogSnapshot,
	SshSessionTarget,
} from "../../shared/ipc-types";
import { useRemoteStore } from "./remote";

const catalog = vi.fn<() => Promise<RemoteCatalogResult>>();
const listHistory = vi.fn<(hostAlias: string, cursor?: string) => Promise<RemoteHistoryResult>>();
const noteWorkspace = vi.fn<(hostAlias: string, cwd: string) => Promise<RemoteCatalogResult>>();

(globalThis as Record<string, unknown>).window = {
	omp: { remote: { catalog, listHistory, noteWorkspace } },
};

function catalogEntry(alias: string, recentWorkspaces: string[] = []): RemoteHostCatalogEntry {
	return {
		alias,
		host: {
			host: `${alias}.example.com`,
			sourceId: `source-${alias}`,
			sourceLevel: "user",
		},
		recentWorkspaces,
	};
}

function snapshot(hosts: RemoteHostCatalogEntry[]): RemoteHostCatalogSnapshot {
	return { hosts, updatedAt: "2026-08-12T12:00:00.000Z" };
}

function sshTarget(alias: string, cwd: string): SshSessionTarget {
	return {
		type: "ssh",
		hostAlias: alias,
		host: catalogEntry(alias).host,
		originCwd: cwd,
		cwd,
	};
}

function history(alias: string, sessionId: string, cwd = "/srv/app"): RemoteHistorySession {
	return {
		target: sshTarget(alias, cwd),
		sessionId,
		cwd,
		title: null,
		updatedAt: null,
	};
}

afterEach(() => {
	catalog.mockReset();
	listHistory.mockReset();
	noteWorkspace.mockReset();
	useRemoteStore.getState().reset();
});

describe("remote store", () => {
	it("loads catalog rows without fetching host history", async () => {
		catalog.mockResolvedValue({ ok: true, catalog: snapshot([catalogEntry("build"), catalogEntry("prod")]) });

		await useRemoteStore.getState().loadCatalog();

		const state = useRemoteStore.getState();
		expect(state.catalogStatus).toBe("ready");
		expect(Object.keys(state.hosts)).toEqual(["build", "prod"]);
		expect(state.hosts.build).toMatchObject({ history: [], historyStatus: "idle", historyError: null });
		expect(listHistory).not.toHaveBeenCalled();
	});

	it("allows catalog load retry after an error", async () => {
		catalog
			.mockResolvedValueOnce({ ok: false, error: "catalog unavailable" })
			.mockResolvedValueOnce({ ok: true, catalog: snapshot([catalogEntry("build")]) });

		await useRemoteStore.getState().loadCatalog();
		expect(useRemoteStore.getState()).toMatchObject({ catalogStatus: "error", catalogError: "catalog unavailable" });

		await useRemoteStore.getState().loadCatalog();
		expect(useRemoteStore.getState()).toMatchObject({ catalogStatus: "ready", catalogError: null });
		expect(useRemoteStore.getState().hosts.build?.host.alias).toBe("build");
	});

	it("refreshes history lazily for one host and records unsupported history", async () => {
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build"), catalogEntry("legacy")]));
		listHistory
			.mockResolvedValueOnce({ ok: true, sessions: [history("build", "s-1")] })
			.mockResolvedValueOnce({ ok: false, unsupported: true, error: "ACP history unsupported" });

		await useRemoteStore.getState().refreshHistory("build");
		expect(useRemoteStore.getState().hosts.build).toMatchObject({
			historyStatus: "ready",
			historyError: null,
			history: [{ sessionId: "s-1", updatedAt: null }],
		});
		expect(useRemoteStore.getState().hosts.legacy?.historyStatus).toBe("idle");

		await useRemoteStore.getState().refreshHistory("legacy");
		expect(useRemoteStore.getState().hosts.legacy).toMatchObject({
			historyStatus: "unsupported",
			historyError: "ACP history unsupported",
			history: [],
		});
	});

	it("isolates concurrent refresh state by host", async () => {
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build"), catalogEntry("prod")]));
		const build = Promise.withResolvers<RemoteHistoryResult>();
		const prod = Promise.withResolvers<RemoteHistoryResult>();
		listHistory.mockImplementation(alias => (alias === "build" ? build.promise : prod.promise));

		const buildRefresh = useRemoteStore.getState().refreshHistory("build");
		const prodRefresh = useRemoteStore.getState().refreshHistory("prod");
		expect(useRemoteStore.getState().hosts.build?.historyStatus).toBe("loading");
		expect(useRemoteStore.getState().hosts.prod?.historyStatus).toBe("loading");

		build.resolve({ ok: false, error: "build disconnected" });
		await buildRefresh;
		expect(useRemoteStore.getState().hosts.build).toMatchObject({
			historyStatus: "error",
			historyError: "build disconnected",
		});
		expect(useRemoteStore.getState().hosts.prod?.historyStatus).toBe("loading");

		prod.resolve({ ok: true, sessions: [history("prod", "p-1", "/opt/prod")] });
		await prodRefresh;
		expect(useRemoteStore.getState().hosts.prod).toMatchObject({
			historyStatus: "ready",
			history: [{ sessionId: "p-1" }],
		});
	});

	it("suppresses stale same-host completions with a per-alias generation", async () => {
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build")]));
		const older = Promise.withResolvers<RemoteHistoryResult>();
		const newer = Promise.withResolvers<RemoteHistoryResult>();
		listHistory.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);

		const olderRefresh = useRemoteStore.getState().refreshHistory("build");
		const newerRefresh = useRemoteStore.getState().refreshHistory("build");
		newer.resolve({ ok: true, sessions: [history("build", "new")] });
		await newerRefresh;
		older.resolve({ ok: false, error: "stale failure" });
		await olderRefresh;

		expect(useRemoteStore.getState().hosts.build).toMatchObject({
			generation: 2,
			historyStatus: "ready",
			historyError: null,
			history: [{ sessionId: "new" }],
		});
	});

	it("invalidates a removed host's pending generation before the alias is re-added", async () => {
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build")]));
		const removedHostRefresh = Promise.withResolvers<RemoteHistoryResult>();
		const readdedHostRefresh = Promise.withResolvers<RemoteHistoryResult>();
		listHistory.mockReturnValueOnce(removedHostRefresh.promise).mockReturnValueOnce(readdedHostRefresh.promise);

		const staleRefresh = useRemoteStore.getState().refreshHistory("build");
		useRemoteStore.getState().setCatalog(snapshot([]));
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build")]));
		const currentRefresh = useRemoteStore.getState().refreshHistory("build");
		readdedHostRefresh.resolve({ ok: true, sessions: [history("build", "current")] });
		await currentRefresh;
		removedHostRefresh.resolve({ ok: false, error: "removed host completion" });
		await staleRefresh;

		expect(useRemoteStore.getState().hosts.build).toMatchObject({
			historyStatus: "ready",
			historyError: null,
			history: [{ sessionId: "current" }],
		});
	});

	it.each([
		{
			identity: "endpoint",
			update: (entry: RemoteHostCatalogEntry): RemoteHostCatalogEntry => ({
				...entry,
				host: { ...entry.host, host: "replacement.example.com" },
			}),
		},
		{
			identity: "connection",
			update: (entry: RemoteHostCatalogEntry): RemoteHostCatalogEntry => ({
				...entry,
				host: { ...entry.host, username: "replacement-user" },
			}),
		},
		{
			identity: "executable override",
			update: (entry: RemoteHostCatalogEntry): RemoteHostCatalogEntry => ({
				...entry,
				executableOverride: "/opt/replacement/omp",
			}),
		},
	])("resets history and rejects an old in-flight completion when the $identity changes", async ({ update }) => {
		const original = catalogEntry("build", ["/srv/old"]);
		useRemoteStore.getState().setCatalog(snapshot([original]));
		listHistory.mockResolvedValueOnce({ ok: true, sessions: [history("build", "old")] });
		await useRemoteStore.getState().refreshHistory("build");
		const stale = Promise.withResolvers<RemoteHistoryResult>();
		listHistory.mockReturnValueOnce(stale.promise);

		const staleRefresh = useRemoteStore.getState().refreshHistory("build");
		const replacement = update(original);
		useRemoteStore.getState().setCatalog(snapshot([replacement]));

		expect(useRemoteStore.getState().hosts.build).toMatchObject({
			host: replacement,
			history: [],
			historyStatus: "idle",
			historyError: null,
			generation: 0,
		});

		stale.resolve({ ok: true, sessions: [history("build", "stale")] });
		await staleRefresh;
		expect(useRemoteStore.getState().hosts.build).toMatchObject({
			history: [],
			historyStatus: "idle",
			historyError: null,
		});
	});

	it("preserves history lifetime across a recents-only catalog update", async () => {
		const original = catalogEntry("build", ["/srv/old"]);
		useRemoteStore.getState().setCatalog(snapshot([original]));
		listHistory.mockResolvedValueOnce({ ok: true, sessions: [history("build", "old")] });
		await useRemoteStore.getState().refreshHistory("build");
		const current = Promise.withResolvers<RemoteHistoryResult>();
		listHistory.mockReturnValueOnce(current.promise);

		const refresh = useRemoteStore.getState().refreshHistory("build");
		useRemoteStore.getState().setCatalog(snapshot([{ ...original, recentWorkspaces: ["/srv/new", "/srv/old"] }]));
		expect(useRemoteStore.getState().hosts.build).toMatchObject({
			history: [{ sessionId: "old" }],
			historyStatus: "loading",
			generation: 2,
		});

		current.resolve({ ok: true, sessions: [history("build", "current")] });
		await refresh;
		expect(useRemoteStore.getState().hosts.build).toMatchObject({
			history: [{ sessionId: "current" }],
			historyStatus: "ready",
			historyError: null,
		});
	});

	it("reconciles recent workspace catalog rows without mutating open-tab target snapshots", async () => {
		const original = catalogEntry("build", ["/srv/old"]);
		useRemoteStore.getState().setCatalog(snapshot([original]));
		const openTabTarget: SshSessionTarget = {
			type: "ssh",
			hostAlias: original.alias,
			host: original.host,
			originCwd: "/srv/old",
			cwd: "/srv/old",
			executableOverride: "/opt/omp-old",
		};
		noteWorkspace.mockResolvedValue({
			ok: true,
			catalog: snapshot([
				{
					...catalogEntry("build", ["/srv/new", "/srv/old"]),
					executableOverride: "/opt/omp-new",
				},
			]),
		});

		const noted = await useRemoteStore.getState().noteWorkspace("build", "/srv/new");

		expect(noted).toBe(true);
		expect(useRemoteStore.getState().hosts.build?.host.recentWorkspaces).toEqual(["/srv/new", "/srv/old"]);
		expect(openTabTarget).toEqual({
			type: "ssh",
			hostAlias: "build",
			host: original.host,
			originCwd: "/srv/old",
			cwd: "/srv/old",
			executableOverride: "/opt/omp-old",
		});
	});

	it("does not repopulate catalog when a successful workspace note completes after reset", async () => {
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build", ["/srv/old"])]));
		const pending = Promise.withResolvers<RemoteCatalogResult>();
		noteWorkspace.mockReturnValueOnce(pending.promise);

		const noting = useRemoteStore.getState().noteWorkspace("build", "/srv/late");
		useRemoteStore.getState().reset();
		pending.resolve({
			ok: true,
			catalog: snapshot([catalogEntry("build", ["/srv/late", "/srv/old"])]),
		});

		expect(await noting).toBe(true);
		expect(useRemoteStore.getState()).toMatchObject({
			hosts: {},
			catalogStatus: "idle",
			catalogError: null,
		});
	});

	it("does not overwrite a newer catalog when an older workspace note completes", async () => {
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build", ["/srv/old"])]));
		const pending = Promise.withResolvers<RemoteCatalogResult>();
		noteWorkspace.mockReturnValueOnce(pending.promise);

		const noting = useRemoteStore.getState().noteWorkspace("build", "/srv/stale");
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build", ["/srv/current", "/srv/old"])]));
		pending.resolve({
			ok: true,
			catalog: snapshot([catalogEntry("build", ["/srv/stale", "/srv/old"])]),
		});

		expect(await noting).toBe(true);
		expect(useRemoteStore.getState().hosts.build?.host.recentWorkspaces).toEqual(["/srv/current", "/srv/old"]);
	});

	it("settles a superseded catalog load when workspace note returns an error", async () => {
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build", ["/srv/old"])]));
		const pendingLoad = Promise.withResolvers<RemoteCatalogResult>();
		catalog.mockReturnValueOnce(pendingLoad.promise);
		noteWorkspace.mockResolvedValueOnce({ ok: false, error: "workspace note rejected" });

		const loading = useRemoteStore.getState().loadCatalog();
		expect(useRemoteStore.getState().catalogStatus).toBe("loading");
		const noted = await useRemoteStore.getState().noteWorkspace("build", "/srv/new");

		expect(noted).toBe(false);
		expect(useRemoteStore.getState()).toMatchObject({
			catalogStatus: "error",
			catalogError: "workspace note rejected",
		});
		expect(useRemoteStore.getState().hosts.build?.host.recentWorkspaces).toEqual(["/srv/old"]);

		pendingLoad.resolve({ ok: true, catalog: snapshot([catalogEntry("stale")]) });
		await loading;
		expect(useRemoteStore.getState().hosts.build?.host.alias).toBe("build");
	});

	it("settles a superseded catalog load when workspace note IPC throws", async () => {
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build", ["/srv/old"])]));
		const pendingLoad = Promise.withResolvers<RemoteCatalogResult>();
		catalog.mockReturnValueOnce(pendingLoad.promise);
		noteWorkspace.mockRejectedValueOnce(new Error("workspace note disconnected"));

		const loading = useRemoteStore.getState().loadCatalog();
		expect(useRemoteStore.getState().catalogStatus).toBe("loading");
		const noted = await useRemoteStore.getState().noteWorkspace("build", "/srv/new");

		expect(noted).toBe(false);
		expect(useRemoteStore.getState()).toMatchObject({
			catalogStatus: "error",
			catalogError: "Error: workspace note disconnected",
		});
		expect(useRemoteStore.getState().hosts.build?.host.recentWorkspaces).toEqual(["/srv/old"]);

		pendingLoad.resolve({ ok: true, catalog: snapshot([catalogEntry("stale")]) });
		await loading;
		expect(useRemoteStore.getState().hosts.build?.host.alias).toBe("build");
	});

	it("reset clears catalog state and invalidates pending history completions after re-add", async () => {
		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build")]));
		const pending = Promise.withResolvers<RemoteHistoryResult>();
		const afterReset = Promise.withResolvers<RemoteHistoryResult>();
		listHistory.mockReturnValueOnce(pending.promise).mockReturnValueOnce(afterReset.promise);
		const refreshing = useRemoteStore.getState().refreshHistory("build");

		useRemoteStore.getState().reset();
		expect(useRemoteStore.getState()).toMatchObject({
			hosts: {},
			catalogStatus: "idle",
			catalogError: null,
		});

		useRemoteStore.getState().setCatalog(snapshot([catalogEntry("build")]));
		const currentRefresh = useRemoteStore.getState().refreshHistory("build");
		afterReset.resolve({ ok: true, sessions: [history("build", "current")] });
		await currentRefresh;
		pending.resolve({ ok: true, sessions: [history("build", "late")] });
		await refreshing;

		expect(useRemoteStore.getState().hosts.build).toMatchObject({
			historyStatus: "ready",
			history: [{ sessionId: "current" }],
		});
	});
});
