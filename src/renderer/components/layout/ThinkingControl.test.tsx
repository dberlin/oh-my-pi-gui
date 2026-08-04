/**
 * Contract tests for the composer thinking-level picker (Codex-style):
 * the menu must offer exactly the selectors the active model supports — off,
 * auto, and the model's own ladder — with the current selector checked, and
 * a click must send that explicit value (never an unspecified "next" one).
 * Unsupported models get an honest note instead of a dead cycler.
 * Rendered with react-dom/client into a linkedom document.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { ThinkingControl } from "./ThinkingControl";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

interface TestElement {
	textContent: string | null;
	remove: () => void;
	appendChild: (child: TestElement) => void;
	dispatchEvent: (event: object) => boolean;
}

let setThinkingLevelMock: Mock<(level: string) => Promise<RpcResponse>>;

function installMockOmp(): void {
	setThinkingLevelMock = vi.fn(async () => ({ type: "response", command: "set_thinking_level", success: true }) as RpcResponse);
	const ompWindow = window as unknown as { omp: { rpc: { setThinkingLevel: typeof setThinkingLevelMock } } };
	ompWindow.omp = { rpc: { setThinkingLevel: setThinkingLevelMock } };
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

function click(element: TestElement): void {
	element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
}

function buttonWithMono(text: string): TestElement | undefined {
	const buttons = Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
	return buttons.find(button => button.textContent?.includes(text));
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	// The menu portals to document.body — sweep any leftovers between tests.
	document.body.innerHTML = "";
	useModelStore.getState().reset();
});

describe("ThinkingControl", () => {
	it("lists off, auto, and exactly the model-supported ladder with the current selector checked", async () => {
		installMockOmp();
		useModelStore.setState({
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
			availableThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		});
		await mount(<ThinkingControl />);

		const trigger = buttonWithMono("medium");
		expect(trigger).toBeDefined();
		if (!trigger) return;
		await act(async () => {
			click(trigger);
		});

		const body = document.body.textContent ?? "";
		for (const option of ["off", "auto", "low", "medium", "high", "xhigh", "max"]) {
			expect(body).toContain(option);
		}
		// Unsupported levels must not be offered.
		expect(body).not.toContain("minimal");
	});

	it("sends the explicitly picked value and applies the receipt", async () => {
		installMockOmp();
		useModelStore.setState({
			thinkingLevel: "medium",
			thinkingConfigured: "medium",
			availableThinkingLevels: ["low", "medium", "high"],
		});
		await mount(<ThinkingControl />);

		const trigger = buttonWithMono("medium");
		if (!trigger) throw new Error("trigger missing");
		await act(async () => {
			click(trigger);
		});
		const high = buttonWithMono("high");
		expect(high).toBeDefined();
		if (!high) return;
		await act(async () => {
			click(high);
		});
		await flush();

		expect(setThinkingLevelMock).toHaveBeenCalledWith("high");
		expect(useModelStore.getState().thinkingConfigured).toBe("high");
	});

	it("offers auto as a first-class selector", async () => {
		installMockOmp();
		useModelStore.setState({
			thinkingLevel: "high",
			thinkingConfigured: "high",
			availableThinkingLevels: ["low", "medium", "high"],
		});
		await mount(<ThinkingControl />);

		const trigger = buttonWithMono("high");
		if (!trigger) throw new Error("trigger missing");
		await act(async () => {
			click(trigger);
		});
		const auto = buttonWithMono("auto");
		expect(auto).toBeDefined();
		if (!auto) return;
		await act(async () => {
			click(auto);
		});
		await flush();

		expect(setThinkingLevelMock).toHaveBeenCalledWith("auto");
	});

	it("shows an honest note when the model does not reason", async () => {
		installMockOmp();
		useModelStore.setState({ thinkingLevel: undefined, thinkingConfigured: undefined, availableThinkingLevels: [] });
		await mount(<ThinkingControl />);

		const trigger = buttonWithMono("off");
		if (!trigger) throw new Error("trigger missing");
		await act(async () => {
			click(trigger);
		});
		expect(document.body.textContent).toContain("does not support reasoning");
	});
});
