import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useAgentViewStore } from "../../stores/agent-view";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { CommandPalette } from "./CommandPalette";

const parsed = parseHTML("<html><body></body></html>");
const testWindow = parsed.window;
const testDocument = parsed.document;
const globals = globalThis as Record<string, unknown>;
const storage = new Map<string, string>();
Object.assign(globals, {
	window: testWindow,
	document: testDocument,
	Event: testWindow.Event,
	CustomEvent: testWindow.CustomEvent,
	HTMLElement: testWindow.HTMLElement,
	Element: testWindow.Element,
	Node: testWindow.Node,
	MutationObserver: testWindow.MutationObserver,
	localStorage: {
		clear: () => storage.clear(),
		getItem: (key: string) => storage.get(key) ?? null,
		key: (index: number) => [...storage.keys()][index] ?? null,
		get length() {
			return storage.size;
		},
		removeItem: (key: string) => storage.delete(key),
		setItem: (key: string, value: string) => storage.set(key, value),
	},
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	IS_REACT_ACT_ENVIRONMENT: true,
});

const elementPrototype = testWindow.HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

const ok = (data?: unknown) => ({ type: "response" as const, command: "test", success: true as const, data });

let container: HTMLElement;
let root: Root;
let prompt: Mock;
let retry: Mock;
let compact: Mock;
let setPlanMode: Mock;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mountPalette(): Promise<void> {
	container = testDocument.createElement("div") as unknown as HTMLElement;
	testDocument.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<CommandPalette />
			</I18nProvider>,
		);
	});
}

async function openPalette(): Promise<void> {
	await act(async () => useUiStore.getState().openCommandPalette());
	await flush();
}

function commandButton(label: string): HTMLButtonElement | null {
	return (
		(Array.from(container.querySelectorAll("button")) as unknown as HTMLButtonElement[]).find(button =>
			button.textContent?.includes(label),
		) ?? null
	);
}

async function runIfPresent(label: string): Promise<boolean> {
	await openPalette();
	const button = commandButton(label);
	if (!button) return false;
	await act(async () => button.click());
	await flush();
	return true;
}

function reactClick(button: HTMLButtonElement): () => void {
	const record = button as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onClick?: () => void } | undefined) : undefined;
	if (!props?.onClick) throw new Error("Command button onClick not found");
	return props.onClick;
}

async function invokeReactClick(onClick: () => void): Promise<void> {
	await act(async () => onClick());
	await flush();
}

function resetUi(): void {
	useUiStore.setState({
		agentHubOpen: false,
		dockCollapsed: {},
		dockFocus: null,
		commandPaletteOpen: false,
		modelPickerOpen: false,
	});
}

beforeEach(() => {
	storage.clear();
	useAgentViewStore.getState().reset();
	useMessagesStore.getState().reset();
	useMessagesStore.setState({
		messages: [{ role: "user", content: [{ type: "text", text: "Main resend payload" }], timestamp: 1 }],
	});
	useSessionStore.getState().reset();
	resetUi();

	prompt = vi.fn(async () => ok());
	retry = vi.fn(async () => ok({ retried: true }));
	compact = vi.fn(async () => ok());
	setPlanMode = vi.fn(async (enabled: boolean) => ok({ enabled }));
	(testWindow as unknown as Record<string, unknown>).omp = {
		rpc: {
			abortAndPrompt: vi.fn(async () => ok()),
			compact,
			getAvailableCommands: vi.fn(async () =>
				ok({
					commands: [
						{
							name: "unsafe-main",
							description: "Mutates the selected Main conversation",
							textModeExecutable: true,
						},
					],
				}),
			),
			prompt,
			retry,
			setPlanMode,
		},
	};
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useAgentViewStore.getState().reset();
	useMessagesStore.getState().reset();
	useSessionStore.getState().reset();
	resetUi();
	vi.restoreAllMocks();
});

describe("CommandPalette selected-subagent mode", () => {
	it("keeps Main mutation commands unchanged when Main is selected", async () => {
		await mountPalette();

		expect(await runIfPresent("/unsafe-main")).toBe(true);
		expect(prompt).toHaveBeenCalledWith("/unsafe-main");

		expect(await runIfPresent("Retry Last Turn")).toBe(true);
		expect(retry).toHaveBeenCalledTimes(1);

		expect(await runIfPresent("Plan Mode")).toBe(true);
		expect(setPlanMode).toHaveBeenCalledWith(true);

		expect(await runIfPresent("Switch Model")).toBe(true);
		expect(useUiStore.getState().modelPickerOpen).toBe(true);
	});

	it("rechecks the target before a command captured on Main can execute", async () => {
		await mountPalette();
		await openPalette();
		const staleMainCommand = commandButton("/unsafe-main");
		if (!staleMainCommand) throw new Error("Expected Main prompt command");
		const clickStaleMainCommand = reactClick(staleMainCommand);

		await act(async () => {
			useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "sub-1" });
		});
		expect(commandButton("/unsafe-main")).toBeNull();

		await invokeReactClick(clickStaleMainCommand);
		expect(prompt).not.toHaveBeenCalled();
	});

	it("cannot execute prompt, retry, resend, compact, plan, or model mutations for a selected subagent", async () => {
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "sub-1" });
		await mountPalette();

		expect(await runIfPresent("/unsafe-main")).toBe(false);
		expect(await runIfPresent("Retry Last Turn")).toBe(false);
		expect(await runIfPresent("Resend Last Message")).toBe(false);
		expect(await runIfPresent("Compact Context")).toBe(false);
		expect(await runIfPresent("Plan Mode")).toBe(false);
		expect(await runIfPresent("Switch Model")).toBe(false);
		expect(await runIfPresent("Settings")).toBe(false);
		expect(await runIfPresent("Extensions")).toBe(false);
		expect(await runIfPresent("PR Center")).toBe(false);

		expect(prompt).not.toHaveBeenCalled();
		expect(retry).not.toHaveBeenCalled();
		expect(compact).not.toHaveBeenCalled();
		expect(setPlanMode).not.toHaveBeenCalled();
		expect(useUiStore.getState().modelPickerOpen).toBe(false);
	});

	it("preserves Agents navigation for a selected subagent", async () => {
		useAgentViewStore.getState().restoreTarget({ kind: "subagent", id: "sub-1" });
		await mountPalette();

		expect(await runIfPresent("Agents")).toBe(true);
		expect(useUiStore.getState()).toMatchObject({
			agentHubOpen: false,
			dockFocus: { id: "agents", seq: 1 },
		});
		expect(prompt).not.toHaveBeenCalled();
	});
});
