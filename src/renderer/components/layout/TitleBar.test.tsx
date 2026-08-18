import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { TitleBar } from "./TitleBar";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

interface TestButton {
	title: string;
	click: () => void;
}

interface TestElement {
	remove: () => void;
	querySelectorAll: (selector: string) => TestButton[];
}

const sessions = {
	list: vi.fn(async () => []),
	delete: vi.fn(async () => {}),
	rename: vi.fn(async () => {}),
};
const events = {
	onSessionsChanged: vi.fn(() => () => {}),
};
(window as unknown as { omp: { sessions: typeof sessions; events: typeof events } }).omp = { sessions, events };

let container: TestElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TitleBar onToggleStats={() => {}} />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	useUiStore.getState().closeHotkeys();
	vi.clearAllMocks();
});

describe("TitleBar", () => {
	it("keeps keyboard shortcuts reachable after the bottom status strip is removed", async () => {
		useSessionStore.setState({ status: "ready", cwd: "/tmp/project" });
		await mount();

		const button = Array.from(container.querySelectorAll("button")).find(item => item.title === "Keyboard shortcuts");
		expect(button).toBeDefined();
		expect(useUiStore.getState().hotkeysOpen).toBe(false);

		await act(async () => {
			button?.click();
		});
		expect(useUiStore.getState().hotkeysOpen).toBe(true);
	});
});
