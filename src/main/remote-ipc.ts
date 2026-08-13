import type {
	FsTreeEntry,
	IpcFsListPayload,
	IpcFsListResult,
	IpcFsReadImagePayload,
	IpcFsReadImageResult,
	IpcFsReadPayload,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	RemoteCatalogResult,
	RemoteDirectoryListResult,
	RemoteDirectoryValidationResult,
	RemoteHistoryResult,
	RemoteHostCatalogSnapshot,
	RemotePreflightResult,
	SessionTarget,
	SshConnectionSnapshot,
	SshSessionTarget,
} from "../shared/ipc-types";
import type { RpcCommand, RpcResponse, RpcSshHostInfo, RpcSshHostsResult } from "../shared/rpc-types";
import { isSshSessionTarget } from "../shared/session-target";
import type { RemoteAcpClient } from "./remote-acp";
import {
	type FinalRemoteTargetAuthorization,
	isBoundedRemoteTargetInput,
	REMOTE_CURSOR_MAX_BYTES,
	REMOTE_EXECUTABLE_OVERRIDE_MAX_BYTES,
	REMOTE_HOST_ALIAS_MAX_BYTES,
	REMOTE_PATH_MAX_BYTES,
	REMOTE_ROOTS_MAX_COUNT,
	REMOTE_SESSION_ID_MAX_BYTES,
	type RemoteFileResult,
	type RemoteSshService,
	type RemoteWorkspaceListResult,
	remoteInputWithinBytes,
} from "./remote-ssh";

const FS_LIST_DEFAULT_DEPTH = 8;
const FS_LIST_MAX_DEPTH = 16;
const FS_LIST_DEFAULT_MAX_FILES = 2_000;
const FS_LIST_MAX_FILES_CAP = 20_000;
const FS_READ_DEFAULT_MAX_BYTES = 200_000;
const FS_READ_MAX_BYTES_CAP = 2_000_000;
const FS_PLAN_MAX_BYTES = 2_000_000;
const FS_IMAGE_MAX_BYTES = 25_000_000;
const MAX_ERROR_LENGTH = 512;
const REMOTE_IMPLICIT_ROOTS_MAX_COUNT = 2;
const REMOTE_DIRECTORY_ROOTS_MAX_COUNT = REMOTE_ROOTS_MAX_COUNT - REMOTE_IMPLICIT_ROOTS_MAX_COUNT;

const HOST_KEYS = [
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
const TARGET_KEYS = ["type", "hostAlias", "host", "originCwd", "cwd", "executableOverride"] as const;

interface CatalogDependency {
	snapshot(): RemoteHostCatalogSnapshot;
	replaceFromRpc(hosts: RpcSshHostInfo[]): RemoteHostCatalogSnapshot;
	setExecutableOverride(hostAlias: string, value: string | null): RemoteHostCatalogSnapshot;
	noteWorkspace(hostAlias: string, cwd: string): RemoteHostCatalogSnapshot;
	target(hostAlias: string, cwd: string): SshSessionTarget | null;
}

type RemoteSshDispatchDependency = Pick<RemoteSshService, "preflight" | "listDirectories" | "validateDirectory">;
type RemoteAcpDispatchDependency = Pick<RemoteAcpClient, "listSessions">;

export interface RemoteIpcDispatchDeps {
	catalog: CatalogDependency;
	refreshCatalog?(): Promise<void>;
	lookupTab(tabId: string): WorkspaceTabIdentity | null;
	ssh: RemoteSshDispatchDependency;
	acp: RemoteAcpDispatchDependency;
}

export interface WorkspaceTabIdentity {
	tabId: string;
	target: SessionTarget;
}

interface LocalWorkspaceOperations {
	list(payload: IpcFsListPayload): Promise<IpcFsListResult>;
	read(payload: IpcFsReadPayload): Promise<IpcFsReadResult>;
	readImage(payload: IpcFsReadImagePayload): Promise<IpcFsReadImageResult>;
	readPlan(payload: IpcFsReadPlanPayload): Promise<IpcFsReadPlanResult>;
}

interface RemoteWorkspaceOperations {
	listWorkspace(
		target: SshSessionTarget,
		path: string,
		roots: string[],
		maxDepth: number,
		maxEntries: number,
	): Promise<RemoteWorkspaceListResult>;
	readFile(target: SshSessionTarget, path: string, roots: string[], maxBytes: number): Promise<RemoteFileResult>;
}

export interface WorkspaceDispatchDeps {
	catalog: CatalogDependency;
	lookupTab(tabId: string): WorkspaceTabIdentity | null;
	trust: RemoteWorkspaceTrust;
	local: LocalWorkspaceOperations;
	remote: RemoteWorkspaceOperations;
}

interface TrustedRemoteState {
	target: SshSessionTarget;
	directories: string[];
	sessionParent: string | null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every(key => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return hasOnlyKeys(value, allowed) && Object.keys(value).length === allowed.length;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function optionalNonEmptyString(value: unknown): value is string | undefined {
	return value === undefined || nonEmptyString(value);
}

export class RemoteRequestRegistry {
	readonly #active = new Map<number, Map<string, AbortController>>();

	start(ownerId: number, requestId: unknown): AbortController | null {
		if (!Number.isInteger(ownerId) || ownerId < 0 || !nonEmptyString(requestId) || requestId.length > 128) {
			return null;
		}
		let ownerRequests = this.#active.get(ownerId);
		if (!ownerRequests) {
			ownerRequests = new Map();
			this.#active.set(ownerId, ownerRequests);
		}
		if (ownerRequests.has(requestId)) return null;
		const controller = new AbortController();
		ownerRequests.set(requestId, controller);
		return controller;
	}

	finish(ownerId: number, requestId: string, controller: AbortController): void {
		const ownerRequests = this.#active.get(ownerId);
		if (ownerRequests?.get(requestId) !== controller) return;
		ownerRequests.delete(requestId);
		if (ownerRequests.size === 0) this.#active.delete(ownerId);
	}

	cancel(ownerId: number, requestId: unknown): boolean {
		if (!nonEmptyString(requestId) || requestId.length > 128) return false;
		const ownerRequests = this.#active.get(ownerId);
		const controller = ownerRequests?.get(requestId);
		if (!ownerRequests || !controller) return false;
		ownerRequests.delete(requestId);
		if (ownerRequests.size === 0) this.#active.delete(ownerId);
		controller.abort();
		return true;
	}

	cancelOwner(ownerId: number): void {
		const ownerRequests = this.#active.get(ownerId);
		if (!ownerRequests) return;
		this.#active.delete(ownerId);
		for (const controller of ownerRequests.values()) controller.abort();
	}
}

interface RemoteResumeGrant {
	target: SshSessionTarget;
	cwd: string;
	sessionId: string;
}

export class RemoteResumeGrantRegistry {
	readonly #byOwner = new Map<number, RemoteResumeGrant[]>();
	readonly #closedOwners = new Set<number>();

	record(ownerId: number, target: SshSessionTarget, cwd: string, sessionId: string): void {
		if (
			!Number.isInteger(ownerId) ||
			ownerId < 0 ||
			this.#closedOwners.has(ownerId) ||
			!nonEmptyString(cwd) ||
			cwd !== target.cwd ||
			!nonEmptyString(sessionId)
		) {
			return;
		}
		let grants = this.#byOwner.get(ownerId);
		if (!grants) {
			grants = [];
			this.#byOwner.set(ownerId, grants);
		}
		if (
			grants.some(grant => grant.cwd === cwd && grant.sessionId === sessionId && sameTarget(grant.target, target))
		) {
			return;
		}
		grants.push({ target: copyTarget(target), cwd, sessionId });
	}

	allows(ownerId: number, target: SshSessionTarget, cwd: string, sessionId: string): boolean {
		const grants = this.#byOwner.get(ownerId);
		return (
			grants?.some(
				grant => grant.cwd === cwd && grant.sessionId === sessionId && sameTarget(grant.target, target),
			) ?? false
		);
	}

	clearOwner(ownerId: number): void {
		this.#closedOwners.add(ownerId);
		this.#byOwner.delete(ownerId);
	}
}

function errorMessage(error: unknown): string {
	let message: string;
	if (error instanceof Error) message = error.message;
	else if (typeof error === "string") message = error;
	else message = "Remote operation failed";
	const trimmed = message.trim();
	return (trimmed || "Remote operation failed").slice(0, MAX_ERROR_LENGTH);
}

function failCatalog(error: string): RemoteCatalogResult {
	return { ok: false, error };
}

function knownAlias(catalog: CatalogDependency, alias: unknown): alias is string {
	return nonEmptyString(alias) && catalog.snapshot().hosts.some(entry => entry.alias === alias);
}

function sameRecordKeys(value: object, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = keys.filter(key => Object.hasOwn(value, key)).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameHost(left: SshConnectionSnapshot, right: SshConnectionSnapshot): boolean {
	if (!sameRecordKeys(left, HOST_KEYS) || !sameRecordKeys(right, HOST_KEYS)) return false;

	return HOST_KEYS.every(key => left[key] === right[key]);
}

function sameTarget(left: SessionTarget, right: SessionTarget): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "local" || right.type === "local") {
		return (
			left.type === "local" &&
			right.type === "local" &&
			Object.keys(left).length === 1 &&
			Object.keys(right).length === 1
		);
	}
	if (!sameRecordKeys(left, TARGET_KEYS) || !sameRecordKeys(right, TARGET_KEYS)) return false;
	return (
		left.hostAlias === right.hostAlias &&
		left.originCwd === right.originCwd &&
		left.cwd === right.cwd &&
		left.executableOverride === right.executableOverride &&
		sameHost(left.host, right.host)
	);
}

function canonicalTarget(catalog: CatalogDependency, value: unknown): SshSessionTarget | null {
	if (!isBoundedRemoteTargetInput(value) || !nonEmptyString(value.hostAlias) || !nonEmptyString(value.cwd)) {
		return null;
	}
	const canonical = catalog.target(value.hostAlias, value.cwd);
	return canonical && sameTarget(value, canonical) ? canonical : null;
}
function finalRemoteDirectoryAuthorization(
	deps: Pick<RemoteIpcDispatchDeps, "catalog">,
	target: SshSessionTarget,
	tabId: unknown,
): FinalRemoteTargetAuthorization {
	if (tabId === undefined) return () => canonicalTarget(deps.catalog, target);
	return () => copyTarget(target);
}

function remoteDirectoryTarget(
	deps: Pick<RemoteIpcDispatchDeps, "catalog" | "lookupTab">,
	target: unknown,
	tabId: unknown,
): SshSessionTarget | null {
	if (tabId === undefined) return canonicalTarget(deps.catalog, target);
	if (!nonEmptyString(tabId) || !isBoundedRemoteTargetInput(target)) return null;
	const owned = deps.lookupTab(tabId);
	if (!owned || !isBoundedRemoteTargetInput(owned.target) || !sameTarget(target, owned.target)) return null;
	return copyTarget(owned.target);
}

function remoteDirectoryTargetError(tabId: unknown): string {
	return tabId === undefined ? "Stale or altered SSH target" : "Stale, altered, or foreign SSH tab target";
}

function validateRpcHost(value: unknown): value is RpcSshHostInfo {
	if (!isPlainRecord(value)) return false;
	const allowed = [
		"name",
		"host",
		"username",
		"port",
		"keyPath",
		"description",
		"compat",
		"scope",
		"editable",
		"source",
		"os",
		"shell",
		"compatShell",
		"transferShell",
	];
	if (!hasOnlyKeys(value, allowed)) return false;
	if (!nonEmptyString(value.name) || !nonEmptyString(value.host) || !nonEmptyString(value.source)) return false;
	if (value.host.startsWith("-") || /[\s\u0000-\u001f\u007f-\u009f]/u.test(value.host)) return false;
	if (value.scope !== "user" && value.scope !== "project" && value.scope !== "native") return false;
	if (typeof value.editable !== "boolean") return false;
	if (!optionalNonEmptyString(value.username) || !optionalNonEmptyString(value.keyPath)) return false;
	if (
		value.username !== undefined &&
		(value.username.startsWith("-") ||
			value.username.includes("@") ||
			/[\s\u0000-\u001f\u007f-\u009f]/u.test(value.username))
	) {
		return false;
	}
	if (value.description !== undefined && typeof value.description !== "string") return false;
	if (
		value.port !== undefined &&
		(!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65_535)
	) {
		return false;
	}
	if (value.compat !== undefined && typeof value.compat !== "boolean") return false;
	if (value.os !== undefined && !["windows", "linux", "macos", "unknown"].includes(String(value.os))) return false;
	if (
		value.shell !== undefined &&
		!["cmd", "powershell", "bash", "zsh", "sh", "unknown"].includes(String(value.shell))
	) {
		return false;
	}
	if (value.compatShell !== undefined && value.compatShell !== "bash" && value.compatShell !== "sh") return false;
	return (
		value.transferShell === undefined ||
		value.transferShell === "sh" ||
		value.transferShell === "bash" ||
		value.transferShell === "zsh"
	);
}

function validateRpcHosts(value: unknown): value is RpcSshHostInfo[] {
	if (!Array.isArray(value)) return false;
	const aliases = new Set<string>();
	for (const host of value) {
		if (!validateRpcHost(host) || aliases.has(host.name)) return false;
		aliases.add(host.name);
	}
	return true;
}

function validateRpcSshHostsResult(value: unknown): value is RpcSshHostsResult {
	return (
		isPlainRecord(value) &&
		hasExactKeys(value, ["openSshAvailable", "hosts", "warnings"]) &&
		typeof value.openSshAvailable === "boolean" &&
		validateRpcHosts(value.hosts) &&
		Array.isArray(value.warnings) &&
		value.warnings.every(warning => typeof warning === "string")
	);
}

export function observeRemoteCatalogRpcResponse(
	catalog: Pick<CatalogDependency, "replaceFromRpc">,
	source: SessionTarget | null,
	command: Pick<RpcCommand, "type">,
	response: RpcResponse,
): boolean {
	if (
		source?.type !== "local" ||
		command.type !== "get_ssh_hosts" ||
		!response.success ||
		response.command !== "get_ssh_hosts" ||
		!validateRpcSshHostsResult(response.data)
	) {
		return false;
	}
	try {
		catalog.replaceFromRpc(response.data.hosts);
		return true;
	} catch {
		return false;
	}
}

export type RemoteTargetSinkResult<Value> = { ok: true; value: Value } | { ok: false; error: string };

export async function authorizeRemoteTargetAtSink<Value>(
	deps: Pick<RemoteIpcDispatchDeps, "catalog" | "ssh">,
	payload: unknown,
	sink: (target: SshSessionTarget) => Value,
): Promise<RemoteTargetSinkResult<Value>> {
	if (!isPlainRecord(payload) || !hasExactKeys(payload, ["target", "cwd"])) {
		return { ok: false, error: "Invalid remote target request" };
	}
	if (!nonEmptyString(payload.cwd) || !remoteInputWithinBytes(payload.cwd, REMOTE_PATH_MAX_BYTES)) {
		return { ok: false, error: "Remote cwd does not match target" };
	}
	const target = canonicalTarget(deps.catalog, payload.target);
	if (!target) return { ok: false, error: "Stale or altered SSH target" };
	if (payload.cwd !== target.cwd) {
		return { ok: false, error: "Remote cwd does not match target" };
	}
	try {
		const validation = await deps.ssh.validateDirectory(target, payload.cwd, undefined, () =>
			canonicalTarget(deps.catalog, target),
		);
		if (!validation.ok) return { ok: false, error: errorMessage(validation.error) };
		if (validation.path !== payload.cwd) {
			return { ok: false, error: "Remote directory changed during validation" };
		}
		const fresh = canonicalTarget(deps.catalog, target);
		if (!fresh) return { ok: false, error: "Stale or altered SSH target" };
		return { ok: true, value: sink(copyTarget(fresh)) };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

export async function dispatchRemoteCatalog(
	deps: RemoteIpcDispatchDeps,
	payload: unknown,
): Promise<RemoteCatalogResult> {
	if (!isPlainRecord(payload) || Object.keys(payload).length !== 0) return failCatalog("Invalid catalog request");
	if (deps.refreshCatalog) {
		try {
			await deps.refreshCatalog();
		} catch {
			// The persisted main-process catalog is the fallback when its local
			// refresh sidecar disappears or rejects the request.
		}
	}
	try {
		return { ok: true, catalog: deps.catalog.snapshot() };
	} catch (error) {
		return failCatalog(errorMessage(error));
	}
}

export async function dispatchRemoteOverride(
	deps: RemoteIpcDispatchDeps,
	payload: unknown,
): Promise<RemoteCatalogResult> {
	if (
		!isPlainRecord(payload) ||
		!hasExactKeys(payload, ["hostAlias", "value"]) ||
		!nonEmptyString(payload.hostAlias) ||
		!remoteInputWithinBytes(payload.hostAlias, REMOTE_HOST_ALIAS_MAX_BYTES)
	) {
		return failCatalog("Invalid remote host alias");
	}
	if (
		payload.value !== null &&
		(!nonEmptyString(payload.value) || !remoteInputWithinBytes(payload.value, REMOTE_EXECUTABLE_OVERRIDE_MAX_BYTES))
	) {
		return failCatalog("Invalid executable override");
	}
	if (!knownAlias(deps.catalog, payload.hostAlias)) return failCatalog("Unknown remote host");
	try {
		return { ok: true, catalog: deps.catalog.setExecutableOverride(payload.hostAlias, payload.value) };
	} catch (error) {
		return failCatalog(errorMessage(error));
	}
}

export async function dispatchRemoteNoteWorkspace(
	deps: RemoteIpcDispatchDeps,
	payload: unknown,
): Promise<RemoteCatalogResult> {
	if (
		!isPlainRecord(payload) ||
		!hasExactKeys(payload, ["hostAlias", "cwd"]) ||
		!nonEmptyString(payload.hostAlias) ||
		!remoteInputWithinBytes(payload.hostAlias, REMOTE_HOST_ALIAS_MAX_BYTES)
	) {
		return failCatalog("Invalid remote host alias");
	}
	if (!nonEmptyString(payload.cwd) || !remoteInputWithinBytes(payload.cwd, REMOTE_PATH_MAX_BYTES)) {
		return failCatalog("Invalid remote workspace");
	}
	if (!knownAlias(deps.catalog, payload.hostAlias)) return failCatalog("Unknown remote host");
	const hostAlias = payload.hostAlias;
	const cwd = payload.cwd;
	const target = deps.catalog.target(hostAlias, cwd);
	if (!target) return failCatalog("Invalid remote workspace");
	const authorized = await authorizeRemoteTargetAtSink(deps, { target, cwd }, fresh =>
		deps.catalog.noteWorkspace(hostAlias, fresh.cwd),
	);
	return authorized.ok ? { ok: true, catalog: authorized.value } : failCatalog(authorized.error);
}

export async function dispatchRemotePreflight(
	deps: RemoteIpcDispatchDeps,
	payload: unknown,
	signal?: AbortSignal,
): Promise<RemotePreflightResult> {
	if (
		!isPlainRecord(payload) ||
		!hasOnlyKeys(payload, ["target", "tabId", "requestId"]) ||
		!Object.hasOwn(payload, "target")
	) {
		return { ok: false, error: "Invalid preflight request" };
	}
	const target = remoteDirectoryTarget(deps, payload.target, payload.tabId);
	if (!target) return { ok: false, error: remoteDirectoryTargetError(payload.tabId) };
	try {
		return await deps.ssh.preflight(target, signal, finalRemoteDirectoryAuthorization(deps, target, payload.tabId));
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

export async function dispatchRemoteListDirectories(
	deps: RemoteIpcDispatchDeps,
	payload: unknown,
	signal?: AbortSignal,
): Promise<RemoteDirectoryListResult> {
	if (
		!isPlainRecord(payload) ||
		!hasOnlyKeys(payload, ["target", "tabId", "requestId", "path", "showHidden"]) ||
		!Object.hasOwn(payload, "target") ||
		!Object.hasOwn(payload, "path") ||
		!Object.hasOwn(payload, "showHidden") ||
		!nonEmptyString(payload.path) ||
		!remoteInputWithinBytes(payload.path, REMOTE_PATH_MAX_BYTES) ||
		typeof payload.showHidden !== "boolean"
	) {
		return { ok: false, error: "Invalid remote directory request" };
	}
	const target = remoteDirectoryTarget(deps, payload.target, payload.tabId);
	if (!target) return { ok: false, error: remoteDirectoryTargetError(payload.tabId) };
	try {
		return await deps.ssh.listDirectories(
			target,
			payload.path,
			payload.showHidden,
			signal,
			finalRemoteDirectoryAuthorization(deps, target, payload.tabId),
		);
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

export async function dispatchRemoteValidateDirectory(
	deps: RemoteIpcDispatchDeps,
	payload: unknown,
	signal?: AbortSignal,
): Promise<RemoteDirectoryValidationResult> {
	if (
		!isPlainRecord(payload) ||
		!hasOnlyKeys(payload, ["target", "tabId", "requestId", "path"]) ||
		!Object.hasOwn(payload, "target") ||
		!Object.hasOwn(payload, "path") ||
		!nonEmptyString(payload.path) ||
		!remoteInputWithinBytes(payload.path, REMOTE_PATH_MAX_BYTES)
	) {
		return { ok: false, error: "Invalid remote directory request" };
	}
	const target = remoteDirectoryTarget(deps, payload.target, payload.tabId);
	if (!target) return { ok: false, error: remoteDirectoryTargetError(payload.tabId) };
	try {
		return await deps.ssh.validateDirectory(
			target,
			payload.path,
			signal,
			finalRemoteDirectoryAuthorization(deps, target, payload.tabId),
		);
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

export async function dispatchRemoteHistory(
	deps: RemoteIpcDispatchDeps,
	payload: unknown,
	recordResumeGrant?: (target: SshSessionTarget, cwd: string, sessionId: string) => void,
): Promise<RemoteHistoryResult> {
	if (
		!isPlainRecord(payload) ||
		!hasOnlyKeys(payload, ["hostAlias", "cursor"]) ||
		!nonEmptyString(payload.hostAlias) ||
		!remoteInputWithinBytes(payload.hostAlias, REMOTE_HOST_ALIAS_MAX_BYTES)
	) {
		return { ok: false, error: "Invalid remote host alias" };
	}
	if (
		payload.cursor !== undefined &&
		(!nonEmptyString(payload.cursor) || !remoteInputWithinBytes(payload.cursor, REMOTE_CURSOR_MAX_BYTES))
	) {
		return { ok: false, error: "Invalid history cursor" };
	}
	const host = deps.catalog.snapshot().hosts.find(entry => entry.alias === payload.hostAlias);
	if (!host) return { ok: false, error: "Unknown remote host" };
	const fallbackCwd = host.host.os === "windows" ? "C:\\" : "/";
	const target = deps.catalog.target(host.alias, host.recentWorkspaces[0] ?? fallbackCwd);
	if (!target) return { ok: false, error: "No known remote workspace" };
	try {
		const result = await deps.acp.listSessions(target, () => canonicalTarget(deps.catalog, target));
		if (!result.ok) return result;
		const sessions = [];
		for (const session of result.sessions) {
			if (
				!nonEmptyString(session.sessionId) ||
				!remoteInputWithinBytes(session.sessionId, REMOTE_SESSION_ID_MAX_BYTES) ||
				!nonEmptyString(session.cwd) ||
				!remoteInputWithinBytes(session.cwd, REMOTE_PATH_MAX_BYTES) ||
				!isAbsoluteRemotePath(session.cwd, target)
			) {
				return { ok: false, error: "Invalid remote history response" };
			}
			const sessionTarget: SshSessionTarget = {
				...target,
				host: { ...target.host },
				originCwd: session.cwd,
				cwd: session.cwd,
			};
			sessions.push({ ...session, target: sessionTarget });
		}
		if (recordResumeGrant) {
			for (const session of sessions) {
				recordResumeGrant(session.target, session.cwd, session.sessionId);
			}
		}
		return { ok: true, sessions };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}

export type NewWindowRequestResult =
	| {
			ok: true;
			cwd: string;
			target: SessionTarget;
			sessionPath?: string;
			resumeSessionId?: string;
	  }
	| { ok: false; error: string };

export function resolveNewWindowRequest(
	catalog: CatalogDependency,
	payload: unknown,
	callerCwd: string,
	authorizeRemoteResume?: (target: SshSessionTarget, cwd: string, sessionId: string) => boolean,
): NewWindowRequestResult {
	if (
		!isPlainRecord(payload) ||
		!hasOnlyKeys(payload, ["sessionPath", "cwd", "target", "resumeSessionId"]) ||
		(payload.sessionPath !== undefined && !nonEmptyString(payload.sessionPath)) ||
		(payload.cwd !== undefined && !nonEmptyString(payload.cwd)) ||
		(payload.resumeSessionId !== undefined &&
			(!nonEmptyString(payload.resumeSessionId) ||
				!remoteInputWithinBytes(payload.resumeSessionId, REMOTE_SESSION_ID_MAX_BYTES))) ||
		(isPlainRecord(payload.target) &&
			payload.target.type === "ssh" &&
			payload.cwd !== undefined &&
			!remoteInputWithinBytes(payload.cwd, REMOTE_PATH_MAX_BYTES))
	) {
		return { ok: false, error: "Invalid new-window request" };
	}
	if (payload.target === undefined || (isPlainRecord(payload.target) && payload.target.type === "local")) {
		if (
			payload.target !== undefined &&
			(!isPlainRecord(payload.target) || Object.keys(payload.target).length !== 1)
		) {
			return { ok: false, error: "Invalid local target" };
		}
		if (payload.resumeSessionId !== undefined) {
			return { ok: false, error: "Local windows cannot resume remote session ids" };
		}
		const result: NewWindowRequestResult = {
			ok: true,
			cwd: payload.cwd ?? callerCwd,
			target: { type: "local" },
		};
		if (payload.sessionPath !== undefined) result.sessionPath = payload.sessionPath;
		return result;
	}
	if (payload.sessionPath !== undefined) return { ok: false, error: "Remote windows cannot open local session paths" };
	const target = canonicalTarget(catalog, payload.target);
	if (!target) return { ok: false, error: "Stale or altered SSH target" };
	if (!nonEmptyString(payload.cwd) || payload.cwd !== target.cwd) {
		return { ok: false, error: "Remote window cwd does not match its target" };
	}
	if (payload.resumeSessionId !== undefined && !authorizeRemoteResume?.(target, target.cwd, payload.resumeSessionId)) {
		return { ok: false, error: "Remote resume session is not authorized" };
	}
	const result: NewWindowRequestResult = { ok: true, cwd: target.cwd, target };
	if (payload.resumeSessionId !== undefined) result.resumeSessionId = payload.resumeSessionId;
	return result;
}

function isAbsoluteRemotePath(value: string, target: SshSessionTarget): boolean {
	const windowsPath = /^[A-Za-z]:[\\/]/u.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(value);
	if (target.host.os === "windows") return windowsPath;
	if (target.host.os === "linux" || target.host.os === "macos") return value.startsWith("/");
	return value.startsWith("/") || windowsPath;
}

function parentRemotePath(value: string, target: SshSessionTarget): string | null {
	if (!nonEmptyString(value)) return null;
	const windows = target.host.os === "windows" || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value);
	if (windows) {
		const normalized = value.replaceAll("/", "\\").replace(/\\+$/u, "");
		const index = normalized.lastIndexOf("\\");
		if (index < 0) return null;
		if (index === 2 && /^[A-Za-z]:/u.test(normalized)) return normalized.slice(0, 3);
		return normalized.slice(0, index) || null;
	}
	const normalized = value.replace(/\/+$/u, "");
	const index = normalized.lastIndexOf("/");
	return index <= 0 ? (index === 0 ? "/" : null) : normalized.slice(0, index);
}

function copyTarget(target: SshSessionTarget): SshSessionTarget {
	return { ...target, host: { ...target.host } };
}

export class RemoteWorkspaceTrust {
	readonly #states = new Map<string, TrustedRemoteState>();

	observeRpcSuccess(tab: WorkspaceTabIdentity, command: Pick<RpcCommand, "type">, data: unknown): void {
		if (!nonEmptyString(tab.tabId) || !isBoundedRemoteTargetInput(tab.target)) return;
		const target = tab.target;
		let observedDirectories: Array<{ path: string; primary: boolean }> | null = null;
		let observedSessionFile: string | null = null;
		if (
			command.type === "get_directories" ||
			command.type === "add_directory" ||
			command.type === "remove_directory"
		) {
			if (
				!isPlainRecord(data) ||
				!Array.isArray(data.directories) ||
				data.directories.length > REMOTE_DIRECTORY_ROOTS_MAX_COUNT ||
				!data.directories.every(
					(entry): entry is { path: string; primary: boolean } =>
						isPlainRecord(entry) &&
						nonEmptyString(entry.path) &&
						remoteInputWithinBytes(entry.path, REMOTE_PATH_MAX_BYTES) &&
						isAbsoluteRemotePath(entry.path, target) &&
						typeof entry.primary === "boolean",
				)
			) {
				return;
			}
			observedDirectories = data.directories;
		} else if (command.type === "get_state") {
			if (!isPlainRecord(data)) return;
			const sessionFile = data.sessionFile;
			if (
				sessionFile !== null &&
				(!nonEmptyString(sessionFile) ||
					!remoteInputWithinBytes(sessionFile, REMOTE_PATH_MAX_BYTES) ||
					!isAbsoluteRemotePath(sessionFile, target))
			) {
				return;
			}
			observedSessionFile = sessionFile;
		}

		let state = this.#states.get(tab.tabId);
		if (!state || !sameTarget(state.target, target)) {
			state = { target: copyTarget(target), directories: [], sessionParent: null };
			this.#states.set(tab.tabId, state);
		}
		if (observedDirectories) {
			const directories: string[] = [];
			for (const entry of observedDirectories) {
				if (!directories.includes(entry.path)) directories.push(entry.path);
			}
			state.directories = directories;
		} else if (command.type === "get_state") {
			state.sessionParent = observedSessionFile === null ? null : parentRemotePath(observedSessionFile, target);
		}
	}

	release(tabId: string): void {
		this.#states.delete(tabId);
	}

	rootsFor(tab: WorkspaceTabIdentity): string[] | null {
		if (!isSshSessionTarget(tab.target)) return [];
		if (!isBoundedRemoteTargetInput(tab.target)) return null;
		let state = this.#states.get(tab.tabId);
		if (state && !sameTarget(state.target, tab.target)) {
			this.#states.delete(tab.tabId);
			state = undefined;
		}
		const roots = [tab.target.cwd, ...(state?.directories ?? [])];
		if (state?.sessionParent) roots.push(state.sessionParent);
		return roots.filter((root, index) => nonEmptyString(root) && roots.indexOf(root) === index);
	}
}

function validateTab(
	deps: WorkspaceDispatchDeps,
	requested: WorkspaceTabIdentity,
): { tab: WorkspaceTabIdentity } | { error: string } {
	if (!isPlainRecord(requested) || !hasExactKeys(requested, ["tabId", "target"]) || !nonEmptyString(requested.tabId)) {
		return { error: "Invalid tab identity" };
	}
	const validTarget =
		(isPlainRecord(requested.target) &&
			requested.target.type === "local" &&
			Object.keys(requested.target).length === 1) ||
		isBoundedRemoteTargetInput(requested.target);
	if (!validTarget) return { error: "Invalid tab identity" };
	const current = deps.lookupTab(requested.tabId);
	if (!current) return { error: "Unknown tab" };
	if (!sameTarget(requested.target, current.target)) return { error: "Stale or altered tab target" };
	return { tab: current };
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
	return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	return Math.min(max, Math.max(min, Math.floor(value ?? fallback)));
}

function isRemoteWorkspaceRequest(requested: WorkspaceTabIdentity): boolean {
	return isPlainRecord(requested) && isPlainRecord(requested.target) && requested.target.type === "ssh";
}

function normalizeRelativeRemotePath(root: string, value: string, target: SshSessionTarget): string | null {
	if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
	const windows = target.host.os === "windows" || /^[A-Za-z]:[\\/]/.test(root) || /^\\\\/.test(root);
	const absolute = windows ? /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) : value.startsWith("/");
	if (absolute) return value;
	const parts = value.split(/[\\/]+/u).filter(part => part.length > 0 && part !== ".");
	if (parts.some(part => part === "..")) return null;
	if (parts.length === 0) return root;
	const separator = windows && root.includes("\\") ? "\\" : "/";
	return `${root.replace(/[\\/]+$/u, "")}${separator}${parts.join(separator)}`;
}

function fsReadFailure(error: string): IpcFsReadResult {
	return { ok: false, content: "", truncated: false, binary: false, size: 0, error };
}

function fsImageFailure(error: string): IpcFsReadImageResult {
	return { ok: false, dataUrl: null, mime: null, size: 0, error };
}

function fsPlanFailure(error: string): IpcFsReadPlanResult {
	return { ok: false, path: null, content: null, error };
}

export function formatWorkspaceRead(result: RemoteFileResult, maxBytes: number): IpcFsReadResult {
	if (!result.ok) return fsReadFailure(result.error);
	const bytes = Buffer.from(result.data);
	if (bytes.includes(0)) return { ok: true, content: "", truncated: false, binary: true, size: result.size };
	return {
		ok: true,
		content: bytes.subarray(0, maxBytes).toString("utf8"),
		truncated: result.truncated || result.size > maxBytes,
		binary: false,
		size: result.size,
	};
}

export function sniffImageMime(header: Uint8Array): string | null {
	const bytes = Buffer.from(header);
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
		return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (
		bytes.length >= 6 &&
		(bytes.subarray(0, 6).toString("ascii") === "GIF89a" || bytes.subarray(0, 6).toString("ascii") === "GIF87a")
	) {
		return "image/gif";
	}
	if (
		bytes.length >= 12 &&
		bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
		bytes.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "image/webp";
	}
	if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
		const brand = bytes.subarray(8, 12).toString("ascii");
		if (brand === "avif" || brand === "avis") return "image/avif";
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
	if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return "image/x-icon";
	const text = bytes.toString("utf8").trimStart().slice(0, 512).toLowerCase();
	return text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg")) ? "image/svg+xml" : null;
}

function formatWorkspaceImage(result: RemoteFileResult): IpcFsReadImageResult {
	if (!result.ok) return fsImageFailure(result.error);
	if (result.size > FS_IMAGE_MAX_BYTES) return fsImageFailure("Image too large");
	if (result.truncated || result.data.byteLength !== result.size)
		return fsImageFailure("Remote image read was incomplete");
	const mime = sniffImageMime(result.data.subarray(0, 512));
	if (!mime) return fsImageFailure("Not a supported image");
	const body = Buffer.from(result.data);
	return { ok: true, dataUrl: `data:${mime};base64,${body.toString("base64")}`, mime, size: result.size };
}

function flattenEntries(entries: FsTreeEntry[]): FsTreeEntry[] {
	const flattened: FsTreeEntry[] = [];
	for (const entry of entries) {
		flattened.push(entry);
		if (entry.children) flattened.push(...flattenEntries(entry.children));
	}
	return flattened;
}

export async function dispatchWorkspaceList(
	deps: WorkspaceDispatchDeps,
	requestedTab: WorkspaceTabIdentity,
	payload: unknown,
): Promise<IpcFsListResult> {
	if (
		!isPlainRecord(payload) ||
		!hasOnlyKeys(payload, ["path", "maxDepth", "maxEntries"]) ||
		(payload.path !== undefined && typeof payload.path !== "string") ||
		(isRemoteWorkspaceRequest(requestedTab) &&
			payload.path !== undefined &&
			!remoteInputWithinBytes(payload.path, REMOTE_PATH_MAX_BYTES)) ||
		!isOptionalFiniteNumber(payload.maxDepth) ||
		!isOptionalFiniteNumber(payload.maxEntries)
	) {
		return { ok: false, entries: [], truncated: false, error: "Invalid workspace list request" };
	}
	const resolved = validateTab(deps, requestedTab);
	if ("error" in resolved) return { ok: false, entries: [], truncated: false, error: resolved.error };
	const normalized: IpcFsListPayload = {
		path: payload.path,
		maxDepth: payload.maxDepth,
		maxEntries: payload.maxEntries,
	};
	if (resolved.tab.target.type === "local") return deps.local.list(normalized);
	const target = resolved.tab.target;
	const roots = deps.trust.rootsFor(resolved.tab);
	if (!roots) return { ok: false, entries: [], truncated: false, error: "Stale remote workspace state" };
	const remotePath = normalizeRelativeRemotePath(target.cwd, payload.path ?? "", target);
	if (!remotePath) return { ok: false, entries: [], truncated: false, error: "Path escapes the workspace" };
	try {
		const result = await deps.remote.listWorkspace(
			target,
			remotePath,
			roots,
			clampInt(payload.maxDepth, 1, FS_LIST_MAX_DEPTH, FS_LIST_DEFAULT_DEPTH),
			clampInt(payload.maxEntries, 1, FS_LIST_MAX_FILES_CAP, FS_LIST_DEFAULT_MAX_FILES),
		);
		return result.ok ? result : { ok: false, entries: [], truncated: false, error: result.error };
	} catch (error) {
		return { ok: false, entries: [], truncated: false, error: errorMessage(error) };
	}
}

export async function dispatchWorkspaceRead(
	deps: WorkspaceDispatchDeps,
	requestedTab: WorkspaceTabIdentity,
	payload: unknown,
): Promise<IpcFsReadResult> {
	if (
		!isPlainRecord(payload) ||
		!hasOnlyKeys(payload, ["path", "maxBytes"]) ||
		!nonEmptyString(payload.path) ||
		(isRemoteWorkspaceRequest(requestedTab) && !remoteInputWithinBytes(payload.path, REMOTE_PATH_MAX_BYTES)) ||
		!isOptionalFiniteNumber(payload.maxBytes)
	) {
		return fsReadFailure("Invalid path");
	}
	const resolved = validateTab(deps, requestedTab);
	if ("error" in resolved) return fsReadFailure(resolved.error);
	const maxBytes = clampInt(payload.maxBytes, 1, FS_READ_MAX_BYTES_CAP, FS_READ_DEFAULT_MAX_BYTES);
	if (resolved.tab.target.type === "local") return deps.local.read({ path: payload.path, maxBytes: payload.maxBytes });
	const target = resolved.tab.target;
	const roots = deps.trust.rootsFor(resolved.tab);
	if (!roots) return fsReadFailure("Stale remote workspace state");
	const remotePath = normalizeRelativeRemotePath(target.cwd, payload.path, target);
	if (!remotePath) return fsReadFailure("Path escapes the workspace");
	try {
		return formatWorkspaceRead(await deps.remote.readFile(target, remotePath, roots, maxBytes + 1), maxBytes);
	} catch (error) {
		return fsReadFailure(errorMessage(error));
	}
}

export async function dispatchWorkspaceReadImage(
	deps: WorkspaceDispatchDeps,
	requestedTab: WorkspaceTabIdentity,
	payload: unknown,
): Promise<IpcFsReadImageResult> {
	if (
		!isPlainRecord(payload) ||
		!hasExactKeys(payload, ["path"]) ||
		!nonEmptyString(payload.path) ||
		(isRemoteWorkspaceRequest(requestedTab) && !remoteInputWithinBytes(payload.path, REMOTE_PATH_MAX_BYTES))
	) {
		return fsImageFailure("Invalid path");
	}
	const resolved = validateTab(deps, requestedTab);
	if ("error" in resolved) return fsImageFailure(resolved.error);
	if (resolved.tab.target.type === "local") return deps.local.readImage({ path: payload.path });
	const target = resolved.tab.target;
	const roots = deps.trust.rootsFor(resolved.tab);
	if (!roots) return fsImageFailure("Stale remote workspace state");
	const remotePath = normalizeRelativeRemotePath(target.cwd, payload.path, target);
	if (!remotePath) return fsImageFailure("Path escapes the workspace");
	try {
		return formatWorkspaceImage(await deps.remote.readFile(target, remotePath, roots, FS_IMAGE_MAX_BYTES + 1));
	} catch (error) {
		return fsImageFailure(errorMessage(error));
	}
}

export async function dispatchWorkspaceReadPlan(
	deps: WorkspaceDispatchDeps,
	requestedTab: WorkspaceTabIdentity,
	payload: unknown,
): Promise<IpcFsReadPlanResult> {
	if (
		!isPlainRecord(payload) ||
		!hasExactKeys(payload, ["fsPath", "localRoot"]) ||
		!nonEmptyString(payload.fsPath) ||
		(payload.localRoot !== null && !nonEmptyString(payload.localRoot)) ||
		(isRemoteWorkspaceRequest(requestedTab) &&
			(!remoteInputWithinBytes(payload.fsPath, REMOTE_PATH_MAX_BYTES) ||
				(payload.localRoot !== null && !remoteInputWithinBytes(payload.localRoot, REMOTE_PATH_MAX_BYTES))))
	) {
		return fsPlanFailure("Invalid path");
	}
	const resolved = validateTab(deps, requestedTab);
	if ("error" in resolved) return fsPlanFailure(resolved.error);
	if (resolved.tab.target.type === "local") {
		return deps.local.readPlan({ fsPath: payload.fsPath, localRoot: payload.localRoot });
	}
	const target = resolved.tab.target;
	const roots = deps.trust.rootsFor(resolved.tab);
	if (!roots) return fsPlanFailure("Stale remote workspace state");
	const planPath = normalizeRelativeRemotePath(target.cwd, payload.fsPath, target);
	if (!planPath) return fsPlanFailure("Path escapes allowed roots");
	try {
		const primary = await deps.remote.readFile(target, planPath, roots, FS_PLAN_MAX_BYTES + 1);
		if (primary.ok) {
			if (primary.size > FS_PLAN_MAX_BYTES) return fsPlanFailure("Plan file too large");
			if (primary.truncated || primary.data.byteLength !== primary.size) {
				return fsPlanFailure("Remote plan read was incomplete");
			}
			return { ok: true, path: planPath, content: Buffer.from(primary.data).toString("utf8") };
		}
		if (payload.localRoot === null) return { ok: true, path: null, content: null };
		const fallbackRoot = normalizeRelativeRemotePath(target.cwd, payload.localRoot, target);
		if (!fallbackRoot) return fsPlanFailure("Path escapes allowed roots");
		const listed = await deps.remote.listWorkspace(target, fallbackRoot, roots, 1, FS_LIST_DEFAULT_MAX_FILES);
		if (!listed.ok) return { ok: true, path: null, content: null };
		const fallback = flattenEntries(listed.entries)
			.filter(entry => entry.kind === "file" && /plan\.md$/iu.test(entry.name))
			.sort((left, right) => right.name.localeCompare(left.name))[0];
		if (!fallback) return { ok: true, path: null, content: null };
		const fallbackPath = normalizeRelativeRemotePath(fallbackRoot, fallback.path, target);
		if (!fallbackPath) return fsPlanFailure("Path escapes allowed roots");
		const picked = await deps.remote.readFile(target, fallbackPath, roots, FS_PLAN_MAX_BYTES + 1);
		if (!picked.ok) return { ok: true, path: null, content: null };
		if (picked.size > FS_PLAN_MAX_BYTES) return fsPlanFailure("Plan file too large");
		if (picked.truncated || picked.data.byteLength !== picked.size) {
			return fsPlanFailure("Remote plan read was incomplete");
		}
		return { ok: true, path: fallbackPath, content: Buffer.from(picked.data).toString("utf8") };
	} catch (error) {
		return fsPlanFailure(errorMessage(error));
	}
}
