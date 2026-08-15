import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import {
	ACTIVITY_SIDEBAR_DEFAULT_WIDTH,
	ACTIVITY_SIDEBAR_MAX_WIDTH,
	ACTIVITY_SIDEBAR_MIN_WIDTH,
	useActivitySidebarStore,
} from "../../stores/activity-sidebar";
import { useAgentViewStore } from "../../stores/agent-view";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { useTabsStore } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const resizeCallbacks = new Map<Element, ResizeObserverCallback>();

let activeElement: HTMLElement | null = null;
Object.defineProperty(document, "activeElement", {
	configurable: true,
	get: () => activeElement,
});

class TestResizeObserver {
	readonly #callback: ResizeObserverCallback;

	constructor(callback: ResizeObserverCallback) {
		this.#callback = callback;
	}

	observe(target: Element): void {
		resizeCallbacks.set(target, this.#callback);
	}

	unobserve(target: Element): void {
		resizeCallbacks.delete(target);
	}

	disconnect(): void {
		for (const [target, callback] of resizeCallbacks) {
			if (callback === this.#callback) resizeCallbacks.delete(target);
		}
	}
}

Object.assign(globalThis, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	ResizeObserver: TestResizeObserver,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (handle: number) => clearTimeout(handle),
});

const getPreference = vi.fn(async () => null as { width: number } | null);
const setPreference = vi.fn(async () => undefined);
const readPlan = vi.fn(async () => ({ ok: true, path: null as string | null, content: null as string | null }));
const rpcResponse = (command: string, data: unknown = {}) => ({ type: "response", command, success: true, data });
const getPlanMode = vi.fn(async () => rpcResponse("get_plan_mode", { enabled: false, planFilePath: null }));

Object.assign(window, {
	omp: {
		prefs: { get: getPreference, set: setPreference },
		fs: { readPlan },
		rpc: {
			getPlanMode,
			setPlanMode: vi.fn(async (enabled: boolean) => rpcResponse("set_plan_mode", { enabled })),
			setGoal: vi.fn(async () => rpcResponse("set_goal")),
			prompt: vi.fn(async () => rpcResponse("prompt")),
			steer: vi.fn(async () => rpcResponse("steer")),
			abortSubagent: vi.fn(async () => rpcResponse("abort_subagent", { status: "aborted" })),
			reviveSubagent: vi.fn(async () => rpcResponse("revive_subagent", { status: "running" })),
			getSubagents: vi.fn(async () => rpcResponse("get_subagents", { agents: [] })),
		},
	},
});

const { createRoot } = await import("react-dom/client");
// WorkspaceCanvas renders the DOM-sensitive Task 1/5 activity trees, so import it after installing linkedom.
const { WorkspaceCanvas } = await import("./WorkspaceCanvas");

let container: HTMLElement;
let root: Root;

function seedTab(kind: "agent" | "chat" = "agent", activeTabId = "tab-a"): void {
	useTabsStore.setState({
		tabs: [
			{ id: "tab-a", cwd: "/work/a", status: "ready", kind, target: { type: "local" }, unreadDone: false },
			{ id: "tab-b", cwd: "/work/b", status: "ready", kind: "agent", target: { type: "local" }, unreadDone: false },
		],
		activeTabId,
		bundles: new Map(),
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
}

async function remount(element: ReactElement): Promise<void> {
	await act(async () => root.unmount());
	container.remove();
	resizeCallbacks.clear();
	await mount(element);
}

function transcript(): ReactElement {
	return (
		<main className="flex min-h-0 flex-1 flex-col" data-transcript>
			<button type="button">Transcript target</button>
		</main>
	);
}

function findButton(label: string | RegExp): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(candidate => {
		const name = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
		return typeof label === "string" ? name === label : label.test(name);
	});
	if (!match) throw new Error(`Missing button ${String(label)}`);
	return match;
}

function separator(): HTMLElement {
	const match = container.querySelector<HTMLElement>('[role="separator"][aria-orientation="vertical"]');
	if (!match) throw new Error("Missing workspace separator");
	return match;
}

async function resizeCanvas(width: number): Promise<void> {
	const target = container.querySelector<Element>("[data-workspace-canvas]");
	if (!target) throw new Error("Missing workspace canvas");
	const callback = resizeCallbacks.get(target);
	if (!callback) throw new Error("Missing canvas ResizeObserver");
	await act(async () => {
		callback([{ target, contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
	});
}

function pointer(target: EventTarget, type: string, clientX: number): void {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(event, { clientX, pointerId: 1, button: 0 });
	act(() => target.dispatchEvent(event));
}

function keyDown(target: HTMLElement, key: string, shiftKey = false): void {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, shiftKey });
	act(() => target.dispatchEvent(event));
}

beforeEach(() => {
	useActivitySidebarStore.getState().reset();
	useAgentViewStore.getState().reset();
	useSessionStore.getState().reset();
	useSubagentsStore.getState().reset();
	useTodoStore.getState().reset();
	useTabsStore.getState().reset();
	seedTab();
	getPreference.mockReset();
	getPreference.mockResolvedValue(null);
	setPreference.mockReset();
	setPreference.mockResolvedValue(undefined);
	readPlan.mockReset();
	readPlan.mockResolvedValue({ ok: true, path: null, content: null });
	getPlanMode.mockReset();
	getPlanMode.mockResolvedValue(rpcResponse("get_plan_mode", { enabled: false, planFilePath: null }));
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
		activeElement = this;
	});
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	resizeCallbacks.clear();
	activeElement = null;
	vi.restoreAllMocks();
});

describe("WorkspaceCanvas", () => {
	it("lays out the transcript and real activity rail side by side without the workspace dock", async () => {
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);

		const canvas = container.querySelector<HTMLElement>("[data-workspace-canvas]");
		const transcriptColumn = container.querySelector<HTMLElement>("[data-workspace-transcript]");
		expect(canvas?.className).toContain("flex");
		expect(canvas?.className).toContain("min-h-0");
		expect(canvas?.className).toContain("min-w-0");
		expect(canvas?.className).toContain("flex-1");
		expect(transcriptColumn?.className).toContain("min-h-0");
		expect(transcriptColumn?.className).toContain("min-w-0");
		expect(transcriptColumn?.className).toContain("flex-1");
		expect(transcriptColumn?.classList.contains("flex")).toBe(true);
		expect(canvas?.querySelector("[data-activity-rail]")).not.toBeNull();
		expect(canvas?.querySelector('[data-testid="workspace-dock-scroll"]')).toBeNull();
	});

	it("moves rail focus to the launcher on automatic collapse, restores the surviving row, and preserves transcript focus", async () => {
		useTodoStore
			.getState()
			.setPhases([{ name: "Build", tasks: [{ content: "Keep semantic focus", status: "pending" }] }]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const todoRow = container.querySelector<HTMLElement>('[data-todo-tree-id="phase:0:Build:task:0"]');
		if (!todoRow) throw new Error("Missing real TodoTree row");
		todoRow.focus();

		await resizeCanvas(850);
		const launcher = findButton("Expand activity sidebar");
		expect(document.activeElement).toBe(launcher);

		await resizeCanvas(900);
		const restored = container.querySelector<HTMLElement>('[data-todo-tree-id="phase:0:Build:task:0"]');
		expect(document.activeElement).toBe(restored);

		const transcriptTarget = findButton("Transcript target");
		transcriptTarget.focus();
		await resizeCanvas(850);
		expect(document.activeElement).toBe(transcriptTarget);
	});

	it("restores an ID-less Todo task by semantic label when insertion changes its generated row ID", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Build",
				tasks: [
					{ content: "Alpha", status: "pending" },
					{ content: "Beta", status: "pending" },
				],
			},
		]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const beta = [
			...container.querySelectorAll<HTMLElement>('[data-activity-section="todo"] [role="treeitem"]'),
		].find(row => row.getAttribute("aria-label") === "Beta");
		if (!beta) throw new Error("Missing Beta TodoTree row");
		beta.focus();
		await resizeCanvas(850);

		act(() =>
			useTodoStore.getState().setPhases([
				{
					name: "Build",
					tasks: [
						{ content: "New", status: "pending" },
						{ content: "Alpha", status: "pending" },
						{ content: "Beta", status: "pending" },
					],
				},
			]),
		);
		await resizeCanvas(900);

		const restoredBeta = [
			...container.querySelectorAll<HTMLElement>('[data-activity-section="todo"] [role="treeitem"]'),
		].find(row => row.getAttribute("aria-label") === "Beta");
		expect(document.activeElement).toBe(restoredBeta);
	});

	it("restores the same duplicate-label ID-less Todo task by its semantic ordinal", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Build",
				tasks: [
					{ content: "Deploy", status: "pending" },
					{ content: "Deploy", status: "pending" },
				],
			},
		]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const deployRows = [
			...container.querySelectorAll<HTMLElement>('[data-activity-section="todo"] [aria-label="Deploy"]'),
		];
		expect(deployRows).toHaveLength(2);
		deployRows[1]!.focus();
		await resizeCanvas(850);

		act(() =>
			useTodoStore.getState().setPhases([
				{
					name: "Build",
					tasks: [
						{ content: "New", status: "pending" },
						{ content: "Deploy", status: "pending" },
						{ content: "Deploy", status: "pending" },
					],
				},
			]),
		);
		await resizeCanvas(900);

		const restoredDeployRows = [
			...container.querySelectorAll<HTMLElement>('[data-activity-section="todo"] [aria-label="Deploy"]'),
		];
		expect(document.activeElement).toBe(restoredDeployRows[1]);
	});

	it("keeps a stable phase-prefixed Todo ID focused across a colliding semantic rename", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Build",
				tasks: [
					{ id: "phase:0:Build:task:0", content: "Before rename", status: "pending" } as never,
					{ id: "other-stable", content: "Other task", status: "pending" } as never,
				],
			},
		]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const beforeRename = container.querySelector<HTMLElement>('[data-todo-tree-id="phase:0:Build:task:0"]');
		if (!beforeRename) throw new Error("Missing explicit-ID TodoTree row");
		beforeRename.focus();
		await resizeCanvas(850);

		act(() =>
			useTodoStore.getState().setPhases([
				{
					name: "Build",
					tasks: [
						{ id: "phase:0:Build:task:0", content: "After rename", status: "pending" } as never,
						{ id: "other-stable", content: "Before rename", status: "pending" } as never,
					],
				},
			]),
		);
		await resizeCanvas(900);

		expect(document.activeElement).toBe(
			container.querySelector<HTMLElement>('[data-todo-tree-id="phase:0:Build:task:0"]'),
		);
	});

	it("does not fall back by label after the focused explicit Todo ID disappears", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Build",
				tasks: [
					{ id: "focused-explicit", content: "Shared label", status: "pending" } as never,
					{ id: "survivor-explicit", content: "Shared label", status: "pending" } as never,
				],
			},
		]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const focusedExplicit = container.querySelector<HTMLElement>('[data-todo-tree-id="focused-explicit"]');
		if (!focusedExplicit) throw new Error("Missing focused explicit TodoTree row");
		focusedExplicit.focus();
		await resizeCanvas(850);

		act(() =>
			useTodoStore.getState().setPhases([
				{
					name: "Build",
					tasks: [{ id: "survivor-explicit", content: "Shared label", status: "pending" } as never],
				},
			]),
		);
		const transcriptTarget = findButton("Transcript target");
		transcriptTarget.focus();
		await resizeCanvas(900);

		expect(container.querySelector('[data-todo-tree-id="focused-explicit"]')).toBeNull();
		expect(document.activeElement).toBe(transcriptTarget);
	});

	it("does not restore a generated task into a replacement explicit parent phase with the same label", async () => {
		useTodoStore
			.getState()
			.setPhases([
				{ id: "phase-p1", name: "Shared phase", tasks: [{ content: "Deploy", status: "pending" }] } as never,
			]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const original = container.querySelector<HTMLElement>('[data-todo-tree-id="phase-p1:task:0"]');
		if (!original) throw new Error("Missing generated task under explicit phase p1");
		original.focus();
		await resizeCanvas(850);

		act(() =>
			useTodoStore
				.getState()
				.setPhases([
					{ id: "phase-p2", name: "Shared phase", tasks: [{ content: "Deploy", status: "pending" }] } as never,
				]),
		);
		const transcriptTarget = findButton("Transcript target");
		transcriptTarget.focus();
		await resizeCanvas(900);

		expect(container.querySelector('[data-todo-tree-id="phase-p2:task:0"]')).not.toBeNull();
		expect(document.activeElement).toBe(transcriptTarget);
	});

	it("does not restore a generated snapshot into an explicit replacement sharing its ID", async () => {
		useTodoStore
			.getState()
			.setPhases([{ name: "Build", tasks: [{ content: "Shared identity", status: "pending" }] }]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const generated = container.querySelector<HTMLElement>('[data-todo-tree-id="phase:0:Build:task:0"]');
		if (!generated) throw new Error("Missing generated TodoTree row");
		generated.focus();
		await resizeCanvas(850);

		act(() =>
			useTodoStore.getState().setPhases([
				{
					name: "Build",
					tasks: [{ id: "phase:0:Build:task:0", content: "Shared identity", status: "pending" } as never],
				},
			]),
		);
		const transcriptTarget = findButton("Transcript target");
		transcriptTarget.focus();
		await resizeCanvas(900);

		expect(container.querySelector('[data-todo-id-generated="false"]')).not.toBeNull();
		expect(document.activeElement).toBe(transcriptTarget);
	});

	it("does not restore an explicit snapshot into a generated replacement sharing its ID", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Build",
				tasks: [{ id: "phase:0:Build:task:0", content: "Shared identity", status: "pending" } as never],
			},
		]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const explicit = container.querySelector<HTMLElement>('[data-todo-tree-id="phase:0:Build:task:0"]');
		if (!explicit) throw new Error("Missing explicit TodoTree row");
		explicit.focus();
		await resizeCanvas(850);

		act(() =>
			useTodoStore
				.getState()
				.setPhases([{ name: "Build", tasks: [{ content: "Shared identity", status: "pending" }] }]),
		);
		const transcriptTarget = findButton("Transcript target");
		transcriptTarget.focus();
		await resizeCanvas(900);

		expect(container.querySelector('[data-todo-id-generated="true"]')).not.toBeNull();
		expect(document.activeElement).toBe(transcriptTarget);
	});

	it("does not restore a tab A rail snapshot into a colliding tab B row", async () => {
		useTodoStore
			.getState()
			.setPhases([{ name: "Shared", tasks: [{ content: "Colliding task", status: "pending" }] }]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const tabARow = container.querySelector<HTMLElement>('[aria-label="Colliding task"]');
		if (!tabARow) throw new Error("Missing tab A TodoTree row");
		tabARow.focus();
		await resizeCanvas(850);

		act(() => {
			useTabsStore.setState({ activeTabId: "tab-b" });
			useTodoStore
				.getState()
				.setPhases([{ name: "Shared", tasks: [{ content: "Colliding task", status: "pending" }] }]);
		});
		const transcriptTarget = findButton("Transcript target");
		transcriptTarget.focus();
		await resizeCanvas(900);

		const tabBRow = container.querySelector<HTMLElement>('[aria-label="Colliding task"]');
		expect(tabBRow).not.toBeNull();
		expect(document.activeElement).toBe(transcriptTarget);
	});

	it("restores the same AgentTree row when duplicate issue-style titles resemble row ordinals", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		useSubagentsStore
			.getState()
			.setSnapshots([
				{ id: "child-a", index: 0, status: "running", task: "#123", parentId: null } as never,
				{ id: "child-b", index: 1, status: "running", task: "#123", parentId: null } as never,
			]);
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(900);
		const rows = [
			...container.querySelectorAll<HTMLElement>('[data-activity-section="agents"] [role="treeitem"]'),
		].filter(row => row.querySelector('[title="#123"]'));
		expect(rows).toHaveLength(2);
		rows[1]!.focus();

		await resizeCanvas(850);
		expect(document.activeElement).toBe(findButton("Expand activity sidebar"));
		await resizeCanvas(900);

		const restoredRows = [
			...container.querySelectorAll<HTMLElement>('[data-activity-section="agents"] [role="treeitem"]'),
		].filter(row => row.querySelector('[title="#123"]'));
		expect(document.activeElement).toBe(restoredRows[1]);
	});

	it("hydrates persisted width once and honors remembered manual collapse before any valid measurement", async () => {
		getPreference.mockResolvedValue({ width: 380 });
		const hydrate = vi.spyOn(useActivitySidebarStore.getState(), "hydrate");
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await act(async () => Promise.resolve());

		expect(hydrate).toHaveBeenCalledTimes(1);
		expect(useActivitySidebarStore.getState().width).toBe(380);
		expect(container.querySelector<HTMLElement>("[data-activity-sidebar-region]")?.style.width).toBe("380px");
		expect(container.querySelector("[data-activity-rail]")).not.toBeNull();
		await resizeCanvas(0);
		expect(container.querySelector("[data-activity-rail]")).not.toBeNull();
		await resizeCanvas(Number.NaN);
		expect(container.querySelector("[data-activity-rail]")).not.toBeNull();

		act(() => useActivitySidebarStore.getState().setManualCollapsed(true));
		await remount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		expect(findButton("Expand activity sidebar")).not.toBeNull();
		expect(resizeCallbacks.has(container.querySelector("[data-workspace-canvas]")!)).toBe(true);
	});

	it.each(["pointerup", "pointercancel"] as const)(
		"freezes responsive mode while dragging, previews locally, and commits once on %s",
		async finishEvent => {
			const commitWidth = vi.spyOn(useActivitySidebarStore.getState(), "commitWidth");
			commitWidth.mockClear();
			await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
			await resizeCanvas(900);
			const removeListener = vi.spyOn(document, "removeEventListener");
			const divider = separator();

			pointer(divider, "pointerdown", 600);
			await resizeCanvas(800);
			expect(container.querySelector("[data-activity-rail]")).not.toBeNull();
			pointer(document, "pointermove", 500);
			expect(container.querySelector<HTMLElement>("[data-activity-sidebar-region]")?.style.width).toBe("400px");
			expect(useActivitySidebarStore.getState().width).toBe(ACTIVITY_SIDEBAR_DEFAULT_WIDTH);
			pointer(document, finishEvent, 500);

			expect(commitWidth).toHaveBeenCalledTimes(1);
			expect(commitWidth).toHaveBeenCalledWith(400);
			expect(useActivitySidebarStore.getState().width).toBe(400);
			expect(findButton("Expand activity sidebar")).not.toBeNull();
			expect(removeListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
			expect(removeListener).toHaveBeenCalledWith("pointerup", expect.any(Function));
			expect(removeListener).toHaveBeenCalledWith("pointercancel", expect.any(Function));
			pointer(document, finishEvent === "pointerup" ? "pointercancel" : "pointerup", 450);
			expect(commitWidth).toHaveBeenCalledTimes(1);
		},
	);

	it("supports 8px and Shift-32px keyboard steps, clamps, and resets on double click", async () => {
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		const divider = separator();
		expect(divider.getAttribute("aria-label")).toBe("Resize activity sidebar");

		keyDown(divider, "ArrowRight");
		expect(useActivitySidebarStore.getState().width).toBe(308);
		keyDown(divider, "ArrowRight", true);
		expect(useActivitySidebarStore.getState().width).toBe(340);

		act(() => useActivitySidebarStore.setState({ width: ACTIVITY_SIDEBAR_MAX_WIDTH - 4 }));
		keyDown(divider, "ArrowRight");
		expect(useActivitySidebarStore.getState().width).toBe(ACTIVITY_SIDEBAR_MAX_WIDTH);
		act(() => useActivitySidebarStore.setState({ width: ACTIVITY_SIDEBAR_MIN_WIDTH + 4 }));
		keyDown(divider, "ArrowLeft");
		expect(useActivitySidebarStore.getState().width).toBe(ACTIVITY_SIDEBAR_MIN_WIDTH);
		expect(separator().getAttribute("aria-valuenow")).toBe(String(ACTIVITY_SIDEBAR_MIN_WIDTH));
		expect(separator().getAttribute("aria-valuemin")).toBe(String(ACTIVITY_SIDEBAR_MIN_WIDTH));
		expect(separator().getAttribute("aria-valuemax")).toBe(String(ACTIVITY_SIDEBAR_MAX_WIDTH));

		act(() => separator().dispatchEvent(new Event("dblclick", { bubbles: true })));
		expect(useActivitySidebarStore.getState().width).toBe(ACTIVITY_SIDEBAR_DEFAULT_WIDTH);
	});

	it("moves Activity-header focus to the launcher on manual collapse and back to the Activity header on expansion", async () => {
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		const collapse = findButton("Collapse activity sidebar");
		collapse.focus();
		await act(async () => collapse.click());
		const launcher = findButton("Expand activity sidebar");
		expect(document.activeElement).toBe(launcher);

		await act(async () => launcher.click());
		expect(document.activeElement).toBe(findButton("Collapse activity sidebar"));
		expect(useActivitySidebarStore.getState().manualCollapsed).toBe(false);
	});

	it("clears a prior-tab narrow override and re-enters automatic compact mode on tab change", async () => {
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(800);
		await act(async () => findButton("Expand activity sidebar").click());
		expect(container.querySelector("[data-activity-rail]")).not.toBeNull();
		expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBe("tab-a");

		act(() => useTabsStore.setState({ activeTabId: "tab-b" }));
		expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBeNull();
		expect(findButton("Expand activity sidebar")).not.toBeNull();
	});

	it("uses observed outer-canvas width rather than window width for automatic collapse", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 2000 });
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);
		await resizeCanvas(860);
		expect(container.querySelector("[data-activity-rail]")).not.toBeNull();

		await resizeCanvas(859);
		expect(findButton("Expand activity sidebar")).not.toBeNull();
	});

	it("renders children directly without an activity owner when no tab is active", async () => {
		useTabsStore.setState({ activeTabId: null, tabs: [] });
		await mount(<WorkspaceCanvas>{transcript()}</WorkspaceCanvas>);

		expect(container.firstElementChild?.hasAttribute("data-transcript")).toBe(true);
		expect(container.querySelector("[data-workspace-canvas]")).toBeNull();
		expect(container.querySelector("[data-activity-rail]")).toBeNull();
	});

	it("renders chat-tab children directly with no rail and waits for a fresh canvas measurement on return", async () => {
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "tab-b" ? { ...tab, kind: "chat" } : tab)),
		}));
		const child = transcript();
		await mount(<WorkspaceCanvas>{child}</WorkspaceCanvas>);
		await resizeCanvas(859);
		expect(findButton("Expand activity sidebar")).not.toBeNull();

		act(() => useTabsStore.setState({ activeTabId: "tab-b" }));
		expect(container.firstElementChild?.hasAttribute("data-transcript")).toBe(true);
		expect(container.querySelector("[data-workspace-canvas]")).toBeNull();
		expect(container.querySelector("[data-activity-rail]")).toBeNull();

		act(() => useTabsStore.setState({ activeTabId: "tab-a" }));
		expect(container.querySelector("[data-activity-rail]")).not.toBeNull();
	});
});
