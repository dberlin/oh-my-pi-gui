import { describe, expect, it } from "vitest";
import type { RpcSshHostInfo } from "../shared/rpc-types";
import { RemoteHostCatalog, type RemoteHostCatalogPrefs, type RemoteHostCatalogStore } from "./remote-host-catalog";

class FakeStore implements RemoteHostCatalogStore {
	readonly values = new Map<keyof RemoteHostCatalogPrefs, unknown>();

	constructor(initial: Partial<Record<keyof RemoteHostCatalogPrefs, unknown>> = {}) {
		for (const [key, value] of Object.entries(initial)) {
			this.values.set(key as keyof RemoteHostCatalogPrefs, value);
		}
	}

	get<Key extends keyof RemoteHostCatalogPrefs>(key: Key): RemoteHostCatalogPrefs[Key] | undefined {
		return this.values.get(key) as RemoteHostCatalogPrefs[Key] | undefined;
	}

	set<Key extends keyof RemoteHostCatalogPrefs>(key: Key, value: RemoteHostCatalogPrefs[Key]): void {
		this.values.set(key, structuredClone(value));
	}
}

function host(name: string, overrides: Partial<RpcSshHostInfo> = {}): RpcSshHostInfo {
	return {
		name,
		host: `${name}.example`,
		scope: "user",
		editable: true,
		source: `/Users/danny/.ssh/config:${name}`,
		...overrides,
	};
}

describe("RemoteHostCatalog", () => {
	it("replaces canonical host rows and preserves only validated connection fields", () => {
		const store = new FakeStore();
		const catalog = new RemoteHostCatalog(store, { now: () => "2026-08-12T10:00:00.000Z" });
		const malformed = { ...host("bad"), port: 70_000 } as RpcSshHostInfo;

		const snapshot = catalog.replaceFromRpc([
			host("build", {
				host: "build.internal",
				username: "danny",
				port: 2222,
				keyPath: "/Users/danny/.ssh/id_ed25519",
				compat: true,
				os: "linux",
				shell: "zsh",
				transferShell: "bash",
				description: "not persisted",
				compatShell: "bash",
			}),
			malformed,
		]);

		expect(snapshot).toEqual({
			hosts: [
				{
					alias: "build",
					host: {
						host: "build.internal",
						username: "danny",
						port: 2222,
						keyPath: "/Users/danny/.ssh/id_ed25519",
						compat: true,
						os: "linux",
						shell: "zsh",
						transferShell: "bash",
						sourceId: "/Users/danny/.ssh/config:build",
						sourceLevel: "user",
					},
					recentWorkspaces: [],
				},
			],
			updatedAt: "2026-08-12T10:00:00.000Z",
		});
		expect(store.values.get("remoteHosts")).toEqual(
			snapshot.hosts.map(({ alias, host: saved }) => ({ alias, host: saved })),
		);

		catalog.replaceFromRpc([host("deploy")]);
		expect(catalog.snapshot().hosts.map(entry => entry.alias)).toEqual(["deploy"]);
	});

	it("rejects option-like or control-bearing SSH destinations from RPC", () => {
		const catalog = new RemoteHostCatalog(new FakeStore());
		expect(
			catalog
				.replaceFromRpc([
					host("option-host", { host: "-oProxyCommand=attacker" }),
					host("control-host", { host: "build.example\nProxyCommand attacker" }),
					host("option-user", { username: "-oProxyCommand=attacker" }),
					host("at-user", { username: "user@attacker" }),
					host("safe"),
				])
				.hosts.map(entry => entry.alias),
		).toEqual(["safe"]);
	});

	it("keeps executable overrides separate and removes them with null or blank input", () => {
		const store = new FakeStore();
		const catalog = new RemoteHostCatalog(store);
		catalog.replaceFromRpc([host("build")]);

		expect(catalog.setExecutableOverride("build", "  /opt/omp/bin/omp  ").hosts[0]?.executableOverride).toBe(
			"/opt/omp/bin/omp",
		);
		expect(store.values.get("remoteExecutableOverrides")).toEqual({ build: "/opt/omp/bin/omp" });
		expect(catalog.setExecutableOverride("missing", "/tmp/omp")).toEqual(catalog.snapshot());
		expect(catalog.setExecutableOverride("build", " ").hosts[0]?.executableOverride).toBeUndefined();
		expect(store.values.get("remoteExecutableOverrides")).toEqual({});
	});

	it("deletes override and recent metadata when canonical replacement removes a host", () => {
		const store = new FakeStore();
		const catalog = new RemoteHostCatalog(store);
		catalog.replaceFromRpc([host("build"), host("deploy")]);
		catalog.setExecutableOverride("build", "/opt/omp");
		catalog.noteWorkspace("build", "/work/repo");

		catalog.replaceFromRpc([host("deploy")]);

		expect(store.values.get("remoteExecutableOverrides")).toEqual({});
		expect(store.values.get("remoteRecentWorkspaces")).toEqual({});
		expect(catalog.snapshot().hosts.map(entry => entry.alias)).toEqual(["deploy"]);
	});

	it("stores unique newest-first recent workspaces with a per-host cap", () => {
		const store = new FakeStore();
		const catalog = new RemoteHostCatalog(store, { maxRecentWorkspaces: 3 });
		catalog.replaceFromRpc([host("build", { os: "linux" }), host("win", { os: "windows" })]);

		catalog.noteWorkspace("build", "/work/one");
		catalog.noteWorkspace("build", "/work/two");
		catalog.noteWorkspace("build", "/work/one");
		catalog.noteWorkspace("build", "/work/three");
		catalog.noteWorkspace("build", "/work/four");
		catalog.noteWorkspace("build", "relative/path");
		catalog.noteWorkspace("win", "C:\\work\\repo");

		expect(catalog.snapshot().hosts).toMatchObject([
			{ alias: "build", recentWorkspaces: ["/work/four", "/work/three", "/work/one"] },
			{ alias: "win", recentWorkspaces: ["C:\\work\\repo"] },
		]);
		expect(store.values.get("remoteRecentWorkspaces")).toEqual({
			build: ["/work/four", "/work/three", "/work/one"],
			win: ["C:\\work\\repo"],
		});
	});

	it("round-trips hostile aliases without prototype collisions or metadata injection", () => {
		const store = new FakeStore({
			remoteExecutableOverrides: Object.fromEntries([
				["__proto__", "/opt/proto-omp"],
				["constructor", "/opt/constructor-omp"],
			]),
			remoteRecentWorkspaces: Object.fromEntries([
				["__proto__", ["/work/proto"]],
				["constructor", ["/work/constructor"]],
			]),
		});
		const catalog = new RemoteHostCatalog(store);
		catalog.replaceFromRpc([host("__proto__"), host("constructor")]);
		catalog.setExecutableOverride("__proto__", "/opt/proto-omp");
		catalog.setExecutableOverride("constructor", "/opt/constructor-omp");
		catalog.noteWorkspace("__proto__", "/work/proto");
		catalog.noteWorkspace("constructor", "/work/constructor");

		expect(catalog.snapshot().hosts).toMatchObject([
			{ alias: "__proto__", executableOverride: "/opt/proto-omp", recentWorkspaces: ["/work/proto"] },
			{ alias: "constructor", executableOverride: "/opt/constructor-omp", recentWorkspaces: ["/work/constructor"] },
		]);
		const savedOverrides = store.values.get("remoteExecutableOverrides") as Record<string, string>;
		expect(Object.hasOwn(savedOverrides, "__proto__")).toBe(true);
		expect(Object.hasOwn(savedOverrides, "constructor")).toBe(true);
	});

	it("validates persisted preferences and deep-copies snapshots and targets", () => {
		const persistedHost = {
			alias: "build",
			host: {
				host: "build.internal",
				sourceId: "config",
				sourceLevel: "project",
				os: "linux",
			},
		};
		const store = new FakeStore({
			remoteHosts: [persistedHost, { alias: "bad", host: { host: "" } }],
			remoteExecutableOverrides: { build: "/opt/omp", bad: 42 },
			remoteRecentWorkspaces: { build: ["/work/a", "relative", "/work/a"], bad: "not-an-array" },
		});
		const catalog = new RemoteHostCatalog(store);

		const first = catalog.snapshot();
		expect(first).toEqual({
			hosts: [
				{
					alias: "build",
					host: persistedHost.host,
					executableOverride: "/opt/omp",
					recentWorkspaces: ["/work/a"],
				},
			],
			updatedAt: null,
		});
		first.hosts[0]!.host.host = "mutated";
		first.hosts[0]!.recentWorkspaces.push("/mutated");

		const target = catalog.target("build", "/work/repo");
		expect(target).toEqual({
			type: "ssh",
			hostAlias: "build",
			host: persistedHost.host,
			originCwd: "/work/repo",
			cwd: "/work/repo",
			executableOverride: "/opt/omp",
		});
		target!.host.host = "also-mutated";
		expect(catalog.snapshot().hosts[0]?.host.host).toBe("build.internal");
		expect(catalog.target("build", "relative")).toBeNull();
		expect(catalog.target("missing", "/work/repo")).toBeNull();
	});
});
