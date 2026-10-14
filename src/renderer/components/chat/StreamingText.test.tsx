import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { loadHljs } from "../../lib/highlight";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { StreamingText } from "./StreamingText";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

interface TestElement {
	textContent: string | null;
	remove: () => void;
	getAttribute: (name: string) => string | null;
	setAttribute: (name: string, value: string) => void;
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

/** StreamingText renders a projection's text, so drive it from the store the way ChatStream does. */
function MainStreamingText() {
	return <StreamingText text={useMessagesStore(s => s.streamingText)} />;
}

async function mount(text: string, element: ReactElement = <MainStreamingText />): Promise<void> {
	useMessagesStore.setState({ streamingText: text });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
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
		expect(container.querySelector(".omp-streaming-tail p")?.textContent).toBe("ABC");
	});

	it("keeps rapid updates pending until the next bounded formatting commit", async () => {
		await mount("**A");
		await act(async () => {
			useMessagesStore.setState({ streamingText: "**AB" });
		});
		await flushFrame();
		await act(async () => {
			useMessagesStore.setState({ streamingText: "**ABC" });
		});
		await flushFrame(10);
		expect(container.querySelector("strong")?.textContent).toBe("AB");
		await flushFrame(30);
		expect(container.querySelector("strong")?.textContent).toBe("ABC");
	});

	it("formats unfinished bold text inside a growing list item", async () => {
		await mount("- First **important");
		expect(container.querySelector(".omp-streaming-tail li strong")?.textContent).toBe("important");
		expect(container.querySelector(".omp-streaming-tail li")?.textContent).toBe("First important");

		await act(async () => {
			useMessagesStore.setState({ streamingText: "- First **important**\n- Second **still growing" });
		});
		await flushFrame();
		expect(container.querySelectorAll(".omp-streaming-tail li")).toHaveLength(2);
		expect(container.querySelectorAll(".omp-streaming-tail strong").map(node => node.textContent)).toEqual([
			"important",
			"still growing",
		]);
	});

	it.each([
		["**bold and *both", "strong em", "both"],
		["__bold", "strong", "bold"],
		["Use ``a ` tick", "code", "a ` tick"],
	])("formats incomplete inline markup %s", async (source, selector, expected) => {
		await mount(source);
		expect(container.querySelector(`.omp-streaming-tail ${selector}`)?.textContent).toBe(expected);
	});

	it.each([
		["Use `<div", "<div"],
		["Use `items[index", "items[index"],
		["Use `<div`", "<div"],
	])("preserves tag/link syntax inside completed and unfinished inline code %s", async (source, expected) => {
		await mount(source);
		expect(container.querySelector(".omp-streaming-tail code")?.textContent).toBe(expected);
		expect(container.querySelector(".omp-streaming-tail a")).toBeNull();
	});

	it.each([
		["Hello **bold** ending", "p"],
		["- Use `code` ending", "li"],
	])("places the caret after the trailing plain text in %s", async (source, endpoint) => {
		await mount(source);
		expect(container.querySelector(".omp-streaming-tail [data-omp-caret]")).toBe(
			container.querySelector(`.omp-streaming-tail ${endpoint}`),
		);
	});

	it("does not treat escaped delimiters or inline code content as emphasis", async () => {
		await mount("Literal \\*\\*stars and `**code**` plus 2 * 3");
		expect(container.querySelector(".omp-streaming-tail code")?.textContent).toBe("**code**");
		expect(container.querySelector(".omp-streaming-tail strong, .omp-streaming-tail em")).toBeNull();
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toContain("Literal **stars");
	});

	it("does not briefly turn a partial next list marker into a heading", async () => {
		await mount("- First\n-");
		expect(container.querySelectorAll(".omp-streaming-tail li")).toHaveLength(1);
		expect(container.querySelector("h1, h2, hr")).toBeNull();
		await act(async () => {
			useMessagesStore.setState({ streamingText: "- First\n- **Second" });
		});
		await flushFrame();
		expect(container.querySelectorAll(".omp-streaming-tail li")).toHaveLength(2);
		expect(container.querySelector(".omp-streaming-tail strong")?.textContent).toBe("Second");
	});

	it("keeps completed blocks mounted when the formatted tail grows", async () => {
		await mount("Finished **paragraph**.\n\nLive **tail");
		const block = container.querySelector(".omp-streaming-block");
		block?.setAttribute("data-probe", "stable");
		await act(async () => {
			useMessagesStore.setState({ streamingText: "Finished **paragraph**.\n\nLive **tail grows" });
		});
		await flushFrame();
		expect(container.querySelector("[data-probe='stable']")).toBe(block);
		expect(container.querySelector(".omp-streaming-tail strong")?.textContent).toBe("tail grows");
	});

	it("sanitizes raw HTML and unsafe URLs in the formatted unfinished tail", async () => {
		await mount(
			'- **Safe** <span onclick="alert(1)" style="position:fixed" class="fixed">text</span>' +
				'<script>alert(2)</script><iframe src="https://evil.invalid"></iframe> [unsafe](javascript:alert%283%29)',
		);
		expect(container.querySelector(".omp-streaming-tail strong")?.textContent).toBe("Safe");
		expect(container.querySelector("script, iframe, [onclick], [style], .fixed")).toBeNull();
		expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
		expect(container.textContent).not.toContain("alert(2)");
	});

	it("renders only projected input and replaces it without leaking another stream", async () => {
		await mount("Main **secret**", <StreamingText text="- Subagent **isolated" />);
		expect(container.querySelector("li strong")?.textContent).toBe("isolated");
		await act(async () => {
			useMessagesStore.setState({ streamingText: "Main **different secret**" });
		});
		await flushFrame();
		expect(container.textContent).not.toContain("Main");

		await act(async () => {
			root.render(
				<I18nProvider>
					<StreamingText text="Replacement **answer" />
				</I18nProvider>,
			);
		});
		expect(container.querySelector("strong")?.textContent).toBe("answer");
		expect(container.textContent).not.toContain("Subagent");
	});

	it("promotes a completed paragraph without changing its formatted content", async () => {
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

	it("renders a partial fence as escaped code and highlights only after promotion", async () => {
		await loadHljs();
		const unfinished = "```ts\nconst answer = '<script>unsafe</script>';\n";
		const completed = `${unfinished}\`\`\`\n`;
		await mount(unfinished);
		const code = container.querySelector(".omp-streaming-tail code.language-typescript");
		expect(code?.textContent).toBe("const answer = '<script>unsafe</script>';");
		expect(code?.querySelector("span")).toBeNull();
		expect(container.querySelector("script")).toBeNull();

		await act(async () => {
			useMessagesStore.setState({ streamingText: "```ts\nconst answer = 43;\n" });
		});
		await flushFrame();
		expect(container.querySelector("code.language-typescript")?.textContent).toBe("const answer = 43;");

		await act(async () => {
			useMessagesStore.setState({ streamingText: completed });
		});
		await flushFrame();
		expect(container.querySelector(".omp-streaming-block code.language-typescript")?.textContent).toContain(
			"const answer = '<script>unsafe</script>';",
		);
		expect(container.querySelector(".omp-streaming-block code span")).not.toBeNull();
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("");
	});

	it("shows an unfinished Mermaid fence as literal source, not a partial diagram", async () => {
		await mount("```mermaid\ngraph TD\nA -->");
		expect(container.querySelector(".omp-streaming-tail code.language-mermaid")?.textContent).toBe("graph TD\nA -->");
		expect(container.querySelector(".omp-streaming-tail img")).toBeNull();
	});
	it("keeps an unfinished bracket equation together and typesets it when it closes", async () => {
		const unfinished = String.raw`\[
TPS_{\text{decode}}

=
\frac{500-1}{12-2}
=
49.9
`;
		await mount(unfinished);
		expect(container.querySelector(".omp-streaming-block")).toBeNull();
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe(unfinished);

		await act(async () => {
			useMessagesStore.setState({ streamingText: `${unfinished}\\]\nExplanation` });
		});
		await flushFrame();

		expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
		expect(container.querySelector("h1, h2, .katex-error")).toBeNull();
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("Explanation");
	});
});
