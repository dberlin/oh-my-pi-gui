import { parseHTML } from "linkedom";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { Modal } from "./Modal";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let activeElement: HTMLElement | null = null;
Object.defineProperty(document, "activeElement", {
	configurable: true,
	get: () => activeElement,
});

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
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await render(element);
}

async function render(element: ReactElement): Promise<void> {
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

async function pressEscape(): Promise<void> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	(event as unknown as { key: string }).key = "Escape";
	await act(async () => {
		document.dispatchEvent(event);
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
	document.body.innerHTML = "";
	activeElement = null;
	vi.restoreAllMocks();
});

describe("Modal", () => {
	it("focuses the dialog on open and restores the trigger on close", async () => {
		const trigger = document.createElement("button");
		document.body.appendChild(trigger);
		activeElement = trigger;
		vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement) {
			activeElement = this;
		});

		await mount(
			<Modal open onClose={() => {}} title="Dialog">
				<button type="button">Action</button>
			</Modal>,
		);

		expect(document.querySelector("[role='dialog']")?.contains(activeElement)).toBe(true);
		await render(
			<Modal open={false} onClose={() => {}} title="Dialog">
				<button type="button">Action</button>
			</Modal>,
		);
		expect(activeElement).toBe(trigger);
		trigger.remove();
	});

	it("closes only the topmost dialog for each Escape press", async () => {
		const closeBottom = vi.fn();
		const closeTop = vi.fn();

		function StackedDialogs() {
			const [bottomOpen, setBottomOpen] = useState(true);
			const [topOpen, setTopOpen] = useState(true);
			return (
				<>
					<Modal
						onClose={() => {
							closeBottom();
							setBottomOpen(false);
						}}
						open={bottomOpen}
						title="Bottom"
					>
						<button type="button">Bottom action</button>
					</Modal>
					<Modal
						onClose={() => {
							closeTop();
							setTopOpen(false);
						}}
						open={topOpen}
						title="Top"
					>
						<button type="button">Top action</button>
					</Modal>
				</>
			);
		}

		await mount(<StackedDialogs />);
		await pressEscape();
		expect(closeTop).toHaveBeenCalledTimes(1);
		expect(closeBottom).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Bottom action");

		await pressEscape();
		expect(closeBottom).toHaveBeenCalledTimes(1);
	});

	it("ignores Escape while a custom fullscreen dialog covers it", async () => {
		const onClose = vi.fn();
		await mount(
			<Modal open onClose={onClose} title="Underlay">
				<button type="button">Action</button>
			</Modal>,
		);
		const fullscreen = document.createElement("div");
		fullscreen.setAttribute("role", "dialog");
		document.body.appendChild(fullscreen);

		await pressEscape();
		expect(onClose).not.toHaveBeenCalled();

		fullscreen.remove();
		await pressEscape();
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
