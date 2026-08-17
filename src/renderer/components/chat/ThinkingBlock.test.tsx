import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { ThinkingBlock } from "./ThinkingBlock";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	textContent: string | null;
	getAttribute: (name: string) => string | null;
	dispatchEvent: (event: Event) => boolean;
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

const HEADLINED_THINKING =
	"**Planning nested repository boundary insertion**\n\n**Clarifying .gitignore and commit boundaries**";

let container: TestElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

async function mountExpandedThinking(text: string): Promise<void> {
	useUiStore.getState().setThinkingExpanded(true);
	await mount(<ThinkingBlock text={text} />);
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container?.remove();
	useSettingsStore.getState().reset();
	useUiStore.getState().setThinkingExpanded(false);
});

describe("ThinkingBlock", () => {
	it("renders reasoning markdown instead of literal syntax (TUI parity)", async () => {
		await mountExpandedThinking(HEADLINED_THINKING);

		const strongs = Array.from(document.querySelectorAll("strong")) as unknown as TestElement[];
		expect(strongs.length).toBe(2);
		expect(strongs[0]?.textContent).toBe("Planning nested repository boundary insertion");
		expect(container.textContent).not.toContain("**Planning");
	});

	it("keeps fenced code as a code block in raw mode", async () => {
		useSettingsStore.setState({ proseOnlyThinking: false });
		await mountExpandedThinking("Plan:\n\n```ts\nconst ok = true;\n```");

		expect(container.querySelector("code.language-typescript")).not.toBeNull();
		expect(container.textContent).toContain("const ok = true;");
	});

	it("elides fenced code to an ellipsis placeholder in prose-only mode", async () => {
		useSettingsStore.setState({ proseOnlyThinking: true });
		await mountExpandedThinking("Plan:\n\n```ts\nconst ok = true;\n```\n\nThen verify.");

		expect(container.textContent).toContain("Then verify.");
		expect(container.querySelector("code.language-ts")).toBeNull();
	});

	it("exposes only a bounded preview until compact reasoning is expanded", async () => {
		const text = `Visible reasoning preview ${"detail ".repeat(80)}HIDDEN_REASONING_TAIL`;
		useUiStore.getState().setThinkingExpanded(false);
		await mount(<ThinkingBlock compact text={text} />);

		const toggle = container.querySelector(".omp-thinking-compact-toggle");
		const regionId = toggle?.getAttribute("aria-controls");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(regionId).toBeTruthy();
		const collapsedRegion = regionId ? (document.getElementById(regionId) as unknown as TestElement | null) : null;
		expect(collapsedRegion?.textContent).toContain("Visible reasoning preview");
		expect(collapsedRegion?.textContent).not.toContain("HIDDEN_REASONING_TAIL");
		expect(collapsedRegion?.querySelector(".markdown-body")).not.toBeNull();

		await act(async () => {
			toggle?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});

		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		const expandedRegion = regionId ? (document.getElementById(regionId) as unknown as TestElement | null) : null;
		expect(expandedRegion?.textContent).toContain("HIDDEN_REASONING_TAIL");
		expect(expandedRegion?.querySelector(".markdown-body")).not.toBeNull();
	});

	it("uses only the streaming caret as motion while visible reasoning grows", async () => {
		useUiStore.getState().setThinkingExpanded(true);
		await mount(<ThinkingBlock live text={HEADLINED_THINKING} />);

		expect(container.querySelectorAll(".omp-caret")).toHaveLength(1);
		expect(container.querySelector(".omp-thinking-pulse")).toBeNull();
	});
});
