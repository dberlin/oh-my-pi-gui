import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useTodoStore } from "../../../stores/todo";
import { useUiStore } from "../../../stores/ui";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const setTodos: Mock<() => Promise<RpcResponse>> = vi.fn(async () => ({
	type: "response",
	command: "set_todos",
	success: true,
	data: {},
}));
(window as unknown as { omp: { rpc: { setTodos: typeof setTodos } } }).omp = { rpc: { setTodos } };

const { createRoot } = await import("react-dom/client");
const { TodoDockCard } = await import("./TodoDockCard");
const { WorkspaceDock } = await import("./WorkspaceDock");
const { WorkspaceDockFocusProvider } = await import("./WorkspaceDockFocus");

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement = <TodoDockCard />): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setTodos.mockClear();
	useTodoStore.getState().reset();
	useUiStore.setState({ dockCollapsed: {}, dockFocus: null });
});

describe("TodoDockCard", () => {
	it("renders a single phase as a flat compact task list with live counts", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Implementation",
				tasks: [
					{ content: "Refine compact renderer", status: "in_progress" },
					{ content: "Run visual QA", status: "pending" },
				],
			},
		]);
		await mount();

		expect(container.textContent).toContain("Tasks1 running · 1 pending");
		expect(container.textContent).toContain("Refine compact renderer");
		expect(container.textContent).toContain("Run visual QA");
		expect(container.textContent).not.toContain("Implementation");
	});

	it("collapses when the task header row is clicked", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Compatibility",
				tasks: [{ content: "Update model compatibility", status: "completed" }],
			},
		]);
		await mount();

		const header = container.querySelector('section[aria-label="Tasks"] button[aria-label="Collapse"]');
		const title = [...(header?.querySelectorAll("span") ?? [])].find(node => node.textContent === "Tasks");
		await act(async () => {
			title?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});

		expect(container.textContent).not.toContain("Update model compatibility");
		expect(useUiStore.getState().dockCollapsed.todo).toBe(true);
	});

	it("reveals every restored task when view all is clicked", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Restored",
				tasks: Array.from({ length: 12 }, (_, index) => ({
					content: `Restored task ${index + 1}`,
					status: "completed" as const,
				})),
			},
		]);
		await mount(
			<WorkspaceDockFocusProvider>
				<TodoDockCard />
			</WorkspaceDockFocusProvider>,
		);

		expect(container.querySelector('[title="Restored task 1"]')).toBeNull();
		const viewAll = [...container.querySelectorAll("button")].find(button =>
			button.textContent?.includes("View all 12 todos"),
		);
		await act(async () => {
			(viewAll as unknown as { click: () => void }).click();
		});

		expect(container.querySelector('[title="Restored task 1"]')).not.toBeNull();
		expect(container.querySelector('[title="Restored task 12"]')).not.toBeNull();
	});

	it("keeps the dock internally scrollable and bounded so the composer is never clipped", async () => {
		// The dock lives in the shrink-0 composer region, NOT inside the
		// transcript scroll container: without its own max-height + overflow,
		// a large list grows past the h-screen shell and clips the goal bar
		// and composer with no reachable scrollbar.
		useTodoStore
			.getState()
			.setPhases([{ name: "Live", tasks: [{ content: "Visible task", status: "in_progress" }] }]);
		await mount(<WorkspaceDock />);

		const dock = container.querySelector('[data-testid="workspace-dock"]');
		expect(dock).not.toBeNull();
		const className = dock?.getAttribute("class") ?? "";
		expect(className).toContain("overflow-y-auto");
		expect(className).toContain("max-h-");
	});
	it("applies an explicit inline max-height when a card is focused, so long lists scroll", async () => {
		// Regression: the focused cap was expressed as an arbitrary Tailwind
		// class whose calc() had an invalid bare dash — the declaration was
		// dropped, the list grew unbounded, and nothing could scroll. The
		// contract is now an INLINE style, present the moment focus starts.
		useTodoStore.getState().setPhases([
			{
				name: "Live",
				tasks: Array.from({ length: 30 }, (_, index) => ({
					content: `Task ${index + 1}`,
					status: "completed" as const,
				})),
			},
		]);
		await mount(<WorkspaceDock />);

		const viewAll = [...container.querySelectorAll("button")].find(button =>
			button.textContent?.includes("View all 30"),
		);
		await act(async () => (viewAll as unknown as { click: () => void }).click());

		const dock = container.querySelector('[data-testid="workspace-dock"]') as unknown as HTMLElement;
		const style = dock?.getAttribute("style") ?? "";
		expect(/max-height\s*:\s*/.test(style) || /max-height/i.test(style)).toBe(true);

		// The true root cause of "cannot scroll": the scroller is flex-col, and
		// a card whose overflow-hidden kills min-height:auto would be SHRUNK to
		// fit the capped container, clipping its own list instead of letting the
		// container scroll. Cards must therefore refuse to shrink.
		const card = container.querySelector("[data-dock-focused]") as unknown as HTMLElement;
		expect(card).not.toBeNull();
		expect(card.getAttribute("class") ?? "").toContain("shrink-0");
	});
});
