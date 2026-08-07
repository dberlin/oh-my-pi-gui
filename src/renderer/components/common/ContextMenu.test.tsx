/**
 * ContextMenu contract tests: items render, arrows navigate, Enter selects,
 * Escape closes, disabled items never fire. Same linkedom + react-dom harness
 * as LangSwitcher.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

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
		root.render(element);
	});
	await flush();
}

async function menuKeyDown(key: string): Promise<void> {
	const menu = document.body.querySelector('[role="menu"]') as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(menu).find(name => name.startsWith("__reactProps$"));
	const props = propsKey
		? (menu[propsKey] as { onKeyDown?: (event: { key: string; preventDefault(): void }) => void } | undefined)
		: undefined;
	if (!props?.onKeyDown) throw new Error("menu onKeyDown not found");
	await act(async () => props.onKeyDown?.({ key, preventDefault: () => {} }));
	await flush();
}

async function clickItem(label: string): Promise<void> {
	const button = [...document.body.querySelectorAll("button")].find(b => b.textContent?.includes(label));
	const record = button as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	const props = propsKey
		? (record[propsKey] as { onClick?: (event: { preventDefault(): void }) => void } | undefined)
		: undefined;
	if (!props?.onClick) throw new Error(`item onClick not found: ${label}`);
	await act(async () => props.onClick?.({ preventDefault: () => {} }));
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	document.body.innerHTML = "";
});

describe("ContextMenu", () => {
	it("renders all items and fires onSelect on click", async () => {
		const onA = vi.fn();
		const onB = vi.fn();
		const items: ContextMenuItem[] = [
			{ id: "a", label: "Action A", onSelect: onA },
			{ id: "b", label: "Action B", onSelect: onB },
		];
		await mount(<ContextMenu items={items} x={10} y={10} onClose={() => {}} />);

		expect(document.body.textContent).toContain("Action A");
		expect(document.body.textContent).toContain("Action B");
		await clickItem("Action B");
		expect(onB).toHaveBeenCalledTimes(1);
		expect(onA).not.toHaveBeenCalled();
	});

	it("arrows navigate, Enter selects the active item", async () => {
		const onA = vi.fn();
		const onB = vi.fn();
		await mount(
			<ContextMenu
				items={[
					{ id: "a", label: "Action A", onSelect: onA },
					{ id: "b", label: "Action B", onSelect: onB },
				]}
				x={10}
				y={10}
				onClose={() => {}}
			/>,
		);

		await menuKeyDown("ArrowDown");
		await menuKeyDown("Enter");
		expect(onB).toHaveBeenCalledTimes(1);

		// Wrap-around: ArrowUp from the last item cycles back and selects A.
		await menuKeyDown("ArrowUp");
		await menuKeyDown("Enter");
		expect(onA).toHaveBeenCalledTimes(1);
	});

	it("Escape closes without selecting", async () => {
		const onClose = vi.fn();
		const onA = vi.fn();
		await mount(
			<ContextMenu items={[{ id: "a", label: "Action A", onSelect: onA }]} x={10} y={10} onClose={onClose} />,
		);

		await menuKeyDown("Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onA).not.toHaveBeenCalled();
	});

	it("disabled items are skipped by navigation and never fire", async () => {
		const onA = vi.fn();
		const onB = vi.fn();
		await mount(
			<ContextMenu
				items={[
					{ id: "a", label: "Disabled A", disabled: true, disabledReason: "nope", onSelect: onA },
					{ id: "b", label: "Action B", onSelect: onB },
				]}
				x={10}
				y={10}
				onClose={() => {}}
			/>,
		);

		// Initial active index skips the disabled first item; Enter hits B.
		await menuKeyDown("Enter");
		expect(onB).toHaveBeenCalledTimes(1);
		expect(onA).not.toHaveBeenCalled();
	});
});
