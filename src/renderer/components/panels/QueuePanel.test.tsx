/**
 * QueuePanel explicit reorder buttons (a11y counterpart of the drag handle):
 * ▲/▼ on a row calls queue_move with the adjacent target index; the buttons
 * are disabled at the lane edges (first ▲, last ▼) so the clamp UX is local,
 * and the store applies the reorder optimistically.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcQueuedMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { QueuePanel } from "./QueuePanel";

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
	disabled?: boolean;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let queueMove: Mock;
let queueRemove: Mock;
let queueClear: Mock;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function click(element: TestElement): Promise<void> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		element.dispatchEvent(event);
	});
	await flush();
}

function buttonsByLabel(label: string): TestElement[] {
	return Array.from(document.querySelectorAll(`button[aria-label="${label}"]`)) as unknown as TestElement[];
}

function queued(id: string, text: string): RpcQueuedMessage {
	return { id, text, timestamp: 1 };
}

async function mount(steering: RpcQueuedMessage[]): Promise<void> {
	queueMove = vi.fn(async () => ok({ lane: "steering", index: 0 }));
	queueRemove = vi.fn(async () => ok({ removed: true }));
	queueClear = vi.fn(async () => ok({ removed: 0 }));
	(window as unknown as Record<string, unknown>).omp = {
		rpc: {
			// The mount-time hydrate pull replaces the store, so it must serve
			// the same rows the test seeded.
			getQueue: vi.fn(async () => ok({ steering, followUp: [] })),
			queueMove,
			queueRemove,
			queueClear,
		},
	};
	useSessionStore.setState({ status: "ready" });
	useQueueStore.getState().setFromFrame({ steering, followUp: [] });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<QueuePanel />
			</I18nProvider>,
		);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("QueuePanel move buttons", () => {
	it("▼ on a middle row calls queue_move with the next index and reorders optimistically", async () => {
		await mount([queued("s1", "one"), queued("s2", "two"), queued("s3", "three")]);
		const downButtons = buttonsByLabel("Move down");
		expect(downButtons).toHaveLength(3);

		await click(downButtons[1]!);

		expect(queueMove).toHaveBeenCalledWith("s2", 2);
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1", "s3", "s2"]);
	});

	it("▲ on a middle row calls queue_move with the previous index", async () => {
		await mount([queued("s1", "one"), queued("s2", "two"), queued("s3", "three")]);

		await click(buttonsByLabel("Move up")[2]!);

		expect(queueMove).toHaveBeenCalledWith("s3", 1);
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1", "s3", "s2"]);
	});

	it("clamped edges: first ▲ and last ▼ are disabled and never call queue_move", async () => {
		await mount([queued("s1", "one"), queued("s2", "two"), queued("s3", "three")]);
		const upButtons = buttonsByLabel("Move up");
		const downButtons = buttonsByLabel("Move down");

		expect(upButtons[0]!.disabled).toBe(true);
		expect(downButtons[2]!.disabled).toBe(true);
		expect(upButtons[0]!.disabled === true && downButtons[1]!.disabled === false).toBe(true);

		await click(upButtons[0]!);
		await click(downButtons[2]!);

		expect(queueMove).not.toHaveBeenCalled();
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1", "s2", "s3"]);
	});

	it("⇄ on a steering row moves it to the end of the follow-up lane via queue_move with toLane", async () => {
		await mount([queued("s1", "one"), queued("s2", "two")]);
		// Seed a non-empty target lane after mount's hydrate pull consumed the mock.
		await act(async () => {
			useQueueStore.getState().setFromFrame({
				steering: useQueueStore.getState().steering,
				followUp: [queued("f1", "queued one")],
			});
		});
		await flush();

		const switchButtons = buttonsByLabel("Move to Queued");
		expect(switchButtons).toHaveLength(2);
		await click(switchButtons[0]!);

		expect(queueMove).toHaveBeenCalledWith("s1", Number.MAX_SAFE_INTEGER, "followUp");
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s2"]);
		expect(useQueueStore.getState().followUp.map(entry => entry.id)).toEqual(["f1", "s1"]);
	});
});
