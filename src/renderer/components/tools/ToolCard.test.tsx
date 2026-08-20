import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import * as RuntimeErrors from "../../lib/runtime-errors";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import * as ToolRegistry from "./index";
import { ToolCard, type ToolCardProps } from "./ToolCard";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const installedGlobals = { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true };
const priorGlobals = new Map<string, PropertyDescriptor | undefined>();
const mounts: Array<{ container: HTMLElement; root: Root }> = [];

beforeAll(() => {
	for (const [key, value] of Object.entries(installedGlobals)) {
		priorGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
});

afterAll(() => {
	for (const [key, descriptor] of priorGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function resultEnvelope(text: string, details: unknown = null): unknown {
	return { content: [{ type: "text", text }], details };
}

function completedEntry(toolName: string, args: Record<string, unknown>, result: unknown): ToolEntry {
	return {
		toolName,
		args,
		status: "done",
		partialResult: null,
		streamingArgs: "",
		result,
		isError: false,
		startTime: 1,
		endTime: 2,
	};
}

function runningEntry(toolName: string, args: Record<string, unknown>, partialResult: unknown): ToolEntry {
	return {
		toolName,
		args,
		status: "running",
		partialResult,
		streamingArgs: "",
		result: null,
		isError: false,
		startTime: Date.now(),
		endTime: null,
	};
}

async function mount(node: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	const root = createRoot(container as unknown as Element);
	mounts.push({ container, root });
	await act(async () => {
		root.render(<I18nProvider>{node}</I18nProvider>);
	});
	return container;
}

async function mountCard(props: ToolCardProps): Promise<HTMLElement> {
	const container = await mount(<ToolCard {...props} />);
	const card = container.querySelector(".omp-tool-card") as HTMLElement | null;
	if (!card) throw new Error("ToolCard did not render");
	return card;
}

async function toggleCard(card: HTMLElement): Promise<void> {
	const button = card.querySelector("button[aria-expanded]");
	if (!button) throw new Error("ToolCard disclosure did not render");
	await act(async () => {
		button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
}

function cardByName(container: HTMLElement, name: string): HTMLElement {
	const card = container.querySelector(`[data-tool-name="${name}"]`) as HTMLElement | null;
	if (!card) throw new Error(`ToolCard ${name} did not render`);
	return card;
}

const rendererError = new Error("renderer explosion");

function ExplodingRenderer(): never {
	throw rendererError;
}

afterEach(async () => {
	for (const mounted of mounts.splice(0).reverse()) {
		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	}
	useToolsStore.getState().reset();
	useUiStore.setState({ toolsExpandAll: { expanded: false, seq: 0 } });
	vi.restoreAllMocks();
});

describe("ToolCard adaptive rendering", () => {
	it("renders settled legacy device references as navigable locations without xdev metadata", async () => {
		const outerArgs = {
			path: "xd://lsp",
			content: '{"action":"references","file":"src/historical.ts"}',
		};
		const result = resultEnvelope("Found 1 reference(s)\nsrc/historical.ts:8:3");
		const card = await mountCard({
			toolCallId: "historical-xd-lsp",
			toolName: "write",
			args: outerArgs,
			entry: completedEntry("write", outerArgs, result),
		});

		expect(card.textContent).toContain("src/historical.ts");
		expect(card.textContent).toContain("line 8, col 3");
	});

	it("renders Xdev help as bounded escaped documentation instead of LSP execution output", async () => {
		const documentation = [
			'<img src="x" onerror="HELP_HANDLER_SHOULD_NOT_RUN">HELP_MARKUP</img>',
			"Found 8 reference(s)",
			"src/help.ts:1:1",
			"src/help.ts:2:2",
			"src/help.ts:3:3",
			"src/help.ts:4:4",
			...Array.from(
				{ length: 80 },
				(_, index) => `HELP_DOCUMENTATION_LINE_${index + 1} ${"documentation ".repeat(12)}`,
			),
			"HELP_DOCUMENTATION_TAIL",
		].join("\n");
		const outerArgs = { path: "xd://lsp", content: "" };
		const result = resultEnvelope(documentation, {
			xdev: {
				tool: "lsp",
				mode: "help",
				args: {},
				inner: { usage: "write LSP arguments to xd://lsp" },
			},
		});
		const card = await mountCard({
			toolCallId: "xd-lsp-help",
			toolName: "write",
			args: outerArgs,
			entry: completedEntry("write", outerArgs, result),
		});

		expect(card.textContent).toContain('<img src="x" onerror="HELP_HANDLER_SHOULD_NOT_RUN">HELP_MARKUP</img>');
		expect(card.textContent).toContain("Found 8 reference(s)");
		expect(card.querySelector("img,[onerror]")).toBeNull();
		expect(card.textContent).not.toContain("HELP_DOCUMENTATION_TAIL");

		await toggleCard(card);

		expect(card.textContent).toContain("HELP_DOCUMENTATION_TAIL");
	});

	it("previews bounded MCP arguments and result or error lines before mounting full disclosed bodies", async () => {
		const successArgs = {
			firstArg: "MCP_ARGUMENT_FIRST",
			padding: "argument-padding-".repeat(500),
			lastArg: "MCP_ARGUMENT_TAIL",
		};
		const successBody = JSON.stringify(
			{
				firstResult: "MCP_RESULT_FIRST",
				padding: "result-padding-".repeat(500),
				lastResult: "MCP_RESULT_TAIL",
			},
			null,
			2,
		);
		const successResult = resultEnvelope(successBody, {
			serverName: "context-mode",
			mcpToolName: "preview_success",
			rawContent: [{ type: "text", text: successBody }],
		});
		const errorArgs = {
			firstArg: "MCP_ERROR_ARGUMENT_FIRST",
			padding: "error-argument-padding-".repeat(500),
			lastArg: "MCP_ERROR_ARGUMENT_TAIL",
		};
		const errorBody = [
			"MCP_ERROR_FIRST",
			...Array.from({ length: 120 }, (_, index) => `MCP_ERROR_DETAIL_${index + 1} ${"failure ".repeat(20)}`),
			"MCP_ERROR_TAIL",
		].join("\n");
		const errorResult = resultEnvelope(errorBody, {
			serverName: "context-mode",
			mcpToolName: "preview_error",
			rawContent: [{ type: "text", text: errorBody }],
		});
		const container = await mount(
			<>
				<ToolCard
					toolCallId="mcp-preview-success"
					toolName="mcp__context_mode_preview_success"
					args={successArgs}
					entry={completedEntry("mcp__context_mode_preview_success", successArgs, successResult)}
				/>
				<ToolCard
					toolCallId="mcp-preview-error"
					toolName="mcp__context_mode_preview_error"
					args={errorArgs}
					entry={{
						...completedEntry("mcp__context_mode_preview_error", errorArgs, errorResult),
						status: "error",
						isError: true,
					}}
				/>
			</>,
		);
		const successCard = cardByName(container, "mcp__context_mode_preview_success");
		const errorCard = cardByName(container, "mcp__context_mode_preview_error");

		for (const card of [successCard, errorCard]) {
			expect(card.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
			expect(card.querySelector("[data-value-type]")).toBeNull();
			expect(card.textContent?.length ?? Number.POSITIVE_INFINITY).toBeLessThan(3_000);
		}
		expect(successCard.textContent).toContain("MCP_ARGUMENT_FIRST");
		expect(successCard.textContent).toContain("MCP_RESULT_FIRST");
		expect(successCard.textContent).not.toContain("MCP_ARGUMENT_TAIL");
		expect(successCard.textContent).not.toContain("MCP_RESULT_TAIL");
		expect(errorCard.textContent).toContain("MCP_ERROR_ARGUMENT_FIRST");
		expect(errorCard.textContent).toContain("MCP_ERROR_FIRST");
		expect(errorCard.textContent).not.toContain("MCP_ERROR_ARGUMENT_TAIL");
		expect(errorCard.textContent).not.toContain("MCP_ERROR_TAIL");

		await toggleCard(successCard);
		await toggleCard(errorCard);

		expect(successCard.textContent).toContain("MCP_ARGUMENT_TAIL");
		expect(successCard.textContent).toContain("MCP_RESULT_TAIL");
		expect(errorCard.textContent).toContain("MCP_ERROR_ARGUMENT_TAIL");
		expect(errorCard.textContent).toContain("MCP_ERROR_TAIL");
	});

	it("exposes localized statuses and only announces actual status transitions", async () => {
		const toolCallId = "accessible-status";
		const args = { pattern: "src/status/*" };
		useToolsStore.setState({
			activeTools: new Map([[toolCallId, runningEntry("glob", args, resultEnvelope("STATUS_RUNNING_BODY"))]]),
		});
		const card = await mountCard({ toolCallId, toolName: "glob", args });
		const accessibleName = () => card.querySelector("button[aria-expanded]")?.getAttribute("aria-label");
		const runningLabel = accessibleName();

		expect(card.getAttribute("data-tool-status")).toBe("running");
		expect(card.querySelector("[aria-live]")).toBeNull();

		await act(async () => {
			useToolsStore.setState({
				activeTools: new Map([[toolCallId, completedEntry("glob", args, resultEnvelope("STATUS_COMPLETED_BODY"))]]),
			});
		});

		const completedLabel = accessibleName();
		expect(completedLabel).not.toBe(runningLabel);
		expect(card.getAttribute("data-tool-status")).toBe("done");
		const completedAnnouncement = card.querySelector('[role="status"][aria-live="polite"]')?.textContent;
		expect(completedLabel).toContain(completedAnnouncement);
		expect(card.querySelector('[role="status"][aria-live="polite"]')?.getAttribute("aria-atomic")).toBe("true");
		expect(card.querySelectorAll("[aria-live]")).toHaveLength(1);

		await act(async () => {
			useToolsStore.setState({
				activeTools: new Map([
					[
						toolCallId,
						{
							...completedEntry("glob", args, resultEnvelope("STATUS_FAILED_BODY")),
							status: "error",
							isError: true,
						},
					],
				]),
			});
		});

		expect(accessibleName()).not.toBe(completedLabel);
		expect(card.getAttribute("data-tool-status")).toBe("error");
		const failedAnnouncement = card.querySelector('[role="status"][aria-live="polite"]')?.textContent;
		expect(failedAnnouncement).not.toBe(completedAnnouncement);
		expect(accessibleName()).toContain(failedAnnouncement);
		expect(card.querySelectorAll("[aria-live]")).toHaveLength(1);
	});

	it("previews two Grep matches with context and expands to all matches", async () => {
		const displayContent = [
			"# src/",
			"## alpha.ts#A1B2",
			"  9│context alpha",
			" *10│needle-one",
			"## beta.ts#C3D4",
			"  19│context beta",
			" *20│needle-two",
			" *21│needle-three",
			"## gamma.ts#E5F6",
			" *30│needle-four",
		].join("\n");
		const result = resultEnvelope(displayContent, {
			displayContent,
			files: ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"],
			matchCount: 4,
			fileCount: 3,
		});
		const args = { pattern: "needle" };
		const card = await mountCard({
			toolCallId: "grep-preview",
			toolName: "grep",
			args,
			entry: completedEntry("grep", args, result),
		});

		expect(card.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(card.textContent).toContain("src/alpha.ts");
		expect(card.textContent).toContain("context alpha");
		expect(card.textContent).toContain("needle-one");
		expect(card.textContent).toContain("src/beta.ts");
		expect(card.textContent).toContain("context beta");
		expect(card.textContent).toContain("needle-two");
		expect(card.textContent).not.toContain("needle-three");
		expect(card.textContent).not.toContain("needle-four");

		await toggleCard(card);

		expect(card.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		expect(card.textContent).toContain("needle-three");
		expect(card.textContent).toContain("needle-four");
	});

	it("bounds LSP diagnostic previews to three and expands to the full body", async () => {
		const text = [
			"Found 5 error(s)",
			"src/diag.ts:1:1 [error] DIAGNOSTIC_ONE",
			"src/diag.ts:2:1 [error] DIAGNOSTIC_TWO",
			"src/diag.ts:3:1 [error] DIAGNOSTIC_THREE",
			"src/diag.ts:4:1 [error] DIAGNOSTIC_FOUR",
			"src/diag.ts:5:1 [error] DIAGNOSTIC_FIVE",
		].join("\n");
		const args = { action: "diagnostics", file: "src/diag.ts" };
		const card = await mountCard({
			toolCallId: "lsp-diagnostics",
			toolName: "lsp",
			args,
			entry: completedEntry("lsp", args, resultEnvelope(text, { action: "diagnostics" })),
		});

		expect(card.textContent).toContain("DIAGNOSTIC_THREE");
		expect(card.textContent).not.toContain("DIAGNOSTIC_FOUR");
		expect(card.textContent).not.toContain("DIAGNOSTIC_FIVE");
		await toggleCard(card);
		expect(card.textContent).toContain("DIAGNOSTIC_FOUR");
		expect(card.textContent).toContain("DIAGNOSTIC_FIVE");
	});

	it("bounds LSP reference previews to three and expands to the full body", async () => {
		const text = [
			"Found 5 reference(s)",
			"src/ref-one.ts:1:1",
			"src/ref-two.ts:2:2",
			"src/ref-three.ts:3:3",
			"src/ref-four.ts:4:4",
			"src/ref-five.ts:5:5",
		].join("\n");
		const args = { action: "references", file: "src/ref.ts" };
		const card = await mountCard({
			toolCallId: "lsp-references",
			toolName: "lsp",
			args,
			entry: completedEntry("lsp", args, resultEnvelope(text, { action: "references" })),
		});

		expect(card.textContent).toContain("src/ref-three.ts");
		expect(card.textContent).not.toContain("src/ref-four.ts");
		expect(card.textContent).not.toContain("src/ref-five.ts");
		await toggleCard(card);
		expect(card.textContent).toContain("src/ref-four.ts");
		expect(card.textContent).toContain("src/ref-five.ts");
	});

	it("bounds LSP symbol previews to three and expands to the full body", async () => {
		const text = [
			"Symbols in src/symbols.ts:",
			"ƒ SYMBOL_ONE @ line 1",
			"ƒ SYMBOL_TWO @ line 2",
			"ƒ SYMBOL_THREE @ line 3",
			"ƒ SYMBOL_FOUR @ line 4",
			"ƒ SYMBOL_FIVE @ line 5",
		].join("\n");
		const args = { action: "symbols", file: "src/symbols.ts" };
		const card = await mountCard({
			toolCallId: "lsp-symbols",
			toolName: "lsp",
			args,
			entry: completedEntry("lsp", args, resultEnvelope(text, { action: "symbols" })),
		});

		expect(card.textContent).toContain("SYMBOL_THREE");
		expect(card.textContent).not.toContain("SYMBOL_FOUR");
		expect(card.textContent).not.toContain("SYMBOL_FIVE");
		await toggleCard(card);
		expect(card.textContent).toContain("SYMBOL_FOUR");
		expect(card.textContent).toContain("SYMBOL_FIVE");
	});

	it("keeps the LSP hover signature and first prose block in preview", async () => {
		const text = [
			"```ts",
			"function hoverSignature(): void",
			"```",
			"FIRST_HOVER_PROSE",
			"",
			"SECOND_HOVER_PROSE",
		].join("\n");
		const args = { action: "hover", file: "src/hover.ts" };
		const card = await mountCard({
			toolCallId: "lsp-hover",
			toolName: "lsp",
			args,
			entry: completedEntry("lsp", args, resultEnvelope(text, { action: "hover" })),
		});

		expect(card.textContent).toContain("hoverSignature");
		expect(card.textContent).toContain("FIRST_HOVER_PROSE");
		expect(card.textContent).not.toContain("SECOND_HOVER_PROSE");
		await toggleCard(card);
		expect(card.textContent).toContain("SECOND_HOVER_PROSE");
	});

	it("previews six Glob paths with an omitted count and expands to all paths", async () => {
		const paths = Array.from({ length: 8 }, (_, index) => `src/glob-path-${index + 1}.ts`);
		const args = { pattern: "src/**/*.ts" };
		const card = await mountCard({
			toolCallId: "glob-preview",
			toolName: "glob",
			args,
			entry: completedEntry("glob", args, resultEnvelope(paths.join("\n"))),
		});

		expect(card.textContent).toContain("src/glob-path-6.ts");
		expect(card.textContent).not.toContain("src/glob-path-7.ts");
		expect(card.textContent).not.toContain("src/glob-path-8.ts");
		await toggleCard(card);
		expect(card.textContent).toContain("src/glob-path-7.ts");
		expect(card.textContent).toContain("src/glob-path-8.ts");
	});

	it("previews six AST Grep matches with an omitted count and expands to all matches", async () => {
		const matches = Array.from(
			{ length: 8 },
			(_, index) => `src/ast-${index + 1}.ts:${index + 1}:1: const AST_MATCH_${index + 1} = target()`,
		);
		const args = { pat: "target()", path: "src" };
		const card = await mountCard({
			toolCallId: "ast-grep-preview",
			toolName: "ast_grep",
			args,
			entry: completedEntry("ast_grep", args, resultEnvelope(matches.join("\n"))),
		});

		expect(card.textContent).toContain("AST_MATCH_6");
		expect(card.textContent).not.toContain("AST_MATCH_7");
		expect(card.textContent).not.toContain("AST_MATCH_8");
		await toggleCard(card);
		expect(card.textContent).toContain("AST_MATCH_7");
		expect(card.textContent).toContain("AST_MATCH_8");
	});

	it("previews three Web Search results with an omitted count and expands to current caps", async () => {
		const sources = Array.from({ length: 5 }, (_, index) => ({
			title: `SEARCH_RESULT_${index + 1}`,
			url: `https://result-${index + 1}.example.test/article`,
			snippet: `snippet ${index + 1}`,
		}));
		const args = { query: "bounded previews" };
		const result = resultEnvelope("", {
			response: { provider: "fixture", answer: "SEARCH_ANSWER", sources },
		});
		const card = await mountCard({
			toolCallId: "web-search-preview",
			toolName: "web_search",
			args,
			entry: completedEntry("web_search", args, result),
		});

		expect(card.textContent).toContain("SEARCH_RESULT_3");
		expect(card.textContent).not.toContain("SEARCH_RESULT_4");
		expect(card.textContent).not.toContain("SEARCH_RESULT_5");
		await toggleCard(card);
		expect(card.textContent).toContain("SEARCH_RESULT_4");
		expect(card.textContent).toContain("SEARCH_RESULT_5");
	});

	it("bounds a multi-thousand-character Web Search answer until disclosure", async () => {
		const answer = `WEB_ANSWER_HEAD_${"A".repeat(6_000)}` + `WEB_ANSWER_MIDDLE_${"B".repeat(6_000)}WEB_ANSWER_TAIL`;
		const args = { query: "large answer allocation" };
		const result = resultEnvelope("", {
			response: { provider: "fixture", answer, sources: [] },
		});
		const card = await mountCard({
			toolCallId: "web-search-long-answer",
			toolName: "web_search",
			args,
			entry: completedEntry("web_search", args, result),
		});
		const previewAnswer = card.querySelector(".markdown-body");

		expect(previewAnswer?.textContent).toContain("WEB_ANSWER_HEAD");
		expect(previewAnswer?.textContent).not.toContain("WEB_ANSWER_MIDDLE");
		expect(previewAnswer?.textContent).not.toContain("WEB_ANSWER_TAIL");
		expect(previewAnswer?.textContent.length ?? Number.POSITIVE_INFINITY).toBeLessThan(3_000);

		await toggleCard(card);

		const expandedAnswer = card.querySelector(".markdown-body");
		expect(expandedAnswer?.textContent).toBe(answer);
	});
	it("keeps peer IRC messages visible while process Hub sends stay collapsed", async () => {
		const peerArgs = { op: "send", to: "PlanReviewer", message: "PEER_IRC_BODY" };
		const processArgs = { op: "send", name: "debugger", text: "PROCESS_STDIN_BODY" };
		const peerCard = await mountCard({
			toolCallId: "hub-peer-send",
			toolName: "hub",
			args: peerArgs,
			entry: completedEntry(
				"hub",
				peerArgs,
				resultEnvelope("Delivered.", {
					op: "send",
					to: "PlanReviewer",
					receipts: [{ to: "PlanReviewer", outcome: "woken" }],
				}),
			),
		});
		const processCard = await mountCard({
			toolCallId: "hub-process-send",
			toolName: "hub",
			args: processArgs,
			entry: completedEntry("hub", processArgs, resultEnvelope("PROCESS_RESULT", { op: "send", state: "ready" })),
		});

		expect(peerCard.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(peerCard.querySelector(".omp-tool-name")?.textContent).toBe("IRC");
		expect(peerCard.querySelector(".omp-tool-summary")?.textContent).toBe("→ PlanReviewer");
		expect(peerCard.querySelector(".omp-tool-preview")?.textContent).toContain("PEER_IRC_BODY");
		expect(peerCard.textContent).toContain("IRC");
		expect(processCard.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(processCard.querySelector(".omp-tool-name")?.textContent).toBe("hub");
		expect(processCard.querySelector(".omp-tool-preview")).toBeNull();
		expect(processCard.textContent).not.toContain("PROCESS_RESULT");
	});

	it("keeps a collapsed Bash framed body unmounted", async () => {
		const args = { command: "printf shell-output" };
		const card = await mountCard({
			toolCallId: "bash-framed",
			toolName: "bash",
			args,
			entry: completedEntry("bash", args, resultEnvelope("BASH_FRAME_BODY", { exitCode: 0 })),
		});

		expect(card.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(card.textContent).not.toContain("BASH_FRAME_BODY");
		await toggleCard(card);
		expect(card.textContent).toContain("BASH_FRAME_BODY");
	});

	it("reports and isolates a renderer exception to the failing entry", async () => {
		const originalGetToolRenderer = ToolRegistry.getToolRenderer;
		vi.spyOn(ToolRegistry, "getToolRenderer").mockImplementation(invocation =>
			invocation.name === "lsp"
				? { component: ExplodingRenderer, shell: "compact" }
				: originalGetToolRenderer(invocation),
		);
		const reportRuntimeError = vi.spyOn(RuntimeErrors, "reportRuntimeError").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const lspArgs = { action: "references" };
		const globArgs = { pattern: "src/*" };
		const container = await mount(
			<>
				<ToolCard
					toolCallId="broken-lsp"
					toolName="lsp"
					args={lspArgs}
					entry={completedEntry("lsp", lspArgs, resultEnvelope("RENDERER_FALLBACK_BODY"))}
				/>
				<ToolCard
					toolCallId="healthy-glob"
					toolName="glob"
					args={globArgs}
					entry={completedEntry("glob", globArgs, resultEnvelope("HEALTHY_PATH"))}
				/>
			</>,
		);
		const broken = cardByName(container, "lsp");
		const healthy = cardByName(container, "glob");

		expect(broken.textContent).toContain("RENDERER_FALLBACK_BODY");
		expect(healthy.textContent).toContain("HEALTHY_PATH");
		expect(healthy.textContent).not.toContain("RENDERER_FALLBACK_BODY");
		expect(reportRuntimeError).toHaveBeenCalledWith(
			"react-render",
			rendererError,
			expect.objectContaining({
				componentStack: expect.stringContaining("ExplodingRenderer"),
				details: expect.objectContaining({ boundary: "tool-renderer", tool: "lsp" }),
			}),
		);
	});

	it("preserves local disclosure state across a live partial update", async () => {
		const toolCallId = "live-glob";
		const args = { pattern: "src/*" };
		useToolsStore.setState({
			activeTools: new Map([[toolCallId, runningEntry("glob", args, resultEnvelope("PARTIAL_PATH_ONE"))]]),
		});
		const card = await mountCard({ toolCallId, toolName: "glob", args });
		await toggleCard(card);
		expect(card.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");

		await act(async () => {
			useToolsStore.setState({
				activeTools: new Map([
					[toolCallId, runningEntry("glob", args, resultEnvelope("PARTIAL_PATH_ONE\nPARTIAL_PATH_TWO"))],
				]),
			});
		});

		expect(card.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		expect(card.textContent).toContain("PARTIAL_PATH_TWO");
	});

	it("synchronizes shared expand and collapse across compact and framed cards", async () => {
		const globArgs = { pattern: "src/*" };
		const bashArgs = { command: "fixture-command" };
		const container = await mount(
			<>
				<ToolCard
					toolCallId="shared-glob"
					toolName="glob"
					args={globArgs}
					entry={completedEntry("glob", globArgs, resultEnvelope("SHARED_GLOB_PATH"))}
				/>
				<ToolCard
					toolCallId="shared-bash"
					toolName="bash"
					args={bashArgs}
					entry={completedEntry("bash", bashArgs, resultEnvelope("SHARED_BASH_BODY"))}
				/>
			</>,
		);
		const compact = cardByName(container, "glob");
		const framed = cardByName(container, "bash");
		expect(compact.textContent).toContain("SHARED_GLOB_PATH");
		expect(framed.textContent).not.toContain("SHARED_BASH_BODY");

		await act(async () => useUiStore.getState().toggleToolsExpandAll());

		expect(compact.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		expect(framed.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
		expect(framed.textContent).toContain("SHARED_BASH_BODY");

		await act(async () => useUiStore.getState().toggleToolsExpandAll());

		expect(compact.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(framed.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
		expect(compact.textContent).toContain("SHARED_GLOB_PATH");
		expect(framed.textContent).not.toContain("SHARED_BASH_BODY");
	});

	it("renders think results as escaped text", async () => {
		const args = { thought: "consider carefully" };
		const card = await mountCard({
			toolCallId: "think-domain",
			toolName: "think",
			args,
			entry: completedEntry("think", args, resultEnvelope('<img src="x" onerror="alert(1)">THINK_RESULT')),
		});
		await toggleCard(card);
		expect(card.textContent).toContain('<img src="x" onerror="alert(1)">THINK_RESULT');
		expect(card.querySelector("img")).toBeNull();
	});

	it("keeps an unanswered historical call interrupted and exposes its request", async () => {
		const message: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "historical-read", name: "read", arguments: { path: "requested.ts" } }],
			timestamp: 1_000,
		};
		useToolsStore.getState().hydrateMessages([message]);
		const card = await mountCard({ toolCallId: "historical-read", toolName: "read", args: { path: "requested.ts" } });
		expect(card.getAttribute("data-tool-status")).toBe("aborted");
		const header = card.querySelector("button[aria-expanded]")?.getAttribute("aria-label");
		const liveCard = await mountCard({
			toolCallId: "live-read",
			toolName: "read",
			args: { path: "requested.ts" },
			entry: runningEntry("read", { path: "requested.ts" }, null),
		});
		expect(header).not.toBe(liveCard.querySelector("button[aria-expanded]")?.getAttribute("aria-label"));
		await toggleCard(card);
		expect(card.querySelector("[data-value-type]")?.textContent).toContain("requested.ts");
	});

	it("preserves partial output when an interrupted call settles", async () => {
		const args = { path: "partial.ts" };
		const card = await mountCard({
			toolCallId: "interrupted-partial",
			toolName: "read",
			args,
			entry: {
				...runningEntry("read", args, resultEnvelope("OUTPUT_BEFORE_INTERRUPT")),
				status: "aborted",
				endTime: 2,
			},
		});
		expect(card.getAttribute("data-tool-status")).toBe("aborted");
		expect(card.textContent).toContain("OUTPUT_BEFORE_INTERRUPT");
	});

	it("does not leak an active-session entry into an explicitly isolated card", async () => {
		const args = { path: "isolated.ts" };
		useToolsStore.setState({
			activeTools: new Map([["shared-id", completedEntry("read", args, resultEnvelope("PRIVATE_MAIN_RESULT"))]]),
		});
		const isolated = await mountCard({ toolCallId: "shared-id", toolName: "read", args, entry: null });
		const main = await mountCard({ toolCallId: "shared-id", toolName: "read", args });
		expect(main.textContent).toContain("PRIVATE_MAIN_RESULT");
		expect(main.getAttribute("data-tool-status")).toBe("done");
		expect(isolated.textContent).not.toContain("PRIVATE_MAIN_RESULT");
		expect(isolated.getAttribute("data-tool-status")).toBe("running");
	});

	it("bounds raw pending arguments before the parsed arguments arrive", async () => {
		const card = await mountCard({
			toolCallId: "pending-raw",
			toolName: "bash",
			args: {},
			entry: {
				...runningEntry("bash", {}, null),
				status: "pending",
				streamingArgs: `{"command":"PENDING_HEAD ${"x".repeat(5_000)} PENDING_TAIL`,
			},
		});
		expect(card.textContent).toContain("PENDING_HEAD");
		expect(card.textContent).not.toContain("PENDING_TAIL");
		expect(card.textContent?.length ?? Number.POSITIVE_INFINITY).toBeLessThan(300);
	});

	it("renders a failed undispatched device response through the generic fallback", async () => {
		const args = { path: "xd://lsp", content: '{"action":"references","symbol":"privateSymbol"}' };
		const card = await mountCard({
			toolCallId: "undispatched-device",
			toolName: "write",
			args,
			entry: {
				...completedEntry("write", args, resultEnvelope("DEVICE_DID_NOT_DISPATCH")),
				status: "error",
				isError: true,
			},
		});
		await toggleCard(card);
		expect(card.textContent).toContain("DEVICE_DID_NOT_DISPATCH");
		expect(Array.from(card.querySelectorAll("[data-value-type]")).map(node => node.textContent)).toContain(
			"privateSymbol",
		);
	});

});

describe("ToolCard disclosure durability", () => {
	const args = { path: "src/index.ts", content: "ok" };

	async function mountWriteCard(): Promise<HTMLElement> {
		return mountCard({
			toolCallId: "durable-write",
			toolName: "write",
			args,
			entry: completedEntry("write", args, "written"),
		});
	}

	it("keeps an expanded card expanded when the row is virtualized away and back", async () => {
		useUiStore.setState({ disclosureOpen: {}, toolsExpandAll: { expanded: false, seq: 0 } });
		const card = await mountWriteCard();
		await toggleCard(card);
		expect(card.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");

		for (const mounted of mounts.splice(0).reverse()) {
			await act(async () => mounted.root.unmount());
			mounted.container.remove();
		}

		const remounted = await mountWriteCard();
		expect(remounted.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
	});

	it("lets expand-all override a card's own choice", async () => {
		useUiStore.setState({ disclosureOpen: {}, toolsExpandAll: { expanded: false, seq: 0 } });
		const card = await mountWriteCard();
		await toggleCard(card);

		await act(async () => {
			useUiStore.getState().toggleToolsExpandAll();
		});
		await act(async () => {
			useUiStore.getState().toggleToolsExpandAll();
		});

		expect(card.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
	});
});
