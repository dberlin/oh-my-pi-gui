/**
 * RPC protocol types for the omp GUI sidecar connection.
 * Hand-written from verified source (rpc-types.ts, rpc-mode.ts).
 * These are the wire types — no runtime dependency on @oh-my-pi/*.
 */

// ============================================================================
// RPC Commands (GUI → omp stdin)
// ============================================================================

export type RpcCommand =
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: HostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: HostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: SubagentSubscriptionLevel }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "eval"; language?: "python" | "js" | "ruby" | "julia"; code: string; excluded?: boolean }
	| { id?: string; type: "abort_eval" }
	| { id?: string; type: "dequeue" }
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "fork" }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "set_entry_label"; entryId: string; label?: string }
	| { id?: string; type: "handoff"; customInstructions?: string }
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "logout"; providerId: string }
	| { id?: string; type: "get_usage" }
	| { id?: string; type: "get_settings_schema" }
	| { id?: string; type: "get_settings"; paths?: string[] }
	| { id?: string; type: "set_setting"; path: string; value: unknown }
	| { id?: string; type: "get_providers" }
	| { id?: string; type: "set_plan_mode"; enabled: boolean }
	| { id?: string; type: "get_plan_mode" }
	| { id?: string; type: "get_model_roles" }
	| { id?: string; type: "set_model_role"; role: string; modelId: string | null }
	| { id?: string; type: "get_model_role_metadata" }

	// Domain inspection (read-only)
	| { id?: string; type: "get_skills" }
	| { id?: string; type: "get_hooks" }
	| { id?: string; type: "get_mcp_servers" }
	| { id?: string; type: "get_plugins" }
	| { id?: string; type: "get_marketplaces" }
	| { id?: string; type: "get_prompt_templates" }
	| { id?: string; type: "get_memory_report" }
	| { id?: string; type: "get_session_tree" }
	| { id?: string; type: "get_themes" }
	| { id?: string; type: "get_transcript" }

	// Plan approval (structured)
	| { id?: string; type: "plan_approval"; approved: boolean; option?: "execute" | "compact" | "keep_context"; feedback?: string }

	// Modes
	| { id?: string; type: "get_vibe_mode" }
	| { id?: string; type: "set_vibe_mode"; enabled: boolean }
	| { id?: string; type: "get_goal" }
	| { id?: string; type: "set_goal"; objective?: string; tokenBudget?: number | null; action?: "pause" | "resume" | "drop" }
	| { id?: string; type: "get_loop_mode" }
	| { id?: string; type: "set_loop_mode"; enabled: boolean; args?: string }

	// Domain actions (mutating)
	| { id?: string; type: "set_skill_enabled"; name: string; enabled: boolean }
	| { id?: string; type: "set_hook_enabled"; hookId: string; enabled: boolean }
	| { id?: string; type: "set_plugin_enabled"; pluginId: string; enabled: boolean; scope?: "user" | "project" }
	| { id?: string; type: "mcp_action"; name: string; action: "enable" | "disable" | "reconnect" | "remove"; scope?: "user" | "project" };

// ============================================================================
// RPC Responses (omp stdout → GUI)
// ============================================================================

export interface RpcResponseSuccess {
	id?: string;
	type: "response";
	command: string;
	success: true;
	data?: unknown;
}

export interface RpcResponseError {
	id?: string;
	type: "response";
	command: string;
	success: false;
	error: string;
	code?: string;
}

export type RpcResponse = RpcResponseSuccess | RpcResponseError;

// ============================================================================
// Domain inspection results (read-only)
// ============================================================================

/** A discoverable skill with its session enable state. */
export interface RpcSkillInfo {
	name: string;
	description: string;
	/** "<provider>:<level>", e.g. "native:project", "claude:user". */
	source: string;
	enabled: boolean;
	location: string;
}
export interface RpcSkillsResult {
	skills: RpcSkillInfo[];
}

/** A discovered pre/post tool hook. */
export interface RpcHookInfo {
	/** Stable id used by `disabledExtensions`: "hook:<type>:<tool>:<name>". */
	id: string;
	name: string;
	/** Hook event: "<pre|post>:<tool>", e.g. "pre:bash". */
	event: string;
	enabled: boolean;
	source: string;
	path: string;
}
export interface RpcHooksResult {
	hooks: RpcHookInfo[];
}

/** A configured or discovered MCP server with live connection state. */
export interface RpcMcpServerInfo {
	name: string;
	transport: "stdio" | "http" | "sse" | "unknown";
	status: "connected" | "connecting" | "disconnected";
	toolCount: number;
	enabled: boolean;
	authed: boolean;
}
export interface RpcMcpServersResult {
	servers: RpcMcpServerInfo[];
}

/** An installed plugin (npm package or marketplace install). */
export interface RpcPluginInfo {
	name: string;
	marketplace: string;
	enabled: boolean;
	version: string;
	id?: string;
	scope?: "user" | "project";
	shadowedBy?: "project";
}
export interface RpcPluginsResult {
	plugins: RpcPluginInfo[];
}

/** A configured marketplace source. */
export interface RpcMarketplaceInfo {
	name: string;
	source: string;
	pluginCount?: number;
}
export interface RpcMarketplacesResult {
	marketplaces: RpcMarketplaceInfo[];
}

/** A file-based prompt template. */
export interface RpcPromptTemplateInfo {
	name: string;
	description: string;
	source: string;
	argumentHint?: string;
}
export interface RpcPromptTemplatesResult {
	templates: RpcPromptTemplateInfo[];
}

/** Structured memory backend status (mirrors MemoryBackendStatus). */
export interface RpcMemoryStatus {
	active: boolean;
	writable: boolean;
	searchable: boolean;
	scope?: string;
	retainBank?: string;
	recallBanks?: string[];
	workingCount?: number;
	episodicCount?: number;
	tripleCount?: number;
	lastMemory?: string;
	lastRecall?: boolean;
	database?: string;
	message?: string;
	error?: string;
}
/** Read-only memory backend report. */
export interface RpcMemoryReport {
	backend: string;
	entryCount?: number;
	status?: RpcMemoryStatus;
	stats?: string;
	diagnosis?: string;
}

/** A node in the session's branch tree (visual session navigation). */
export interface RpcSessionTreeNode {
	entryId: string;
	parentId: string | null;
	role: "user" | "assistant" | "system";
	textPreview: string;
	timestamp: number;
	label?: string;
	onActiveBranch: boolean;
	isLeaf: boolean;
}
export interface RpcSessionTreeResult {
	tree: RpcSessionTreeNode[];
	activeLeafId: string | null;
}

export interface RpcThemeInfo {
	name: string;
	path?: string;
}
export interface RpcThemesResult {
	themes: RpcThemeInfo[];
}

export interface RpcVibeModeState {
	enabled: boolean;
	killedWorkers?: number;
}
export interface RpcGoalState {
	enabled: boolean;
	status: string;
	objective?: string;
	tokenBudget?: number | null;
	tokensUsed?: number;
	timeUsedSeconds?: number;
	mode?: string;
}
export type RpcLoopLimit =
	| { kind: "iterations"; initial: number; remaining: number }
	| { kind: "duration"; durationMs: number; deadlineMs: number };
export interface RpcLoopModeState {
	enabled: boolean;
	state: "off" | "waiting" | "running" | "paused";
	prompt?: string;
	limit?: RpcLoopLimit;
}

// ============================================================================
// Ready Frame
// ============================================================================

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: number;
	supportedProtocolVersions: number[];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

// ============================================================================
// Chunk Frame (v2 transport)
// ============================================================================

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string; // base64
}

// ============================================================================
// Session State
// ============================================================================

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
	percent: number;
}

export interface ModelInfo {
	provider: string;
	id: string;
}

export interface RpcSessionState {
	model: ModelInfo | null;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile: string | null;
	cwd: string;
	sessionId: string;
	sessionName: string | null;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	autoCompactionEnabled: boolean;
	autoRetryEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	systemPrompt: string[];
	dumpTools: ToolDump[];
	contextUsage: ContextUsage | null;
	planModeEnabled: boolean;
}

export interface ToolDump {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

// ============================================================================
// Extension UI
// ============================================================================

export interface ExtensionAskDialogOption {
	label: string;
	description?: string;
}
export interface ExtensionAskDialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: ExtensionAskDialogOption[];
	multi?: boolean;
	recommended?: number;
}
export interface ExtensionAskDialogResultItem {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
}
export interface ExtensionAskDialogResult {
	results: ExtensionAskDialogResultItem[];
}

export type ExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "askDialog";
			questions: ExtensionAskDialogQuestion[];
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines?: string[];
			widgetPlacement?: string;
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			launchUrl?: string;
			instructions?: string;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string };

export type ExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; askDialog: ExtensionAskDialogResult }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Host Tools & URIs
// ============================================================================

export interface HostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
}

export interface HostToolCallRequest {
	type: "host_tool_call";
	callId: string;
	name: string;
	args: Record<string, unknown>;
}

export interface HostToolCancelRequest {
	type: "host_tool_cancel";
	callId: string;
}

export interface HostToolResult {
	type: "host_tool_result";
	callId: string;
	result?: string;
	error?: string;
}

export interface HostToolUpdate {
	type: "host_tool_update";
	callId: string;
	update: string;
}

export interface HostUriSchemeDefinition {
	scheme: string;
	description: string;
	writable?: boolean;
	immutable?: boolean;
}

export interface HostUriRequest {
	type: "host_uri_request";
	requestId: string;
	url: string;
	operation: "read" | "write";
	content?: string;
}

export interface HostUriCancelRequest {
	type: "host_uri_cancel";
	requestId: string;
}

export interface HostUriResult {
	type: "host_uri_result";
	requestId: string;
	content?: string;
	error?: string;
}

// ============================================================================
// Subagents
// ============================================================================

export type SubagentSubscriptionLevel = "off" | "progress" | "events";

export interface SubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: string;
	description?: string;
	status: "started" | "completed" | "failed" | "cancelled";
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate?: string;
	progress?: AgentProgress;
	parentToolCallId?: string;
	/** Present when spawned by another subagent (absent = root spawn from main session). */
	parentSubagentId?: string;
}

export interface AgentProgress {
	status: string;
	description?: string;
}

export interface SubagentLifecycleFrame {
	type: "subagent_lifecycle";
	id: string;
	index: number;
	agent: string;
	agentSource: string;
	description?: string;
	status: "started" | "completed" | "failed" | "cancelled";
	task?: string;
	assignment?: string;
	sessionFile?: string;
	parentToolCallId?: string;
	parentSubagentId?: string;
}

export interface SubagentProgressFrame {
	type: "subagent_progress";
	progress: AgentProgress;
	index: number;
	agent: string;
	agentSource: string;
	task?: string;
	assignment?: string;
	sessionFile?: string;
	parentToolCallId?: string;
	parentSubagentId?: string;
}

export interface SubagentEventFrame {
	type: "subagent_event";
	id: string;
	event: AgentSessionEvent;
}

export type SubagentFrame = SubagentLifecycleFrame | SubagentProgressFrame | SubagentEventFrame;

// ============================================================================
// Shared Value Types
// ============================================================================

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}

export interface TodoTask {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
}

// ============================================================================
// Messages (simplified wire format)
// ============================================================================

export interface AgentMessage {
	role:
		| "user"
		| "assistant"
		| "system"
		| "toolResult"
		| "bashExecution"
		| "pythonExecution"
		| "custom"
		| "hookMessage"
		| "branchSummary"
		| "compactionSummary"
		| "fileMention";
	content?: MessageContent[] | string;
	steering?: boolean;
	stopReason?: string;
	errorMessage?: string;
	errorId?: number;
	timestamp?: string | number;
	command?: string;
	code?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	truncated?: boolean;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
	excludeFromContext?: boolean;
	customType?: string;
	display?: boolean;
	summary?: string;
	shortSummary?: string;
	tokensBefore?: number;
	files?: Array<{
		path: string;
		content: string;
		lineCount?: number;
		byteSize?: number;
		skippedReason?: "tooLarge" | "binary";
		image?: ImageContent;
	}>;
	[key: string]: unknown;
}

export type MessageContent = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface TextContent {
	type: "text";
	text: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	partialArgs?: string;
	streamIndex?: number;
	intent?: string;
}

// ============================================================================
// Messages Page
// ============================================================================

export interface MessagesPage {
	messages: AgentMessage[];
	totalMessages: number;
	nextCursor?: string;
}

// ============================================================================
// Available Commands
// ============================================================================

export interface AvailableCommand {
	name: string;
	description: string;
	aliases?: string[];
	/** Input hint (ghost text) for commands that take a simple argument. */
	input?: { hint?: string };
	/** Declarative subcommands for dropdown completion (e.g. /mcp add). */
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	/** Where the command came from (builtin, skill, extension, custom, mcp_prompt, file). */
	source?: string;
}

// ============================================================================
// Login Providers
// ============================================================================

export interface LoginProvider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

// ============================================================================
// Usage (provider quotas + local session tallies)
// ============================================================================

export interface UsageLimit {
	id: string;
	label: string;
	usedFraction?: number;
	used?: number;
	limit?: number;
	unit?: string;
	remainingFraction?: number;
	windowLabel?: string;
	resetsAt?: number;
	status?: string;
	notes?: string[];
}

export interface UsageReport {
	provider: string;
	fetchedAt: number;
	limits: UsageLimit[];
	notes?: string[];
	account?: string;
	resetCreditsAvailable?: number;
}

export interface UsageSessionStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	orchestrationTokens: number;
	premiumRequests: number;
	cost: number;
}

export interface UsageResult {
	reports: UsageReport[];
	session: UsageSessionStats;
}

// ============================================================================
// Settings schema
// ============================================================================

export interface SettingEntry {
	path: string;
	type: "boolean" | "string" | "number" | "enum" | "array" | "record";
	value: unknown;
	default: unknown;
	label?: string;
	description?: string;
	tab?: string;
	group?: string;
	options?: Array<{ value: string; label: string; description?: string }>;
	secret?: boolean;
	advanced?: boolean;
	/** Visibility gate name; hidden only when the GUI can evaluate it to false. */
	condition?: string;
	/** True when array order is meaningful and the editor supports reordering. */
	ordered?: boolean;
}

export interface SettingsSchemaResult {
	entries: SettingEntry[];
	tabs: Array<{ id: string; label: string; groups: string[] }>;
}

// ============================================================================
// Providers
// ============================================================================

export interface ProviderInfo {
	id: string;
	name: string;
	authenticated: boolean;
	authKind?: "oauth" | "apikey" | "env";
	account?: string;
	oauth: boolean;
	disabled: boolean;
	baseUrl?: string;
	modelCount: number;
}

export interface ProvidersResult {
	providers: ProviderInfo[];
}

// ============================================================================
// Plan Mode
// ============================================================================

export interface PlanModeState {
	enabled: boolean;
	planFilePath?: string;
}

// ============================================================================
// Model Roles
// ============================================================================

export interface ModelRoleEntry {
	id: string;
	name: string;
	tag: string;
	color: string;
	model?: string;
	source: string;
}

export interface ModelRolesResult {
	roles: ModelRoleEntry[];
}

export interface ModelRoleMetadata {
	id: string;
	name: string;
	tag: string;
	color: string;
	hidden?: boolean;
}

export interface ModelRoleMetadataResult {
	roles: ModelRoleMetadata[];
}

// ============================================================================
// Session Stats
// ============================================================================

export interface SessionStats {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: ContextUsage;
}

// ============================================================================
// Outbound Frame Union (everything omp can emit on stdout)
// ============================================================================

export type OutboundFrame =
	| RpcReadyFrame
	| RpcResponse
	| RpcChunkFrame
	| AgentSessionEvent
	| ExtensionUIRequest
	| HostToolCallRequest
	| HostToolCancelRequest
	| HostUriRequest
	| HostUriCancelRequest
	| SubagentFrame
	| AvailableCommandsUpdateFrame
	| PromptResultFrame
	| CommandOutputFrame
	| SessionInfoUpdateFrame
	| ConfigUpdateFrame
	| ExtensionErrorFrame;

export interface AvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: AvailableCommand[];
}

export interface PromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface CommandOutputFrame {
	type: "command_output";
	[key: string]: unknown;
}

export interface SessionInfoUpdateFrame {
	type: "session_info_update";
	[key: string]: unknown;
}

export interface ConfigUpdateFrame {
	type: "config_update";
	[key: string]: unknown;
}

export interface ExtensionErrorFrame {
	type: "extension_error";
	extensionPath: string;
	event: string;
	error: string;
}

// ============================================================================
// AgentSessionEvent (24 types)
// ============================================================================

export type AgentSessionEvent =
	| { type: "agent_start"; sessionId?: string }
	| { type: "agent_end"; messages?: AgentMessage[]; isTerminal?: boolean; telemetry?: unknown; coverage?: unknown }
	| { type: "turn_start" }
	| { type: "turn_end"; message?: AgentMessage; toolResults?: unknown[] }
	| { type: "message_start"; message: AgentMessage }
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			intent?: string;
	  }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: unknown;
	  }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
	| { type: "auto_compaction_start"; reason: "threshold" | "overflow" | "idle" | "incomplete"; action: string }
	| {
			type: "auto_compaction_end";
			action: string;
			result: unknown;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			skipped?: boolean;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
			errorId?: number;
	  }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string; recoveredErrors?: unknown[] }
	| { type: "retry_fallback_applied"; from: string; to: string; role: string }
	| { type: "retry_fallback_succeeded"; model: string; role: string }
	| { type: "model_changed" }
	| { type: "ttsr_triggered"; rules: unknown[] }
	| { type: "todo_reminder"; todos: TodoTask[]; attempt: number; maxAttempts: number }
	| { type: "todo_auto_clear" }
	| { type: "irc_message"; message: unknown }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| {
			type: "thinking_level_changed";
			thinkingLevel: ThinkingLevel | undefined;
			configured?: string;
			resolved?: string;
	  }
	| { type: "goal_updated"; goal: unknown; state?: unknown }
	| { type: "plan_proposal"; planFilePath: string; title?: string; planContent: string; options: string[] }
	| { type: "loop_mode_update"; state: RpcLoopModeState };

export type AssistantMessageEvent =
	| { type: "text_delta"; delta: string }
	| { type: "thinking_delta"; delta: string }
	| { type: "toolcall_delta"; toolCallId: string; name?: string; argsDelta?: string };

// ============================================================================
// Sidecar Status
// ============================================================================

export type SidecarStatus = "starting" | "ready" | "exited" | "error" | "restarting";
