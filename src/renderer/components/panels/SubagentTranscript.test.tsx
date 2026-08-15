import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, RpcResponse, SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { type AgentViewLoader, useAgentViewStore } from "../../stores/agent-view";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useSubagentsStore } from "../../stores/subagents";
import { useTodoStore } from "../../stores/todo";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { ChatCanvas } from "../chat/ChatStream";
import { SubagentTranscript } from "./SubagentTranscript";
import { buildSubagentList } from "./subagent-graph";

const { document, window, Event, CustomEvent, HTMLElement, Element, Node } = parseHTML(
	"<!doctype html><html><body></body></html>",
);
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
	querySelectorAll: (selector: string) => TestElement[];
	dispatchEvent: (event: Event) => boolean;
	getAttribute: (name: string) => string | null;
}

interface TestWindow {
	omp: {
		rpc: {
			getSubagentMessages: AgentViewLoader["getSubagentMessages"];
		};
	};
}

const agent: SubagentSnapshot = {
	id: "agent-a1",
	index: 1,
	agent: "scout",
	status: "running",
	sessionFile: "/sessions/agent-a1.jsonl",
	lastUpdate: 1,
	kind: "sub",
};

const finalizedCall = {
	type: "toolCall" as const,
	id: "subagent-read",
	name: "read",
	arguments: { path: "src/example.ts" },
};
const finalizedMessages: AgentMessage[] = [
	{
		role: "user",
		id: "subagent-user-entry",
		content: [
			{ type: "text", text: "Inspect this image." },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		],
		timestamp: "2026-08-13T12:00:00.000Z",
	},
	{
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Inspect the renderer path." },
			{ type: "text", text: "```ts\nconst answer = 42;\n```" },
			finalizedCall,
		],
		model: "projection-model",
		usage: { input: 1200, output: 300, cacheRead: 40, cacheWrite: 0, cost: { total: 0.002 } },
		duration: 2400,
		timestamp: "2026-08-13T12:00:01.000Z",
	},
	{
		role: "toolResult",
		toolCallId: "subagent-read",
		toolName: "read",
		content: [{ type: "text", text: "export const answer = 42;" }],
		timestamp: "2026-08-13T12:00:02.000Z",
	},
];

let container: TestElement | undefined;
let root: Root | undefined;

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "get_subagent_messages", success: true, data };
}

function fail(error: string): RpcResponse {
	return { type: "response", command: "get_subagent_messages", success: false, error };
}

function setSubagentLoader(getSubagentMessages: AgentViewLoader["getSubagentMessages"]): void {
	const rpcWindow = window as unknown as TestWindow;
	rpcWindow.omp = { rpc: { getSubagentMessages } };
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function click(element: TestElement | null): Promise<void> {
	if (!element) throw new Error("Expected clickable element");
	await act(async () => {
		const event = new Event("click", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
		element.dispatchEvent(event);
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
	useAgentViewStore.getState().reset();
	useMessagesStore.getState().reset();
	useQueueStore.setState({ steering: [], followUp: [] });
	useSessionStore.getState().reset();
	useSettingsStore.getState().reset();
	useSubagentsStore.getState().reset();
	useTodoStore.getState().reset();
	useToolsStore.getState().reset();
	useUiStore.setState({ thinkingExpanded: false, transcriptDetail: "compact", switchPending: null });
});

describe("selected transcript canvas", () => {
	it("switches between Main and an isolated full-parity subagent projection", async () => {
		const getSubagentMessages = vi.fn<AgentViewLoader["getSubagentMessages"]>(async () =>
			ok({ messages: finalizedMessages, nextByte: 100, hasMore: false }),
		);
		setSubagentLoader(getSubagentMessages);
		useSubagentsStore.getState().setSnapshots([agent]);

		const mainMessages: AgentMessage[] = [
			{
				role: "user",
				id: "main-user-entry",
				content: [{ type: "text", text: "Main only transcript" }],
				timestamp: 1,
			},
			{
				role: "custom",
				customType: "extension-control",
				content: [{ type: "text", text: "Main extension control" }],
				timestamp: 2,
			},
		];
		const mainTool: ToolEntry = {
			toolName: "bash",
			args: { command: "main command" },
			status: "running",
			partialResult: "main partial",
			streamingArgs: "",
			result: null,
			isError: false,
			startTime: 1,
			endTime: null,
		};
		const mainTools = new Map([["main-tool", mainTool]]);
		useMessagesStore.setState({
			messages: mainMessages,
			streamingMessage: null,
			streamingText: "",
			streamingThinking: "",
		});
		useToolsStore.setState({ activeTools: mainTools });
		useQueueStore.setState({
			steering: [{ id: "main-queued", text: "Main queued steer", editable: true, timestamp: 3 }],
			followUp: [],
		});
		useTodoStore.setState({
			history: [
				{
					id: "main-todo",
					ts: 2,
					phases: [{ name: "Main", tasks: [{ content: "Main todo row", status: "in_progress" }] }],
				},
			],
		});
		useSessionStore.setState({
			sessionId: "main-session",
			status: "ready",
			isStreaming: true,
			retryInfo: {
				attempt: 1,
				maxAttempts: 2,
				delayMs: 1000,
				errorMessage: "Main retry row",
				startedAt: Date.now(),
			},
		});
		useSettingsStore.setState({ showTokenUsage: true });
		useUiStore.setState({ thinkingExpanded: true, transcriptDetail: "full", switchPending: null });

		await mount(<ChatCanvas />);
		if (!container) throw new Error("Canvas mount missing");
		expect(container.textContent).toContain("Main only transcript");
		expect(container.querySelector('button[title="Branch conversation from here"]')).not.toBeNull();

		await act(async () => {
			await useAgentViewStore.getState().selectSubagent(agent);
		});
		await flush();

		expect(getSubagentMessages).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[data-agent-view-id="agent-a1"]')).not.toBeNull();
		expect(container.querySelector(".omp-transcript-scroll")).not.toBeNull();
		expect(container.querySelector(".omp-thinking-block")?.textContent).toContain("Inspect the renderer path.");
		expect(container.querySelector(".hljs-keyword")?.textContent).toBe("const");
		expect(container.querySelector('img[alt="attached image"]')?.getAttribute("src")).toBe(
			"data:image/png;base64,aGVsbG8=",
		);
		expect(container.querySelector('[title="1,200 input tokens"]')).not.toBeNull();
		expect(container.textContent).toContain("projection-model");
		expect(container.querySelector(".omp-read-group")).not.toBeNull();
		await click(container.querySelector(".omp-read-group-header"));
		expect(container.querySelector('.omp-tool-card[data-tool-status="done"]')).not.toBeNull();
		await click(container.querySelector(".omp-tool-header"));
		expect(container.textContent).toContain("export const answer = 42;");

		expect(container.textContent).not.toContain("Main only transcript");
		expect(container.textContent).not.toContain("Main extension control");
		expect(container.textContent).not.toContain("Main queued steer");
		expect(container.textContent).not.toContain("Main todo row");
		expect(container.textContent).not.toContain("Main retry row");
		expect(container.querySelector('[data-transcript-kind="queued"]')).toBeNull();
		expect(container.querySelector('[data-transcript-kind="todoSnapshot"]')).toBeNull();
		expect(container.querySelector('[data-transcript-kind="pending"]')).toBeNull();
		expect(container.querySelector(".omp-history-expander")).toBeNull();
		expect(container.querySelector('button[title="Branch conversation from here"]')).toBeNull();

		await act(async () => {
			useSessionStore.setState({
				retryInfo: null,
				compactionInfo: { reason: "overflow", action: "compact" },
			});
		});
		expect(container.querySelector(".omp-status-turn")).toBeNull();
		expect(container.textContent).not.toContain("Context overflow detected");
		expect(useMessagesStore.getState().messages).toBe(mainMessages);
		expect(useToolsStore.getState().activeTools).toBe(mainTools);

		await act(async () => {
			useAgentViewStore.getState().selectMain();
		});
		expect(container.textContent).toContain("Main only transcript");
		expect(container.textContent).toContain("Context overflow detected");
		expect(container.textContent).not.toContain("Inspect the renderer path.");
	});

	it("registers loaded and live spawn ownership for nested agent hierarchy", async () => {
		const loadedSpawnCall = {
			type: "toolCall" as const,
			id: "spawn-loaded-child",
			name: "task",
			arguments: { agent: "scout", task: "loaded child" },
		};
		const liveSpawnCall = {
			type: "toolCall" as const,
			id: "spawn-live-child",
			name: "task",
			arguments: { agent: "scout", task: "live child" },
		};
		const loadedMessage: AgentMessage = {
			role: "assistant",
			content: [loadedSpawnCall],
			timestamp: 1,
		};
		const liveMessage: AgentMessage = {
			role: "assistant",
			content: [liveSpawnCall],
			timestamp: 2,
		};
		const loadedChild: SubagentSnapshot = {
			...agent,
			id: "loaded-child",
			index: 2,
			sessionFile: "/sessions/loaded-child.jsonl",
			parentToolCallId: loadedSpawnCall.id,
		};
		const liveChild: SubagentSnapshot = {
			...agent,
			id: "live-child",
			index: 3,
			sessionFile: "/sessions/live-child.jsonl",
			parentToolCallId: liveSpawnCall.id,
		};
		setSubagentLoader(async () => ok({ messages: [loadedMessage], nextByte: 10, hasMore: false }));
		useSubagentsStore.getState().setSnapshots([agent, loadedChild]);
		await useAgentViewStore.getState().selectSubagent(agent);
		await mount(<SubagentTranscript />);

		const loadedRows = buildSubagentList(
			[agent, loadedChild],
			new Set<string>(),
			useSubagentsStore.getState().toolCallOwners,
		);
		expect(loadedRows.find(row => row.agent.id === loadedChild.id)?.depth).toBe(1);

		await act(async () => {
			useSubagentsStore.getState().setSnapshots([agent, loadedChild, liveChild]);
			useAgentViewStore.getState().applyFrame({
				type: "subagent_event",
				payload: { id: agent.id, event: { type: "message_start", message: liveMessage } },
			});
		});
		await flush();

		const liveRows = buildSubagentList(
			[agent, loadedChild, liveChild],
			new Set<string>(),
			useSubagentsStore.getState().toolCallOwners,
		);
		expect(liveRows.find(row => row.agent.id === liveChild.id)?.depth).toBe(1);
		expect(useSubagentsStore.getState().toolCallOwners).toEqual(
			new Map([
				[loadedSpawnCall.id, agent.id],
				[liveSpawnCall.id, agent.id],
			]),
		);
	});

	it("renders live text, thinking, and tool updates without refetching or touching Main stores", async () => {
		const getSubagentMessages = vi.fn<AgentViewLoader["getSubagentMessages"]>(async () =>
			ok({ messages: [], nextByte: 0, hasMore: false }),
		);
		setSubagentLoader(getSubagentMessages);
		useSubagentsStore.getState().setSnapshots([agent]);
		useUiStore.setState({ thinkingExpanded: true, transcriptDetail: "full", switchPending: null });

		const mainMessages = useMessagesStore.getState().messages;
		const mainTools = useToolsStore.getState().activeTools;
		await useAgentViewStore.getState().selectSubagent(agent);
		await mount(<ChatCanvas />);
		if (!container) throw new Error("Canvas mount missing");

		const liveCall = {
			type: "toolCall" as const,
			id: "live-bash",
			name: "bash",
			arguments: { command: "bun test" },
		};
		const liveMessage: AgentMessage = {
			role: "assistant",
			content: [liveCall],
			timestamp: Date.now(),
		};
		const finalizedLiveMessage: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Final projected reasoning" },
				{ type: "text", text: "**Final projected answer**" },
				liveCall,
			],
			timestamp: liveMessage.timestamp,
		};
		await act(async () => {
			const applyFrame = useAgentViewStore.getState().applyFrame;
			applyFrame({
				type: "subagent_event",
				payload: { id: agent.id, event: { type: "message_start", message: liveMessage } },
			});
			applyFrame({
				type: "subagent_event",
				payload: {
					id: agent.id,
					event: {
						type: "message_update",
						message: liveMessage,
						assistantMessageEvent: {
							type: "text_delta",
							contentIndex: 1,
							// Closed paragraph so the streamed text parses as a block, not the plain tail.
							delta: "**Live projected answer**\n\n",
							partial: liveMessage,
						},
					},
				},
			});
			applyFrame({
				type: "subagent_event",
				payload: {
					id: agent.id,
					event: {
						type: "message_update",
						message: liveMessage,
						assistantMessageEvent: {
							type: "thinking_delta",
							contentIndex: 2,
							delta: "Live projected reasoning",
							partial: liveMessage,
						},
					},
				},
			});
			applyFrame({
				type: "subagent_event",
				payload: {
					id: agent.id,
					event: {
						type: "message_update",
						message: liveMessage,
						assistantMessageEvent: {
							type: "toolcall_delta",
							contentIndex: 0,
							delta: '{"command":"bun test"}',
							partial: liveMessage,
						},
					},
				},
			});
		});

		expect(container.querySelector(".omp-streaming strong")?.textContent).toBe("Live projected answer");
		expect(container.querySelector(".omp-thinking-block")?.textContent).toContain("Live projected reasoning");
		expect(container.querySelector('.omp-tool-card[data-tool-status="running"]')).not.toBeNull();
		await act(async () => {
			const applyFrame = useAgentViewStore.getState().applyFrame;
			applyFrame({
				type: "subagent_event",
				payload: { id: agent.id, event: { type: "message_end", message: finalizedLiveMessage } },
			});
			applyFrame({
				type: "subagent_event",
				payload: {
					id: agent.id,
					event: {
						type: "tool_execution_start",
						toolCallId: liveCall.id,
						toolName: liveCall.name,
						args: liveCall.arguments,
					},
				},
			});
		});
		expect(container.querySelector('.omp-tool-card[data-tool-status="running"]')).not.toBeNull();

		await click(container.querySelector(".omp-tool-header"));
		await act(async () => {
			useAgentViewStore.getState().applyFrame({
				type: "subagent_event",
				payload: {
					id: agent.id,
					event: {
						type: "tool_execution_update",
						toolCallId: liveCall.id,
						toolName: liveCall.name,
						args: liveCall.arguments,
						partialResult: "live partial output",
					},
				},
			});
		});
		expect(container.textContent).toContain("live partial output");

		await act(async () => {
			useAgentViewStore.getState().applyFrame({
				type: "subagent_event",
				payload: {
					id: agent.id,
					event: {
						type: "tool_execution_end",
						toolCallId: liveCall.id,
						toolName: liveCall.name,
						result: "live final output",
						isError: false,
					},
				},
			});
		});

		expect(container.querySelector(".omp-assistant-turn strong")?.textContent).toBe("Final projected answer");
		expect(container.textContent).toContain("Final projected reasoning");
		expect(container.querySelector('.omp-tool-card[data-tool-status="done"]')).not.toBeNull();
		expect(getSubagentMessages).toHaveBeenCalledTimes(1);
		expect(useMessagesStore.getState().messages).toBe(mainMessages);
		expect(useToolsStore.getState().activeTools).toBe(mainTools);
	});

	it("keeps loading and empty states bounded to the transcript canvas", async () => {
		const page = Promise.withResolvers<RpcResponse>();
		setSubagentLoader(async () => page.promise);
		const loading = useAgentViewStore.getState().selectSubagent(agent);

		await mount(<SubagentTranscript />);
		if (!container) throw new Error("Canvas mount missing");
		const loadingState = container.querySelector('[data-agent-view-id="agent-a1"]');
		expect(loadingState?.textContent).toContain("Loading transcript…");
		expect(loadingState?.getAttribute("class")).toContain("flex-1");

		page.resolve(ok({ messages: [], nextByte: 0, hasMore: false }));
		await act(async () => {
			await loading;
		});
		expect(container.textContent).toContain("No transcript entries yet.");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: agent.id });
	});

	it("keeps the selected identity on load error and retries inline", async () => {
		const getSubagentMessages = vi
			.fn<AgentViewLoader["getSubagentMessages"]>()
			.mockResolvedValueOnce(fail("transcript unavailable"))
			.mockResolvedValueOnce(
				ok({
					messages: [
						{ role: "assistant", content: [{ type: "text", text: "Recovered transcript" }], timestamp: 1 },
					],
					nextByte: 10,
					hasMore: false,
				}),
			);
		setSubagentLoader(getSubagentMessages);
		useSubagentsStore.getState().setSnapshots([agent]);
		await useAgentViewStore.getState().selectSubagent(agent);

		await mount(<ChatCanvas />);
		if (!container) throw new Error("Canvas mount missing");
		expect(container.querySelector('[data-agent-view-id="agent-a1"]')).not.toBeNull();
		expect(container.textContent).toContain("Transcript failed");
		expect(container.textContent).toContain("transcript unavailable");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: agent.id });

		await click(container.querySelector("button"));
		await flush();

		expect(getSubagentMessages).toHaveBeenCalledTimes(2);
		expect(container.textContent).toContain("Recovered transcript");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: agent.id });
	});
});
