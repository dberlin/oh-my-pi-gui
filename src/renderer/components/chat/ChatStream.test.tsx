import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, ToolCallContent } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { groupReadRows } from "../../lib/read-group";
import * as RuntimeErrors from "../../lib/runtime-errors";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { TodoSnapshot } from "../../stores/todo";
import { useTodoStore } from "../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import * as ToolRegistry from "../tools";
import { ChatStream } from "./ChatStream";
import {
	buildConversationAnchors,
	buildHistoryRowKeys,
	buildHistoryRows,
	buildTranscriptRowKeys,
	claimRowEntrances,
	createRowEntranceState,
	findConversationAnchorIndex,
	hasStreamingTranscriptContent,
	isTranscriptAtLiveEdge,
	LIVE_EDGE_SLACK_PX,
	mergeTodoSnapshots,
	ROW_ENTRANCE_TAIL_ROWS,
	shouldRePinTranscript,
	type RowEntranceState,
} from "./chat-stream-utils";

const { document, window, Event, CustomEvent, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (handle: number) => clearTimeout(handle),
	ResizeObserver: class {
		readonly #callback: (
			entries: Array<{
				target: { getAttribute: (name: string) => string | null };
				contentRect: { width: number; height: number };
			}>,
		) => void;

		constructor(
			callback: (
				entries: Array<{
					target: { getAttribute: (name: string) => string | null };
					contentRect: { width: number; height: number };
				}>,
			) => void,
		) {
			this.#callback = callback;
		}

		observe(target: { getAttribute: (name: string) => string | null }): void {
			this.#callback([{ target, contentRect: { width: 1000, height: 800 } }]);
		}

		unobserve(): void {}

		disconnect(): void {}
	},
});
Object.assign(HTMLElement.prototype, {
	clientHeight: 800,
	clientWidth: 1000,
	scrollHeight: 1600,
	scrollWidth: 1000,
	getBoundingClientRect: () => ({
		width: 1000,
		height: 80,
		top: 0,
		right: 1000,
		bottom: 80,
		left: 0,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	}),
	scrollTo: () => {},
});

interface TestElement {
	parentElement: TestElement | null;
	textContent: string | null;
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

let container: TestElement | undefined;
let root: Root | undefined;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
		await promise;
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
	}
	container?.remove();
	container = undefined;
	root = undefined;
	useMessagesStore.getState().reset();
	useQueueStore.setState({ steering: [], followUp: [] });
	useSessionStore.getState().reset();
	useSettingsStore.getState().reset();
	useTabsStore.getState().reset();
	useTodoStore.getState().reset();
	useToolsStore.getState().reset();
	setFocusedSessionRuntime(null);
	useUiStore.setState({ thinkingExpanded: false, transcriptDetail: "compact" });
	vi.restoreAllMocks();
});
const at = "2026-08-05T04:00:00.000Z";

function assistant(content: AgentMessage["content"]): AgentMessage {
	return { role: "assistant", content, timestamp: at };
}

function toolResult(toolCallId: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "test",
		content: [{ type: "text", text: "result" }],
		isError,
		timestamp: at,
	};
}

const toolRun: AgentMessage[] = [
	assistant([
		{ type: "text", text: "I will inspect the source." },
		{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/a.ts" } },
	]),
	toolResult("call-read"),
	assistant([{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "src/a.ts" } }]),
	toolResult("call-write"),
	assistant([{ type: "text", text: "Implemented and verified." }]),
];

describe("compact transcript rows", () => {
	it("keeps completed read and write tool calls visible in compact history", () => {
		const rows = buildHistoryRows(toolRun, "compact");
		expect(rows.map(row => row.kind)).toEqual(["message", "message", "message"]);

		const readRow = rows[0];
		const writeRow = rows[1];
		const answerRow = rows[2];
		if (readRow?.kind !== "message" || writeRow?.kind !== "message" || answerRow?.kind !== "message") {
			throw new Error("visible tool history rows missing");
		}
		expect(readRow.message.content).toEqual([
			{ type: "text", text: "I will inspect the source." },
			{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "src/a.ts" } },
		]);
		expect(writeRow.message.content).toEqual([
			{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "src/a.ts" } },
		]);
		expect(answerRow.message.content).toEqual([{ type: "text", text: "Implemented and verified." }]);
	});

	it("keeps narration on both sides of a grouped read in chronological order", () => {
		const call: ToolCallContent = {
			type: "toolCall",
			id: "chronology-read:0",
			name: "read",
			arguments: { path: "src/chronology.ts" },
		};
		const completedEntry: ToolEntry = {
			toolName: call.name,
			args: call.arguments,
			status: "done",
			partialResult: null,
			streamingArgs: "",
			result: "completed read",
			isError: false,
			startTime: 1,
			endTime: 2,
		};
		const resolveToolCall = (candidate: ToolCallContent) => ({
			key: candidate === call ? "chronology-read:0#1" : candidate.id,
			entry: candidate === call ? completedEntry : undefined,
		});
		const messages = [
			{
				...assistant([{ type: "text", text: "before" }, call, { type: "text", text: "after" }]),
				usage: { input: 1200, output: 300, cacheRead: 40, cacheWrite: 20, cost: { total: 0.002 } },
				model: "projection-model",
				duration: 2400,
				ttft: 350,
			},
			toolResult(call.id),
		];

		const rows = groupReadRows(buildHistoryRows(messages, "compact"), resolveToolCall);

		expect(
			rows.map(row => {
				if (row.kind === "message") return { kind: row.kind, content: row.message.content };
				if (row.kind === "readGroup") {
					return { kind: row.kind, toolKeys: row.entries.map(entry => entry.toolKey) };
				}
				return { kind: row.kind };
			}),
		).toEqual([
			{ kind: "message", content: [{ type: "text", text: "before" }] },
			{ kind: "readGroup", toolKeys: ["chronology-read:0#1"] },
			{ kind: "message", content: [{ type: "text", text: "after" }] },
		]);

		const [beforeRow, readGroup, afterRow] = rows;
		if (beforeRow?.kind !== "message" || readGroup?.kind !== "readGroup" || afterRow?.kind !== "message") {
			throw new Error("grouped read chronology rows missing");
		}
		expect([
			{
				usage: beforeRow.message.usage,
				model: beforeRow.message.model,
				duration: beforeRow.message.duration,
				ttft: beforeRow.message.ttft,
			},
			{
				usage: afterRow.message.usage,
				model: afterRow.message.model,
				duration: afterRow.message.duration,
				ttft: afterRow.message.ttft,
			},
		]).toEqual([
			{ usage: undefined, model: undefined, duration: undefined, ttft: undefined },
			{
				usage: { input: 1200, output: 300, cacheRead: 40, cacheWrite: 20, cost: { total: 0.002 } },
				model: "projection-model",
				duration: 2400,
				ttft: 350,
			},
		]);
		expect(readGroup.usage).toBeUndefined();
	});

	it("splits only thinking into process and keeps narration and tool visible in chronological order", () => {
		const rows = buildHistoryRows(
			[
				assistant([
					{ type: "thinking", thinking: "Check the boundary first." },
					{ type: "text", text: "Inspect the public surface." },
					{
						type: "toolCall",
						id: "call-grep",
						name: "grep",
						arguments: { pattern: "public", path: "src/a.ts" },
					},
				]),
			],
			"compact",
		);
		expect(rows.map(row => row.kind)).toEqual(["process", "message"]);

		const process = rows[0];
		const visible = rows[1];
		if (process?.kind !== "process" || visible?.kind !== "message") throw new Error("split rows missing");
		expect(process.messages).toHaveLength(1);
		expect(process.messages[0]?.content).toEqual([{ type: "thinking", thinking: "Check the boundary first." }]);
		expect(visible.message.content).toEqual([
			{ type: "text", text: "Inspect the public surface." },
			{
				type: "toolCall",
				id: "call-grep",
				name: "grep",
				arguments: { pattern: "public", path: "src/a.ts" },
			},
		]);
	});

	it("keeps response footer metadata only on the visible core after splitting renderable thinking", () => {
		const usage = {
			input: 2400,
			output: 600,
			cacheRead: 80,
			cacheWrite: 40,
			cost: { total: 0.004 },
		};
		const rows = buildHistoryRows(
			[
				{
					...assistant([
						{ type: "thinking", thinking: "Inspect the response boundary." },
						{ type: "text", text: "The visible answer belongs after the process." },
					]),
					usage,
					model: "split-projection-model",
					duration: 4800,
					ttft: 700,
				},
			],
			"compact",
		);

		expect(rows.map(row => row.kind)).toEqual(["process", "message"]);
		const actualRows = rows.map(row => {
			if (row.kind === "todoSnapshot") throw new Error("unexpected todo snapshot row");
			const message =
				row.kind === "process"
					? row.messages[row.messages.length - 1]
					: row.kind === "message"
						? row.message
						: row.usage?.[row.usage.length - 1];
			return {
				kind: row.kind,
				usage: message?.usage,
				model: message?.model,
				duration: message?.duration,
				ttft: message?.ttft,
			};
		});
		expect(actualRows.filter(row => row.usage !== undefined)).toHaveLength(1);
		expect(actualRows).toEqual([
			{ kind: "process", usage: undefined, model: undefined, duration: undefined, ttft: undefined },
			{
				kind: "message",
				usage,
				model: "split-projection-model",
				duration: 4800,
				ttft: 700,
			},
		]);

		const thinkingOnlyUsage = {
			input: 900,
			output: 120,
			cacheRead: 30,
			cacheWrite: 10,
			cost: { total: 0.001 },
		};
		const thinkingOnlyRows = buildHistoryRows(
			[
				{
					...assistant([{ type: "thinking", thinking: "This response has no visible core." }]),
					usage: thinkingOnlyUsage,
					model: "thinking-only-model",
					duration: 1600,
					ttft: 250,
				},
			],
			"compact",
		);
		const thinkingOnly = thinkingOnlyRows[0];
		if (thinkingOnly?.kind !== "process") throw new Error("thinking-only process row missing");
		expect(thinkingOnly.messages).toHaveLength(1);
		expect({
			usage: thinkingOnly.messages[0]?.usage,
			model: thinkingOnly.messages[0]?.model,
			duration: thinkingOnly.messages[0]?.duration,
			ttft: thinkingOnly.messages[0]?.ttft,
		}).toEqual({
			usage: thinkingOnlyUsage,
			model: "thinking-only-model",
			duration: 1600,
			ttft: 250,
		});
	});

	it("moves footer metadata to a trailing read group after thinking and narration", () => {
		const call: ToolCallContent = {
			type: "toolCall",
			id: "trailing-read:0",
			name: "read",
			arguments: { path: "src/trailing-read.ts:40-80" },
		};
		const completedEntry: ToolEntry = {
			toolName: call.name,
			args: call.arguments,
			status: "done",
			partialResult: null,
			streamingArgs: "",
			result: "export const trailingRead = true;",
			isError: false,
			startTime: 10,
			endTime: 20,
		};
		const resolveToolCall = (candidate: ToolCallContent) => ({
			key: candidate === call ? "trailing-read:0#1" : candidate.id,
			entry: candidate === call ? completedEntry : undefined,
		});
		const usage = {
			input: 3200,
			output: 800,
			cacheRead: 120,
			cacheWrite: 60,
			cost: { total: 0.006 },
		};
		const rows = groupReadRows(
			buildHistoryRows(
				[
					{
						...assistant([
							{ type: "thinking", thinking: "Locate the relevant implementation." },
							{ type: "text", text: "Read the final section before answering." },
							call,
						]),
						usage,
						model: "trailing-read-projection-model",
						duration: 5200,
						ttft: 750,
					},
					toolResult(call.id),
				],
				"compact",
				undefined,
				resolveToolCall,
			),
			resolveToolCall,
		);

		expect(rows.map(row => row.kind)).toEqual(["process", "message", "readGroup"]);
		const actualRowMetadata = rows.map(row => {
			if (row.kind === "todoSnapshot") throw new Error("unexpected todo snapshot row");
			if (row.kind === "readGroup") return { kind: row.kind, usage: row.usage };
			const message = row.kind === "process" ? row.messages[row.messages.length - 1] : row.message;
			return {
				kind: row.kind,
				usage: message?.usage,
				model: message?.model,
				duration: message?.duration,
				ttft: message?.ttft,
			};
		});
		expect(actualRowMetadata).toEqual([
			{ kind: "process", usage: undefined, model: undefined, duration: undefined, ttft: undefined },
			{ kind: "message", usage: undefined, model: undefined, duration: undefined, ttft: undefined },
			{
				kind: "readGroup",
				usage: [
					{
						role: "assistant",
						usage,
						model: "trailing-read-projection-model",
						duration: 5200,
						ttft: 750,
						timestamp: at,
					},
				],
			},
		]);
	});

	it("omits punctuation filler instead of allocating an invisible virtual row", () => {
		expect(
			buildHistoryRows(
				[
					assistant([
						{ type: "thinking", thinking: "." },
						{ type: "text", text: "." },
					]),
				],
				"compact",
			),
		).toEqual([]);
	});

	it("may combine consecutive thinking-only messages into one process row", () => {
		const rows = buildHistoryRows(
			[
				assistant([{ type: "thinking", thinking: "Inspect the inputs." }]),
				assistant([{ type: "thinking", thinking: "Compare the outputs." }]),
			],
			"compact",
		);

		expect(rows.map(row => row.kind)).toEqual(["process"]);
		const process = rows[0];
		if (process?.kind !== "process") throw new Error("process row missing");
		expect(process.stepCount).toBe(2);
		expect(process.messages.map(message => message.content)).toEqual([
			[{ type: "thinking", thinking: "Inspect the inputs." }],
			[{ type: "thinking", thinking: "Compare the outputs." }],
		]);
	});

	it("combines thinking across invisible core filler without emitting a blank message row", () => {
		const rows = buildHistoryRows(
			[
				assistant([
					{ type: "thinking", thinking: "Inspect the inputs." },
					{ type: "text", text: " . \n\t " },
				]),
				assistant([{ type: "thinking", thinking: "Compare the outputs." }]),
			],
			"compact",
		);

		expect(rows.map(row => row.kind)).toEqual(["process"]);
		expect(rows.filter(row => row.kind === "message")).toEqual([]);
		const process = rows[0];
		if (process?.kind !== "process") throw new Error("combined process row missing");
		expect(
			process.messages.flatMap(message =>
				Array.isArray(message.content)
					? message.content.flatMap(block => (block.type === "thinking" ? [block.thinking] : []))
					: [],
			),
		).toEqual(["Inspect the inputs.", "Compare the outputs."]);
	});

	it("never places toolCall blocks inside a compact process row", () => {
		const rows = buildHistoryRows(
			[
				assistant([{ type: "thinking", thinking: "Choose a search." }]),
				assistant([
					{
						type: "toolCall",
						id: "call-grep",
						name: "grep",
						arguments: { pattern: "toolCall", path: "src" },
					},
				]),
				assistant([{ type: "thinking", thinking: "Interpret the match." }]),
				assistant([{ type: "text", text: "The match is visible." }]),
			],
			"compact",
		);

		const processBlocks = rows.flatMap(row =>
			row.kind === "process"
				? row.messages.flatMap(message => (Array.isArray(message.content) ? message.content : []))
				: [],
		);
		expect(processBlocks).toEqual([
			{ type: "thinking", thinking: "Choose a search." },
			{ type: "thinking", thinking: "Interpret the match." },
		]);
		expect(rows.map(row => row.kind)).toEqual(["process", "message", "process", "message"]);

		const visibleToolNames = rows.flatMap(row =>
			row.kind === "message" && Array.isArray(row.message.content)
				? row.message.content
						.filter((block): block is ToolCallContent => block.type === "toolCall")
						.map(block => block.name)
				: [],
		);
		expect(visibleToolNames).toEqual(["grep"]);
	});

	it("keeps resolver occurrence keys in compact message rows", () => {
		const firstCall: ToolCallContent = {
			type: "toolCall",
			id: "provider-call:0",
			name: "read",
			arguments: { path: "first.ts" },
		};
		const secondCall: ToolCallContent = {
			type: "toolCall",
			id: "provider-call:0",
			name: "read",
			arguments: { path: "second.ts" },
		};
		const occurrenceKeys = new WeakMap<ToolCallContent, string>([
			[firstCall, "provider-call:0#1"],
			[secondCall, "provider-call:0#2"],
		]);
		const resolveToolCall = (call: ToolCallContent) => ({
			key: occurrenceKeys.get(call) ?? call.id,
			entry: undefined,
		});
		const messages = [
			{ ...assistant([{ type: "text", text: "Inspect both occurrences." }, firstCall]), timestamp: undefined },
			{ ...assistant([{ type: "text", text: "." }, secondCall]), timestamp: undefined },
		];

		const compactRows = buildHistoryRows(messages, "compact", undefined, resolveToolCall);
		expect(compactRows.map(row => row.kind)).toEqual(["message", "message"]);
		expect(buildHistoryRowKeys(compactRows, resolveToolCall)).toEqual([
			"message-provider-call:0#1",
			"message-provider-call:0#2",
		]);
	});

	it("keeps projected row keys tied to resolved occurrences when an earlier duplicate is removed", () => {
		const firstCall: ToolCallContent = {
			type: "toolCall",
			id: "provider-process:0",
			name: "read",
			arguments: { path: "first.ts" },
		};
		const secondCall: ToolCallContent = {
			type: "toolCall",
			id: "provider-process:0",
			name: "read",
			arguments: { path: "second.ts" },
		};
		const occurrenceKeys = new WeakMap<ToolCallContent, string>([
			[firstCall, "provider-process:0#1"],
			[secondCall, "provider-process:0#2"],
		]);
		const resolveToolCall = (call: ToolCallContent) => ({
			key: occurrenceKeys.get(call) ?? call.id,
			entry: undefined,
		});
		const firstMessage = { ...assistant([{ type: "text", text: "Inspect first." }, firstCall]), timestamp: undefined };
		const secondMessage = { ...assistant([{ type: "text", text: "Inspect second." }, secondCall]), timestamp: undefined };
		const phaseBoundary: AgentMessage = {
			...assistant([{ type: "text", text: "First inspection complete." }]),
			id: "phase-boundary",
		};
		const bothRows = buildHistoryRows(
			[firstMessage, phaseBoundary, secondMessage],
			"compact",
			undefined,
			resolveToolCall,
		);
		const remainingRows = buildHistoryRows([secondMessage], "compact", undefined, resolveToolCall);

		expect(buildHistoryRowKeys(bothRows, resolveToolCall)).toEqual([
			"message-provider-process:0#1",
			"message-phase-boundary",
			"message-provider-process:0#2",
		]);
		expect(buildHistoryRowKeys(remainingRows, resolveToolCall)).toEqual(["message-provider-process:0#2"]);

		const bothMessageRows = buildHistoryRows(
			[firstMessage, phaseBoundary, secondMessage],
			"full",
			undefined,
			resolveToolCall,
		);
		const remainingMessageRows = buildHistoryRows([secondMessage], "full", undefined, resolveToolCall);
		expect(buildHistoryRowKeys(bothMessageRows, resolveToolCall)).toEqual([
			"message-provider-process:0#1",
			"message-phase-boundary",
			"message-provider-process:0#2",
		]);
		expect(buildHistoryRowKeys(remainingMessageRows, resolveToolCall)).toEqual(["message-provider-process:0#2"]);
	});
});


describe("full transcript rows", () => {
	it("moves an opening assistant emoji onto the preceding user message", () => {
		const rows = buildHistoryRows(
			[
				{ role: "user", content: [{ type: "text", text: "Ship it?" }], timestamp: at },
				assistant([{ type: "text", text: "👍\nShipped." }]),
			],
			"full",
		);

		expect(rows).toHaveLength(2);
		const user = rows[0];
		const reply = rows[1];
		if (user?.kind !== "message" || reply?.kind !== "message") throw new Error("reaction rows missing");
		expect(user.reaction).toBe("👍");
		expect(reply.message.content).toEqual([{ type: "text", text: "Shipped." }]);
	});

	it("preserves an earlier failure after the user starts another turn", () => {
		const rows = buildHistoryRows(
			[
				{ ...assistant([{ type: "text", text: "Partial reply" }]), errorMessage: "network disconnected" },
				{ role: "user", content: [{ type: "text", text: "Try again" }], timestamp: at },
			],
			"full",
		);

		expect(rows).toHaveLength(2);
		const failed = rows[0];
		if (failed?.kind !== "message") throw new Error("partial reply row missing");
		expect(failed.message.errorMessage).toBe("network disconnected");
		expect(failed.message.content).toEqual([{ type: "text", text: "Partial reply" }]);
	});

	it("keeps individual process messages but removes standalone tool-result transport rows", () => {
		const rows = buildHistoryRows(toolRun, "full");
		expect(rows.map(row => row.kind)).toEqual(["message", "message", "message"]);
		for (const row of rows) {
			if (row.kind !== "message") throw new Error("full mode unexpectedly folded a process row");
			expect(row.message.role).toBe("assistant");
		}
	});

});

describe("streaming transcript visibility", () => {
	const shell = assistant([]);

	it("does not allocate a blank row for punctuation-only deltas", () => {
		expect(hasStreamingTranscriptContent(shell, ".", "…", new Map())).toBe(false);
	});

	it("shows a tool-only turn as soon as its live tool starts", () => {
		expect(
			hasStreamingTranscriptContent(
				shell,
				"",
				"",
				new Map([
					[
						"call-read",
						{
							toolName: "read",
							args: { path: "src/a.ts" },
							status: "running",
							partialResult: null,
							streamingArgs: "",
							result: null,
							isError: false,
							startTime: Date.parse(at),
							endTime: null,
						},
					],
				]),
			),
		).toBe(true);
	});

	it("excludes hydrated and previous-turn tools while retaining a current terminal tool row", () => {
		const entry: ToolEntry = {
			toolName: "read",
			args: { path: "src/a.ts" },
			status: "aborted",
			partialResult: null,
			streamingArgs: "",
			result: null,
			isError: false,
			startTime: Date.parse(at),
			endTime: Date.parse(at),
			streamGeneration: 0,
		};
		const tools = new Map([["call-read", entry]]);
		expect(hasStreamingTranscriptContent(shell, "", "", tools, 0)).toBe(false);
		entry.streamGeneration = 1;
		expect(hasStreamingTranscriptContent(shell, "", "", tools, 2)).toBe(false);
		entry.streamGeneration = 2;
		expect(hasStreamingTranscriptContent(shell, "", "", tools, 2)).toBe(true);
	});
});

describe("virtual transcript identity", () => {
	it("keeps tail following across layout slack and releases on a real scroll-up", () => {
		expect(isTranscriptAtLiveEdge({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true);
		// Row re-measurement and fractional scrollTop leave a few pixels under the
		// last row; that gap must not read as "the user scrolled away".
		expect(isTranscriptAtLiveEdge({ scrollHeight: 1000, scrollTop: 790, clientHeight: 200 })).toBe(true);
		expect(
			isTranscriptAtLiveEdge({ scrollHeight: 1000, scrollTop: 800 - LIVE_EDGE_SLACK_PX, clientHeight: 200 }),
		).toBe(false);
		expect(isTranscriptAtLiveEdge({ scrollHeight: 1000, scrollTop: 600, clientHeight: 200 })).toBe(false);
	});

	it("hands the tail back only to a gesture that moved toward it", () => {
		// A tail-follow write that slips into the same frame as an upward gesture
		// leaves the viewport at the live edge. Reading that position as intent clears
		// the gesture latch, so every later append follows and the view the reader just
		// took is lost for the rest of the run.
		expect(shouldRePinTranscript(false, true)).toBe(false);
		expect(shouldRePinTranscript(null, true)).toBe(false);
		// Dragging or flicking to the very bottom re-engages when the gesture ends,
		// not from a position the system itself produced.
		expect(shouldRePinTranscript(true, true)).toBe(true);
		// Toward the tail is not yet on it.
		expect(shouldRePinTranscript(true, false)).toBe(false);
		expect(shouldRePinTranscript(false, false)).toBe(false);
	});

	it("keeps an empty wire message anchored when a tool call finalizes it", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [],
			timestamp: at,
		};

		const liveKey = buildTranscriptRowKeys([{ kind: "streaming", message }]);
		const finalized: AgentMessage = {
			...message,
			entryId: "persisted-tool",
			content: [{ type: "toolCall", id: "call-finalized", name: "read", arguments: { path: "src/a.ts" } }],
		};
		const finalizedKey = buildHistoryRowKeys(buildHistoryRows([finalized], "full"));

		expect(liveKey).toEqual(finalizedKey);
	});

	it("keeps an expanded live phase separate when compact history absorbs it", () => {
		const first: AgentMessage = {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "thinking", thinking: "First phase" }],
		};
		const next: AgentMessage = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "thinking", thinking: "Next phase" }],
		};
		const [expandedKey] = buildTranscriptRowKeys([{ kind: "streaming", message: next }]);
		expect(buildHistoryRows([first, next], "compact")).toHaveLength(1);
		const rows = buildHistoryRows([first, next], "compact", new Set([expandedKey]));
		expect(buildHistoryRowKeys(rows)).toContain(expandedKey);
		expect(rows).toHaveLength(2);
	});

	it("anchors compact finalization to the first row produced from the live assistant", () => {
		const cases: AgentMessage[] = [
			{
				id: "assistant-thinking",
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Inspect the boundary." },
					{ type: "text", text: "Final answer" },
				],
				timestamp: at,
			},
			{
				id: "assistant-tool",
				role: "assistant",
				content: [{ type: "toolCall", id: "call-compact", name: "read", arguments: { path: "src/a.ts" } }],
				timestamp: at,
			},
		];

		for (const message of cases) {
			const [liveKey] = buildTranscriptRowKeys([{ kind: "streaming", message }]);
			const [firstFinalizedKey] = buildHistoryRowKeys(buildHistoryRows([message], "compact"));
			expect(firstFinalizedKey).toBe(liveKey);
		}
	});

	it("reuses the live assistant key when a pure read compact-finalizes into a read group", () => {
		const call: ToolCallContent = {
			type: "toolCall",
			id: "call-pure-read",
			name: "read",
			arguments: { path: "src/pure-read.ts" },
		};
		const message: AgentMessage = {
			id: "assistant-pure-read",
			role: "assistant",
			content: [call],
			timestamp: at,
		};
		const resolveToolCall = (candidate: ToolCallContent) => ({
			key: candidate === call ? "call-pure-read#1" : candidate.id,
			entry: undefined,
		});

		const [liveKey] = buildTranscriptRowKeys([{ kind: "streaming", message }], resolveToolCall);
		const finalizedRows = groupReadRows(
			buildHistoryRows([message], "compact", undefined, resolveToolCall),
			resolveToolCall,
		);
		const firstFinalizedRow = finalizedRows[0];
		if (firstFinalizedRow?.kind !== "readGroup") throw new Error("pure read group missing");
		const [finalizedKey] = buildHistoryRowKeys(finalizedRows, resolveToolCall);

		expect(finalizedKey).toBe(liveKey);
	});

	it("keeps existing row keys stable when a new message is inserted before them", () => {
		const existingRows = buildHistoryRows(
			[assistant([{ type: "text", text: "First" }]), assistant([{ type: "text", text: "Second" }])],
			"full",
		);
		const existingKeys = buildHistoryRowKeys(existingRows);
		const prependedRows = buildHistoryRows(
			[
				{ role: "user", content: [{ type: "text", text: "Prompt" }], timestamp: "2026-08-05T03:59:59.000Z" },
				assistant([{ type: "text", text: "First" }]),
				assistant([{ type: "text", text: "Second" }]),
			],
			"full",
		);
		expect(buildHistoryRowKeys(prependedRows).slice(1)).toEqual(existingKeys);
	});
});

describe("conversation navigation anchors", () => {
	it("indexes only user-authored turns and keeps their rendered row targets", () => {
		const rows = buildHistoryRows(
			[
				{ role: "user", content: [{ type: "text", text: "  First\nquestion  " }], timestamp: 100 },
				assistant([{ type: "text", text: "First answer" }]),
				{ role: "user", content: [{ type: "text", text: "Second question" }], timestamp: 300 },
			],
			"full",
		);
		const keys = buildHistoryRowKeys(rows);

		expect(buildConversationAnchors(rows, keys)).toEqual([
			{ key: keys[0], rowIndex: 0, preview: "First question", timestamp: 100 },
			{ key: keys[2], rowIndex: 2, preview: "Second question", timestamp: 300 },
		]);
	});

	it("selects the user turn at or immediately before the visible row", () => {
		const anchors = [
			{ key: "one", rowIndex: 2, preview: "One" },
			{ key: "two", rowIndex: 7, preview: "Two" },
			{ key: "three", rowIndex: 12, preview: "Three" },
		];

		expect(findConversationAnchorIndex(anchors, 0)).toBe(0);
		expect(findConversationAnchorIndex(anchors, 7)).toBe(1);
		expect(findConversationAnchorIndex(anchors, 11)).toBe(1);
		expect(findConversationAnchorIndex(anchors, 99)).toBe(2);
		expect(findConversationAnchorIndex([], 3)).toBe(-1);
	});

	it("bounds long prompt previews without changing their target row", () => {
		const rows = buildHistoryRows(
			[{ role: "user", content: [{ type: "text", text: "SQL ".repeat(100) }], timestamp: 100 }],
			"full",
		);
		const [anchor] = buildConversationAnchors(rows, buildHistoryRowKeys(rows));

		expect(anchor?.rowIndex).toBe(0);
		expect(anchor?.preview.length).toBeLessThanOrEqual(180);
		expect(anchor?.preview.endsWith("…")).toBe(true);
	});
});

describe("mergeTodoSnapshots", () => {
	function snapshot(id: string, ts: number): TodoSnapshot {
		return { id, ts, phases: [{ name: "Build", tasks: [{ content: "task", status: "pending" }] }] };
	}

	it("interleaves snapshots by timestamp and tails the newest changes", () => {
		const rows = buildHistoryRows(
			[
				{ role: "user", content: [{ type: "text", text: "One" }], timestamp: 100 },
				{ role: "user", content: [{ type: "text", text: "Two" }], timestamp: 300 },
			],
			"full",
		);
		const merged = mergeTodoSnapshots(rows, [snapshot("s1", 50), snapshot("s2", 200), snapshot("s3", 400)]);
		expect(merged.map(row => row.kind)).toEqual([
			"todoSnapshot",
			"message",
			"todoSnapshot",
			"message",
			"todoSnapshot",
		]);
		expect(merged.map(row => (row.kind === "todoSnapshot" ? row.entry.id : null))).toEqual([
			"s1",
			null,
			"s2",
			null,
			"s3",
		]);
	});

	it("passes rows through untouched when there are no snapshots", () => {
		const rows = buildHistoryRows([assistant([{ type: "text", text: "Solo" }])], "full");
		expect(mergeTodoSnapshots(rows, [])).toEqual(rows);
	});
});

describe("transcript row entrances", () => {
	function claim(
		latch: RowEntranceState,
		sessionId: string,
		live: boolean,
		rowKeys: string[],
	) {
		const mounted = rowKeys.map((key, index) => ({ index, key }));
		return claimRowEntrances(latch, { sessionId, live, rowKeys, mounted });
	}

	function history(count: number): string[] {
		return Array.from({ length: count }, (_, index) => `r${index}`);
	}

	it("leaves a restored transcript alone, however it lands", () => {
		const latch = createRowEntranceState("session-a", []);
		const restored = history(5);
		expect(claim(latch, "session-a", false, restored)).toEqual([]);
		expect(claim(latch, "session-a", true, restored)).toEqual([]);
	});

	it("claims a row appended at the tail, exactly once", () => {
		const restored = history(20);
		const latch = createRowEntranceState("session-a", restored);
		const next = [...restored, "live"];
		expect(claim(latch, "session-a", true, next)).toEqual(["live"]);
		expect(claim(latch, "session-a", true, next)).toEqual([]);
	});

	it("claims the reply even when it replaces the waiting row", () => {
		const restored = [...history(20), "pending"];
		const latch = createRowEntranceState("session-a", restored);
		expect(claim(latch, "session-a", true, [...history(20), "user", "streaming"])).toEqual(["user", "streaming"]);
	});

	it("does not claim history landing above the tail", () => {
		const restored = history(20);
		const latch = createRowEntranceState("session-a", restored);
		const older = ["older-1", "older-2"];
		const next = [...older, ...restored, "live"];
		const claims = claimRowEntrances(latch, {
			sessionId: "session-a",
			live: true,
			rowKeys: next,
			mounted: next.map((key, index) => ({ index, key })),
		});
		expect(claims).toEqual(["live"]);
	});

	it("treats a bulk jump as a restore", () => {
		const latch = createRowEntranceState("session-a", history(2));
		const page = [...history(2), ...Array.from({ length: ROW_ENTRANCE_TAIL_ROWS + 8 }, (_, i) => `hydrated-${i}`)];
		expect(claim(latch, "session-a", true, page)).toEqual([]);
		expect(claim(latch, "session-a", true, [...page, "live"])).toEqual(["live"]);
	});

	it("rebaselines on a session switch instead of animating the new view", () => {
		const latch = createRowEntranceState("session-a", history(20));
		const other = history(30);
		expect(claim(latch, "session-b", true, other)).toEqual([]);
		expect(claim(latch, "session-b", true, [...other, "a30"])).toEqual(["a30"]);
	});
});

describe("Main ChatStream characterization", () => {



	it("keeps finalized, live, and Main-only rows on the shared scroll surface", async () => {
		const streamStartedAt = Date.parse("2026-08-05T04:00:05.000Z");
		const liveTool: ToolEntry = {
			toolName: "bash",
			args: { command: "bun test" },
			status: "running",
			partialResult: "running focused tests",
			streamingArgs: "",
			result: null,
			isError: false,
			startTime: streamStartedAt + 1,
			endTime: null,
		};
		useMessagesStore.setState({
			messages: [
				{ role: "user", content: [{ type: "text", text: "**First Main prompt**" }], timestamp: 100 },
				assistant([
					{ type: "thinking", thinking: "Inspect the existing renderer." },
					{ type: "text", text: "**Finalized Main answer**" },
					{ type: "toolCall", id: "final-read", name: "read", arguments: { path: "src/main.ts" } },
				]),
				{ role: "user", content: [{ type: "text", text: "Second Main prompt" }], timestamp: 300 },
				{ ...assistant([{ type: "text", text: "Second Main answer" }]), timestamp: 400 },
			],
			streamingMessage: { ...assistant([]), timestamp: streamStartedAt },
			// Trailing blank line closes the paragraph so frame-paced streaming promotes it
			// out of the plain-text tail into a parsed block.
			streamingText: "**Live Main answer**\n\n",
			streamingThinking: "Live Main reasoning",
		});
		useToolsStore.setState({ activeTools: new Map([["live-bash", liveTool]]) });
		useSessionStore.setState({
			sessionId: "main-characterization",
			status: "ready",
			switchPending: null,
			isStreaming: true,
			retryInfo: {
				attempt: 2,
				maxAttempts: 3,
				delayMs: 1000,
				errorMessage: "temporary provider failure",
				startedAt: Date.now(),
			},
		});
		useQueueStore.setState({
			steering: [{ id: "queued-main", text: "Queued Main steer", editable: true, timestamp: 500 }],
			followUp: [],
		});
		useTodoStore.setState({
			history: [
				{
					id: "todo-main",
					ts: 250,
					phases: [{ name: "Build", tasks: [{ content: "Preserve Main todo", status: "in_progress" }] }],
				},
			],
		});
		useUiStore.setState({ thinkingExpanded: true, transcriptDetail: "full" });

		await mount(<ChatStream />);

		if (!container) throw new Error("ChatStream mount missing");
		expect(container.textContent).toContain("First Main prompt");
		expect(container.querySelector(".omp-assistant-turn strong")?.textContent).toBe("Finalized Main answer");
		expect(container.querySelector(".omp-streaming strong")?.textContent).toBe("Live Main answer");
		expect(container.textContent).toContain("Live Main reasoning");
		expect(container.querySelector('[data-tool-status="running"]')).not.toBeNull();
		expect(container.querySelector(".omp-process-group")).toBeNull();
		expect(container.querySelector('[data-transcript-kind="queued"]')?.textContent).toContain("Queued Main steer");
		expect(container.querySelector('[data-transcript-kind="todoSnapshot"]')).not.toBeNull();
		expect(container.querySelector('[data-transcript-kind="pending"]')?.textContent).toContain(
			"temporary provider failure",
		);


		await act(async () => {
			useUiStore.setState({ transcriptDetail: "compact" });
		});
		expect(container.querySelector(".omp-process-group")).not.toBeNull();
	});

	it("isolates tool disclosure and renderer-boundary state between tabs sharing a session identity", async () => {
		function ExplodingProjectionRenderer(): never {
			throw new Error("tab A renderer failure");
		}

		const originalGetToolRenderer = ToolRegistry.getToolRenderer;
		vi.spyOn(ToolRegistry, "getToolRenderer").mockImplementation(invocation =>
			invocation.name === "grep" && invocation.args.path === "src/tab-a.ts"
				? { component: ExplodingProjectionRenderer, shell: "compact" }
				: originalGetToolRenderer(invocation),
		);
		vi.spyOn(RuntimeErrors, "reportRuntimeError").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const projectionMessages = (path: string, marker: string): AgentMessage[] =>
			JSON.parse(
				JSON.stringify([
					{
						id: "shared-message-occurrence",
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "shared-tool-occurrence",
								name: "grep",
								arguments: { pattern: "TRANSCRIPT_MATCH", path },
							},
						],
						timestamp: at,
					},
					{
						role: "toolResult",
						toolCallId: "shared-tool-occurrence",
						toolName: "grep",
						content: [{ type: "text", text: `${path}:7:${marker}` }],
						isError: false,
						timestamp: at,
					},
				]),
			) as AgentMessage[];
		const messagesA = projectionMessages("src/tab-a.ts", "TAB_A_MATCH");
		const messagesB = projectionMessages("src/tab-b.ts", "TAB_B_MATCH");

		useTabsStore.setState({
			tabs: [
				{
					id: "tab-a",
					cwd: "/work/a",
					target: { type: "local" },
					status: "ready",
					kind: "agent",
					sessionId: "shared-session",
					unreadDone: false,
				},
				{
					id: "tab-b",
					cwd: "/work/b",
					target: { type: "local" },
					status: "ready",
					kind: "agent",
					sessionId: "shared-session",
					unreadDone: false,
				},
			],
			activeTabId: "tab-a",
			bundles: new Map(),
		});
		useSessionStore.setState({ sessionId: "shared-session", status: "ready" });
		useMessagesStore.setState({ messages: messagesA });
		useToolsStore.getState().hydrateMessages(messagesA);
		setFocusedSessionRuntime("tab-a");
		await mount(<ChatStream />);

		const cardA = container?.querySelector('[data-tool-name="grep"]') as unknown as HTMLElement | null;
		const headerA = cardA?.querySelector(".omp-tool-header") as HTMLElement | null;
		// The row is the click target; the toggle inside it owns aria-expanded so
		// the header's file path can be a link of its own.
		const toggleA = cardA?.querySelector(".omp-tool-header-toggle") as HTMLElement | null;
		if (!cardA || !headerA || !toggleA) throw new Error("tab A tool card missing");
		expect(toggleA.getAttribute("aria-expanded")).toBe("false");
		await act(async () => {
			headerA.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(toggleA.getAttribute("aria-expanded")).toBe("true");
		expect(cardA.querySelector(".omp-tool-body")?.textContent).toContain("TAB_A_MATCH");
		expect(cardA.querySelector(".omp-tool-body")?.textContent).not.toContain("/TRANSCRIPT_MATCH/");

		await act(async () => {
			useTabsStore.setState({ activeTabId: "tab-b" });
			setFocusedSessionRuntime("tab-b");
			useMessagesStore.setState({ messages: messagesB });
			useToolsStore.getState().hydrateMessages(messagesB);
		});

		const cardB = container?.querySelector('[data-tool-name="grep"]') as unknown as HTMLElement | null;
		const toggleB = cardB?.querySelector(".omp-tool-header-toggle") as HTMLElement | null;
		const bodyB = cardB?.querySelector(".omp-tool-body");
		if (!cardB || !toggleB || !bodyB) throw new Error("tab B tool card missing");
		expect(toggleB.getAttribute("aria-expanded")).toBe("false");
		expect(bodyB.textContent).toContain("/TRANSCRIPT_MATCH/");
		expect(bodyB.textContent).toContain("TAB_B_MATCH");
		expect(bodyB.textContent).not.toContain("TAB_A_MATCH");
	});
});
