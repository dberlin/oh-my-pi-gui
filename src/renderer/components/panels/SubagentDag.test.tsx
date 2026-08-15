import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentProgress, SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
import { buildSubagentList } from "./subagent-graph";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
// Deferred until the DOM globals exist: react-dom computes DOM support flags at evaluation time.

const { createRoot } = await import("react-dom/client");
const { SubagentDag } = await import("./SubagentDag");

const getSubagentMessages: Mock = vi.fn(async () => ({
	type: "response",
	command: "get_subagent_messages",
	success: true,
	data: { messages: [], nextByte: 0, hasMore: false },
}));
type OmpWindow = { omp: { rpc: { getSubagentMessages: Mock } } };
const ompWindow = window as unknown as OmpWindow;
ompWindow.omp = { rpc: { getSubagentMessages } };

function progress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "parent",
		agent: "scout",
		agentSource: "bundled",
		status: "running",
		task: "Map the graph",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: 20,
		cost: 0,
		durationMs: 61_000,
		...overrides,
	};
}

function snapshot(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return {
		id: "parent",
		index: 0,
		agent: "scout",
		status: "running",
		lastUpdate: Date.now(),
		kind: "sub",
		...overrides,
	};
}

const parent = snapshot({
	description: "Parent task",
	progress: progress({ description: "Analyzing graph" }),
});
const child = snapshot({
	id: "child",
	index: 1,
	agent: "reviewer",
	description: "Child task",
	status: "completed",
	parentSubagentId: "parent",
	progress: progress({
		id: "child",
		index: 1,
		agent: "reviewer",
		status: "completed",
		description: "Reviewed graph",
		durationMs: 65_000,
	}),
});
const parked = snapshot({
	id: "parked",
	index: 2,
	agent: "task",
	description: "Parked task",
	status: "parked",
	progress: progress({ id: "parked", index: 2, agent: "task", status: "running" }),
});

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

function graphNode(label: string): HTMLElement {
	const match = [...container.querySelectorAll<HTMLElement>('[role="treeitem"], button')].find(element =>
		element.textContent?.includes(label),
	);
	if (!match) throw new Error(`Missing graph node: ${label}`);
	return match;
}

async function dispatch(element: Element, type: string): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
	});
}

async function pressEnter(element: Element): Promise<void> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: "Enter" });
	await act(async () => {
		element.dispatchEvent(event);
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	getSubagentMessages.mockClear();
	useMessagesStore.getState().reset();
	useSubagentsStore.getState().reset();
});

describe("SubagentDag", () => {
	it("keeps the hierarchy, lifecycle metadata, timing, progress, and actions on graph nodes", async () => {
		useSubagentsStore.getState().setSnapshots([parent, child]);
		await mount(
			<SubagentDag onActivate={vi.fn()} onLifecycleAction={vi.fn()} viewedAgentId={null} working={false} />,
		);

		const mainNode = graphNode("main session");
		const parentNode = graphNode("Parent task");
		const childNode = graphNode("Child task");
		expect(container.querySelector('[role="tree"]')).not.toBeNull();
		expect(mainNode.getAttribute("aria-level")).toBe("1");
		expect(parentNode.getAttribute("aria-level")).toBe("2");
		expect(childNode.getAttribute("aria-level")).toBe("3");
		expect(parentNode.textContent).toContain("running");
		expect(parentNode.textContent).toContain("Analyzing graph");
		expect(childNode.textContent).toContain("completed");
		expect(childNode.textContent).toContain("1m 5s");
		expect(parentNode.querySelector('button[title="Abort this agent"]')).not.toBeNull();
	});

	it("selects locally, activates on double-click or Enter, marks the viewed target, and mounts no inspector", async () => {
		const activate = vi.fn();
		useSubagentsStore.getState().setSnapshots([parent, child]);
		await mount(
			<SubagentDag onActivate={activate} onLifecycleAction={vi.fn()} viewedAgentId="parent" working={false} />,
		);

		const parentNode = graphNode("Parent task");
		const childNode = graphNode("Child task");
		expect(parentNode.getAttribute("aria-current")).toBe("true");
		expect(parentNode.textContent).toContain("Viewing");

		await dispatch(childNode, "click");
		expect(childNode.getAttribute("aria-selected")).toBe("true");
		expect(activate).not.toHaveBeenCalled();
		expect(container.querySelector("[data-agent-view-id]")).toBeNull();

		await dispatch(childNode, "dblclick");
		expect(activate).toHaveBeenLastCalledWith(child);
		await pressEnter(parentNode);
		expect(activate).toHaveBeenLastCalledWith(parent);
	});

	it("keeps lifecycle actions isolated from selection and activation", async () => {
		const activate = vi.fn();
		const lifecycle = vi.fn();
		useSubagentsStore.getState().setSnapshots([parent, parked]);
		await mount(
			<SubagentDag onActivate={activate} onLifecycleAction={lifecycle} viewedAgentId={null} working={false} />,
		);

		const parentNode = graphNode("Parent task");
		const abort = parentNode.querySelector('button[title="Abort this agent"]');
		if (!abort) throw new Error("Missing graph abort action");
		await dispatch(abort, "click");
		await dispatch(abort, "dblclick");
		await pressEnter(abort);
		const parkedNode = graphNode("Parked task");
		const revive = parkedNode.querySelector('button[title="Revive this agent"]');
		if (!revive) throw new Error("Missing graph revive action");
		await dispatch(revive, "click");
		await dispatch(revive, "dblclick");
		await pressEnter(revive);

		expect(lifecycle).toHaveBeenCalledTimes(2);
		expect(lifecycle).toHaveBeenNthCalledWith(1, "abort", parent);
		expect(lifecycle).toHaveBeenNthCalledWith(2, "revive", parked);
		expect(parentNode.getAttribute("aria-selected")).toBe("false");
		expect(parkedNode.getAttribute("aria-selected")).toBe("false");
		expect(activate).not.toHaveBeenCalled();
	});

	it("clears inferred ownership across a session reset before ids are reused", () => {
		const sessionAParent = snapshot({ id: "reused-parent", description: "Session A parent" });
		useSubagentsStore.getState().setSnapshots([sessionAParent]);
		useSubagentsStore.getState().registerToolCallOwners(sessionAParent.id, ["provider-call:0"]);

		useSubagentsStore.getState().reset();

		const sessionBParent = snapshot({ id: "reused-parent", description: "Unrelated Session B parent" });
		const sessionBChild = snapshot({
			id: "session-b-child",
			index: 1,
			description: "Session B child",
			parentToolCallId: "provider-call:0",
		});
		useSubagentsStore.getState().setSnapshots([sessionBParent, sessionBChild]);
		const owners = useSubagentsStore.getState().toolCallOwners;
		const rows = buildSubagentList([sessionBParent, sessionBChild], new Set<string>(), owners);

		expect(owners.size).toBe(0);
		expect(rows.find(row => row.agent.id === sessionBChild.id)?.depth).toBe(0);
	});
});
