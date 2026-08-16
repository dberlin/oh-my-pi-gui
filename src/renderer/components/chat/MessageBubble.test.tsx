import { parseHTML } from "linkedom";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage, ToolCallContent } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { groupReadRows } from "../../lib/read-group";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { ReadGroupCard } from "../tools/ReadGroupCard";

import { MessageBubble } from "./MessageBubble";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

const toolCallId = "call_read_package";
const assistantMessage: AgentMessage = {
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: toolCallId,
			name: "read",
			arguments: { path: "packages/gui/package.json" },
		},
	],
	timestamp: "2026-08-02T12:00:00.000Z",
};
const toolResultMessage: AgentMessage = {
	role: "toolResult",
	toolCallId,
	toolName: "read",
	content: [{ type: "text", text: '{"name":"@oh-my-pi/omp-gui"}' }],
	isError: false,
	timestamp: "2026-08-02T12:00:01.000Z",
};

function completedToolEntry(result: string): ToolEntry {
	return {
		toolName: "read",
		args: {},
		status: "done",
		partialResult: null,
		streamingArgs: "",
		result,
		isError: false,
		startTime: 1,
		endTime: 2,
	};
}

afterEach(() => {
	useToolsStore.getState().reset();
});

describe("MessageBubble tool messages", () => {
	it("hydrates a completed tool card and folds away the standalone result", () => {
		useToolsStore.getState().hydrateMessages([assistantMessage, toolResultMessage]);

		const entry = useToolsStore.getState().activeTools.get(toolCallId);
		expect(entry).toMatchObject({
			toolName: "read",
			args: { path: "packages/gui/package.json" },
			status: "done",
			isError: false,
		});

		const callHtml = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={assistantMessage} />
			</I18nProvider>,
		);
		expect(callHtml).toContain("read");
		expect(callHtml).toContain("packages/gui/package.json");
		expect(
			renderToStaticMarkup(
				<I18nProvider>
					<MessageBubble message={toolResultMessage} />
				</I18nProvider>,
			),
		).toBe("");
	});

	it("shows edited files for freeform edit calls in collapsed headers", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_edit_patch",
					name: "edit",
					arguments: {
						input: "*** Begin Patch\n[packages/gui/src/first.ts#A1B2] PUT 1.=1:\n+first\n[packages/gui/src/second.ts#C3D4] PUT 1.=1:\n+second\n*** End Patch\n",
					},
				},
			],
			timestamp: "2026-08-12T00:00:00.000Z",
		};
		useToolsStore.getState().hydrateMessages([message]);

		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={message} />
			</I18nProvider>,
		);
		expect(html).toContain("packages/gui/src/first.ts +1");
	});

	it("keeps repeated provider call ids paired with their own historical results", async () => {
		const firstCall: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "read:0", name: "read", arguments: { path: "first.txt" } }],
			timestamp: "2026-08-02T12:00:02.000Z",
		};
		const firstResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "read:0",
			toolName: "read",
			content: [{ type: "text", text: "FIRST_RESULT" }],
			timestamp: "2026-08-02T12:00:03.000Z",
		};
		const secondCall: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "read:0", name: "read", arguments: { path: "second.txt" } }],
			timestamp: "2026-08-02T12:00:04.000Z",
		};
		const secondResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "read:0",
			toolName: "read",
			content: [{ type: "text", text: "SECOND_RESULT" }],
			timestamp: "2026-08-02T12:00:05.000Z",
		};
		useToolsStore.getState().hydrateMessages([firstCall, firstResult, secondCall, secondResult]);
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<div id="first-call">
							<MessageBubble message={firstCall} />
						</div>
						<div id="second-call">
							<MessageBubble message={secondCall} />
						</div>
					</I18nProvider>,
				);
			});
			const firstNode = container.querySelector("#first-call");
			const secondNode = container.querySelector("#second-call");
			const firstButton = firstNode?.querySelector("button");
			const secondButton = secondNode?.querySelector("button");
			if (!firstNode || !secondNode || !firstButton || !secondButton) throw new Error("tool cards did not render");
			await act(async () => firstButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			await act(async () => secondButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			expect(firstNode.textContent).toContain("FIRST_RESULT");
			expect(firstNode.textContent).not.toContain("SECOND_RESULT");
			expect(secondNode.textContent).toContain("SECOND_RESULT");
			expect(secondNode.textContent).not.toContain("FIRST_RESULT");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("keeps explicit repeated-id occurrences paired through rerenders", async () => {
		const firstCall: ToolCallContent = {
			type: "toolCall",
			id: "projection-read:0",
			name: "read",
			arguments: { path: "first.txt" },
		};
		const secondCall: ToolCallContent = {
			type: "toolCall",
			id: "projection-read:0",
			name: "read",
			arguments: { path: "second.txt" },
		};
		const projection = new WeakMap<ToolCallContent, { key: string; entry: ToolEntry }>([
			[firstCall, { key: "projection-read:0#1", entry: completedToolEntry("FIRST_PROJECTED_RESULT") }],
			[secondCall, { key: "projection-read:0#2", entry: completedToolEntry("SECOND_PROJECTED_RESULT") }],
		]);
		const resolveToolCall = (call: ToolCallContent) =>
			projection.get(call) ?? { key: call.id, entry: completedToolEntry("UNEXPECTED_RESULT") };
		const projectedMessage = (content: ToolCallContent[]): AgentMessage => ({
			role: "assistant",
			content,
			timestamp: "2026-08-02T12:00:06.000Z",
		});
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<MessageBubble
							message={projectedMessage([firstCall, secondCall])}
							resolveToolCall={resolveToolCall}
						/>
					</I18nProvider>,
				);
			});
			const buttons = container.querySelectorAll(".omp-tool-header");
			const secondButton = buttons.item(1);
			if (!secondButton) throw new Error("second projected tool card did not render");
			await act(async () => secondButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			expect(container.textContent).toContain("SECOND_PROJECTED_RESULT");

			await act(async () => {
				root.render(
					<I18nProvider>
						<MessageBubble message={projectedMessage([secondCall])} resolveToolCall={resolveToolCall} />
					</I18nProvider>,
				);
			});
			expect(container.textContent).toContain("SECOND_PROJECTED_RESULT");
			expect(container.textContent).not.toContain("FIRST_PROJECTED_RESULT");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("does not subscribe projected tool cards to Main tool updates", async () => {
		const call: ToolCallContent = {
			type: "toolCall",
			id: "isolated-read:0",
			name: "read",
			arguments: { path: "isolated.txt" },
		};
		const projected = completedToolEntry("ISOLATED_RESULT");
		const resolveToolCall = () => ({ key: "isolated-read:0#projected", entry: projected });
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		let commits = 0;
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<Profiler id="projected-tool" onRender={() => commits++}>
							<MessageBubble
								message={{ ...assistantMessage, content: [call] }}
								resolveToolCall={resolveToolCall}
							/>
						</Profiler>
					</I18nProvider>,
				);
			});
			const commitsBeforeMainUpdate = commits;

			await act(async () => {
				useToolsStore.setState({
					activeTools: new Map([["isolated-read:0#projected", { ...projected, status: "error", isError: true }]]),
				});
			});

			expect(commits).toBe(commitsBeforeMainUpdate);
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("does not fall back to a conflicting Main entry when an ungrouped projection entry is missing", async () => {
		const call: ToolCallContent = {
			type: "toolCall",
			id: "missing-projected-read",
			name: "read",
			arguments: { path: "projected-only.ts" },
		};
		useToolsStore.setState({
			activeTools: new Map([[call.id, completedToolEntry("MAIN_UNGROUPED_RESULT")]]),
		});
		const resolveToolCall = () => ({ key: call.id, entry: undefined });
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<MessageBubble message={{ ...assistantMessage, content: [call] }} resolveToolCall={resolveToolCall} />
					</I18nProvider>,
				);
			});
			expect(container.querySelector('.omp-tool-card[data-tool-status="running"]')).not.toBeNull();
			const header = container.querySelector(".omp-tool-header");
			if (!header) throw new Error("projected tool card did not render");
			await act(async () => header.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			expect(container.textContent).not.toContain("MAIN_UNGROUPED_RESULT");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("renders grouped read results from the supplied projection instead of Main", async () => {
		const firstCall: ToolCallContent = {
			type: "toolCall",
			id: "group-read:0",
			name: "read",
			arguments: { path: "first.ts" },
		};
		const secondCall: ToolCallContent = {
			type: "toolCall",
			id: "group-read:0",
			name: "read",
			arguments: { path: "second.ts" },
		};
		const projection = new WeakMap<ToolCallContent, { key: string; entry: ToolEntry }>([
			[firstCall, { key: "group-read:0#1", entry: completedToolEntry("FIRST_GROUP_RESULT") }],
			[secondCall, { key: "group-read:0#2", entry: completedToolEntry("SECOND_GROUP_RESULT") }],
		]);
		const resolveToolCall = (call: ToolCallContent) =>
			projection.get(call) ?? { key: call.id, entry: completedToolEntry("UNEXPECTED_RESULT") };
		const grouped = groupReadRows(
			[
				{ kind: "message" as const, message: { ...assistantMessage, content: [firstCall] } },
				{ kind: "message" as const, message: { ...assistantMessage, content: [secondCall] } },
			],
			resolveToolCall,
		);
		const group = grouped[0];
		if (group?.kind !== "readGroup") throw new Error("projected read group did not render");

		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<ReadGroupCard entries={group.entries} resolveToolCall={resolveToolCall} />
					</I18nProvider>,
				);
			});
			const header = container.querySelector(".omp-read-group-header");
			if (!header) throw new Error("read group header did not render");
			await act(async () => header.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			for (const button of container.querySelectorAll(".omp-tool-header")) {
				await act(async () => button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			}
			expect(container.textContent).toContain("FIRST_GROUP_RESULT");
			expect(container.textContent).toContain("SECOND_GROUP_RESULT");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});

	it("does not fall back to conflicting Main entries when grouped projection entries are missing", async () => {
		const firstCall: ToolCallContent = {
			type: "toolCall",
			id: "missing-group-read-1",
			name: "read",
			arguments: { path: "first-projected.ts" },
		};
		const secondCall: ToolCallContent = {
			type: "toolCall",
			id: "missing-group-read-2",
			name: "read",
			arguments: { path: "second-projected.ts" },
		};
		useToolsStore.setState({
			activeTools: new Map([
				[firstCall.id, completedToolEntry("MAIN_FIRST_GROUP_RESULT")],
				[secondCall.id, completedToolEntry("MAIN_SECOND_GROUP_RESULT")],
			]),
		});
		const resolveToolCall = (call: ToolCallContent) => ({ key: call.id, entry: undefined });
		const grouped = groupReadRows(
			[
				{ kind: "message" as const, message: { ...assistantMessage, content: [firstCall] } },
				{ kind: "message" as const, message: { ...assistantMessage, content: [secondCall] } },
			],
			resolveToolCall,
		);
		const group = grouped[0];
		if (group?.kind !== "readGroup") throw new Error("missing-entry read group did not render");
		const projectedTools = new Map<string, ToolEntry>();
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		try {
			await act(async () => {
				root.render(
					<I18nProvider>
						<ReadGroupCard
							activeTools={projectedTools}
							entries={group.entries}
							resolveToolCall={resolveToolCall}
						/>
					</I18nProvider>,
				);
			});
			const header = container.querySelector(".omp-read-group-header");
			if (!header) throw new Error("missing-entry read group header did not render");
			await act(async () => header.dispatchEvent(new Event("click", { bubbles: true, cancelable: true })));
			expect(container.querySelectorAll('.omp-tool-card[data-tool-status="running"]')).toHaveLength(2);
			expect(container.textContent).not.toContain("MAIN_FIRST_GROUP_RESULT");
			expect(container.textContent).not.toContain("MAIN_SECOND_GROUP_RESULT");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});

describe("MessageBubble user content", () => {
	it("shows an assistant reaction on the user bubble", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: "Ship it?" }],
						timestamp: "2026-08-06T00:00:00.000Z",
					}}
					reaction="👍"
				/>
			</I18nProvider>,
		);
		expect(html).toContain('role="img"');
		expect(html).toContain("👍");
	});

	it("renders user text through the same Markdown pipeline as assistant text", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: "**bold** and `code`" }],
						timestamp: "2026-08-06T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<code");
	});

	it("keeps SQL JSONPath dollars literal instead of parsing them as inline math", () => {
		const sql =
			"JSON_SET(o.parameters, '$.reasoning_effort.required', FALSE, '$.reasoning_effort.default', 'medium')";
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "user",
						content: [{ type: "text", text: sql }],
						timestamp: "2026-08-13T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("$.reasoning_effort.required");
		expect(html).toContain("$.reasoning_effort.default");
		expect(html).not.toContain("katex");
	});
});

describe("MessageBubble compaction summaries", () => {
	it("shows the maintenance method and before-to-after context size", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "compactionSummary",
						summary: "Long archived context details.",
						shortSummary: "Kept the active work.",
						method: "remote",
						tokensBefore: 256_000,
						tokensAfter: 20_000,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);

		expect(html).toContain("Remote compacted · 256.0k → 20.0k");
		expect(html).toContain("Kept the active work.");
		expect(html).not.toContain("Long archived context details.");
	});

	it("preserves an unknown maintenance method and a zero-token starting point", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "compactionSummary",
						summary: "Future compactor finished.",
						method: "future",
						tokensBefore: 0,
						tokensAfter: 12,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);

		expect(html).toContain("future · 0 → 12");
	});
});

describe("MessageBubble completion events", () => {
	it("renders supervised-process failures as one compact status row without the wire type", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					compact
					message={{
						role: "custom",
						customType: "launch-completion",
						content: "Supervised process backend-smoke failed with exit code 1.",
						details: {
							daemons: [{ name: "backend-smoke", state: "failed", exitCode: 1 }],
						},
						display: true,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("backend-smoke");
		expect(html).toContain("exit 1");
		expect(html).not.toContain("launch-completion");
		expect(html).not.toContain("omp-custom-turn");
	});

	it("keeps background output behind one native disclosure row", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble
					message={{
						role: "custom",
						customType: "async-result",
						content: "<system-notice>Background job bg-7 has completed.\nBUILD_OUTPUT</system-notice>",
						details: { jobs: [{ jobId: "bg-7", type: "bash", label: "bun run build" }] },
						display: true,
						timestamp: "2026-08-20T00:00:00.000Z",
					}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("bun run build");
		expect(html).toContain("Background job completed");
		expect(html).toContain("<details");
		expect(html).not.toContain("<details open");
		expect(html).toContain("BUILD_OUTPUT");
	});
});

describe("MessageBubble noise filtering", () => {
	const at = "2026-08-02T12:00:00.000Z";

	it('renders nothing for punctuation-only text or thinking blocks (model filler like ".")', () => {
		for (const text of [".", "…", "---", " ", "***"]) {
			for (const message of [
				{ role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: at },
				{ role: "assistant" as const, content: [{ type: "thinking" as const, thinking: text }], timestamp: at },
			]) {
				expect(
					renderToStaticMarkup(
						<I18nProvider>
							<MessageBubble message={message} />
						</I18nProvider>,
					),
				).toBe("");
			}
		}
	});

	it("keeps real text, CJK, and emoji-only blocks", () => {
		for (const text of ["已修复", "Done.", "👍"]) {
			const message: AgentMessage = { role: "assistant", content: [{ type: "text", text }], timestamp: at };
			expect(
				renderToStaticMarkup(
					<I18nProvider>
						<MessageBubble message={message} />
					</I18nProvider>,
				),
			).toContain(text);
		}
	});

	it("compacts tool-only messages — no hover footer chrome", () => {
		useToolsStore.getState().hydrateMessages([assistantMessage, toolResultMessage]);
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={assistantMessage} />
			</I18nProvider>,
		);
		// The timestamp/copy/branch footer is message-level chrome a tool card
		// doesn't need (copy would copy an empty string).
		expect(html).not.toContain("Copy message text");
		expect(html).toContain("py-1.5");
	});

	it("keeps the footer on text-bearing messages", () => {
		const mixed: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "text", text: "Fixed." },
				{ type: "toolCall", id: "call_mixed", name: "read", arguments: { path: "x" } },
			],
			timestamp: at,
		};
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble message={mixed} />
			</I18nProvider>,
		);
		expect(html).toContain("Fixed.");
		expect(html).toContain("Copy message text");
		expect(html).toContain("py-3");
	});



});

describe("MessageBubble read-only actions", () => {
	it("retains copying but cannot branch a projected assistant answer into Main", () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: "Completed the child investigation." }],
			entryId: "child-answer",
			timestamp: 1,
		};
		const render = (readOnly: boolean) =>
			parseHTML(
				renderToStaticMarkup(
					<I18nProvider>
						<MessageBubble message={message} readOnly={readOnly} />
					</I18nProvider>,
				),
			).document;
		const branch = `button[aria-label="${translate("chat.branchFromHere")}"]`;
		expect(render(false).querySelector(branch)).not.toBeNull();
		const projected = render(true);
		expect(projected.querySelector(branch)).toBeNull();
		expect(projected.querySelector(`button[title="${translate("chat.copyMessage")}"]`)).not.toBeNull();
	});
});
