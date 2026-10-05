/** Compile-time directional contracts for the adjacent vanilla producer. */
import type * as Core from "omp-core-rpc";
import type * as Gui from "../../src/shared/rpc-types";

// Enum members cross JSON as primitives, not nominal TypeScript enum types.
export type Wire<T> = T extends string ? `${T}` : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
export type Assert<T extends true> = T;
/** Check the entire producer; absent or untyped data is not a valid proof. */
export type Compatible<Consumer, Producer> = [Consumer] extends [never]
	? false
	: [Producer] extends [never]
		? false
		: unknown extends Producer
			? false
			: [Producer] extends [Consumer]
				? true
				: false;

type Success = Extract<Core.RpcResponse, { success: true }>;
type DataSuccess = Extract<Success, { data: unknown }>;
export type SuccessData<Command extends DataSuccess["command"]> = Wire<
	Extract<DataSuccess, { command: Command }>["data"]
>;

type CommonCommand = Extract<Gui.RpcCommand, { type: Core.RpcCommand["type"] }>;
// Extension commands are deliberately not claimed as upstream-supported. Their
// runtime adapters must either implement them honestly or return explicit errors.
export type Commands = Assert<Compatible<Wire<Core.RpcCommand>, CommonCommand>>;
// A disappeared upstream command cannot make the overlap check vacuously pass.
type RequiredCommands =
	| "negotiate_protocol"
	| "prompt"
	| "get_state"
	| "set_model"
	| "set_thinking_level"
	| "get_messages_page"
	| "get_session_stats"
	| "bash"
	| "switch_session"
	| "set_host_tools";
export type CommandCoverage = Assert<Compatible<Core.RpcCommand["type"], RequiredCommands>>;
export type ResponseEnvelope = Assert<Compatible<Gui.RpcResponse, Wire<Core.RpcResponse>>>;
export type State = Assert<Compatible<Gui.RpcSessionState, SuccessData<"get_state">>>;
export type Stats = Assert<Compatible<Gui.SessionStats, SuccessData<"get_session_stats">>>;
export type Messages = Assert<Compatible<{ messages: Gui.AgentMessage[] }, SuccessData<"get_messages">>>;
export type Pagination = Assert<Compatible<Gui.MessagesPage, SuccessData<"get_messages_page">>>;
export type Model = Assert<Compatible<Gui.ModelInfo, SuccessData<"set_model">>>;
export type Models = Assert<Compatible<{ models: Gui.ModelInfo[] }, SuccessData<"get_available_models">>>;
export type AvailableCommands = Assert<
	Compatible<{ commands: Gui.AvailableCommand[] }, SuccessData<"get_available_commands">>
>;
export type LoginProviders = Assert<Compatible<{ providers: Gui.LoginProvider[] }, SuccessData<"get_login_providers">>>;
export type Subagents = Assert<Compatible<{ subagents: Gui.SubagentSnapshot[] }, SuccessData<"get_subagents">>>;
export type ThinkingLevels = Assert<
	Compatible<{ levels: Gui.ThinkingLevel[] }, SuccessData<"get_available_thinking_levels">>
>;
export type Ready = Assert<Compatible<Gui.RpcReadyFrame, Wire<Core.RpcReadyFrame>>>;
export type Chunk = Assert<Compatible<Gui.RpcChunkFrame, Wire<Core.RpcChunkFrame>>>;
export type PromptResult = Assert<Compatible<Gui.PromptResultFrame, Wire<Core.RpcPromptResultFrame>>>;
export type SessionSettled = Assert<Compatible<Gui.SessionSettledFrame, Wire<Core.RpcSessionSettledFrame>>>;
export type HostToolCall = Assert<Compatible<Gui.HostToolCallRequest, Wire<Core.RpcHostToolCallRequest>>>;
export type HostToolCancel = Assert<Compatible<Gui.HostToolCancelRequest, Wire<Core.RpcHostToolCancelRequest>>>;
export type HostToolResult = Assert<Compatible<Wire<Core.RpcHostToolResult>, Gui.HostToolResult>>;
export type HostToolUpdate = Assert<Compatible<Wire<Core.RpcHostToolUpdate>, Gui.HostToolUpdate>>;
export type HostUriRequest = Assert<Compatible<Gui.HostUriRequest, Wire<Core.RpcHostUriRequest>>>;
export type HostUriCancel = Assert<Compatible<Gui.HostUriCancelRequest, Wire<Core.RpcHostUriCancelRequest>>>;
export type HostUriResult = Assert<Compatible<Wire<Core.RpcHostUriResult>, Gui.HostUriResult>>;
export type ExtensionRequests = Assert<Compatible<Gui.ExtensionUIRequest, Wire<Core.RpcExtensionUIRequest>>>;
export type ExtensionResponses = Assert<
	Compatible<
		Wire<Core.RpcExtensionUIResponse>,
		Extract<
			Gui.ExtensionUIResponse,
			{ value: string } | { confirmed: boolean } | { answers: unknown } | { cancelled: true }
		>
	>
>;
// Check the full producer stream, including vanilla text queues. Display-only
// metadata may be unconsumed, but it must remain representable and forwarded.
export type Stream = Assert<Compatible<Gui.AgentSessionEvent, Wire<Core.RpcAgentSessionEventFrame>>>;
export type MessageStream = Assert<Compatible<Gui.AgentSessionEvent, Wire<Core.RpcMessageEventFrame>>>;
export type SubagentStream = Assert<Compatible<Gui.SubagentFrame, Wire<Core.RpcSubagentFrame>>>;
export type CommandUpdates = Assert<
	Compatible<Gui.AvailableCommandsUpdateFrame, Wire<Core.RpcAvailableCommandsUpdateFrame>>
>;
