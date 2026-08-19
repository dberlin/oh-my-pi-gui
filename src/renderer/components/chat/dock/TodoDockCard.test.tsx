import { parseHTML } from "linkedom";
import { act } from "react";
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

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TodoDockCard />
			</I18nProvider>,
		);
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
});
