import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { type ToolEntry, useToolsStore } from "../../stores/tools";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { ExecutionGroup } = await import("./ExecutionGroup");
const { ToolCard } = await import("../tools/ToolCard");

let container: HTMLElement;
let root: Root;

function toolEntry(status: "running" | "error", isError = false): ToolEntry {
	return {
		toolName: "bash",
		args: {},
		status,
		partialResult: null,
		streamingArgs: "",
		result: null,
		isError,
		startTime: 1,
		endTime: status === "running" ? null : 2,
	};
}

async function mount(
	toolCallIds: string[] = [],
	live = false,
	children: ReactNode = <div data-testid="details">tool details</div>,
): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ExecutionGroup live={live} stepCount={2} toolCallIds={toolCallIds}>
					{children}
				</ExecutionGroup>
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useToolsStore.getState().reset();
});

describe("ExecutionGroup", () => {
	it("keeps completed work to one summary line until requested", async () => {
		await mount();
		expect(container.textContent).toContain("2 steps complete");
		expect(container.querySelector('[data-testid="details"]')).toBeNull();

		await act(async () => {
			(container.querySelector("button") as unknown as { click: () => void }).click();
		});
		expect(container.querySelector('[data-testid="details"]')).not.toBeNull();
	});

	it("keeps failed work compact while preserving its error summary and details", async () => {
		useToolsStore.setState({
			activeTools: new Map([["tool-1", toolEntry("error", true)]]),
		});
		await mount(["tool-1"]);

		expect(container.textContent).toContain("1 failed · 2 steps");
		expect(container.querySelector('[data-testid="details"]')).toBeNull();

		await act(async () => {
			(container.querySelector("button") as unknown as { click: () => void }).click();
		});
		expect(container.querySelector('[data-testid="details"]')).not.toBeNull();
	});

	it("opens active work and collapses it when execution settles", async () => {
		useToolsStore.setState({ activeTools: new Map([["tool-1", toolEntry("running")]]) });
		await mount(["tool-1"]);
		expect(container.querySelector('[data-testid="details"]')).not.toBeNull();

		await act(async () => {
			useToolsStore.setState({ activeTools: new Map([["tool-1", toolEntry("error", true)]]) });
		});

		expect(container.textContent).toContain("1 failed · 2 steps");
		expect(container.querySelector('[data-testid="details"]')).toBeNull();
	});

	it("keeps one animated status for a live group while running child steps remain visible", async () => {
		useToolsStore.setState({
			activeTools: new Map([
				["tool-1", toolEntry("running")],
				["tool-2", toolEntry("running")],
			]),
		});
		await mount(
			["tool-1", "tool-2"],
			true,
			<>
				<ToolCard toolCallId="tool-1" toolName="edit" args={{}} runningIndicator="dot" />
				<ToolCard toolCallId="tool-2" toolName="bash" args={{ command: "bun check" }} runningIndicator="dot" />
			</>,
		);
		await act(async () => {
			for (const button of container.querySelectorAll(".omp-tool-header")) {
				(button as unknown as { click: () => void }).click();
			}
		});

		expect(container.querySelectorAll(".animate-spin, .animate-pulse")).toHaveLength(1);
		expect(container.querySelectorAll(".omp-tool-status-icon")).toHaveLength(2);
		expect(container.querySelector('[role="status"]')?.textContent).toContain("2 running");
	});
});
