import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, ToolCallContent } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { groupReadRows } from "../../lib/read-group";
import * as RuntimeErrors from "../../lib/runtime-errors";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
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
	buildTimelineMarkers,
	buildTranscriptRowKeys,
	findConversationAnchorIndex,
	hasStreamingTranscriptContent,
	isTranscriptAtLiveEdge,
	mergeTodoSnapshots,
} from "./chat-stream-utils";
import { MessageBubble } from "./MessageBubble";
import { StreamingRows } from "./TranscriptViewport";

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
	useUiStore.setState({ thinkingExpanded: false, transcriptDetail: "compact", switchPending: null });
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

	it("keeps resolver occurrence keys in compact message rows and timeline markers", () => {
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
			assistant([{ type: "text", text: "Inspect both occurrences." }, firstCall]),
			assistant([{ type: "text", text: "." }, secondCall]),
		];

		const compactRows = buildHistoryRows(messages, "compact", resolveToolCall);
		expect(compactRows.map(row => row.kind)).toEqual(["message", "message"]);
		expect(buildHistoryRowKeys(compactRows, resolveToolCall)).toEqual([
			"message-provider-call:0#1",
			"message-provider-call:0#2",
		]);

		const fullRows = buildHistoryRows(messages, "full", resolveToolCall);
		const markers = buildTimelineMarkers(fullRows, resolveToolCall);
		expect(markers[0]?.toolIds).toEqual(["provider-call:0#1", "provider-call:0#2"]);
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
		const firstMessage = assistant([{ type: "text", text: "Inspect first." }, firstCall]);
		const secondMessage = assistant([{ type: "text", text: "Inspect second." }, secondCall]);
		const phaseBoundary: AgentMessage = {
			...assistant([{ type: "text", text: "First inspection complete." }]),
			id: "phase-boundary",
		};
		const bothRows = buildHistoryRows([firstMessage, phaseBoundary, secondMessage], "compact", resolveToolCall);
		const remainingRows = buildHistoryRows([secondMessage], "compact", resolveToolCall);

		expect(buildHistoryRowKeys(bothRows, resolveToolCall)).toEqual([
			"message-provider-process:0#1",
			"message-phase-boundary",
			"message-provider-process:0#2",
		]);
		expect(buildHistoryRowKeys(remainingRows, resolveToolCall)).toEqual(["message-provider-process:0#2"]);

		const bothMessageRows = buildHistoryRows([firstMessage, phaseBoundary, secondMessage], "full", resolveToolCall);
		const remainingMessageRows = buildHistoryRows([secondMessage], "full", resolveToolCall);
		expect(buildHistoryRowKeys(bothMessageRows, resolveToolCall)).toEqual([
			"message-provider-process:0#1",
			"message-phase-boundary",
			"message-provider-process:0#2",
		]);
		expect(buildHistoryRowKeys(remainingMessageRows, resolveToolCall)).toEqual(["message-provider-process:0#2"]);
	});
});

describe("projected tool renderers", () => {
	it("passes the projection through finalized visible messages and streaming tool renderers", () => {
		const call: ToolCallContent = {
			type: "toolCall",
			id: "shared-provider:0",
			name: "bash",
			arguments: { command: "printf projected" },
		};
		const projectedEntry: ToolEntry = {
			toolName: "bash",
			args: call.arguments,
			status: "running",
			partialResult: "PROJECTED_PARTIAL",
			streamingArgs: "",
			result: null,
			isError: false,
			startTime: 1,
			endTime: null,
		};
		const mainEntry: ToolEntry = {
			...projectedEntry,
			status: "error",
			partialResult: "MAIN_PARTIAL",
			isError: true,
			endTime: 2,
		};
		useToolsStore.setState({
			activeTools: new Map([
				[call.id, mainEntry],
				["shared-provider:0#projected", mainEntry],
			]),
		});
		const projectedTools = new Map([["shared-provider:0#projected", projectedEntry]]);
		const resolveToolCall = () => ({ key: "shared-provider:0#projected", entry: projectedEntry });
		const rows = buildHistoryRows(
			[assistant([{ type: "text", text: "Run projected." }, call])],
			"compact",
			resolveToolCall,
		);
		const row = rows[0];
		if (row?.kind !== "message") throw new Error("projected visible message row missing");

		const finalizedHtml = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={row.message} resolveToolCall={resolveToolCall} />
			</I18nProvider>,
		);
		const streamingHtml = renderToStaticMarkup(
			<I18nProvider>
				<StreamingRows
					activeTools={projectedTools}
					resolveToolCall={resolveToolCall}
					streamingMessage={assistant([call])}
					streamingText=""
					streamingThinking=""
					transcriptDetail="full"
				/>
			</I18nProvider>,
		);

		for (const html of [finalizedHtml, streamingHtml]) {
			expect(html).toContain('data-tool-status="running"');
			expect(html).not.toContain('data-tool-error="true"');
		}
	});
});

describe("full transcript rows", () => {
	it("keeps individual process messages but removes standalone tool-result transport rows", () => {
		const rows = buildHistoryRows(toolRun, "full");
		expect(rows.map(row => row.kind)).toEqual(["message", "message", "message"]);
		for (const row of rows) {
			if (row.kind !== "message") throw new Error("full mode unexpectedly folded a process row");
			expect(row.message.role).toBe("assistant");
		}
	});

	it("renders one marker per narrated phase and aggregates continuation tool state", () => {
		const phaseRows = buildHistoryRows(
			[
				assistant([
					{ type: "text", text: "Validate the updater." },
					{ type: "toolCall", id: "call-check", name: "bash", arguments: { command: "bun check" } },
				]),
				assistant([
					{ type: "text", text: "." },
					{ type: "toolCall", id: "call-format", name: "bash", arguments: { command: "bun format" } },
				]),
				assistant([
					{ type: "thinking", thinking: "The checks passed; launch the audit build." },
					{ type: "text", text: "Launch the audit build." },
					{ type: "toolCall", id: "call-build", name: "bash", arguments: { command: "bun run build" } },
				]),
				assistant([
					{ type: "text", text: "." },
					{ type: "toolCall", id: "call-hub", name: "hub", arguments: { name: "gui-final" } },
				]),
				assistant([
					{ type: "text", text: "." },
					{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "xd://browser" } },
				]),
				{ role: "custom", customType: "launch-completion", content: "gui-final exited with code 0", timestamp: at },
			],
			"full",
		);

		const markers = buildTimelineMarkers(phaseRows);
		expect(markers.map(marker => marker?.state ?? null)).toEqual(["done", null, "done", null, null, "launch"]);
		expect(markers[0]?.toolIds).toEqual(["call-check", "call-format"]);
		expect(markers[2]?.toolIds).toEqual(["call-build", "call-hub", "call-write"]);
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
});

describe("virtual transcript identity", () => {
	it("releases tail following after even a nearby one-pixel manual scroll", () => {
		expect(isTranscriptAtLiveEdge({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true);
		expect(isTranscriptAtLiveEdge({ scrollHeight: 1000, scrollTop: 799.5, clientHeight: 200 })).toBe(true);
		expect(isTranscriptAtLiveEdge({ scrollHeight: 1000, scrollTop: 799, clientHeight: 200 })).toBe(false);
	});

	it("keeps the live assistant row identity when message_end finalizes it", () => {
		const message: AgentMessage = {
			id: "assistant-live",
			role: "assistant",
			content: [{ type: "text", text: "Finalized answer" }],
			timestamp: at,
		};

		const liveKey = buildTranscriptRowKeys([{ kind: "streaming", message }]);
		const finalizedKey = buildHistoryRowKeys(buildHistoryRows([message], "full"));

		expect(liveKey).toEqual(finalizedKey);
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
		const finalizedRows = groupReadRows(buildHistoryRows([message], "compact", resolveToolCall), resolveToolCall);
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

describe("Main ChatStream characterization", () => {
	it("routes Main messages and occurrence-specific tools through the shared viewport", async () => {
		useMessagesStore.setState({ messages: toolRun });
		useSessionStore.setState({ sessionId: "main-session", status: "ready" });
		await mount(<ChatStream />);

		expect(container?.querySelector(".omp-transcript-editorial")).not.toBeNull();
		expect(container?.textContent).toContain("Implemented and verified.");
	});

	it("shows a local starting loader without starter actions", async () => {
		useSessionStore.setState({ sessionId: "main-starting", status: "starting", isStreaming: false });
		await mount(<ChatStream />);

		expect(container?.querySelector(".animate-spin")).not.toBeNull();
		expect(container?.querySelector(".omp-starter-card")).toBeNull();
	});

	it("releases shared Main tail following after a one-pixel manual scroll", async () => {
		useMessagesStore.setState({
			messages: Array.from({ length: 12 }, (_, index) => ({
				role: "user",
				content: [{ type: "text", text: `History prompt ${index + 1}` }],
				timestamp: index + 1,
			})),
		});
		useSessionStore.setState({ sessionId: "main-scroll-release", status: "ready" });
		await mount(<ChatStream />);

		const { promise: settled, resolve: resolveSettled } = Promise.withResolvers<void>();
		setTimeout(resolveSettled, 0);
		await act(async () => {
			await settled;
		});

		const scroll = container?.querySelector(".omp-transcript-scroll") as unknown as HTMLElement | null;
		const canvas = container?.querySelector(".omp-transcript-canvas") as unknown as HTMLElement | null;
		if (!scroll || !canvas) throw new Error("Main transcript scroll surface missing");
		Object.defineProperty(scroll, "scrollHeight", {
			configurable: true,
			get: () => Number.parseFloat(canvas.style.height),
		});

		const beforeAppendBottom = scroll.scrollHeight - scroll.clientHeight;
		expect(beforeAppendBottom).toBeGreaterThan(0);
		scroll.scrollTop = beforeAppendBottom - 1;
		await act(async () => {
			const wheel = new Event("wheel", { bubbles: true, cancelable: true });
			Object.defineProperty(wheel, "eventPhase", { value: 0, writable: true, configurable: true });
			scroll.dispatchEvent(wheel);
			const manualScroll = new Event("scroll", { bubbles: true, cancelable: true });
			Object.defineProperty(manualScroll, "eventPhase", { value: 0, writable: true, configurable: true });
			scroll.dispatchEvent(manualScroll);
		});

		const jump = container?.querySelector('button[aria-label="Jump to latest"]') as unknown as HTMLElement | null;
		if (!jump) throw new Error("Jump to latest action missing");
		expect(jump.classList.contains("opacity-100")).toBe(true);
		expect(jump.classList.contains("opacity-0")).toBe(false);

		const { promise: appended, resolve: resolveAppended } = Promise.withResolvers<void>();
		setTimeout(resolveAppended, 0);
		await act(async () => {
			useMessagesStore.setState(state => ({
				messages: [
					...state.messages,
					{ role: "user", content: [{ type: "text", text: "Appended prompt" }], timestamp: 13 },
				],
			}));
			await appended;
		});

		expect(jump.classList.contains("opacity-100")).toBe(true);
		expect(jump.classList.contains("opacity-0")).toBe(false);
	});

	it("keeps finalized, live, navigation, and Main-only rows on the shared scroll surface", async () => {
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
		useUiStore.setState({ thinkingExpanded: true, transcriptDetail: "full", switchPending: null });

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

		const scroll = container.querySelector(".omp-transcript-scroll");
		const navigator = container.querySelector(".omp-conversation-nav");
		const jump = container.querySelector('button[aria-label="Jump to latest"]');
		expect(scroll).not.toBeNull();
		expect(navigator?.parentElement).toBe(scroll?.parentElement);
		expect(jump?.parentElement).toBe(scroll?.parentElement);

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
		await mount(<ChatStream />);

		const cardA = container?.querySelector('[data-tool-name="grep"]') as unknown as HTMLElement | null;
		const headerA = cardA?.querySelector(".omp-tool-header") as HTMLElement | null;
		if (!cardA || !headerA) throw new Error("tab A tool card missing");
		expect(headerA.getAttribute("aria-expanded")).toBe("false");
		await act(async () => {
			headerA.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		expect(headerA.getAttribute("aria-expanded")).toBe("true");
		expect(cardA.querySelector(".omp-tool-body")?.textContent).toContain("TAB_A_MATCH");
		expect(cardA.querySelector(".omp-tool-body")?.textContent).not.toContain("/TRANSCRIPT_MATCH/");

		await act(async () => {
			useTabsStore.setState({ activeTabId: "tab-b" });
			useMessagesStore.setState({ messages: messagesB });
			useToolsStore.getState().hydrateMessages(messagesB);
		});

		const cardB = container?.querySelector('[data-tool-name="grep"]') as unknown as HTMLElement | null;
		const headerB = cardB?.querySelector(".omp-tool-header") as HTMLElement | null;
		const bodyB = cardB?.querySelector(".omp-tool-body");
		if (!cardB || !headerB || !bodyB) throw new Error("tab B tool card missing");
		expect(headerB.getAttribute("aria-expanded")).toBe("false");
		expect(bodyB.textContent).toContain("/TRANSCRIPT_MATCH/");
		expect(bodyB.textContent).toContain("TAB_B_MATCH");
		expect(bodyB.textContent).not.toContain("TAB_A_MATCH");
	});
});
