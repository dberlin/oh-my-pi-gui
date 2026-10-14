import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BtwHistoryRecord } from "../../../../../coding-agent/src/modes/rpc/wire/rpc-wire.generated";
import type { RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { createTabRuntime } from "../../stores/tab-runtime";
import {
	deleteSessionRuntime,
	SessionRuntimeProvider,
	type SessionRuntime,
} from "../../stores/session-runtime-context";
import { useUiStore } from "../../stores/ui";
import { BtwDialog } from "./BtwDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
type Frame = { type: "btw_delta"; recordId: string; delta: string } | { type: "btw_record"; record: BtwHistoryRecord };
const listeners = new Set<(frame: Frame, tabId: string) => void>();
const commands: RpcCommand[] = [];
const response = vi.fn<(command: RpcCommand) => Promise<RpcResponse>>();
let root: Root;
let container: HTMLElement;
let runtime: SessionRuntime;
function record(patch: Partial<BtwHistoryRecord> = {}): BtwHistoryRecord {
	return {
		id: "topic-a",
		leafId: "leaf-a",
		question: "Explain",
		answer: "",
		status: "running",
		createdAt: 1,
		updatedAt: 1,
		...patch,
	};
}
function success(data: unknown): RpcResponse {
	return { type: "response", command: "btw", success: true, data };
}
function button(text: string): HTMLButtonElement {
	const found = Array.from(document.querySelectorAll("button")).find(node => node.textContent?.includes(text));
	expect(found).toBeDefined();
	return found as unknown as HTMLButtonElement;
}
async function click(text: string): Promise<void> {
	await act(async () => {
		button(text).dispatchEvent(new Event("click", { bubbles: true }));
	});
}
async function emit(frame: Frame, tabId = "btw-origin"): Promise<void> {
	await act(async () => {
		for (const listener of listeners) listener(frame, tabId);
	});
}
async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<SessionRuntimeProvider runtime={runtime}>
				<I18nProvider>
					<BtwDialog />
				</I18nProvider>
			</SessionRuntimeProvider>,
		);
	});
}
beforeEach(() => {
	commands.length = 0;
	listeners.clear();
	response
		.mockReset()
		.mockImplementation(async command =>
			command.type === "btw_cancel" ? success({ cancelled: true }) : success({ record: record() }),
		);
	Object.assign(window, {
		omp: {
			rpc: {
				commandForTab: async (_tab: string, command: RpcCommand) => {
					commands.push(command);
					return response(command);
				},
			},
			events: {
				onTabBtwFrame: (listener: (frame: Frame, tabId: string) => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			},
		},
	});
	runtime = createTabRuntime("btw-origin");
	useUiStore.setState({ btwRequest: "Explain" });
});
afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	deleteSessionRuntime("btw-origin");
	useUiStore.getState().closeBtw();
});
describe("BtwDialog genuine vanilla frames", () => {
	it("continues the genuine follow-up after unsupported branching without retiring its origin", async () => {
		response.mockResolvedValueOnce(success({ record: record({ answer: "finished answer", status: "complete" }) }));
		response.mockResolvedValueOnce({
			type: "response",
			command: "btw_branch",
			success: false,
			code: "unsupported_capability",
			error: "Vanilla cannot promote a BTW answer",
		});
		response.mockResolvedValueOnce(
			success({
				record: record({
					answer: "finished answer",
					status: "complete",
					followUps: [{ question: "Explain", answer: "", status: "running", createdAt: 3, updatedAt: 3 }],
				}),
			}),
		);
		await mount();
		await click("Ask");
		await click("Branch");
		await click("Ask");
		expect(commands.filter(command => command.type === "btw")).toEqual([
			{ type: "btw", question: "Explain" },
			{ type: "btw", question: "Explain", recordId: "topic-a" },
		]);
		await emit({ type: "btw_delta", recordId: "topic-a", delta: "genuine follow-up answer" });
		expect(document.body.textContent).toContain("genuine follow-up answer");
		expect(document.body.textContent).not.toContain("finished answer");
	});
	it("renders sanitized formatted partial text, enables partial copy, and keeps branch disabled", async () => {
		await mount();
		await click("Ask");
		await emit({ type: "btw_delta", recordId: "topic-a", delta: "**partial answer**<script>danger()</script>" });
		expect(document.querySelector("strong")?.textContent).toBe("partial answer");
		expect(document.querySelector("script")).toBeNull();
		expect(button("Copy").disabled).toBe(false);
		expect(button("Branch").disabled).toBe(true);
	});
	it("keeps a cancelled partial answer visible and rejects later deltas and completed snapshots", async () => {
		await mount();
		await click("Ask");
		await emit({ type: "btw_delta", recordId: "topic-a", delta: "kept partial" });
		await click("Stop");
		expect(commands).toContainEqual({ type: "btw_cancel", recordId: "topic-a" });
		await emit({ type: "btw_record", record: record({ status: "cancelled", answer: "kept partial", updatedAt: 2 }) });
		await emit({ type: "btw_delta", recordId: "topic-a", delta: " leaked" });
		await emit({
			type: "btw_record",
			record: record({ status: "complete", answer: "late completion", updatedAt: 3 }),
		});
		expect(document.body.textContent).toContain("kept partial");
		expect(document.body.textContent).not.toContain("leaked");
		expect(document.body.textContent).not.toContain("late completion");
		expect(button("Branch").disabled).toBe(true);
	});
	it("shows only the latest follow-up and passes the topic id to its next question", async () => {
		response.mockResolvedValue(
			success({
				record: record({
					answer: "old answer",
					status: "complete",
					followUps: [
						{
							question: "latest question",
							answer: "latest answer",
							status: "complete",
							createdAt: 2,
							updatedAt: 3,
						},
					],
				}),
			}),
		);
		await mount();
		await click("Ask");
		expect(document.body.textContent).toContain("latest answer");
		expect(document.body.textContent).not.toContain("old answer");
		expect(button("Branch").disabled).toBe(false);
		await click("Ask");
		expect(commands.at(-1)).toEqual({ type: "btw", question: "Explain", recordId: "topic-a" });
	});
	it("ignores another tab and another topic even when their questions match", async () => {
		await mount();
		await click("Ask");
		await emit({ type: "btw_delta", recordId: "topic-a", delta: "foreign tab" }, "another-tab");
		await emit({ type: "btw_record", record: record({ id: "other-topic", answer: "foreign topic" }) });
		expect(document.body.textContent).not.toContain("foreign");
	});
	it("replays genuine frames that arrive before the start acknowledgement", async () => {
		const pending = Promise.withResolvers<RpcResponse>();
		response.mockReturnValueOnce(pending.promise);
		await mount();
		await click("Ask");
		await emit({ type: "btw_record", record: record() });
		await emit({ type: "btw_delta", recordId: "topic-a", delta: "early partial" });
		await act(async () => pending.resolve(success({ record: record() })));
		expect(document.body.textContent).toContain("early partial");
	});
	it("cancels a starting request when closing before its id is acknowledged", async () => {
		const pending = Promise.withResolvers<RpcResponse>();
		response.mockReturnValueOnce(pending.promise);
		await mount();
		await click("Ask");
		await act(async () => useUiStore.getState().closeBtw());
		expect(commands).toContainEqual({ type: "btw_cancel" });
		await act(async () => pending.resolve(success({ record: record() })));
		await emit({ type: "btw_delta", recordId: "topic-a", delta: "closed leak" });
		expect(document.body.textContent).not.toContain("closed leak");
	});
	it("ignores frames after the origin runtime generation changes", async () => {
		await mount();
		await click("Ask");
		response.mockResolvedValueOnce(success({}));
		await act(async () => {
			await runtime.command({ type: "new_session" });
		});
		await emit({ type: "btw_delta", recordId: "topic-a", delta: "replaced session leak" });
		expect(document.body.textContent).not.toContain("replaced session leak");
	});
	it("retains partial output beside a failed terminal turn", async () => {
		await mount();
		await click("Ask");
		await emit({
			type: "btw_record",
			record: record({ status: "error", answer: "useful partial", error: "provider unavailable", updatedAt: 2 }),
		});
		expect(document.body.textContent).toContain("useful partial");
		expect(document.body.textContent).toContain("provider unavailable");
		expect(button("Copy").disabled).toBe(false);
		expect(button("Branch").disabled).toBe(true);
	});
});
