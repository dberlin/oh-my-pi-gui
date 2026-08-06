/**
 * Contract tests for mode-state visibility: the composer chips (ComposerModes)
 * and the footer mode badges (StatusFooter) must surface plan/goal/loop/vibe/
 * pause at a glance — accent chip + check + detail tooltip in the composer,
 * small badges beside model/cwd/context in the footer — driven purely by
 * session-store state (loopMode/vibeModeEnabled hydrated from
 * get_loop_mode/get_vibe_mode, loop kept live by loop_mode_update frames).
 * Same linkedom + react-dom harness as use-rpc-events.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { ComposerModes } from "./ComposerModes";
import { StatusFooter } from "./StatusFooter";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
	appendChild: (child: TestElement) => void;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

interface MockOmp {
	rpc: {
		getSettings: Mock<(keys: string[]) => Promise<RpcResponse>>;
	};
	events: {
		onConfigUpdate: Mock<() => () => void>;
	};
}

/** StatusFooter reads statusLine.preset at mount; ComposerModes needs no RPC on render. */
function installMockOmp(preset?: string): MockOmp {
	const omp: MockOmp = {
		rpc: {
			getSettings: vi.fn(async () => success({ values: preset ? { "statusLine.preset": preset } : {} })),
		},
		events: {
			onConfigUpdate: vi.fn(() => () => {}),
		},
	};
	(window as unknown as { omp: MockOmp }).omp = omp;
	return omp;
}

let container: TestElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
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
	useSessionStore.getState().reset();
	useUiStore.setState({ modesOpen: false, modesTab: "vibe" });
});

function buttonByTitle(title: string): TestElement | null {
	const buttons = container.querySelectorAll("button");
	return buttons.find(button => (button as unknown as { title: string }).title === title) ?? null;
}

describe("ComposerModes chips", () => {
	it("marks active plan/goal/loop chips with accent styling, a check, and detail tooltips", async () => {
		installMockOmp();
		useSessionStore.setState({
			planModeEnabled: true,
			goal: { objective: "Ship the activity dock" },
			goalState: { status: "active" },
			loopMode: {
				enabled: true,
				state: "running",
				prompt: "keep going",
				limit: { kind: "iterations", initial: 10, remaining: 7 },
			},
		});
		await mount(<ComposerModes />);

		const plan = buttonByTitle("Plan mode — agent drafts a plan before acting");
		expect(plan).not.toBeNull();
		expect((plan as unknown as { className: string }).className).toContain("bg-[var(--omp-accent-dim)]");
		// Mode icon + check = two svgs on an active chip.
		expect(plan?.querySelectorAll("svg").length).toBe(2);

		const goal = buttonByTitle("Goal mode — Ship the activity dock");
		expect(goal).not.toBeNull();
		expect((goal as unknown as { className: string }).className).toContain("bg-[var(--omp-accent-dim)]");
		expect(goal?.querySelectorAll("svg").length).toBe(2);

		const loop = buttonByTitle("Loop mode — 7 of 10 iterations left");
		expect(loop).not.toBeNull();
		expect((loop as unknown as { className: string }).className).toContain("bg-[var(--omp-accent-dim)]");
		expect(loop?.querySelectorAll("svg").length).toBe(2);
	});

	it("renders inactive chips muted with the static loop tooltip and no check", async () => {
		installMockOmp();
		await mount(<ComposerModes />);

		const plan = buttonByTitle("Plan mode — agent drafts a plan before acting");
		expect((plan as unknown as { className: string }).className).not.toContain("bg-[var(--omp-accent-dim)]");
		expect(plan?.querySelectorAll("svg").length).toBe(1);

		const loop = buttonByTitle("Loop mode — open the loop panel");
		expect(loop).not.toBeNull();
		expect(loop?.querySelectorAll("svg").length).toBe(1);
	});

	it("opens the Modes window on the loop tab from the loop chip", async () => {
		installMockOmp();
		await mount(<ComposerModes />);

		const loop = buttonByTitle("Loop mode — open the loop panel");
		await act(async () => {
			(loop as unknown as { click: () => void }).click();
		});
		expect(useUiStore.getState().modesOpen).toBe(true);
		expect(useUiStore.getState().modesTab).toBe("loop");
	});
});

describe("StatusFooter mode badges", () => {
	it("renders a badge per active mode with detail tooltips", async () => {
		installMockOmp();
		useSessionStore.setState({
			cwd: "/tmp/project",
			planModeEnabled: true,
			goal: { objective: "Ship the activity dock" },
			goalState: { status: "active" },
			loopMode: { enabled: true, state: "waiting" },
			vibeModeEnabled: true,
			agentsPaused: true,
		});
		await mount(<StatusFooter />);

		const text = document.body.textContent ?? "";
		for (const label of ["Plan", "Goal", "Loop", "Vibe", "Paused"]) {
			expect(text).toContain(label);
		}
		expect(document.body.innerHTML).toContain("Goal: Ship the activity dock");
		// Unbounded loop: no limit on the wire, so the tooltip says so.
		expect(document.body.innerHTML).toContain("Loop mode: Unbounded");
		expect(document.body.innerHTML).toContain("All agents are paused");
	});

	it("renders no badges when every mode is off", async () => {
		installMockOmp();
		useSessionStore.setState({ cwd: "/tmp/project" });
		await mount(<StatusFooter />);

		const text = document.body.textContent ?? "";
		for (const label of ["Plan", "Goal", "Loop", "Vibe", "Paused"]) {
			expect(text).not.toContain(label);
		}
	});

	it("hides badges under the minimal preset (model + context only)", async () => {
		installMockOmp("minimal");
		useSessionStore.setState({ cwd: "/tmp/project", planModeEnabled: true, agentsPaused: true });
		await mount(<StatusFooter />);

		const text = document.body.textContent ?? "";
		expect(text).not.toContain("Paused");
		expect(text).not.toContain("Plan");
	});
});
