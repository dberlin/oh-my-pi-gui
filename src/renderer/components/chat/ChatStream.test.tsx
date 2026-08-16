import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage, ToolCallContent } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import type { TodoSnapshot } from "../../stores/todo";
import { useTodoStore } from "../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
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
import { ProcessGroup, StreamingRows } from "./TranscriptViewport";

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
	useTodoStore.getState().reset();
	useToolsStore.getState().reset();
	useUiStore.setState({ thinkingExpanded: false, transcriptDetail: "compact", switchPending: null });
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
	it("folds consecutive tool work into one process row and keeps the final answer visible", () => {
		const rows = buildHistoryRows(toolRun, "compact");
		expect(rows.map(row => row.kind)).toEqual(["process", "message"]);

		const process = rows[0];
		if (process?.kind !== "process") throw new Error("process row missing");
		expect(process.stepCount).toBe(2);
		expect(process.toolNames).toEqual(["read", "write"]);
		expect(process.messages).toHaveLength(2);

		const answer = rows[1];
		if (answer?.kind !== "message") throw new Error("final answer row missing");
		expect(answer.message.content).toEqual([{ type: "text", text: "Implemented and verified." }]);
	});

	it("splits final reasoning from final text so only the answer stays outside the process row", () => {
		const rows = buildHistoryRows(
			[
				assistant([
					{ type: "thinking", thinking: "Check the boundary first." },
					{ type: "text", text: "The public answer." },
				]),
			],
			"compact",
		);
		expect(rows.map(row => row.kind)).toEqual(["process", "message"]);

		const process = rows[0];
		const answer = rows[1];
		if (process?.kind !== "process" || answer?.kind !== "message") throw new Error("split rows missing");
		expect(process.stepCount).toBe(1);
		expect(process.messages[0]?.content).toEqual([{ type: "thinking", thinking: "Check the boundary first." }]);
		expect(answer.message.content).toEqual([{ type: "text", text: "The public answer." }]);
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

	it("folds narrated phases and filler tool calls into one activity summary before the final answer", () => {
		const rows = buildHistoryRows(
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
					{ type: "toolCall", id: "call-launch", name: "hub", arguments: { name: "gui-final" } },
				]),
			],
			"compact",
		);

		expect(rows.map(row => row.kind)).toEqual(["process"]);
		const process = rows[0];
		if (process?.kind !== "process") throw new Error("process row missing");
		expect(process.stepCount).toBe(5);
		expect(process.toolNames).toEqual(["bash", "bash", "bash", "hub"]);
	});

	it("keeps resolver occurrence keys in process rows and timeline markers", () => {
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
		if (compactRows[0]?.kind !== "process") throw new Error("process row missing");
		expect(compactRows[0].toolCallIds).toEqual(["provider-call:0#1", "provider-call:0#2"]);

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

		expect(buildHistoryRowKeys(bothRows)).toEqual([
			"message-provider-process:0#1",
			"message-phase-boundary",
			"message-provider-process:0#2",
		]);
		expect(buildHistoryRowKeys(remainingRows)).toEqual(["message-provider-process:0#2"]);

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
	it("passes the projection through finalized process and streaming tool renderers", () => {
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
		if (row?.kind !== "process") throw new Error("projected process row missing");

		const processHtml = renderToStaticMarkup(
			<I18nProvider>
				<ProcessGroup activeTools={projectedTools} resolveToolCall={resolveToolCall} row={row} />
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

		for (const html of [processHtml, streamingHtml]) {
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
});
