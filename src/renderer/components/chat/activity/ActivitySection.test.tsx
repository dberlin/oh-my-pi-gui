import { parseHTML } from "linkedom";
import { ListTodo } from "lucide-react";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useActivitySidebarStore } from "../../../stores/activity-sidebar";
import { ActivitySection } from "./ActivitySection";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

let activeElement: HTMLElement | null = null;
Object.defineProperty(document, "activeElement", {
	configurable: true,
	get: () => activeElement,
});

const parentNodePrototype = Object.getPrototypeOf(Element.prototype) as typeof Node.prototype;
const removeChild = parentNodePrototype.removeChild;

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

function getButton(name: string): HTMLButtonElement {
	const button = [...container.querySelectorAll("button")].find(
		candidate => candidate.getAttribute("aria-label") === name,
	);
	if (!button) throw new Error(`Expected button named ${name}`);
	return button;
}

async function click(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
		activeElement = this;
	});
	vi.spyOn(parentNodePrototype, "removeChild").mockImplementation(function (this: Node, child: Node) {
		if (activeElement && child instanceof HTMLElement && child.contains(activeElement)) activeElement = null;
		return removeChild.call(this, child);
	});
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	document.body.innerHTML = "";
	activeElement = null;
	useActivitySidebarStore.getState().reset();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("ActivitySection", () => {
	it("keeps the section header mounted and restores focus when collapsed", async () => {
		await mount(
			<ActivitySection id="todo" icon={ListTodo} title="Todos">
				<button data-body type="button">
					Inside todos
				</button>
			</ActivitySection>,
		);
		const disclosure = getButton("Collapse Todos");
		const bodyControl = container.querySelector<HTMLButtonElement>("[data-body]");
		if (!bodyControl) throw new Error("Expected section body control");
		bodyControl.focus();

		act(() => useActivitySidebarStore.getState().toggleTree("todo"));

		expect(container.querySelector('section[aria-label="Todos"]')).not.toBeNull();
		expect(container.querySelector("[data-body]")).toBeNull();
		expect(document.activeElement).toBe(disclosure);
		expect(getButton("Expand Todos").getAttribute("aria-expanded")).toBe("false");
	});

	it("expands, focuses, and flashes when the section receives a reveal request", async () => {
		useActivitySidebarStore.setState({ treeCollapsed: { todo: true, agents: false } });
		await mount(
			<ActivitySection id="todo" icon={ListTodo} title="Todos">
				<div data-body>body</div>
			</ActivitySection>,
		);

		act(() => useActivitySidebarStore.getState().revealSection("todo", "tab-a"));

		const disclosure = getButton("Collapse Todos");
		expect(document.activeElement).toBe(disclosure);
		expect(disclosure.closest('[data-activity-focused="true"]')).not.toBeNull();
		expect(container.querySelector("[data-body]")).not.toBeNull();

		act(() => vi.advanceTimersByTime(1199));
		expect(disclosure.closest('[data-activity-focused="true"]')).not.toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(disclosure.closest('[data-activity-focused="true"]')).toBeNull();
	});

	it("ignores reveal requests for other sections", async () => {
		await mount(
			<ActivitySection id="todo" icon={ListTodo} title="Todos">
				<div>body</div>
			</ActivitySection>,
		);
		act(() => useActivitySidebarStore.getState().revealSection("todo", "tab-a"));
		act(() => vi.advanceTimersByTime(1200));
		const outsideControl = document.createElement("button");
		document.body.appendChild(outsideControl);
		outsideControl.focus();

		act(() => useActivitySidebarStore.getState().revealSection("agents", "tab-a"));

		expect(document.activeElement).toBe(outsideControl);
		expect(container.querySelector('[data-activity-focused="true"]')).toBeNull();
	});

	it("finishes the current flash when another section is revealed", async () => {
		await mount(
			<ActivitySection id="todo" icon={ListTodo} title="Todos">
				<div>body</div>
			</ActivitySection>,
		);
		act(() => useActivitySidebarStore.getState().revealSection("todo", "tab-a"));
		const disclosure = getButton("Collapse Todos");
		act(() => vi.advanceTimersByTime(600));

		act(() => useActivitySidebarStore.getState().revealSection("agents", "tab-a"));

		expect(disclosure.closest('[data-activity-focused="true"]')).not.toBeNull();
		act(() => vi.advanceTimersByTime(599));
		expect(disclosure.closest('[data-activity-focused="true"]')).not.toBeNull();
		act(() => vi.advanceTimersByTime(1));
		expect(disclosure.closest('[data-activity-focused="true"]')).toBeNull();
	});

	it("does not toggle when a header action is activated", async () => {
		await mount(
			<ActivitySection actions={<button type="button">Refresh</button>} id="todo" icon={ListTodo} title="Todos">
				<div data-body>body</div>
			</ActivitySection>,
		);

		const refresh = [...container.querySelectorAll("button")].find(button => button.textContent === "Refresh");
		if (!refresh) throw new Error("Expected refresh action");
		await click(refresh);

		expect(useActivitySidebarStore.getState().treeCollapsed.todo).toBe(false);
	});
});
