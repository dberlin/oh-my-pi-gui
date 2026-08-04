/**
 * Registers all IPC handlers and wires sidecar events to renderer windows.
 */
import { type Dirent, existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from "electron";
import Store from "electron-store";
import type {
	CustomProviderInput,
	FsTreeEntry,
	IpcExtensionUiRespondPayload,
	IpcFsListPayload,
	IpcFsReadPayload,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcHostToolResultPayload,
	IpcHostToolUpdatePayload,
	IpcHostUriResultPayload,
	IpcNotifyPayload,
	IpcPrefsGetPayload,
	IpcPrefsSetPayload,
	IpcRpcCommandPayload,
	IpcSessionsDeletePayload,
	IpcSessionsListPayload,
	IpcSessionsSearchPayload,
	IpcStatsFetchPayload,
} from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS, type RunProgressState, type TrayState } from "../shared/ipc-types";
import type { RpcCommand } from "../shared/rpc-types";
import type { LogWatcher } from "./log-watcher";
import { deleteModelsProvider, listModelsProviders, modelsPath, upsertModelsProvider } from "./models-config";
import type { SessionIndex } from "./session-index";
import type { SidecarManager } from "./sidecar";
import type { StatsClient } from "./stats-client";
import { setTrayState } from "./tray";
import type { WindowManager } from "./window";

export interface IpcDeps {
	sidecar: SidecarManager;
	sessionIndex: SessionIndex;
	statsClient: StatsClient;
	logWatcher: LogWatcher;
	windowManager: WindowManager;
}

interface PrefsSchema {
	[key: string]: unknown;
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

// Dedupe state for SYSTEM_NOTIFY across multiple windows (see the handler).
let lastNotifyKey = "";
let lastNotifyAt = 0;

export function registerIpcHandlers(deps: IpcDeps): void {
	const { sidecar, sessionIndex, statsClient, logWatcher, windowManager } = deps;
	const prefsStore = new Store<PrefsSchema>({ name: "prefs" });

	// ========================================================================
	// Sidecar event forwarding → all windows
	// ========================================================================

	sidecar.on("events", events => {
		broadcast(windowManager, IPC_EVENTS.EVENTS_BATCH, { events });
	});

	sidecar.on("status", payload => {
		broadcast(windowManager, IPC_EVENTS.SIDECAR_STATUS, { ...payload, cwd: sidecar.cwd });
	});

	sidecar.on("extensionUi", request => {
		broadcast(windowManager, IPC_EVENTS.EXTENSION_UI, { request });
	});

	sidecar.on("hostToolCall", (request: { callId: string; name: string; args: Record<string, unknown> }) => {
		// Execute GUI-registered host tools directly in main process
		const result = executeGuiHostTool(request.name, request.args);
		if (result !== undefined) {
			sidecar.sendSideChannel({ type: "host_tool_result", callId: request.callId, result });
			return;
		}
		// Unknown host tools → forward to renderer
		broadcast(windowManager, IPC_EVENTS.HOST_TOOL_CALL, { request });
	});

	sidecar.on("hostUriRequest", request => {
		broadcast(windowManager, IPC_EVENTS.HOST_URI_REQUEST, { request });
	});

	sidecar.on("subagentFrame", frame => {
		broadcast(windowManager, IPC_EVENTS.SUBAGENT_FRAME, { frame });
	});

	sidecar.on("commandsUpdate", commands => {
		broadcast(windowManager, IPC_EVENTS.COMMANDS_UPDATE, { commands });
	});

	sidecar.on("configUpdate", payload => {
		broadcast(windowManager, IPC_EVENTS.CONFIG_UPDATE, payload);
	});

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

	// RPC command passthrough — always returns a response, never throws.
	// Throwing here causes "Error occurred in handler" console spam AND
	// bypasses the renderer's `if (!res.success)` checks, leaving components
	// on infinite spinners instead of showing error states.
	ipcMain.on(IPC_EVENTS.TRAY_STATE_PUSH, (_event, state: TrayState) => {
		setTrayState(state);
	});

	// Run-progress indicator (terminal.showProgress): the renderer pushes the
	// coalesced working/waiting/idle state (already gated on the setting, and
	// pinned to "idle" when off); mirror it to the dock badge + progress bars.
	ipcMain.on(IPC_EVENTS.PROGRESS_SET, (_event, state: RunProgressState) => {
		windowManager.setRunProgress(state);
	});

	ipcMain.handle(IPC_COMMANDS.RPC_COMMAND, async (_event, payload: IpcRpcCommandPayload) => {
		const client = sidecar.rpcClient;
		if (!client) {
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
		try {
			return await client.command({ ...cmd, id: _id } as RpcCommand, payload.timeoutMs);
		} catch (err) {
			return { id: _id, type: "response", success: false, error: err instanceof Error ? err.message : String(err) };
		}
	});

	// Extension UI respond
	ipcMain.handle(IPC_COMMANDS.EXTENSION_UI_RESPOND, (_event, payload: IpcExtensionUiRespondPayload) => {
		sidecar.sendSideChannel(payload.response);
	});

	// Host tool result
	ipcMain.handle(IPC_COMMANDS.HOST_TOOL_RESULT, (_event, payload: IpcHostToolResultPayload) => {
		sidecar.sendSideChannel(payload.result);
	});

	// Host tool update
	ipcMain.handle(IPC_COMMANDS.HOST_TOOL_UPDATE, (_event, payload: IpcHostToolUpdatePayload) => {
		sidecar.sendSideChannel(payload.update);
	});

	// Host URI result
	ipcMain.handle(IPC_COMMANDS.HOST_URI_RESULT, (_event, payload: IpcHostUriResultPayload) => {
		sidecar.sendSideChannel(payload.result);
	});

	// Sessions
	ipcMain.handle(IPC_COMMANDS.SESSIONS_LIST, async (_event, payload: IpcSessionsListPayload) => {
		const scope = payload.scope === "local" ? "local" : "global";
		return sessionIndex.list(scope);
	});

	ipcMain.handle(IPC_COMMANDS.SESSIONS_DELETE, async (_event, payload: IpcSessionsDeletePayload) => {
		if (typeof payload.sessionPath !== "string" || !payload.sessionPath.endsWith(".jsonl")) {
			throw new Error("Invalid session path");
		}
		return sessionIndex.deleteSession(payload.sessionPath);
	});

	// Full-content search over session files (raw JSONL grep in main, scoped to
	// the same candidate set the list view would show).
	ipcMain.handle(IPC_COMMANDS.SESSIONS_SEARCH, async (_event, payload: IpcSessionsSearchPayload) => {
		const scope = payload.scope === "local" ? "local" : "global";
		const query = typeof payload.query === "string" ? payload.query : "";
		const candidates = await sessionIndex.list(scope);
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
		async (event, filters?: { name: string; extensions: string[] }[]) => {
			const win = BrowserWindow.fromWebContents(event.sender);
			if (!win) return null;
			const result = await dialog.showOpenDialog(win, {
				properties: ["openFile", "multiSelections"],
				filters: filters ?? [],
			});
			return result.canceled ? null : result.filePaths;
		},
	);

	ipcMain.handle(IPC_COMMANDS.SYSTEM_CLIPBOARD_READ, () => {
		return clipboard.readText();
	});

	ipcMain.handle(IPC_COMMANDS.SYSTEM_NOTIFY, (_event, payload: IpcNotifyPayload) => {
		if (typeof payload.title === "string") {
			// Dedupe across windows: with 2+ windows each renderer posts its own copy
			// of the same turn notification — show it only once per title+body burst.
			const key = `${payload.title}${payload.body ?? ""}`;
			const now = Date.now();
			if (key === lastNotifyKey && now - lastNotifyAt < 1500) return;
			lastNotifyKey = key;
			lastNotifyAt = now;
			new Notification({ title: payload.title, body: payload.body ?? "" }).show();
		}
	});

	// Preferences
	ipcMain.handle(IPC_COMMANDS.PREFS_GET, (_event, payload: IpcPrefsGetPayload) => {
		if (payload.key) {
			return prefsStore.get(payload.key);
		}
		return prefsStore.store;
	});

	ipcMain.handle(IPC_COMMANDS.PREFS_SET, (_event, payload: IpcPrefsSetPayload) => {
		if (typeof payload.key !== "string") {
			throw new Error("Invalid preference key");
		}
		prefsStore.set(payload.key, payload.value);
	});

	// Sidecar control
	ipcMain.handle(IPC_COMMANDS.SIDECAR_RESTART, () => {
		sidecar.restart();
	});

	ipcMain.handle(IPC_COMMANDS.SIDECAR_SELECT_PROJECT, async event => {
		const win = BrowserWindow.fromWebContents(event.sender);
		if (!win) return null;
		const result = await dialog.showOpenDialog(win, {
			title: "Open project",
			defaultPath: sidecar.cwd,
			properties: ["openDirectory", "createDirectory"],
		});
		if (result.canceled || !result.filePaths[0]) return null;

		const cwd = result.filePaths[0];
		prefsStore.set("lastProject", cwd);
		sessionIndex.setCwd(cwd);
		sidecar.restart(cwd);
		return cwd;
	});

	// Switch to a KNOWN workspace directory (no native picker): used by the
	// workspace manager to jump to a recent project. Validates the directory
	// exists, then restarts the sidecar there (same tail as select-project).
	ipcMain.handle(IPC_COMMANDS.SIDECAR_SET_PROJECT, async (_event, payload: { cwd?: string }) => {
		const cwd = payload?.cwd;
		if (typeof cwd !== "string" || cwd.length === 0) return false;
		try {
			if (!(await fsp.stat(cwd)).isDirectory()) return false;
		} catch {
			return false;
		}
		prefsStore.set("lastProject", cwd);
		sessionIndex.setCwd(cwd);
		sidecar.restart(cwd);
		return true;
	});

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

	// Workspace filesystem — node:fs against sidecar.cwd; works without a live
	// sidecar session and never throws (renderer reads `ok`/`error`).
	ipcMain.handle(IPC_COMMANDS.FS_LIST, async (_event, payload: IpcFsListPayload) => {
		const rootAbs = sidecar.cwd;
		const prefix = (typeof payload.path === "string" ? payload.path : "")
			.replace(/\\/g, "/")
			.replace(/^\.\//, "")
			.replace(/^\/+|\/+$/g, "");
		const dirAbs = resolveWithin(rootAbs, prefix);
		if (!dirAbs) {
			return { ok: false, entries: [], truncated: false, error: "Path escapes the workspace" };
		}
		const state: WalkState = {
			rules: await loadIgnoreRules(rootAbs),
			maxDepth: clampInt(payload.maxDepth, 1, FS_LIST_MAX_DEPTH, FS_LIST_DEFAULT_DEPTH),
			maxFiles: clampInt(payload.maxEntries, 1, FS_LIST_MAX_FILES_CAP, FS_LIST_DEFAULT_MAX_FILES),
			fileCount: 0,
			truncated: false,
		};
		try {
			const stat = await fsp.stat(dirAbs);
			if (!stat.isDirectory()) {
				return { ok: false, entries: [], truncated: false, error: "Not a directory" };
			}
			const entries = await walkWorkspace(dirAbs, prefix, 0, state);
			return { ok: true, entries, truncated: state.truncated };
		} catch (err) {
			return {
				ok: false,
				entries: [],
				truncated: state.truncated,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});

	ipcMain.handle(IPC_COMMANDS.FS_READ, async (_event, payload: IpcFsReadPayload) => {
		const fail = (error: string) => ({ ok: false, content: "", truncated: false, binary: false, size: 0, error });
		if (typeof payload.path !== "string" || payload.path.length === 0) {
			return fail("Invalid path");
		}
		const abs = resolveWithin(sidecar.cwd, payload.path);
		if (!abs) {
			return fail("Path escapes the workspace");
		}
		const maxBytes = clampInt(payload.maxBytes, 1, FS_READ_MAX_BYTES_CAP, FS_READ_DEFAULT_MAX_BYTES);
		try {
			const stat = await fsp.stat(abs);
			if (!stat.isFile()) {
				return fail("Not a file");
			}
			const handle = await fsp.open(abs, "r");
			try {
				const length = Math.min(stat.size, maxBytes + 1);
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, 0);
				const slice = buffer.subarray(0, bytesRead);
				if (slice.includes(0)) {
					return { ok: true, content: "", truncated: false, binary: true, size: stat.size };
				}
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
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err));
		}
	});

	// Plan-mode document read — deliberately OFF the RPC bus: reading via the
	// bash RPC injected the plan into the model context and appended
	// bashExecution entries to the transcript on every poll. Reads the
	// configured path, else the newest `*plan.md` in the session-local root.
	// Confined to the workspace and the sessions dir (plan artifacts live there).
	ipcMain.handle(
		IPC_COMMANDS.FS_READ_PLAN,
		async (_event, payload: IpcFsReadPlanPayload): Promise<IpcFsReadPlanResult> => {
			const fail = (error: string): IpcFsReadPlanResult => ({ ok: false, path: null, content: null, error });
			if (typeof payload?.fsPath !== "string" || payload.fsPath.length === 0) {
				return fail("Invalid path");
			}
			const withinAllowedRoots = (value: string): string | null =>
				resolveWithin(sidecar.cwd, value) ?? resolveWithin(sessionIndex.sessionsDir, value);
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
			} catch (err) {
				return fail(err instanceof Error ? err.message : String(err));
			}
		},
	);

	ipcMain.handle(IPC_COMMANDS.SIDECAR_STATUS_GET, () => {
		return { status: sidecar.status, cwd: sidecar.cwd };
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
