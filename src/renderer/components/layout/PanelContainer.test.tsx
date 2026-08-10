/**
 * PanelContainer chat filter: a tool-free chat tab renders only the files +
 * logs drawer tabs (todo/plan/agents/queue/diff can't exist without tools);
 * an agent tab renders all seven. Same linkedom + react-dom harness as
 * mode-visibility.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { PanelContainer } from "./PanelContainer";

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
		root.render(<I18nProvider>{element}</I18nProvider>);
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
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useUiStore.setState({ panelTab: "files", panelVisible: true });
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
});

function seedActiveTab(kind: "agent" | "chat"): void {
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work", status: "ready", kind, unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

function drawerTabLabels(): string[] {
	return [...document.querySelectorAll("aside button")].map(button => (button.textContent ?? "").trim());
}

describe("PanelContainer chat tab filter", () => {
	it("renders only files + logs tabs in a chat tab", async () => {
		seedActiveTab("chat");
		useUiStore.setState({ panelTab: "files", panelVisible: true });
		await mount(<PanelContainer />);

		const labels = drawerTabLabels();
		expect(labels).toContain("Files");
		expect(labels).toContain("Logs");
		for (const hidden of ["Todo", "Plan", "Agents", "Queue", "Diff"]) {
			expect(labels).not.toContain(hidden);
		}
	});

	it("falls back to the files surface when an agent-only tab was selected before entering chat", async () => {
		seedActiveTab("chat");
		useUiStore.setState({ panelTab: "agents", panelVisible: true });
		await mount(<PanelContainer />);

		expect(document.querySelector('button[aria-label="Refresh file tree"]')).not.toBeNull();
		expect(container.textContent).not.toContain("No agents yet");
	});

	it("renders all drawer tabs in an agent tab", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelTab: "files", panelVisible: true });
		await mount(<PanelContainer />);

		const labels = drawerTabLabels();
		for (const visible of ["Todo", "Plan", "Agents", "Queue", "Diff", "Files", "Logs"]) {
			expect(labels).toContain(visible);
		}
	});

	it("uses the available window width instead of a fixed narrow drawer", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 2400 });
		seedActiveTab("agent");
		await mount(<PanelContainer />);

		expect((document.querySelector("aside") as HTMLElement | null)?.style.width).toBe("672px");
	});
});
