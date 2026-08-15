/**
 * Registers all IPC handlers and wires sidecar events to renderer windows.
 */
import { type Dirent, existsSync, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from "electron";
import Store from "electron-store";
import type {
	CustomProviderInput,
	FsTreeEntry,
	IpcCloseTabPayload,
	IpcExtensionUiRespondPayload,
	IpcFsListPayload,
	IpcFsListResult,
	IpcFsReadImagePayload,
	IpcFsReadImageResult,
	IpcFsReadPayload,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	IpcGetSessionOwnerPayload,
	IpcHostToolResultPayload,
	IpcHostToolUpdatePayload,
	IpcHostUriResultPayload,
	IpcNotifyPayload,
	IpcOpenPathResult,
	IpcPrefsGetPayload,
	IpcPrefsSetPayload,
	IpcRemoteCancelRequestPayload,
	IpcRpcCommandForTabPayload,
	IpcRpcCommandPayload,
	IpcSessionsDeletePayload,
	IpcSessionsListPayload,
	IpcSessionsRenamePayload,
	IpcSessionsSearchPayload,
	IpcSetActiveTabPayload,
	IpcSidecarRestartPayload,
	IpcSpawnTabPayload,
	IpcSpawnTabResult,
	IpcStatsFetchPayload,
	IpcSubagentTranscriptReadPayload,
	IpcSubagentTranscriptReadResult,
	SshSessionTarget,
} from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS, type RunProgressState, type TrayState } from "../shared/ipc-types";
import type { AgentMessage, RpcCommand, RpcResponse, RpcSessionState } from "../shared/rpc-types";
import { ensureDefaultWorkspace } from "./default-workspace";
import { openInExternalEditor } from "./editor";
import { mainT } from "./i18n";
import { isLocalSshSettingsCommand, isLocalSshSettingsCommandType } from "./local-ssh-settings";
import type { LogWatcher } from "./log-watcher";
import { createMenu } from "./menu";
import { deleteModelsProvider, listModelsProviders, modelsPath, upsertModelsProvider } from "./models-config";
import type { RemoteAcpClient } from "./remote-acp";
import type { RemoteHostCatalog } from "./remote-host-catalog";
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
	RemoteRequestRegistry,
	RemoteResumeGrantRegistry,
	RemoteWorkspaceTrust,
	resolveNewWindowRequest,
	sniffImageMime,
	type WorkspaceDispatchDeps,
	type WorkspaceTabIdentity,
} from "./remote-ipc";
import { REMOTE_PATH_MAX_BYTES, type RemoteSshService } from "./remote-ssh";
import { runtimeLogPath, writeRuntimeLog } from "./runtime-log";
import type { SessionIndex } from "./session-index";
import { resolveEditorCommand } from "./shell-env";
import type { SidecarManager } from "./sidecar";
import type { SidecarPool } from "./sidecar-pool";
import type { StatsClient } from "./stats-client";
import { spawnTabForWindow } from "./tab-spawn";
import { setTrayState } from "./tray";
import type { SpawnWindow, WindowManager } from "./window";

export type LocalSshSettingsCommand = Extract<RpcCommand, { type: "get_ssh_hosts" | "ssh_manage" | "ssh_test" }>;

export interface LocalSshSettingsDependency {
	execute(cwd: string, command: unknown): Promise<RpcResponse>;
}

export interface IpcDeps {
	sidecarPool: SidecarPool;
	sessionIndex: SessionIndex;
	statsClient: StatsClient;
	logWatcher: LogWatcher;
	windowManager: WindowManager;
	/** Spawn a window with its own sidecar (index.ts's pool-backed helper). */
	spawnWindow: SpawnWindow;
	remoteSsh: RemoteSshService;
	remoteHostCatalog: RemoteHostCatalog;
	remoteAcp: RemoteAcpClient;
	localSshSettings: LocalSshSettingsDependency;
}

/**
 * Resolve the sidecar that owns the calling window. Routing derives from
 * `event.sender` (Electron guarantees it is the caller's webContents), never
 * from a client-supplied id. Null when the window has no sidecar bound yet.
 */
function sidecarFor(deps: IpcDeps, event: Electron.IpcMainInvokeEvent): SidecarManager | null {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return null;
	return deps.sidecarPool.sidecarForWindow(win);
}

function localProjectCwdForWindow(deps: IpcDeps, win: BrowserWindow): string | null {
	const active = deps.sidecarPool.entryForWindow(win);
	if (active?.target.type === "local") return active.sidecar.cwd;
	return deps.windowManager.recordFor(win)?.cwd ?? null;
}

interface LocalProjectContext {
	win: BrowserWindow;
	sidecar: SidecarManager;
}

/** Local project mutation is forbidden when the calling window's active tab is SSH-owned. */
function localProjectContextFor(deps: IpcDeps, event: Electron.IpcMainInvokeEvent): LocalProjectContext | null {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return null;
	const entry = deps.sidecarPool.entryForWindow(win);
	return entry?.target.type === "local" ? { win, sidecar: entry.sidecar } : null;
}

/**
 * The calling window's working directory — the bound sidecar's cwd when one
 * exists, else the cwd the window was created with (before its sidecar binds).
 */
function cwdFor(deps: IpcDeps, event: Electron.IpcMainInvokeEvent): string | null {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return null;
	return deps.sidecarPool.sidecarForWindow(win)?.cwd ?? deps.windowManager.recordFor(win)?.cwd ?? null;
}

interface PrefsSchema {
	[key: string]: unknown;
}

const MAIN_OWNED_PREF_KEYS: Record<string, true> = {
	remoteHosts: true,
	remoteExecutableOverrides: true,
	remoteRecentWorkspaces: true,
};

interface RendererPreferenceStore {
	readonly store: Record<string, unknown>;
	get(key: string): unknown;
	set(key: string, value: unknown): void;
}

export function readRendererPreference(store: RendererPreferenceStore, key?: string): unknown {
	if (key !== undefined) return MAIN_OWNED_PREF_KEYS[key] ? undefined : store.get(key);
	return Object.fromEntries(Object.entries(store.store).filter(([name]) => !MAIN_OWNED_PREF_KEYS[name]));
}

export function writeRendererPreference(store: RendererPreferenceStore, key: string, value: unknown): void {
	if (MAIN_OWNED_PREF_KEYS[key]) throw new Error("Preference key is main-owned");
	store.set(key, value);
}

// ============================================================================
// Workspace filesystem (fs:list / fs:read) — node:fs based, no sidecar session
// required, cross-platform. Rooted at the sidecar's cwd.
// ============================================================================

const FS_LIST_DEFAULT_DEPTH = 8;
const FS_LIST_MAX_DEPTH = 16;
const FS_LIST_DEFAULT_MAX_FILES = 2000;
const FS_LIST_MAX_FILES_CAP = 20_000;
const FS_READ_DEFAULT_MAX_BYTES = 200_000;
const FS_READ_MAX_BYTES_CAP = 2_000_000;

/** Always-skipped names, applied like root .gitignore patterns. */
const FS_IGNORED_DEFAULTS = [
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"out",
	".next",
	"target",
	"build",
	".turbo",
	"coverage",
	"__pycache__",
	".venv",
	"venv",
	".cache",
	".codegraph",
	"bazel-*",
];

interface IgnoreRule {
	negated: boolean;
	dirOnly: boolean;
	regex: RegExp;
}

const REGEX_SPECIALS = "\\^$.|+()[]{}";

/**
 * Compile one gitignore pattern line into a rule. Minimal but faithful to the
 * common semantics: `!` negation, trailing `/` dir-only, any slash anchors the
 * pattern to the root, `*`/`?` match within a segment, `**` crosses segments.
 */
function compileIgnoreRule(rawLine: string): IgnoreRule | null {
	let line = rawLine.trimEnd();
	if (!line || line.startsWith("#")) return null;
	let negated = false;
	if (line.startsWith("!")) {
		negated = true;
		line = line.slice(1);
	} else if (line.startsWith("\\!") || line.startsWith("\\#")) {
		line = line.slice(1);
	}
	let dirOnly = false;
	if (line.endsWith("/")) {
		dirOnly = true;
		line = line.slice(0, -1);
	}
	if (!line) return null;
	const anchored = line.includes("/");
	if (line.startsWith("/")) line = line.slice(1);
	let body = "";
	let i = 0;
	while (i < line.length) {
		const char = line[i];
		if (char === "*") {
			if (line[i + 1] === "*") {
				if (line[i + 2] === "/") {
					body += "(?:[^/]+/)*";
					i += 3;
				} else {
					body += ".*";
					i += 2;
				}
			} else {
				body += "[^/]*";
				i += 1;
			}
		} else if (char === "?") {
			body += "[^/]";
			i += 1;
		} else if (REGEX_SPECIALS.includes(char)) {
			body += `\\${char}`;
			i += 1;
		} else {
			body += char;
			i += 1;
		}
	}
	// A matching directory also ignores everything beneath it.
	const source = anchored ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`;
	return { negated, dirOnly, regex: new RegExp(source) };
}

/** Last matching rule wins, per gitignore semantics. */
function isIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
	let ignored = false;
	for (const rule of rules) {
		if (rule.dirOnly && !isDir) continue;
		if (rule.regex.test(relPath)) ignored = !rule.negated;
	}
	return ignored;
}

async function loadIgnoreRules(rootAbs: string): Promise<IgnoreRule[]> {
	const rules: IgnoreRule[] = [];
	for (const pattern of FS_IGNORED_DEFAULTS) {
		const rule = compileIgnoreRule(pattern);
		if (rule) rules.push(rule);
	}
	try {
		const content = await fsp.readFile(path.join(rootAbs, ".gitignore"), "utf8");
		for (const line of content.split(/\r?\n/)) {
			const rule = compileIgnoreRule(line);
			if (rule) rules.push(rule);
		}
	} catch {
		// No readable root .gitignore — defaults only.
	}
	return rules;
}

/** Resolve `rel` against `root`, refusing escapes outside the workspace. */
function resolveWithin(root: string, rel: string): string | null {
	const resolved = path.resolve(root, rel);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
	return resolved;
}

/** `abs` when it exists and is a regular file, else null. */
async function statFile(abs: string): Promise<string | null> {
	try {
		return (await fsp.stat(abs)).isFile() ? abs : null;
	} catch {
		return null;
	}
}

/**
 * Newest top-level `*plan.md` (case-insensitive) in `dirAbs`, mirroring the
 * agent-side `listPlanFiles` fallback (the agent names its own
 * `local://<slug>-plan.md`, so the configured path alone often misses it).
 */
async function newestPlanFile(dirAbs: string): Promise<string | null> {
	let dirents: Dirent[];
	try {
		dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
	} catch {
		return null;
	}
	let best: { abs: string; mtimeMs: number } | null = null;
	for (const dirent of dirents) {
		if (!dirent.isFile() || !/plan\.md$/i.test(dirent.name)) continue;
		const abs = path.join(dirAbs, dirent.name);
		try {
			const { mtimeMs } = await fsp.stat(abs);
			if (!best || mtimeMs > best.mtimeMs) best = { abs, mtimeMs };
		} catch {
			// Vanished between readdir and stat — skip.
		}
	}
	return best?.abs ?? null;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

interface WalkState {
	rules: IgnoreRule[];
	maxDepth: number;
	maxFiles: number;
	fileCount: number;
	truncated: boolean;
}

/** Recursive readdir → sorted tree (dirs first, then files, each alphabetical). */
async function walkWorkspace(
	dirAbs: string,
	relPrefix: string,
	depth: number,
	state: WalkState,
): Promise<FsTreeEntry[]> {
	let dirents: Dirent[];
	try {
		dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
	} catch {
		return []; // Unreadable directory (permissions) — skip, don't fail the walk.
	}
	const dirs: FsTreeEntry[] = [];
	const files: FsTreeEntry[] = [];
	const sorted = dirents.filter(dirent => !dirent.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name));
	for (const dirent of sorted) {
		if (state.truncated) break;
		const isDir = dirent.isDirectory();
		if (!isDir && !dirent.isFile()) continue;
		const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;
		if (isIgnored(state.rules, rel, isDir)) continue;
		if (isDir) {
			const children =
				depth < state.maxDepth ? await walkWorkspace(path.join(dirAbs, dirent.name), rel, depth + 1, state) : [];
			dirs.push({ name: dirent.name, path: rel, kind: "dir", children });
		} else {
			if (state.fileCount >= state.maxFiles) {
				state.truncated = true;
				break;
			}
			state.fileCount += 1;
			files.push({ name: dirent.name, path: rel, kind: "file" });
		}
	}
	return [...dirs, ...files];
}

async function localWorkspaceList(
	deps: IpcDeps,
	event: Electron.IpcMainInvokeEvent,
	payload: IpcFsListPayload,
): Promise<IpcFsListResult> {
	const rootAbs = cwdFor(deps, event);
	if (!rootAbs) return { ok: false, entries: [], truncated: false, error: "No workspace" };
	const prefix = (typeof payload.path === "string" ? payload.path : "")
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+|\/+$/g, "");
	const dirAbs = resolveWithin(rootAbs, prefix);
	if (!dirAbs) return { ok: false, entries: [], truncated: false, error: "Path escapes the workspace" };
	const state: WalkState = {
		rules: await loadIgnoreRules(rootAbs),
		maxDepth: clampInt(payload.maxDepth, 1, FS_LIST_MAX_DEPTH, FS_LIST_DEFAULT_DEPTH),
		maxFiles: clampInt(payload.maxEntries, 1, FS_LIST_MAX_FILES_CAP, FS_LIST_DEFAULT_MAX_FILES),
		fileCount: 0,
		truncated: false,
	};
	try {
		const stat = await fsp.stat(dirAbs);
		if (!stat.isDirectory()) return { ok: false, entries: [], truncated: false, error: "Not a directory" };
		const entries = await walkWorkspace(dirAbs, prefix, 0, state);
		return { ok: true, entries, truncated: state.truncated };
	} catch (error) {
		return {
			ok: false,
			entries: [],
			truncated: state.truncated,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function localWorkspaceRead(
	deps: IpcDeps,
	event: Electron.IpcMainInvokeEvent,
	payload: IpcFsReadPayload,
): Promise<IpcFsReadResult> {
	const fail = (error: string): IpcFsReadResult => ({
		ok: false,
		content: "",
		truncated: false,
		binary: false,
		size: 0,
		error,
	});
	if (typeof payload.path !== "string" || payload.path.length === 0) return fail("Invalid path");
	// Rendered responses link local files by absolute or ~-relative path; those
	// open in the Files drawer, so they read outside the workspace root.
	const raw = payload.path.startsWith("~/") ? path.join(os.homedir(), payload.path.slice(2)) : payload.path;
	let abs: string;
	if (path.isAbsolute(raw)) abs = path.normalize(raw);
	else {
		const cwd = cwdFor(deps, event);
		if (!cwd) return fail("No workspace");
		const within = resolveWithin(cwd, raw);
		if (!within) return fail("Path escapes the workspace");
		abs = within;
	}
	const maxBytes = clampInt(payload.maxBytes, 1, FS_READ_MAX_BYTES_CAP, FS_READ_DEFAULT_MAX_BYTES);
	try {
		const stat = await fsp.stat(abs);
		if (!stat.isFile()) return fail("Not a file");
		const handle = await fsp.open(abs, "r");
		try {
			const length = Math.min(stat.size, maxBytes + 1);
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, 0);
			const slice = buffer.subarray(0, bytesRead);
			if (slice.includes(0)) return { ok: true, content: "", truncated: false, binary: true, size: stat.size };
			return {
				ok: true,
				content: slice.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8"),
				truncated: stat.size > maxBytes,
				binary: false,
				size: stat.size,
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

async function localWorkspaceReadImage(
	deps: IpcDeps,
	event: Electron.IpcMainInvokeEvent,
	payload: IpcFsReadImagePayload,
): Promise<IpcFsReadImageResult> {
	const fail = (error: string): IpcFsReadImageResult => ({ ok: false, dataUrl: null, mime: null, size: 0, error });
	if (typeof payload.path !== "string" || payload.path.length === 0) return fail("Invalid path");
	const raw = payload.path.startsWith("~/") ? path.join(os.homedir(), payload.path.slice(2)) : payload.path;
	let abs: string;
	if (path.isAbsolute(raw)) {
		abs = path.normalize(raw);
	} else {
		const cwd = cwdFor(deps, event);
		if (!cwd) return fail("No workspace");
		const within = resolveWithin(cwd, raw);
		if (!within) return fail("Path escapes the workspace");
		abs = within;
	}
	try {
		const stat = await fsp.stat(abs);
		if (!stat.isFile()) return fail("Not a file");
		if (stat.size > 25_000_000) return fail("Image too large");
		const handle = await fsp.open(abs, "r");
		try {
			const header = Buffer.alloc(512);
			const { bytesRead } = await handle.read(header, 0, 512, 0);
			const mime = sniffImageMime(header.subarray(0, bytesRead));
			if (!mime) return fail("Not a supported image");
			const body = Buffer.alloc(stat.size);
			await handle.read(body, 0, stat.size, 0);
			return { ok: true, dataUrl: `data:${mime};base64,${body.toString("base64")}`, mime, size: stat.size };
		} finally {
			await handle.close();
		}
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

async function localWorkspaceReadPlan(
	deps: IpcDeps,
	event: Electron.IpcMainInvokeEvent,
	payload: IpcFsReadPlanPayload,
): Promise<IpcFsReadPlanResult> {
	const fail = (error: string): IpcFsReadPlanResult => ({ ok: false, path: null, content: null, error });
	if (typeof payload.fsPath !== "string" || payload.fsPath.length === 0) return fail("Invalid path");
	const cwd = cwdFor(deps, event);
	if (!cwd) return fail("No workspace");
	const withinAllowedRoots = (value: string): string | null =>
		resolveWithin(cwd, value) ?? resolveWithin(deps.sessionIndex.sessionsDir, value);
	const target = withinAllowedRoots(payload.fsPath);
	if (!target) return fail("Path escapes allowed roots");
	let localRoot: string | null = null;
	if (typeof payload.localRoot === "string" && payload.localRoot.length > 0) {
		localRoot = withinAllowedRoots(payload.localRoot);
		if (!localRoot) return fail("Path escapes allowed roots");
	}
	try {
		const picked = (await statFile(target)) ?? (localRoot ? await newestPlanFile(localRoot) : null);
		if (!picked) return { ok: true, path: null, content: null };
		return { ok: true, path: picked, content: await fsp.readFile(picked, "utf8") };
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

interface WorkspaceDispatchContext {
	tab: WorkspaceTabIdentity;
	dispatch: WorkspaceDispatchDeps;
}

function workspaceDispatchContext(
	deps: IpcDeps,
	event: Electron.IpcMainInvokeEvent,
	trust: RemoteWorkspaceTrust,
): WorkspaceDispatchContext | null {
	const win = BrowserWindow.fromWebContents(event.sender);
	if (!win) return null;
	const activeTabId = deps.sidecarPool.activeTabForWindow(win);
	if (!activeTabId) return null;
	const tabInfo = deps.sidecarPool.tabsForWindow(win).find(tab => tab.tabId === activeTabId);
	if (!tabInfo) return null;
	const tab: WorkspaceTabIdentity = { tabId: tabInfo.tabId, target: tabInfo.target };
	const dispatch: WorkspaceDispatchDeps = {
		catalog: deps.remoteHostCatalog,
		lookupTab: tabId => {
			const current = deps.sidecarPool.tabsForWindow(win).find(candidate => candidate.tabId === tabId);
			return current ? { tabId: current.tabId, target: current.target } : null;
		},
		trust,
		local: {
			list: payload => localWorkspaceList(deps, event, payload),
			read: payload => localWorkspaceRead(deps, event, payload),
			readImage: payload => localWorkspaceReadImage(deps, event, payload),
			readPlan: payload => localWorkspaceReadPlan(deps, event, payload),
		},
		remote: deps.remoteSsh,
	};
	return { tab, dispatch };
}

const SUBAGENT_TRANSCRIPT_MAX_BYTES = 25_000_000;

function subagentTranscriptFailure(error: string): IpcSubagentTranscriptReadResult {
	return { ok: false, error };
}

function isPersistedSubagentSessionPath(
	sessionFile: string,
	sessionsRoot: string,
	pathApi: typeof path.posix,
): boolean {
	const root = pathApi.resolve(sessionsRoot);
	const resolved = pathApi.resolve(sessionFile);
	const relative = pathApi.relative(root, resolved);
	if (!relative || relative === ".." || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) {
		return false;
	}
	const segments = relative.split(pathApi.sep).filter(Boolean);
	return segments.length >= 3 && pathApi.extname(resolved) === ".jsonl";
}

export function parsePersistedSubagentMessages(content: string): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (const line of content.split(/\r?\n/)) {
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as unknown;
			if (
				typeof entry !== "object" ||
				entry === null ||
				Array.isArray(entry) ||
				!("type" in entry) ||
				entry.type !== "message" ||
				!("message" in entry) ||
				typeof entry.message !== "object" ||
				entry.message === null ||
				Array.isArray(entry.message)
			) {
				continue;
			}
			messages.push(entry.message as AgentMessage);
		} catch {
			// Ignore a malformed or partially appended JSONL row.
		}
	}
	return messages;
}

async function readPersistedSubagentTranscript(
	deps: IpcDeps,
	context: WorkspaceDispatchContext,
	payload: unknown,
): Promise<IpcSubagentTranscriptReadResult> {
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload) ||
		!("sessionFile" in payload) ||
		typeof payload.sessionFile !== "string" ||
		payload.sessionFile.length === 0 ||
		Buffer.byteLength(payload.sessionFile, "utf8") > REMOTE_PATH_MAX_BYTES
	) {
		return subagentTranscriptFailure("Invalid subagent session file");
	}
	const sessionFile = payload.sessionFile;
	const target = context.tab.target;
	if (target.type === "local") {
		const sessionsRoot = path.join(os.homedir(), ".omp", "agent", "sessions");
		if (!isPersistedSubagentSessionPath(sessionFile, sessionsRoot, path.posix)) {
			return subagentTranscriptFailure("Subagent transcript is outside the local session store");
		}
		try {
			const stat = await fsp.stat(sessionFile);
			if (!stat.isFile()) return subagentTranscriptFailure("Subagent transcript is not a file");
			if (stat.size > SUBAGENT_TRANSCRIPT_MAX_BYTES) {
				return subagentTranscriptFailure("Subagent transcript exceeds the 25 MB limit");
			}
			return { ok: true, messages: parsePersistedSubagentMessages(await fsp.readFile(sessionFile, "utf8")) };
		} catch (error) {
			return subagentTranscriptFailure(error instanceof Error ? error.message : String(error));
		}
	}

	try {
		const resolution = await deps.remoteSsh.resolveRuntime(target);
		if (!resolution.ok) return subagentTranscriptFailure(resolution.error);
		const pathApi = resolution.runtime.platform === "windows" ? path.win32 : path.posix;
		const sessionsRoot = pathApi.join(resolution.runtime.home, ".omp", "agent", "sessions");
		if (!isPersistedSubagentSessionPath(sessionFile, sessionsRoot, pathApi)) {
			return subagentTranscriptFailure("Subagent transcript is outside the remote session store");
		}
		const result = await deps.remoteSsh.readFile(
			target,
			sessionFile,
			[sessionsRoot],
			SUBAGENT_TRANSCRIPT_MAX_BYTES + 1,
		);
		if (!result.ok) return subagentTranscriptFailure(result.error);
		if (result.truncated || result.size > SUBAGENT_TRANSCRIPT_MAX_BYTES) {
			return subagentTranscriptFailure("Subagent transcript exceeds the 25 MB limit");
		}
		try {
			const content = new TextDecoder("utf-8", { fatal: true }).decode(result.data);
			return { ok: true, messages: parsePersistedSubagentMessages(content) };
		} catch {
			return subagentTranscriptFailure("Subagent transcript is not valid UTF-8");
		}
	} catch (error) {
		return subagentTranscriptFailure(error instanceof Error ? error.message : String(error));
	}
}

// Dedupe state for SYSTEM_NOTIFY across multiple windows (see the handler).
let lastNotifyKey = "";
let lastNotifyAt = 0;

// Per-window tray/progress snapshots, aggregated for the app-global tray/dock.
const trayStates = new Map<number, TrayState>();
const progressStates = new Map<number, RunProgressState>();

/** Collapse per-window tray statuses to one: any error > streaming > waiting > idle. */
function aggregateTrayStatus(states: TrayState[]): TrayState["status"] {
	if (states.some(s => s.status === "error")) return "error";
	if (states.some(s => s.status === "streaming")) return "streaming";
	if (states.some(s => s.status === "waiting")) return "waiting";
	return "idle";
}

/** Collapse per-window run-progress to one: any working > waiting > idle. */
function aggregateProgress(states: RunProgressState[]): RunProgressState {
	if (states.some(s => s === "working")) return "working";
	if (states.some(s => s === "waiting")) return "waiting";
	return "idle";
}

export function registerIpcHandlers(deps: IpcDeps): void {
	const { sidecarPool, sessionIndex, statsClient, logWatcher, windowManager } = deps;
	const prefsStore = new Store<PrefsSchema>({ name: "prefs" });
	const remoteWorkspaceTrust = new RemoteWorkspaceTrust();
	const remoteRequests = new RemoteRequestRegistry();
	const remoteResumeGrants = new RemoteResumeGrantRegistry();
	const remoteDispatchDeps = {
		catalog: deps.remoteHostCatalog,
		lookupTab: (_tabId: string) => null,
		ssh: deps.remoteSsh,
		acp: deps.remoteAcp,
	};
	const refreshCatalogForWindow = async (event: Electron.IpcMainInvokeEvent): Promise<void> => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return;
		const cwd = localProjectCwdForWindow(deps, win);
		if (!cwd) return;
		const command: LocalSshSettingsCommand = { type: "get_ssh_hosts" };
		const response = await deps.localSshSettings.execute(cwd, command);
		observeRemoteCatalogRpcResponse(deps.remoteHostCatalog, { type: "local" }, command, response);
	};
	const remoteDispatchDepsFor = (event: Electron.IpcMainInvokeEvent) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		return {
			...remoteDispatchDeps,
			lookupTab: (tabId: string): WorkspaceTabIdentity | null => {
				if (!win) return null;
				const owned = sidecarPool.tabsForWindow(win).find(tab => tab.tabId === tabId);
				return owned ? { tabId: owned.tabId, target: owned.target } : null;
			},
		};
	};
	const runRemoteRequest = async <Result>(
		event: Electron.IpcMainInvokeEvent,
		payload: unknown,
		failure: Result,
		operation: (signal: AbortSignal) => Promise<Result>,
	): Promise<Result> => {
		const requestId =
			typeof payload === "object" && payload !== null && !Array.isArray(payload)
				? Reflect.get(payload, "requestId")
				: undefined;
		if (typeof requestId !== "string") return failure;
		const controller = remoteRequests.start(event.sender.id, requestId);
		if (!controller) return failure;
		try {
			return await operation(controller.signal);
		} finally {
			remoteRequests.finish(event.sender.id, requestId, controller);
		}
	};

	// Drop a closed window's tray/progress snapshot so the aggregate reflects
	// only live windows (and re-render the tray with the new aggregate).
	windowManager.onWindowClosed = record => {
		for (const tab of sidecarPool.tabsForWindow(record.win)) remoteWorkspaceTrust.release(tab.tabId);
		remoteRequests.cancelOwner(record.id);
		remoteResumeGrants.clearOwner(record.id);
		trayStates.delete(record.id);
		progressStates.delete(record.id);
	};

	// Sidecar → owning-window event forwarding (events/status/extensionUi/
	// hostUriRequest/subagentFrame/commandsUpdate/configUpdate) is wired by
	// SidecarPool at acquire time. hostToolCall needs the main-process executor,
	// so the pool routes it through this callback (set once at startup). The
	// boolean tells the pool whether the tool was answered inline; only
	// renderer-forwarded calls get request-id → origin tracking (F-UI-ORIGIN).
	sidecarPool.hostToolExecutor = (sidecar, request, win) => {
		const result = executeGuiHostTool(request.toolName, request.arguments);
		if (result !== undefined) {
			sidecar.sendSideChannel({ type: "host_tool_result", id: request.id, result });
			return true;
		}
		// Unknown host tools → forward to the owning renderer.
		if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.HOST_TOOL_CALL, { request });
		return false;
	};

	// Session index changes
	sessionIndex.onChange = () => {
		broadcast(windowManager, IPC_EVENTS.SESSIONS_CHANGED, undefined);
	};

	// Log lines (batched by LogWatcher)
	logWatcher.onLines = lines => {
		broadcast(windowManager, IPC_EVENTS.LOG_LINE, lines);
	};

	// ========================================================================
	// IPC Command Handlers
	// ========================================================================
	ipcMain.on(IPC_COMMANDS.RUNTIME_ERROR_REPORT, (event, report: unknown) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		writeRuntimeLog(report, {
			windowId: win?.webContents.id,
			cwd: win ? windowManager.recordFor(win)?.cwd : undefined,
		});
	});

	ipcMain.handle(IPC_COMMANDS.RUNTIME_LOG_PATH, () => runtimeLogPath());

	ipcMain.handle(IPC_COMMANDS.REMOTE_CATALOG, (event, payload: unknown) =>
		dispatchRemoteCatalog({ ...remoteDispatchDeps, refreshCatalog: () => refreshCatalogForWindow(event) }, payload),
	);
	ipcMain.handle(IPC_COMMANDS.REMOTE_SET_EXECUTABLE_OVERRIDE, (_event, payload: unknown) =>
		dispatchRemoteOverride(remoteDispatchDeps, payload),
	);
	ipcMain.handle(IPC_COMMANDS.REMOTE_CANCEL_REQUEST, (event, payload: unknown) => {
		if (
			typeof payload !== "object" ||
			payload === null ||
			Array.isArray(payload) ||
			Object.keys(payload).length !== 1
		) {
			return false;
		}
		const { requestId } = payload as Partial<IpcRemoteCancelRequestPayload>;
		return remoteRequests.cancel(event.sender.id, requestId);
	});
	ipcMain.handle(IPC_COMMANDS.REMOTE_PREFLIGHT, (event, payload: unknown) =>
		runRemoteRequest(event, payload, { ok: false, error: "Invalid or duplicate remote request" }, signal =>
			dispatchRemotePreflight(remoteDispatchDepsFor(event), payload, signal),
		),
	);
	ipcMain.handle(IPC_COMMANDS.REMOTE_LIST_DIRECTORIES, (event, payload: unknown) =>
		runRemoteRequest(event, payload, { ok: false, error: "Invalid or duplicate remote request" }, signal =>
			dispatchRemoteListDirectories(remoteDispatchDepsFor(event), payload, signal),
		),
	);
	ipcMain.handle(IPC_COMMANDS.REMOTE_VALIDATE_DIRECTORY, (event, payload: unknown) =>
		runRemoteRequest(event, payload, { ok: false, error: "Invalid or duplicate remote request" }, signal =>
			dispatchRemoteValidateDirectory(remoteDispatchDepsFor(event), payload, signal),
		),
	);
	ipcMain.handle(IPC_COMMANDS.REMOTE_NOTE_WORKSPACE, (_event, payload: unknown) =>
		dispatchRemoteNoteWorkspace(remoteDispatchDeps, payload),
	);
	ipcMain.handle(IPC_COMMANDS.REMOTE_LIST_HISTORY, (event, payload: unknown) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return { ok: false, error: "Unknown window" };
		return dispatchRemoteHistory(remoteDispatchDeps, payload, (target, cwd, sessionId) => {
			remoteResumeGrants.record(win.webContents.id, target, cwd, sessionId);
		});
	});

	// RPC command passthrough — always returns a response, never throws.
	// Throwing here causes "Error occurred in handler" console spam AND
	// Tray/dock are app-global OS surfaces; with N parallel windows each pushing
	// its own state, aggregate per-window instead of last-write-wins (which made
	// the indicator flap with push order) or focus-gating (which let it go
	// stale). Status aggregates across windows: any error > streaming > waiting
	// > idle; the displayed blob is the most recently pushed one, with its
	// status replaced by the aggregate.
	ipcMain.on(IPC_EVENTS.TRAY_STATE_PUSH, (event, state: TrayState) => {
		const winId = BrowserWindow.fromWebContents(event.sender)?.webContents.id;
		if (winId === undefined) return;
		trayStates.set(winId, state);
		const aggregate = aggregateTrayStatus([...trayStates.values()]);
		setTrayState({ ...state, status: aggregate });
	});

	// Run-progress (terminal.showProgress): aggregate per-window the same way —
	// any window working → working, else any waiting → waiting, else idle.
	ipcMain.on(IPC_EVENTS.PROGRESS_SET, (event, state: RunProgressState) => {
		const winId = BrowserWindow.fromWebContents(event.sender)?.webContents.id;
		if (winId === undefined) return;
		progressStates.set(winId, state);
		windowManager.setRunProgress(aggregateProgress([...progressStates.values()]));
	});

	ipcMain.handle(IPC_COMMANDS.RPC_COMMAND, async (event, payload: IpcRpcCommandPayload) => {
		const incomingCommand: unknown = payload.command;
		if (isLocalSshSettingsCommandType(incomingCommand)) {
			if (!isLocalSshSettingsCommand(incomingCommand)) {
				return {
					id: "id" in incomingCommand && typeof incomingCommand.id === "string" ? incomingCommand.id : undefined,
					type: "response",
					command: incomingCommand.type,
					success: false,
					error: "Invalid local SSH settings command",
				};
			}
			const command = incomingCommand;
			const win = BrowserWindow.fromWebContents(event.sender);
			const cwd = win ? localProjectCwdForWindow(deps, win) : null;
			if (!cwd) {
				return {
					id: command.id,
					type: "response",
					command: command.type,
					success: false,
					error: "Local project is unavailable",
				};
			}
			try {
				const response = await deps.localSshSettings.execute(cwd, command);
				observeRemoteCatalogRpcResponse(deps.remoteHostCatalog, { type: "local" }, command, response);
				return response;
			} catch (err) {
				return {
					id: command.id,
					type: "response",
					command: command.type,
					success: false,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
		const win = BrowserWindow.fromWebContents(event.sender);
		const sidecar = win ? sidecarPool.sidecarForWindow(win) : null;
		const client = sidecar?.rpcClient;
		if (!client || !sidecar) {
			return { id: payload.command.id, type: "response", success: false, error: "Sidecar not connected" };
		}
		if (sidecar.status !== "ready") {
			return {
				id: payload.command.id,
				type: "response",
				success: false,
				error: `Sidecar not ready (${sidecar.status})`,
			};
		}
		const { id: _id, ...cmd } = payload.command;
		// F-OWN: pin the issuing tab NOW — the ownership note below must register
		// against the tab that sent the command even if the user switches tabs
		// while it is in flight.
		const issuerTabId = win ? sidecarPool.activeTabForWindow(win) : null;
		const issuerTabInfo =
			win && issuerTabId ? sidecarPool.tabsForWindow(win).find(tab => tab.tabId === issuerTabId) : undefined;
		const issuerTab: WorkspaceTabIdentity | null = issuerTabInfo
			? { tabId: issuerTabInfo.tabId, target: issuerTabInfo.target }
			: null;
		// F-OWN refuse-or-focus backstop: a switch_session onto a file a
		// DIFFERENT tab owns would double-attach it (the owner itself re-attaches
		// freely). Refuse BEFORE dispatch — the sidecar would attach for real
		// and silently diverge the owner's file. The renderer pre-check routes
		// to the owner; this catches the race.
		if (cmd.type === "switch_session") {
			const blocker = sidecarPool.foreignSessionOwner(issuerTabId, cmd.sessionPath);
			if (blocker) {
				return {
					id: _id,
					type: "response",
					command: "switch_session",
					success: false,
					error: "Session is already open in another tab",
					code: "session_owned_elsewhere",
					data: { ownerTabId: blocker.tabId, ownerWinId: blocker.winId },
				};
			}
		}
		try {
			const response = await client.command({ ...cmd, id: _id } as RpcCommand, payload.timeoutMs);
			observeRemoteCatalogRpcResponse(deps.remoteHostCatalog, issuerTab?.target ?? null, cmd, response);
			if (response.success && issuerTab) remoteWorkspaceTrust.observeRpcSuccess(issuerTab, cmd, response.data);
			// F-OWN registration points carried by this passthrough: a successful
			// switch_session attaches the issuer to that file; get_state is how
			// the renderer's attach/hydrate reports the file (session_info_update
			// itself carries only the session id, never the path).
			if (issuerTabId && response.success) {
				if (cmd.type === "switch_session") {
					const cancelled = (response.data as { cancelled?: boolean } | undefined)?.cancelled ?? false;
					if (!cancelled) sidecarPool.noteSessionFile(issuerTabId, cmd.sessionPath);
				} else if (cmd.type === "get_state") {
					const state = response.data as RpcSessionState | undefined;
					sidecarPool.noteSessionFile(issuerTabId, state?.sessionFile ?? null);
					// switch_session re-roots the agent with no main-observable
					// event; get_state (run by every hydrate) carries the live
					// cwd. Adopt it so the tab chip tracks the session, and sync
					// the window record (menu "New Window" reads cwd from it) —
					// the same tail as a project switch, minus the respawn.
					if (state?.cwd && win && sidecarPool.adoptSessionCwd(issuerTabId, state.cwd)) {
						windowManager.setRecordCwd(win, state.cwd);
					}
				}
			}
			return response;
		} catch (err) {
			return { id: _id, type: "response", success: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// RPC addressed at a SPECIFIC tab's sidecar — background-tab flows (the
	// worktree close prompt) must not route through the window's active tab.
	// No F-OWN bookkeeping here: the callers query/remove worktrees, never
	// switch sessions.
	ipcMain.handle(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, async (event, payload: IpcRpcCommandForTabPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return { id: payload?.command?.id, type: "response", success: false, error: "No window" };
		const sidecar = sidecarPool.sidecarForTab(win, payload.tabId);
		if (!sidecar) {
			return { id: payload.command.id, type: "response", success: false, error: "Unknown tab" };
		}
		if (sidecar.status !== "ready") {
			return {
				id: payload.command.id,
				type: "response",
				success: false,
				error: `Sidecar not ready (${sidecar.status})`,
			};
		}
		const client = sidecar.rpcClient;
		if (!client) return { id: payload.command.id, type: "response", success: false, error: "No RPC client" };
		const { id: _id, ...cmd } = payload.command;
		try {
			return await client.command({ ...cmd, id: _id } as RpcCommand, payload.timeoutMs);
		} catch (err) {
			return { id: _id, type: "response", success: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	const routeRendererSideChannel = (
		event: Electron.IpcMainInvokeEvent,
		frame: unknown,
		expectedType: string,
		final: boolean,
	): void => {
		if (
			typeof frame !== "object" ||
			frame === null ||
			Array.isArray(frame) ||
			Reflect.get(frame, "type") !== expectedType
		) {
			return;
		}
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return;
		const route = sidecarPool.routeSideChannel(win, Reflect.get(frame, "id"), frame, final);
		if (route !== "unknown") return;
		// Compatibility for responses to requests raised before ownership
		// tracking existed: only a structurally valid frame with a bounded,
		// genuinely unknown id from this window may use its active sidecar.
		sidecarPool.sidecarForWindow(win)?.sendSideChannel(frame);
	};

	// Renderer side-channel responses are authorized by exact caller window +
	// live request id. Foreign/invalid authority is rejected, never confused
	// with the narrow same-window fallback for genuinely unknown ids.
	ipcMain.handle(IPC_COMMANDS.EXTENSION_UI_RESPOND, (event, payload: IpcExtensionUiRespondPayload) => {
		const response = payload?.response;
		routeRendererSideChannel(event, response, "extension_ui_response", true);
	});

	ipcMain.handle(IPC_COMMANDS.HOST_TOOL_RESULT, (event, payload: IpcHostToolResultPayload) => {
		const result = payload?.result;
		routeRendererSideChannel(event, result, "host_tool_result", true);
	});

	// Updates retain ownership so the final host-tool result can follow.
	ipcMain.handle(IPC_COMMANDS.HOST_TOOL_UPDATE, (event, payload: IpcHostToolUpdatePayload) => {
		const update = payload?.update;
		routeRendererSideChannel(event, update, "host_tool_update", false);
	});

	ipcMain.handle(IPC_COMMANDS.HOST_URI_RESULT, (event, payload: IpcHostUriResultPayload) => {
		const result = payload?.result;
		routeRendererSideChannel(event, result, "host_uri_result", true);
	});

	// Sessions
	ipcMain.handle(IPC_COMMANDS.SESSIONS_LIST, async (event, payload: IpcSessionsListPayload) => {
		const scope = payload.scope === "local" ? "local" : "global";
		return sessionIndex.list(scope, cwdFor(deps, event) ?? undefined);
	});

	ipcMain.handle(IPC_COMMANDS.SESSIONS_DELETE, async (_event, payload: IpcSessionsDeletePayload) => {
		if (typeof payload.sessionPath !== "string" || !payload.sessionPath.endsWith(".jsonl")) {
			throw new Error("Invalid session path");
		}
		const owner = sidecarPool.sessionOwner(payload.sessionPath);
		if (owner) {
			const response = await sidecarPool.commandForIdleSession(payload.sessionPath, { type: "drop_session" });
			if (!response) throw new Error("Session is currently running");
			if (!response.success) throw new Error(response.error);
			const cancelled = (response.data as { cancelled?: boolean } | undefined)?.cancelled ?? false;
			if (cancelled) throw new Error("Session deletion was cancelled");
			return;
		}
		return sessionIndex.deleteSession(payload.sessionPath);
	});

	ipcMain.handle(IPC_COMMANDS.SESSIONS_RENAME, async (event, payload: IpcSessionsRenamePayload) => {
		if (typeof payload.sessionPath !== "string" || !payload.sessionPath.endsWith(".jsonl")) {
			throw new Error("Invalid session path");
		}
		const name = typeof payload.name === "string" ? payload.name.trim() : "";
		if (!name) throw new Error("Session name cannot be empty");
		const command: RpcCommand = { type: "set_session_name", name, sessionPath: payload.sessionPath };
		const owner = sidecarPool.sessionOwner(payload.sessionPath);
		let response = owner ? await sidecarPool.commandForIdleSession(payload.sessionPath, command) : null;
		if (!owner) {
			const caller = sidecarFor(deps, event);
			if (caller?.status === "ready" && caller.rpcClient) response = await caller.rpcClient.command(command);
		}
		if (!response) throw new Error(owner ? "Session is currently running" : "Sidecar not connected");
		if (!response.success) throw new Error(response.error);
	});

	// Open a session (or a fresh project window) in a NEW parallel window with
	// its own sidecar. The calling window's sidecar is left running untouched —
	// this is the explicit parallel action. Returns false at the pool cap.
	// F-OWN: when the session is already attached to a tab, focus the owner
	// window (win.show()+win.focus() — the codebase's focus pattern, see
	// deep-link.ts/tray.ts) instead of spawning a second sidecar for the same
	// file; resolves true because the session ends up foregrounded either way.
	// The session switch is done by the NEW window's renderer on boot (it pulls
	// pendingSessionPath and runs switch_session + hydrate itself), which avoids
	// racing the renderer's boot hydration and surfaces failures in that window.
	ipcMain.handle(IPC_COMMANDS.SESSION_OPEN_NEW_WINDOW, async (event, payload: unknown) => {
		const caller = BrowserWindow.fromWebContents(event.sender);
		const callerCwd = cwdFor(deps, event) ?? process.cwd();
		const request = resolveNewWindowRequest(
			deps.remoteHostCatalog,
			payload,
			callerCwd,
			(target, cwd, sessionId) =>
				caller !== null && remoteResumeGrants.allows(caller.webContents.id, target, cwd, sessionId),
		);
		if (!request.ok) return false;
		if (request.target.type === "ssh") {
			if (deps.sidecarPool.atCap) return false;
			const authorized = await authorizeRemoteTargetAtSink(
				remoteDispatchDeps,
				{ target: request.target, cwd: request.cwd },
				(target: SshSessionTarget) => {
					if (
						request.resumeSessionId !== undefined &&
						(!caller ||
							!remoteResumeGrants.allows(caller.webContents.id, target, target.cwd, request.resumeSessionId))
					) {
						return false;
					}
					return deps.spawnWindow(request.cwd, undefined, undefined, target, request.resumeSessionId) !== null;
				},
			);
			return authorized.ok ? authorized.value : false;
		}
		if (request.sessionPath) {
			const owner = deps.sidecarPool.sessionOwner(request.sessionPath);
			if (owner && deps.windowManager.focusWindowById(owner.winId)) return true;
		}
		if (deps.sidecarPool.atCap) return false;
		const kind = request.sessionPath ? await sessionIndex.kindFor(request.sessionPath) : undefined;
		return deps.spawnWindow(request.cwd, request.sessionPath, kind, request.target, request.resumeSessionId) !== null;
	});

	// Fresh window pulls the session it was opened to display (one-shot). The
	// renderer performs the actual switch_session + hydrate on boot, which
	// avoids racing the boot hydration and surfaces failures in that window.
	ipcMain.handle(IPC_COMMANDS.SESSION_CONSUME_PENDING, event => {
		const win = BrowserWindow.fromWebContents(event.sender);
		return win ? (deps.windowManager.consumePendingSession(win) ?? null) : null;
	});

	ipcMain.handle(
		IPC_COMMANDS.SESSION_READ_SUBAGENT_TRANSCRIPT,
		async (event, payload: IpcSubagentTranscriptReadPayload): Promise<IpcSubagentTranscriptReadResult> => {
			const context = workspaceDispatchContext(deps, event, remoteWorkspaceTrust);
			if (!context) return subagentTranscriptFailure("No active session tab");
			return readPersistedSubagentTranscript(deps, context, payload);
		},
	);

	// ========================================================================
	// Session tabs — in-window parallel sessions. Each tab owns a pooled
	// sidecar bound to the CALLING window (no new BrowserWindow); the pool
	// moves full event forwarding to the window's active tab. Routing derives
	// from event.sender, so a renderer can only touch its own window's tabs.
	// ========================================================================

	// Spawn a background tab. Null at the pool cap; the renderer decides
	// whether to activate it (SET_ACTIVE_TAB) — spawn itself never switches.
	// F-OWN: a sessionPath already attached to a tab returns
	// { tabId: null, ownerTabId, ownerWinId, refusal: "owned" } — the renderer
	// switches to (or focuses) the owner instead of double-attaching the file.
	// F-KIND: an explicit payload kind that disagrees with the file's stamped
	// kind returns { tabId: null, refusal: "kind-mismatch" } (I3); an omitted
	// payload kind defers to the file. Decision logic lives in tab-spawn.ts so
	// both refusal contracts are unit-testable without an Electron runtime.
	ipcMain.handle(IPC_COMMANDS.SPAWN_TAB, async (event, payload: IpcSpawnTabPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return null;
		return spawnTabForWindow(
			{
				sidecarPool: deps.sidecarPool,
				sessionIndex,
				fallbackCwd: () => cwdFor(deps, event) ?? process.cwd(),
				defaultWorkspace: ensureDefaultWorkspace,
				authorizeRemoteTarget: (
					target: SshSessionTarget,
					cwd: unknown,
					sink: (target: SshSessionTarget) => IpcSpawnTabResult | null,
				) => {
					const result = authorizeRemoteSpawnTargetAtSink(remoteDispatchDeps, { target, cwd }, sink);
					return result.ok ? result.value : null;
				},
				authorizeRemoteResume: (target, cwd, sessionId) =>
					remoteResumeGrants.allows(win.webContents.id, target, cwd, sessionId),
			},
			win,
			payload,
		);
	});

	// Release a tab's sidecar. The window falls back to its initial no-tab
	// state when its last tab closes (welcome screen; handlers tolerate null).
	ipcMain.handle(IPC_COMMANDS.CLOSE_TAB, (event, payload: IpcCloseTabPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || typeof payload?.tabId !== "string") return false;
		if (!deps.sidecarPool.sidecarForTab(win, payload.tabId)) return false;
		const released = deps.sidecarPool.releaseTab(payload.tabId);
		if (released) remoteWorkspaceTrust.release(payload.tabId);
		return released;
	});

	// Move full event forwarding to the window's active tab (listeners move,
	// never duplicate). The renderer calls this before hydrateSession().
	ipcMain.handle(IPC_COMMANDS.SET_ACTIVE_TAB, (event, payload: IpcSetActiveTabPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win || typeof payload?.tabId !== "string") return false;
		return deps.sidecarPool.setActiveTab(win, payload.tabId);
	});

	// Boot reconciliation: the window's tabs in acquisition order (the initial
	// sidecar is tab 0 — main minted its tabId at acquire).
	ipcMain.handle(IPC_COMMANDS.GET_TABS, event => {
		const win = BrowserWindow.fromWebContents(event.sender);
		return win ? deps.sidecarPool.tabsForWindow(win) : [];
	});

	// F-OWN: which tab/window owns a session file, if any. The renderer
	// belt-guards (open tab / open-in-new-window rows) consult this before
	// attempting an attach.
	ipcMain.handle(IPC_COMMANDS.GET_SESSION_OWNER, (_event, payload: IpcGetSessionOwnerPayload) => {
		return typeof payload?.sessionPath === "string" ? deps.sidecarPool.sessionOwner(payload.sessionPath) : null;
	});

	// Full-content search over session files (raw JSONL grep in main, scoped to
	// the same candidate set the list view would show).
	ipcMain.handle(IPC_COMMANDS.SESSIONS_SEARCH, async (event, payload: IpcSessionsSearchPayload) => {
		const scope = payload.scope === "local" ? "local" : "global";
		const query = typeof payload.query === "string" ? payload.query : "";
		const candidates = await sessionIndex.list(scope, cwdFor(deps, event) ?? undefined);
		return sessionIndex.searchContent(
			query,
			candidates.map(info => info.path),
		);
	});

	// Stats
	ipcMain.handle(IPC_COMMANDS.STATS_FETCH, async (_event, payload: IpcStatsFetchPayload) => {
		if (typeof payload.path !== "string") {
			throw new Error("Invalid stats path");
		}
		try {
			return await statsClient.fetch(payload.path, payload.params);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { error: msg, unavailable: true };
		}
	});

	// System
	ipcMain.handle(IPC_COMMANDS.SYSTEM_OPEN_EXTERNAL, async (_event, url: string) => {
		if (typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"))) {
			await shell.openExternal(url);
		}
	});

	// Tool-card path links — open a file in the system editor. "~" expands,
	// relative paths resolve inside the calling window's workspace (escapes
	// refused), absolute paths pass through: the agent can legitimately touch
	// files outside the workspace. When no editor association exists, reveal
	// the file in the file manager instead of failing.
	ipcMain.handle(IPC_COMMANDS.SYSTEM_OPEN_PATH, async (event, target: string): Promise<IpcOpenPathResult> => {
		if (typeof target !== "string" || !target.trim()) return { ok: false, error: "Empty path" };
		let resolved = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
		if (!path.isAbsolute(resolved)) {
			const rootAbs = cwdFor(deps, event);
			if (!rootAbs) return { ok: false, error: "No workspace" };
			const within = resolveWithin(rootAbs, resolved);
			if (!within) return { ok: false, error: "Path escapes the workspace" };
			resolved = within;
		}
		// A stale tool card can reference a file that no longer exists (or never
		// did outside the workspace). Both openPath and showItemInFolder fail
		// silently on missing paths, so detect it here and let the link toast.
		try {
			await fsp.access(resolved);
		} catch {
			return { ok: false, error: "File not found" };
		}
		const openError = await shell.openPath(resolved);
		if (!openError) return { ok: true, resolvedPath: resolved };
		shell.showItemInFolder(resolved);
		return { ok: true, resolvedPath: resolved };
	});

	ipcMain.handle(IPC_COMMANDS.SYSTEM_SAVE_DIALOG, async (event, defaultPath?: string) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return null;
		const result = await dialog.showSaveDialog(win, {
			defaultPath: defaultPath ?? "session.html",
			filters: [{ name: "HTML", extensions: ["html"] }],
		});
		return result.canceled ? null : (result.filePath ?? null);
	});

	ipcMain.handle(
		IPC_COMMANDS.SYSTEM_OPEN_DIALOG,
		async (event, filters?: { name: string; extensions: string[] }[], options?: { directory?: boolean }) => {
			const win = BrowserWindow.fromWebContents(event.sender);
			if (!win) return null;
			const result = await dialog.showOpenDialog(win, {
				properties: options?.directory ? ["openDirectory", "createDirectory"] : ["openFile", "multiSelections"],
				filters: filters ?? [],
			});
			return result.canceled ? null : result.filePaths;
		},
	);

	ipcMain.handle(IPC_COMMANDS.SYSTEM_CLIPBOARD_READ, () => {
		return clipboard.readText();
	});

	ipcMain.handle(IPC_COMMANDS.SYSTEM_NOTIFY, (event, payload: IpcNotifyPayload) => {
		if (typeof payload.title === "string") {
			// Dedupe within a window (a turn can emit the same notification from
			// several renderers), but NOT across windows — two parallel sessions
			// finishing in different windows are distinct events the user wants.
			const winId = BrowserWindow.fromWebContents(event.sender)?.webContents.id ?? 0;
			const key = `${winId}${payload.title}${payload.body ?? ""}`;
			const now = Date.now();
			if (key === lastNotifyKey && now - lastNotifyAt < 1500) return;
			lastNotifyKey = key;
			lastNotifyAt = now;
			new Notification({ title: payload.title, body: payload.body ?? "" }).show();
		}
	});

	// Preferences
	ipcMain.handle(IPC_COMMANDS.PREFS_GET, (_event, payload: IpcPrefsGetPayload) =>
		readRendererPreference(prefsStore, payload.key),
	);

	ipcMain.handle(IPC_COMMANDS.PREFS_SET, (_event, payload: IpcPrefsSetPayload) => {
		if (typeof payload.key !== "string") {
			throw new Error("Invalid preference key");
		}
		writeRendererPreference(prefsStore, payload.key, payload.value);
		if (payload.key === "language" && (payload.value === "en" || payload.value === "zh")) {
			createMenu(windowManager, deps.spawnWindow);
		}
	});

	// Sidecar control
	ipcMain.handle(IPC_COMMANDS.SIDECAR_RESTART, (event, payload?: IpcSidecarRestartPayload) => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) throw new Error("No window");
		const sidecar =
			typeof payload?.tabId === "string"
				? sidecarPool.sidecarForTab(win, payload.tabId)
				: sidecarPool.sidecarForWindow(win);
		if (!sidecar) throw new Error("Unknown tab");
		const sessionPath =
			typeof payload?.sessionPath === "string" && payload.sessionPath ? payload.sessionPath : undefined;
		sidecar.restart(undefined, sessionPath);
	});

	ipcMain.handle(IPC_COMMANDS.SIDECAR_SELECT_PROJECT, async event => {
		const context = localProjectContextFor(deps, event);
		if (!context) return null;
		const { sidecar, win } = context;
		const result = await dialog.showOpenDialog(win, {
			title: mainT("dialog.openProject"),
			defaultPath: sidecar.cwd,
			properties: ["openDirectory", "createDirectory"],
		});
		if (result.canceled || !result.filePaths[0]) return null;

		const cwd = result.filePaths[0];
		prefsStore.set("lastProject", cwd);
		// Per-window project switch: restart only this window's sidecar and keep
		// the window record in sync (menu "New Window" reads cwd from it).
		windowManager.setRecordCwd(win, cwd);
		sidecar.restart(cwd);
		return cwd;
	});

	// Switch to a KNOWN workspace directory (no native picker): used by the
	// workspace manager to jump to a recent project. Validates the directory
	// exists, then restarts the sidecar there (same tail as select-project).
	ipcMain.handle(IPC_COMMANDS.SIDECAR_SET_PROJECT, async (event, payload: { cwd?: string }) => {
		const cwd = payload?.cwd;
		if (typeof cwd !== "string" || cwd.length === 0) return false;
		const context = localProjectContextFor(deps, event);
		if (!context) return false;
		const { sidecar, win } = context;
		try {
			if (!(await fsp.stat(cwd)).isDirectory()) return false;
		} catch {
			return false;
		}
		prefsStore.set("lastProject", cwd);
		windowManager.setRecordCwd(win, cwd);
		sidecar.restart(cwd);
		return true;
	});

	ipcMain.handle(IPC_COMMANDS.SIDECAR_DEFAULT_WORKSPACE, () => ensureDefaultWorkspace());

	ipcMain.handle(IPC_COMMANDS.MODELS_PROVIDERS_LIST, () => {
		return listModelsProviders();
	});

	ipcMain.handle(IPC_COMMANDS.MODELS_PROVIDER_UPSERT, (_event, input: CustomProviderInput) => {
		upsertModelsProvider(input);
	});

	ipcMain.handle(IPC_COMMANDS.MODELS_PROVIDER_DELETE, (_event, id: string) => {
		deleteModelsProvider(id);
	});

	// "Edit config" — open the agent's models.yml in the system editor. The
	// file is created with a minimal skeleton when missing so there is always
	// something to edit; when no editor association exists, reveal it in the
	// file manager instead.
	ipcMain.handle(IPC_COMMANDS.MODELS_CONFIG_OPEN, async () => {
		const file = modelsPath();
		if (!existsSync(file)) {
			await fsp.mkdir(path.dirname(file), { recursive: true });
			await fsp.writeFile(file, "# Custom model providers.\nproviders: {}\n", "utf8");
		}
		const openError = await shell.openPath(file);
		if (openError) shell.showItemInFolder(file);
		return { path: file, opened: !openError };
	});

	// Workspace filesystem dispatches from the calling window's active immutable
	// tab target. Local tabs keep node:fs behavior; SSH failures stay remote.
	ipcMain.handle(IPC_COMMANDS.FS_LIST, async (event, payload: unknown): Promise<IpcFsListResult> => {
		const context = workspaceDispatchContext(deps, event, remoteWorkspaceTrust);
		if (!context) return { ok: false, entries: [], truncated: false, error: "No workspace" };
		return dispatchWorkspaceList(context.dispatch, context.tab, payload);
	});

	ipcMain.handle(IPC_COMMANDS.FS_READ, async (event, payload: unknown): Promise<IpcFsReadResult> => {
		const context = workspaceDispatchContext(deps, event, remoteWorkspaceTrust);
		if (!context) {
			return { ok: false, content: "", truncated: false, binary: false, size: 0, error: "No workspace" };
		}
		return dispatchWorkspaceRead(context.dispatch, context.tab, payload);
	});

	ipcMain.handle(IPC_COMMANDS.FS_READ_IMAGE, async (event, payload: unknown): Promise<IpcFsReadImageResult> => {
		const context = workspaceDispatchContext(deps, event, remoteWorkspaceTrust);
		if (!context) return { ok: false, dataUrl: null, mime: null, size: 0, error: "No workspace" };
		return dispatchWorkspaceReadImage(context.dispatch, context.tab, payload);
	});

	ipcMain.handle(IPC_COMMANDS.FS_READ_PLAN, async (event, payload: unknown): Promise<IpcFsReadPlanResult> => {
		const context = workspaceDispatchContext(deps, event, remoteWorkspaceTrust);
		if (!context) return { ok: false, path: null, content: null, error: "No workspace" };
		return dispatchWorkspaceReadPlan(context.dispatch, context.tab, payload);
	});
	ipcMain.handle(IPC_COMMANDS.SIDECAR_STATUS_GET, event => {
		const sidecar = sidecarFor(deps, event);
		return { status: sidecar?.status ?? "starting", cwd: cwdFor(deps, event) ?? "" };
	});

	// External-editor round trip ($VISUAL/$EDITOR, temp file, exit-0 read-back)
	// for the composer editor dialog. Result shape carries availability +
	// cancellation so the renderer never has to catch.
	ipcMain.handle(IPC_COMMANDS.EDITOR_OPEN_EXTERNAL, async (_event, payload: { content?: string }) => {
		if (!(await resolveEditorCommand())) {
			return {
				ok: false,
				unavailable: true as const,
				text: null,
				error: "Set $VISUAL or $EDITOR to use an external editor",
			};
		}
		try {
			const { text } = await openInExternalEditor(typeof payload?.content === "string" ? payload.content : "");
			return { ok: true, unavailable: false as const, text };
		} catch (err) {
			return {
				ok: false,
				unavailable: false as const,
				text: null,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});
}

function broadcast(windowManager: WindowManager, channel: string, data: unknown): void {
	for (const win of windowManager.getAllWindows()) {
		if (!win.isDestroyed()) {
			win.webContents.send(channel, data);
		}
	}
}

/** Execute GUI-registered host tools. Returns undefined for unknown tools. */
function executeGuiHostTool(name: string, args: Record<string, unknown>): string | undefined {
	switch (name) {
		case "gui_open_url": {
			const url = typeof args.url === "string" ? args.url : "";
			if (url.startsWith("https://") || url.startsWith("http://")) {
				void shell.openExternal(url);
				return "Opened in browser";
			}
			return `Invalid URL: ${url}`;
		}
		case "gui_notify": {
			const title = typeof args.title === "string" ? args.title : "Notification";
			const body = typeof args.body === "string" ? args.body : "";
			new Notification({ title, body }).show();
			return "Notification shown";
		}
		case "gui_clipboard_read": {
			return clipboard.readText();
		}
		default:
			return undefined;
	}
}
