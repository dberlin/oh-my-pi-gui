import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, ToolCallContent } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import {
	createToolProjection,
	hydrateToolProjection,
	resolveProjectionToolCall,
	type ToolEntry,
	useToolsStore,
} from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { ChatStream } from "./ChatStream";
import { TranscriptViewport } from "./TranscriptViewport";

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
	children: TestElement[];
	parentElement: TestElement | null;
	textContent: string | null;
	click: () => void;
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
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

function assistant(content: AgentMessage["content"], timestamp: number): AgentMessage {
	return { role: "assistant", content, timestamp };
}

const liveGrepCall: ToolCallContent = {
	type: "toolCall",
	id: "live-grep",
	name: "grep",
	arguments: { pattern: "needle", path: "src" },
};

function seedLiveCompactGrep({
	streamingText = "**Streaming answer after tools**",
	streamingThinking = "Live compact reasoning",
}: {
	streamingText?: string;
	streamingThinking?: string;
} = {}): ToolEntry {
	const streamStartedAt = Date.parse("2026-08-05T06:00:00.000Z");
	const entry: ToolEntry = {
		toolName: liveGrepCall.name,
		args: liveGrepCall.arguments,
		status: "running",
		partialResult: "src/live.ts:9:const needle = true;",
		streamingArgs: "",
		result: null,
		isError: false,
		startTime: streamStartedAt + 1,
		endTime: null,
	};
	useMessagesStore.setState({
		messages: [],
		streamingMessage: assistant([], streamStartedAt),
		streamingText,
		streamingThinking,
	});
	useToolsStore.setState({ activeTools: new Map([[liveGrepCall.id, entry]]) });
	useSessionStore.setState({ isStreaming: true, status: "ready" });
	useUiStore.setState({ thinkingExpanded: true, transcriptDetail: "compact", switchPending: null });
	return entry;
}
afterEach(async () => {
	vi.restoreAllMocks();
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

describe("TranscriptViewport projected branch", () => {
	it("renders only projection messages, live buffers, and tools without Main-only rows", async () => {
		const streamStartedAt = Date.parse("2026-08-05T05:00:00.000Z");
		const call: ToolCallContent = {
			type: "toolCall",
			id: "provider-call",
			name: "bash",
			arguments: { command: "printf projected" },
		};
		const projectedEntry: ToolEntry = {
			toolName: "bash",
			args: call.arguments,
			status: "running",
			partialResult: "PROJECTED_TOOL_OUTPUT",
			streamingArgs: "",
			result: null,
			isError: false,
			startTime: streamStartedAt + 1,
			endTime: null,
		};
		const mainEntry: ToolEntry = {
			...projectedEntry,
			status: "error",
			partialResult: "MAIN_TOOL_LEAK",
			isError: true,
		};
		useMessagesStore.setState({
			messages: [{ role: "user", content: [{ type: "text", text: "MAIN_MESSAGE_LEAK" }], timestamp: 1 }],
			streamingMessage: assistant([], streamStartedAt),
			streamingText: "MAIN_STREAM_LEAK",
			streamingThinking: "MAIN_THINKING_LEAK",
		});
		useToolsStore.setState({ activeTools: new Map([[call.id, mainEntry]]) });
		useQueueStore.setState({
			steering: [{ id: "main-queue", text: "MAIN_QUEUE_LEAK", editable: true, timestamp: 1 }],
			followUp: [],
		});
		useTodoStore.setState({
			history: [
				{
					id: "main-todo",
					ts: 1,
					phases: [{ name: "Main", tasks: [{ content: "MAIN_TODO_LEAK", status: "pending" }] }],
				},
			],
		});
		useSessionStore.setState({
			isStreaming: true,
			retryInfo: {
				attempt: 1,
				maxAttempts: 2,
				delayMs: 1000,
				errorMessage: "MAIN_STATUS_LEAK",
				startedAt: Date.now(),
			},
		});
		useUiStore.setState({ thinkingExpanded: true });

		const projectedTools = new Map([["provider-call#projected", projectedEntry]]);
		const resolveToolCall = () => ({ key: "provider-call#projected", entry: projectedEntry });
		await mount(
			<TranscriptViewport
				mode="subagent"
				projection={{
					transcriptId: "subagent-1",
					messages: [
						{
							id: "projected-user-entry",
							role: "user",
							content: [{ type: "text", text: "Projected prompt" }],
							timestamp: 100,
						},
						assistant([{ type: "text", text: "**Projected finalized**" }, call], 200),
					],
					streamingMessage: assistant([], streamStartedAt),
					// Closed paragraph so the streamed text parses as a block, not the plain tail.
					streamingText: "**Projected live**\n\n",
					streamingThinking: "Projected reasoning",
					activeTools: projectedTools,
					resolveToolCall,
					transcriptDetail: "full",
				}}
			/>,
		);

		if (!container) throw new Error("TranscriptViewport mount missing");
		expect(container.textContent).toContain("Projected prompt");
		expect(container.querySelector(".omp-assistant-turn strong")?.textContent).toBe("Projected finalized");
		expect(container.querySelector(".omp-streaming strong")?.textContent).toBe("Projected live");
		expect(container.textContent).toContain("Projected reasoning");
		expect(container.querySelector('[data-tool-status="running"]')).not.toBeNull();
		expect(container.querySelector('button[title="Branch conversation from here"]')).toBeNull();
		expect(container.textContent).not.toContain("MAIN_MESSAGE_LEAK");
		expect(container.textContent).not.toContain("MAIN_STREAM_LEAK");
		expect(container.textContent).not.toContain("MAIN_THINKING_LEAK");
		expect(container.textContent).not.toContain("MAIN_TOOL_LEAK");
		expect(container.textContent).not.toContain("MAIN_QUEUE_LEAK");
		expect(container.textContent).not.toContain("MAIN_TODO_LEAK");
		expect(container.textContent).not.toContain("MAIN_STATUS_LEAK");
		expect(container.querySelector('[data-transcript-kind="queued"]')).toBeNull();
		expect(container.querySelector('[data-transcript-kind="todoSnapshot"]')).toBeNull();
		expect(container.querySelector('[data-transcript-kind="pending"]')).toBeNull();
	});
});

describe("TranscriptViewport compact tool visibility", () => {
	it("renders a finalized Grep as a visible specialized card without an outer Process disclosure", async () => {
		const call: ToolCallContent = {
			type: "toolCall",
			id: "final-grep",
			name: "grep",
			arguments: { pattern: "needle", path: "src" },
		};
		const entry: ToolEntry = {
			toolName: call.name,
			args: call.arguments,
			status: "done",
			partialResult: null,
			streamingArgs: "",
			result: {
				content: [{ type: "text", text: "src/final.ts:7:const needle = true;" }],
				details: { files: ["src/final.ts"], fileCount: 1, matchCount: 1, scopePath: "src" },
			},
			isError: false,
			startTime: 100,
			endTime: 125,
		};
		useMessagesStore.setState({
			messages: [assistant([call], 100)],
		});
		useToolsStore.setState({ activeTools: new Map([[call.id, entry]]) });
		useSessionStore.setState({ status: "ready" });
		useUiStore.setState({ transcriptDetail: "compact" });

		await mount(<ChatStream />);

		if (!container) throw new Error("TranscriptViewport mount missing");
		const finalizedRow = container.querySelector('[data-transcript-kind="message"]');
		expect(finalizedRow).not.toBeNull();
		expect(container.querySelector(".omp-execution-group")).toBeNull();
		const grepHeader = finalizedRow?.querySelector(".omp-tool-header");
		expect(grepHeader?.querySelector(".omp-tool-name")?.textContent).toBe("grep");

		if (!grepHeader) throw new Error("Finalized Grep card missing");
		await act(async () => {
			grepHeader.click();
		});
		const specializedBody = finalizedRow?.querySelector(".omp-tool-body");
		expect(specializedBody?.textContent).toContain("/needle/");
		expect(specializedBody?.textContent).toContain("src/final.ts");
		expect(specializedBody?.textContent).toContain("1 match");
	});
	it("shows finalized compact thoughts directly without a completed-steps disclosure", async () => {
		useMessagesStore.setState({
			messages: [assistant([{ type: "thinking", thinking: "Finalized compact thought" }], 100)],
		});
		useSessionStore.setState({ status: "ready" });
		useUiStore.setState({ thinkingExpanded: false, transcriptDetail: "compact" });

		await mount(<ChatStream />);

		if (!container) throw new Error("TranscriptViewport mount missing");
		expect(container.querySelector(".omp-execution-group")).toBeNull();
		expect(container.querySelector(".omp-thinking-block")?.textContent).toContain("Finalized compact thought");
		expect(container.querySelector(".omp-thinking-preview.italic")).not.toBeNull();
	});

	it("shows live compact reasoning directly while tools and answer text remain visible", async () => {
		seedLiveCompactGrep();

		await mount(<ChatStream />);

		if (!container) throw new Error("TranscriptViewport mount missing");
		const liveRow = container.querySelector('[data-transcript-kind="streaming"]');
		const liveTurn = liveRow?.querySelector(".omp-streaming-turn");
		const reasoning = liveTurn?.querySelector(".omp-thinking-block");
		const toolCard = liveTurn?.querySelector(".omp-tool-card");
		const answerContainer = liveTurn?.children[2];
		expect(liveTurn?.querySelector(".omp-execution-group")).toBeNull();
		expect(reasoning?.textContent).toContain("Live compact reasoning");
		expect(toolCard?.querySelector(".omp-tool-name")?.textContent).toBe("grep");
		expect(reasoning?.querySelector(".omp-tool-card")).toBeNull();
		expect(liveTurn?.children[0]).toBe(reasoning);
		expect(liveTurn?.children[1]?.querySelector(".omp-tool-card")).toBe(toolCard);
		expect(answerContainer?.querySelector(".omp-streaming")).not.toBeNull();
		expect(answerContainer?.textContent).toContain("Streaming answer after tools");
	});

	it("keeps a timestamp-less live compact turn scoped to its current same-millisecond tool after settlement", async () => {
		const sharedNow = Date.parse("2026-08-05T06:00:00.000Z");
		vi.spyOn(Date, "now").mockReturnValue(sharedNow);

		useToolsStore.getState().applyEvents([
			{
				type: "tool_execution_start",
				toolCallId: "retained-bash",
				toolName: "bash",
				args: { command: "printf retained" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "retained-bash",
				toolName: "bash",
				result: "retained",
				isError: false,
			},
		]);

		useMessagesStore.getState().applyEvents([{ type: "message_start", message: { role: "assistant", content: [] } }]);
		useToolsStore.getState().applyEvents([
			{ type: "message_start", message: { role: "assistant", content: [] } },
			{
				type: "tool_execution_start",
				toolCallId: liveGrepCall.id,
				toolName: liveGrepCall.name,
				args: liveGrepCall.arguments,
			},
		]);
		useSessionStore.setState({ isStreaming: true, status: "ready" });
		useUiStore.setState({ thinkingExpanded: true, transcriptDetail: "compact", switchPending: null });

		await mount(<ChatStream />);

		if (!container) throw new Error("TranscriptViewport mount missing");
		const runningStreamingRow = container.querySelector('[data-transcript-kind="streaming"]');
		expect(runningStreamingRow).not.toBeNull();
		expect(runningStreamingRow?.querySelector('[data-tool-status="running"] .omp-tool-name')?.textContent).toBe(
			"grep",
		);
		expect(runningStreamingRow?.textContent).not.toContain("bash");

		await act(async () => {
			useToolsStore.getState().applyEvents([
				{
					type: "tool_execution_end",
					toolCallId: liveGrepCall.id,
					toolName: liveGrepCall.name,
					result: "src/live.ts:9:const needle = true;",
					isError: false,
				},
			]);
		});

		const settledStreamingRow = container.querySelector('[data-transcript-kind="streaming"]');
		expect(settledStreamingRow).not.toBeNull();
		const settledCard = settledStreamingRow?.querySelector('[data-tool-status="done"]');
		expect(settledCard?.querySelector(".omp-tool-name")?.textContent).toBe("grep");
		expect(settledStreamingRow?.textContent).not.toContain("bash");
	});
});

describe("TranscriptViewport cross-path tool parity", () => {
	it("renders one hydrated finalized tool sequence equivalently for Main and transcript-local projections", async () => {
		const grepCall: ToolCallContent = {
			type: "toolCall",
			id: "parity-grep",
			name: "grep",
			arguments: { pattern: "needle", path: "src" },
		};
		const lspCall: ToolCallContent = {
			type: "toolCall",
			id: "parity-lsp",
			name: "write",
			arguments: {
				path: "xd://lsp",
				content: '{"action":"hover","file":"src/outer.ts"}',
			},
		};
		const bashCall: ToolCallContent = {
			type: "toolCall",
			id: "parity-bash",
			name: "bash",
			arguments: { command: "printf BASH_STDOUT_READY" },
		};
		const browserCall: ToolCallContent = {
			type: "toolCall",
			id: "parity-browser",
			name: "write",
			arguments: {
				path: "xd://browser",
				content: '{"action":"open","name":"outer-tab"}',
			},
		};
		const mcpCall: ToolCallContent = {
			type: "toolCall",
			id: "parity-mcp",
			name: "write",
			arguments: {
				path: "xd://mcp__context_mode_ctx_execute",
				content: '{"language":"javascript","code":"return \\"outer\\""}',
			},
		};
		const unknownCall: ToolCallContent = {
			type: "toolCall",
			id: "parity-unknown",
			name: "write",
			arguments: {
				path: "xd://unknown_malformed_tool",
				content: '{"payload":',
			},
		};
		const grepDisplay = [
			"# src/",
			"## alpha.ts#A1B2",
			" *10│needle-one",
			"## beta.ts#C3D4",
			" *20│needle-two",
			" *21│needle-three",
			"## gamma.ts#E5F6",
			" *30│needle-four",
		].join("\n");
		const mcpJson = '{"items":[{"name":"alpha"}],"count":2}';
		const truncation = {
			meta: {
				truncation: {
					direction: "middle",
					truncatedBy: "middle",
					totalLines: 400,
					totalBytes: 8_000,
					outputLines: 40,
					outputBytes: 1_000,
					headRange: { start: 1, end: 20 },
					tailRange: { start: 381, end: 400 },
					elidedLines: 360,
					elidedBytes: 7_000,
					artifactId: "42",
				},
			},
		};
		const result = (call: ToolCallContent, text: string, details: unknown, timestamp: number): AgentMessage => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text }],
			details,
			isError: false,
			timestamp,
		});
		const startedAt = Date.parse("2026-08-05T08:00:00.000Z");
		const messages: AgentMessage[] = [
			assistant([grepCall, lspCall, bashCall, browserCall, mcpCall, unknownCall], startedAt),
			result(
				grepCall,
				grepDisplay,
				{
					displayContent: grepDisplay,
					files: ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"],
					matchCount: 4,
					fileCount: 3,
					scopePath: "src",
				},
				startedAt + 100,
			),
			result(
				lspCall,
				"Found 2 reference(s)\nsrc/ref-one.ts:4:2\nsrc/ref-two.ts:9:7",
				{
					xdev: {
						tool: "lsp",
						mode: "execute",
						args: { action: "references", file: "src/authoritative.ts" },
						inner: {
							action: "references",
							success: true,
							request: { file: "src/authoritative.ts" },
						},
					},
				},
				startedAt + 200,
			),
			result(
				bashCall,
				"BASH_STDOUT_READY\nCommand exited with code 0\nWall time: 1.25 seconds",
				{ exitCode: 0, wallTimeMs: 1_250 },
				startedAt + 1_250,
			),
			result(
				browserCall,
				"BROWSER_RESULT_READY",
				{
					xdev: {
						tool: "browser",
						mode: "execute",
						args: { action: "run", name: "parity-tab" },
						inner: { action: "run", success: true },
					},
				},
				startedAt + 300,
			),
			result(
				mcpCall,
				mcpJson,
				{
					xdev: {
						tool: "mcp__context_mode_ctx_execute",
						mode: "execute",
						args: {
							language: "javascript",
							code: 'return { items: [{ name: "alpha" }], count: 2 }',
							options: { timeout: 17 },
						},
						inner: {
							serverName: "context-mode",
							mcpToolName: "ctx_execute",
							rawContent: [{ type: "text", text: mcpJson }],
							success: true,
							...truncation,
						},
					},
				},
				startedAt + 400,
			),
			result(
				unknownCall,
				"MALFORMED_GENERIC_BODY {not-json",
				{
					xdev: {
						tool: "unknown_malformed_tool",
						mode: "execute",
						args: {
							i: "Malformed unknown device",
							payload: { kind: "unknown-request", retry: 9 },
						},
						inner: { success: true },
					},
				},
				startedAt + 500,
			),
		];

		useMessagesStore.setState({
			messages,
			streamingMessage: null,
			streamingText: "",
			streamingThinking: "",
		});
		useToolsStore.getState().hydrateMessages(messages);
		const projectedTools = hydrateToolProjection(createToolProjection(), messages);
		useQueueStore.setState({
			steering: [
				{
					id: "main-only-parity-queue",
					text: "MAIN_ONLY_PARITY_AUGMENT",
					editable: true,
					timestamp: startedAt + 600,
				},
			],
			followUp: [],
		});
		useSessionStore.setState({ isStreaming: false, status: "ready" });
		useUiStore.setState({ transcriptDetail: "compact" });

		await mount(
			<>
				<section data-parity-path="main">
					<ChatStream />
				</section>
				<section data-parity-path="projected">
					<TranscriptViewport
						mode="subagent"
						projection={{
							transcriptId: "parity-projection",
							messages,
							streamingMessage: null,
							streamingText: "",
							streamingThinking: "",
							activeTools: projectedTools.activeTools,
							streamGeneration: projectedTools.streamGeneration,
							resolveToolCall: call => resolveProjectionToolCall(projectedTools, call),
							transcriptDetail: "compact",
						}}
					/>
				</section>
			</>,
		);

		if (!container) throw new Error("TranscriptViewport parity mount missing");
		const mounted = container as unknown as HTMLElement;
		const main = mounted.querySelector<HTMLElement>('[data-parity-path="main"]');
		const projected = mounted.querySelector<HTMLElement>('[data-parity-path="projected"]');
		if (!main || !projected) throw new Error("TranscriptViewport parity paths missing");
		const semanticText = (node: Element | null) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
		const semantics = (card: HTMLElement) => ({
			name: card.getAttribute("data-tool-name"),
			shell: card.getAttribute("data-tool-shell"),
			status: card.getAttribute("data-tool-status"),
			summary: semanticText(card.querySelector(".omp-tool-summary")),
			expanded: card.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
			body: semanticText(card.querySelector(".omp-tool-body")),
		});
		const mainCards = Array.from(main.querySelectorAll<HTMLElement>(".omp-tool-card"));
		const projectedCards = Array.from(projected.querySelectorAll<HTMLElement>(".omp-tool-card"));
		const expectedNames = [
			"grep",
			"lsp",
			"bash",
			"browser",
			"mcp__context_mode_ctx_execute",
			"unknown_malformed_tool",
		];
		const expectedShells = ["compact", "compact", "framed", "framed", "framed", "framed"];
		const expectedSummaries = [
			"needle",
			"references",
			"printf BASH_STDOUT_READY",
			"run parity-tab",
			"context-mode/ctx_execute",
			"Malformed unknown device",
		];

		expect(mainCards.map(card => card.getAttribute("data-tool-name"))).toEqual(expectedNames);
		expect(projectedCards.map(card => card.getAttribute("data-tool-name"))).toEqual(expectedNames);
		expect(mainCards.map(card => card.getAttribute("data-tool-shell"))).toEqual(expectedShells);
		expect(projectedCards.map(card => card.getAttribute("data-tool-shell"))).toEqual(expectedShells);
		expect(mainCards.map(card => card.getAttribute("data-tool-status"))).toEqual(expectedNames.map(() => "done"));
		expect(projectedCards.map(card => card.getAttribute("data-tool-status"))).toEqual(
			expectedNames.map(() => "done"),
		);
		expect(mainCards.map(card => semanticText(card.querySelector(".omp-tool-summary")))).toEqual(expectedSummaries);
		expect(projectedCards.map(card => semanticText(card.querySelector(".omp-tool-summary")))).toEqual(
			expectedSummaries,
		);
		expect(mainCards.slice(0, 2).every(card => card.querySelector(".omp-tool-body") !== null)).toBe(true);
		expect(mainCards.slice(2).every(card => card.querySelector(".omp-tool-body") === null)).toBe(true);
		expect(projectedCards.map(semantics)).toEqual(mainCards.map(semantics));
		expect(main.textContent).toContain("MAIN_ONLY_PARITY_AUGMENT");
		expect(projected.textContent).not.toContain("MAIN_ONLY_PARITY_AUGMENT");

		await act(async () => {
			for (const card of [...mainCards, ...projectedCards]) {
				const disclosure = card.querySelector<HTMLButtonElement>("button[aria-expanded]");
				if (!disclosure) throw new Error(`Native disclosure missing for ${card.getAttribute("data-tool-name")}`);
				disclosure.click();
			}
		});

		expect(projectedCards.map(semantics)).toEqual(mainCards.map(semantics));
		expect(mainCards.map(card => card.querySelector("button")?.getAttribute("aria-expanded"))).toEqual(
			expectedNames.map(() => "true"),
		);
		for (const pathCards of [mainCards, projectedCards]) {
			const body = (index: number) => semanticText(pathCards[index]?.querySelector(".omp-tool-body") ?? null);
			expect(body(0).match(/needle-(?:one|two|three|four)/g)).toEqual([
				"needle-one",
				"needle-two",
				"needle-three",
				"needle-four",
			]);
			expect(body(1)).toContain("src/ref-one.ts");
			expect(body(1)).toContain("line 4, col 2");
			expect(body(1)).toContain("src/ref-two.ts");
			expect(body(1)).toContain("line 9, col 7");
			expect(body(2)).toContain("BASH_STDOUT_READY");
			expect(body(2)).toContain("exit 0");
			expect(body(2)).toContain("Wall: 1.25s");
			expect(body(3)).toContain("run");
			expect(body(3)).toContain("BROWSER_RESULT_READY");
			expect(body(4)).toContain("alpha");
			expect(body(4)).toContain("360");
			expect(body(4)).toContain("artifact://42");
			expect(
				Array.from(pathCards[4]?.querySelectorAll('[data-value-type="number"]') ?? []).some(node =>
					node.textContent?.includes("2"),
				),
			).toBe(true);
			expect(
				Array.from(pathCards[4]?.querySelectorAll('[data-value-type="string"]') ?? []).some(node =>
					node.textContent?.includes("alpha"),
				),
			).toBe(true);
			expect(body(5)).toContain("unknown-request");
			expect(body(5)).toContain("MALFORMED_GENERIC_BODY {not-json");
			expect(
				Array.from(pathCards[5]?.querySelectorAll('[data-value-type="number"]') ?? []).some(node =>
					node.textContent?.includes("9"),
				),
			).toBe(true);
		}
	});
});
