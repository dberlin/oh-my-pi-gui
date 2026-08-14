import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { SshSessionTarget } from "../shared/ipc-types";
import type {
	RpcResponse,
	RpcSshHostInfo,
	RpcSshHostInput,
	RpcSshHostsResult,
	RpcSshTestResult,
} from "../shared/rpc-types";
import type { LocalSshSettingsCommand, LocalSshSettingsDependency } from "./ipc";
import { isSafeSshDestination } from "./remote-host-catalog";
import type { RemoteRuntimeResolution } from "./remote-ssh";

export interface LocalSshSettingsServiceOptions {
	home: string;
	isOpenSshAvailable(): Promise<boolean>;
	resolveRuntime(target: SshSessionTarget, signal?: AbortSignal): Promise<RemoteRuntimeResolution>;
	writeConfig?(filePath: string, config: Record<string, unknown>): Promise<void>;
}

interface LocalSshConfigFile {
	[key: string]: unknown;
	hosts?: Record<string, unknown>;
}

type ManageCommand = Extract<LocalSshSettingsCommand, { type: "ssh_manage" }>;
type TestCommand = Extract<LocalSshSettingsCommand, { type: "ssh_test" }>;

const SshHostInputSchema = z
	.object({
		host: z.string(),
		username: z.string().optional(),
		port: z.number().int().min(1).max(65_535).optional(),
		keyPath: z.string().optional(),
		description: z.string().optional(),
		compat: z.boolean().optional(),
	})
	.strict();

const LocalSshSettingsCommandSchema = z.union([
	z.object({ id: z.string().optional(), type: z.literal("get_ssh_hosts") }).strict(),
	z
		.object({
			id: z.string().optional(),
			type: z.literal("ssh_manage"),
			action: z.enum(["create", "update", "delete"]),
			scope: z.enum(["project", "user"]),
			name: z.string(),
			previousName: z.string().optional(),
			previousScope: z.enum(["project", "user"]).optional(),
			host: SshHostInputSchema.optional(),
		})
		.strict()
		.refine(value => value.action === "delete" || value.host !== undefined),
	z
		.object({
			id: z.string().optional(),
			type: z.literal("ssh_test"),
			host: SshHostInputSchema.extend({ name: z.string() }).strict(),
		})
		.strict(),
]);

export function isLocalSshSettingsCommand(value: unknown): value is LocalSshSettingsCommand {
	return LocalSshSettingsCommandSchema.safeParse(value).success;
}

export function isLocalSshSettingsCommandType(value: unknown): value is { type: LocalSshSettingsCommand["type"] } {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) return false;
	return value.type === "get_ssh_hosts" || value.type === "ssh_manage" || value.type === "ssh_test";
}

function parseHost(
	name: string,
	value: unknown,
	scope: "project" | "user",
	source: string,

	warnings: string[],
): RpcSshHostInfo | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		warnings.push(`Invalid SSH host entry in ${source}: ${name}`);
		return null;
	}
	const fields = value as Record<string, unknown>;
	const host = typeof fields.host === "string" ? fields.host.trim() : "";
	const username = typeof fields.username === "string" ? fields.username.trim() : undefined;
	if (!host || !isSafeSshDestination(host, username || undefined)) {
		warnings.push(`Invalid SSH destination in ${source}: ${name}`);
		return null;
	}
	if (
		fields.port !== undefined &&
		(!Number.isInteger(fields.port) || Number(fields.port) < 1 || Number(fields.port) > 65_535)
	) {
		warnings.push(`Invalid SSH port in ${source}: ${name}`);
		return null;
	}
	if (fields.compat !== undefined && typeof fields.compat !== "boolean") {
		warnings.push(`Invalid SSH compatibility flag in ${source}: ${name}`);
		return null;
	}
	const info: RpcSshHostInfo = {
		name,
		host,
		scope,
		editable: true,
		source,
	};
	if (username) info.username = username;
	if (fields.port !== undefined) info.port = Number(fields.port);
	if (typeof fields.keyPath === "string" && fields.keyPath.trim()) info.keyPath = fields.keyPath.trim();
	if (typeof fields.description === "string" && fields.description.trim()) {
		info.description = fields.description.trim();
	}
	if (fields.compat === true) info.compat = true;
	return info;
}
async function readConfig(filePath: string): Promise<LocalSshConfigFile> {
	try {
		const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`Invalid SSH config file: ${filePath}`);
		}
		const config = value as LocalSshConfigFile;
		if (
			config.hosts !== undefined &&
			(typeof config.hosts !== "object" || config.hosts === null || Array.isArray(config.hosts))
		) {
			throw new Error(`Invalid hosts object in SSH config file: ${filePath}`);
		}
		return config;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

async function writeConfig(filePath: string, config: LocalSshConfigFile): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		await fs.rename(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true });
		throw error;
	}
}

function normalizeManagedHost(name: string, value: RpcSshHostInput | undefined): Record<string, unknown> {
	const trimmedName = name.trim();
	if (!trimmedName || trimmedName.startsWith("-") || /[\s\u0000-\u001f\u007f-\u009f]/u.test(trimmedName)) {
		throw new Error("Invalid SSH host name");
	}
	if (!value) throw new Error("SSH host details are required");
	const host = value.host.trim();
	const username = value.username?.trim();
	if (!isSafeSshDestination(host, username || undefined)) throw new Error("Invalid SSH destination");
	if (value.port !== undefined && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65_535)) {
		throw new Error("SSH port must be an integer between 1 and 65535");
	}
	const normalized: Record<string, unknown> = { host };
	if (username) normalized.username = username;
	if (value.port !== undefined) normalized.port = value.port;
	if (value.keyPath?.trim()) normalized.keyPath = value.keyPath.trim();
	if (value.description?.trim()) normalized.description = value.description.trim();
	if (value.compat === true) normalized.compat = true;
	return normalized;
}

async function readHosts(filePath: string, scope: "project" | "user", warnings: string[]): Promise<RpcSshHostInfo[]> {
	let config: LocalSshConfigFile;
	try {
		config = await readConfig(filePath);
	} catch (error) {
		warnings.push(
			`Failed to read SSH config file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
	if (config.hosts === undefined) return [];
	if (typeof config.hosts !== "object" || config.hosts === null || Array.isArray(config.hosts)) {
		warnings.push(`Invalid hosts object in SSH config file: ${filePath}`);
		return [];
	}
	const hosts: RpcSshHostInfo[] = [];
	for (const [name, value] of Object.entries(config.hosts)) {
		const trimmedName = name.trim();
		if (!trimmedName) {
			warnings.push(`Invalid empty SSH host name in ${filePath}`);
			continue;
		}
		const host = parseHost(trimmedName, value, scope, filePath, warnings);
		if (host) hosts.push(host);
	}
	return hosts;
}

export class LocalSshSettingsService implements LocalSshSettingsDependency {
	readonly #options: LocalSshSettingsServiceOptions;
	readonly #writeConfig: (filePath: string, config: LocalSshConfigFile) => Promise<void>;
	#mutationTail: Promise<void> = Promise.resolve();

	constructor(options: LocalSshSettingsServiceOptions) {
		this.#options = options;
		this.#writeConfig = options.writeConfig ?? writeConfig;
	}

	async execute(cwd: string, input: unknown): Promise<RpcResponse> {
		if (!isLocalSshSettingsCommand(input)) {
			const id =
				typeof input === "object" && input !== null && "id" in input && typeof input.id === "string"
					? input.id
					: undefined;
			const command =
				typeof input === "object" && input !== null && "type" in input && typeof input.type === "string"
					? input.type
					: "invalid";
			return {
				id,
				type: "response",
				command,
				success: false,
				error: "Invalid local SSH settings command",
			};
		}
		const command = input;
		try {
			let data: unknown;
			switch (command.type) {
				case "get_ssh_hosts":
					await this.#mutationTail;
					data = await this.#list(cwd);
					break;
				case "ssh_manage": {
					const operation = this.#mutationTail.then(() => this.#manage(cwd, command));
					this.#mutationTail = operation.then(
						() => undefined,
						() => undefined,
					);
					data = await operation;
					break;
				}
				case "ssh_test":
					data = await this.#test(command);
					break;
			}
			return {
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data,
			};
		} catch (error) {
			return {
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async #list(cwd: string): Promise<RpcSshHostsResult> {
		const warnings: string[] = [];
		const projectPath = path.join(cwd, ".omp", "ssh.json");
		const userPath = path.join(this.#options.home, ".omp", "agent", "ssh.json");
		const [projectHosts, userHosts, openSshAvailable] = await Promise.all([
			readHosts(projectPath, "project", warnings),
			readHosts(userPath, "user", warnings),
			this.#options.isOpenSshAvailable(),
		]);
		const aliases = new Set(projectHosts.map(host => host.name));
		const visibleUserHosts = userHosts.filter(host => {
			if (!aliases.has(host.name)) {
				aliases.add(host.name);
				return true;
			}
			warnings.push(`Ignored user SSH host shadowed by project config: ${host.name}`);
			return false;
		});
		return {
			openSshAvailable,
			hosts: [...projectHosts, ...visibleUserHosts],
			warnings,
		};
	}

	async #manage(cwd: string, command: ManageCommand): Promise<Record<string, never>> {
		const destinationPath =
			command.scope === "project"
				? path.join(cwd, ".omp", "ssh.json")
				: path.join(this.#options.home, ".omp", "agent", "ssh.json");
		if (command.action === "create") {
			const config = await readConfig(destinationPath);
			const hosts = { ...(config.hosts ?? {}) };
			if (Object.hasOwn(hosts, command.name)) throw new Error(`SSH host already exists: ${command.name}`);
			hosts[command.name] = normalizeManagedHost(command.name, command.host);
			await this.#writeConfig(destinationPath, { ...config, hosts });
			return {};
		}

		const previousScope = command.previousScope ?? command.scope;
		const previousName = command.previousName ?? command.name;
		const sourcePath =
			previousScope === "project"
				? path.join(cwd, ".omp", "ssh.json")
				: path.join(this.#options.home, ".omp", "agent", "ssh.json");
		const sourceConfig = await readConfig(sourcePath);
		const sourceHosts = { ...(sourceConfig.hosts ?? {}) };
		if (!Object.hasOwn(sourceHosts, previousName)) throw new Error(`SSH host not found: ${previousName}`);

		if (command.action === "delete") {
			delete sourceHosts[previousName];
			await this.#writeConfig(sourcePath, { ...sourceConfig, hosts: sourceHosts });
			return {};
		}

		const nextHost = normalizeManagedHost(command.name, command.host);
		if (sourcePath === destinationPath) {
			if (command.name !== previousName && Object.hasOwn(sourceHosts, command.name)) {
				throw new Error(`SSH host already exists: ${command.name}`);
			}
			delete sourceHosts[previousName];
			sourceHosts[command.name] = nextHost;
			await this.#writeConfig(sourcePath, { ...sourceConfig, hosts: sourceHosts });
			return {};
		}

		const destinationConfig = await readConfig(destinationPath);
		const destinationHosts = { ...(destinationConfig.hosts ?? {}) };
		if (Object.hasOwn(destinationHosts, command.name)) throw new Error(`SSH host already exists: ${command.name}`);
		destinationHosts[command.name] = nextHost;
		await this.#writeConfig(destinationPath, { ...destinationConfig, hosts: destinationHosts });
		delete sourceHosts[previousName];
		try {
			await this.#writeConfig(sourcePath, { ...sourceConfig, hosts: sourceHosts });
		} catch (sourceError) {
			try {
				await this.#writeConfig(destinationPath, destinationConfig);
			} catch (rollbackError) {
				throw new Error(
					`Failed to update source SSH config and roll back destination: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
					{ cause: sourceError },
				);
			}
			throw sourceError;
		}
		return {};
	}

	async #test(command: TestCommand): Promise<RpcSshTestResult> {
		const normalized = normalizeManagedHost(command.host.name, command.host);
		const host: SshSessionTarget["host"] = {
			host: String(normalized.host),
			sourceId: `gui-draft:${command.host.name}`,
			sourceLevel: "project",
		};
		if (typeof normalized.username === "string") host.username = normalized.username;
		if (typeof normalized.port === "number") host.port = normalized.port;
		if (typeof normalized.keyPath === "string") host.keyPath = normalized.keyPath;
		if (normalized.compat === true) host.compat = true;
		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: command.host.name,
			host,
			originCwd: "/",
			cwd: "/",
		};
		const checkedAt = new Date().toISOString();
		const resolution = await this.#options.resolveRuntime(target);
		if (!resolution.ok) {
			return { name: command.host.name, ok: false, checkedAt, error: resolution.error };
		}
		const shellName = resolution.runtime.shell.split(/[\\/]/).at(-1)?.toLowerCase();
		const shell: RpcSshHostInfo["shell"] =
			shellName === "cmd" ||
			shellName === "powershell" ||
			shellName === "bash" ||
			shellName === "zsh" ||
			shellName === "sh"
				? shellName
				: "unknown";
		return {
			name: command.host.name,
			ok: true,
			checkedAt,
			os: resolution.runtime.platform,
			shell,
			...(host.compat && (shell === "bash" || shell === "sh") ? { compatShell: shell } : {}),
		};
	}
}
