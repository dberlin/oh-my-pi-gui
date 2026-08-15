import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse, TodoPhase, TodoTask } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useTodoStore } from "../../../stores/todo";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const selectionDocument = document as unknown as {
	getSelection: () => { removeAllRanges: () => void };
};
selectionDocument.getSelection = () => ({ removeAllRanges: () => undefined });
const styleWindow = window as unknown as {
	getComputedStyle: () => {
		overflow: string;
		overflowX: string;
		overflowY: string;
		position: string;
		transform: string;
		transformOrigin: string;
	};
};
styleWindow.getComputedStyle = () => ({
	overflow: "visible",
	overflowX: "visible",
	overflowY: "visible",
	position: "static",
	transform: "none",
	transformOrigin: "0 0",
});

const setTodos = vi.fn(
	async (_phases: TodoPhase[]): Promise<RpcResponse> => ({
		type: "response",
		command: "set_todos",
		success: true,
		data: {},
	}),
);
const ompWindow = window as unknown as { omp: { rpc: { setTodos: typeof setTodos } } };
ompWindow.omp = { rpc: { setTodos } };

// react-dom must observe the linkedom globals installed above.
const { createRoot } = await import("react-dom/client");
const { TodoTree } = await import("./TodoTree");

let container: HTMLElement;
let root: Root;

function task(content: string, status: TodoTask["status"]): TodoTask {
	return { content, status };
}

function phase(name: string, tasks: TodoTask[]): TodoPhase {
	return { name, tasks };
}

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

function text(value: string): HTMLElement {
	const match = [...container.querySelectorAll<HTMLElement>("*")].find(
		element => element.textContent === value && [...element.children].every(child => child.textContent !== value),
	);
	if (!match) throw new Error(`Missing text: ${value}`);
	return match;
}

function button(name: RegExp): HTMLButtonElement | null {
	return (
		[...container.querySelectorAll<HTMLButtonElement>("button")].find(element =>
			name.test(element.getAttribute("aria-label") ?? element.textContent ?? ""),
		) ?? null
	);
}

function treeItem(label: string): HTMLElement {
	const match = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(element =>
		element.textContent?.includes(label),
	);
	if (!match) throw new Error(`Missing tree item: ${label}`);
	return match;
}

function focusedTreeItem(): HTMLElement {
	const match = container.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]');
	if (!match) throw new Error("Missing focused tree item");
	return match;
}

function reactProps(element: HTMLElement): { onChange?: (event: object) => void } | undefined {
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	return key ? (record[key] as { onChange?: (event: object) => void } | undefined) : undefined;
}

async function typeInto(element: HTMLInputElement, value: string): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else element.value = value;
	const props = reactProps(element);
	if (props?.onChange) {
		await act(async () => props.onChange?.({ target: element, currentTarget: element }));
	} else {
		await act(async () => {
			element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
		});
	}
	await flush();
}

async function click(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

async function doubleClick(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("dblclick", { bubbles: true, cancelable: true }));
	});
	await flush();
}

async function keyDown(
	element: Element,
	key: string,
	options: { altKey?: boolean; code?: string } = {},
): Promise<void> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		altKey: { value: options.altKey ?? false },
		code: { value: options.code ?? (key === " " ? "Space" : key) },
		key: { value: key },
	});
	await act(async () => {
		element.dispatchEvent(event);
	});
	await flush();
}

function pointerEvent(type: string, clientX: number, clientY: number): InstanceType<typeof Event> {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		button: { value: 0 },
		clientX: { value: clientX },
		clientY: { value: clientY },
		isPrimary: { value: true },
		pageX: { value: clientX },
		pageY: { value: clientY },
	});
	return event;
}

async function dragFirstTaskDown(): Promise<void> {
	const rows = [...container.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="2"]')];
	rows.forEach((row, index) => {
		const top = 40 + index * 40;
		Object.defineProperty(row, "getBoundingClientRect", {
			configurable: true,
			value: () => ({
				bottom: top + 32,
				height: 32,
				left: 0,
				right: 200,
				toJSON: () => undefined,
				top,
				width: 200,
				x: 0,
				y: top,
			}),
		});
	});
	const handle = button(/reorder/i);
	if (!handle) throw new Error("Missing reorder handle");
	await act(async () => {
		handle.dispatchEvent(pointerEvent("pointerdown", 12, 52));
	});
	await flush();
	await act(async () => {
		document.dispatchEvent(pointerEvent("pointermove", 12, 96));
	});
	await flush();
	await act(async () => {
		document.dispatchEvent(pointerEvent("pointermove", 12, 96));
	});
	await flush();
	await act(async () => {
		document.dispatchEvent(pointerEvent("pointerup", 12, 96));
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => root.unmount());
	}
	container?.remove();
	setTodos.mockClear();
	useTodoStore.getState().reset();
});

describe("TodoTree", () => {
	it("renders task rows without React reserved-key warnings", async () => {
		const errors: string[] = [];
		const consoleError = vi.spyOn(console, "error").mockImplementation((...arguments_) => {
			errors.push(arguments_.map(String).join(" "));
		});
		try {
			useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
			await mount(<TodoTree readOnly={false} />);

			expect(errors.some(message => message.includes('containing a "key" prop'))).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("renders generated and explicit ID provenance on phase and task semantic rows", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Build",
				tasks: [
					{ content: "generated", status: "pending" },
					{ id: "phase:0:Build:task:1", content: "explicit", status: "pending" } as never,
				],
			},
			{ id: "phase:1:Explicit phase", name: "Explicit phase", tasks: [] } as never,
		]);
		await mount(<TodoTree readOnly={false} />);

		expect(treeItem("generated").getAttribute("data-todo-id-generated")).toBe("true");
		expect(treeItem("explicit").getAttribute("data-todo-id-generated")).toBe("false");
		expect(treeItem("Build").getAttribute("data-todo-id-generated")).toBe("true");
		expect(treeItem("Explicit phase").getAttribute("data-todo-id-generated")).toBe("false");
	});

	it("renders a stable empty tree body", async () => {
		await mount(<TodoTree readOnly={false} />);

		expect(text("No todos")).not.toBeNull();
		expect(container.querySelector('[role="tree"][aria-label="Todos"]')).not.toBeNull();
	});

	it("keeps Main todos visible but removes every mutation path when read-only", async () => {
		useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
		useTodoStore.getState().showReminder([task("remember", "pending")]);
		await mount(<TodoTree readOnly />);

		expect(text("one")).not.toBeNull();
		expect(button(/status/i)).toBeNull();
		expect(button(/reorder/i)).toBeNull();
		expect(button(/edit/i)).toBeNull();
		expect(button(/dismiss reminder/i)).toBeNull();
		await doubleClick(text("one"));
		expect(container.querySelector("input")).toBeNull();
		expect(setTodos).not.toHaveBeenCalled();
	});

	it("restores status mutations on Main", async () => {
		useTodoStore.getState().setPhases([phase("Build", [task("one", "pending"), task("two", "pending")])]);
		await mount(<TodoTree readOnly={false} />);

		const status = button(/status/i);
		if (!status) throw new Error("Missing status button");
		await click(status);
		expect(setTodos).toHaveBeenCalledWith([
			{
				name: "Build",
				tasks: [
					{ content: "one", status: "in_progress" },
					{ content: "two", status: "pending" },
				],
			},
		]);
	});

	it("persists inline task edits on Main", async () => {
		useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
		await mount(<TodoTree readOnly={false} />);

		await doubleClick(text("one"));
		const input = container.querySelector<HTMLInputElement>("input");
		if (!input) throw new Error("Missing task editor");
		await typeInto(input, "updated");
		await keyDown(input, "Enter");
		expect(setTodos).toHaveBeenLastCalledWith([
			{ name: "Build", tasks: [{ content: "updated", status: "pending" }] },
		]);
	});

	it("preserves tree semantics and blocks keyboard mutation while read-only", async () => {
		useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
		await mount(<TodoTree readOnly />);

		const tree = container.querySelector<HTMLElement>('[role="tree"][aria-label="Todos"]');
		if (!tree) throw new Error("Missing Todo tree");
		const row = treeItem("one");
		expect(row.getAttribute("aria-level")).toBe("2");
		await keyDown(row, " ");
		expect(setTodos).not.toHaveBeenCalled();
	});

	it("uses roving focus and navigates visible phase and task rows", async () => {
		useTodoStore
			.getState()
			.setPhases([
				phase("Build", [task("one", "pending"), task("two", "pending")]),
				phase("Ship", [task("three", "pending")]),
			]);
		await mount(<TodoTree readOnly={false} />);

		const items = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
		expect(items.filter(item => item.getAttribute("tabindex") === "0")).toHaveLength(1);
		await keyDown(focusedTreeItem(), "ArrowDown");
		expect(focusedTreeItem().textContent).toContain("one");
		await keyDown(focusedTreeItem(), "End");
		expect(focusedTreeItem().textContent).toContain("three");
		await keyDown(focusedTreeItem(), "Home");
		await keyDown(focusedTreeItem(), "ArrowLeft");
		expect(items[0]?.getAttribute("aria-expanded")).toBe("false");
		await keyDown(focusedTreeItem(), "ArrowRight");
		expect(items[0]?.getAttribute("aria-expanded")).toBe("true");
	});

	it("keeps child actions out of the roving Tab sequence and exposes keyboard row actions", async () => {
		useTodoStore.getState().setPhases([phase("Build", [task("one", "pending"), task("two", "pending")])]);
		await mount(<TodoTree readOnly={false} />);

		const one = treeItem("one");
		expect([...one.querySelectorAll("button")].every(control => control.getAttribute("tabindex") === "-1")).toBe(
			true,
		);
		expect(one.getAttribute("aria-keyshortcuts")).toContain("Alt+ArrowDown");
		await keyDown(one, "ArrowDown", { altKey: true });
		expect(
			[...container.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="2"]')].map(row => row.textContent),
		).toEqual([expect.stringContaining("two"), expect.stringContaining("one")]);
		expect(setTodos).toHaveBeenLastCalledWith([
			{
				name: "Build",
				tasks: [
					{ content: "two", status: "pending" },
					{ content: "one", status: "pending" },
				],
			},
		]);
	});

	it("associates each expanded task group with its phase treeitem", async () => {
		useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
		await mount(<TodoTree readOnly={false} />);

		const build = treeItem("Build");
		const ownedGroup = build.getAttribute("aria-owns");
		expect(ownedGroup).not.toBeNull();
		expect(container.querySelector(`[role="group"][id="${ownedGroup}"]`)).not.toBeNull();
	});

	it("does not begin editing when a status or reorder control is double-clicked", async () => {
		useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
		await mount(<TodoTree readOnly={false} />);

		const status = button(/status/i);
		const reorder = button(/reorder/i);
		if (!status || !reorder) throw new Error("Missing task controls");
		await doubleClick(status);
		await doubleClick(reorder);
		expect(container.querySelector("input")).toBeNull();
	});

	it("reorders a same-phase drag and persists the exact wire payload", async () => {
		useTodoStore.getState().setPhases([phase("Build", [task("one", "pending"), task("two", "pending")])]);
		await mount(<TodoTree readOnly={false} />);

		await dragFirstTaskDown();
		expect(
			[...container.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="2"]')].map(row => row.textContent),
		).toEqual([expect.stringContaining("two"), expect.stringContaining("one")]);
		expect(setTodos).toHaveBeenLastCalledWith([
			{
				name: "Build",
				tasks: [
					{ content: "two", status: "pending" },
					{ content: "one", status: "pending" },
				],
			},
		]);
	});

	it("keeps phase disclosure available in read-only mode", async () => {
		useTodoStore.getState().setPhases([phase("Build", [task("one", "pending")])]);
		await mount(<TodoTree readOnly />);

		const build = treeItem("Build");
		expect(build.getAttribute("aria-expanded")).toBe("true");
		await click(build);
		expect(build.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("one");
	});

	it("renders reminders and only allows Main to dismiss them", async () => {
		useTodoStore.getState().showReminder([task("remember", "pending")]);
		await mount(<TodoTree readOnly={false} />);

		expect(container.textContent).toContain("Todo reminder");
		const dismiss = button(/dismiss reminder/i);
		if (!dismiss) throw new Error("Missing reminder dismissal");
		await click(dismiss);
		expect(useTodoStore.getState().reminderVisible).toBe(false);
	});
});
