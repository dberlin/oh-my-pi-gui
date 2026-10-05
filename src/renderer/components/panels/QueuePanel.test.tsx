/** Canonical text queues and optional stable-ID extension controls. */
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
	value?: string;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let getQueue: Mock;
let queueMove: Mock;
let queueEdit: Mock;
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

function queued(id: string, text: string, editable = true): RpcQueuedMessage {
	return { id, text, editable, timestamp: 1 };
}

async function mount(steering: RpcQueuedMessage[]): Promise<void> {
	getQueue = vi.fn(async () => ok({ steering, followUp: [] }));
	queueMove = vi.fn(async () => ok({ lane: "steering", index: 0 }));
	queueEdit = vi.fn(async () => ok({ updated: true }));
	queueRemove = vi.fn(async () => ok({ removed: true }));
	queueClear = vi.fn(async () => ok({ removed: 0 }));
	(window as unknown as Record<string, unknown>).omp = {
		rpc: {
			// The mount-time hydrate pull replaces the store, so it must serve
			// the same rows the test seeded.
			getState: async () => ok({}),
			getQueue,
			queueEdit,
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

async function mountVanilla(steering: string[], followUp: string[] = []) {
	await mount([]);
	let snapshot = { steering, followUp };
	const commands: object[] = [];
	// The test installed this minimal preload bridge in mount().
	const bridge = window as unknown as { omp: { rpc: Record<string, unknown> } };
	const rpc = bridge.omp.rpc;
	rpc.command = async (command: { type: string; message?: string; queue?: "steering" | "followUp" }) => {
		commands.push(command);
		if (command.type === "get_state") return ok({ queuedMessages: snapshot });
		const lane = command.type === "promote_queued_message" ? "followUp" : command.queue;
		if (!lane) throw new Error("Unexpected queue command");
		const index = snapshot[lane].indexOf(command.message ?? "");
		const changed = index >= 0;
		if (changed) {
			const remaining = snapshot[lane].filter((_text, position) => position !== index);
			snapshot =
				command.type === "promote_queued_message"
					? { steering: [...snapshot.steering, command.message!], followUp: remaining }
					: { ...snapshot, [lane]: remaining };
			useQueueStore.getState().setFromFrame(snapshot);
		}
		return ok(command.type === "promote_queued_message" ? { promoted: changed } : { removed: changed });
	};
	await act(async () => useQueueStore.getState().setFromFrame(snapshot));
	await flush();
	return { commands, rpc };
}

describe("QueuePanel vanilla queues", () => {
	it("displays exact text and disables unsupported ID-only controls", async () => {
		const { commands } = await mountVanilla(["first", "second"], ["later"]);
		expect(container.textContent).toContain("first");
		expect(container.textContent).toContain("second");
		expect(container.textContent).toContain("later");
		expect(buttonsByLabel("Edit")).toHaveLength(0);
		for (const label of ["Move up", "Move down", "Clear", "Move to Queued", "Drag to reorder"]) {
			const buttons = buttonsByLabel(label);
			expect(buttons.length).toBeGreaterThan(0);
			for (const button of buttons) {
				expect(button.disabled).toBe(true);
				await click(button);
			}
		}
		expect(commands).toEqual([]);
	});

	it("removes one duplicate by exact text rather than a client display key", async () => {
		const { commands } = await mountVanilla([], ["same", "middle", "same"]);
		await click(buttonsByLabel("Remove")[2]!);
		expect(commands[0]).toEqual({ type: "remove_queued_message", message: "same", queue: "followUp" });
		expect(useQueueStore.getState().followUp.map(entry => entry.text)).toEqual(["middle", "same"]);
	});

	it("promotes only the first matching follow-up to the end of steering", async () => {
		const { commands } = await mountVanilla(["existing"], ["same", "middle", "same"]);
		await click(buttonsByLabel("Move to Steering")[2]!);
		expect(commands[0]).toEqual({ type: "promote_queued_message", message: "same" });
		expect(useQueueStore.getState().steering.map(entry => entry.text)).toEqual(["existing", "same"]);
		expect(useQueueStore.getState().followUp.map(entry => entry.text)).toEqual(["middle", "same"]);
	});

	it("does not remove a guessed duplicate while a text command is pending or merely acknowledged", async () => {
		const { rpc } = await mountVanilla([], ["same", "middle", "same"]);
		const pending = Promise.withResolvers<{
			type: "response";
			command: string;
			success: true;
			data: { removed: boolean };
		}>();
		rpc.command = async (command: { type: string }) => {
			if (command.type === "get_state")
				return ok({ queuedMessages: { steering: [], followUp: ["same", "middle", "same"] } });
			return pending.promise;
		};
		await click(buttonsByLabel("Remove")[2]!);
		expect(useQueueStore.getState().followUp.map(entry => entry.text)).toEqual(["same", "middle", "same"]);
		await act(async () =>
			pending.resolve({
				type: "response",
				command: "remove_queued_message",
				success: true,
				data: { removed: true },
			}),
		);
		await flush();
		expect(useQueueStore.getState().followUp.map(entry => entry.text)).toEqual(["same", "middle", "same"]);
		await act(async () => useQueueStore.getState().setFromFrame({ steering: [], followUp: ["middle", "same"] }));
		expect(useQueueStore.getState().followUp.map(entry => entry.text)).toEqual(["middle", "same"]);
	});

	it("does not fake a removal when upstream reports the text already delivered", async () => {
		const { rpc } = await mountVanilla(["claimed"]);
		rpc.command = async (command: { type: string }) =>
			command.type === "get_state"
				? ok({ queuedMessages: { steering: ["claimed"], followUp: [] } })
				: ok({ removed: false });
		await click(buttonsByLabel("Remove")[0]!);
		expect(useQueueStore.getState().steering.map(entry => entry.text)).toEqual(["claimed"]);
	});

	it("keeps the authoritative queue when a text removal rejects", async () => {
		const { rpc } = await mountVanilla([], ["keep"]);
		rpc.command = async (command: { type: string }) => {
			if (command.type === "get_state") return ok({ queuedMessages: { steering: [], followUp: ["keep"] } });
			throw new Error("Disconnected");
		};
		await click(buttonsByLabel("Remove")[0]!);
		expect(useQueueStore.getState().followUp.map(entry => entry.text)).toEqual(["keep"]);
	});
});

describe("QueuePanel editing", () => {
	it("edits a plain queued message in place", async () => {
		await mount([queued("s1", "before"), queued("s2", "untouched")]);
		await click(buttonsByLabel("Edit")[0]!);
		const editor = document.querySelector('textarea[aria-label="Queued message text"]') as unknown as TestElement;
		editor.value = "after";
		await act(async () => {
			editor.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
		});
		await click(buttonsByLabel("Save")[0]!);

		expect(queueEdit).toHaveBeenCalledWith("s1", "after");
		expect(useQueueStore.getState().steering.map(entry => entry.text)).toEqual(["after", "untouched"]);
	});

	it("rolls back an optimistic edit when the transport rejects", async () => {
		await mount([queued("s1", "before")]);
		queueEdit.mockRejectedValueOnce(new Error("sidecar unavailable"));
		await click(buttonsByLabel("Edit")[0]!);
		const editor = document.querySelector('textarea[aria-label="Queued message text"]') as unknown as TestElement;
		editor.value = "after";
		await act(async () => {
			editor.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
		});
		await click(buttonsByLabel("Save")[0]!);

		expect(useQueueStore.getState().steering.map(entry => entry.text)).toEqual(["before"]);
	});

	it("does not offer text editing for structured queued commands", async () => {
		await mount([queued("s1", "/skill run", false)]);
		expect(buttonsByLabel("Edit")).toHaveLength(0);
	});
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

	it("unwinds overlapping optimistic moves when transport and refresh reject", async () => {
		await mount([queued("s1", "one"), queued("s2", "two"), queued("s3", "three")]);
		getQueue.mockRejectedValue(new Error("sidecar unavailable"));
		const first = Promise.withResolvers<never>();
		const second = Promise.withResolvers<never>();
		queueMove.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		await click(buttonsByLabel("Move down")[0]!);
		await click(buttonsByLabel("Move down")[1]!);
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s2", "s3", "s1"]);

		await act(async () => {
			first.reject(new Error("sidecar unavailable"));
			await Promise.resolve();
		});
		await flush();
		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s2", "s3", "s1"]);

		await act(async () => {
			second.reject(new Error("sidecar unavailable"));
			await Promise.resolve();
		});
		await flush();
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

	it("rolls back an optimistic cross-lane move when the transport rejects", async () => {
		await mount([queued("s1", "one"), queued("s2", "two")]);
		queueMove.mockRejectedValueOnce(new Error("sidecar unavailable"));

		await click(buttonsByLabel("Move to Queued")[0]!);

		expect(useQueueStore.getState().steering.map(entry => entry.id)).toEqual(["s1", "s2"]);
		expect(useQueueStore.getState().followUp).toEqual([]);
	});
});
