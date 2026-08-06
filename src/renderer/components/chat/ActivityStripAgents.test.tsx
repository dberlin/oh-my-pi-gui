/**
 * ActivityStrip agents segment: shows the live-subagent count with a jump to
 * the drawer's agents tab, and polls get_subagents while a turn streams
 * (parked/idle transitions emit no wire frame, so the store goes stale
 * mid-run without it). Renders nothing when no subagent is live.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { ActivityStripAgents } = await import("./ActivityStripAgents");

const getSubagents: Mock = vi.fn(async () => ({
	type: "response",
	command: "get_subagents",
	success: true,
	data: { subagents: [] },
}));
(window as unknown as { omp: { rpc: { getSubagents: Mock } } }).omp = { rpc: { getSubagents } };

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now(), ...overrides };
}

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	getSubagents.mockClear();
	useSubagentsStore.getState().reset();
	useSessionStore.setState({ isStreaming: false });
	useUiStore.setState({ panelTab: "todo", panelVisible: false });
});

interface TestElement {
	dispatchEvent: (event: object) => boolean;
}

/** linkedom container — the DOM lib types aren't linked into this test env. */
interface TestContainer {
	textContent: string | null;
	querySelector: (selector: string) => TestElement | null;
}

function containerText(): string {
	const view = container as unknown as TestContainer;
	return view.textContent ?? "";
}

describe("ActivityStripAgents", () => {
	it("renders nothing when no subagent is live", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "done", status: "completed" })]);
		await mount(<ActivityStripAgents />);
		expect(containerText()).toBe("");
	});

	it("shows the running count and jumps to the agents panel tab on click", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "a1", status: "running" }),
				snap({ id: "a2", index: 2, status: "parked" }),
				snap({ id: "a3", index: 3, status: "completed" }),
			]);
		await mount(<ActivityStripAgents />);

		// Live = running + parked (terminal completed is not counted).
		expect(containerText()).toContain("🤖 2 agents ▾");

		const view = container as unknown as TestContainer;
		const button = view.querySelector("button");
		expect(button).not.toBeNull();
		const event = new Event("click", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
		await act(async () => {
			button!.dispatchEvent(event);
		});
		expect(useUiStore.getState().panelTab).toBe("agents");
		expect(useUiStore.getState().panelVisible).toBe(true);
	});

	it("polls get_subagents while streaming, stops when the turn ends", async () => {
		// Real timers + a short injected cadence: vi.useFakeTimers/advanceTimers
		// are vitest-only, and this file must also pass under `bun test`.
		const sleep = (ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		};
		useSessionStore.setState({ isStreaming: true });
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(
				<I18nProvider>
					<ActivityStripAgents pollMs={25} />
				</I18nProvider>,
			);
		});
		expect(getSubagents).not.toHaveBeenCalled();

		await act(async () => {
			await sleep(60);
		});
		expect(getSubagents.mock.calls.length).toBeGreaterThanOrEqual(1);

		// Turn ends → interval cleared, no further polls.
		await act(async () => {
			useSessionStore.setState({ isStreaming: false });
		});
		const callsAtStop = getSubagents.mock.calls.length;
		await act(async () => {
			await sleep(60);
		});
		expect(getSubagents.mock.calls.length).toBe(callsAtStop);
	});
});
