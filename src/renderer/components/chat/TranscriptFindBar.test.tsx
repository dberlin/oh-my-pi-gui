import { parseHTML } from "linkedom";
import { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { TranscriptFindBar, type TranscriptFindBarProps, TranscriptFindTicks } from "./TranscriptFindBar";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const installedGlobals = { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true };
// linkedom's HTMLInputElement has no `select()`, and the bar claims focus and
// selects its query on mount (see TranscriptFindBar's mount effect). Same stub
// TranscriptViewport.test.tsx installs for the same reason.
Object.assign(HTMLElement.prototype, { select: () => {} });
const priorGlobals = new Map<string, PropertyDescriptor | undefined>();
const mounts: Array<{ container: HTMLElement; root: Root }> = [];

beforeAll(() => {
	for (const [key, value] of Object.entries(installedGlobals)) {
		priorGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
});

afterAll(() => {
	for (const [key, descriptor] of priorGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

afterEach(async () => {
	while (mounts.length > 0) {
		const mounted = mounts.pop();
		if (!mounted) continue;
		await act(async () => {
			mounted.root.unmount();
		});
		mounted.container.remove();
	}
});

async function mount(node: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	const root = createRoot(container as unknown as Element);
	mounts.push({ container, root });
	await act(async () => {
		root.render(<I18nProvider>{node}</I18nProvider>);
	});
	return container;
}

const baseProps: TranscriptFindBarProps = {
	query: "",
	onQueryChange: () => {},
	total: 0,
	current: null,
	wrapped: false,
	onOlder: () => {},
	onNewer: () => {},
	onClose: () => {},
	inputRef: createRef<HTMLInputElement>(),
};

let container: HTMLElement;

describe("TranscriptFindBar", () => {
	it("renders the counter in document order with tabular figures", async () => {
		container = await mount(<TranscriptFindBar {...baseProps} query="needle" total={17} current={2} />);
		expect(container.querySelector("[data-find-counter]")?.textContent).toBe("3 / 17");
	});

	it("renders no counter and no error for an empty query", async () => {
		container = await mount(<TranscriptFindBar {...baseProps} query="" total={0} current={null} />);
		expect(container.querySelector("[data-find-counter]")).toBeNull();
		expect(container.querySelector("[data-find-input]")?.getAttribute("aria-invalid")).toBeNull();
	});

	it("announces nothing for the untouched empty-query state", async () => {
		container = await mount(<TranscriptFindBar {...baseProps} query="" total={0} current={null} />);
		expect(container.querySelector("[role='status']")?.textContent).toBe("");
	});

	it("announces matches found without claiming a selection when current is null but matches exist", async () => {
		container = await mount(<TranscriptFindBar {...baseProps} query="needle" total={5} current={null} />);
		const status = container.querySelector("[role='status']")?.textContent;
		expect(status).not.toBe("No matches");
		expect(status).toContain("5");
	});

	it("marks the input invalid and reads 0 / 0 when a real query has no matches", async () => {
		container = await mount(<TranscriptFindBar {...baseProps} query="zzz" total={0} current={null} />);
		expect(container.querySelector("[data-find-counter]")?.textContent).toBe("0 / 0");
		expect(container.querySelector("[data-find-input]")?.getAttribute("aria-invalid")).toBe("true");
		expect(container.querySelector("[role='status']")?.textContent).toBe("No matches");
	});

	it("announces the wrap for one step", async () => {
		container = await mount(<TranscriptFindBar {...baseProps} query="needle" total={3} current={2} wrapped />);
		expect(container.querySelector("[role='status']")?.textContent).toBe("Match 3 of 3, wrapped");
		expect(container.textContent).toContain("wrapped");
	});

	it("labels the buttons by travel direction, not by previous/next", async () => {
		container = await mount(<TranscriptFindBar {...baseProps} query="needle" total={3} current={0} />);
		const labels = [...container.querySelectorAll("button")].map(b => b.getAttribute("aria-label"));
		expect(labels).toEqual(["Older match", "Newer match", "Close find"]);
	});

	it("routes Enter to older, Shift+Enter to newer, and Escape to close, preventing default each time", async () => {
		const onOlder = vi.fn();
		const onNewer = vi.fn();
		const onClose = vi.fn();
		container = await mount(
			<TranscriptFindBar {...baseProps} query="needle" total={3} current={0} {...{ onOlder, onNewer, onClose }} />,
		);
		const input = container.querySelector("[data-find-input]");
		// React feature-detects DOM support at module-import time, before this file's
		// beforeAll() installs the linkedom globals; with no `document` yet, it
		// concludes native "input" events aren't supported and falls back to its
		// legacy IE9 text-input polyfill for keydown/keyup, which tracks the focused
		// input via a real focusin event and calls the IE-only attachEvent/detachEvent
		// on it. linkedom implements neither, so stub them before focusing.
		(input as unknown as { attachEvent?: () => void }).attachEvent = () => {};
		(input as unknown as { detachEvent?: () => void }).detachEvent = () => {};
		act(() => {
			input?.dispatchEvent(new window.Event("focusin", { bubbles: true, cancelable: true }));
		});
		const fire = (init: { key: string; shiftKey?: boolean }) => {
			// linkedom has no KeyboardEvent constructor; synthesize one from the plain
			// Event installed as a global, the same escape hatch the existing chat
			// tests (e.g. PlanApprovalDialog.test.tsx's keydownOnDocument) use.
			const event = new window.Event("keydown", { bubbles: true, cancelable: true }) as Event & {
				key: string;
				shiftKey: boolean;
			};
			event.key = init.key;
			event.shiftKey = init.shiftKey ?? false;
			input?.dispatchEvent(event);
			return event;
		};
		let event: ReturnType<typeof fire> | undefined;
		act(() => {
			event = fire({ key: "Enter" });
		});
		expect(event?.defaultPrevented).toBe(true);
		expect(onOlder).toHaveBeenCalledTimes(1);
		act(() => {
			fire({ key: "Enter", shiftKey: true });
		});
		expect(onNewer).toHaveBeenCalledTimes(1);
		act(() => {
			event = fire({ key: "Escape" });
		});
		expect(event?.defaultPrevented).toBe(true);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("renders one tick per match and emphasizes the current one", async () => {
		container = await mount(
			<TranscriptFindTicks
				ticks={[
					{ ordinal: 0, fraction: 0.1 },
					{ ordinal: 1, fraction: 0.8 },
				]}
				currentOrdinal={1}
			/>,
		);
		const ticks = [...container.querySelectorAll("[data-find-tick]")];
		expect(ticks).toHaveLength(2);
		expect(ticks[1]?.getAttribute("data-find-tick-current")).toBe("true");
	});

	it("returns null from TranscriptFindTicks for an empty list", async () => {
		container = await mount(<TranscriptFindTicks ticks={[]} currentOrdinal={null} />);
		expect(container.querySelector("[data-find-tick]")).toBeNull();
	});
});
