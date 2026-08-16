import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useAgentViewStore } from "../../stores/agent-view";
import { useComposerStore } from "../../stores/composer";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useSubagentsStore } from "../../stores/subagents";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { InputArea } from "./InputArea";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

interface TestElement {
	textContent: string | null;
	value: string;
	remove(): void;
	dispatchEvent(event: object): boolean;
	querySelector(selector: string): TestElement | null;
	querySelectorAll(selector: string): TestElement[];
	getAttribute(name: string): string | null;
}

const selectedAgent = {
	id: "sub-8",
	index: 8,
	agent: "Task8Composer",
	description: "Composer safety",
	status: "running",
	lastUpdate: 1,
} satisfies SubagentSnapshot;

const image = {
	content: { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
	preview: "data:image/png;base64,aW1hZ2U=",
};

const ok = (data?: unknown) => ({ type: "response" as const, command: "x", success: true as const, data });

let container: TestElement;
let root: Root;
let prompt: Mock;
let steer: Mock;
let followUp: Mock;
let abort: Mock;
let getAvailableCommands: Mock;
let writeLocalPaste: Mock;
let prefsGet: Mock;
let includeMainQueue = false;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function pressEnter(element: TestElement): Promise<void> {
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey
		? (record[propsKey] as { onKeyDown?: (event: Record<string, unknown>) => void } | undefined)
		: undefined;
	if (!props?.onKeyDown) throw new Error("textarea onKeyDown not found");
	await act(async () =>
		props.onKeyDown?.({
			key: "Enter",
			shiftKey: false,
			ctrlKey: false,
			metaKey: false,
			altKey: false,
			nativeEvent: { isComposing: false },
			keyCode: 13,
			preventDefault: () => {},
		}),
	);
}

async function click(element: TestElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

async function mountSubagentComposer(startAtMain = false): Promise<void> {
	prompt = vi.fn(async () => ok());
	steer = vi.fn(async () => ok());
	followUp = vi.fn(async () => ok());
	abort = vi.fn(async () => ok());
	getAvailableCommands = vi.fn(async () => ok({ commands: [] }));
	writeLocalPaste = vi.fn(async () => ok({ url: "local://paste-1.txt" }));
	prefsGet = vi.fn(async () => []);
	(window as unknown as Record<string, unknown>).omp = {
		fs: { list: vi.fn(async () => ({ entries: [] })), readPlan: vi.fn(async () => ({ ok: true })) },
		events: { onCommandsUpdate: vi.fn(() => () => {}) },
		prefs: { set: vi.fn(async () => ({})), get: prefsGet },
		rpc: {
			getAvailableCommands,
			getPlanMode: vi.fn(async () => ok({ enabled: false, planFilePath: null })),
			getQueue: vi.fn(async () =>
				ok({
					steering: [],
					followUp: includeMainQueue
						? [{ id: "queued-1", text: "Main queued work", editable: true, timestamp: 1 }]
						: [],
				}),
			),
			followUp,
			steer,
			prompt,
			abort,
			setPlanMode: vi.fn(async (enabled: boolean) => ok({ enabled })),
			writeLocalPaste,
		},
	};
	useSessionStore.setState({
		status: "ready",
		isStreaming: false,
		queuedMessageCount: 0,
		cwd: "/tmp",
		sessionId: "s1",
		sessionName: null,
	});
	useSettingsStore.setState({ sttEnabled: true });
	useTabsStore.setState({
		tabs: [{ kind: "agent", id: "t0", cwd: "/tmp", status: "ready", target: { type: "local" }, unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
	useSubagentsStore.getState().setSnapshots([selectedAgent]);
	useAgentViewStore
		.getState()
		.restoreTarget(startAtMain ? { kind: "main" } : { kind: "subagent", id: selectedAgent.id });
	useComposerStore.setState({ draft: "keep this Main draft", images: [image] });

	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<InputArea />
			</I18nProvider>,
		);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useAgentViewStore.getState().reset();
	useSubagentsStore.getState().reset();
	useSessionStore.getState().reset();
	useSettingsStore.getState().reset();
	useMessagesStore.getState().reset();
	useComposerStore.getState().reset();
	useQueueStore.getState().setFromFrame({ steering: [], followUp: [] });
	includeMainQueue = false;
	useTabsStore.getState().reset();
	useUiStore.getState().closeModelPicker();
	useUiStore.getState().closeComposerEditor();
	vi.restoreAllMocks();
});

describe("InputArea selected-subagent mode", () => {
	it("renders only an explicit read-only action and leaves every composer input path inert", async () => {
		await mountSubagentComposer();

		const readOnlyPanel = container.querySelector('[data-agent-view-composer="subagent"]');
		expect(readOnlyPanel).not.toBeNull();
		expect(readOnlyPanel?.textContent).toContain("Composer safety");
		expect(readOnlyPanel?.textContent).not.toContain("Task8Composer");
		expect(readOnlyPanel?.textContent).toContain("Select Main to send a message.");
		expect(container.textContent).not.toContain("Enter to send");
		expect(container.querySelector("textarea")).toBeNull();
		expect(container.querySelector("input")).toBeNull();

		const buttons = readOnlyPanel?.querySelectorAll("button") ?? [];
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.textContent).toContain("Select Main");

		await act(async () => {
			readOnlyPanel?.dispatchEvent(new Event("keydown", { bubbles: true, cancelable: true }));
			readOnlyPanel?.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
			window.dispatchEvent(
				new CustomEvent("omp:fill-composer", { detail: { text: "must not replace Main draft" } }),
			);
			window.dispatchEvent(new CustomEvent("omp:insert-mention", { detail: { value: "@secret" } }));
		});
		await flush();

		expect(useComposerStore.getState().draft).toBe("keep this Main draft");
		expect(useComposerStore.getState().images).toEqual([image]);
		expect(useUiStore.getState().modelPickerOpen).toBe(false);
		expect(prompt).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
		expect(writeLocalPaste).not.toHaveBeenCalled();
		expect(getAvailableCommands).not.toHaveBeenCalled();
		expect(prefsGet).toHaveBeenCalledTimes(1);
		expect(prefsGet).toHaveBeenCalledWith("language");
	});

	it("removes Main queue access in a subagent view and never mounts a workspace-dock surface", async () => {
		includeMainQueue = true;
		await mountSubagentComposer(true);

		const queueButton = container.querySelector(
			'.omp-composer-toolbar button[aria-label="Manage queued messages: 1"]',
		);
		expect(queueButton).not.toBeNull();
		expect(container.querySelector('[data-testid="workspace-dock-scroll"]')).toBeNull();
		if (!queueButton) throw new Error("Main queue button not found");
		await click(queueButton);
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();

		await act(async () => {
			useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selectedAgent.id });
		});

		expect(container.querySelector('[data-agent-view-composer="subagent"]')).not.toBeNull();
		expect(container.querySelector('button[aria-label^="Manage queued messages"]')).toBeNull();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(container.querySelector('[data-testid="workspace-dock-scroll"]')).toBeNull();

		await act(async () => useAgentViewStore.getState().selectMain());
		expect(container.querySelector("textarea")).not.toBeNull();
		expect(container.querySelector('button[aria-label="Manage queued messages: 1"]')).not.toBeNull();
	});

	it("preserves Main draft and attachments through a subagent view, then submits normally on return", async () => {
		await mountSubagentComposer(true);
		const initialTextarea = container.querySelector("textarea");
		if (!initialTextarea) throw new Error("Initial Main composer textarea not found");
		expect(initialTextarea.value).toBe("keep this Main draft");
		expect(container.querySelector('img[alt="attachment 1"]')).not.toBeNull();

		await act(async () => {
			useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: selectedAgent.id });
		});
		expect(container.querySelector("textarea")).toBeNull();
		expect(useComposerStore.getState().draft).toBe("keep this Main draft");
		expect(useComposerStore.getState().images).toEqual([image]);

		const selectMain = container.querySelector('[data-agent-view-composer="subagent"] button');
		if (!selectMain) throw new Error("Select Main action not found");
		await click(selectMain);

		expect(useAgentViewStore.getState().target).toEqual({ kind: "main" });
		const restoredTextarea = container.querySelector("textarea");
		if (!restoredTextarea) throw new Error("Restored Main composer textarea not found");
		expect(restoredTextarea.value).toBe("keep this Main draft");
		expect(container.querySelector('img[alt="attachment 1"]')).not.toBeNull();

		await pressEnter(restoredTextarea);
		await flush();
		await flush();

		expect(prompt).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledWith("keep this Main draft", [image.content], "steer");
		expect(steer).not.toHaveBeenCalled();
		expect(followUp).not.toHaveBeenCalled();
	});
});
