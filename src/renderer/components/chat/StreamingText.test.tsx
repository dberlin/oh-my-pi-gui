import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { StreamingText } from "./StreamingText";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

interface TestElement {
	textContent: string | null;
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

let frameId = 0;
let frameTime = 0;
const frameCallbacks = new Map<number, FrameRequestCallback>();
const testWindow = window as unknown as Record<string, unknown>;
testWindow.requestAnimationFrame = (callback: FrameRequestCallback) => {
	const id = ++frameId;
	frameCallbacks.set(id, callback);
	return id;
};
testWindow.cancelAnimationFrame = (id: number) => frameCallbacks.delete(id);

let container: TestElement;
let root: Root;

async function mount(text: string): Promise<void> {
	useMessagesStore.setState({ streamingText: text });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<StreamingText />
			</I18nProvider>,
		);
	});
}

async function flushFrame(elapsed = 50): Promise<void> {
	frameTime += elapsed;
	const callbacks = [...frameCallbacks.values()];
	frameCallbacks.clear();
	await act(async () => {
		for (const callback of callbacks) callback(frameTime);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useMessagesStore.getState().reset();
	frameCallbacks.clear();
	frameTime = 0;
});

describe("StreamingText presentation", () => {
	it("coalesces multiple incoming prefixes into one visible animation frame", async () => {
		await mount("A");

		await act(async () => {
			useMessagesStore.setState({ streamingText: "AB" });
			useMessagesStore.setState({ streamingText: "ABC" });
		});
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("A");

		await flushFrame();
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("ABC");
		expect(container.querySelector(".omp-streaming-reveal")?.textContent).toBe("BC");
	});

	it("parses a completed paragraph once and keeps the unfinished suffix lightweight", async () => {
		const paragraph = "First **complete** paragraph.";
		await mount(paragraph);

		await act(async () => {
			useMessagesStore.setState({ streamingText: `${paragraph}\n\nTail still growing` });
		});
		await flushFrame();

		expect(container.querySelectorAll(".omp-streaming-block")).toHaveLength(1);
		expect(container.querySelector("strong")?.textContent).toBe("complete");
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("Tail still growing");
	});

	it("defers code highlighting until the streamed fence closes", async () => {
		const unfinished = "```ts\nconst answer = 42;\n";
		const completed = `${unfinished}\`\`\`\n`;
		await mount(unfinished);
		expect(container.querySelector("code.language-ts")).toBeNull();
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toContain("const answer = 42;");

		await act(async () => {
			useMessagesStore.setState({ streamingText: completed });
		});
		await flushFrame();

		expect(container.querySelector("code.language-ts")?.textContent).toContain("const answer = 42;");
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("");
	});
});
