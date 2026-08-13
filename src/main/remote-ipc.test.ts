import { describe, expect, it, vi } from "vitest";
import type {
	IpcFsListResult,
	IpcFsReadImageResult,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	RemoteDirectoryListResult,
	RemoteDirectoryValidationResult,
	RemoteHistoryResult,
	RemotePreflightResult,
	SessionTarget,
	SshSessionTarget,
} from "../shared/ipc-types";
import type { RpcResponse, RpcSshHostInfo } from "../shared/rpc-types";
import { RemoteHostCatalog, type RemoteHostCatalogPrefs, type RemoteHostCatalogStore } from "./remote-host-catalog";
import {
	authorizeRemoteSpawnTargetAtSink,
	authorizeRemoteTargetAtSink,
	dispatchRemoteCatalog,
	dispatchRemoteHistory,
	dispatchRemoteListDirectories,
	dispatchRemoteNoteWorkspace,
	dispatchRemoteOverride,
	dispatchRemotePreflight,
	dispatchRemoteValidateDirectory,
	dispatchWorkspaceList,
	dispatchWorkspaceRead,
	dispatchWorkspaceReadImage,
	dispatchWorkspaceReadPlan,
	observeRemoteCatalogRpcResponse,
	type RemoteIpcDispatchDeps,
	RemoteRequestRegistry,
	RemoteResumeGrantRegistry,
	RemoteWorkspaceTrust,
	resolveNewWindowRequest,
	type WorkspaceDispatchDeps,
	type WorkspaceTabIdentity,
} from "./remote-ipc";
import type { RemoteWorkspaceListResult } from "./remote-ssh";

const BUILD_HOST: RpcSshHostInfo = {
	name: "build",
	host: "build.example.com",
	username: "deploy",
	port: 2222,
	keyPath: "/keys/build",
	compat: false,
	description: "Build host",
	scope: "user",
	editable: true,
	source: "/home/user/.omp/ssh.json",
	os: "linux",
	shell: "bash",
	transferShell: "sh",
};

const PROD_HOST: RpcSshHostInfo = {
	name: "prod",
	host: "prod.example.com",
	scope: "project",
	editable: true,
	source: "/repo/.omp/ssh.json",
	os: "linux",
	shell: "sh",
};

class MemoryCatalogStore implements RemoteHostCatalogStore {
	readonly #values: RemoteHostCatalogPrefs = {};

	get<Key extends keyof RemoteHostCatalogPrefs>(key: Key): RemoteHostCatalogPrefs[Key] | undefined {
		return this.#values[key];
	}

	set<Key extends keyof RemoteHostCatalogPrefs>(key: Key, value: RemoteHostCatalogPrefs[Key]): void {
		this.#values[key] = value;
	}
}

function catalogWith(hosts: RpcSshHostInfo[] = [BUILD_HOST]): RemoteHostCatalog {
	const store = new MemoryCatalogStore();
	const catalog = new RemoteHostCatalog(store, { now: () => "2026-08-12T12:00:00.000Z" });
	catalog.replaceFromRpc(hosts);
	return catalog;
}

function sshTarget(catalog: RemoteIpcDispatchDeps["catalog"], alias = "build", cwd = "/srv/app"): SshSessionTarget {
	const target = catalog.target(alias, cwd);
	if (!target) throw new Error("fixture target missing");
	return target;
}

function remoteDeps(
	catalog: RemoteIpcDispatchDeps["catalog"] = catalogWith(),
	tabs: WorkspaceTabIdentity[] = [],
): RemoteIpcDispatchDeps {
	const ownedTabs = new Map(tabs.map(tab => [tab.tabId, tab]));
	return {
		catalog,
		lookupTab: tabId => ownedTabs.get(tabId) ?? null,
		ssh: {
			preflight: vi.fn(
				async (target: SshSessionTarget): Promise<RemotePreflightResult> => ({
					ok: true,
					target,
					home: "/home/deploy",
					platform: "linux",
					executable: "/usr/bin/omp",
				}),
			),
			listDirectories: vi.fn(
				async (_target: SshSessionTarget, path: string): Promise<RemoteDirectoryListResult> => ({
					ok: true,
					path,
					parent: "/srv",
					entries: [],
				}),
			),
			validateDirectory: vi.fn(
				async (_target: SshSessionTarget, path: string): Promise<RemoteDirectoryValidationResult> => ({
					ok: true,
					path,
				}),
			),
		},
		acp: {
			listSessions: vi.fn(async (): Promise<RemoteHistoryResult> => ({ ok: true, sessions: [] })),
		},
	};
}

function localTab(tabId = "local-tab"): WorkspaceTabIdentity {
	return { tabId, target: { type: "local" } };
}

function remoteTab(target: SshSessionTarget, tabId = "remote-tab"): WorkspaceTabIdentity {
	return { tabId, target };
}

function workspaceDeps(
	catalog: WorkspaceDispatchDeps["catalog"],
	current: WorkspaceTabIdentity[],
	trust = new RemoteWorkspaceTrust(),
): WorkspaceDispatchDeps {
	const tabs = new Map(current.map(tab => [tab.tabId, tab]));
	return {
		catalog,
		lookupTab: (tabId: string) => tabs.get(tabId) ?? null,
		trust,
		local: {
			list: vi.fn(async (): Promise<IpcFsListResult> => ({ ok: true, entries: [], truncated: false })),
			read: vi.fn(
				async (): Promise<IpcFsReadResult> => ({
					ok: true,
					content: "local",
					truncated: false,
					binary: false,
					size: 5,
				}),
			),
			readImage: vi.fn(
				async (): Promise<IpcFsReadImageResult> => ({
					ok: true,
					dataUrl: "data:image/png;base64,bG9jYWw=",
					mime: "image/png",
					size: 5,
				}),
			),
			readPlan: vi.fn(
				async (): Promise<IpcFsReadPlanResult> => ({
					ok: true,
					path: "/local/plan.md",
					content: "local plan",
				}),
			),
		},
		remote: {
			listWorkspace: vi.fn(
				async (): Promise<RemoteWorkspaceListResult> => ({
					ok: true,
					entries: [{ name: "remote.ts", path: "remote.ts", kind: "file" }],
					truncated: false,
				}),
			),
			readFile: vi.fn(async () => ({
				ok: true as const,
				data: new Uint8Array(Buffer.from("remote", "utf8")),
				size: 6,
				truncated: false,
			})),
		},
	};
}

describe("remote IPC dispatch", () => {
	it("rejects malformed payloads and unknown aliases without invoking remote services", async () => {
		const deps = remoteDeps();
		const target = sshTarget(deps.catalog);

		expect(await dispatchRemoteCatalog(deps, { unexpected: true })).toEqual({
			ok: false,
			error: "Invalid catalog request",
		});
		expect(await dispatchRemoteOverride(deps, { hostAlias: "missing", value: "/usr/bin/omp" })).toEqual({
			ok: false,
			error: "Unknown remote host",
		});
		expect(await dispatchRemoteNoteWorkspace(deps, { hostAlias: " missing ", cwd: "/srv/app" })).toEqual({
			ok: false,
			error: "Invalid remote host alias",
		});
		expect(await dispatchRemoteListDirectories(deps, { target, path: "/srv/app", showHidden: "yes" })).toEqual({
			ok: false,
			error: "Invalid remote directory request",
		});
		expect(deps.ssh.listDirectories).not.toHaveBeenCalled();
	});

	it("rejects altered host snapshots and executable overrides before preflight", async () => {
		const catalog = catalogWith();
		catalog.setExecutableOverride("build", "/opt/omp");
		const deps = remoteDeps(catalog);
		const canonical = sshTarget(catalog);
		const alteredHost: SshSessionTarget = { ...canonical, host: { ...canonical.host, port: 22 } };
		const alteredOverride: SshSessionTarget = { ...canonical, executableOverride: "/tmp/omp" };

		expect(await dispatchRemotePreflight(deps, { target: alteredHost })).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(await dispatchRemotePreflight(deps, { target: alteredOverride })).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(deps.ssh.preflight).not.toHaveBeenCalled();
	});

	it("replaces the catalog from a local get_ssh_hosts response but rejects an SSH tab response", () => {
		const catalog = catalogWith([BUILD_HOST, PROD_HOST]);
		const validResponse: RpcResponse = {
			type: "response",
			command: "get_ssh_hosts",
			success: true,
			data: { openSshAvailable: true, hosts: [BUILD_HOST], warnings: [] },
		};
		const remoteTarget = sshTarget(catalog);

		expect(observeRemoteCatalogRpcResponse(catalog, remoteTarget, { type: "get_ssh_hosts" }, validResponse)).toBe(
			false,
		);
		expect(catalog.snapshot().hosts.map(host => host.alias)).toEqual(["build", "prod"]);
		expect(
			observeRemoteCatalogRpcResponse(catalog, { type: "local" }, { type: "get_ssh_hosts" }, validResponse),
		).toBe(true);
		expect(catalog.snapshot().hosts.map(host => host.alias)).toEqual(["build"]);

		const before = catalog.snapshot();
		const rejected: Array<{ command: { type: "get_ssh_hosts" | "get_state" }; response: RpcResponse }> = [
			{
				command: { type: "get_state" },
				response: validResponse,
			},
			{
				command: { type: "get_ssh_hosts" },
				response: { ...validResponse, command: "get_state" },
			},
			{
				command: { type: "get_ssh_hosts" },
				response: { type: "response", command: "get_ssh_hosts", success: false, error: "unavailable" },
			},
			{
				command: { type: "get_ssh_hosts" },
				response: {
					...validResponse,
					data: { openSshAvailable: true, hosts: [{ ...BUILD_HOST, scope: "invalid" }], warnings: [] },
				},
			},
			{
				command: { type: "get_ssh_hosts" },
				response: {
					...validResponse,
					data: { openSshAvailable: true, hosts: [PROD_HOST], warnings: ["ok"], extra: true },
				},
			},
		];
		for (const item of rejected) {
			expect(observeRemoteCatalogRpcResponse(catalog, { type: "local" }, item.command, item.response)).toBe(false);
			expect(catalog.snapshot()).toEqual(before);
		}
	});

	it("refreshes the canonical catalog before returning its snapshot and falls back after refresh failure", async () => {
		const deps = remoteDeps() as RemoteIpcDispatchDeps & { refreshCatalog: () => Promise<void> };
		deps.refreshCatalog = vi.fn(async () => {
			deps.catalog.replaceFromRpc([PROD_HOST]);
		});

		expect(await dispatchRemoteCatalog(deps, {})).toEqual({
			ok: true,
			catalog: deps.catalog.snapshot(),
		});
		expect(deps.refreshCatalog).toHaveBeenCalledOnce();
		expect(deps.catalog.snapshot().hosts.map(host => host.alias)).toEqual(["prod"]);

		deps.refreshCatalog = vi.fn(async () => {
			throw new Error("local sidecar disconnected");
		});
		const cached = deps.catalog.snapshot();
		expect(await dispatchRemoteCatalog(deps, {})).toEqual({ ok: true, catalog: cached });
	});

	it("authorizes remote targets against catalog truth and an exact canonical directory at the sink", async () => {
		const catalog = catalogWith();
		catalog.setExecutableOverride("build", "/opt/omp");
		const deps = remoteDeps(catalog);
		const target = sshTarget(catalog);
		const alteredHost = { ...target, host: { ...target.host, host: "attacker.example" } };
		const alteredOverride = { ...target, executableOverride: "/tmp/omp" };
		const sink = vi.fn((canonical: SshSessionTarget) => canonical);

		expect(await authorizeRemoteTargetAtSink(deps, { target: alteredHost, cwd: target.cwd }, sink)).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(await authorizeRemoteTargetAtSink(deps, { target: alteredOverride, cwd: target.cwd }, sink)).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(await authorizeRemoteTargetAtSink(deps, { target, cwd: "/srv/other" }, sink)).toEqual({
			ok: false,
			error: "Remote cwd does not match target",
		});
		expect(deps.ssh.validateDirectory).not.toHaveBeenCalled();
		expect(sink).not.toHaveBeenCalled();

		vi.mocked(deps.ssh.validateDirectory)
			.mockResolvedValueOnce({ ok: false, error: "denied" })
			.mockResolvedValueOnce({ ok: true, path: "/srv/app/" })
			.mockResolvedValueOnce({ ok: true, path: "/srv/app" });
		expect(await authorizeRemoteTargetAtSink(deps, { target, cwd: target.cwd }, sink)).toEqual({
			ok: false,
			error: "denied",
		});
		expect(await authorizeRemoteTargetAtSink(deps, { target, cwd: target.cwd }, sink)).toEqual({
			ok: false,
			error: "Remote directory changed during validation",
		});
		const authorized = await authorizeRemoteTargetAtSink(deps, { target, cwd: target.cwd }, sink);
		expect(authorized).toEqual({ ok: true, value: target });
		expect(sink).toHaveBeenCalledTimes(1);
		const sinkTarget = sink.mock.calls[0]?.[0];
		expect(sinkTarget).not.toBe(target);
		expect(sinkTarget?.host).not.toBe(target.host);
	});

	it("authorizes a remote tab spawn synchronously without a duplicate directory probe", () => {
		const catalog = catalogWith();
		const deps = remoteDeps(catalog);
		const target = sshTarget(catalog);
		const sink = vi.fn((canonical: SshSessionTarget) => canonical);

		expect(authorizeRemoteSpawnTargetAtSink(deps, { target, cwd: target.cwd }, sink)).toEqual({
			ok: true,
			value: target,
		});
		expect(deps.ssh.validateDirectory).not.toHaveBeenCalled();
		expect(sink).toHaveBeenCalledOnce();
		expect(sink.mock.calls[0]?.[0]).not.toBe(target);
	});

	it("runs a remote new-window sink synchronously with the final catalog snapshot", async () => {
		const catalog = catalogWith();
		const deps = remoteDeps(catalog);
		const target = sshTarget(catalog);
		const originalTarget = catalog.target.bind(catalog);
		let targetLookups = 0;
		let catalogReplaced = false;
		vi.spyOn(catalog, "target").mockImplementation((alias: string, cwd: string) => {
			const result = originalTarget(alias, cwd);
			targetLookups++;
			if (targetLookups === 2) {
				queueMicrotask(() => {
					catalog.replaceFromRpc([{ ...BUILD_HOST, host: "replacement.example.com" }]);
					catalogReplaced = true;
				});
			}
			return result;
		});
		const spawnWindow = vi.fn((canonical: SshSessionTarget) => {
			expect(catalogReplaced).toBe(false);
			return canonical.host.host;
		});

		expect(await authorizeRemoteTargetAtSink(deps, { target, cwd: target.cwd }, spawnWindow)).toEqual({
			ok: true,
			value: "build.example.com",
		});
		expect(spawnWindow).toHaveBeenCalledTimes(1);
		expect(catalogReplaced).toBe(true);
	});

	it("uses canonical targets for directory operations and normalizes thrown failures", async () => {
		const deps = remoteDeps();
		const target = sshTarget(deps.catalog);
		vi.mocked(deps.ssh.validateDirectory).mockRejectedValueOnce(new Error("ssh disconnected"));

		expect(await dispatchRemoteListDirectories(deps, { target, path: "/srv/app", showHidden: false })).toEqual({
			ok: true,
			path: "/srv/app",
			parent: "/srv",
			entries: [],
		});
		expect(await dispatchRemoteValidateDirectory(deps, { target, path: "/srv/app" })).toEqual({
			ok: false,
			error: "ssh disconnected",
		});
		expect(deps.ssh.listDirectories).toHaveBeenCalledWith(target, "/srv/app", false, undefined, expect.any(Function));
	});
	it("rejects an unopened preflight when its catalog target is deleted before the probe child starts", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const deps = remoteDeps(catalog);
		const spawned = vi.fn();
		vi.mocked(deps.ssh.preflight).mockImplementation(
			async (
				_candidate: SshSessionTarget,
				_signal?: AbortSignal,
				finalAuthorization?: () => SshSessionTarget | null,
			): Promise<RemotePreflightResult> => {
				catalog.replaceFromRpc([]);
				const fresh = finalAuthorization?.();
				if (!fresh) {
					if (finalAuthorization) return { ok: false, error: "Stale or altered SSH target" };
					spawned();
					return {
						ok: true,
						target,
						home: "/home/deploy",
						platform: "linux",
						executable: "/usr/bin/omp",
					};
				}
				spawned();
				return {
					ok: true,
					target: fresh,
					home: "/home/deploy",
					platform: "linux",
					executable: "/usr/bin/omp",
				};
			},
		);

		expect(await dispatchRemotePreflight(deps, { target })).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(spawned).not.toHaveBeenCalled();
	});

	it("rejects an unopened directory listing when its catalog target changes after runtime discovery", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const deps = remoteDeps(catalog);
		const spawned = vi.fn();
		vi.mocked(deps.ssh.listDirectories).mockImplementation(
			async (
				_candidate: SshSessionTarget,
				path: string,
				_showHidden: boolean,
				_signal?: AbortSignal,
				finalAuthorization?: () => SshSessionTarget | null,
			): Promise<RemoteDirectoryListResult> => {
				catalog.replaceFromRpc([{ ...BUILD_HOST, host: "replacement.example.com" }]);
				const fresh = finalAuthorization?.();
				if (!fresh) {
					if (finalAuthorization) return { ok: false, error: "Stale or altered SSH target" };
					spawned();
					return { ok: true, path, parent: "/srv", entries: [] };
				}
				spawned();
				return { ok: true, path, parent: "/srv", entries: [] };
			},
		);

		expect(await dispatchRemoteListDirectories(deps, { target, path: "/srv/app", showHidden: false })).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(spawned).not.toHaveBeenCalled();
	});

	it("rejects unopened directory validation when its catalog target is deleted after runtime discovery", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const deps = remoteDeps(catalog);
		const spawned = vi.fn();
		vi.mocked(deps.ssh.validateDirectory).mockImplementation(
			async (
				_candidate: SshSessionTarget,
				path: string,
				_signal?: AbortSignal,
				finalAuthorization?: () => SshSessionTarget | null,
			): Promise<RemoteDirectoryValidationResult> => {
				catalog.replaceFromRpc([]);
				const fresh = finalAuthorization?.();
				if (!fresh) {
					if (finalAuthorization) return { ok: false, error: "Stale or altered SSH target" };
					spawned();
					return { ok: true, path };
				}
				spawned();
				return { ok: true, path };
			},
		);

		expect(await dispatchRemoteValidateDirectory(deps, { target, path: "/srv/app" })).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(spawned).not.toHaveBeenCalled();
	});

	it("forwards caller-owned cancellation signals to every one-shot SSH operation", async () => {
		const deps = remoteDeps();
		const target = sshTarget(deps.catalog);
		const controller = new AbortController();

		await dispatchRemotePreflight(deps, { target }, controller.signal);
		await dispatchRemoteListDirectories(deps, { target, path: "/srv/app", showHidden: false }, controller.signal);
		await dispatchRemoteValidateDirectory(deps, { target, path: "/srv/app" }, controller.signal);

		expect(deps.ssh.preflight).toHaveBeenCalledWith(target, controller.signal, expect.any(Function));
		expect(deps.ssh.listDirectories).toHaveBeenCalledWith(
			target,
			"/srv/app",
			false,
			controller.signal,
			expect.any(Function),
		);
		expect(deps.ssh.validateDirectory).toHaveBeenCalledWith(
			target,
			"/srv/app",
			controller.signal,
			expect.any(Function),
		);
	});

	it("aborts only the matching caller request and preserves a reused id from an older completion", () => {
		const registry = new RemoteRequestRegistry();
		const first = registry.start(101, "picker-request");
		if (!first) throw new Error("request did not start");

		expect(registry.cancel(202, "picker-request")).toBe(false);
		expect(registry.cancel(101, "different-request")).toBe(false);
		expect(first.signal.aborted).toBe(false);
		expect(registry.cancel(101, "picker-request")).toBe(true);
		expect(first.signal.aborted).toBe(true);

		const replacement = registry.start(101, "picker-request");
		if (!replacement) throw new Error("replacement request did not start");
		registry.finish(101, "picker-request", first);
		expect(registry.cancel(101, "picker-request")).toBe(true);
		expect(replacement.signal.aborted).toBe(true);
	});

	it("aborts every request for a closed caller without touching another caller", () => {
		const registry = new RemoteRequestRegistry();
		const first = registry.start(101, "first");
		const second = registry.start(101, "second");
		const foreign = registry.start(202, "first");
		if (!first || !second || !foreign) throw new Error("requests did not start");

		registry.cancelOwner(101);

		expect(first.signal.aborted).toBe(true);
		expect(second.signal.aborted).toBe(true);
		expect(foreign.signal.aborted).toBe(false);
		expect(registry.cancel(202, "first")).toBe(true);
	});

	it("authorizes existing-tab directory browsing against the exact owned immutable target", async () => {
		const catalog = catalogWith();
		const original = sshTarget(catalog);
		const deps = remoteDeps(catalog, [remoteTab(original, "remote-1")]);
		catalog.replaceFromRpc([{ ...BUILD_HOST, host: "replacement.example.com" }]);

		expect(await dispatchRemotePreflight(deps, { target: original, tabId: "remote-1" })).toMatchObject({
			ok: true,
			target: original,
		});
		expect(
			await dispatchRemoteListDirectories(deps, {
				target: original,
				tabId: "remote-1",
				path: "/srv/app",
				showHidden: false,
			}),
		).toMatchObject({ ok: true, path: "/srv/app" });
		expect(
			await dispatchRemoteValidateDirectory(deps, {
				target: original,
				tabId: "remote-1",
				path: "/srv/app",
			}),
		).toEqual({ ok: true, path: "/srv/app" });
		expect(deps.ssh.preflight).toHaveBeenCalledWith(original, undefined, expect.any(Function));
		expect(deps.ssh.listDirectories).toHaveBeenCalledWith(
			original,
			"/srv/app",
			false,
			undefined,
			expect.any(Function),
		);
		expect(deps.ssh.validateDirectory).toHaveBeenCalledWith(original, "/srv/app", undefined, expect.any(Function));
		const preflightAuthorization = vi.mocked(deps.ssh.preflight).mock.calls[0]?.[2];
		const listAuthorization = vi.mocked(deps.ssh.listDirectories).mock.calls[0]?.[4];
		const validationAuthorization = vi.mocked(deps.ssh.validateDirectory).mock.calls[0]?.[3];
		expect(preflightAuthorization?.()).toEqual(original);
		expect(listAuthorization?.()).toEqual(original);
		expect(validationAuthorization?.()).toEqual(original);
	});

	it("refuses missing, closed, foreign, or altered existing-tab identities before SSH access", async () => {
		const catalog = catalogWith();
		const original = sshTarget(catalog);
		const changed = { ...original, cwd: "/srv/changed", originCwd: "/srv/changed" };
		const deps = remoteDeps(catalog, [remoteTab(changed, "remote-1")]);

		for (const payload of [
			{ target: original, tabId: "closed-tab" },
			{ target: original, tabId: "remote-1" },
			{ target: { ...original, host: { ...original.host, port: 22 } }, tabId: "remote-1" },
		]) {
			expect(await dispatchRemotePreflight(deps, payload)).toEqual({
				ok: false,
				error: "Stale, altered, or foreign SSH tab target",
			});
		}
		expect(deps.ssh.preflight).not.toHaveBeenCalled();
	});

	it("stores a recent workspace only after exact main-process SSH validation", async () => {
		const deps = remoteDeps();
		vi.mocked(deps.ssh.validateDirectory)
			.mockResolvedValueOnce({ ok: false, error: "denied" })
			.mockResolvedValueOnce({ ok: true, path: "/srv/app/" })
			.mockResolvedValueOnce({ ok: true, path: "/srv/app" });

		expect(await dispatchRemoteNoteWorkspace(deps, { hostAlias: "build", cwd: "/srv/app" })).toEqual({
			ok: false,
			error: "denied",
		});
		expect(await dispatchRemoteNoteWorkspace(deps, { hostAlias: "build", cwd: "/srv/app" })).toEqual({
			ok: false,
			error: "Remote directory changed during validation",
		});
		expect(deps.catalog.snapshot().hosts[0]?.recentWorkspaces).toEqual([]);
		expect(await dispatchRemoteNoteWorkspace(deps, { hostAlias: "build", cwd: "/srv/app" })).toMatchObject({
			ok: true,
			catalog: { hosts: [{ recentWorkspaces: ["/srv/app"] }] },
		});
		expect(deps.ssh.validateDirectory).toHaveBeenCalledTimes(3);
	});

	it("persists a workspace synchronously with the final catalog snapshot", async () => {
		const catalog = catalogWith();
		const deps = remoteDeps(catalog);
		const originalTarget = catalog.target.bind(catalog);
		const originalNoteWorkspace = catalog.noteWorkspace.bind(catalog);
		let targetLookups = 0;
		let catalogReplaced = false;
		vi.spyOn(catalog, "target").mockImplementation((alias: string, cwd: string) => {
			const result = originalTarget(alias, cwd);
			targetLookups++;
			if (targetLookups === 3) {
				queueMicrotask(() => {
					catalog.replaceFromRpc([{ ...BUILD_HOST, host: "replacement.example.com" }]);
					catalogReplaced = true;
				});
			}
			return result;
		});
		const noteWorkspace = vi.spyOn(catalog, "noteWorkspace").mockImplementation((alias: string, cwd: string) => {
			expect(catalogReplaced).toBe(false);
			return originalNoteWorkspace(alias, cwd);
		});

		expect(await dispatchRemoteNoteWorkspace(deps, { hostAlias: "build", cwd: "/srv/app" })).toMatchObject({
			ok: true,
		});
		expect(noteWorkspace).toHaveBeenCalledWith("build", "/srv/app");
		expect(catalogReplaced).toBe(true);
	});

	it("isolates ACP history failures to the requested host and remaps rows to fresh canonical targets", async () => {
		const catalog = catalogWith([BUILD_HOST, PROD_HOST]);
		catalog.noteWorkspace("build", "/srv/build");
		catalog.noteWorkspace("prod", "/srv/prod");
		const deps = remoteDeps(catalog);
		const buildInput = sshTarget(catalog, "build", "/srv/build");
		vi.mocked(deps.acp.listSessions).mockImplementation(async (target: SshSessionTarget) => {
			if (target.hostAlias === "prod") return { ok: false, error: "prod disconnected" };
			return {
				ok: true,
				sessions: [
					{
						target: { ...buildInput, cwd: "/forged", host: { ...buildInput.host, host: "forged" } },
						sessionId: "session-1",
						cwd: "/srv/build/release",
						title: "Release",
						updatedAt: null,
					},
				],
			};
		});

		expect(await dispatchRemoteHistory(deps, { hostAlias: "prod" })).toEqual({
			ok: false,
			error: "prod disconnected",
		});
		const build = await dispatchRemoteHistory(deps, { hostAlias: "build" });
		expect(build).toMatchObject({
			ok: true,
			sessions: [
				{
					sessionId: "session-1",
					cwd: "/srv/build/release",
					target: {
						type: "ssh",
						hostAlias: "build",
						cwd: "/srv/build/release",
						originCwd: "/srv/build/release",
						host: { host: "build.example.com" },
					},
				},
			],
		});
		expect(deps.acp.listSessions).toHaveBeenNthCalledWith(
			1,
			sshTarget(catalog, "prod", "/srv/prod"),
			expect.any(Function),
		);
		expect(deps.acp.listSessions).toHaveBeenNthCalledWith(
			2,
			sshTarget(catalog, "build", "/srv/build"),
			expect.any(Function),
		);
	});

	it("rejects unopened history when its catalog target changes after runtime discovery", async () => {
		const catalog = catalogWith();
		catalog.noteWorkspace("build", "/srv/build");
		const deps = remoteDeps(catalog);
		const spawned = vi.fn();
		vi.mocked(deps.acp.listSessions).mockImplementation(
			async (
				_target: SshSessionTarget,
				finalAuthorization?: () => SshSessionTarget | null,
			): Promise<RemoteHistoryResult> => {
				catalog.replaceFromRpc([{ ...BUILD_HOST, host: "replacement.example.com" }]);
				const fresh = finalAuthorization?.();
				if (!fresh) {
					if (finalAuthorization) return { ok: false, error: "Stale or altered SSH target" };
					spawned();
					return { ok: true, sessions: [] };
				}
				spawned();
				return { ok: true, sessions: [] };
			},
		);

		expect(await dispatchRemoteHistory(deps, { hostAlias: "build" })).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(spawned).not.toHaveBeenCalled();
	});

	it("records only successful history rows as exact resume grants", async () => {
		const catalog = catalogWith();
		catalog.noteWorkspace("build", "/srv/build");
		const deps = remoteDeps(catalog);
		const grants = new RemoteResumeGrantRegistry();
		const recordResumeGrant = vi.fn((target: SshSessionTarget, cwd: string, sessionId: string) => {
			grants.record(41, target, cwd, sessionId);
		});
		vi.mocked(deps.acp.listSessions).mockResolvedValue({
			ok: true,
			sessions: [
				{
					target: sshTarget(catalog, "build", "/forged"),
					sessionId: "session-1",
					cwd: "/srv/build/release",
					title: "Release",
					updatedAt: null,
				},
			],
		});

		const result = await dispatchRemoteHistory(deps, { hostAlias: "build" }, recordResumeGrant);

		expect(result).toMatchObject({ ok: true, sessions: [{ sessionId: "session-1" }] });
		expect(recordResumeGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				hostAlias: "build",
				originCwd: "/srv/build/release",
				cwd: "/srv/build/release",
			}),
			"/srv/build/release",
			"session-1",
		);
		if (!result.ok) throw new Error(result.error);
		const session = result.sessions[0];
		if (!session) throw new Error("Expected a remote history row");
		expect(
			resolveNewWindowRequest(
				catalog,
				{ target: session.target, cwd: session.cwd, resumeSessionId: session.sessionId },
				"/local/caller",
				(target, cwd, sessionId) => grants.allows(41, target, cwd, sessionId),
			),
		).toEqual({
			ok: true,
			cwd: "/srv/build/release",
			target: session.target,
			resumeSessionId: "session-1",
		});
		recordResumeGrant.mockClear();
		vi.mocked(deps.acp.listSessions).mockResolvedValue({
			ok: true,
			sessions: [
				{
					target: session.target,
					sessionId: "valid-before-invalid",
					cwd: "/srv/build/valid",
					title: null,
					updatedAt: null,
				},
				{
					target: session.target,
					sessionId: "invalid",
					cwd: "relative",
					title: null,
					updatedAt: null,
				},
			],
		});
		expect(await dispatchRemoteHistory(deps, { hostAlias: "build" }, recordResumeGrant)).toEqual({
			ok: false,
			error: "Invalid remote history response",
		});
		expect(recordResumeGrant).not.toHaveBeenCalled();
	});

	it("scopes reusable resume grants to the exact owner, immutable target, cwd, and session id", () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const grants = new RemoteResumeGrantRegistry();

		grants.record(41, target, target.cwd, "session-1");

		expect(grants.allows(41, target, target.cwd, "session-1")).toBe(true);
		expect(grants.allows(41, target, target.cwd, "session-1")).toBe(true);
		expect(grants.allows(42, target, target.cwd, "session-1")).toBe(false);
		expect(grants.allows(41, target, "/srv/other", "session-1")).toBe(false);
		expect(grants.allows(41, target, target.cwd, "session-2")).toBe(false);
		expect(
			grants.allows(
				41,
				{ ...target, host: { ...target.host, host: "replacement.example.com" } },
				target.cwd,
				"session-1",
			),
		).toBe(false);

		grants.clearOwner(41);
		expect(grants.allows(41, target, target.cwd, "session-1")).toBe(false);
		grants.record(41, target, target.cwd, "late-session");
		expect(grants.allows(41, target, target.cwd, "late-session")).toBe(false);
	});

	it("keeps history row targets on the request snapshot when the catalog changes in flight", async () => {
		const catalog = catalogWith();
		catalog.noteWorkspace("build", "/srv/build");
		const requestTarget = sshTarget(catalog, "build", "/srv/build");
		const deps = remoteDeps(catalog);
		vi.mocked(deps.acp.listSessions).mockImplementation(async () => {
			catalog.replaceFromRpc([{ ...BUILD_HOST, host: "replacement.example.com" }]);
			return {
				ok: true,
				sessions: [
					{
						target: requestTarget,
						sessionId: "session-1",
						cwd: "/srv/build/release",
						title: null,
						updatedAt: null,
					},
				],
			};
		});

		expect(await dispatchRemoteHistory(deps, { hostAlias: "build" })).toMatchObject({
			ok: true,
			sessions: [
				{
					target: {
						hostAlias: "build",
						host: { host: "build.example.com" },
						originCwd: "/srv/build/release",
						cwd: "/srv/build/release",
					},
				},
			],
		});
	});

	it("rejects an arbitrary remote resume id for a new window", () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const authorizeRemoteResume = vi.fn(() => false);

		expect(
			resolveNewWindowRequest(
				catalog,
				{ target, resumeSessionId: "renderer-chosen-session", cwd: target.cwd },
				"/local/caller",
				authorizeRemoteResume,
			),
		).toEqual({ ok: false, error: "Remote resume session is not authorized" });
		expect(authorizeRemoteResume).toHaveBeenCalledWith(target, target.cwd, "renderer-chosen-session");
	});

	it("validates and carries canonical targets and remote resume ids for new windows", () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);

		expect(
			resolveNewWindowRequest(
				catalog,
				{ target, resumeSessionId: "remote-session", cwd: "/srv/app" },
				"/local/caller",
				() => true,
			),
		).toEqual({
			ok: true,
			cwd: "/srv/app",
			target,
			resumeSessionId: "remote-session",
		});
		const denyResume = vi.fn(() => false);
		expect(resolveNewWindowRequest(catalog, { target, cwd: target.cwd }, "/local/caller", denyResume)).toEqual({
			ok: true,
			cwd: target.cwd,
			target,
		});
		expect(denyResume).not.toHaveBeenCalled();
		expect(resolveNewWindowRequest(catalog, {}, "/local/caller")).toEqual({
			ok: true,
			cwd: "/local/caller",
			target: { type: "local" },
		});
		expect(
			resolveNewWindowRequest(
				catalog,
				{ target: { ...target, host: { ...target.host, host: "attacker" } }, resumeSessionId: "remote-session" },
				"/local/caller",
			),
		).toEqual({ ok: false, error: "Stale or altered SSH target" });
		expect(resolveNewWindowRequest(catalog, { target, cwd: "/different" }, "/local/caller")).toEqual({
			ok: false,
			error: "Remote window cwd does not match its target",
		});
		expect(
			resolveNewWindowRequest(
				catalog,
				{ target: { type: "local" }, resumeSessionId: "remote-session" },
				"/local/caller",
			),
		).toEqual({
			ok: false,
			error: "Local windows cannot resume remote session ids",
		});
	});
});

describe("workspace dispatch", () => {
	it("routes local and SSH list/read operations to exactly one backend", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const local = localTab();
		const remote = remoteTab(target);
		const deps = workspaceDeps(catalog, [local, remote]);

		expect(await dispatchWorkspaceList(deps, local, { path: "src" })).toEqual({
			ok: true,
			entries: [],
			truncated: false,
		});
		expect(await dispatchWorkspaceRead(deps, local, { path: "README.md" })).toMatchObject({ content: "local" });
		expect(await dispatchWorkspaceList(deps, remote, { path: "src", maxDepth: 5, maxEntries: 50 })).toEqual({
			ok: true,
			entries: [{ name: "remote.ts", path: "remote.ts", kind: "file" }],
			truncated: false,
		});
		expect(await dispatchWorkspaceRead(deps, remote, { path: "README.md" })).toEqual({
			ok: true,
			content: "remote",
			truncated: false,
			binary: false,
			size: 6,
		});
		expect(deps.local.list).toHaveBeenCalledTimes(1);
		expect(deps.local.read).toHaveBeenCalledTimes(1);
		expect(deps.remote.listWorkspace).toHaveBeenCalledWith(target, "/srv/app/src", ["/srv/app"], 5, 50);
		expect(deps.remote.readFile).toHaveBeenCalledWith(target, "/srv/app/README.md", ["/srv/app"], 200_001);
	});

	it("keeps file, markdown image, and plan previews separated across local and SSH tabs", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const local = localTab();
		const remote = remoteTab(target);
		const trust = new RemoteWorkspaceTrust();
		const deps = workspaceDeps(catalog, [local, remote], trust);
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		trust.observeRpcSuccess(
			remote,
			{ type: "get_directories" },
			{
				directories: [
					{ path: "/srv/app", primary: true },
					{ path: "/shared", primary: false },
				],
			},
		);
		vi.mocked(deps.remote.readFile).mockImplementation(async (_target, requestedPath) => {
			if (requestedPath === "/srv/app/same-name.txt") {
				return { ok: false, error: "remote read denied" };
			}
			if (requestedPath === "/shared/same-name.png") {
				return { ok: true, data: png, size: png.byteLength, truncated: false };
			}
			if (requestedPath === "/shared/plan.md") {
				const data = new Uint8Array(Buffer.from("# Remote-only plan", "utf8"));
				return { ok: true, data, size: data.byteLength, truncated: false };
			}
			return { ok: false, error: "outside known remote roots" };
		});

		expect(await dispatchWorkspaceRead(deps, local, { path: "same-name.txt", maxBytes: 32 })).toMatchObject({
			ok: true,
			content: "local",
		});
		expect(await dispatchWorkspaceReadImage(deps, local, { path: "same-name.png" })).toMatchObject({ ok: true });
		expect(
			await dispatchWorkspaceReadPlan(deps, local, {
				fsPath: "/srv/app/plan.md",
				localRoot: null,
			}),
		).toMatchObject({ ok: true, content: "local plan" });

		expect(await dispatchWorkspaceRead(deps, remote, { path: "same-name.txt", maxBytes: 32 })).toMatchObject({
			ok: false,
			error: "remote read denied",
		});
		expect(await dispatchWorkspaceReadImage(deps, remote, { path: "/shared/same-name.png" })).toMatchObject({
			ok: true,
			mime: "image/png",
		});
		expect(
			await dispatchWorkspaceReadPlan(deps, remote, {
				fsPath: "/shared/plan.md",
				localRoot: null,
			}),
		).toEqual({ ok: true, path: "/shared/plan.md", content: "# Remote-only plan" });
		expect(await dispatchWorkspaceRead(deps, remote, { path: "/etc/same-name.txt", maxBytes: 32 })).toMatchObject({
			ok: false,
			error: "outside known remote roots",
		});

		expect(deps.local.read).toHaveBeenCalledTimes(1);
		expect(deps.local.readImage).toHaveBeenCalledTimes(1);
		expect(deps.local.readPlan).toHaveBeenCalledTimes(1);
		expect(deps.remote.readFile).toHaveBeenNthCalledWith(
			1,
			target,
			"/srv/app/same-name.txt",
			["/srv/app", "/shared"],
			33,
		);
		expect(deps.remote.readFile).toHaveBeenNthCalledWith(
			2,
			target,
			"/shared/same-name.png",
			["/srv/app", "/shared"],
			25_000_001,
		);
		expect(deps.remote.readFile).toHaveBeenNthCalledWith(
			3,
			target,
			"/shared/plan.md",
			["/srv/app", "/shared"],
			2_000_001,
		);
		expect(deps.remote.readFile).toHaveBeenNthCalledWith(
			4,
			target,
			"/etc/same-name.txt",
			["/srv/app", "/shared"],
			33,
		);
	});

	it("trusts the exact pool-owned SSH snapshot after catalog edits and deletion", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const current = remoteTab(target);
		const deps = workspaceDeps(catalog, [current]);

		catalog.replaceFromRpc([{ ...BUILD_HOST, host: "replacement.example.com" }]);
		expect(await dispatchWorkspaceRead(deps, current, { path: "README.md" })).toMatchObject({
			ok: true,
			content: "remote",
		});

		catalog.replaceFromRpc([]);
		expect(await dispatchWorkspaceRead(deps, current, { path: "README.md" })).toMatchObject({
			ok: true,
			content: "remote",
		});
		expect(deps.remote.readFile).toHaveBeenCalledTimes(2);
		expect(deps.remote.readFile).toHaveBeenLastCalledWith(target, "/srv/app/README.md", ["/srv/app"], 200_001);
		expect(deps.local.read).not.toHaveBeenCalled();
	});

	it("rejects unknown and forged tab targets even when their host alias remains cataloged", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const current = remoteTab(target);
		const deps = workspaceDeps(catalog, [current]);
		const unknown = remoteTab(target, "unknown");
		const altered = remoteTab({ ...target, cwd: "/etc" });

		expect(await dispatchWorkspaceRead(deps, unknown, { path: "passwd" })).toMatchObject({
			ok: false,
			error: "Unknown tab",
		});
		expect(await dispatchWorkspaceRead(deps, altered, { path: "passwd" })).toMatchObject({
			ok: false,
			error: "Stale or altered tab target",
		});
		expect(deps.local.read).not.toHaveBeenCalled();
		expect(deps.remote.readFile).not.toHaveBeenCalled();
	});

	it("derives remote roots only from target and successful sidecar-observed state", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const tab = remoteTab(target);
		const trust = new RemoteWorkspaceTrust();
		const deps = workspaceDeps(catalog, [tab], trust);

		trust.observeRpcSuccess(
			tab,
			{ type: "get_directories" },
			{
				directories: [
					{ path: "/srv/app", primary: true },
					{ path: "/shared/reports", primary: false },
				],
			},
		);
		trust.observeRpcSuccess(tab, { type: "get_state" }, { sessionFile: "/home/deploy/.omp/sessions/session.jsonl" });
		trust.observeRpcSuccess(
			tab,
			{ type: "get_directories" },
			{
				directories: [{ path: "renderer-relative", primary: false }],
			},
		);

		await dispatchWorkspaceReadPlan(deps, tab, {
			fsPath: "/shared/reports/release-plan.md",
			localRoot: "/renderer/supplied/root",
		});

		expect(deps.remote.readFile).toHaveBeenCalledWith(
			target,
			"/shared/reports/release-plan.md",
			["/srv/app", "/shared/reports", "/home/deploy/.omp/sessions"],
			2_000_001,
		);

		trust.release(tab.tabId);
		expect(trust.rootsFor(tab)).toEqual(["/srv/app"]);
	});

	it("authorizes the authoritative roots returned by add_directory", () => {
		const catalog = catalogWith();
		const tab = remoteTab(sshTarget(catalog));
		const trust = new RemoteWorkspaceTrust();

		trust.observeRpcSuccess(
			tab,
			{ type: "get_directories" },
			{
				directories: [{ path: "/srv/app", primary: true }],
			},
		);
		expect(trust.rootsFor(tab)).toEqual(["/srv/app"]);

		trust.observeRpcSuccess(
			tab,
			{ type: "add_directory" },
			{
				directories: [
					{ path: "/srv/app", primary: true },
					{ path: "/shared/new", primary: false },
				],
			},
		);
		expect(trust.rootsFor(tab)).toEqual(["/srv/app", "/shared/new"]);
	});

	it("revokes roots omitted from the authoritative remove_directory result", () => {
		const catalog = catalogWith();
		const tab = remoteTab(sshTarget(catalog));
		const trust = new RemoteWorkspaceTrust();

		trust.observeRpcSuccess(
			tab,
			{ type: "get_directories" },
			{
				directories: [
					{ path: "/srv/app", primary: true },
					{ path: "/shared/removed", primary: false },
				],
			},
		);
		expect(trust.rootsFor(tab)).toEqual(["/srv/app", "/shared/removed"]);

		trust.observeRpcSuccess(
			tab,
			{ type: "remove_directory" },
			{
				directories: [{ path: "/srv/app", primary: true }],
			},
		);
		expect(trust.rootsFor(tab)).toEqual(["/srv/app"]);
	});

	it("preserves prior trust after malformed or oversized directory mutation results", () => {
		const catalog = catalogWith();
		const tab = remoteTab(sshTarget(catalog));
		const trust = new RemoteWorkspaceTrust();
		const trustedRoots = ["/srv/app", "/shared/trusted"];

		trust.observeRpcSuccess(
			tab,
			{ type: "get_directories" },
			{
				directories: [
					{ path: trustedRoots[0], primary: true },
					{ path: trustedRoots[1], primary: false },
				],
			},
		);

		trust.observeRpcSuccess(
			tab,
			{ type: "add_directory" },
			{
				directories: [{ path: "renderer-relative", primary: false }],
			},
		);
		expect(trust.rootsFor(tab)).toEqual(trustedRoots);

		trust.observeRpcSuccess(
			tab,
			{ type: "remove_directory" },
			{
				directories: Array.from({ length: 127 }, (_, index) => ({
					path: `/shared/${index}`,
					primary: false,
				})),
			},
		);
		expect(trust.rootsFor(tab)).toEqual(trustedRoots);

		trust.observeRpcSuccess(
			tab,
			{ type: "add_directory" },
			{
				directories: [{ path: `/${"💥".repeat(4_096)}`, primary: false }],
			},
		);
		expect(trust.rootsFor(tab)).toEqual(trustedRoots);
	});

	it("re-roots workspace trust to an adopted pool target and drops stale supplemental roots", async () => {
		const catalog = catalogWith();
		const original = sshTarget(catalog);
		const tab = remoteTab(original);
		const trust = new RemoteWorkspaceTrust();
		trust.observeRpcSuccess(
			tab,
			{ type: "get_directories" },
			{
				directories: [
					{ path: original.cwd, primary: true },
					{ path: "/shared/old", primary: false },
				],
			},
		);
		const movedTarget: SshSessionTarget = { ...original, host: { ...original.host }, cwd: "/srv/moved" };
		const movedTab = remoteTab(movedTarget);
		const deps = workspaceDeps(catalog, [movedTab], trust);

		expect(await dispatchWorkspaceRead(deps, movedTab, { path: "README.md" })).toMatchObject({
			ok: true,
			content: "remote",
		});
		expect(deps.remote.readFile).toHaveBeenCalledWith(movedTarget, "/srv/moved/README.md", ["/srv/moved"], 200_001);
		expect(trust.rootsFor(movedTab)).toEqual(["/srv/moved"]);
	});

	it("never falls back to local filesystem operations after a remote failure", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const tab = remoteTab(target);
		const deps = workspaceDeps(catalog, [tab]);
		vi.mocked(deps.remote.readFile).mockResolvedValue({ ok: false, error: "remote denied" });
		vi.mocked(deps.remote.listWorkspace).mockResolvedValue({ ok: false, error: "remote list denied" });

		expect(await dispatchWorkspaceList(deps, tab, { path: "." })).toEqual({
			ok: false,
			entries: [],
			truncated: false,
			error: "remote list denied",
		});
		expect(await dispatchWorkspaceRead(deps, tab, { path: "secret.txt" })).toEqual({
			ok: false,
			content: "",
			truncated: false,
			binary: false,
			size: 0,
			error: "remote denied",
		});
		expect(await dispatchWorkspaceReadImage(deps, tab, { path: "image.png" })).toEqual({
			ok: false,
			dataUrl: null,
			mime: null,
			size: 0,
			error: "remote denied",
		});
		expect(deps.local.list).not.toHaveBeenCalled();
		expect(deps.local.read).not.toHaveBeenCalled();
		expect(deps.local.readImage).not.toHaveBeenCalled();
	});

	it("preserves an incomplete remote text read as truncated when the file shrinks", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const tab = remoteTab(target);
		const deps = workspaceDeps(catalog, [tab]);
		vi.mocked(deps.remote.readFile).mockResolvedValue({
			ok: true,
			data: new Uint8Array(Buffer.from("short", "utf8")),
			size: 10,
			truncated: true,
		});

		expect(await dispatchWorkspaceRead(deps, tab, { path: "changing.txt" })).toEqual({
			ok: true,
			content: "short",
			truncated: true,
			binary: false,
			size: 10,
		});
	});

	it("preserves binary detection, image MIME sniffing, and image size caps for remote bytes", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const tab = remoteTab(target);
		const deps = workspaceDeps(catalog, [tab]);
		vi.mocked(deps.remote.readFile)
			.mockResolvedValueOnce({ ok: true, data: new Uint8Array([0x61, 0, 0x62]), size: 3, truncated: false })
			.mockResolvedValueOnce({
				ok: true,
				data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				size: 8,
				truncated: false,
			})
			.mockResolvedValueOnce({ ok: true, data: new Uint8Array(), size: 25_000_001, truncated: true });

		expect(await dispatchWorkspaceRead(deps, tab, { path: "binary.bin" })).toEqual({
			ok: true,
			content: "",
			truncated: false,
			binary: true,
			size: 3,
		});
		expect(await dispatchWorkspaceReadImage(deps, tab, { path: "image.png" })).toEqual({
			ok: true,
			dataUrl: "data:image/png;base64,iVBORw0KGgo=",
			mime: "image/png",
			size: 8,
		});
		expect(await dispatchWorkspaceReadImage(deps, tab, { path: "huge.png" })).toEqual({
			ok: false,
			dataUrl: null,
			mime: null,
			size: 0,
			error: "Image too large",
		});
	});

	it("rejects an incomplete remote image body instead of returning a corrupt data URL", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const tab = remoteTab(target);
		const deps = workspaceDeps(catalog, [tab]);
		vi.mocked(deps.remote.readFile).mockResolvedValue({
			ok: true,
			data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			size: 100,
			truncated: true,
		});

		expect(await dispatchWorkspaceReadImage(deps, tab, { path: "changing.png" })).toEqual({
			ok: false,
			dataUrl: null,
			mime: null,
			size: 0,
			error: "Remote image read was incomplete",
		});
	});

	it("rejects an incomplete remote plan body instead of returning partial markdown", async () => {
		const catalog = catalogWith();
		const target = sshTarget(catalog);
		const tab = remoteTab(target);
		const deps = workspaceDeps(catalog, [tab]);
		vi.mocked(deps.remote.readFile).mockResolvedValue({
			ok: true,
			data: new Uint8Array(Buffer.from("# Parti", "utf8")),
			size: 100,
			truncated: true,
		});

		expect(await dispatchWorkspaceReadPlan(deps, tab, { fsPath: "/srv/app/plan.md", localRoot: null })).toEqual({
			ok: false,
			path: null,
			content: null,
			error: "Remote plan read was incomplete",
		});
	});

	it("keeps local image and plan behavior behind the existing local helpers", async () => {
		const catalog = catalogWith();
		const tab = localTab();
		const deps = workspaceDeps(catalog, [tab]);

		expect(await dispatchWorkspaceReadImage(deps, tab, { path: "~/image.png" })).toMatchObject({
			ok: true,
			mime: "image/png",
		});
		expect(await dispatchWorkspaceReadPlan(deps, tab, { fsPath: "/tmp/plan.md", localRoot: null })).toEqual({
			ok: true,
			path: "/local/plan.md",
			content: "local plan",
		});
		expect(deps.local.readImage).toHaveBeenCalledWith({ path: "~/image.png" });
		expect(deps.local.readPlan).toHaveBeenCalledWith({ fsPath: "/tmp/plan.md", localRoot: null });
	});

	it("rejects malformed workspace payloads before dispatch", async () => {
		const catalog = catalogWith();
		const tab = localTab();
		const deps = workspaceDeps(catalog, [tab]);
		const malformedTarget: WorkspaceTabIdentity = { tabId: "bad", target: null as unknown as SessionTarget };

		expect(await dispatchWorkspaceRead(deps, tab, { path: "" })).toMatchObject({ ok: false, error: "Invalid path" });
		expect(await dispatchWorkspaceList(deps, tab, { maxDepth: "deep" })).toMatchObject({
			ok: false,
			error: "Invalid workspace list request",
		});
		expect(await dispatchWorkspaceRead(deps, malformedTarget, { path: "x" })).toMatchObject({
			ok: false,
			error: "Invalid tab identity",
		});
		expect(deps.local.read).not.toHaveBeenCalled();
	});
});

describe("remote renderer input bounds", () => {
	it("rejects oversized multibyte aliases, cursors, cwd, and executable overrides before catalog lookup", async () => {
		const catalog = catalogWith();
		const deps = remoteDeps(catalog);
		const snapshot = vi.spyOn(catalog, "snapshot");
		const oversizedAlias = "é".repeat(129);
		const oversizedCursor = "💥".repeat(1_025);
		const oversizedPath = `/${"💥".repeat(4_096)}`;

		expect(await dispatchRemoteOverride(deps, { hostAlias: oversizedAlias, value: "/usr/bin/omp" })).toEqual({
			ok: false,
			error: "Invalid remote host alias",
		});
		expect(snapshot).not.toHaveBeenCalled();

		expect(await dispatchRemoteHistory(deps, { hostAlias: "build", cursor: oversizedCursor })).toEqual({
			ok: false,
			error: "Invalid history cursor",
		});
		expect(snapshot).not.toHaveBeenCalled();

		expect(await dispatchRemoteNoteWorkspace(deps, { hostAlias: "build", cwd: oversizedPath })).toEqual({
			ok: false,
			error: "Invalid remote workspace",
		});
		expect(snapshot).not.toHaveBeenCalled();

		expect(await dispatchRemoteOverride(deps, { hostAlias: "build", value: oversizedPath })).toEqual({
			ok: false,
			error: "Invalid executable override",
		});
		expect(snapshot).not.toHaveBeenCalled();
	});

	it("rejects oversized target fields, directory paths, and session ids before target lookup", async () => {
		const catalog = catalogWith();
		const deps = remoteDeps(catalog);
		const target = sshTarget(catalog);
		const targetLookup = vi.spyOn(catalog, "target");
		const oversizedAlias = "é".repeat(129);
		const oversizedPath = `/${"💥".repeat(4_096)}`;
		const oversizedSessionId = "💥".repeat(1_025);

		expect(await dispatchRemotePreflight(deps, { target: { ...target, hostAlias: oversizedAlias } })).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(await dispatchRemotePreflight(deps, { target: { ...target, cwd: oversizedPath } })).toEqual({
			ok: false,
			error: "Stale or altered SSH target",
		});
		expect(await dispatchRemotePreflight(deps, { target: { ...target, executableOverride: oversizedPath } })).toEqual(
			{
				ok: false,
				error: "Stale or altered SSH target",
			},
		);
		expect(await dispatchRemoteListDirectories(deps, { target, path: oversizedPath, showHidden: false })).toEqual({
			ok: false,
			error: "Invalid remote directory request",
		});
		const sink = vi.fn((fresh: SshSessionTarget) => fresh);
		expect(await authorizeRemoteTargetAtSink(deps, { target, cwd: oversizedPath }, sink)).toEqual({
			ok: false,
			error: "Remote cwd does not match target",
		});
		expect(
			resolveNewWindowRequest(
				catalog,
				{ target, cwd: target.cwd, resumeSessionId: oversizedSessionId },
				"/local/caller",
			),
		).toEqual({ ok: false, error: "Invalid new-window request" });
		expect(targetLookup).not.toHaveBeenCalled();
		expect(deps.ssh.preflight).not.toHaveBeenCalled();
		expect(deps.ssh.listDirectories).not.toHaveBeenCalled();
		expect(sink).not.toHaveBeenCalled();
	});

	it("ignores oversized and excessive remote workspace roots", () => {
		const catalog = catalogWith();
		const tab = remoteTab(sshTarget(catalog));
		const trust = new RemoteWorkspaceTrust();
		const command = { type: "get_directories" } as const;

		trust.observeRpcSuccess(tab, command, {
			directories: [{ path: "/shared", primary: false }],
		});
		expect(trust.rootsFor(tab)).toEqual(["/srv/app", "/shared"]);

		trust.observeRpcSuccess(tab, command, {
			directories: Array.from({ length: 127 }, (_, index) => ({
				path: `/shared/${index}`,
				primary: false,
			})),
		});
		expect(trust.rootsFor(tab)).toEqual(["/srv/app", "/shared"]);

		trust.observeRpcSuccess(tab, command, {
			directories: [{ path: `/${"💥".repeat(4_096)}`, primary: false }],
		});
		expect(trust.rootsFor(tab)).toEqual(["/srv/app", "/shared"]);
	});

	it("rejects oversized remote workspace paths before tab lookup or normalization", async () => {
		const catalog = catalogWith();
		const tab = remoteTab(sshTarget(catalog));
		const deps = workspaceDeps(catalog, [tab]);
		const lookupTab = vi.fn((_tabId: string): WorkspaceTabIdentity | null => tab);
		deps.lookupTab = lookupTab;
		const oversizedPath = `/${"💥".repeat(4_096)}`;

		expect(await dispatchWorkspaceList(deps, tab, { path: oversizedPath })).toMatchObject({
			ok: false,
			error: "Invalid workspace list request",
		});
		expect(await dispatchWorkspaceRead(deps, tab, { path: oversizedPath })).toMatchObject({
			ok: false,
			error: "Invalid path",
		});
		expect(await dispatchWorkspaceReadImage(deps, tab, { path: oversizedPath })).toMatchObject({
			ok: false,
			error: "Invalid path",
		});
		expect(
			await dispatchWorkspaceReadPlan(deps, tab, { fsPath: oversizedPath, localRoot: oversizedPath }),
		).toMatchObject({
			ok: false,
			error: "Invalid path",
		});
		expect(lookupTab).not.toHaveBeenCalled();
		expect(deps.remote.listWorkspace).not.toHaveBeenCalled();
		expect(deps.remote.readFile).not.toHaveBeenCalled();
	});
});
