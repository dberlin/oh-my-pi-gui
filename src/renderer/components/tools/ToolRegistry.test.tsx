import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { ToolCard } from "./ToolCard";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;


const containers: HTMLElement[] = [];
const roots: Root[] = [];

async function mountCard(toolCallId: string, toolName: string, args: Record<string, unknown>): Promise<void> {
	// Cards read the shared expand-all target on mount, so expand before rendering.
	useUiStore.getState().toggleToolsExpandAll();
	const container = document.createElement("div");
	document.body.appendChild(container);
	containers.push(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ToolCard toolCallId={toolCallId} toolName={toolName} args={args} />
			</I18nProvider>,
		);
	});
}

function bodyText(): string {
	return containers.map(container => container.textContent ?? "").join("");
}

/** A `write xd://<tool>` call, as the tools store sees it. */
function deviceCall(toolCallId: string, args: Record<string, unknown>, result: unknown): void {
	useToolsStore.getState().applyEvents([
		{ type: "tool_execution_start", toolCallId, toolName: "write", args },
		{ type: "tool_execution_end", toolCallId, toolName: "write", result, isError: false },
	]);
}

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	for (const container of containers.splice(0)) container.remove();
	useToolsStore.getState().reset();
	useUiStore.setState({ toolsExpandAll: { expanded: false, seq: 0 } });
});

describe("tool registry coverage", () => {

	it("names a live call in its own header", async () => {
		useToolsStore.getState().applyEvents([
			{
				type: "tool_execution_start",
				toolCallId: "hdr",
				toolName: "find",
				args: { query: "where retries are counted" },
			},
		]);
		await mountCard("hdr", "find", { query: "where retries are counted" });

		// The header belongs to the card: a transcript layer that has to pass it
		// in leaves live cards from ChatStream and ReadGroupCard blank.
		const headers = containers.flatMap(container =>
			[...container.querySelectorAll(".omp-tool-summary")].map(node => node.textContent),
		);
		expect(headers).toEqual(["where retries are counted"]);
	});
});

describe("device calls routed through write", () => {
	it("renders the scan outcome instead of a file write", async () => {
		const args = { path: "xd://security_scan", content: '{"action":"start","plan_id":"p-1"}' };
		deviceCall("scan", args, {
			content: [{ type: "text", text: "Security scan scan-9 started as op-3." }],
			details: {
				xdev: {
					tool: "security_scan",
					mode: "execute",
					args: { action: "start", plan_id: "p-1" },
					inner: { action: "start", operation: { scanId: "scan-9", phase: "reviewing", findingCount: 0 } },
				},
			},
		});
		await mountCard("scan", "write", args);

		expect(bodyText()).toContain("Security scan scan-9 started as op-3.");
		expect(bodyText()).toContain("plan_id");
		// The payload is a JSON request, not a file: a line count would be fiction.
		expect(bodyText()).not.toMatch(/\d+ lines?\b/);
	});

	it("renders a plan resolution through the resolve card", async () => {
		const args = { path: "xd://resolve", content: '{"action":"apply"}' };
		deviceCall("res", args, {
			content: [{ type: "text", text: "Applied 3 ops." }],
			details: {
				xdev: {
					tool: "resolve",
					mode: "execute",
					args: { action: "apply" },
					inner: {
						action: "apply",
						label: "ast_edit: rename the flag",
						sourceToolName: "ast_edit",
						sourceResultDetails: { ops: [{}, {}, {}] },
					},
				},
			},
		});
		await mountCard("res", "write", args);

		expect(bodyText()).toContain("Applied");
		expect(bodyText()).toContain("3 ops");
		expect(bodyText()).toContain("rename the flag");
	});

	it("does not claim a verdict for a device call that never returned", async () => {
		useToolsStore.getState().applyEvents([
			{
				type: "tool_execution_start",
				toolCallId: "live",
				toolName: "write",
				args: { path: "xd://grep", content: '{"pattern":"dispatchXdevTool"' },
			},
		]);
		await mountCard("live", "write", { path: "xd://grep", content: '{"pattern":"dispatchXdevTool"' });

		// GrepRenderer reads a missing result as zero matches.
		expect(bodyText()).not.toContain("No matches");
		expect(bodyText()).toContain("dispatchXdevTool");
	});

	it("keeps a real file write on the write card", async () => {
		const args = { path: "src/app.ts", content: "export const a = 1;" };
		deviceCall("file", args, {
			content: [{ type: "text", text: "Successfully wrote 21 bytes to src/app.ts" }],
			details: {},
		});
		await mountCard("file", "write", args);

		expect(bodyText()).toContain("src/app.ts");
		expect(bodyText()).toContain("1 line");
	});
});

