/**
 * Preload script: exposes the OmpApi on window.omp via contextBridge.
 * All RPC commands delegate to ipcRenderer.invoke(IPC_COMMANDS.RPC_COMMAND, ...).
 * Event subscriptions return unsubscribe functions.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
	CustomProviderInput,
	CustomProviderView,
	DeepLinkPayload,
	IpcFsListResult,
	IpcFsReadPlanPayload,
	IpcFsReadPlanResult,
	IpcFsReadResult,
	IpcSessionOpenNewWindowPayload,
	IpcSidecarStatusPayload,
	MenuAction,
	MenuActionPayload,
	OmpApi,
	RunProgressState,
	SessionInfo,
	TrayState,
} from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../shared/ipc-types";
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
} from "../shared/rpc-types";

function rpcCommand(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
	return ipcRenderer.invoke(IPC_COMMANDS.RPC_COMMAND, {
		command: cmd,
		timeoutMs: timeoutMs ?? timeoutForCommand(cmd),
	});
}

/**
 * The sidecar only answers `bash`/`eval`/`compact`/`export_html` after the
 * work finishes (rpc-mode awaits each), and big transcripts make the
 * transcript/message commands slow too. The 8s default would surface a
 * spurious "RPC timeout" while the command keeps running server-side, so
 * these get generous windows. Fast commands keep the default.
 */
const RPC_COMMAND_TIMEOUTS: Record<string, number> = {
	bash: 120_000,
	eval: 120_000,
	compact: 120_000,
	export_html: 120_000,
	get_transcript: 30_000,
	get_messages: 30_000,
	get_messages_page: 30_000,
};

function timeoutForCommand(cmd: RpcCommand): number | undefined {
	return RPC_COMMAND_TIMEOUTS[cmd.type];
}

function subscribe<T>(channel: string, callback: (data: T) => void): () => void {
	const listener = (_event: Electron.IpcRendererEvent, data: T) => callback(data);
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.removeListener(channel, listener);
	};
}

const api: OmpApi = {
	rpc: {
		command: (cmd: RpcCommand, timeoutMs?: number) => rpcCommand(cmd, timeoutMs),
		getState: () => ipcRenderer.invoke(IPC_COMMANDS.RPC_COMMAND, { command: { type: "get_state" } }),
		prompt: (message: string, images?: ImageContent[]) => rpcCommand({ type: "prompt", message, images }),
		steer: (message: string, images?: ImageContent[]) => rpcCommand({ type: "steer", message, images }),
		followUp: (message: string, images?: ImageContent[]) => rpcCommand({ type: "follow_up", message, images }),
		abort: () => rpcCommand({ type: "abort" }),
		abortAndPrompt: (message: string) => rpcCommand({ type: "abort_and_prompt", message }),
		newSession: (parentSession?: string) => rpcCommand({ type: "new_session", parentSession }),
		switchSession: (sessionPath: string) => rpcCommand({ type: "switch_session", sessionPath }),
		branch: (entryId: string) => rpcCommand({ type: "branch", entryId }),
		fork: () => rpcCommand({ type: "fork" }),
		eval: (code: string, language?: "python" | "js" | "ruby" | "julia", excluded?: boolean) =>
			rpcCommand({ type: "eval", code, language, excluded }),
		abortEval: () => rpcCommand({ type: "abort_eval" }),
		dequeue: () => rpcCommand({ type: "dequeue" }),
		setModel: (provider: string, modelId: string) => rpcCommand({ type: "set_model", provider, modelId }),
		cycleModel: () => rpcCommand({ type: "cycle_model" }),
		getAvailableModels: () => rpcCommand({ type: "get_available_models" }),
		setThinkingLevel: (level: ThinkingLevel | "auto") => rpcCommand({ type: "set_thinking_level", level }),
		cycleThinkingLevel: () => rpcCommand({ type: "cycle_thinking_level" }),
		setFastMode: (enabled: boolean) => rpcCommand({ type: "set_fast_mode", enabled }),
		setSteeringMode: (mode: "all" | "one-at-a-time") => rpcCommand({ type: "set_steering_mode", mode }),
		setFollowUpMode: (mode: "all" | "one-at-a-time") => rpcCommand({ type: "set_follow_up_mode", mode }),
		setInterruptMode: (mode: "immediate" | "wait") => rpcCommand({ type: "set_interrupt_mode", mode }),
		compact: (customInstructions?: string) => rpcCommand({ type: "compact", customInstructions }),
		setAutoCompaction: (enabled: boolean) => rpcCommand({ type: "set_auto_compaction", enabled }),
		setAutoRetry: (enabled: boolean) => rpcCommand({ type: "set_auto_retry", enabled }),
		abortRetry: () => rpcCommand({ type: "abort_retry" }),
		bash: (command: string) => rpcCommand({ type: "bash", command }),
		abortBash: () => rpcCommand({ type: "abort_bash" }),
		getSessionStats: () => rpcCommand({ type: "get_session_stats" }),
		exportHtml: (outputPath?: string) => rpcCommand({ type: "export_html", outputPath }),
		getBranchMessages: () => rpcCommand({ type: "get_branch_messages" }),
		getLastAssistantText: () => rpcCommand({ type: "get_last_assistant_text" }),
		setSessionName: (name: string) => rpcCommand({ type: "set_session_name", name }),
		setEntryLabel: (entryId: string, label?: string) => rpcCommand({ type: "set_entry_label", entryId, label }),
		handoff: (customInstructions?: string) => rpcCommand({ type: "handoff", customInstructions }),
		getMessages: () => rpcCommand({ type: "get_messages" }),
		getMessagesPage: (cursor?: string, limit?: number) => rpcCommand({ type: "get_messages_page", cursor, limit }),
		getLoginProviders: () => rpcCommand({ type: "get_login_providers" }),
		login: (providerId: string) => rpcCommand({ type: "login", providerId }),
		logout: (providerId: string) => rpcCommand({ type: "logout", providerId }),
		getUsage: () => rpcCommand({ type: "get_usage" }),
		getSettingsSchema: () => rpcCommand({ type: "get_settings_schema" }),
		getSettings: (paths?: string[]) => rpcCommand({ type: "get_settings", paths }),
		setSetting: (path: string, value: unknown) => rpcCommand({ type: "set_setting", path, value }),
		getProviders: () => rpcCommand({ type: "get_providers" }),
		setPlanMode: (enabled: boolean) => rpcCommand({ type: "set_plan_mode", enabled }),
		getPlanMode: () => rpcCommand({ type: "get_plan_mode" }),
		getModelRoles: () => rpcCommand({ type: "get_model_roles" }),
		setModelRole: (role: string, modelId: string | null) => rpcCommand({ type: "set_model_role", role, modelId }),
		getModelRoleMetadata: () => rpcCommand({ type: "get_model_role_metadata" }),
		getAvailableCommands: () => rpcCommand({ type: "get_available_commands" }),
		getSkills: () => rpcCommand({ type: "get_skills" }),
		getHooks: () => rpcCommand({ type: "get_hooks" }),
		getMcpServers: () => rpcCommand({ type: "get_mcp_servers" }),
		getPlugins: () => rpcCommand({ type: "get_plugins" }),
		getMarketplaces: () => rpcCommand({ type: "get_marketplaces" }),
		getPromptTemplates: () => rpcCommand({ type: "get_prompt_templates" }),
		getMemoryReport: () => rpcCommand({ type: "get_memory_report" }),
		getSessionTree: () => rpcCommand({ type: "get_session_tree" }),
		getThemes: () => rpcCommand({ type: "get_themes" }),
		getThemeColors: (name: string) => rpcCommand({ type: "get_theme_colors", name }),
		getTranscript: () => rpcCommand({ type: "get_transcript" }),
		planApproval: (approved: boolean, option?: "execute" | "compact" | "keep_context", feedback?: string) =>
			rpcCommand({ type: "plan_approval", approved, option, feedback }),
		getVibeMode: () => rpcCommand({ type: "get_vibe_mode" }),
		setVibeMode: (enabled: boolean) => rpcCommand({ type: "set_vibe_mode", enabled }),
		getGoal: () => rpcCommand({ type: "get_goal" }),
		setGoal: (args: { objective?: string; tokenBudget?: number | null; action?: "pause" | "resume" | "drop" }) =>
			rpcCommand({ type: "set_goal", ...args }),
		getLoopMode: () => rpcCommand({ type: "get_loop_mode" }),
		setLoopMode: (enabled: boolean, args?: string) => rpcCommand({ type: "set_loop_mode", enabled, args }),
		setSkillEnabled: (name: string, enabled: boolean) => rpcCommand({ type: "set_skill_enabled", name, enabled }),
		setHookEnabled: (hookId: string, enabled: boolean) => rpcCommand({ type: "set_hook_enabled", hookId, enabled }),
		setPluginEnabled: (pluginId: string, enabled: boolean, scope?: "user" | "project") =>
			rpcCommand({ type: "set_plugin_enabled", pluginId, enabled, scope }),
		mcpAction: (name: string, action: "enable" | "disable" | "reconnect" | "remove", scope?: "user" | "project") =>
			rpcCommand({ type: "mcp_action", name, action, scope }),
		setTodos: (phases: TodoPhase[]) => rpcCommand({ type: "set_todos", phases }),
		setSubagentSubscription: (level: "off" | "progress" | "events") =>
			rpcCommand({ type: "set_subagent_subscription", level }),
		getSubagents: () => rpcCommand({ type: "get_subagents" }),
		getSubagentMessages: (subagentId?: string, sessionFile?: string, fromByte?: number) =>
			rpcCommand({ type: "get_subagent_messages", subagentId, sessionFile, fromByte }),
		setHostTools: (tools: unknown[]) => rpcCommand({ type: "set_host_tools", tools: tools as never }),
		setHostUriSchemes: (schemes: unknown[]) =>
			rpcCommand({ type: "set_host_uri_schemes", schemes: schemes as never }),
		// Voice (speech in/out) — AgentVoice region; keep at the end of the rpc object.
		// Generous timeouts: the first call on a fresh sidecar loads the STT/TTS
		// model into the worker, far beyond the default 8s RPC timeout.
		transcribeAudio: (audioBase64: string, mimeType: string) =>
			rpcCommand({ type: "transcribe_audio", audioBase64, mimeType }, 120_000),
		synthesizeSpeech: (text: string) => rpcCommand({ type: "synthesize_speech", text }, 60_000),
	},

	events: {
		onBatch: (callback: (events: AgentSessionEvent[]) => void) =>
			subscribe<{ events: AgentSessionEvent[] }>(IPC_EVENTS.EVENTS_BATCH, data => callback(data.events)),
		onSidecarStatus: (callback: (status: IpcSidecarStatusPayload) => void) =>
			subscribe<IpcSidecarStatusPayload>(IPC_EVENTS.SIDECAR_STATUS, callback),
		onExtensionUi: (callback: (request: ExtensionUIRequest) => void) =>
			subscribe<{ request: ExtensionUIRequest }>(IPC_EVENTS.EXTENSION_UI, data => callback(data.request)),
		onHostToolCall: (callback: (request: HostToolCallRequest) => void) =>
			subscribe<{ request: HostToolCallRequest }>(IPC_EVENTS.HOST_TOOL_CALL, data => callback(data.request)),
		onHostUriRequest: (callback: (request: HostUriRequest) => void) =>
			subscribe<{ request: HostUriRequest }>(IPC_EVENTS.HOST_URI_REQUEST, data => callback(data.request)),
		onSubagentFrame: (callback: (frame: SubagentFrame) => void) =>
			subscribe<{ frame: SubagentFrame }>(IPC_EVENTS.SUBAGENT_FRAME, data => callback(data.frame)),
		onCommandsUpdate: (callback: (commands: AvailableCommand[]) => void) =>
			subscribe<{ commands: AvailableCommand[] }>(IPC_EVENTS.COMMANDS_UPDATE, data => callback(data.commands)),
		onConfigUpdate: (callback: (payload: ConfigUpdateFrame) => void) =>
			subscribe<ConfigUpdateFrame>(IPC_EVENTS.CONFIG_UPDATE, data => callback(data)),
		onSessionsChanged: (callback: () => void) => subscribe<undefined>(IPC_EVENTS.SESSIONS_CHANGED, () => callback()),
		onLogLines: (callback: (lines: string[]) => void) => subscribe<string[]>(IPC_EVENTS.LOG_LINE, callback),
		onMenuAction: (callback: (action: MenuAction, payload?: MenuActionPayload) => void) =>
			subscribe<{ action: MenuAction } & MenuActionPayload>(IPC_EVENTS.MENU_ACTION, data =>
				callback(data.action, data),
			),
		onDeepLink: (callback: (link: DeepLinkPayload) => void) =>
			subscribe<DeepLinkPayload>(IPC_EVENTS.DEEP_LINK, callback),
	},

	ui: {
		respondExtensionUi: (response: ExtensionUIResponse) => {
			ipcRenderer.invoke(IPC_COMMANDS.EXTENSION_UI_RESPOND, { response });
		},
		sendHostToolResult: (result: HostToolResult) => {
			ipcRenderer.invoke(IPC_COMMANDS.HOST_TOOL_RESULT, { result });
		},
		sendHostToolUpdate: (update: HostToolUpdate) => {
			ipcRenderer.invoke(IPC_COMMANDS.HOST_TOOL_UPDATE, { update });
		},
		sendHostUriResult: (result: HostUriResult) => {
			ipcRenderer.invoke(IPC_COMMANDS.HOST_URI_RESULT, { result });
		},
	},

	sessions: {
		list: (scope: "local" | "global") =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSIONS_LIST, { scope }) as Promise<SessionInfo[]>,
		delete: (sessionPath: string) =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSIONS_DELETE, { sessionPath }) as Promise<void>,
		search: (query: string, scope: "local" | "global") =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSIONS_SEARCH, { query, scope }) as Promise<string[]>,
		openInNewWindow: (payload: IpcSessionOpenNewWindowPayload) =>
			ipcRenderer.invoke(IPC_COMMANDS.SESSION_OPEN_NEW_WINDOW, payload) as Promise<boolean>,
		consumePendingOpen: () => ipcRenderer.invoke(IPC_COMMANDS.SESSION_CONSUME_PENDING) as Promise<string | null>,
	},

	stats: {
		fetch: (path: string, params?: Record<string, string>) =>
			ipcRenderer.invoke(IPC_COMMANDS.STATS_FETCH, { path, params }),
	},

	system: {
		openExternal: (url: string) => ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_OPEN_EXTERNAL, url),
		showSaveDialog: (defaultPath?: string) => ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_SAVE_DIALOG, defaultPath),
		showOpenDialog: (filters?: { name: string; extensions: string[] }[]) =>
			ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_OPEN_DIALOG, filters),
		clipboardRead: () => ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_CLIPBOARD_READ),
		notify: (title: string, body?: string) => {
			ipcRenderer.invoke(IPC_COMMANDS.SYSTEM_NOTIFY, { title, body });
		},
	},

	prefs: {
		get: (key?: string) => ipcRenderer.invoke(IPC_COMMANDS.PREFS_GET, { key }),
		set: (key: string, value: unknown) => ipcRenderer.invoke(IPC_COMMANDS.PREFS_SET, { key, value }),
	},

	sidecar: {
		restart: (sessionPath?: string) => ipcRenderer.invoke(IPC_COMMANDS.SIDECAR_RESTART, { sessionPath }),
		selectProject: () => ipcRenderer.invoke(IPC_COMMANDS.SIDECAR_SELECT_PROJECT),
		setProject: (cwd: string) => ipcRenderer.invoke(IPC_COMMANDS.SIDECAR_SET_PROJECT, { cwd }),
		getStatus: () => ipcRenderer.invoke(IPC_COMMANDS.SIDECAR_STATUS_GET),
	},

	tray: {
		pushState: (state: TrayState) => ipcRenderer.send(IPC_EVENTS.TRAY_STATE_PUSH, state),
	},

	progress: {
		set: (state: RunProgressState) => ipcRenderer.send(IPC_EVENTS.PROGRESS_SET, state),
	},

	models: {
		listProviders: () => ipcRenderer.invoke(IPC_COMMANDS.MODELS_PROVIDERS_LIST) as Promise<CustomProviderView[]>,
		upsertProvider: (input: CustomProviderInput) =>
			ipcRenderer.invoke(IPC_COMMANDS.MODELS_PROVIDER_UPSERT, input) as Promise<void>,
		deleteProvider: (id: string) => ipcRenderer.invoke(IPC_COMMANDS.MODELS_PROVIDER_DELETE, id) as Promise<void>,
		openConfig: () =>
			ipcRenderer.invoke(IPC_COMMANDS.MODELS_CONFIG_OPEN) as Promise<{ path: string; opened: boolean }>,
	},

	fs: {
		list: (path?: string, maxDepth?: number, maxEntries?: number) =>
			ipcRenderer.invoke(IPC_COMMANDS.FS_LIST, { path, maxDepth, maxEntries }) as Promise<IpcFsListResult>,
		read: (path: string, maxBytes?: number) =>
			ipcRenderer.invoke(IPC_COMMANDS.FS_READ, { path, maxBytes }) as Promise<IpcFsReadResult>,
		readPlan: (payload: IpcFsReadPlanPayload) =>
			ipcRenderer.invoke(IPC_COMMANDS.FS_READ_PLAN, payload) as Promise<IpcFsReadPlanResult>,
	},
};

contextBridge.exposeInMainWorld("omp", api);
