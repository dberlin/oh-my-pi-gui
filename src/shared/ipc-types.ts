/**
 * IPC channel definitions shared between main, preload, and renderer.
 * Type-safe contract for the contextBridge API.
 */

import type {
	AgentSessionEvent,
	AvailableCommand,
	ConfigUpdateFrame,
	ExtensionUIRequest,
	ExtensionUIResponse,
	HostToolCallRequest,
	HostToolResult,
	HostToolUpdate,
	HostUriRequest,
	HostUriResult,
	ImageContent,
	RpcCommand,
	RpcResponse,
	SubagentFrame,
	ThinkingLevel,
	TodoPhase,
} from "./rpc-types";

// ============================================================================
// IPC Channels (main → renderer events)
// ============================================================================

export const IPC_EVENTS = {
	/** Batched agent session events (16ms cadence) */
	EVENTS_BATCH: "rpc:events",
	/** Sidecar connection status change */
	SIDECAR_STATUS: "sidecar:status",
	/** Extension UI request from agent */
	EXTENSION_UI: "extension-ui:request",
	/** Host tool call request */
	HOST_TOOL_CALL: "host-tool:call",
	/** Host URI request */
	HOST_URI_REQUEST: "host-uri:request",
	/** Subagent frame */
	SUBAGENT_FRAME: "subagent:frame",
	/** Available commands updated */
	COMMANDS_UPDATE: "commands:update",
	/** Agent config changed (set_setting, slash-command config edits) */
	CONFIG_UPDATE: "config:update",
	/** Session list changed */
	SESSIONS_CHANGED: "sessions:changed",
	/** Log line appended */
	LOG_LINE: "log:line",
	/** Stats data ready */
	STATS_DATA: "stats:data",
	/** Native application menu action */
	MENU_ACTION: "menu:action",
	/** omp:// deep link (new session / switch session) */
	DEEP_LINK: "deep-link",
	/** Renderer → main fire-and-forget tray-state snapshot */
	TRAY_STATE_PUSH: "tray:state-push",
	/** Renderer → main fire-and-forget run-progress state (dock badge + progress bar) */
	PROGRESS_SET: "progress:set",
} as const;

// ============================================================================
// IPC Channels (renderer → main invoke)
// ============================================================================

export const IPC_COMMANDS = {
	/** Send an RPC command, get response */
	RPC_COMMAND: "rpc:command",
	/** Respond to extension UI request */
	EXTENSION_UI_RESPOND: "extension-ui:respond",
	/** Send host tool result */
	HOST_TOOL_RESULT: "host-tool:result",
	/** Send host tool update */
	HOST_TOOL_UPDATE: "host-tool:update",
	/** Send host URI result */
	HOST_URI_RESULT: "host-uri:result",
	/** Get session list */
	SESSIONS_LIST: "sessions:list",
	/** Delete a session file */
	SESSIONS_DELETE: "sessions:delete",
	/** Full-content search over session files; returns matching paths */
	SESSIONS_SEARCH: "sessions:search",
	/** Fetch stats endpoint */
	STATS_FETCH: "stats:fetch",
	/** Open external URL */
	SYSTEM_OPEN_EXTERNAL: "system:open-external",
	/** Show save dialog */
	SYSTEM_SAVE_DIALOG: "system:save-dialog",
	/** Show open dialog */
	SYSTEM_OPEN_DIALOG: "system:open-dialog",
	/** Read clipboard */
	SYSTEM_CLIPBOARD_READ: "system:clipboard-read",
	/** Show notification */
	SYSTEM_NOTIFY: "system:notify",
	/** Get GUI preferences */
	PREFS_GET: "prefs:get",
	/** Set GUI preferences */
	PREFS_SET: "prefs:set",
	/** Restart sidecar */
	SIDECAR_RESTART: "sidecar:restart",
	/** Get sidecar status */
	SIDECAR_STATUS_GET: "sidecar:status-get",
	/** Choose a project directory and restart the sidecar there */
	SIDECAR_SELECT_PROJECT: "sidecar:select-project",
	SIDECAR_SET_PROJECT: "sidecar:set-project",
	/** List custom models.yml providers */
	MODELS_PROVIDERS_LIST: "models:providers-list",
	/** Upsert a custom provider into models.yml */
	MODELS_PROVIDER_UPSERT: "models:provider-upsert",
	/** Delete a custom provider from models.yml */
	MODELS_PROVIDER_DELETE: "models:provider-delete",
	/** Open the agent's models.yml in the system editor (created when missing; falls back to revealing it in the file manager) */
	MODELS_CONFIG_OPEN: "models:config-open",
	/** List workspace files as a tree (main-process readdir, no sidecar needed) */
	FS_LIST: "fs:list",
	/** Read a workspace file with a byte cap */
	FS_READ: "fs:read",
	/** Read the plan-mode document off the RPC bus (with session-local fallback) */
	FS_READ_PLAN: "fs:read-plan",
	/** Open a session (or a fresh window) in a new parallel window with its own sidecar */
	SESSION_OPEN_NEW_WINDOW: "session:open-new-window",
	/** Fresh window pulls the session it was opened for (one-shot) */
	SESSION_CONSUME_PENDING: "session:consume-pending",
} as const;

export type MenuAction =
	| "new-session"
	| "open-project"
	| "toggle-sidebar"
	| "toggle-panel"
	| "open-settings"
	| "open-usage"
	| "export-html"
	| "handoff"
	| "toggle-fast"
	| "cycle-thinking"
	| "set-approval"
	| "toggle-language"
	| "switch-project";

/** Action forwarded to the renderer for an omp:// deep link. */
export type DeepLinkPayload = { action: "new-session" } | { action: "switch-session"; sessionId: string };

/** Optional payload carried alongside a MenuAction (approval mode / project cwd). */
export interface MenuActionPayload {
	approvalMode?: "always-ask" | "write" | "yolo";
	cwd?: string;
}

/** Run-progress state pushed by the renderer (terminal.showProgress): dock badge + window progress bar. */
export type RunProgressState = "working" | "waiting" | "idle";

/** Compact snapshot the renderer pushes to main to build the tray menu. */
export interface TrayState {
	status: "idle" | "streaming" | "waiting" | "error";
	language: "zh" | "en";
	cwd: string | null;
	projectName: string;
	modelId: string | null;
	thinkingLevel: string;
	fastMode: boolean;
	approvalMode: "always-ask" | "write" | "yolo";
	contextPercent: number | null;
	contextTokens: number | null;
	workspaces: { cwd: string; name: string; current: boolean }[];
}

// ============================================================================
// IPC Payload Types
// ============================================================================

export interface IpcRpcCommandPayload {
	command: RpcCommand;
	/** Per-call timeout override (ms) for slow commands (voice STT/TTS model load). */
	timeoutMs?: number;
}

export interface IpcEventsBatchPayload {
	events: AgentSessionEvent[];
}

export interface IpcSidecarStatusPayload {
	status: "starting" | "ready" | "exited" | "error" | "restarting";
	message?: string;
	cwd: string;
}

export interface IpcExtensionUiPayload {
	request: ExtensionUIRequest;
}

export interface IpcExtensionUiRespondPayload {
	response: ExtensionUIResponse;
}

export interface IpcHostToolCallPayload {
	request: HostToolCallRequest;
}

export interface IpcHostToolResultPayload {
	result: HostToolResult;
}

export interface IpcHostToolUpdatePayload {
	update: HostToolUpdate;
}

export interface IpcHostUriRequestPayload {
	request: HostUriRequest;
}

export interface IpcHostUriResultPayload {
	result: HostUriResult;
}

export interface IpcSubagentFramePayload {
	frame: SubagentFrame;
}

export interface IpcCommandsUpdatePayload {
	commands: AvailableCommand[];
}

export interface CustomProviderModelInput {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
}

export interface CustomProviderInput {
	id: string;
	api: string;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models: CustomProviderModelInput[];
}

/** A provider entry as shown in the GUI (apiKey masked, never the real value). */
export interface CustomProviderView {
	id: string;
	api: string;
	baseUrl: string;
	hasApiKey: boolean;
	apiKeyPreview?: string;
	headers?: Record<string, string>;
	models: CustomProviderModelInput[];
	builtin: boolean;
}

export interface IpcSessionsListPayload {
	scope: "local" | "global";
}

export interface IpcSessionsDeletePayload {
	sessionPath: string;
}

export interface IpcSessionsSearchPayload {
	query: string;
	scope: "local" | "global";
}

export interface IpcStatsFetchPayload {
	path: string;
	params?: Record<string, string>;
}

export interface IpcNotifyPayload {
	title: string;
	body?: string;
}

export interface IpcPrefsGetPayload {
	key?: string;
}

export interface IpcPrefsSetPayload {
	key: string;
	value: unknown;
}

// ============================================================================
// Workspace Filesystem Types
// ============================================================================

export interface IpcFsListPayload {
	/** Directory to walk, relative to the workspace root; defaults to the root. */
	path?: string;
	/** Max directory depth to descend into (root level = 0). */
	maxDepth?: number;
	/** Max number of files to include before truncating. */
	maxEntries?: number;
}

export interface FsTreeEntry {
	name: string;
	/** Workspace-relative path using POSIX separators. */
	path: string;
	kind: "file" | "dir";
	/** Directories only; omitted or empty beyond the depth cap. */
	children?: FsTreeEntry[];
}

export interface IpcFsListResult {
	ok: boolean;
	entries: FsTreeEntry[];
	/** True when the file cap stopped the walk early. */
	truncated: boolean;
	error?: string;
}

export interface IpcFsReadPayload {
	/** Workspace-relative file path. */
	path: string;
	/** Max bytes to read; hard-capped in main. */
	maxBytes?: number;
}

export interface IpcFsReadResult {
	ok: boolean;
	content: string;
	/** File exceeded maxBytes; content is a prefix. */
	truncated: boolean;
	/** NUL byte found in the read region; content is empty. */
	binary: boolean;
	/** Total file size in bytes. */
	size: number;
	error?: string;
}

export interface IpcFsReadPlanPayload {
	/** Absolute path of the configured plan file. */
	fsPath: string;
	/** Session-local artifacts root for the newest-`*plan.md` fallback (plan under `local://`); null disables the fallback. */
	localRoot: string | null;
}

export interface IpcFsReadPlanResult {
	ok: boolean;
	/** The file actually read (fsPath or the fallback pick); null when no plan file exists. */
	path: string | null;
	/** File content ("" for an empty file); null when no plan file exists. */
	content: string | null;
	error?: string;
}

// ============================================================================
// Session Index Types
// ============================================================================

/**
 * Open a session (or a fresh project window) in a new parallel window.
 * `sessionPath` opens that specific session; `cwd` chooses the project for a
 * fresh window. Both optional — omit both for a fresh window in the caller's cwd.
 */
export interface IpcSessionOpenNewWindowPayload {
	sessionPath?: string;
	cwd?: string;
}

export interface SessionInfo {
	path: string;
	id: string;
	title: string | null;
	cwd: string;
	created: string;
	modified: string;
	messageCount: number;
	size: number;
	status: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
	parentSessionPath?: string;
	firstMessage: string;
}

// ============================================================================
// Preload API Shape (what window.omp exposes)
// ============================================================================

export interface OmpApi {
	rpc: {
		command(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse>;
		getState(): Promise<RpcResponse>;
		prompt(message: string, images?: ImageContent[]): Promise<RpcResponse>;
		steer(message: string, images?: ImageContent[]): Promise<RpcResponse>;
		followUp(message: string, images?: ImageContent[]): Promise<RpcResponse>;
		abort(): Promise<RpcResponse>;
		abortAndPrompt(message: string): Promise<RpcResponse>;
		newSession(parentSession?: string): Promise<RpcResponse>;
		switchSession(sessionPath: string): Promise<RpcResponse>;
		branch(entryId: string): Promise<RpcResponse>;
		fork(): Promise<RpcResponse>;
		eval(code: string, language?: "python" | "js" | "ruby" | "julia", excluded?: boolean): Promise<RpcResponse>;
		abortEval(): Promise<RpcResponse>;
		dequeue(): Promise<RpcResponse>;
		setModel(provider: string, modelId: string): Promise<RpcResponse>;
		cycleModel(): Promise<RpcResponse>;
		getAvailableModels(): Promise<RpcResponse>;
		setThinkingLevel(level: ThinkingLevel | "auto"): Promise<RpcResponse>;
		cycleThinkingLevel(): Promise<RpcResponse>;
		setFastMode(enabled: boolean): Promise<RpcResponse>;
		setSteeringMode(mode: "all" | "one-at-a-time"): Promise<RpcResponse>;
		setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<RpcResponse>;
		setInterruptMode(mode: "immediate" | "wait"): Promise<RpcResponse>;
		compact(customInstructions?: string): Promise<RpcResponse>;
		setAutoCompaction(enabled: boolean): Promise<RpcResponse>;
		setAutoRetry(enabled: boolean): Promise<RpcResponse>;
		abortRetry(): Promise<RpcResponse>;
		bash(command: string): Promise<RpcResponse>;
		abortBash(): Promise<RpcResponse>;
		getSessionStats(): Promise<RpcResponse>;
		exportHtml(outputPath?: string): Promise<RpcResponse>;
		getBranchMessages(): Promise<RpcResponse>;
		getLastAssistantText(): Promise<RpcResponse>;
		setSessionName(name: string): Promise<RpcResponse>;
		setEntryLabel(entryId: string, label?: string): Promise<RpcResponse>;
		handoff(customInstructions?: string): Promise<RpcResponse>;
		getMessages(): Promise<RpcResponse>;
		getMessagesPage(cursor?: string, limit?: number): Promise<RpcResponse>;
		getLoginProviders(): Promise<RpcResponse>;
		login(providerId: string): Promise<RpcResponse>;
		logout(providerId: string): Promise<RpcResponse>;
		getUsage(): Promise<RpcResponse>;
		getSettingsSchema(): Promise<RpcResponse>;
		getSettings(paths?: string[]): Promise<RpcResponse>;
		setSetting(path: string, value: unknown): Promise<RpcResponse>;
		getProviders(): Promise<RpcResponse>;
		setPlanMode(enabled: boolean): Promise<RpcResponse>;
		getPlanMode(): Promise<RpcResponse>;
		getModelRoles(): Promise<RpcResponse>;
		setModelRole(role: string, modelId: string | null): Promise<RpcResponse>;
		getModelRoleMetadata(): Promise<RpcResponse>;
		getAvailableCommands(): Promise<RpcResponse>;
		getSkills(): Promise<RpcResponse>;
		getHooks(): Promise<RpcResponse>;
		getMcpServers(): Promise<RpcResponse>;
		getPlugins(): Promise<RpcResponse>;
		getMarketplaces(): Promise<RpcResponse>;
		getPromptTemplates(): Promise<RpcResponse>;
		getMemoryReport(): Promise<RpcResponse>;
		getSessionTree(): Promise<RpcResponse>;
		getThemes(): Promise<RpcResponse>;
		getThemeColors(name: string): Promise<RpcResponse>;
		getTranscript(): Promise<RpcResponse>;
		planApproval(
			approved: boolean,
			option?: "execute" | "compact" | "keep_context",
			feedback?: string,
		): Promise<RpcResponse>;
		getVibeMode(): Promise<RpcResponse>;
		setVibeMode(enabled: boolean): Promise<RpcResponse>;
		getGoal(): Promise<RpcResponse>;
		setGoal(args: {
			objective?: string;
			tokenBudget?: number | null;
			action?: "pause" | "resume" | "drop";
		}): Promise<RpcResponse>;
		getLoopMode(): Promise<RpcResponse>;
		setLoopMode(enabled: boolean, args?: string): Promise<RpcResponse>;
		setSkillEnabled(name: string, enabled: boolean): Promise<RpcResponse>;
		setHookEnabled(hookId: string, enabled: boolean): Promise<RpcResponse>;
		setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<RpcResponse>;
		mcpAction(
			name: string,
			action: "enable" | "disable" | "reconnect" | "remove",
			scope?: "user" | "project",
		): Promise<RpcResponse>;
		setTodos(phases: TodoPhase[]): Promise<RpcResponse>;
		setSubagentSubscription(level: "off" | "progress" | "events"): Promise<RpcResponse>;
		getSubagents(): Promise<RpcResponse>;
		getSubagentMessages(subagentId?: string, sessionFile?: string, fromByte?: number): Promise<RpcResponse>;
		setHostTools(tools: unknown[]): Promise<RpcResponse>;
		setHostUriSchemes(schemes: unknown[]): Promise<RpcResponse>;
		// Voice (speech in/out): audio is canonical PCM16 mono 16 kHz WAV, base64.
		transcribeAudio(audioBase64: string, mimeType: string): Promise<RpcResponse>;
		synthesizeSpeech(text: string): Promise<RpcResponse>;
	};
	events: {
		onBatch(callback: (events: AgentSessionEvent[]) => void): () => void;
		onSidecarStatus(callback: (status: IpcSidecarStatusPayload) => void): () => void;
		onExtensionUi(callback: (request: ExtensionUIRequest) => void): () => void;
		onHostToolCall(callback: (request: HostToolCallRequest) => void): () => void;
		onHostUriRequest(callback: (request: HostUriRequest) => void): () => void;
		onSubagentFrame(callback: (frame: SubagentFrame) => void): () => void;
		onCommandsUpdate(callback: (commands: AvailableCommand[]) => void): () => void;
		onConfigUpdate(callback: (payload: ConfigUpdateFrame) => void): () => void;
		onSessionsChanged(callback: () => void): () => void;
		onLogLines(callback: (lines: string[]) => void): () => void;
		onMenuAction(callback: (action: MenuAction, payload?: MenuActionPayload) => void): () => void;
		onDeepLink(callback: (link: DeepLinkPayload) => void): () => void;
	};
	ui: {
		respondExtensionUi(response: ExtensionUIResponse): void;
		sendHostToolResult(result: HostToolResult): void;
		sendHostToolUpdate(update: HostToolUpdate): void;
		sendHostUriResult(result: HostUriResult): void;
	};
	sessions: {
		list(scope: "local" | "global"): Promise<SessionInfo[]>;
		delete(sessionPath: string): Promise<void>;
		search(query: string, scope: "local" | "global"): Promise<string[]>;
		/** Open a session (or a fresh project window) in a new parallel window. False at the cap. */
		openInNewWindow(payload: IpcSessionOpenNewWindowPayload): Promise<boolean>;
		/** One-shot: the session this window was opened to display, if any. */
		consumePendingOpen(): Promise<string | null>;
	};
	stats: {
		fetch(path: string, params?: Record<string, string>): Promise<unknown>;
	};
	system: {
		openExternal(url: string): Promise<void>;
		showSaveDialog(defaultPath?: string): Promise<string | null>;
		showOpenDialog(filters?: { name: string; extensions: string[] }[]): Promise<string[] | null>;
		clipboardRead(): Promise<string>;
		notify(title: string, body?: string): void;
	};
	prefs: {
		get(key?: string): Promise<unknown>;
		set(key: string, value: unknown): Promise<void>;
	};
	sidecar: {
		restart(): Promise<void>;
		selectProject(): Promise<string | null>;
		setProject(cwd: string): Promise<boolean>;
		getStatus(): Promise<IpcSidecarStatusPayload>;
	};
	tray: {
		pushState(state: TrayState): void;
	};
	progress: {
		set(state: RunProgressState): void;
	};
	models: {
		listProviders(): Promise<CustomProviderView[]>;
		upsertProvider(input: CustomProviderInput): Promise<void>;
		deleteProvider(id: string): Promise<void>;
		openConfig(): Promise<{ path: string; opened: boolean }>;
	};
	fs: {
		list(path?: string, maxDepth?: number, maxEntries?: number): Promise<IpcFsListResult>;
		read(path: string, maxBytes?: number): Promise<IpcFsReadResult>;
		readPlan(payload: IpcFsReadPlanPayload): Promise<IpcFsReadPlanResult>;
	};
}
