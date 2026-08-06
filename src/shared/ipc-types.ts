/**
 * IPC channel definitions shared between main, preload, and renderer.
 * Type-safe contract for the contextBridge API.
 */

import type {
	AgentSessionEvent,
	AvailableCommand,
	CommandOutputFrame,
	ConfigUpdateFrame,
	ExtensionErrorFrame,
	ExtensionUIRequest,
	ExtensionUIResponse,
	HostToolCallRequest,
	HostToolResult,
	HostToolUpdate,
	HostUriRequest,
	HostUriResult,
	ImageContent,
	PromptResultFrame,
	RpcCommand,
	RpcDebugParams,
	RpcLiveUpdateFrame,
	RpcMcpServerInput,
	RpcResponse,
	SessionInfoUpdateFrame,
	SidecarStatus,
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
	/** Per-tab sidecar status push (every tab of the window, foreground or background) */
	TAB_STATUS: "tab:status",
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
	/** Deferred result for locally handled extension slash commands */
	PROMPT_RESULT: "prompt:result",
	/** Text emitted by text-mode slash commands */
	COMMAND_OUTPUT: "command:output",
	/** Current session title/id changed */
	SESSION_INFO_UPDATE: "session-info:update",
	/** Extension runtime hook failed */
	EXTENSION_ERROR: "extension:error",
	/** Realtime voice session state/levels/transcript update. */
	LIVE_UPDATE: "live:update",
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
	/** Auto-update status machine push (idle/checking/available/downloading/downloaded/not-available/error) */
	UPDATER_STATUS: "updater:status",
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
	/** Spawn a tab (own sidecar) bound to the calling window */
	SPAWN_TAB: "tab:spawn",
	/** Close a tab: release its sidecar; last tab leaves the window tab-less */
	CLOSE_TAB: "tab:close",
	/** Move full event forwarding to the window's active tab */
	SET_ACTIVE_TAB: "tab:set-active",
	/** List the calling window's tabs (boot reconciliation) */
	GET_TABS: "tab:get-all",
	/** Round-trip a draft through the user's $VISUAL/$EDITOR (temp file, exit-0 read-back) */
	EDITOR_OPEN_EXTERNAL: "editor:open-external",
	/** Manual update check */
	UPDATER_CHECK: "updater:check",
	/** Start downloading the available update */
	UPDATER_DOWNLOAD: "updater:download",
	/** Quit and install the downloaded update */
	UPDATER_INSTALL: "updater:install",
	/** Current updater status (replay for renderer boot) */
	UPDATER_GET_STATUS: "updater:getStatus",
	/** Current app version (settings → updates row) */
	UPDATER_VERSION: "updater:version",
} as const;

// ============================================================================
// Auto-update status machine (electron-updater → renderer)
// ============================================================================

export type UpdateStatus =
	| { state: "idle" }
	| { state: "checking" }
	| { state: "available"; version: string; notes?: string }
	| { state: "downloading"; percent: number; bytesPerSecond: number; transferred: number; total: number }
	| { state: "downloaded"; version: string }
	| { state: "not-available"; version: string }
	| { state: "error"; message: string };

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

// ============================================================================
// Session Tab Types (in-window parallel sessions, one sidecar per tab)
// ============================================================================

/**
 * Tab chip status: the sidecar's connection status plus a main-synthesized
 * "running" (connection ready + agent run in flight, from the event stream).
 */
export type TabStatus = SidecarStatus | "running";

/** One tab of a window: its sidecar's cwd, last status, and cached session meta. */
export interface IpcTabInfo {
	/** Opaque snowflake id minted by main at acquire. */
	tabId: string;
	cwd: string;
	status: TabStatus;
	/** Present once the tab's sidecar reported session_info_update. */
	sessionId?: string;
	title?: string;
}

/** TAB_STATUS push payload — a full tab snapshot from any tab, active or background. */
export type IpcTabStatusPayload = IpcTabInfo;

/** Spawn a tab bound to the calling window. Defaults: caller's cwd, fresh session. */
export interface IpcSpawnTabPayload {
	cwd?: string;
	sessionPath?: string;
}

export interface IpcSpawnTabResult {
	tabId: string;
}

export interface IpcCloseTabPayload {
	tabId: string;
}

export interface IpcSetActiveTabPayload {
	tabId: string;
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
		prompt(message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp"): Promise<RpcResponse>;
		steer(message: string, images?: ImageContent[]): Promise<RpcResponse>;
		followUp(message: string, images?: ImageContent[]): Promise<RpcResponse>;
		abort(): Promise<RpcResponse>;
		abortAndPrompt(message: string): Promise<RpcResponse>;
		newSession(parentSession?: string): Promise<RpcResponse>;
		dropSession(): Promise<RpcResponse>;
		switchSession(sessionPath: string): Promise<RpcResponse>;
		branch(entryId: string): Promise<RpcResponse>;
		fork(): Promise<RpcResponse>;
		eval(code: string, language?: "python" | "js" | "ruby" | "julia", excluded?: boolean): Promise<RpcResponse>;
		abortEval(): Promise<RpcResponse>;
		dequeue(): Promise<RpcResponse>;
		getQueue(): Promise<RpcResponse>;
		queueRemove(queueId: string): Promise<RpcResponse>;
		queueMove(queueId: string, toIndex: number): Promise<RpcResponse>;
		queueClear(lane?: "steering" | "followUp"): Promise<RpcResponse>;
		setModel(provider: string, modelId: string): Promise<RpcResponse>;
		cycleModel(direction?: "forward" | "backward"): Promise<RpcResponse>;
		retry(): Promise<RpcResponse>;
		clearContext(): Promise<RpcResponse>;
		abortSubagent(agentId: string): Promise<RpcResponse>;
		reviveSubagent(agentId: string): Promise<RpcResponse>;
		writeLocalPaste(content: string): Promise<RpcResponse>;
		getActiveTools(): Promise<RpcResponse>;
		setPrewalk(enabled: boolean): Promise<RpcResponse>;
		fresh(): Promise<RpcResponse>;
		shakeContext(mode: "elide" | "images"): Promise<RpcResponse>;
		reloadPlugins(): Promise<RpcResponse>;
		setForceTool(payload: { tool: string } | { clear: true }): Promise<RpcResponse>;
		getForceTool(): Promise<RpcResponse>;
		listForeignSessions(source: "claude" | "codex"): Promise<RpcResponse>;
		importForeignSession(source: "claude" | "codex", foreignId: string): Promise<RpcResponse>;
		forkFrom(entryId: string): Promise<RpcResponse>;
		switchLeaf(entryId: string, options?: { summarize?: boolean; customInstructions?: string }): Promise<RpcResponse>;
		resumeAfterAskReanswer(): Promise<RpcResponse>;
		getCommandArgCompletions(command: string, prefix: string): Promise<RpcResponse>;
		mcpAdd(name: string, config: RpcMcpServerInput, scope?: "user" | "project"): Promise<RpcResponse>;
		mcpTest(probe: { name?: string; config?: RpcMcpServerInput }): Promise<RpcResponse>;
		mcpReauth(name: string): Promise<RpcResponse>;
		mcpReauthCancel(name: string): Promise<RpcResponse>;
		marketplaceAction(payload: {
			action: "add" | "remove" | "update" | "install" | "uninstall" | "upgrade" | "list_available";
			marketplace?: string;
			plugin?: string;
			source?: string;
		}): Promise<RpcResponse>;
		getPluginDetail(pluginId: string): Promise<RpcResponse>;
		setPluginFeatures(pluginId: string, features: string[]): Promise<RpcResponse>;
		setPluginSetting(pluginId: string, key: string, value: unknown): Promise<RpcResponse>;
		deletePluginSetting(pluginId: string, key: string): Promise<RpcResponse>;
		getDirectories(): Promise<RpcResponse>;
		addDirectory(path: string): Promise<RpcResponse>;
		removeDirectory(path: string): Promise<RpcResponse>;
		moveSession(path: string): Promise<RpcResponse>;
		liveStart(voice?: string): Promise<RpcResponse>;
		liveToggleMute(): Promise<RpcResponse>;
		liveStop(): Promise<RpcResponse>;
		getLiveState(): Promise<RpcResponse>;
		debug(params: RpcDebugParams): Promise<RpcResponse>;
		collabStart(relayUrl?: string, view?: boolean): Promise<RpcResponse>;
		collabJoin(link: string): Promise<RpcResponse>;
		collabLeave(): Promise<RpcResponse>;
		getCollabState(): Promise<RpcResponse>;
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
		bash(command: string, excluded?: boolean): Promise<RpcResponse>;
		abortBash(): Promise<RpcResponse>;
		getSessionStats(): Promise<RpcResponse>;
		exportHtml(outputPath?: string): Promise<RpcResponse>;
		getBranchMessages(): Promise<RpcResponse>;
		getLastAssistantText(): Promise<RpcResponse>;
		getCopyTargets(): Promise<RpcResponse>;
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
		getAgentDefinitions(): Promise<RpcResponse>;
		getHooks(): Promise<RpcResponse>;
		getMcpServers(): Promise<RpcResponse>;
		getPlugins(): Promise<RpcResponse>;
		getMarketplaces(): Promise<RpcResponse>;
		getPromptTemplates(): Promise<RpcResponse>;
		getMemoryReport(): Promise<RpcResponse>;
		getContextReport(): Promise<RpcResponse>;
		shareSession(): Promise<RpcResponse>;
		getJobs(): Promise<RpcResponse>;
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
		guidedGoal(initial?: string): Promise<RpcResponse>;
		setAgentsPaused(enabled: boolean): Promise<RpcResponse>;
		setGoal(args: {
			objective?: string;
			tokenBudget?: number | null;
			action?: "pause" | "resume" | "drop";
		}): Promise<RpcResponse>;
		btw(question: string): Promise<RpcResponse>;
		btwBranch(): Promise<RpcResponse>;
		tan(work: string): Promise<RpcResponse>;
		omfg(complaint: string): Promise<RpcResponse>;
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
		onTabStatus(callback: (payload: IpcTabStatusPayload) => void): () => void;
		onExtensionUi(callback: (request: ExtensionUIRequest) => void): () => void;
		onHostToolCall(callback: (request: HostToolCallRequest) => void): () => void;
		onHostUriRequest(callback: (request: HostUriRequest) => void): () => void;
		onLiveUpdate(callback: (frame: RpcLiveUpdateFrame) => void): () => void;
		onSubagentFrame(callback: (frame: SubagentFrame) => void): () => void;
		onCommandsUpdate(callback: (commands: AvailableCommand[]) => void): () => void;
		onConfigUpdate(callback: (payload: ConfigUpdateFrame) => void): () => void;
		onPromptResult(callback: (frame: PromptResultFrame) => void): () => void;
		onCommandOutput(callback: (frame: CommandOutputFrame) => void): () => void;
		onSessionInfoUpdate(callback: (frame: SessionInfoUpdateFrame) => void): () => void;
		onExtensionError(callback: (frame: ExtensionErrorFrame) => void): () => void;
		onSessionsChanged(callback: () => void): () => void;
		onLogLines(callback: (lines: string[]) => void): () => void;
		onMenuAction(callback: (action: MenuAction, payload?: MenuActionPayload) => void): () => void;
		onDeepLink(callback: (link: DeepLinkPayload) => void): () => void;
		onUpdaterStatus(callback: (status: UpdateStatus) => void): () => void;
	};
	updater: {
		check(): Promise<UpdateStatus>;
		download(): Promise<UpdateStatus>;
		install(): Promise<void>;
		getStatus(): Promise<UpdateStatus>;
		version(): Promise<string>;
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
	tabs: {
		/** The calling window's tabs in acquisition order (boot reconciliation). */
		list(): Promise<IpcTabInfo[]>;
		/** Spawn a background tab bound to this window. Null at the pool cap. */
		spawn(payload: IpcSpawnTabPayload): Promise<IpcSpawnTabResult | null>;
		/** Release a tab's sidecar. False when the tab is unknown or foreign. */
		close(tabId: string): Promise<boolean>;
		/** Move full event forwarding to this tab. False when unknown or foreign. */
		setActive(tabId: string): Promise<boolean>;
	};
	stats: {
		fetch(path: string, params?: Record<string, string>): Promise<unknown>;
	};
	system: {
		openExternal(url: string): Promise<void>;
		showSaveDialog(defaultPath?: string): Promise<string | null>;
		showOpenDialog(
			filters?: { name: string; extensions: string[] }[],
			options?: { directory?: boolean },
		): Promise<string[] | null>;
		clipboardRead(): Promise<string>;
		notify(title: string, body?: string): void;
	};
	prefs: {
		get(key?: string): Promise<unknown>;
		set(key: string, value: unknown): Promise<void>;
	};
	sidecar: {
		restart(sessionPath?: string): Promise<void>;
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
	editor: {
		openExternal(content: string): Promise<{
			ok: boolean;
			unavailable: boolean;
			text: string | null;
			error?: string;
		}>;
	};
}
