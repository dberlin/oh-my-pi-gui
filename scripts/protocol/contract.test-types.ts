/** Negative probes are compiled by check:protocol, never loaded at runtime. */
import type { Assert, Compatible, SuccessData } from "./contract";
import type * as Core from "omp-core-rpc";
import type * as Gui from "../../src/shared/rpc-types";
import type { Wire } from "./contract";

// @ts-expect-error A missing producer must not satisfy a consumer via never.
export type MissingProducer = Assert<Compatible<{ rows: string[] }, never>>;
// @ts-expect-error An empty consumer must not mask a missing contract.
export type MissingConsumer = Assert<Compatible<never, { rows: string[] }>>;
// @ts-expect-error Unresolved or untyped producers cannot bypass the check.
export type UntypedProducer = Assert<Compatible<{ rows: string[] }, unknown>>;
// @ts-expect-error An any producer is no more proof than an unknown producer.
export type AnyProducer = Assert<Compatible<{ rows: string[] }, any>>;
// @ts-expect-error A changed payload field must fail the real directional check.
export type WrongPayload = Assert<Compatible<{ totalMessages: number }, { totalMessages: string }>>;
// @ts-expect-error Whole unions, not their convenient overlap, must be accepted.
export type PartialUnion = Assert<Compatible<{ mode: "steer" }, { mode: "steer" | "followUp" }>>;
// @ts-expect-error Fork-only commands do not have canonical success data.
export type ForkReply = SuccessData<"get_queue">;
export type RealPagination = Assert<Compatible<{ totalMessages: number }, SuccessData<"get_messages_page">>>;

// Pin the full discriminated unions as well as the response-level contracts.
export type MessageRoles = Assert<
	Compatible<Gui.AgentMessage["role"], Wire<SuccessData<"get_messages">["messages"][number]["role"]>>
>;
export type MessageContent = Assert<
	Compatible<
		NonNullable<Gui.AgentMessage["content"]>,
		SuccessData<"get_messages">["messages"][number] extends infer Message
			? Message extends { content: infer Content }
				? Content
				: never
			: never
	>
>;
export type FullStream = Assert<Compatible<Gui.AgentSessionEvent, Wire<Core.RpcAgentSessionEventFrame>>>;
export type MissingDescription = Assert<Compatible<Gui.AvailableCommand, { name: string; source: "extension" }>>;
// @ts-expect-error Unknown content discriminators are not supported message blocks.
export type UnknownContent = Assert<Compatible<Gui.MessageContent, { type: "unrecognized"; text: string }>>;
// @ts-expect-error Unknown assistant events must not silently bypass stream coverage.
export type UnknownAssistantEvent = Assert<Compatible<Gui.AssistantMessageEvent, { type: "unrecognized" }>>;
