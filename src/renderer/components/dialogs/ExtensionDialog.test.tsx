import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ExtensionUIResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { ExtensionDialog } from "./ExtensionDialog";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

interface TestElement {
	textContent: string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

let container: TestElement;
let root: Root;
let respondExtensionUi: Mock<(response: ExtensionUIResponse) => void>;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	respondExtensionUi = vi.fn();
	const ompWindow = window as unknown as { omp: { ui: { respondExtensionUi: typeof respondExtensionUi } } };
	ompWindow.omp = { ui: { respondExtensionUi } };
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ExtensionDialog />
			</I18nProvider>,
		);
	});
}

function buttonWithText(text: string): TestElement | undefined {
	const buttons = Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
	return buttons.find(button => button.textContent?.includes(text));
}

async function click(element: TestElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

function showAskDialog(): void {
	useExtensionUiStore.getState().pushRequest({
		type: "extension_ui_request",
		id: "ask-1",
		method: "askDialog",
		questions: [
			{
				id: "deploy",
				question: "Where should this deploy?",
				options: [
					{ label: "Staging", description: "Safe environment" },
					{ label: "Production", preview: "Deploys to **all users**." },
				],
				recommended: 0,
			},
		],
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useExtensionUiStore.getState().clearAll();
	vi.restoreAllMocks();
	document.title = "";
});

describe("ExtensionDialog askDialog", () => {
	it("returns the wire submit discriminator and renders the selected option preview", async () => {
		await mount();
		await act(async () => showAskDialog());

		const production = buttonWithText("Production");
		if (!production) throw new Error("missing Production option");
		await click(production);
		expect(document.body.textContent).toContain("Deploys to all users.");

		const form = document.querySelector("form") as unknown as TestElement | null;
		if (!form) throw new Error("missing ask form");
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-1",
			askDialog: {
				kind: "submit",
				results: [
					{
						id: "deploy",
						question: "Where should this deploy?",
						options: ["Staging", "Production"],
						multi: false,
						selectedOptions: ["Production"],
					},
				],
			},
		});
	});

	it("returns the chat redirect discriminator", async () => {
		await mount();
		await act(async () => showAskDialog());

		const chat = buttonWithText("Chat about this");
		if (!chat) throw new Error("missing Chat about this button");
		await click(chat);

		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-1",
			askDialog: { kind: "chat" },
		});
	});
});

describe("ExtensionDialog non-dialog mutations", () => {
	it("fills the composer for set_editor_text and applies extension window titles", async () => {
		await mount();
		let editorText: string | undefined;
		window.addEventListener(
			"omp:fill-composer",
			(event: Event) => {
				editorText = (event as CustomEvent<{ text?: string }>).detail.text;
			},
			{ once: true },
		);

		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "editor-1",
				method: "set_editor_text",
				text: "restored draft",
			});
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "title-1",
				method: "setTitle",
				title: "Extension task",
			});
		});
		await flush();

		expect(editorText).toBe("restored draft");
		expect(document.title).toBe("Extension task");
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
	});
});
