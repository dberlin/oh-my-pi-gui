/**
 * AgentsDockCard: the center-dock roster. Renders nothing while the store is
 * empty, renders navigation rows for live and terminal agents, summarizes
 * large rosters, and polls get_subagents while a turn streams. Parked/idle
 * transitions emit no wire frame, so the store would otherwise go stale.
 */
import { parseHTML } from "linkedom";
import { ListTodo } from "lucide-react";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentProgress, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { resetTabRoute } from "../../../lib/tab-routing";
import { useAgentViewStore } from "../../../stores/agent-view";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { AgentsDockCard } = await import("./AgentsDockCard");
const { DockCard } = await import("./DockCard");
const { WorkspaceDockFocusProvider } = await import("./WorkspaceDockFocus");

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
// Window carries the omp bridge at runtime; named cast keeps the mock wiring typed.
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

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now(), ...overrides };
}

function progress(overrides: Partial<AgentProgress>): AgentProgress {
	return {
		index: 1,
		id: "a1",
		agent: "scout",
		agentSource: "bundled",
		status: "running",
		task: "audit",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: 12_345,
		cost: 0.4321,
		durationMs: 60_000,
		...overrides,
	};
}

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

function activateTab(): void {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	useSessionStore.setState({ sessionId: "s1" });
	resetTabRoute();
}

async function mount(element: ReactElement): Promise<void> {
	activateTab();
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	getSubagents.mockClear();
	getSubagentMessages.mockClear();
	abortSubagent.mockClear();
	reviveSubagent.mockClear();
	useAgentViewStore.getState().reset();
	useSubagentsStore.getState().reset();
	useSessionStore.setState({ isStreaming: false });
	useTabsStore.getState().reset();
	resetTabRoute();
	useUiStore.setState({ dockCollapsed: {}, dockFocus: null });
});

function containerText(): string {
	return container.textContent ?? "";
}

function row(label: string): HTMLElement {
	const match = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(item =>
		item.textContent?.includes(label),
	);
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

async function pressEnter(element: Element): Promise<void> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: "Enter" });
	await act(async () => {
		element.dispatchEvent(event);
	});
	await flush();
}

describe("AgentsDockCard", () => {
	it("renders nothing when the roster is empty", async () => {
		await mount(<AgentsDockCard />);
		expect(containerText()).toBe("");
	});

	it("lists every known agent with the live/total count badge", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "a1", status: "running" }),
				snap({ id: "a2", index: 2, status: "parked" }),
				snap({ id: "a3", index: 3, status: "parked" }),
				snap({ id: "a4", index: 4, status: "completed" }),
			]);
		await mount(<AgentsDockCard />);

		// Live = running + parked; the terminal completed row stays listed.
		expect(containerText()).toContain("3/4");
		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(4);
		expect(containerText()).toContain("scout");
	});

	it("shows each agent's resolved model, tokens, and cost", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([snap({ progress: progress({ resolvedModel: "openai-codex/gpt-5.6-sol:max" }) })]);
		await mount(<AgentsDockCard />);

		expect(containerText()).toContain("openai-codex/gpt-5.6-sol:max");
		expect(containerText()).toContain("12.3k tokens");
		expect(containerText()).toContain("$0.4321");
	});

	it("renders Main as the root before lifecycle rows without embedding a transcript", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "completed", index: 1, agent: "completed-agent", status: "completed" }),
				snap({ id: "failed", index: 2, agent: "failed-agent", status: "failed" }),
				snap({ id: "aborted", index: 3, agent: "aborted-agent", status: "aborted" }),
				snap({ id: "parked", index: 4, agent: "parked-agent", status: "parked" }),
			]);
		await mount(<AgentsDockCard />);

		const rows = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
		expect(rows).toHaveLength(5);
		expect(rows[0]?.textContent).toContain("Main");
		expect(rows[0]?.getAttribute("aria-level")).toBe("1");
		expect(rows.slice(1).every(item => item.getAttribute("aria-level") === "2")).toBe(true);

		await click(row("completed-agent"));
		expect(getSubagentMessages).not.toHaveBeenCalled();
		expect(container.querySelector("[data-agent-view-id]")).toBeNull();
	});

	it("keeps row selection separate from the viewed target and marks only the active view", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", agent: "selected-agent" })]);
		await mount(<AgentsDockCard />);

		const main = row("Main");
		const subagent = row("selected-agent");
		expect(main.textContent).toContain("Viewing");
		expect(main.getAttribute("aria-current")).toBe("true");

		await click(subagent);
		expect(subagent.getAttribute("aria-selected")).toBe("true");
		expect(main.getAttribute("aria-selected")).toBe("false");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(main.textContent).toContain("Viewing");
		expect(subagent.textContent).not.toContain("Viewing");

		await doubleClick(subagent);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "a1" });
		expect(subagent.getAttribute("aria-current")).toBe("true");
		expect(subagent.textContent).toContain("Viewing");
		expect(main.textContent).not.toContain("Viewing");

		await doubleClick(main);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(main.getAttribute("aria-current")).toBe("true");
	});

	it("routes graph activation and lifecycle actions through the same dock handlers as list rows", async () => {
		const graphSnapshot = snap({ id: "graph-agent", agent: "scout", description: "Graph agent" });
		useSubagentsStore.getState().setSnapshots([graphSnapshot]);
		getSubagents.mockResolvedValueOnce({
			type: "response",
			command: "get_subagents",
			success: true,
			data: { subagents: [graphSnapshot] },
		});
		await mount(<AgentsDockCard />);

		const graphToggle = [...container.querySelectorAll("button")].find(button =>
			button.textContent?.includes("Graph"),
		);
		if (!graphToggle) throw new Error("Missing graph toggle");
		await click(graphToggle);

		const main = row("main session");
		const subagent = row("Graph agent");
		expect(main.getAttribute("aria-current")).toBe("true");
		await click(subagent);
		expect(subagent.getAttribute("aria-selected")).toBe("true");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });

		await doubleClick(subagent);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "graph-agent" });
		expect(subagent.getAttribute("aria-current")).toBe("true");
		expect(subagent.textContent).toContain("Viewing");

		await pressEnter(main);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(main.getAttribute("aria-current")).toBe("true");

		const abort = subagent.querySelector('button[title="Abort this agent"]');
		if (!abort) throw new Error("Missing graph abort action");
		await click(abort);
		await flush();
		expect(abortSubagent).toHaveBeenCalledWith("graph-agent");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
	});

	it("makes every row keyboard reachable and activates the focused selection with Enter", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", agent: "keyboard-agent" })]);
		await mount(<AgentsDockCard />);

		const subagent = row("keyboard-agent");
		expect(subagent.getAttribute("tabindex")).toBe("0");
		await act(async () => subagent.dispatchEvent(new Event("focusin", { bubbles: true })));
		expect(subagent.getAttribute("aria-selected")).toBe("true");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });

		await pressEnter(subagent);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "a1" });
	});

	it("keeps terminal and parked rows navigable", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "completed", index: 1, agent: "completed-agent", status: "completed" }),
				snap({ id: "failed", index: 2, agent: "failed-agent", status: "failed" }),
				snap({ id: "aborted", index: 3, agent: "aborted-agent", status: "aborted" }),
				snap({ id: "parked", index: 4, agent: "parked-agent", status: "parked" }),
			]);
		await mount(<AgentsDockCard />);

		for (const [label, id] of [
			["completed-agent", "completed"],
			["failed-agent", "failed"],
			["aborted-agent", "aborted"],
			["parked-agent", "parked"],
		] as const) {
			await doubleClick(row(label));
			expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id });
		}
	});

	it("runs lifecycle actions without selecting or activating their rows", async () => {
		const snapshots = [
			snap({ id: "running", index: 1, agent: "running-agent", status: "running" }),
			snap({ id: "parked", index: 2, agent: "parked-agent", status: "parked" }),
		];
		useSubagentsStore.getState().setSnapshots(snapshots);
		const refreshResponse = {
			type: "response" as const,
			command: "get_subagents",
			success: true as const,
			data: { subagents: snapshots },
		};
		getSubagents.mockResolvedValueOnce(refreshResponse).mockResolvedValueOnce(refreshResponse);
		await mount(<AgentsDockCard />);

		const abortButton = container.querySelector('button[title="Abort this agent"]');
		if (!abortButton) throw new Error("Missing abort action");
		await click(abortButton);
		await flush();
		expect(abortSubagent).toHaveBeenCalledWith("running");
		expect(row("running-agent").getAttribute("aria-selected")).toBe("false");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });

		const reviveButton = container.querySelector('button[title="Revive this agent"]');
		if (!reviveButton) throw new Error("Missing revive action");
		await click(reviveButton);
		await flush();
		expect(reviveSubagent).toHaveBeenCalledWith("parked");
		expect(row("parked-agent").getAttribute("aria-selected")).toBe("false");
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
	});

	it("summarizes large rosters and leaves focus mode without collapsing after activation", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "a1", index: 1, agent: "agent-1", status: "running" }),
				snap({ id: "a2", index: 2, agent: "agent-2", status: "failed" }),
				snap({ id: "a3", index: 3, agent: "agent-3", status: "completed", lastUpdate: 3 }),
				snap({ id: "a4", index: 4, agent: "agent-4", status: "completed", lastUpdate: 4 }),
				snap({ id: "a5", index: 5, agent: "agent-5", status: "completed", lastUpdate: 5 }),
				snap({ id: "a6", index: 6, agent: "agent-6", status: "completed", lastUpdate: 6 }),
				snap({ id: "a7", index: 7, agent: "agent-7", status: "completed", lastUpdate: 7 }),
			]);
		await mount(
			<WorkspaceDockFocusProvider>
				<DockCard icon={ListTodo} id="todo" title="Todo">
					<div data-testid="other-card-body">other card body</div>
				</DockCard>
				<AgentsDockCard />
			</WorkspaceDockFocusProvider>,
		);

		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(6);
		expect(containerText()).toContain("2 more · View all 7 agents");
		expect(container.querySelector('[data-testid="other-card-body"]')).not.toBeNull();

		const viewAll = [...container.querySelectorAll("button")].find(button =>
			button.textContent?.includes("View all 7 agents"),
		);
		if (!viewAll) throw new Error("Missing view-all action");
		await click(viewAll);
		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(8);
		expect(containerText()).toContain("Back to summary");
		expect(containerText()).toContain("Todo");
		expect(container.querySelector('[data-testid="other-card-body"]')).toBeNull();

		await doubleClick(row("agent-3"));
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "a3" });
		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(6);
		expect(container.querySelector('[data-testid="other-card-body"]')).not.toBeNull();
		expect(useUiStore.getState().dockCollapsed.agents).not.toBe(true);
		expect(row("agent-3").getAttribute("aria-current")).toBe("true");
		expect(row("agent-3").textContent).toContain("Viewing");
	});

	it("retains fallback-resolved ancestors when an active child leaves focus mode", async () => {
		const parent = snap({
			id: "parent",
			index: 3,
			agent: "fallback-parent",
			status: "completed",
			lastUpdate: 1,
		});
		const child = snap({
			id: "child",
			index: 4,
			agent: "fallback-child",
			status: "completed",
			lastUpdate: 2,
			parentToolCallId: "spawn-child",
		});
		useSubagentsStore.getState().registerToolCallOwners(parent.id, ["spawn-child"]);
		useSubagentsStore
			.getState()
			.setSnapshots([
				snap({ id: "running", index: 1, agent: "running-root", status: "running" }),
				snap({ id: "failed", index: 2, agent: "failed-root", status: "failed" }),
				parent,
				child,
				snap({ id: "recent-1", index: 5, agent: "recent-1", status: "completed", lastUpdate: 30 }),
				snap({ id: "recent-2", index: 6, agent: "recent-2", status: "completed", lastUpdate: 31 }),
				snap({ id: "recent-3", index: 7, agent: "recent-3", status: "completed", lastUpdate: 32 }),
			]);
		await mount(
			<WorkspaceDockFocusProvider>
				<AgentsDockCard />
			</WorkspaceDockFocusProvider>,
		);

		expect(containerText()).not.toContain("fallback-parent");
		expect(containerText()).not.toContain("fallback-child");
		const viewAll = [...container.querySelectorAll("button")].find(button =>
			button.textContent?.includes("View all 7 agents"),
		);
		if (!viewAll) throw new Error("Missing view-all action");
		await click(viewAll);
		expect(row("fallback-parent").getAttribute("aria-level")).toBe("2");
		expect(row("fallback-child").getAttribute("aria-level")).toBe("3");

		await doubleClick(row("fallback-child"));
		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(6);
		expect(row("fallback-parent").getAttribute("aria-level")).toBe("2");
		expect(row("fallback-child").getAttribute("aria-level")).toBe("3");
		expect(row("fallback-child").textContent).toContain("Viewing");
	});

	it("collapses to the header via the ui store and re-expands on focusDockCard", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "running" })]);
		useUiStore.setState({ dockCollapsed: { agents: true } });
		await mount(<AgentsDockCard />);
		expect(container.querySelector('[role="tree"]')).toBeNull();

		await act(async () => {
			useUiStore.getState().focusDockCard("agents");
		});
		expect(useUiStore.getState().dockCollapsed.agents).toBe(false);
		expect(container.querySelector('[role="tree"]')).not.toBeNull();
	});

	it("polls get_subagents while streaming, stops when the turn ends", async () => {
		// Real timers + a short injected cadence: vi.useFakeTimers/advanceTimers
		// are vitest-only, and this file must also pass under `bun test`.
		const sleep = (ms: number) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		};
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "running" })]);
		activateTab();
		useSessionStore.setState({ isStreaming: true });
		container = document.createElement("div") as unknown as HTMLElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root.render(
				<I18nProvider>
					<AgentsDockCard pollMs={25} />
				</I18nProvider>,
			);
		});
		expect(getSubagents).not.toHaveBeenCalled();

		await act(async () => {
			await sleep(60);
		});
		expect(getSubagents.mock.calls.length).toBeGreaterThanOrEqual(1);

		// Turn ends → interval cleared, no further polls.
		await act(async () => {
			useSessionStore.setState({ isStreaming: false });
		});
		const callsAtStop = getSubagents.mock.calls.length;
		await act(async () => {
			await sleep(60);
		});
		expect(getSubagents.mock.calls.length).toBe(callsAtStop);
	});
});
