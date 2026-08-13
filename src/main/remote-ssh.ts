import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	FsTreeEntry,
	RemoteDirectoryEntry,
	RemoteDirectoryListResult,
	RemoteDirectoryValidationResult,
	RemotePreflightResult,
	SshConnectionSnapshot,
	SshSessionTarget,
} from "../shared/ipc-types";
import { isSshSessionTarget } from "../shared/session-target";

export interface RemoteProcessRunner {
	spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
}

export const nodeRemoteProcessRunner: RemoteProcessRunner = {
	spawn(command, args, options) {
		return spawn(command, args, options);
	},
};

export interface RemoteRuntimeInfo {
	home: string;
	platform: "windows" | "linux" | "macos";
	shell: string;
	executable: string;
	runtimePath: string[];
}

export type RemoteRuntimeResolution =
	| { ok: true; target: SshSessionTarget; runtime: RemoteRuntimeInfo }
	| { ok: false; error: string };
export type FinalRemoteTargetAuthorization = () => SshSessionTarget | null;

export interface RemoteChildHandle {
	child: ChildProcess;
	terminate(): Promise<void>;
}

export type RemoteFileResult =
	| { ok: true; data: Uint8Array; size: number; truncated: boolean }
	| { ok: false; error: string };

export type RemoteWorkspaceListResult =
	| { ok: true; entries: FsTreeEntry[]; truncated: boolean }
	| { ok: false; error: string };

export interface RemoteSshServiceOptions {
	connectTimeoutSeconds?: number;
	controlPathRoot?: string;
	controlPathReady?: (controlPath: string) => Promise<boolean>;
	operationTimeoutMs?: number;
	stdoutCapBytes?: number;
	stderrCapBytes?: number;
	maxDirectoryEntries?: number;
	terminationGraceMs?: number;
	platform?: NodeJS.Platform;
	markerFactory?: () => string;
	killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

interface BoundedResult {
	ok: boolean;
	stdout: Uint8Array;
	error?: string;
}

interface DirectoryHeader {
	path: string;
	parent: string | null;
}

interface WorkspaceEntryRecord {
	depth: number;
	kind: "file" | "dir";
	name: string;
	path: string;
}

interface RecordScan {
	records: Buffer[];
	tooMany: boolean;
}

type RemoteFileHelper =
	| { kind: "linux-shell"; readlink: string; stat: string; dd: string; base64: string }
	| { kind: "macos-python"; executable: string }
	| { kind: "windows" };

interface RuntimeProbe {
	runtime: RemoteRuntimeInfo;
	fileHelper: RemoteFileHelper | null;
}
function scanRecords(bytes: Uint8Array, delimiter: number, maxRecords: number, trimCarriageReturn = false): RecordScan {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const records: Buffer[] = [];
	let start = 0;
	for (let index = 0; index <= buffer.length; index++) {
		if (index !== buffer.length && buffer[index] !== delimiter) continue;
		let end = index;
		if (trimCarriageReturn && end > start && buffer[end - 1] === 13) end--;
		if (end > start) {
			if (records.length === maxRecords) return { records, tooMany: true };
			records.push(buffer.subarray(start, end));
		}
		start = index + 1;
	}
	return { records, tooMany: false };
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;
const DEFAULT_STDOUT_CAP_BYTES = 1_048_576;
const DEFAULT_STDERR_CAP_BYTES = 16_384;
const DEFAULT_DIRECTORY_ENTRY_CAP = 500;
const DEFAULT_TERMINATION_GRACE_MS = 750;
const MAX_FILE_BYTES = 25_000_001;
const MAX_WORKSPACE_DEPTH = 16;
const MAX_WORKSPACE_ENTRIES = 20_000;
const MAX_WORKSPACE_STDOUT_BYTES = 4 * 1_048_576;
const FILE_HEADER_BYTES = 64;
const WINDOWS_UTF8_OUTPUT = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)";

export const REMOTE_HOST_ALIAS_MAX_BYTES = 256;
export const REMOTE_CURSOR_MAX_BYTES = 4_096;
export const REMOTE_SESSION_ID_MAX_BYTES = 4_096;
export const REMOTE_PATH_MAX_BYTES = 16_384;
export const REMOTE_EXECUTABLE_OVERRIDE_MAX_BYTES = REMOTE_PATH_MAX_BYTES;
export const REMOTE_ROOTS_MAX_COUNT = 128;
export const REMOTE_LAUNCH_ARGS_MAX_COUNT = 256;

export function remoteInputWithinBytes(value: unknown, maxBytes: number): value is string {
	return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}

export function isBoundedRemoteTargetInput(target: unknown): target is SshSessionTarget {
	return (
		isSshSessionTarget(target) &&
		target.hostAlias.length > 0 &&
		remoteInputWithinBytes(target.hostAlias, REMOTE_HOST_ALIAS_MAX_BYTES) &&
		target.originCwd.length > 0 &&
		remoteInputWithinBytes(target.originCwd, REMOTE_PATH_MAX_BYTES) &&
		target.cwd.length > 0 &&
		remoteInputWithinBytes(target.cwd, REMOTE_PATH_MAX_BYTES) &&
		(target.executableOverride === undefined ||
			(target.executableOverride.length > 0 &&
				remoteInputWithinBytes(target.executableOverride, REMOTE_EXECUTABLE_OVERRIDE_MAX_BYTES)))
	);
}

function isBoundedRemoteRuntimeInput(runtime: RemoteRuntimeInfo): boolean {
	return (
		(runtime.platform === "windows" || runtime.platform === "linux" || runtime.platform === "macos") &&
		runtime.executable.length > 0 &&
		remoteInputWithinBytes(runtime.executable, REMOTE_EXECUTABLE_OVERRIDE_MAX_BYTES) &&
		Array.isArray(runtime.runtimePath) &&
		runtime.runtimePath.length <= REMOTE_ROOTS_MAX_COUNT &&
		runtime.runtimePath.every(entry => remoteInputWithinBytes(entry, REMOTE_PATH_MAX_BYTES))
	);
}

function areBoundedRemoteLaunchArgs(args: string[]): boolean {
	if (
		!Array.isArray(args) ||
		args.length > REMOTE_LAUNCH_ARGS_MAX_COUNT ||
		args.some(arg => !remoteInputWithinBytes(arg, REMOTE_PATH_MAX_BYTES))
	) {
		return false;
	}
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--resume" && !remoteInputWithinBytes(args[index + 1], REMOTE_SESSION_ID_MAX_BYTES)) {
			return false;
		}
	}
	return true;
}

function windowsSafeHandleSource(): string {
	return [
		"using System;",
		"using System.IO;",
		"using System.Runtime.InteropServices;",
		"using System.Text;",
		"using Microsoft.Win32.SafeHandles;",
		"public static class OmpRemoteFile {",
		' [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
		" static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);",
		' [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]',
		" static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);",
		" public static SafeFileHandle OpenFile(string path) { return CreateFile(path, 0x80000000, 7, IntPtr.Zero, 3, 0x80, IntPtr.Zero); }",
		" public static SafeFileHandle OpenDirectory(string path) { return CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero); }",
		' public static string FinalPath(SafeFileHandle handle) { var value=new StringBuilder(32768); var length=GetFinalPathNameByHandle(handle,value,(uint)value.Capacity,0); if(length==0 || length>=value.Capacity) throw new IOException("GetFinalPathNameByHandle failed"); return value.ToString(); }',
		"}",
	].join("\n");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powershellQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function encodeUtf8(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

function encodePowerShell(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

function decodeBase64(value: string): string | null {
	if (
		value.length === 0 ||
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		return null;
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) return null;
	return decoded.toString("utf8");
}

function chunkBuffer(value: unknown): Buffer {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return Buffer.from(String(value), "utf8");
}

function cloneTarget(target: SshSessionTarget): SshSessionTarget {
	return { ...target, host: { ...target.host } };
}
function finalAuthorizedTarget(authorize: FinalRemoteTargetAuthorization): SshSessionTarget | null {
	try {
		const target = authorize();
		return isBoundedRemoteTargetInput(target) ? cloneTarget(target) : null;
	} catch {
		return null;
	}
}

function errorWithStderr(message: string, stderr: Buffer): string {
	const detail = stderr.toString("utf8").trim();
	return detail.length > 0 ? `${message}: ${detail}` : message;
}

function posixDecodeFunction(): string {
	return "decode_b64() { printf '%s' \"$1\" | base64 --decode 2>/dev/null || printf '%s' \"$1\" | base64 -D; }";
}

function posixEncodeFunction(): string {
	return "encode_b64() { printf '%s' \"$1\" | base64 | tr -d '\\r\\n'; }";
}

class ServiceChildHandle implements RemoteChildHandle {
	readonly child: ChildProcess;
	readonly #terminateOwned: () => Promise<void>;
	#terminatePromise: Promise<void> | null = null;

	constructor(child: ChildProcess, terminateOwned: () => Promise<void>) {
		this.child = child;
		this.#terminateOwned = terminateOwned;
	}

	terminate(): Promise<void> {
		this.#terminatePromise ??= this.#terminateOwned();
		return this.#terminatePromise;
	}
}

export class RemoteSshService {
	readonly #runner: RemoteProcessRunner;
	readonly #connectTimeoutSeconds: number;
	readonly #operationTimeoutMs: number;
	readonly #controlPathRoot: string | undefined;
	readonly #controlPathReady: (controlPath: string) => Promise<boolean>;
	readonly #stdoutCapBytes: number;
	readonly #stderrCapBytes: number;
	readonly #maxDirectoryEntries: number;
	readonly #terminationGraceMs: number;
	readonly #platform: NodeJS.Platform;
	readonly #markerFactory: () => string;
	readonly #killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
	readonly #activeHandles = new Set<RemoteChildHandle>();
	readonly #closedChildren = new WeakSet<ChildProcess>();
	readonly #fileHelpers = new WeakMap<RemoteRuntimeInfo, RemoteFileHelper>();
	readonly #controlMasters = new Map<string, RemoteChildHandle>();
	readonly #controlMasterStarts = new Map<string, Promise<boolean>>();
	#disposePromise: Promise<void> | null = null;

	constructor(runner: RemoteProcessRunner, options: RemoteSshServiceOptions = {}) {
		this.#runner = runner;
		this.#connectTimeoutSeconds = Math.max(
			1,
			Math.floor(options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS),
		);
		this.#controlPathRoot = options.controlPathRoot;
		this.#controlPathReady =
			options.controlPathReady ??
			(async controlPath => {
				try {
					return (await fs.stat(controlPath)).isSocket();
				} catch {
					return false;
				}
			});
		this.#operationTimeoutMs = Math.max(1, Math.floor(options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS));
		this.#stdoutCapBytes = Math.max(1, Math.floor(options.stdoutCapBytes ?? DEFAULT_STDOUT_CAP_BYTES));
		this.#stderrCapBytes = Math.max(1, Math.floor(options.stderrCapBytes ?? DEFAULT_STDERR_CAP_BYTES));
		this.#maxDirectoryEntries = Math.max(1, Math.floor(options.maxDirectoryEntries ?? DEFAULT_DIRECTORY_ENTRY_CAP));
		this.#terminationGraceMs = Math.max(1, Math.floor(options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS));
		this.#platform = options.platform ?? process.platform;
		this.#markerFactory = options.markerFactory ?? (() => `__OMP_REMOTE_${randomBytes(16).toString("hex")}__`);
		this.#killProcessGroup = options.killProcessGroup ?? ((pid, signal) => process.kill(pid, signal));
	}

	connectionArgs(host: SshConnectionSnapshot): string[] {
		return this.#connectionArgs(host, false);
	}

	#connectionArgs(host: SshConnectionSnapshot, controlMaster: boolean): string[] {
		const controlPath = this.#controlPath(host);
		const args = [
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			`ConnectTimeout=${this.#connectTimeoutSeconds}`,
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=2",
		];
		if (controlPath) {
			args.push(
				"-o",
				`ControlMaster=${controlMaster ? "yes" : "no"}`,
				"-o",
				"ControlPersist=no",
				"-o",
				`ControlPath=${controlPath}`,
			);
		}
		args.push("-T");
		if (controlMaster) args.push("-N");
		if (host.port !== undefined) args.push("-p", String(host.port));
		if (host.keyPath) args.push("-i", host.keyPath);
		args.push("--", host.username ? `${host.username}@${host.host}` : host.host);
		return args;
	}

	#controlPath(host: SshConnectionSnapshot): string | undefined {
		if (
			typeof host.host !== "string" ||
			host.host.length === 0 ||
			host.host.startsWith("-") ||
			/[\s\u0000-\u001f\u007f-\u009f]/u.test(host.host) ||
			(host.username !== undefined &&
				(host.username.length === 0 ||
					host.username.startsWith("-") ||
					host.username.includes("@") ||
					/[\s\u0000-\u001f\u007f-\u009f]/u.test(host.username)))
		) {
			throw new TypeError("Invalid SSH connection destination");
		}
		if (this.#platform === "win32" || this.#controlPathRoot === undefined) return undefined;
		return path.join(
			this.#controlPathRoot,
			`omp-gui-ssh-${createHash("sha256")
				.update(
					JSON.stringify([
						host.host,
						host.username ?? null,
						host.port ?? null,
						host.keyPath ?? null,
						host.compat ?? null,
						host.os ?? null,
						host.shell ?? null,
						host.transferShell ?? null,
						host.sourceId,
						host.sourceLevel,
					]),
				)
				.digest("hex")
				.slice(0, 24)}`,
		);
	}

	async resolveRuntime(target: SshSessionTarget, signal?: AbortSignal): Promise<RemoteRuntimeResolution> {
		if (!isBoundedRemoteTargetInput(target)) return { ok: false, error: "Invalid SSH session target" };
		const marker = this.#markerFactory();
		if (!/^__OMP_REMOTE_[A-Za-z0-9]+__$/.test(marker)) return { ok: false, error: "Invalid runtime marker" };
		const remoteCommand =
			target.host.os === "windows"
				? this.#windowsProbe(marker, target.executableOverride)
				: this.#posixProbe(marker, target.executableOverride);
		const result = await this.#runBounded(target, remoteCommand, signal);
		if (!result.ok) return { ok: false, error: result.error ?? "Remote runtime probe failed" };
		const probe = this.#parseRuntimeProbe(Buffer.from(result.stdout).toString("utf8"), marker);
		if (!probe) return { ok: false, error: "Invalid remote runtime probe output" };
		if (probe.fileHelper) this.#fileHelpers.set(probe.runtime, probe.fileHelper);
		return { ok: true, target: cloneTarget(target), runtime: probe.runtime };
	}

	async preflight(
		target: SshSessionTarget,
		signal: AbortSignal | undefined,
		finalAuthorization: FinalRemoteTargetAuthorization,
	): Promise<RemotePreflightResult> {
		if (!isBoundedRemoteTargetInput(target)) return { ok: false, error: "Invalid SSH session target" };
		const freshTarget = finalAuthorizedTarget(finalAuthorization);
		if (!freshTarget) return { ok: false, error: "Stale or altered SSH target" };
		const resolution = await this.resolveRuntime(freshTarget, signal);
		if (!resolution.ok) return resolution;
		return {
			ok: true,
			target: resolution.target,
			home: resolution.runtime.home,
			platform: resolution.runtime.platform,
			executable: resolution.runtime.executable,
		};
	}

	async listDirectories(
		target: SshSessionTarget,
		path: string,
		showHidden: boolean,
		signal: AbortSignal | undefined,
		finalAuthorization: FinalRemoteTargetAuthorization,
	): Promise<RemoteDirectoryListResult> {
		if (
			!isBoundedRemoteTargetInput(target) ||
			typeof path !== "string" ||
			path.length === 0 ||
			!remoteInputWithinBytes(path, REMOTE_PATH_MAX_BYTES)
		) {
			return { ok: false, error: "Invalid remote directory path" };
		}
		const resolution = await this.resolveRuntime(target, signal);
		if (!resolution.ok) return resolution;
		const command =
			resolution.runtime.platform === "windows"
				? this.#windowsListCommand(path, showHidden)
				: this.#posixListCommand(path, showHidden);
		const freshTarget = finalAuthorizedTarget(finalAuthorization);
		if (!freshTarget) return { ok: false, error: "Stale or altered SSH target" };
		const result = await this.#runBounded(freshTarget, command, signal);
		if (!result.ok) return { ok: false, error: result.error ?? "Remote directory listing failed" };
		return resolution.runtime.platform === "windows"
			? this.#parseWindowsDirectories(result.stdout, showHidden)
			: this.#parsePosixDirectories(result.stdout, showHidden);
	}

	async validateDirectory(
		target: SshSessionTarget,
		path: string,
		signal: AbortSignal | undefined,
		finalAuthorization: FinalRemoteTargetAuthorization,
	): Promise<RemoteDirectoryValidationResult> {
		if (
			!isBoundedRemoteTargetInput(target) ||
			typeof path !== "string" ||
			path.length === 0 ||
			!remoteInputWithinBytes(path, REMOTE_PATH_MAX_BYTES)
		) {
			return { ok: false, error: "Invalid remote directory path" };
		}
		const resolution = await this.resolveRuntime(target, signal);
		if (!resolution.ok) return resolution;
		const command =
			resolution.runtime.platform === "windows"
				? this.#windowsValidateCommand(path)
				: this.#posixValidateCommand(path);
		const freshTarget = finalAuthorizedTarget(finalAuthorization);
		if (!freshTarget) return { ok: false, error: "Stale or altered SSH target" };
		const result = await this.#runBounded(freshTarget, command, signal);
		if (!result.ok) return { ok: false, error: result.error ?? "Remote directory validation failed" };
		if (resolution.runtime.platform === "windows") {
			const text = Buffer.from(result.stdout).toString("utf8").trim();
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return { ok: false, error: "Invalid remote directory validation output" };
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return { ok: false, error: "Invalid remote directory validation output" };
			}
			const record = parsed as { path?: unknown };
			return typeof record.path === "string" && record.path.length > 0
				? { ok: true, path: record.path }
				: { ok: false, error: "Invalid remote directory validation output" };
		}
		const records = Buffer.from(result.stdout)
			.toString("utf8")
			.split("\0")
			.filter(record => record.length > 0);
		if (records.length !== 1) return { ok: false, error: "Invalid remote directory validation output" };
		const fields = records[0]?.split("\t") ?? [];
		const canonical = fields.length === 2 && fields[0] === "P" ? decodeBase64(fields[1] ?? "") : null;
		return canonical
			? { ok: true, path: canonical }
			: { ok: false, error: "Invalid remote directory validation output" };
	}

	async listWorkspace(
		target: SshSessionTarget,
		path: string,
		roots: string[],
		maxDepth: number,
		maxEntries: number,
		signal?: AbortSignal,
	): Promise<RemoteWorkspaceListResult> {
		if (
			!isBoundedRemoteTargetInput(target) ||
			typeof path !== "string" ||
			path.length === 0 ||
			!remoteInputWithinBytes(path, REMOTE_PATH_MAX_BYTES) ||
			!Array.isArray(roots) ||
			roots.length > REMOTE_ROOTS_MAX_COUNT ||
			roots.some(
				root =>
					typeof root !== "string" || root.length === 0 || !remoteInputWithinBytes(root, REMOTE_PATH_MAX_BYTES),
			) ||
			!Number.isInteger(maxDepth) ||
			maxDepth < 0 ||
			maxDepth > MAX_WORKSPACE_DEPTH ||
			!Number.isInteger(maxEntries) ||
			maxEntries < 1 ||
			maxEntries > MAX_WORKSPACE_ENTRIES
		) {
			return { ok: false, error: "Invalid remote workspace request" };
		}
		const allowedRoots = [target.cwd, ...roots].filter((root, index, all) => all.indexOf(root) === index);
		const resolution = await this.resolveRuntime(target, signal);
		if (!resolution.ok) return resolution;
		const helper = this.#fileHelpers.get(resolution.runtime);
		if (!helper) return { ok: false, error: "Remote host has no handle-safe workspace helper" };
		const command =
			helper.kind === "windows"
				? this.#windowsWorkspaceListCommand(path, allowedRoots, maxDepth, maxEntries)
				: this.#posixWorkspaceListCommand(helper, path, allowedRoots, maxDepth, maxEntries);
		const result = await this.#runBounded(target, command, signal, MAX_WORKSPACE_STDOUT_BYTES);
		if (!result.ok) return { ok: false, error: result.error ?? "Remote workspace listing failed" };
		return helper.kind === "windows"
			? this.#parseWindowsWorkspace(result.stdout, maxDepth, maxEntries)
			: this.#parsePosixWorkspace(result.stdout, maxDepth, maxEntries);
	}

	async readFile(
		target: SshSessionTarget,
		path: string,
		roots: string[],
		maxBytes: number,
		signal?: AbortSignal,
	): Promise<RemoteFileResult> {
		if (
			!isBoundedRemoteTargetInput(target) ||
			typeof path !== "string" ||
			path.length === 0 ||
			!remoteInputWithinBytes(path, REMOTE_PATH_MAX_BYTES) ||
			!Array.isArray(roots) ||
			roots.length > REMOTE_ROOTS_MAX_COUNT ||
			roots.some(
				root =>
					typeof root !== "string" || root.length === 0 || !remoteInputWithinBytes(root, REMOTE_PATH_MAX_BYTES),
			) ||
			!Number.isInteger(maxBytes) ||
			maxBytes < 1 ||
			maxBytes > MAX_FILE_BYTES
		) {
			return { ok: false, error: "Invalid remote file request" };
		}
		const allowedRoots = [target.cwd, ...roots].filter(
			(root, index, all) => typeof root === "string" && root.length > 0 && all.indexOf(root) === index,
		);
		if (allowedRoots.length === 0) return { ok: false, error: "Remote file has no allowed roots" };
		const resolution = await this.resolveRuntime(target, signal);
		if (!resolution.ok) return resolution;
		const helper = this.#fileHelpers.get(resolution.runtime);
		if (!helper) return { ok: false, error: "Remote host has no handle-safe file helper" };
		const command =
			helper.kind === "windows"
				? this.#windowsReadCommand(path, allowedRoots, maxBytes)
				: this.#posixReadCommand(helper, path, allowedRoots, maxBytes);
		const result = await this.#runBounded(target, command, signal, maxBytes + FILE_HEADER_BYTES);
		if (!result.ok) return { ok: false, error: result.error ?? "Remote file read failed" };
		const bytes = Buffer.from(result.stdout);
		const separator = bytes.indexOf(0);
		if (separator < 1 || separator >= FILE_HEADER_BYTES) return { ok: false, error: "Invalid remote file output" };
		const sizeText = bytes.subarray(0, separator).toString("ascii");
		if (!/^\d+$/.test(sizeText)) return { ok: false, error: "Invalid remote file output" };
		const size = Number(sizeText);
		if (!Number.isSafeInteger(size) || size < 0) return { ok: false, error: "Invalid remote file output" };
		const data = bytes.subarray(separator + 1, separator + 1 + maxBytes);
		if (data.length > size) return { ok: false, error: "Invalid remote file output" };
		return { ok: true, data: new Uint8Array(data), size, truncated: size > data.length };
	}

	spawnRpc(target: SshSessionTarget, runtime: RemoteRuntimeInfo, args: string[]): RemoteChildHandle {
		return this.#spawnLongLived(target, runtime, args);
	}

	spawnAcp(target: SshSessionTarget, runtime: RemoteRuntimeInfo): RemoteChildHandle {
		return this.#spawnLongLived(target, runtime, ["acp"]);
	}

	dispose(): Promise<void> {
		this.#disposePromise ??= Promise.allSettled([...this.#activeHandles].map(handle => handle.terminate())).then(
			results => {
				const errors = results
					.filter((result): result is PromiseRejectedResult => result.status === "rejected")
					.map(result => result.reason);
				if (errors.length > 0)
					throw new AggregateError(errors, "One or more SSH process trees could not be terminated");
			},
		);
		return this.#disposePromise;
	}

	#spawnLongLived(target: SshSessionTarget, runtime: RemoteRuntimeInfo, args: string[]): RemoteChildHandle {
		if (
			!isBoundedRemoteTargetInput(target) ||
			!isBoundedRemoteRuntimeInput(runtime) ||
			!areBoundedRemoteLaunchArgs(args)
		) {
			throw new TypeError("Invalid remote launch request");
		}
		const remoteCommand =
			runtime.platform === "windows"
				? this.#windowsLaunchCommand(runtime, args)
				: this.#posixLaunchCommand(runtime, args);
		const child = this.#spawnSsh(target, remoteCommand);
		return this.#ownChild(child);
	}

	#spawnSsh(target: SshSessionTarget, remoteCommand: string): ChildProcess {
		return this.#runner.spawn("ssh", [...this.connectionArgs(target.host), remoteCommand], {
			stdio: "pipe",
			windowsHide: true,
			detached: this.#platform !== "win32",
		});
	}

	async #ensureControlMaster(host: SshConnectionSnapshot, signal?: AbortSignal): Promise<boolean> {
		const controlPath = this.#controlPath(host);
		if (!controlPath || (await this.#controlPathReady(controlPath))) return true;
		let pending = this.#controlMasterStarts.get(controlPath);
		if (!pending) {
			pending = this.#startControlMaster(host, controlPath).catch(() => false);
			this.#controlMasterStarts.set(controlPath, pending);
			void pending.then(() => {
				if (this.#controlMasterStarts.get(controlPath) === pending) this.#controlMasterStarts.delete(controlPath);
			});
		}
		if (!signal) return pending;
		if (signal.aborted) return false;
		const aborted = Promise.withResolvers<boolean>();
		const onAbort = (): void => aborted.resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([pending, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async #startControlMaster(host: SshConnectionSnapshot, controlPath: string): Promise<boolean> {
		const child = this.#runner.spawn("ssh", this.#connectionArgs(host, true), {
			stdio: ["ignore", "ignore", "ignore"],
			windowsHide: true,
			detached: true,
		});
		child.once("error", () => {});
		const handle = this.#ownChild(child);
		this.#controlMasters.set(controlPath, handle);
		child.once("close", () => {
			if (this.#controlMasters.get(controlPath) === handle) this.#controlMasters.delete(controlPath);
		});
		const deadline = Date.now() + this.#operationTimeoutMs;
		while (!this.#closedChildren.has(child) && Date.now() < deadline) {
			if (await this.#controlPathReady(controlPath)) return true;
			await sleep(25);
		}
		try {
			await handle.terminate();
		} catch {}
		return false;
	}

	#ownChild(child: ChildProcess): RemoteChildHandle {
		let handle: RemoteChildHandle;
		handle = new ServiceChildHandle(child, () => this.#terminateChild(child));
		this.#activeHandles.add(handle);
		child.once("close", () => {
			this.#closedChildren.add(child);
			this.#activeHandles.delete(handle);
		});
		return handle;
	}

	async #terminateChild(child: ChildProcess): Promise<void> {
		if (this.#platform === "win32") {
			if (child.exitCode !== null || child.signalCode !== null) return;
		} else {
			if (this.#closedChildren.has(child)) return;
			if (child.exitCode !== null || child.signalCode !== null) {
				if (await this.#waitForClose(child, this.#terminationGraceMs, true)) return;
				throw new Error("Unable to confirm SSH process-tree termination");
			}
		}
		const pid = child.pid;
		if (pid === undefined) {
			child.kill("SIGKILL");
			if (this.#platform === "win32" || (await this.#waitForClose(child, this.#terminationGraceMs, true))) return;
			throw new Error("Unable to confirm SSH process-tree termination");
		}
		if (this.#platform === "win32") {
			let taskkillSucceeded = false;
			try {
				const killer = this.#runner.spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
					stdio: "pipe",
					windowsHide: true,
					detached: false,
				});
				const killerClosed = await this.#waitForClose(killer, this.#terminationGraceMs);
				taskkillSucceeded = killerClosed && killer.exitCode === 0;
				if (!killerClosed) {
					killer.kill("SIGKILL");
					await this.#waitForClose(killer, this.#terminationGraceMs);
				}
			} catch {
				taskkillSucceeded = false;
			}
			if (taskkillSucceeded && (await this.#waitForClose(child, this.#terminationGraceMs))) return;
			child.kill("SIGKILL");
			if (await this.#waitForClose(child, this.#terminationGraceMs)) return;
			throw new Error("Unable to confirm SSH process-tree termination");
		}
		try {
			this.#killProcessGroup(-pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
		if (await this.#waitForClose(child, this.#terminationGraceMs, true)) return;
		try {
			this.#killProcessGroup(-pid, "SIGKILL");
		} catch {
			child.kill("SIGKILL");
		}
		if (await this.#waitForClose(child, this.#terminationGraceMs, true)) return;
		throw new Error("Unable to confirm SSH process-tree termination");
	}

	async #waitForClose(child: ChildProcess, timeoutMs: number, requireCloseEvent = false): Promise<boolean> {
		if (this.#closedChildren.has(child)) return true;
		if (!requireCloseEvent && (child.exitCode !== null || child.signalCode !== null)) return true;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		let settled = false;
		const finish = (closed: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off("close", onClose);
			resolve(closed);
		};
		const onClose = (): void => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("close", onClose);
		return promise;
	}

	async #runBounded(
		target: SshSessionTarget,
		remoteCommand: string,
		signal?: AbortSignal,
		stdoutCapBytes = this.#stdoutCapBytes,
	): Promise<BoundedResult> {
		if (signal?.aborted) return { ok: false, stdout: new Uint8Array(), error: "Remote operation aborted" };
		if (this.#platform !== "win32" && this.#controlPathRoot !== undefined) {
			try {
				const ready = await this.#ensureControlMaster(target.host, signal);
				if (!ready) {
					return {
						ok: false,
						stdout: new Uint8Array(),
						error: signal?.aborted ? "Remote operation aborted" : "Unable to establish shared SSH connection",
					};
				}
			} catch (error) {
				return {
					ok: false,
					stdout: new Uint8Array(),
					error: error instanceof Error ? error.message : String(error),
				};
			}
			if (signal?.aborted) return { ok: false, stdout: new Uint8Array(), error: "Remote operation aborted" };
		}
		let child: ChildProcess;
		try {
			child = this.#spawnSsh(target, remoteCommand);
		} catch (error) {
			return { ok: false, stdout: new Uint8Array(), error: error instanceof Error ? error.message : String(error) };
		}
		const handle = this.#ownChild(child);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let failure: string | null = null;
		let settled = false;
		const { promise, resolve } = Promise.withResolvers<BoundedResult>();

		const stderrBuffer = (): Buffer => Buffer.concat(stderr, stderrBytes);
		const cleanup = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			child.stdout?.off("data", onStdout);
			child.stderr?.off("data", onStderr);
			child.off("error", onError);
			child.off("close", onClose);
		};
		const finish = (result: BoundedResult): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const terminate = (message: string): void => {
			if (failure !== null) return;
			failure = message;
			void handle.terminate().then(
				() => finish({ ok: false, stdout: new Uint8Array(), error: errorWithStderr(message, stderrBuffer()) }),
				error => {
					const detail = error instanceof Error ? error.message : String(error);
					finish({
						ok: false,
						stdout: new Uint8Array(),
						error: `${message}; process-tree termination failed: ${detail}`,
					});
				},
			);
		};
		const onStdout = (value: unknown): void => {
			const chunk = chunkBuffer(value);
			if (stdoutBytes + chunk.length > stdoutCapBytes) {
				terminate("Remote stdout exceeded its byte limit");
				return;
			}
			stdout.push(chunk);
			stdoutBytes += chunk.length;
		};
		const onStderr = (value: unknown): void => {
			let chunk = chunkBuffer(value);
			if (chunk.length >= this.#stderrCapBytes) {
				stderr.length = 0;
				chunk = chunk.subarray(chunk.length - this.#stderrCapBytes);
				stderr.push(chunk);
				stderrBytes = chunk.length;
				return;
			}
			stderr.push(chunk);
			stderrBytes += chunk.length;
			while (stderrBytes > this.#stderrCapBytes) {
				const first = stderr[0];
				if (!first) break;
				const excess = stderrBytes - this.#stderrCapBytes;
				if (first.length <= excess) {
					stderr.shift();
					stderrBytes -= first.length;
				} else {
					stderr[0] = first.subarray(excess);
					stderrBytes -= excess;
				}
			}
		};
		const onError = (error: Error): void => terminate(`Remote process failed: ${error.message}`);
		const onAbort = (): void => terminate("Remote operation aborted");
		const onClose = (code: number | null, closeSignal: NodeJS.Signals | null): void => {
			if (failure !== null) {
				finish({ ok: false, stdout: new Uint8Array(), error: errorWithStderr(failure, stderrBuffer()) });
				return;
			}
			if (code !== 0) {
				const status = closeSignal ? `signal ${closeSignal}` : `exit ${code ?? "unknown"}`;
				finish({
					ok: false,
					stdout: new Uint8Array(),
					error: errorWithStderr(`Remote process failed with ${status}`, stderrBuffer()),
				});
				return;
			}
			finish({ ok: true, stdout: new Uint8Array(Buffer.concat(stdout, stdoutBytes)) });
		};
		const timer = setTimeout(() => terminate("Remote operation timed out"), this.#operationTimeoutMs);
		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", onStderr);
		child.once("error", onError);
		child.once("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		return promise;
	}

	#posixProbe(marker: string, executableOverride?: string): string {
		const override = encodeUtf8(executableOverride ?? "");
		const script = [
			posixDecodeFunction(),
			posixEncodeFunction(),
			`override=$(decode_b64 ${shellQuote(override)}) || exit 71`,
			'export PATH="$HOME/.local/share/mise/shims:$HOME/.bun/bin:$HOME/.local/bin:$PATH"',
			'if command -v mise >/dev/null 2>&1; then eval "$(mise activate sh 2>/dev/null)"; fi',
			'if [ -n "$override" ]; then executable=$override; else executable=$(command -v omp 2>/dev/null || true); fi',
			'[ -n "$executable" ] && [ -f "$executable" ] && [ -x "$executable" ] || exit 72',
			"system=$(uname -s 2>/dev/null || true)",
			'case "$system" in Darwin) platform=macos ;; Linux) platform=linux ;; *) exit 73 ;; esac',
			`shell=\${SHELL:-/bin/sh}`,
			"file_helper=unavailable",
			`if [ "$platform" = linux ]; then readlink_bin=$(command -v readlink 2>/dev/null || true); stat_bin=$(command -v stat 2>/dev/null || true); dd_bin=$(command -v dd 2>/dev/null || true); base64_bin=$(command -v base64 2>/dev/null || true); if [ -d /proc/self/fd ] && [ -n "$readlink_bin" ] && [ -n "$stat_bin" ] && [ -n "$dd_bin" ] && [ -n "$base64_bin" ] && exec 9< /etc/passwd && "$readlink_bin" -f /proc/$$/fd/9 >/dev/null 2>&1 && "$stat_bin" -Lc %s /proc/$$/fd/9 >/dev/null 2>&1 && "$dd_bin" bs=1 count=0 <&9 >/dev/null 2>&1 && printf "" | "$base64_bin" --decode >/dev/null 2>&1; then file_helper="linux:$(encode_b64 "$readlink_bin"):$(encode_b64 "$stat_bin"):$(encode_b64 "$dd_bin"):$(encode_b64 "$base64_bin")"; fi; exec 9<&- 2>/dev/null || true; elif [ "$platform" = macos ]; then python_bin=$(command -v python3 2>/dev/null || true); if [ -n "$python_bin" ] && "$python_bin" -c "import fcntl,os; f=os.open('/dev/null',os.O_RDONLY); fcntl.fcntl(f,50,b'\\\\0'*1024); os.close(f)" >/dev/null 2>&1; then file_helper="python:$(encode_b64 "$python_bin")"; fi; fi`,
			`printf '%s\\n' ${shellQuote(marker)}`,
			`printf 'home=%s\\n' "$(encode_b64 "$HOME")"`,
			`printf 'platform=%s\\n' "$platform"`,
			`printf 'shell=%s\\n' "$(encode_b64 "$shell")"`,
			`printf 'executable=%s\\n' "$(encode_b64 "$executable")"`,
			`printf 'path=%s\\n' "$(encode_b64 "$PATH")"`,
			`printf 'filehelper=%s\\n' "$(encode_b64 "$file_helper")"`,
			`printf '%s\\n' ${shellQuote(marker)}`,
		].join("; ");
		const posixCommand = `exec sh -c ${shellQuote(script)}`;
		return `"$SHELL" -lc ${shellQuote(posixCommand)}`;
	}

	#windowsProbe(marker: string, executableOverride?: string): string {
		const override = encodeUtf8(executableOverride ?? "");
		const script = [
			WINDOWS_UTF8_OUTPUT,
			`$marker = ${powershellQuote(marker)}`,
			`$override = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellQuote(override)}))`,
			'$env:PATH = "$HOME\\.local\\share\\mise\\shims;$HOME\\.bun\\bin;$HOME\\.local\\bin;$env:PATH"',
			"$executable = if ($override) { $override } else { (Get-Command omp.exe, omp -ErrorAction SilentlyContinue | Select-Object -First 1).Source }",
			"if (-not $executable -or -not (Test-Path -LiteralPath $executable -PathType Leaf)) { exit 72 }",
			"$b64 = { param($v) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v)) }",
			"Write-Output $marker",
			'Write-Output ("home=" + (& $b64 $HOME))',
			'Write-Output "platform=windows"',
			'Write-Output ("shell=" + (& $b64 "powershell.exe"))',
			'Write-Output ("executable=" + (& $b64 $executable))',
			'Write-Output ("path=" + (& $b64 $env:PATH))',
			'Write-Output ("filehelper=" + (& $b64 "windows"))',
			"Write-Output $marker",
		].join("; ");
		return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
	}

	#parseRuntimeProbe(output: string, marker: string): RuntimeProbe | null {
		const lines = output.split(/\r?\n/);
		const markers: number[] = [];
		for (let index = 0; index < lines.length; index++) {
			if (lines[index] === marker) markers.push(index);
		}
		if (markers.length !== 2 || markers[1] !== markers[0]! + 7) return null;
		const values = Object.create(null) as Record<string, string>;
		for (const line of lines.slice(markers[0]! + 1, markers[1])) {
			const equals = line.indexOf("=");
			if (equals <= 0) return null;
			const key = line.slice(0, equals);
			if (Object.hasOwn(values, key)) return null;
			values[key] = line.slice(equals + 1);
		}
		if (Object.keys(values).sort().join(",") !== "executable,filehelper,home,path,platform,shell") return null;
		const platform = values.platform;
		if (platform !== "windows" && platform !== "linux" && platform !== "macos") return null;
		const home = decodeBase64(values.home ?? "");
		const shell = decodeBase64(values.shell ?? "");
		const executable = decodeBase64(values.executable ?? "");
		const runtimePathValue = decodeBase64(values.path ?? "");
		const fileHelperValue = decodeBase64(values.filehelper ?? "");
		if (!home || !shell || !executable || !runtimePathValue || !fileHelperValue) return null;
		const runtimePath = runtimePathValue.split(platform === "windows" ? ";" : ":").filter(entry => entry.length > 0);
		if (runtimePath.length === 0) return null;
		let fileHelper: RemoteFileHelper | null = null;
		if (fileHelperValue !== "unavailable") {
			const fields = fileHelperValue.split(":");
			if (platform === "windows" && fileHelperValue === "windows") {
				fileHelper = { kind: "windows" };
			} else if (platform === "macos" && fields.length === 2 && fields[0] === "python") {
				const helperExecutable = decodeBase64(fields[1] ?? "");
				if (!helperExecutable?.startsWith("/")) return null;
				fileHelper = { kind: "macos-python", executable: helperExecutable };
			} else if (platform === "linux" && fields.length === 5 && fields[0] === "linux") {
				const [readlink, stat, dd, base64] = fields.slice(1).map(field => decodeBase64(field));
				if (![readlink, stat, dd, base64].every(value => value?.startsWith("/"))) return null;
				fileHelper = {
					kind: "linux-shell",
					readlink: readlink!,
					stat: stat!,
					dd: dd!,
					base64: base64!,
				};
			} else {
				return null;
			}
		}
		return { runtime: { home, platform, shell, executable, runtimePath }, fileHelper };
	}

	#posixListCommand(path: string, showHidden: boolean): string {
		const encodedPath = encodeUtf8(path);
		const script = [
			posixDecodeFunction(),
			posixEncodeFunction(),
			`requested=$(decode_b64 ${shellQuote(encodedPath)}) || exit 81`,
			'canonical=$(cd -P -- "$requested" 2>/dev/null && pwd -P) || exit 82',
			'parent=$(dirname -- "$canonical")',
			'printf "H\\t%s\\t%s\\0" "$(encode_b64 "$canonical")" "$(encode_b64 "$parent")"',
			'for entry in "$canonical"/* "$canonical"/.[!.]* "$canonical"/..?*; do',
			'  [ -d "$entry" ] || continue',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion is literal shell source.
			"  name=${entry##*/}",
			`  hidden=0; case "$name" in .*) hidden=1 ;; esac; [ ${showHidden ? "1" : "0"} = 1 ] || [ "$hidden" = 0 ] || continue`,
			'  kind=directory; [ -L "$entry" ] && kind=symlink-directory',
			'  printf "E\\t%s\\t%s\\t%s\\t%s\\0" "$kind" "$hidden" "$(encode_b64 "$name")" "$(encode_b64 "$entry")"',
			"done",
		].join("\n");
		return `sh -c ${shellQuote(script)}`;
	}

	#windowsListCommand(path: string, showHidden: boolean): string {
		const script = [
			WINDOWS_UTF8_OUTPUT,
			`$requested = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellQuote(encodeUtf8(path))}))`,
			"$canonical = (Resolve-Path -LiteralPath $requested -ErrorAction Stop).Path",
			"$item = Get-Item -LiteralPath $canonical -Force -ErrorAction Stop",
			"if (-not $item.PSIsContainer) { exit 82 }",
			"$parent = if ($item.Parent) { $item.Parent.FullName } else { $null }",
			'[Console]::Out.WriteLine((@{type="header";path=$canonical;parent=$parent} | ConvertTo-Json -Compress))',
			`Get-ChildItem -LiteralPath $canonical -Directory -Force | Where-Object { ${showHidden ? "$true" : "-not $_.Name.StartsWith('.')"} } | ForEach-Object {`,
			'  $hidden = $_.Name.StartsWith(".") -or (($_.Attributes -band [IO.FileAttributes]::Hidden) -ne 0)',
			'  $kind = if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { "symlink-directory" } else { "directory" }',
			'  [Console]::Out.WriteLine((@{type="entry";name=$_.Name;path=$_.FullName;kind=$kind;hidden=$hidden} | ConvertTo-Json -Compress))',
			"}",
		].join("; ");
		return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
	}

	#posixWorkspaceListCommand(
		helper: Exclude<RemoteFileHelper, { kind: "windows" }>,
		path: string,
		roots: string[],
		maxDepth: number,
		maxEntries: number,
	): string {
		if (helper.kind === "macos-python") {
			const request = encodeUtf8(JSON.stringify({ path, roots, maxDepth, maxEntries }));
			const script = [
				"import base64,json,os,sys",
				"request=json.loads(base64.b64decode(sys.argv[1]))",
				"requested=os.path.realpath(request['path'])",
				"if not os.path.isdir(requested) or os.path.islink(request['path']): raise SystemExit(82)",
				"resolved_roots=[os.path.realpath(root) for root in request['roots']]",
				"selected=next((root for root in resolved_roots if os.path.commonpath((requested,root))==root),None)",
				"if selected is None: raise SystemExit(85)",
				"count=0",
				"truncated=False",
				"def emit(value): os.write(1,value.encode()+b'\\0')",
				"def encoded(value): return base64.b64encode(value.encode()).decode()",
				"def walk(directory,depth):",
				" global count,truncated",
				" entries=sorted(os.scandir(directory),key=lambda entry:(not entry.is_dir(follow_symlinks=False),entry.name.lower(),entry.name))",
				" for entry in entries:",
				"  if entry.is_symlink(): continue",
				"  physical=os.path.realpath(entry.path)",
				"  try: allowed=os.path.commonpath((physical,selected))==selected",
				"  except ValueError: allowed=False",
				"  if not allowed: continue",
				"  if entry.is_dir(follow_symlinks=False): kind='dir'",
				"  elif entry.is_file(follow_symlinks=False): kind='file'",
				"  else: continue",
				"  if count>=request['maxEntries']:",
				"   if not truncated: emit('T'); truncated=True",
				"   return",
				"  relative=os.path.relpath(entry.path,selected).replace(os.sep,'/')",
				"  emit('E\\t%d\\t%s\\t%s\\t%s'%(depth,kind,encoded(entry.name),encoded(relative)))",
				"  count+=1",
				"  if kind=='dir' and depth<request['maxDepth'] and not truncated: walk(entry.path,depth+1)",
				"  if truncated: return",
				"walk(requested,0)",
			].join("\n");
			return `${shellQuote(helper.executable)} -c ${shellQuote(script)} ${shellQuote(request)}`;
		}
		const encodedRoots = roots.map(root => shellQuote(encodeUtf8(root))).join(" ");
		const decodeFunction = `decode_b64() { printf '%s' "$1" | ${shellQuote(helper.base64)} --decode; }`;
		const encodeFunction = `encode_b64() { printf '%s' "$1" | ${shellQuote(helper.base64)} | tr -d '\\r\\n'; }`;
		const script = [
			decodeFunction,
			encodeFunction,
			`requested=$(decode_b64 ${shellQuote(encodeUtf8(path))}) || exit 81`,
			`canonical=$(${shellQuote(helper.readlink)} -f "$requested") || exit 82`,
			'[ -d "$canonical" ] && [ ! -L "$requested" ] || exit 82',
			"selected_root=",
			`for encoded_root in ${encodedRoots}; do`,
			'  root=$(decode_b64 "$encoded_root") || exit 84',
			`  root_physical=$(${shellQuote(helper.readlink)} -f "$root") || continue`,
			'  case "$root_physical" in /) selected_root=/; break ;; *) case "$canonical" in "$root_physical"|"$root_physical"/*) selected_root=$root_physical; break ;; esac ;; esac',
			"done",
			'[ -n "$selected_root" ] || exit 85',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion is literal shell source.
			'case "$selected_root" in /) prefix=${canonical#/} ;; *) case "$canonical" in "$selected_root") prefix="" ;; *) prefix=${canonical#"$selected_root"/} ;; esac ;; esac',
			"count=0",
			"truncated=0",
			"walk() {",
			"  local directory=$1 relative_prefix=$2 depth=$3 entry name physical allowed kind relative encoded_root root root_physical",
			'  for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do',
			'    [ -e "$entry" ] || continue',
			'    [ -L "$entry" ] && continue',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: POSIX parameter expansion is literal shell source.
			"    name=${entry##*/}",
			'    case "$name" in .git|node_modules|.DS_Store|dist|build|coverage|target|__pycache__|.venv|venv|.next|out|.turbo) continue ;; esac',
			`    physical=$(${shellQuote(helper.readlink)} -f "$entry") || continue`,
			"    allowed=0",
			`    for encoded_root in ${encodedRoots}; do root=$(decode_b64 "$encoded_root") || exit 84; root_physical=$(${shellQuote(helper.readlink)} -f "$root") || continue; case "$root_physical" in /) allowed=1; break ;; *) case "$physical" in "$root_physical"|"$root_physical"/*) allowed=1; break ;; esac ;; esac; done`,
			'    [ "$allowed" = 1 ] || continue',
			'    if [ -d "$entry" ]; then kind=dir; elif [ -f "$entry" ]; then kind=file; else continue; fi',
			`    if [ "$count" -ge ${maxEntries} ]; then [ "$truncated" = 1 ] || printf 'T\\0'; truncated=1; return 2; fi`,
			'    if [ -n "$relative_prefix" ]; then relative=$relative_prefix/$name; else relative=$name; fi',
			'    printf "E\\t%s\\t%s\\t%s\\t%s\\0" "$depth" "$kind" "$(encode_b64 "$name")" "$(encode_b64 "$relative")"',
			"    count=$((count + 1))",
			`    if [ "$kind" = dir ] && [ "$depth" -lt ${maxDepth} ]; then walk "$entry" "$relative" "$((depth + 1))" || [ "$?" = 2 ] || return 1; fi`,
			'    [ "$truncated" = 0 ] || return 2',
			"  done",
			"}",
			'walk "$canonical" "$prefix" 0',
			'status=$?; [ "$status" = 0 ] || [ "$status" = 2 ] || exit 86',
		].join("\n");
		return `sh -c ${shellQuote(script)}`;
	}

	#windowsWorkspaceListCommand(path: string, roots: string[], maxDepth: number, maxEntries: number): string {
		const request = encodeUtf8(JSON.stringify({ path, roots, maxDepth, maxEntries }));
		const nativeSource = windowsSafeHandleSource();
		const script = [
			WINDOWS_UTF8_OUTPUT,
			`$nativeSource = @'\n${nativeSource}\n'@`,
			"Add-Type -TypeDefinition $nativeSource",
			`$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellQuote(request)})) | ConvertFrom-Json`,
			"$requestedItem = Get-Item -LiteralPath $request.path -Force -ErrorAction Stop",
			"if (-not $requestedItem.PSIsContainer) { exit 82 }",
			"$requestedHandle = [OmpRemoteFile]::OpenDirectory($request.path)",
			"if ($requestedHandle.IsInvalid) { $requestedHandle.Dispose(); exit 82 }",
			"try { $requestedPhysical = [OmpRemoteFile]::FinalPath($requestedHandle) } catch { $requestedHandle.Dispose(); exit 82 }",
			'function Within($value,$root) { $prefix=$root.TrimEnd("\\\\")+"\\\\"; return $value.Equals($root,[StringComparison]::OrdinalIgnoreCase) -or $value.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) }',
			'function FilesystemPath($value) { if ($value.StartsWith("\\\\\\\\?\\\\UNC\\\\",[StringComparison]::OrdinalIgnoreCase)) { return "\\\\\\\\"+$value.Substring(8) }; if ($value.StartsWith("\\\\\\\\?\\\\",[StringComparison]::OrdinalIgnoreCase)) { return $value.Substring(4) }; return $value }',
			"$selected = $null",
			"foreach ($root in $request.roots) {",
			"  $rootHandle = [OmpRemoteFile]::OpenDirectory($root)",
			"  if ($rootHandle.IsInvalid) { $rootHandle.Dispose(); continue }",
			"  try { $rootPhysical = [OmpRemoteFile]::FinalPath($rootHandle) } finally { $rootHandle.Dispose() }",
			"  if (Within $requestedPhysical $rootPhysical) { $selected=$rootPhysical; break }",
			"}",
			"if (-not $selected) { $requestedHandle.Dispose(); exit 85 }",
			"$script:count = 0",
			"$script:truncated = $false",
			"function Emit($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress)) }",
			"function Walk($directory,$depth) {",
			"  $entries = Get-ChildItem -LiteralPath (FilesystemPath $directory) -Force -ErrorAction Stop | Sort-Object @{Expression={-not $_.PSIsContainer}},Name",
			"  foreach ($entry in $entries) {",
			"    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }",
			'    $kind = if ($entry.PSIsContainer) { "dir" } else { "file" }',
			"    $handle = if ($entry.PSIsContainer) { [OmpRemoteFile]::OpenDirectory($entry.FullName) } else { [OmpRemoteFile]::OpenFile($entry.FullName) }",
			"    if ($handle.IsInvalid) { $handle.Dispose(); continue }",
			"    try {",
			"      $physical = [OmpRemoteFile]::FinalPath($handle)",
			"      if (-not (Within $physical $selected)) { continue }",
			`      if ($script:count -ge ${maxEntries}) { if (-not $script:truncated) { Emit(@{type="truncated"}); $script:truncated=$true }; return }`,
			'      $relative = $physical.Substring($selected.Length).TrimStart("\\\\").Replace("\\\\","/")',
			'      Emit(@{type="entry";depth=$depth;kind=$kind;name=$entry.Name;path=$relative})',
			"      $script:count++",
			`      if ($kind -eq "dir" -and $depth -lt ${maxDepth} -and -not $script:truncated) { Walk (FilesystemPath $physical) ($depth+1) }`,
			"      if ($script:truncated) { return }",
			"    } finally { $handle.Dispose() }",
			"  }",
			"}",
			"try { Walk (FilesystemPath $requestedPhysical) 0 } finally { $requestedHandle.Dispose() }",
		].join("; ");
		return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
	}

	#parsePosixDirectories(bytes: Uint8Array, showHidden: boolean): RemoteDirectoryListResult {
		const scanned = scanRecords(bytes, 0, this.#maxDirectoryEntries + 1);
		if (scanned.tooMany) return { ok: false, error: "Remote directory returned too many records" };
		if (scanned.records.length < 1) return { ok: false, error: "Invalid remote directory output" };
		const headerFields = scanned.records[0]!.toString("utf8").split("\t");
		const path = headerFields.length === 3 && headerFields[0] === "H" ? decodeBase64(headerFields[1] ?? "") : null;
		const decodedParent = headerFields.length === 3 ? decodeBase64(headerFields[2] ?? "") : null;
		if (!path || !decodedParent) return { ok: false, error: "Invalid remote directory output" };
		const entries: RemoteDirectoryEntry[] = [];
		for (let index = 1; index < scanned.records.length; index++) {
			const fields = scanned.records[index]!.toString("utf8").split("\t");
			if (fields.length !== 5 || fields[0] !== "E") return { ok: false, error: "Invalid remote directory output" };
			const kind = fields[1];
			const hidden = fields[2] === "1";
			const name = decodeBase64(fields[3] ?? "");
			const entryPath = decodeBase64(fields[4] ?? "");
			if (
				(kind !== "directory" && kind !== "symlink-directory") ||
				(fields[2] !== "0" && fields[2] !== "1") ||
				!name ||
				!entryPath
			) {
				return { ok: false, error: "Invalid remote directory output" };
			}
			if (showHidden || !hidden) entries.push({ name, path: entryPath, kind, hidden });
		}
		return { ok: true, path, parent: path === "/" ? null : decodedParent, entries };
	}

	#parseWindowsDirectories(bytes: Uint8Array, showHidden: boolean): RemoteDirectoryListResult {
		const scanned = scanRecords(bytes, 10, this.#maxDirectoryEntries + 1, true);
		if (scanned.tooMany) return { ok: false, error: "Remote directory returned too many records" };
		if (scanned.records.length < 1) return { ok: false, error: "Invalid remote directory output" };
		let header: DirectoryHeader | null = null;
		const entries: RemoteDirectoryEntry[] = [];
		for (let index = 0; index < scanned.records.length; index++) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(scanned.records[index]!.toString("utf8"));
			} catch {
				return { ok: false, error: "Invalid remote directory output" };
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				return { ok: false, error: "Invalid remote directory output" };
			const row = parsed as Record<string, unknown>;
			if (index === 0) {
				if (
					row.type !== "header" ||
					typeof row.path !== "string" ||
					(row.parent !== null && typeof row.parent !== "string")
				) {
					return { ok: false, error: "Invalid remote directory output" };
				}
				header = { path: row.path, parent: row.parent };
				continue;
			}
			if (
				row.type !== "entry" ||
				typeof row.name !== "string" ||
				typeof row.path !== "string" ||
				(row.kind !== "directory" && row.kind !== "symlink-directory") ||
				typeof row.hidden !== "boolean"
			) {
				return { ok: false, error: "Invalid remote directory output" };
			}
			if (showHidden || !row.hidden)
				entries.push({ name: row.name, path: row.path, kind: row.kind, hidden: row.hidden });
		}
		return header ? { ok: true, ...header, entries } : { ok: false, error: "Invalid remote directory output" };
	}

	#parsePosixWorkspace(bytes: Uint8Array, maxDepth: number, maxEntries: number): RemoteWorkspaceListResult {
		const scanned = scanRecords(bytes, 0, maxEntries + 1);
		const finalRecord = scanned.records.at(-1)?.toString("ascii");
		if (scanned.tooMany || (scanned.records.length === maxEntries + 1 && finalRecord !== "T")) {
			return { ok: false, error: "Remote workspace returned too many records" };
		}
		const truncated = finalRecord === "T";
		const records = truncated ? scanned.records.slice(0, -1) : scanned.records;
		const rows: WorkspaceEntryRecord[] = [];
		for (const record of records) {
			const fields = record.toString("utf8").split("\t");
			const depth = fields.length === 5 && /^\d+$/u.test(fields[1] ?? "") ? Number(fields[1]) : -1;
			const kind = fields[2];
			const name = decodeBase64(fields[3] ?? "");
			const entryPath = decodeBase64(fields[4] ?? "");
			if (
				fields[0] !== "E" ||
				(kind !== "file" && kind !== "dir") ||
				!Number.isSafeInteger(depth) ||
				depth < 0 ||
				depth > maxDepth ||
				!name ||
				!entryPath
			) {
				return { ok: false, error: "Invalid remote workspace output" };
			}
			rows.push({ depth, kind, name, path: entryPath });
		}
		return this.#buildWorkspaceTree(rows, truncated);
	}

	#parseWindowsWorkspace(bytes: Uint8Array, maxDepth: number, maxEntries: number): RemoteWorkspaceListResult {
		const scanned = scanRecords(bytes, 10, maxEntries + 1, true);
		const finalRecord = scanned.records.at(-1)?.toString("utf8");
		const truncatedRecord = finalRecord === '{"type":"truncated"}';
		if (scanned.tooMany || (scanned.records.length === maxEntries + 1 && !truncatedRecord)) {
			return { ok: false, error: "Remote workspace returned too many records" };
		}
		const records = truncatedRecord ? scanned.records.slice(0, -1) : scanned.records;
		const rows: WorkspaceEntryRecord[] = [];
		for (const record of records) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(record.toString("utf8"));
			} catch {
				return { ok: false, error: "Invalid remote workspace output" };
			}
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				return { ok: false, error: "Invalid remote workspace output" };
			}
			const row = parsed as Record<string, unknown>;
			if (
				row.type !== "entry" ||
				!Number.isInteger(row.depth) ||
				Number(row.depth) < 0 ||
				Number(row.depth) > maxDepth ||
				(row.kind !== "file" && row.kind !== "dir") ||
				typeof row.name !== "string" ||
				row.name.length === 0 ||
				typeof row.path !== "string" ||
				row.path.length === 0
			) {
				return { ok: false, error: "Invalid remote workspace output" };
			}
			rows.push({ depth: Number(row.depth), kind: row.kind, name: row.name, path: row.path });
		}
		return this.#buildWorkspaceTree(rows, truncatedRecord);
	}

	#buildWorkspaceTree(rows: WorkspaceEntryRecord[], truncated: boolean): RemoteWorkspaceListResult {
		const entries: FsTreeEntry[] = [];
		const parents: Array<{ depth: number; entry: FsTreeEntry }> = [];
		for (const row of rows) {
			if (
				/[\u0000-\u001f\u007f-\u009f]/u.test(row.name) ||
				/[\u0000-\u001f\u007f-\u009f]/u.test(row.path) ||
				row.path.startsWith("/") ||
				/^[A-Za-z]:[\\/]/u.test(row.path) ||
				row.path.split("/").some(part => part === "..") ||
				row.path.split("/").at(-1) !== row.name
			) {
				return { ok: false, error: "Invalid remote workspace output" };
			}
			const entry: FsTreeEntry =
				row.kind === "dir"
					? { name: row.name, path: row.path, kind: "dir", children: [] }
					: { name: row.name, path: row.path, kind: "file" };
			while (parents.length > 0 && parents.at(-1)!.depth >= row.depth) parents.pop();
			if (row.depth === 0) {
				entries.push(entry);
			} else {
				const parent = parents.at(-1);
				if (!parent || parent.depth !== row.depth - 1 || parent.entry.kind !== "dir") {
					return { ok: false, error: "Invalid remote workspace output" };
				}
				parent.entry.children!.push(entry);
			}
			if (entry.kind === "dir") parents.push({ depth: row.depth, entry });
		}
		const sortEntries = (values: FsTreeEntry[]): void => {
			values.sort((left, right) => {
				if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
				return left.name.localeCompare(right.name);
			});
			for (const entry of values) {
				if (entry.children) sortEntries(entry.children);
			}
		};
		sortEntries(entries);
		return { ok: true, entries, truncated };
	}

	#posixValidateCommand(path: string): string {
		const script = [
			posixDecodeFunction(),
			posixEncodeFunction(),
			`requested=$(decode_b64 ${shellQuote(encodeUtf8(path))}) || exit 81`,
			'canonical=$(cd -P -- "$requested" 2>/dev/null && pwd -P) || exit 82',
			'[ -x "$canonical" ] || exit 83',
			'printf "P\\t%s\\0" "$(encode_b64 "$canonical")"',
		].join("; ");
		return `sh -c ${shellQuote(script)}`;
	}

	#windowsValidateCommand(path: string): string {
		const script = [
			WINDOWS_UTF8_OUTPUT,
			`$requested = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellQuote(encodeUtf8(path))}))`,
			"$canonical = (Resolve-Path -LiteralPath $requested -ErrorAction Stop).Path",
			"if (-not (Test-Path -LiteralPath $canonical -PathType Container)) { exit 82 }",
			"[Console]::Out.WriteLine((@{path=$canonical} | ConvertTo-Json -Compress))",
		].join("; ");
		return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
	}

	#posixReadCommand(
		helper: Exclude<RemoteFileHelper, { kind: "windows" }>,
		path: string,
		roots: string[],
		maxBytes: number,
	): string {
		if (helper.kind === "linux-shell") {
			const encodedRoots = roots.map(encodeUtf8).join(" ");
			const decodeFunction = `decode_b64() { printf '%s' "$1" | ${shellQuote(helper.base64)} --decode; }`;
			const script = [
				decodeFunction,
				`requested=$(decode_b64 ${shellQuote(encodeUtf8(path))}) || exit 81`,
				'exec 3< "$requested" || exit 83',
				"fd_path=/proc/$$/fd/3",
				'[ -f "$fd_path" ] || exit 83',
				`physical=$(${shellQuote(helper.readlink)} -f "$fd_path") || exit 86`,
				"allowed=0",
				`for encoded_root in ${encodedRoots}; do root=$(decode_b64 "$encoded_root") || exit 84; root_physical=$(${shellQuote(helper.readlink)} -f "$root") || continue; case "$root_physical" in /) allowed=1 ;; *) case "$physical" in "$root_physical"|"$root_physical"/*) allowed=1 ;; esac ;; esac; done`,
				'[ "$allowed" = 1 ] || exit 85',
				`size=$(${shellQuote(helper.stat)} -Lc %s "$fd_path") || exit 86`,
				'printf "%s\\0" "$size"',
				`${shellQuote(helper.dd)} bs=1 count=${maxBytes} 2>/dev/null <&3`,
				"exec 3<&-",
			].join("; ");
			return `sh -c ${shellQuote(script)}`;
		}
		const request = encodeUtf8(JSON.stringify({ path, roots, maxBytes }));
		const script = [
			"import base64,json,os,stat,sys",
			"request=json.loads(base64.b64decode(sys.argv[1]))",
			"if not hasattr(os,'O_NOFOLLOW'): raise SystemExit(86)",
			"fd=os.open(request['path'],os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)",
			"try:",
			" info=os.fstat(fd)",
			" if not stat.S_ISREG(info.st_mode): raise SystemExit(83)",
			" import fcntl",
			" F_GETPATH=50",
			" physical=fcntl.fcntl(fd,F_GETPATH,b'\\0'*1024).split(b'\\0',1)[0].decode()",
			" allowed=False",
			" for root in request['roots']:",
			"  root_physical=os.path.realpath(root)",
			"  try:",
			"   if os.path.commonpath((physical,root_physical))==root_physical: allowed=True",
			"  except ValueError: pass",
			" if not allowed: raise SystemExit(85)",
			" os.write(1,str(info.st_size).encode()+b'\\0')",
			" remaining=request['maxBytes']",
			" while remaining:",
			"  chunk=os.read(fd,min(remaining,65536))",
			"  if not chunk: break",
			"  os.write(1,chunk)",
			"  remaining-=len(chunk)",
			"finally:",
			" os.close(fd)",
		].join("\n");
		return `${shellQuote(helper.executable)} -c ${shellQuote(script)} ${shellQuote(request)}`;
	}

	#windowsReadCommand(path: string, roots: string[], maxBytes: number): string {
		const request = encodeUtf8(JSON.stringify({ path, roots, maxBytes }));
		const nativeSource = windowsSafeHandleSource();
		const script = [
			WINDOWS_UTF8_OUTPUT,
			`$nativeSource = @'\n${nativeSource}\n'@`,
			"Add-Type -TypeDefinition $nativeSource",
			`$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(${powershellQuote(request)})) | ConvertFrom-Json`,
			"$handle = [OmpRemoteFile]::OpenFile($request.path)",
			"if ($handle.IsInvalid) { exit 83 }",
			"try {",
			" $physical = [OmpRemoteFile]::FinalPath($handle)",
			" $allowed = $false",
			" foreach ($root in $request.roots) {",
			"  $rootHandle = [OmpRemoteFile]::OpenDirectory($root)",
			"  if ($rootHandle.IsInvalid) { $rootHandle.Dispose(); continue }",
			"  try { $rootPhysical = [OmpRemoteFile]::FinalPath($rootHandle) } finally { $rootHandle.Dispose() }",
			"  $prefix = $rootPhysical.TrimEnd('\\') + '\\'",
			"  if ($physical.Equals($rootPhysical,[StringComparison]::OrdinalIgnoreCase) -or $physical.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) { $allowed = $true }",
			" }",
			" if (-not $allowed) { exit 85 }",
			" $stream = [IO.FileStream]::new($handle,[IO.FileAccess]::Read)",
			" try {",
			"  $size = $stream.Length",
			"  $count = [Math]::Min([int64]$request.maxBytes,$size)",
			"  $bytes = [byte[]]::new([int]$count)",
			"  $read = 0",
			"  while ($read -lt $count) { $n=$stream.Read($bytes,$read,[int]($count-$read)); if($n -eq 0){break}; $read+=$n }",
			"  $output = [Console]::OpenStandardOutput()",
			"  $header = [Text.Encoding]::ASCII.GetBytes(([string]$size)+[char]0)",
			"  $output.Write($header,0,$header.Length)",
			"  $output.Write($bytes,0,$read)",
			" } finally { $stream.Dispose() }",
			"} finally { $handle.Dispose() }",
		].join("\n");
		return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
	}

	#posixLaunchCommand(runtime: RemoteRuntimeInfo, args: string[]): string {
		const path = runtime.runtimePath.join(":");
		return `env PATH=${shellQuote(path)} ${shellQuote(runtime.executable)} ${args.map(shellQuote).join(" ")}`.trimEnd();
	}

	#windowsLaunchCommand(runtime: RemoteRuntimeInfo, args: string[]): string {
		const script = [
			`$env:PATH = ${powershellQuote(runtime.runtimePath.join(";"))}`,
			`& ${powershellQuote(runtime.executable)} ${args.map(powershellQuote).join(" ")}`,
			"exit $LASTEXITCODE",
		].join("; ");
		return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encodePowerShell(script)}`;
	}
}
