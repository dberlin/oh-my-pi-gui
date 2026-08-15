/**
 * AgentHubWindow keeps definitions and lifecycle controls in the Hub while
 * transcript actions navigate the main canvas to the selected roster snapshot.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentProgress, SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useAgentViewStore } from "../../stores/agent-view";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
(window as unknown as Record<string, unknown>).setTimeout = setTimeout;
(window as unknown as Record<string, unknown>).clearTimeout = clearTimeout;

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { AgentHubWindow } = await import("./AgentHubWindow");

type RpcResult = { type: "response"; command: string; success: boolean; data?: unknown; error?: string };

function ok(data: unknown): RpcResult {
	return { type: "response", command: "x", success: true, data };
}

interface OmpMock {
	getSettings: Mock;
	getAgentDefinitions: Mock;
	setSetting: Mock;
	getSubagents: Mock;
	getSubagentMessages: Mock;
	abortSubagent: Mock;
	reviveSubagent: Mock;
	abort: Mock;
}

function installOmpMock(overrides: Partial<OmpMock> = {}): OmpMock {
	const mock: OmpMock = {
		getSettings: vi.fn(async () =>
			ok({
				values: {
					"task.disabledAgents": [],
					"task.agentModelOverrides": {},
					"task.agentPrewalk": {},
				},
			}),
		),
		getAgentDefinitions: vi.fn(async () =>
			ok({ agents: [{ name: "scout", description: "Scout the repository", source: "bundled" }] }),
		),
		setSetting: vi.fn(async () => ok({})),
		getSubagents: vi.fn(async () => ok({ subagents: [] })),
		getSubagentMessages: vi.fn(async () => ok({ messages: [], nextByte: 0, hasMore: false })),
		abortSubagent: vi.fn(async () => ok({ ok: true })),
		reviveSubagent: vi.fn(async () => ok({ ok: true })),
		abort: vi.fn(async () => ok({})),
		...overrides,
	};
	(window as unknown as { omp: { rpc: OmpMock } }).omp = { rpc: mock };
	return mock;
}

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
		task: "t",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: 10,
		cost: 0,
		durationMs: 61_000,
		...overrides,
	};
}

function seedHub(): void {
	useSubagentsStore.getState().setSnapshots([
		snap({
			id: "a1",
			index: 1,
			task: "x".repeat(70),
			kind: "sub",
			sessionFile: "/sessions/a1.jsonl",
			progress: progress({ id: "a1", resolvedModel: "openai/gpt-5.2-codex", description: "editing files" }),
		}),
		snap({
			id: "a2",
			index: 2,
			status: "parked",
			task: "short second task",
			kind: "sub",
			sessionFile: "/sessions/a2.jsonl",
		}),
		snap({ id: "a3", index: 3, task: "advisor review", kind: "advisor", sessionFile: "/sessions/a3.jsonl" }),
	]);
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

async function mount(element: ReactElement): Promise<void> {
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
	useSubagentsStore.getState().reset();
	useAgentViewStore.getState().reset();
	useSessionStore.getState().reset();
});

interface TestElement {
	dispatchEvent: (event: object) => boolean;
	textContent: string | null;
}

function queryAll(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

async function doubleClick(element: TestElement): Promise<void> {
	await dispatch(element, new Event("dblclick", { bubbles: true, cancelable: true }));
}

async function pressEnter(element: TestElement): Promise<void> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: "Enter" });
	await dispatch(element, event);
}

function requireElement(selector: string): TestElement {
	const element = document.querySelector(selector);
	if (!element) throw new Error(`Missing test element: ${selector}`);
	return element as unknown as TestElement;
}

function requireButton(label: string): TestElement {
	const button = queryAll("button").find(element => element.textContent?.trim() === label);
	if (!button) throw new Error(`Missing button: ${label}`);
	return button;
}

function bodyText(): string {
	return document.body.textContent ?? "";
}

describe("AgentHubWindow hub tab", () => {
	it("distinguishes same-type agents by task label and shows model/kind/status", async () => {
		installOmpMock();
		seedHub();
		await mount(<AgentHubWindow initialTab="hub" onClose={() => {}} open />);

		// Primary label: task truncated to 60 chars (59 + …); both scout agents
		// are told apart by their labels, not their type name.
		expect(bodyText()).toContain(`${"x".repeat(59)}…`);
		expect(bodyText()).toContain("short second task");
		// Secondary line: agent type, kind badges, resolved model, progress note.
		expect(bodyText()).toContain("openai/gpt-5.2-codex");
		expect(bodyText()).toContain("editing files");
		expect(bodyText()).toContain("read-only");
		expect(bodyText()).toContain("sub");
		// Status badges for the seeded statuses.
		expect(bodyText()).toContain("running");
		expect(bodyText()).toContain("parked");
	});

	it("retains the definitions, prewalk, and Hub controls", async () => {
		const omp = installOmpMock();
		useSessionStore.setState({ status: "ready" });
		seedHub();
		await mount(<AgentHubWindow initialTab="hub" onClose={() => {}} open />);

		expect(bodyText()).toContain("Definitions");
		expect(bodyText()).toContain("Hub");
		expect(queryAll('button[title="View messages"]')).toHaveLength(3);
		expect(queryAll('button[title="Abort this agent"]')).toHaveLength(2);

		await click(requireButton("Definitions"));
		await flush();
		expect(omp.getSettings).toHaveBeenCalled();
		expect(omp.getAgentDefinitions).toHaveBeenCalled();
		expect(bodyText()).toContain("Prewalk");
		expect(bodyText()).toContain("scout");

		await click(requireElement('[data-tab-id="hub"]'));
		expect(queryAll('button[title="View messages"]')).toHaveLength(3);
	});

	it("ranks assignment above the rendered task template, description above task", async () => {
		installOmpMock();
		useSubagentsStore.getState().setSnapshots([
			snap({
				id: "a1",
				index: 1,
				task: "<rendered prompt template with instructions>",
				assignment: "raw scout task",
			}),
			snap({ id: "a2", index: 2, task: "<another rendered template>", description: "identity label" }),
		]);
		await mount(<AgentHubWindow initialTab="hub" onClose={() => {}} open />);

		// task-tool spawns wire task=renderSubagentUserPrompt(assignment): the raw
		// assignment/description must win over the template or cards are boilerplate.
		expect(bodyText()).toContain("raw scout task");
		expect(bodyText()).toContain("identity label");
		expect(bodyText()).not.toContain("rendered prompt template");
		expect(bodyText()).not.toContain("another rendered template");
	});

	it("activates the current roster snapshot and closes without mounting a Hub transcript", async () => {
		const omp = installOmpMock();
		let targetAtClose: unknown;
		const onClose = vi.fn(() => {
			targetAtClose = useAgentViewStore.getState().target;
		});
		seedHub();
		await mount(<AgentHubWindow initialTab="hub" onClose={onClose} open />);

		expect(omp.getSubagentMessages).not.toHaveBeenCalled();
		await click(requireElement('[data-agent-id="a1"] button[title="View messages"]'));

		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "a1" });
		expect(onClose).toHaveBeenCalledOnce();
		expect(targetAtClose).toEqual({ kind: "subagent", id: "a1" });
		expect(omp.getSubagentMessages).toHaveBeenCalledWith("a1", "/sessions/a1.jsonl", 0);
		expect(omp.getSubagentMessages).toHaveBeenCalledOnce();
		expect(queryAll('button[aria-label="Back to instances"]')).toHaveLength(0);
	});

	it("uses the same activation path for the row action, single click, and Enter", async () => {
		const omp = installOmpMock();
		const onClose = vi.fn();
		seedHub();
		await mount(<AgentHubWindow initialTab="hub" onClose={onClose} open />);

		await click(requireElement('[data-agent-id="a1"] button[title="View messages"]'));
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "a1" });
		expect(onClose).toHaveBeenCalledTimes(1);

		await act(async () => useAgentViewStore.getState().selectMain());
		await click(requireElement('[data-agent-id="a2"]'));
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "a2" });
		expect(onClose).toHaveBeenCalledTimes(2);

		await act(async () => useAgentViewStore.getState().selectMain());
		await pressEnter(requireElement('[data-agent-id="a3"]'));
		expect(useAgentViewStore.getState().target).toEqual({ kind: "subagent", id: "a3" });
		expect(onClose).toHaveBeenCalledTimes(3);
		expect(omp.getSubagentMessages.mock.calls.map(call => call[0])).toEqual(["a1", "a2", "a3"]);
	});

	it("isolates abort and revive clicks, double-clicks, and keys from view activation", async () => {
		// Post-action refetch keeps the parked row (a1 is released on abort).
		const omp = installOmpMock({
			getSubagents: vi.fn(async () =>
				ok({ subagents: [snap({ id: "a2", index: 2, status: "parked", task: "short second task", kind: "sub" })] }),
			),
		});
		const onClose = vi.fn();
		seedHub();
		await mount(<AgentHubWindow initialTab="hub" onClose={onClose} open />);

		// Live non-advisor rows (parked a2 + running a1) get abort; advisor a3 doesn't.
		const abort = requireElement('[data-agent-id="a1"] button[title="Abort this agent"]');
		await pressEnter(abort);
		await doubleClick(abort);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		expect(onClose).not.toHaveBeenCalled();

		await click(abort);
		expect(omp.abortSubagent).not.toHaveBeenCalled();
		const confirmAbort = requireElement('[data-agent-id="a1"] button[title="Confirm abort"]');
		await pressEnter(confirmAbort);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		await click(confirmAbort);
		expect(omp.abortSubagent).toHaveBeenCalledWith("a1");
		expect(omp.getSubagents).toHaveBeenCalled();

		const revive = requireElement('[data-agent-id="a2"] button[title="Revive this agent"]');
		await pressEnter(revive);
		await doubleClick(revive);
		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		await click(revive);
		expect(omp.reviveSubagent).toHaveBeenCalledWith("a2");
		expect(onClose).not.toHaveBeenCalled();
		expect(omp.getSubagentMessages).not.toHaveBeenCalled();
	});
});
