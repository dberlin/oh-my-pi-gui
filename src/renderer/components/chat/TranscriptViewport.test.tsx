import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage, ToolCallContent } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useTodoStore } from "../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
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
	textContent: string | null;
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
