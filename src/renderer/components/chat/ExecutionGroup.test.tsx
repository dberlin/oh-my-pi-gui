import { parseHTML } from "linkedom";
import { act } from "react";
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

async function render(live = false, stepCount = 2): Promise<void> {
	await act(async () => {
		root.render(
			<I18nProvider>
				<ExecutionGroup live={live} stepCount={stepCount}>
					<div data-testid="reasoning">reasoning details</div>
				</ExecutionGroup>
			</I18nProvider>,
		);
	});
}

async function mount(live = false, stepCount = 2): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await render(live, stepCount);
}

function disclosureButton(): Element {
	const disclosure = container.querySelector(".omp-execution-group-header");
	expect(disclosure).not.toBeNull();
	return disclosure as Element;
}

function reasoningStatus(): Element {
	const status = container.querySelector('[role="status"]');
	expect(status).not.toBeNull();
	return status as Element;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useToolsStore.getState().reset();
});

describe("ExecutionGroup", () => {
	it("opens live reasoning with one spinner and an accessible disclosure", async () => {
		await mount(true);

		const disclosure = disclosureButton();
		const status = reasoningStatus();
		expect(disclosure.tagName).toBe("BUTTON");
		expect(disclosure.getAttribute("type")).toBe("button");
		expect(disclosure.getAttribute("aria-expanded")).toBe("true");
		expect(status.getAttribute("aria-live")).toBe("polite");
		expect(status.getAttribute("aria-atomic")).toBe("true");
		expect(status.textContent).toContain("1 running · 2 steps");
		expect(container.querySelector('[data-testid="reasoning"]')).not.toBeNull();
		expect(container.querySelectorAll(".omp-execution-group-header .animate-spin")).toHaveLength(1);
	});

	it("collapses reasoning when its live lifecycle settles", async () => {
		await mount(true);
		expect(disclosureButton().getAttribute("aria-expanded")).toBe("true");

		await render(false);

		expect(disclosureButton().getAttribute("aria-expanded")).toBe("false");
		expect(reasoningStatus().textContent).toContain("2 steps complete");
		expect(container.querySelector('[data-testid="reasoning"]')).toBeNull();
		expect(container.querySelectorAll(".omp-execution-group-header .animate-spin")).toHaveLength(0);
	});

	it("preserves native disclosure semantics for settled reasoning", async () => {
		await mount();
		const disclosure = disclosureButton();
		expect(disclosure.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector('[data-testid="reasoning"]')).toBeNull();

		await act(async () => {
			(disclosure as unknown as { click: () => void }).click();
		});
		expect(disclosure.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelector('[data-testid="reasoning"]')).not.toBeNull();

		await act(async () => {
			(disclosure as unknown as { click: () => void }).click();
		});
		expect(disclosure.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector('[data-testid="reasoning"]')).toBeNull();
	});

	it("does not derive its status or expansion from tool state", async () => {
		useToolsStore.setState({
			activeTools: new Map([["tool-1", toolEntry("error", true)]]),
		});
		await mount();

		expect(reasoningStatus().textContent).toContain("2 steps complete");
		expect(reasoningStatus().textContent).not.toContain("failed");
		expect(disclosureButton().getAttribute("aria-expanded")).toBe("false");

		await act(async () => {
			useToolsStore.setState({
				activeTools: new Map([["tool-1", toolEntry("running")]]),
			});
		});

		expect(reasoningStatus().textContent).toContain("2 steps complete");
		expect(disclosureButton().getAttribute("aria-expanded")).toBe("false");
	});
});
