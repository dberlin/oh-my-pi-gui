import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useToolsStore } from "../../stores/tools";
import { MessageBubble } from "./MessageBubble";

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
});

describe("MessageBubble noise filtering", () => {
	const at = "2026-08-02T12:00:00.000Z";

	it('renders nothing for punctuation-only text blocks (model filler like ".")', () => {
		for (const text of [".", "…", "---", " ", "***"]) {
			const message: AgentMessage = { role: "assistant", content: [{ type: "text", text }], timestamp: at };
			expect(
				renderToStaticMarkup(
					<I18nProvider>
						<MessageBubble message={message} />
					</I18nProvider>,
				),
			).toBe("");
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

	it("uses compact chrome for expanded process details containing reasoning and tools", () => {
		const processMessage: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Inspect first." },
				{ type: "toolCall", id: "call_process", name: "read", arguments: { path: "x" } },
			],
			timestamp: at,
		};
		const html = renderToStaticMarkup(
			<I18nProvider>
				<MessageBubble compact message={processMessage} />
			</I18nProvider>,
		);
		expect(html).toContain("read");
		expect(html).not.toContain("Copy message text");
		expect(html).toContain("py-1.5");
		expect(html).toMatch(/^<div class="group flex px-6 py-1\.5">/);
	});
});
