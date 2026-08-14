import type { RemoteHostCatalogSnapshot, SshConnectionSnapshot, SshSessionTarget } from "../shared/ipc-types";
import type { RpcSshHostInfo } from "../shared/rpc-types";

interface StoredRemoteHost {
	alias: string;
	host: SshConnectionSnapshot;
}

export interface RemoteHostCatalogPrefs {
	remoteHosts?: StoredRemoteHost[];
	remoteExecutableOverrides?: Record<string, string>;
	remoteRecentWorkspaces?: Record<string, string[]>;
}

export interface RemoteHostCatalogStore {
	get<Key extends keyof RemoteHostCatalogPrefs>(key: Key): RemoteHostCatalogPrefs[Key] | undefined;
	set<Key extends keyof RemoteHostCatalogPrefs>(key: Key, value: RemoteHostCatalogPrefs[Key]): void;
}

export interface RemoteHostCatalogOptions {
	maxRecentWorkspaces?: number;
	now?: () => string;
}

const VALID_SOURCE_LEVELS: Record<SshConnectionSnapshot["sourceLevel"], true> = {
	user: true,
	project: true,
	native: true,
};
const VALID_OS: Record<NonNullable<SshConnectionSnapshot["os"]>, true> = {
	windows: true,
	linux: true,
	macos: true,
	unknown: true,
};
const VALID_SHELLS: Record<NonNullable<SshConnectionSnapshot["shell"]>, true> = {
	cmd: true,
	powershell: true,
	bash: true,
	zsh: true,
	sh: true,
	unknown: true,
};
const VALID_TRANSFER_SHELLS: Record<NonNullable<SshConnectionSnapshot["transferShell"]>, true> = {
	sh: true,
	bash: true,
	zsh: true,
};

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || nonEmptyString(value);
}

function cloneHost(host: SshConnectionSnapshot): SshConnectionSnapshot {
	return { ...host };
}

export function isSafeSshDestination(host: string, username?: string): boolean {
	return (
		host.length > 0 &&
		!host.startsWith("-") &&
		!/[\s\u0000-\u001f\u007f-\u009f]/u.test(host) &&
		(username === undefined ||
			(username.length > 0 &&
				!username.startsWith("-") &&
				!username.includes("@") &&
				!/[\s\u0000-\u001f\u007f-\u009f]/u.test(username)))
	);
}

function validateSnapshot(value: unknown): SshConnectionSnapshot | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const fields = value as Record<string, unknown>;
	if (!nonEmptyString(fields.host) || !nonEmptyString(fields.sourceId)) return null;
	if (typeof fields.sourceLevel !== "string" || !(fields.sourceLevel in VALID_SOURCE_LEVELS)) return null;
	if (!optionalString(fields.username) || !optionalString(fields.keyPath)) return null;
	const trimmedHost = fields.host.trim();
	if (!isSafeSshDestination(trimmedHost, fields.username)) return null;
	if (
		fields.port !== undefined &&
		(!Number.isInteger(fields.port) || Number(fields.port) < 1 || Number(fields.port) > 65_535)
	) {
		return null;
	}
	if (fields.compat !== undefined && typeof fields.compat !== "boolean") return null;
	if (fields.os !== undefined && (typeof fields.os !== "string" || !(fields.os in VALID_OS))) return null;
	if (fields.shell !== undefined && (typeof fields.shell !== "string" || !(fields.shell in VALID_SHELLS))) return null;
	if (
		fields.transferShell !== undefined &&
		(typeof fields.transferShell !== "string" || !(fields.transferShell in VALID_TRANSFER_SHELLS))
	) {
		return null;
	}

	const snapshot: SshConnectionSnapshot = {
		host: trimmedHost,
		sourceId: fields.sourceId,
		sourceLevel: fields.sourceLevel as SshConnectionSnapshot["sourceLevel"],
	};
	if (fields.username !== undefined) snapshot.username = fields.username;
	if (fields.port !== undefined) snapshot.port = Number(fields.port);
	if (fields.keyPath !== undefined) snapshot.keyPath = fields.keyPath;
	if (fields.compat !== undefined) snapshot.compat = fields.compat;
	if (fields.os !== undefined) snapshot.os = fields.os as NonNullable<SshConnectionSnapshot["os"]>;
	if (fields.shell !== undefined) snapshot.shell = fields.shell as NonNullable<SshConnectionSnapshot["shell"]>;
	if (fields.transferShell !== undefined) {
		snapshot.transferShell = fields.transferShell as NonNullable<SshConnectionSnapshot["transferShell"]>;
	}
	return snapshot;
}

function snapshotFromRpc(value: unknown): StoredRemoteHost | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const fields = value as Record<string, unknown>;
	if (!nonEmptyString(fields.name) || !nonEmptyString(fields.host) || !nonEmptyString(fields.source)) return null;
	const candidate: Record<string, unknown> = {
		host: fields.host,
		username: fields.username,
		port: fields.port,
		keyPath: fields.keyPath,
		compat: fields.compat,
		os: fields.os,
		shell: fields.shell,
		transferShell: fields.transferShell,
		sourceId: fields.source,
		sourceLevel: fields.scope,
	};
	const validated = validateSnapshot(candidate);
	return validated ? { alias: fields.name.trim(), host: validated } : null;
}

function isAbsoluteRemotePath(path: string, host: SshConnectionSnapshot): boolean {
	if (host.os === "windows") return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
	if (host.os === "linux" || host.os === "macos") return path.startsWith("/");
	return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
}

export class RemoteHostCatalog {
	readonly #store: RemoteHostCatalogStore;
	readonly #maxRecentWorkspaces: number;
	readonly #now: () => string;
	#hosts: StoredRemoteHost[];
	#overrides: Map<string, string>;
	#recents: Map<string, string[]>;
	#updatedAt: string | null = null;

	constructor(store: RemoteHostCatalogStore, options: RemoteHostCatalogOptions = {}) {
		this.#store = store;
		this.#maxRecentWorkspaces = Math.max(1, Math.floor(options.maxRecentWorkspaces ?? 10));
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#hosts = this.#loadHosts(store.get("remoteHosts"));
		this.#overrides = this.#loadOverrides(store.get("remoteExecutableOverrides"));
		this.#recents = this.#loadRecents(store.get("remoteRecentWorkspaces"));
	}

	snapshot(): RemoteHostCatalogSnapshot {
		return {
			hosts: this.#hosts.map(({ alias, host }) => {
				const entry = {
					alias,
					host: cloneHost(host),
					recentWorkspaces: [...(this.#recents.get(alias) ?? [])],
				};
				const executableOverride = this.#overrides.get(alias);
				return executableOverride ? { ...entry, executableOverride } : entry;
			}),
			updatedAt: this.#updatedAt,
		};
	}

	replaceFromRpc(hosts: RpcSshHostInfo[]): RemoteHostCatalogSnapshot {
		const next: StoredRemoteHost[] = [];
		const aliases = new Set<string>();
		for (const value of hosts) {
			const converted = snapshotFromRpc(value);
			if (!converted || aliases.has(converted.alias)) continue;
			aliases.add(converted.alias);
			next.push(converted);
		}
		this.#hosts = next;
		this.#overrides = new Map([...this.#overrides].filter(([alias]) => aliases.has(alias)));
		this.#recents = new Map(
			[...this.#recents].filter(([alias]) => aliases.has(alias)).map(([alias, paths]) => [alias, [...paths]]),
		);
		this.#store.set("remoteExecutableOverrides", Object.fromEntries(this.#overrides));
		this.#store.set("remoteRecentWorkspaces", Object.fromEntries(this.#recents));
		this.#updatedAt = this.#now();
		this.#store.set(
			"remoteHosts",
			this.#hosts.map(({ alias, host }) => ({ alias, host: cloneHost(host) })),
		);
		return this.snapshot();
	}

	setExecutableOverride(hostAlias: string, value: string | null): RemoteHostCatalogSnapshot {
		if (!this.#hosts.some(entry => entry.alias === hostAlias)) return this.snapshot();
		const trimmed = value?.trim() ?? "";
		if (trimmed.length > 0) this.#overrides.set(hostAlias, trimmed);
		else this.#overrides.delete(hostAlias);
		this.#store.set("remoteExecutableOverrides", Object.fromEntries(this.#overrides));
		return this.snapshot();
	}

	noteWorkspace(hostAlias: string, cwd: string): RemoteHostCatalogSnapshot {
		const row = this.#hosts.find(entry => entry.alias === hostAlias);
		if (!row || !nonEmptyString(cwd) || !isAbsoluteRemotePath(cwd, row.host)) return this.snapshot();
		const previous = this.#recents.get(hostAlias) ?? [];
		this.#recents.set(hostAlias, [cwd, ...previous.filter(path => path !== cwd)].slice(0, this.#maxRecentWorkspaces));
		this.#store.set("remoteRecentWorkspaces", Object.fromEntries(this.#recents));
		return this.snapshot();
	}

	target(hostAlias: string, cwd: string): SshSessionTarget | null {
		const row = this.#hosts.find(entry => entry.alias === hostAlias);
		if (!row || !nonEmptyString(cwd) || !isAbsoluteRemotePath(cwd, row.host)) return null;
		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias,
			host: cloneHost(row.host),
			originCwd: cwd,
			cwd,
		};
		const executableOverride = this.#overrides.get(hostAlias);
		if (executableOverride) target.executableOverride = executableOverride;
		return target;
	}

	#loadHosts(value: unknown): StoredRemoteHost[] {
		if (!Array.isArray(value)) return [];
		const hosts: StoredRemoteHost[] = [];
		const aliases = new Set<string>();
		for (const row of value) {
			if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
			const fields = row as Record<string, unknown>;
			if (!nonEmptyString(fields.alias) || aliases.has(fields.alias)) continue;
			const host = validateSnapshot(fields.host);
			if (!host) continue;
			aliases.add(fields.alias);
			hosts.push({ alias: fields.alias, host });
		}
		return hosts;
	}

	#loadOverrides(value: unknown): Map<string, string> {
		const overrides = new Map<string, string>();
		if (typeof value !== "object" || value === null || Array.isArray(value)) return overrides;
		for (const [alias, executable] of Object.entries(value)) {
			if (this.#hosts.some(entry => entry.alias === alias) && nonEmptyString(executable)) {
				overrides.set(alias, executable.trim());
			}
		}
		return overrides;
	}

	#loadRecents(value: unknown): Map<string, string[]> {
		const recents = new Map<string, string[]>();
		if (typeof value !== "object" || value === null || Array.isArray(value)) return recents;
		const stored = value as Record<string, unknown>;
		for (const { alias, host } of this.#hosts) {
			const paths = Object.hasOwn(stored, alias) ? stored[alias] : undefined;
			if (!Array.isArray(paths)) continue;
			const validated: string[] = [];
			for (const path of paths) {
				if (
					typeof path === "string" &&
					isAbsoluteRemotePath(path, host) &&
					!validated.includes(path) &&
					validated.length < this.#maxRecentWorkspaces
				) {
					validated.push(path);
				}
			}
			if (validated.length > 0) recents.set(alias, validated);
		}
		return recents;
	}
}
