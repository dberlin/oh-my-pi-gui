import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentProgress, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { beginTabRoute, resetTabRoute, settleTabRoute } from "../../../lib/tab-routing";
import { useAgentViewStore } from "../../../stores/agent-view";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

let activeElement: HTMLElement | null = null;
Object.defineProperty(document, "activeElement", {
	configurable: true,
	get: () => activeElement,
});
Object.defineProperty(HTMLElement.prototype, "tabIndex", {
	configurable: true,
	get(this: HTMLElement) {
		return Number(this.getAttribute("tabindex") ?? -1);
	},
	set(this: HTMLElement, value: number) {
		this.setAttribute("tabindex", String(value));
	},
});
HTMLElement.prototype.focus = function focusElement(this: HTMLElement) {
	const previous = activeElement;
	if (previous === this) return;
	if (previous) {
		const focusOut = new Event("focusout", { bubbles: true });
		Object.defineProperty(focusOut, "relatedTarget", { value: this });
		previous.dispatchEvent(focusOut);
	}
	activeElement = this;
	const focusIn = new Event("focusin", { bubbles: true });
	Object.defineProperty(focusIn, "relatedTarget", { value: previous });
	this.dispatchEvent(focusIn);
};

const { createRoot } = await import("react-dom/client");
const { AgentTree } = await import("./AgentTree");

const getSubagents: Mock = vi.fn(async () => ({
	type: "response",
	command: "get_subagents",
	success: true,
	data: { subagents: [] },
}));
const getSubagentMessages: Mock = vi.fn(async () => ({
	type: "response",
	command: "get_subagent_messages",
	success: true,
	data: { messages: [], nextByte: 0, hasMore: false },
}));
const abortSubagent: Mock = vi.fn(async () => ({
	type: "response",
	command: "abort_subagent",
	success: true,
	data: { ok: true },
}));
const reviveSubagent: Mock = vi.fn(async () => ({
	type: "response",
	command: "revive_subagent",
	success: true,
	data: { ok: true },
}));

const ompWindow = window as unknown as {
	omp: {
		rpc: {
			getSubagents: Mock;
			getSubagentMessages: Mock;
			abortSubagent: Mock;
			reviveSubagent: Mock;
		};
	};
};
ompWindow.omp = { rpc: { getSubagents, getSubagentMessages, abortSubagent, reviveSubagent } };

function progress(durationMs: number): AgentProgress {
	return {
		index: 0,
		id: "agent-1",
		agent: "scout",
		agentSource: "bundled",
		status: "running",
		task: "Audit renderer",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs,
	};
}

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 0, agent: "scout", status: "running", lastUpdate: Date.now(), ...overrides };
}

let container: HTMLElement | undefined;
let root: Root | undefined;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

function treeRows(): HTMLElement[] {
	return [...(container?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
}

function row(label: string): HTMLElement {
	const match = treeRows().find(item => item.textContent?.includes(label));
	if (!match) throw new Error(`Missing agent row: ${label}`);
	return match;
}

async function click(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
}

async function doubleClick(element: Element): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("dblclick", { bubbles: true, cancelable: true }));
	});
	await flush();
}

async function keyDown(element: Element, key: string): Promise<void> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: key });
	await act(async () => {
		element.dispatchEvent(event);
	});
	await flush();
}

async function focus(element: HTMLElement): Promise<void> {
	await act(async () => {
		element.focus();
	});
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
	}
	container?.remove();
	container = undefined;
	activeElement = null;
	root = undefined;
	getSubagents.mockReset();
	getSubagents.mockResolvedValue({
		type: "response",
		command: "get_subagents",
		success: true,
		data: { subagents: [] },
	});
	getSubagentMessages.mockClear();
	abortSubagent.mockClear();
	reviveSubagent.mockClear();
	useAgentViewStore.getState().reset();
	useSubagentsStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	resetTabRoute();
});

describe("AgentTree", () => {
	it("renders Main and the approved empty copy when no subagent exists", async () => {
		await mount(<AgentTree />);
		const rows = treeRows();
		expect(container?.querySelector('[role="tree"]')).not.toBeNull();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.textContent).toContain("Main");
		expect(container?.textContent).toContain("No subagents");
	});

	it("renders the complete hierarchy without a summary cutoff or graph controls", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots(
				Array.from({ length: 12 }, (_, index) => snap({ id: `a${index}`, index, agent: `agent-${index}` })),
			);
		await mount(<AgentTree />);
		expect(treeRows()).toHaveLength(13);
		expect([...container!.querySelectorAll("button")].some(button => /graph/i.test(button.textContent ?? ""))).toBe(
			false,
		);
		expect(container?.textContent?.toLowerCase()).not.toContain("view all");
	});

	it("activates subagent and Main transcripts on a single row click", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "child", agent: "child" })]);
		await mount(<AgentTree />);

		await click(row("child"));
		expect(getSubagentMessages).toHaveBeenCalledWith("child", undefined, 0);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "child" });

		await click(row("Main"));
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
	});

	it("uses Space to select a row without activating its transcript", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "child", agent: "child" })]);
		await mount(<AgentTree />);
		const child = row("child");
		expect(child.getAttribute("aria-selected")).toBe("false");
		await keyDown(child, " ");
		expect(child.getAttribute("aria-selected")).toBe("true");
		expect(getSubagentMessages).not.toHaveBeenCalled();
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
	});

	it("retains focused row identity across refresh and falls back focus to Main when it disappears", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "child", agent: "child" })]);
		await mount(<AgentTree />);
		await focus(row("child"));
		await act(async () => {
			useSubagentsStore.getState().setSnapshots([snap({ id: "child", agent: "child", status: "completed" })]);
		});
		expect(document.activeElement?.textContent).toContain("child");

		await act(async () => {
			useSubagentsStore.getState().setSnapshots([]);
		});
		expect(document.activeElement?.textContent).toContain("Main");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
	});

	it("retains manual row selection across roster refreshes", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "child", agent: "child" })]);
		await mount(<AgentTree />);
		await keyDown(row("child"), " ");
		expect(row("child").getAttribute("aria-selected")).toBe("true");
		await act(async () => {
			useSubagentsStore.getState().setSnapshots([snap({ id: "child", agent: "child", status: "completed" })]);
		});
		expect(row("child").getAttribute("aria-selected")).toBe("true");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
	});

	it("retains a collapsed branch across refresh when it contains the active transcript", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "parent", index: 0, agent: "parent" }),
				snap({ id: "child", index: 1, agent: "child", parentSubagentId: "parent" }),
			]);
		await mount(<AgentTree />);
		await click(row("child"));
		await focus(row("parent"));
		await keyDown(row("parent"), "ArrowLeft");
		expect(row("parent").getAttribute("aria-expanded")).toBe("false");
		await act(async () => {
			useSubagentsStore
				.getState()
				.setSnapshots([
					snap({ id: "parent", index: 0, agent: "parent", status: "completed" }),
					snap({ id: "child", index: 1, agent: "child", parentSubagentId: "parent", status: "completed" }),
				]);
		});
		expect(row("parent").getAttribute("aria-expanded")).toBe("false");
		expect(treeRows().some(item => item.textContent?.includes("child"))).toBe(false);
	});

	it("resets local tree state when a new tab and session reuse agent ids", async () => {
		useTabsStore.setState({ activeTabId: "tab-a" });
		useSessionStore.setState({ sessionId: "session-a", sessionFile: "/tmp/session-a.jsonl" });
		const snapshots = [
			snap({ id: "parent", index: 0, agent: "parent" }),
			snap({ id: "child", index: 1, agent: "child", parentSubagentId: "parent" }),
			snap({ id: "sibling", index: 2, agent: "sibling" }),
		];
		useSubagentsStore.getState().setSnapshots(snapshots);
		await mount(<AgentTree />);
		await click(row("child"));
		await focus(row("parent"));
		await keyDown(row("parent"), "ArrowLeft");
		await keyDown(row("sibling"), " ");
		expect(row("parent").getAttribute("aria-expanded")).toBe("false");
		expect(row("sibling").getAttribute("aria-selected")).toBe("true");

		await act(async () => {
			useTabsStore.setState({ activeTabId: "tab-b" });
			useSessionStore.setState({ sessionId: "session-b", sessionFile: "/tmp/session-b.jsonl" });
			useSubagentsStore.getState().setSnapshots(snapshots.map(agent => ({ ...agent, lastUpdate: Date.now() })));
		});

		expect(row("parent").getAttribute("aria-expanded")).toBe("true");
		expect(row("child").getAttribute("aria-selected")).toBe("true");
		expect(row("child").tabIndex).toBe(0);
		expect(row("sibling").getAttribute("aria-selected")).toBe("false");
	});

	it("uses one roving tab stop and visible-row keyboard navigation", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "parent", index: 0, agent: "parent" }),
				snap({ id: "child", index: 1, agent: "child", parentSubagentId: "parent" }),
			]);
		await mount(<AgentTree />);
		const rows = treeRows();
		expect(rows.filter(item => item.tabIndex === 0)).toHaveLength(1);
		await focus(rows[0]!);
		await keyDown(rows[0]!, "End");
		expect(document.activeElement?.textContent).toContain("child");
		await keyDown(document.activeElement as unknown as Element, "Home");
		expect(document.activeElement?.textContent).toContain("Main");
		await keyDown(document.activeElement as unknown as Element, "ArrowDown");
		expect(document.activeElement?.textContent).toContain("parent");
		await keyDown(document.activeElement as unknown as Element, "ArrowUp");
		expect(document.activeElement?.textContent).toContain("Main");
	});

	it("repairs the roving tab stop without stealing focus after the tree loses focus", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "child", agent: "child" })]);
		await mount(<AgentTree />);
		await focus(row("child"));
		const outside = document.createElement("button") as unknown as HTMLElement;
		document.body.appendChild(outside as never);
		await focus(outside);
		await act(async () => {
			useSubagentsStore.getState().setSnapshots([]);
		});
		expect(document.activeElement).toBe(outside);
		expect(row("Main").tabIndex).toBe(0);
		outside.remove();
	});

	it("collapses branches and uses Right and Left for child and parent navigation", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "parent", index: 0, agent: "parent" }),
				snap({ id: "child", index: 1, agent: "child", parentSubagentId: "parent" }),
				snap({ id: "sibling", index: 2, agent: "sibling" }),
			]);
		await mount(<AgentTree />);
		const parent = row("parent");
		await focus(parent);
		expect(parent.getAttribute("aria-expanded")).toBe("true");
		await keyDown(parent, "ArrowLeft");
		expect(row("parent").getAttribute("aria-expanded")).toBe("false");
		expect(treeRows().some(item => item.textContent?.includes("child"))).toBe(false);
		await keyDown(row("parent"), "ArrowRight");
		expect(row("parent").getAttribute("aria-expanded")).toBe("true");
		await keyDown(row("parent"), "ArrowRight");
		expect(document.activeElement?.textContent).toContain("child");
		await keyDown(document.activeElement as unknown as Element, "ArrowLeft");
		expect(document.activeElement?.textContent).toContain("parent");
	});

	it("keeps lifecycle actions isolated from row selection and activation", async () => {
		const snapshots = [
			snap({ id: "running", index: 0, agent: "running-agent", status: "running" }),
			snap({ id: "parked", index: 1, agent: "parked-agent", status: "parked" }),
		];
		useSubagentsStore.getState().setSnapshots(snapshots);
		getSubagents.mockResolvedValue({
			type: "response",
			command: "get_subagents",
			success: true,
			data: { subagents: snapshots },
		});
		await mount(<AgentTree />);
		const abort = container?.querySelector('button[title="Abort this agent"]');
		if (!abort) throw new Error("Missing abort action");
		await doubleClick(abort);
		await keyDown(abort, " ");
		expect(row("running-agent").getAttribute("aria-selected")).toBe("false");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		await click(abort);
		await flush();
		expect(abortSubagent).toHaveBeenCalledWith("running");
		expect(row("running-agent").getAttribute("aria-selected")).toBe("false");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });

		const revive = container?.querySelector('button[title="Revive this agent"]');
		if (!revive) throw new Error("Missing revive action");
		await keyDown(revive, "Enter");
		expect(reviveSubagent).not.toHaveBeenCalled();
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		await click(revive);
		await flush();
		expect(reviveSubagent).toHaveBeenCalledWith("parked");
	});

	it("does not move focus from a lifecycle button to its owning row during refresh", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "running", agent: "running-agent" })]);
		await mount(<AgentTree />);
		await focus(row("running-agent"));
		const abort = container?.querySelector<HTMLElement>('button[title="Abort this agent"]');
		if (!abort) throw new Error("Missing abort action");
		await focus(abort);
		await act(async () => {
			useSubagentsStore
				.getState()
				.setSnapshots([snap({ id: "running", agent: "running-agent", lastUpdate: Date.now() + 1 })]);
		});
		expect(document.activeElement).toBe(abort);
	});

	it("guards activation until the incoming tab route is ready", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "route-agent", agent: "route-agent" })]);
		await mount(<AgentTree />);
		await act(async () => beginTabRoute("outgoing-tab", "incoming-tab"));
		await click(row("route-agent"));
		expect(getSubagentMessages).not.toHaveBeenCalled();
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });

		await act(async () => settleTabRoute("incoming-tab"));
		await click(row("route-agent"));
		expect(getSubagentMessages).toHaveBeenCalledWith("route-agent", undefined, 0);
	});

	it("guards lifecycle actions until the incoming tab route is ready", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "route-agent", agent: "route-agent", status: "running" })]);
		await mount(<AgentTree />);
		await act(async () => beginTabRoute("outgoing-tab", "incoming-tab"));
		const abort = container?.querySelector<HTMLButtonElement>('button[title="Abort this agent"]');
		if (!abort) throw new Error("Missing abort action");
		expect(abort.disabled).toBe(true);
		await click(abort);
		expect(abortSubagent).not.toHaveBeenCalled();

		await act(async () => settleTabRoute("incoming-tab"));
		expect(abort.disabled).toBe(false);
		await click(abort);
		await flush();
		expect(abortSubagent).toHaveBeenCalledWith("route-agent");
	});

	it("polls only while the session is streaming", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "running" })]);
		await mount(<AgentTree pollMs={20} />);
		await act(async () => {
			await sleep(30);
		});
		expect(getSubagents).not.toHaveBeenCalled();
		await act(async () => {
			useSessionStore.setState({ isStreaming: true });
			await sleep(55);
		});
		expect(getSubagents.mock.calls.length).toBeGreaterThanOrEqual(1);
		await act(async () => {
			useSessionStore.setState({ isStreaming: false });
		});
		const callsAtStop = getSubagents.mock.calls.length;
		await act(async () => {
			await sleep(55);
		});
		expect(getSubagents).toHaveBeenCalledTimes(callsAtStop);
	});

	it("synchronizes selection and viewing state with an externally activated target", async () => {
		const child = snap({ id: "child", agent: "child" });
		useSubagentsStore.getState().setSnapshots([child]);
		await mount(<AgentTree />);
		await act(async () => {
			await useAgentViewStore.getState().selectSubagent(child);
		});
		expect(row("child").getAttribute("aria-selected")).toBe("true");
		expect(row("child").getAttribute("aria-current")).toBe("true");
		expect(row("Main").getAttribute("aria-current")).toBeNull();
	});

	it("derives explicit and tool-call fallback ancestry with correct aria levels", async () => {
		useSubagentsStore.getState().registerToolCallOwners("fallback-parent", ["spawn-child"]);
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "explicit-parent", index: 0, agent: "explicit-parent" }),
				snap({ id: "explicit-child", index: 1, agent: "explicit-child", parentSubagentId: "explicit-parent" }),
				snap({ id: "fallback-parent", index: 2, agent: "fallback-parent" }),
				snap({ id: "fallback-child", index: 3, agent: "fallback-child", parentToolCallId: "spawn-child" }),
			]);
		await mount(<AgentTree />);
		expect(row("Main").getAttribute("aria-level")).toBe("1");
		expect(row("explicit-parent").getAttribute("aria-level")).toBe("2");
		expect(row("explicit-child").getAttribute("aria-level")).toBe("3");
		expect(row("fallback-parent").getAttribute("aria-level")).toBe("2");
		expect(row("fallback-child").getAttribute("aria-level")).toBe("3");
	});

	it("keeps historical terminal and parked agents navigable", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "completed", index: 0, agent: "completed-agent", status: "completed" }),
				snap({ id: "failed", index: 1, agent: "failed-agent", status: "failed" }),
				snap({ id: "aborted", index: 2, agent: "aborted-agent", status: "aborted" }),
				snap({ id: "parked", index: 3, agent: "parked-agent", status: "parked" }),
			]);
		await mount(<AgentTree />);
		for (const [label, id] of [
			["completed-agent", "completed"],
			["failed-agent", "failed"],
			["aborted-agent", "aborted"],
			["parked-agent", "parked"],
		] as const) {
			await click(row(label));
			expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id });
		}
	});

	it("updates elapsed time for live agents and freezes terminal duration samples", async () => {
		const now = Date.now();
		useSubagentsStore.getState().setSnapshots([
			snap({
				id: "live",
				index: 0,
				agent: "live-agent",
				lastUpdate: now,
				progress: { ...progress(1_000), id: "live" },
			}),
			snap({
				id: "done",
				index: 1,
				agent: "done-agent",
				status: "completed",
				lastUpdate: now,
				progress: { ...progress(4_000), id: "done", status: "completed" },
			}),
		]);
		await mount(<AgentTree />);
		expect(row("live-agent").textContent).toContain("1s");
		expect(row("done-agent").textContent).toContain("4s");
		await act(async () => {
			await sleep(1_050);
		});
		expect(row("live-agent").textContent).toContain("2s");
		expect(row("done-agent").textContent).toContain("4s");
	});
});
