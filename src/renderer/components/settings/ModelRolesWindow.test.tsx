import { parseArgs } from "node:util";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeConfigRpcCommand, isConfigRpcCommand } from "../../../main/config-rpc";
import type { ModelInfo, RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { createSessionStore } from "../../stores/session";
import { addRuntimeStore, SessionRuntimeProvider, type SessionRuntime } from "../../stores/session-runtime-context";
import { type SessionTab, useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { ModelRolesWindow } from "./ModelRolesWindow";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document, window, Event, HTMLElement, Element, Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList;

let root: Root | undefined;
const models: ModelInfo[] = [
	{ provider: "anthropic", id: "claude", name: "Claude" },
	{ provider: "openai", id: "gpt", name: "GPT" },
	{ provider: "local", id: "tiny", name: "Tiny", kind: "tiny" },
	{ provider: "openai", id: "dalle", name: "DALL·E", kind: "image" },
];

function configBackend(assignments: Record<string, string> = { default: "anthropic/claude", image: "retired/image", secret: "private/model" }) {
	const state = {
		error: null as string | null,
		readGate: null as Promise<void> | null,
		saveGate: null as Promise<void> | null,
		settings: {
			modelRoles: assignments,
			modelTags: { image: { name: "Image generation" }, secret: { name: "Hidden role", hidden: true } },
			cycleOrder: ["default", "image", "secret"],
		} as Record<string, unknown>,
	};
	const runCli = vi.fn(async (args: string[]): Promise<string> => {
		if (state.error) throw new Error(state.error);
		const entry = (key: string) => ({
			value: state.settings[key], type: key === "cycleOrder" ? "array" : "record", description: key,
		});
		if (args[1] === "list") {
			await state.readGate;
			return JSON.stringify(Object.fromEntries(Object.keys(state.settings).map(key => [key, entry(key)])));
		}
		const { positionals } = parseArgs({ args: args.slice(2), options: { json: { type: "boolean" } }, allowPositionals: true });
		const key = positionals[0]!;
		if (args[1] === "get") return JSON.stringify({ key, ...entry(key) });
		if (args[1] === "set") {
			await state.saveGate;
			state.settings[key] = JSON.parse(positionals[1]!);
			return JSON.stringify({ key, value: state.settings[key] });
		}
		throw new Error(`Unexpected config invocation: ${args.join(" ")}`);
	});
	const handler = async (request: RpcCommand): Promise<RpcResponse> => {
		if (request.type === "get_available_models") return ok(request.type, { models });
		if (isConfigRpcCommand(request)) return executeConfigRpcCommand(request, runCli);
		return failure(request, `Unsupported command: ${request.type}`);
	};
	return { state, handler, runCli };
}

function ok(command: string, data?: unknown): RpcResponse {
	return { type: "response", command, success: true, data } as RpcResponse;
}

function failure(request: RpcCommand, error: string): RpcResponse {
	return { type: "response", command: request.type, success: false, error };
}

function runtime(tabId: string, handler: (request: RpcCommand) => Promise<RpcResponse>, remote = false) {
	const command = vi.fn(handler);
	const owner: SessionRuntime = { tabId, command, stores: new Map() };
	const session = createSessionStore();
	session.setState({ status: "ready", cwd: `/srv/${tabId}` });
	addRuntimeStore(owner, "session", session);
	const tab: SessionTab = {
		id: tabId, cwd: `/srv/${tabId}`, status: "ready", kind: "agent", unreadDone: false,
		target: remote ? {
			type: "ssh", hostAlias: "build", host: { host: "build.example", sourceId: "ssh-json", sourceLevel: "user" },
			originCwd: "/srv", cwd: `/srv/${tabId}`,
		} : { type: "local" },
	};
	useTabsStore.setState(state => ({ tabs: [...state.tabs, tab] }));
	return { owner, session, command };
}

async function flush(): Promise<void> {
	await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
}

async function render(owner: SessionRuntime): Promise<void> {
	if (!root) {
		const container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container as unknown as Element);
		useUiStore.setState({ modelRolesOpen: true });
	}
	await act(async () => {
		root?.render(<I18nProvider><SessionRuntimeProvider runtime={owner}><ModelRolesWindow /></SessionRuntimeProvider></I18nProvider>);
	});
	await flush();
}

function trigger(role: string): HTMLButtonElement {
	const button = document.body.querySelector(`button[aria-label="Model for ${role}"]`);
	expect(button).not.toBeNull();
	return button as unknown as HTMLButtonElement;
}

function button(label: string): HTMLButtonElement {
	const match = [...document.body.querySelectorAll("button")].find(node => node.textContent?.trim() === label);
	expect(match).toBeDefined();
	return match as unknown as HTMLButtonElement;
}

async function click(node: HTMLButtonElement): Promise<void> {
	await act(async () => { node.dispatchEvent(new Event("click", { bubbles: true })); });
	await flush();
}

async function choose(role: string, selector: string | null): Promise<void> {
	await click(trigger(role));
	const option = selector
		? [...document.body.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes(selector))
		: document.body.querySelector('[role="option"]');
	expect(option).toBeDefined();
	await click(option as unknown as HTMLButtonElement);
}

async function search(value: string): Promise<void> {
	const input = document.body.querySelector("input") as unknown as HTMLInputElement;
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
	if (descriptor?.set) descriptor.set.call(input, value);
	else input.value = value;
	const record = input as unknown as Record<string, unknown>;
	const propsKey = Object.keys(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? record[propsKey] as { onChange: (event: { target: HTMLInputElement }) => void } : undefined;
	await act(async () => { props?.onChange({ target: input }); });
}

afterEach(async () => {
	await act(async () => { root?.unmount(); });
	root = undefined;
	document.body.innerHTML = "";
	useUiStore.setState({ modelRolesOpen: false });
	useTabsStore.setState({ tabs: [], activeTabId: null });
	vi.restoreAllMocks();
});

describe("ModelRolesWindow config eligibility and recovery", () => {
	it("honors configured names and hidden roles while searching catalog-eligible grouped choices", async () => {
		const backend = configBackend();
		const local = runtime("local", backend.handler);
		await render(local.owner);
		expect(document.body.textContent).not.toContain("Hidden role");
		await click(trigger("Default"));
		expect(document.body.querySelector('[role="listbox"]')?.textContent).toContain("openai/gpt");
		expect(document.body.querySelector('[role="listbox"]')?.textContent).not.toContain("openai/dalle");
		await search("openai");
		const options = [...document.body.querySelectorAll('[role="option"]')].map(node => node.textContent);
		expect(options.some(text => text?.includes("openai/gpt"))).toBe(true);
		expect(options.some(text => text?.includes("anthropic/claude"))).toBe(false);
		await click(trigger("Default"));
		await click(trigger("Image generation"));
		const imageOptions = document.body.querySelector('[role="listbox"]')?.textContent;
		expect(imageOptions).toContain("retired/image");
		expect(imageOptions).toContain("openai/dalle");
		expect(imageOptions).not.toContain("openai/gpt");
		await click(trigger("Image generation"));
		await click(trigger("Tiny"));
		const tinyOption = [...document.body.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes("local/tiny"));
		const chatOption = [...document.body.querySelectorAll('[role="option"]')].find(node => node.textContent?.includes("openai/gpt"));
		expect(tinyOption).toBeDefined();
		expect(chatOption).toBeDefined();
		expect(tinyOption?.parentElement).not.toBe(chatOption?.parentElement);
		expect(document.body.querySelector('[role="listbox"]')?.textContent).not.toContain("openai/dalle");
	});

	it("saves and clears an SSH role through the real config facade without dropping other assignments", async () => {
		const backend = configBackend({ plan: "anthropic/claude", task: "openai/gpt" });
		const remote = runtime("ssh", backend.handler, true);
		await render(remote.owner);
		await choose("Architect", "openai/gpt");
		expect(backend.state.settings.modelRoles).toEqual({ plan: "openai/gpt", task: "openai/gpt" });
		expect(trigger("Architect").textContent).toContain("GPT — openai/gpt");
		await choose("Architect", null);
		expect(backend.state.settings.modelRoles).toEqual({ task: "openai/gpt" });
		expect(trigger("Subtask").textContent).toContain("openai/gpt");
	});

	it("preserves a sibling role completed by another window after this window loaded", async () => {
		const backend = configBackend({ plan: "anthropic/claude", task: "old/task" });
		const firstWindow = runtime("first-window", backend.handler);
		const secondWindow = runtime("second-window", backend.handler);
		await render(firstWindow.owner);
		await secondWindow.command({ type: "set_model_role", role: "task", modelId: "openai/gpt" });
		await choose("Architect", "openai/gpt");
		expect(backend.state.settings.modelRoles).toEqual({ plan: "openai/gpt", task: "openai/gpt" });
		await secondWindow.command({ type: "set_model_role", role: "task", modelId: "other/new-task" });
		await choose("Architect", null);
		expect(backend.state.settings.modelRoles).toEqual({ task: "other/new-task" });
		expect(trigger("Subtask").textContent).toContain("other/new-task");
	});

	it("recovers from initial and stale config failures without replacing loaded roles", async () => {
		const backend = configBackend();
		backend.state.error = "socket closed";
		const local = runtime("local", backend.handler);
		await render(local.owner);
		expect(document.body.querySelector('[aria-haspopup="listbox"]')).toBeNull();
		backend.state.error = null;
		await click(button("Retry"));
		expect(trigger("Default").disabled).toBe(false);
		backend.state.error = "socket closed";
		await click(button("Refresh"));
		expect(trigger("Default").textContent).toContain("anthropic/claude");
		expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
		backend.state.error = null;
		await click(button("Retry"));
		expect(document.body.querySelector('[role="alert"]')).toBeNull();
	});

	it("disables controls without issuing a config read while disconnected", async () => {
		const backend = configBackend();
		const local = runtime("local", backend.handler);
		local.session.setState({ status: "exited" });
		await render(local.owner);
		expect(button("Refresh").disabled).toBe(true);
		expect(document.body.querySelector('[aria-haspopup="listbox"]')).toBeNull();
		expect(local.command).not.toHaveBeenCalled();
		await act(async () => { local.session.setState({ status: "ready" }); });
		await flush();
		await click(trigger("Default"));
		await act(async () => { local.session.setState({ status: "exited" }); });
		expect(trigger("Default").disabled).toBe(true);
		expect(document.body.querySelector('[role="listbox"]')).toBeNull();
		expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
	});

	it("locks every role during a role save and retains assignments on rejection", async () => {
		const backend = configBackend({ plan: "anthropic/claude", task: "openai/gpt" });
		const gate = Promise.withResolvers<void>();
		backend.state.saveGate = gate.promise;
		const remote = runtime("ssh", backend.handler, true);
		await render(remote.owner);
		await choose("Architect", "openai/gpt");
		expect(trigger("Architect").disabled).toBe(true);
		expect(trigger("Subtask").disabled).toBe(true);
		gate.reject(new Error("permission denied"));
		await flush();
		expect(backend.state.settings.modelRoles).toEqual({ plan: "anthropic/claude", task: "openai/gpt" });
		expect(trigger("Architect").disabled).toBe(false);
		expect(trigger("Architect").textContent).toContain("anthropic/claude");
	});

	it("ignores a previous tab's delayed config load and uses only the current assignments for saving", async () => {
		const oldBackend = configBackend({ plan: "old/selector", task: "old/task" });
		const gate = Promise.withResolvers<void>();
		oldBackend.state.readGate = gate.promise;
		const old = runtime("old", oldBackend.handler, true);
		const currentBackend = configBackend({ plan: "anthropic/claude", task: "openai/gpt" });
		const current = runtime("current", currentBackend.handler, true);
		await render(old.owner);
		await render(current.owner);
		expect(trigger("Architect").textContent).toContain("anthropic/claude");
		gate.resolve();
		await flush();
		expect(document.body.textContent).not.toContain("old/selector");
		await choose("Architect", "openai/gpt");
		expect(currentBackend.state.settings.modelRoles).toEqual({ plan: "openai/gpt", task: "openai/gpt" });
	});

	it("ignores a previous tab's pending save after ownership changes", async () => {
		const oldBackend = configBackend({ plan: "anthropic/claude", task: "old/task" });
		const gate = Promise.withResolvers<void>();
		oldBackend.state.saveGate = gate.promise;
		const old = runtime("old", oldBackend.handler, true);
		const currentBackend = configBackend({ plan: "anthropic/claude", task: "current/task" });
		const current = runtime("current", currentBackend.handler, true);
		await render(old.owner);
		await choose("Architect", "openai/gpt");
		await render(current.owner);
		gate.resolve();
		await flush();
		expect(trigger("Architect").textContent).toContain("anthropic/claude");
		expect(trigger("Subtask").textContent).toContain("current/task");
		await choose("Architect", "openai/gpt");
		expect(currentBackend.state.settings.modelRoles).toEqual({ plan: "openai/gpt", task: "current/task" });
	});
});
