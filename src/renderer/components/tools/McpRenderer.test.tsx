import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { McpRenderer } from "./McpRenderer";
import { ToolCard, type ToolCardProps, type ToolRendererProps } from "./ToolCard";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const installedGlobals = { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true };
const priorGlobals = new Map<string, PropertyDescriptor | undefined>();
const mounts: Array<{ container: HTMLElement; root: Root }> = [];

const SAFE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const SAFE_PNG_URL = `data:image/png;base64,${SAFE_PNG_BASE64}`;
const MCP_ARGS = {
	language: "javascript",
	code: "return { count: 2 }",
	options: { timeout: 17 },
};
const JSON_RESULT = '{"items":[{"name":"alpha"}],"count":2}';

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

function completedEntry(
	toolName: string,
	args: Record<string, unknown>,
	result: unknown,
	options: { isError?: boolean; status?: ToolEntry["status"] } = {},
): ToolEntry {
	return {
		toolName,
		args,
		status: options.status ?? "done",
		partialResult: null,
		streamingArgs: "",
		result,
		isError: options.isError ?? false,
		startTime: 1,
		endTime: 2,
	};
}

function directMcpResult(text: string, rawContent: unknown[] = [{ type: "text", text }], extraDetails = {}) {
	return {
		content: [{ type: "text", text }],
		details: {
			serverName: "context-mode",
			mcpToolName: "ctx_execute",
			rawContent,
			...extraDetails,
		},
	};
}

function truncationDetails() {
	return {
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

function expectStructuredValue(root: ParentNode, type: "string" | "number" | "boolean" | "null", value: string) {
	const values = Array.from(root.querySelectorAll(`[data-value-type="${type}"]`));
	expect(values.some(node => node.textContent?.includes(value))).toBe(true);
}

function mcpRendererProps(result: unknown): ToolRendererProps {
	return {
		args: MCP_ARGS,
		result,
		isError: false,
		isPartial: false,
		partialResult: null,
		view: "expanded",
	};
}

afterEach(async () => {
	for (const mounted of mounts.splice(0).reverse()) {
		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	}
	useSettingsStore.getState().reset();
	useToolsStore.getState().reset();
	useUiStore.setState({ toolsExpandAll: { expanded: false, seq: 0 } });
});

describe("MCP and Generic tool rendering", () => {
	it("gives direct and authoritative Xdev MCP calls equivalent identity, framed disclosure, and structured expanded data", async () => {
		const directResult = directMcpResult(JSON_RESULT);
		const outerArgs = {
			path: "xd://mcp__outer_name",
			content: '{"language":"javascript","code":"outer"}',
		};
		const xdevResult = {
			content: [{ type: "text", text: JSON_RESULT }],
			details: {
				xdev: {
					tool: "mcp__parsed_final",
					mode: "execute",
					args: MCP_ARGS,
					inner: {
						serverName: "context-mode",
						mcpToolName: "ctx_execute",
						rawContent: [{ type: "text", text: JSON_RESULT }],
						success: true,
					},
				},
			},
		};
		const container = await mount(
			<>
				<ToolCard
					toolCallId="direct-mcp"
					toolName="mcp__context_mode_ctx_execute"
					args={MCP_ARGS}
					entry={completedEntry("mcp__context_mode_ctx_execute", MCP_ARGS, directResult)}
				/>
				<ToolCard
					toolCallId="xdev-mcp"
					toolName="write"
					args={outerArgs}
					entry={completedEntry("write", outerArgs, xdevResult)}
				/>
			</>,
		);
		const cards = Array.from(container.querySelectorAll(".omp-tool-card")) as HTMLElement[];
		expect(cards).toHaveLength(2);
		expect(cards.map(card => card.querySelector(".omp-tool-summary")?.textContent)).toEqual([
			"context-mode/ctx_execute",
			"context-mode/ctx_execute",
		]);
		expect(cards.map(card => card.getAttribute("data-tool-shell"))).toEqual(["framed", "framed"]);
		expect(cards.map(card => card.querySelector("button")?.getAttribute("aria-expanded"))).toEqual([
			"false",
			"false",
		]);
		expect(cards[1]?.getAttribute("data-tool-name")).toBe("mcp__parsed_final");
		expect(cards[1]?.textContent).not.toContain("xd://mcp__outer_name");
		expect(cards.every(card => card.querySelector(".omp-tool-body") === null)).toBe(true);

		for (const card of cards) await toggleCard(card);

		for (const card of cards) {
			expect(card.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
			expect(card.textContent).toContain("language");
			expect(card.textContent).toContain("options");
			expect(card.textContent).toContain("count");
			expectStructuredValue(card, "string", "javascript");
			expectStructuredValue(card, "number", "17");
			expectStructuredValue(card, "number", "2");
			expect(card.querySelector(".markdown-body")).toBeNull();
		}
	});

	it("uses sanitized Markdown for a non-JSON MCP result when the synchronized preference is enabled", async () => {
		useSettingsStore.setState({ mcpRenderMarkdownResults: true });
		const unsafeMarkdown = [
			"# Safe heading",
			"",
			"**rendered safely**",
			"",
			"<script>UNSAFE_SCRIPT_CONTENT</script>",
			'<span onclick="void 0">safe span</span>',
			'<a href="javascript:void 0">unsafe link</a>',
		].join("\n");
		const container = await mount(<McpRenderer {...mcpRendererProps(directMcpResult(unsafeMarkdown))} />);

		expect(container.querySelector(".markdown-body")).not.toBeNull();
		expect(container.querySelector("h1")?.textContent).toBe("Safe heading");
		expect(container.querySelector("strong")?.textContent).toBe("rendered safely");
		expect(container.querySelector("script,[onclick],[onerror],[href^='javascript:']")).toBeNull();
		expect(container.textContent).not.toContain("UNSAFE_SCRIPT_CONTENT");
	});

	it("uses plain preformatted text for a non-JSON MCP result when the preference is disabled", async () => {
		useSettingsStore.setState({ mcpRenderMarkdownResults: false });
		const literal = '# Literal heading\n\n**literal strong**\n<span data-literal-html="true">literal HTML</span>';
		const container = await mount(<McpRenderer {...mcpRendererProps(directMcpResult(literal))} />);

		expect(container.querySelector(".markdown-body")).toBeNull();
		expect(container.querySelector("strong,[onclick]")).toBeNull();
		const plainResult = Array.from(container.querySelectorAll("pre")).find(node => node.textContent === literal);
		expect(plainResult).toBeDefined();
	});

	it("renders one safe MCP data image and makes truncation recovery metadata visible", async () => {
		const result = directMcpResult(
			"[Image: image/png]",
			[{ type: "image", data: SAFE_PNG_BASE64, mimeType: "image/png" }],
			truncationDetails(),
		);
		const container = await mount(<McpRenderer {...mcpRendererProps(result)} />);
		const images = Array.from(container.querySelectorAll("img"));
		const renderer = container.firstElementChild;
		const artifactUri = "artifact://42";
		const recoveryControl = container.querySelector(`a[href="${artifactUri}"]`);

		expect(images).toHaveLength(1);
		expect(images[0]?.getAttribute("src")).toBe(SAFE_PNG_URL);
		expect(container.textContent).toMatch(/truncat/i);
		expect(container.textContent).toContain("360");
		expect(recoveryControl?.getAttribute("href")).toBe(artifactUri);
		expect(recoveryControl?.textContent).toContain(artifactUri);
		if (!renderer || !recoveryControl) throw new Error("Artifact recovery control did not render");

		const click = new Event("click", { bubbles: true, cancelable: true });
		await act(async () => {
			recoveryControl.dispatchEvent(click);
		});

		expect(click.defaultPrevented).toBe(true);
		expect(container.firstElementChild).toBe(renderer);
		expect(container.contains(recoveryControl)).toBe(true);
		expect(recoveryControl.getAttribute("href")).toBe(artifactUri);
		expect(recoveryControl.textContent).toContain(artifactUri);
	});

	it("keeps authoritative MCP identity and error status on a failed disclosed card", async () => {
		useSettingsStore.setState({ mcpRenderMarkdownResults: true });
		const result = directMcpResult("Error: **MCP_EXECUTION_FAILED**", [
			{ type: "text", text: "Error: **MCP_EXECUTION_FAILED**" },
		]);
		const card = await mountCard({
			toolCallId: "failed-mcp",
			toolName: "mcp__context_mode_ctx_execute",
			args: MCP_ARGS,
			entry: completedEntry("mcp__context_mode_ctx_execute", MCP_ARGS, result, {
				isError: true,
				status: "error",
			}),
		});

		expect(card.getAttribute("data-tool-name")).toBe("mcp__context_mode_ctx_execute");
		expect(card.getAttribute("data-tool-shell")).toBe("framed");
		expect(card.getAttribute("data-tool-status")).toBe("error");
		expect(card.getAttribute("data-tool-error")).toBe("true");
		expect(card.querySelector(".omp-tool-summary")?.textContent).toBe("context-mode/ctx_execute");
		await toggleCard(card);
		expect(card.textContent).toContain("MCP_EXECUTION_FAILED");
		expect(card.querySelector("strong")?.textContent).toBe("MCP_EXECUTION_FAILED");
	});

	it("keeps a malformed unknown tool Generic while structuring its args, JSON, image, and truncation", async () => {
		const args = {
			payload: { kind: "unknown-request", retry: 9 },
			flags: [true, null],
		};
		const result = {
			content: [
				{ type: "text", text: '{"records":[{"kind":"generic-result"}],"total":3}' },
				{ type: "image", data: SAFE_PNG_BASE64, mimeType: "image/png" },
			],
			details: truncationDetails(),
		};
		const card = await mountCard({
			toolCallId: "malformed-unknown",
			toolName: "unknown_malformed_tool",
			args,
			entry: completedEntry("unknown_malformed_tool", args, result),
		});

		expect(card.getAttribute("data-tool-name")).toBe("unknown_malformed_tool");
		expect(card.getAttribute("data-tool-shell")).toBe("framed");
		expect(card.querySelector(".omp-tool-name")?.textContent).toBe("unknown_malformed_tool");
		expect(card.querySelector(".omp-tool-summary")?.textContent).not.toBe("context-mode/ctx_execute");
		await toggleCard(card);

		expect(card.textContent).toContain("unknown-request");
		expect(card.textContent).toContain("generic-result");
		expectStructuredValue(card, "number", "9");
		expectStructuredValue(card, "number", "3");
		expectStructuredValue(card, "boolean", "true");
		expectStructuredValue(card, "null", "null");
		expect(card.querySelector(".markdown-body")).toBeNull();
		const images = Array.from(card.querySelectorAll("img"));
		expect(images).toHaveLength(1);
		expect(images[0]?.getAttribute("src")).toBe(SAFE_PNG_URL);
		expect(card.textContent).toMatch(/truncat/i);
		expect(card.textContent).toContain("artifact://42");
	});
});
