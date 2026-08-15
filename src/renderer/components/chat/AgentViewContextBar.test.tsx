import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useAgentViewStore } from "../../stores/agent-view";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { useUiStore } from "../../stores/ui";
import { AgentViewContextBar, AgentViewTranscriptSlot } from "./AgentViewContextBar";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
const storage: Record<string, string> = {};
const localStorage = {
	getItem: (key: string) => storage[key] ?? null,
	setItem: (key: string, value: string) => {
		storage[key] = value;
	},
};
Object.assign(globals, {
	document,
	window,
	localStorage,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});

interface TestElement {
	className: string;
	previousElementSibling: TestElement | null;
	textContent: string | null;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	remove: () => void;
}

let container: TestElement;
let root: Root;

function snapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
	return {
		id: "agent-1",
		index: 0,
		agent: "worker",
		agentSource: "bundled",
		status: "running",
		lastUpdate: Date.now(),
		description: "Implement the context bar",
		...overrides,
	};
}

async function mount(element: ReactElement = <AgentViewContextBar />): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useAgentViewStore.getState().reset();
	useSessionStore.getState().reset();
	useSubagentsStore.getState().reset();
	useUiStore.setState({ dockCollapsed: {}, dockFocus: null });
});

describe("AgentViewContextBar", () => {
	it("shows Main identity and follows the current session status", async () => {
		useSessionStore.setState({ status: "ready", isStreaming: true });
		await mount();

		const bar = container.querySelector('[data-agent-view="main"]');
		expect(bar?.textContent).toContain("Main");
		expect(bar?.textContent).toContain("Main session");
		expect(bar?.textContent).toContain("Working");

		await act(async () => {
			useSessionStore.setState({ isStreaming: false });
		});
		expect(bar?.textContent).toContain("Ready");
		expect(bar?.textContent).not.toContain("Working");
	});

	it("exposes a named group with a dedicated live status region", async () => {
		await mount();

		const bar = container.querySelector('[data-agent-view="main"]');
		expect(bar?.getAttribute("role")).toBe("group");
		expect(bar?.getAttribute("aria-label")).toBe("Active agent");
		const status = bar?.querySelector('[role="status"]');
		expect(status?.getAttribute("aria-live")).toBe("polite");
		expect(status?.textContent).toContain("Connecting");
	});

	it("shows the selected subagent label, type, lifecycle, and live indicator", async () => {
		useSubagentsStore.getState().setSnapshots([snapshot()]);
		useAgentViewStore.setState({ target: { kind: "subagent", id: "agent-1" } });
		await mount();

		const bar = container.querySelector('[data-agent-view="subagent"]');
		expect(bar?.querySelector("[data-agent-label]")?.textContent).toBe("Implement the context bar");
		expect(bar?.querySelector("[data-agent-type]")?.textContent).toBe("worker");
		expect(bar?.querySelector('[data-agent-status="running"]')?.textContent).toBe("running");
		expect(bar?.querySelector('[data-agent-live="true"] .animate-ping')).not.toBeNull();
	});

	it("repaints lifecycle and live state from roster frames", async () => {
		useSubagentsStore.getState().setSnapshots([snapshot()]);
		useAgentViewStore.setState({ target: { kind: "subagent", id: "agent-1" } });
		await mount();

		await act(async () => {
			useSubagentsStore.getState().applyFrame({
				type: "subagent_lifecycle",
				payload: {
					id: "agent-1",
					index: 0,
					agent: "worker",
					agentSource: "bundled",
					description: "Context bar complete",
					status: "completed",
				},
			});
		});

		const bar = container.querySelector('[data-agent-view="subagent"]');
		expect(bar?.querySelector("[data-agent-label]")?.textContent).toBe("Context bar complete");
		expect(bar?.querySelector('[data-agent-status="completed"]')?.textContent).toBe("completed");
		expect(bar?.querySelector('[data-agent-live="true"]')).toBeNull();
	});

	it("stays immediately above the canvas when the agents dock collapses", async () => {
		await mount(
			<AgentViewTranscriptSlot>
				<section data-transcript-canvas />
			</AgentViewTranscriptSlot>,
		);

		const canvas = container.querySelector("[data-transcript-canvas]");
		const expectPersistentBar = () => {
			const bar = canvas?.previousElementSibling;
			expect(bar?.className.split(/\s+/)).toContain("omp-agent-view-context-bar");
			expect(bar?.className.split(/\s+/)).toContain("shrink-0");
			expect(bar?.querySelector("button, select, input")).toBeNull();
		};
		expectPersistentBar();

		await act(async () => {
			useUiStore.getState().toggleDockCard("agents");
		});
		expect(useUiStore.getState().dockCollapsed.agents).toBe(true);
		expectPersistentBar();
	});
});
