import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { beginTabRoute, resetTabRoute, settleTabRoute } from "../../../lib/tab-routing";
import { useActivitySidebarStore } from "../../../stores/activity-sidebar";
import { useAgentViewStore } from "../../../stores/agent-view";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTodoStore } from "../../../stores/todo";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const resizeCallbacks = new Map<Element, ResizeObserverCallback>();
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
		for (const [target, callback] of resizeCallbacks) if (callback === this.#callback) resizeCallbacks.delete(target);
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

const readPlan = vi.fn(async () => ({ ok: true, path: null as string | null, content: null as string | null }));
const getPlanMode = vi.fn(async () => rpcResponse("get_plan_mode", { enabled: false, planFilePath: null }));
const rpcResponse = (command: string, data: unknown = {}) => ({ type: "response", command, success: true, data });
Object.assign(window, {
	omp: {
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
// ActivitySidebar transitively renders DOM-sensitive drag-and-drop controls, so load it after linkedom.
const { ActivitySidebar } = await import("./ActivitySidebar");

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
}

function button(label: string | RegExp): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(candidate => {
		const name = candidate.getAttribute("aria-label") ?? candidate.textContent ?? "";
		return typeof label === "string" ? name === label : label.test(name);
	});
	if (!match) throw new Error(`Missing button ${String(label)}`);
	return match;
}

async function click(target: HTMLElement): Promise<void> {
	await act(async () => target.click());
}

async function resize(selector: string, height: number): Promise<void> {
	const target = container.querySelector(selector);
	if (!target) throw new Error(`Missing resize target ${selector}`);
	const callback = resizeCallbacks.get(target);
	if (!callback) throw new Error(`Missing ResizeObserver for ${selector}`);
	await act(async () => callback([{ target, contentRect: { height } } as ResizeObserverEntry], {} as ResizeObserver));
}

function keyDown(target: HTMLElement, key: string, shiftKey = false): void {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, shiftKey });
	target.dispatchEvent(event);
}

function pointer(target: EventTarget, type: string, clientY: number): void {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.assign(event, { clientY, pointerId: 1, button: 0 });
	act(() => target.dispatchEvent(event));
}

beforeEach(() => {
	useActivitySidebarStore.getState().reset();
	useAgentViewStore.getState().reset();
	useSessionStore.getState().reset();
	useSubagentsStore.getState().reset();
	useTodoStore.getState().reset();
	readPlan.mockReset();
	readPlan.mockResolvedValue({ ok: true, path: null, content: null });
	getPlanMode.mockReset();
	getPlanMode.mockResolvedValue(rpcResponse("get_plan_mode", { enabled: false, planFilePath: null }));
	resetTabRoute();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	resizeCallbacks.clear();
	vi.restoreAllMocks();
});

describe("ActivitySidebar", () => {
	it("keeps Plan, Goal, Todo, and Agents headers mounted in approved order", async () => {
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		expect(
			[...container.querySelectorAll("[data-activity-section]")].map(node =>
				node.getAttribute("data-activity-section"),
			),
		).toEqual(["plan", "goal", "todo", "agents"]);
		const rail = container.querySelector<HTMLElement>("[data-activity-rail]")!;
		expect(rail.children).toHaveLength(3);
		expect((rail.children[1] as HTMLElement).hasAttribute("data-activity-meta-rows")).toBe(true);
		expect((rail.children[2] as HTMLElement).hasAttribute("data-activity-tree-area")).toBe(true);
	});

	it("starts balanced and commits one clamped pointer split", async () => {
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		await resize("[data-activity-tree-area]", 320);
		const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
		expect(separator.getAttribute("aria-valuenow")).toBe("50");
		const setSplitRatio = vi.spyOn(useActivitySidebarStore.getState(), "setSplitRatio");
		setSplitRatio.mockClear();
		pointer(separator, "pointerdown", 100);
		pointer(document, "pointermove", 140);
		pointer(document, "pointerup", 140);
		expect(setSplitRatio).toHaveBeenCalledTimes(1);
		expect(useActivitySidebarStore.getState().splitRatio).toBeGreaterThan(0.5);
		setSplitRatio.mockRestore();
	});

	it("moves immediately from the displayed clamped ratio with keyboard and pointer input", async () => {
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		await resize("[data-activity-tree-area]", 200);
		const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
		act(() => useActivitySidebarStore.getState().setSplitRatio(0.95));
		const clampedMaximum = Number(separator.getAttribute("aria-valuemax"));
		expect(Number(separator.getAttribute("aria-valuenow"))).toBe(clampedMaximum);

		act(() => keyDown(separator, "ArrowUp"));
		expect(Number(separator.getAttribute("aria-valuenow"))).toBeLessThan(clampedMaximum);
		expect(useActivitySidebarStore.getState().splitRatio).toBeLessThan(clampedMaximum / 100);

		act(() => useActivitySidebarStore.getState().setSplitRatio(0.95));
		pointer(separator, "pointerdown", 100);
		pointer(document, "pointermove", 90);
		pointer(document, "pointerup", 90);
		expect(Number(separator.getAttribute("aria-valuenow"))).toBeLessThan(clampedMaximum);
		expect(useActivitySidebarStore.getState().splitRatio).toBeLessThan(clampedMaximum / 100);
	});

	it("disables short split input, shares non-negative bodies, and supports keyboard reset", async () => {
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		await resize("[data-activity-tree-area]", 150);
		const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
		const heights = [...container.querySelectorAll<HTMLElement>("[data-activity-tree-scroll]")].map(node =>
			Number.parseInt(node.style.height, 10),
		);
		expect(heights).toEqual([46, 46]);
		const sectionHeaders = container.querySelectorAll<HTMLElement>("[data-activity-section-header]");
		expect(sectionHeaders).toHaveLength(4);
		expect([...sectionHeaders].every(header => header.style.height === "23px")).toBe(true);
		expect(separator.getAttribute("aria-disabled")).toBe("true");
		act(() => useActivitySidebarStore.getState().setSplitRatio(0.8));
		expect(separator.getAttribute("aria-valuenow")).toBe("50");
		act(() => useActivitySidebarStore.getState().setSplitRatio(0.5));
		act(() => keyDown(separator, "ArrowDown", true));
		expect(useActivitySidebarStore.getState().splitRatio).toBe(0.5);
		await resize("[data-activity-tree-area]", 320);
		act(() => keyDown(separator, "ArrowDown", true));
		expect(useActivitySidebarStore.getState().splitRatio).toBe(0.6);
		await act(async () => separator.dispatchEvent(new Event("dblclick", { bubbles: true })));
		expect(useActivitySidebarStore.getState().splitRatio).toBe(0.5);
	});

	it("collapses either tree without losing its stored split or either header", async () => {
		useActivitySidebarStore.getState().setSplitRatio(0.62);
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		await click(button("Collapse Todos"));
		expect(container.querySelector('[role="separator"]')).toBeNull();
		await click(button("Expand Todos"));
		expect(useActivitySidebarStore.getState().splitRatio).toBe(0.62);
		await click(button("Collapse Todos"));
		await click(button("Collapse Agents"));
		expect(container.querySelector('section[aria-label="Todos"]')).not.toBeNull();
		expect(container.querySelector('section[aria-label="Agents"]')).not.toBeNull();
	});

	it("keeps tree scrolling independent and removes drag listeners on cancellation", async () => {
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		await resize("[data-activity-tree-area]", 320);
		const separator = container.querySelector<HTMLElement>('[role="separator"]')!;
		const setSplitRatio = vi.spyOn(useActivitySidebarStore.getState(), "setSplitRatio");
		setSplitRatio.mockClear();
		pointer(separator, "pointerdown", 100);
		pointer(document, "pointermove", 120);
		pointer(document, "pointercancel", 120);
		expect(setSplitRatio).toHaveBeenCalledTimes(1);
		setSplitRatio.mockRestore();
		const [todos, agents] = container.querySelectorAll<HTMLElement>("[data-activity-tree-scroll]");
		agents!.scrollTop = 0;
		todos!.scrollTop = 30;
		expect(agents!.scrollTop).toBe(0);
	});

	it("uses a measured metadata budget without stealing the tree minima", async () => {
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		await resize("[data-activity-rail]", 420);
		await click(button("Expand Plan"));
		const detail = container.querySelector<HTMLElement>("[data-activity-meta-detail='plan']")!;
		expect(Number.parseInt(detail.style.maxHeight, 10)).toBe(176);
	});

	it("renders compact counts and reveals a requested tree with focus", async () => {
		useTodoStore.getState().setPhases([{ name: "Build", tasks: [{ content: "one", status: "pending" }] }]);
		useSubagentsStore
			.getState()
			.setSnapshots([{ id: "child", index: 0, status: "running", task: "Work", parentId: null } as never]);
		await mount(<ActivitySidebar activeTabId="tab-a" compact />);
		await click(button(/Agents.*1/));
		expect(useActivitySidebarStore.getState().narrowOverrideTabId).toBe("tab-a");
		expect(useActivitySidebarStore.getState().focusRequest?.id).toBe("agents");
		expect(button(/Todos.*1/)).not.toBeNull();
		expect(button(/Todos.*1/).getAttribute("data-live")).toBe("true");
		expect(container.querySelector("[data-activity-live-indicator='todo']")).not.toBeNull();
		expect(container.querySelector("[data-activity-live-indicator='agents']")).not.toBeNull();
		expect(button(/Todos.*1/).getAttribute("aria-label")).toContain("in progress");
		await act(async () => {
			root.render(
				<I18nProvider>
					<ActivitySidebar activeTabId="tab-a" compact={false} />
				</I18nProvider>,
			);
		});
		expect(container.querySelector('[data-activity-focused="true"]')).not.toBeNull();
	});

	it("uses the selected subagent as read-only while preserving lifecycle controls", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		useAgentViewStore.setState({ target: { kind: "subagent", id: "child" } });
		useTodoStore.getState().setPhases([{ name: "Build", tasks: [{ content: "one", status: "pending" }] }]);
		useSubagentsStore
			.getState()
			.setSnapshots([{ id: "child", index: 0, status: "running", task: "Work", parentId: null } as never]);
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		expect(container.querySelector('[aria-label*="Reorder"]')).toBeNull();
		expect(container.querySelector('[aria-label="Pause"]')).toBeNull();
		expect(button(/Abort.*agent/i)).not.toBeNull();
		expect(consoleError.mock.calls.flat().join(" ")).not.toContain('a "key" prop');
		consoleError.mockRestore();
	});

	it("makes Main-owned activity mutations read-only until the incoming tab route settles", async () => {
		useTodoStore.getState().setPhases([{ name: "Build", tasks: [{ content: "one", status: "pending" }] }]);
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		expect(container.querySelector('[aria-label*="Reorder"]')).not.toBeNull();

		await act(async () => beginTabRoute("outgoing-tab", "tab-a"));
		expect(container.querySelector('[aria-label*="Reorder"]')).toBeNull();

		await act(async () => settleTabRoute("tab-a"));
		expect(container.querySelector('[aria-label*="Reorder"]')).not.toBeNull();
	});

	it.each([
		{
			label: "Plan",
			breakSection: () => {
				getPlanMode.mockResolvedValueOnce(
					rpcResponse("get_plan_mode", { enabled: true, planFilePath: "plan.md" }) as never,
				);
				readPlan.mockResolvedValueOnce({
					ok: true,
					path: "/tmp/plan.md",
					content: {
						split: () => {
							throw new Error("Plan failed");
						},
					},
				} as never);
				useSessionStore.setState({ planModeEnabled: true, cwd: "/tmp", sessionFile: "/tmp/session.jsonl" });
			},
			siblings: ["Goal", "Todos", "Agents"],
		},
		{
			label: "Goal",
			breakSection: () => {
				const goal = {};
				Object.defineProperty(goal, "objective", {
					get: () => {
						throw new Error("Goal failed");
					},
				});
				useSessionStore.setState({ goal: goal as never });
			},
			siblings: ["Plan", "Todos", "Agents"],
		},
		{
			label: "Todo",
			breakSection: () => {
				const phase = { id: "broken", name: "Broken" };
				Object.defineProperty(phase, "tasks", {
					get: () => {
						throw new Error("Todo failed");
					},
				});
				useTodoStore.setState({ phases: [phase as never] });
			},
			siblings: ["Plan", "Goal", "Agents"],
		},
		{
			label: "Agents",
			breakSection: () => {
				const agents = new Map();
				Object.defineProperty(agents, "values", {
					value: () => {
						throw new Error("Agents failed");
					},
				});
				useSubagentsStore.setState({ subagents: agents });
			},
			siblings: ["Plan", "Goal", "Todos"],
		},
	])("isolates a complete $label section failure from its siblings", async ({ breakSection, label, siblings }) => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		breakSection();
		await mount(<ActivitySidebar activeTabId="tab-a" compact={false} />);
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
		expect(container.textContent).toContain(`${label} failed`);
		for (const sibling of siblings) {
			expect(container.querySelector(`section[aria-label="${sibling}"]`)).not.toBeNull();
		}
		consoleError.mockRestore();
	});
});
