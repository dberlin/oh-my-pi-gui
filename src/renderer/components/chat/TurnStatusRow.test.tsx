import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { TurnStatusRow } from "./TranscriptViewport";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});


let container: HTMLElement;
let root: Root;

async function mount(awaitingModelSince: number): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TurnStatusRow awaitingModelSince={awaitingModelSince} compactionInfo={null} retryInfo={null} />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

describe("TurnStatusRow", () => {
	it("announces a stable waiting state without repeating the elapsed clock", async () => {
		await mount(Date.now() - 5_000);

		const status = container.querySelector('[role="status"]');
		expect(status?.textContent).not.toMatch(/\d+s/);
		expect(container.textContent).toMatch(/\d+s/);
	});
});
