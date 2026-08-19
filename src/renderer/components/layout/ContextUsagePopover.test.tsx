import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcContextReportResult, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";

const { document, window, Event, HTMLElement, Element, Node, PointerEvent } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	PointerEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const report: RpcContextReportResult = {
	contextWindow: 1_000_000,
	model: "test-model",
	breakdown: {
		anchored: true,
		contextWindow: 1_000_000,
		usedTokens: 161_900,
		systemPromptTokens: 1_000,
		systemContextTokens: 200,
		systemToolsTokens: 6_400,
		skillsTokens: 300,
		messagesTokens: 154_000,
	},
};

const getContextReport: Mock<() => Promise<RpcResponse>> = vi.fn(async () => ({
	type: "response",
	command: "get_context_report",
	success: true,
	data: report,
}));
(window as unknown as { omp: { rpc: { getContextReport: typeof getContextReport } } }).omp = {
	rpc: { getContextReport },
};

const { createRoot } = await import("react-dom/client");
const { ContextUsagePopover } = await import("./ContextUsagePopover");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ContextUsagePopover />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	getContextReport.mockClear();
	useSessionStore.getState().reset();
});

describe("ContextUsagePopover", () => {
	it("keeps context usage to one control and reveals the native three-category breakdown", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 1_000_000, percent: 16.19, tokens: 161_900 },
			sessionId: "session-1",
			status: "ready",
		});
		await mount();

		const trigger = container.querySelector("button") as unknown as HTMLButtonElement;
		expect(trigger.getAttribute("aria-label")).toBe("Show context usage, 16% used");
		expect(trigger.textContent).toContain("161.9k/1.0M");
		expect(document.querySelector('[role="dialog"]')).toBeNull();

		await act(async () => trigger.click());
		expect(getContextReport).toHaveBeenCalledTimes(1);
		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("Context used 16%");
		expect(dialog?.textContent).toContain("~161.9k / 1.0M");
		expect(dialog?.textContent).toContain("Context remaining838.1k");
		expect(dialog?.textContent).toContain("System context~1.5k");
		expect(dialog?.textContent).toContain("Tools~6.4k");
		expect(dialog?.textContent).toContain("Conversation messages~154.0k");
	});

	it("renders nothing until the session reports a context window", async () => {
		await mount();
		expect(container.childElementCount).toBe(0);
		expect(getContextReport).not.toHaveBeenCalled();
	});

	it("reveals the same breakdown on hover without pinning a modal", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 100_000, percent: 10, tokens: 10_000 },
			sessionId: "session-hover",
			status: "ready",
		});
		await mount();

		await act(async () => {
			container.querySelector("button")?.dispatchEvent(new Event("mouseover", { bubbles: true }));
		});
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		expect(getContextReport).toHaveBeenCalledTimes(1);
	});

	it("closes a pinned popover from its trigger, Escape, and an outside pointer", async () => {
		useSessionStore.setState({
			contextUsage: { contextWindow: 1_000_000, percent: 16.19, tokens: 161_900 },
			sessionId: "session-close",
			status: "ready",
		});
		await mount();
		const trigger = container.querySelector("button") as unknown as HTMLButtonElement;

		await act(async () => trigger.click());
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		await act(async () => trigger.click());
		expect(document.querySelector('[role="dialog"]')).toBeNull();

		await act(async () => trigger.click());
		const escapeEvent = new Event("keydown", { bubbles: true });
		Object.defineProperty(escapeEvent, "key", { value: "Escape" });
		await act(async () => document.dispatchEvent(escapeEvent));
		expect(document.querySelector('[role="dialog"]')).toBeNull();

		await act(async () => trigger.click());
		await act(async () => document.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("keeps the current total visible when the detailed report is unavailable", async () => {
		getContextReport.mockRejectedValueOnce(new Error("sidecar unavailable"));
		useSessionStore.setState({
			contextUsage: { contextWindow: 272_000, percent: 64, tokens: 173_700 },
			sessionId: "session-fallback",
			status: "ready",
		});
		await mount();

		await act(async () => (container.querySelector("button") as unknown as HTMLButtonElement).click());
		const dialog = document.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("Context used 64%");
		expect(dialog?.textContent).toContain("~173.7k / 272.0k");
		expect(dialog?.textContent).toContain("The detailed breakdown is temporarily unavailable.");
	});
});
