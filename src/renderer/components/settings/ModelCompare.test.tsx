import { parseArgs } from "node:util";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { executeConfigRpcCommand, isConfigRpcCommand } from "../../../main/config-rpc";
import type { SessionTarget } from "../../../shared/ipc-types";
import type { ModelRoleEntry, ProviderInfo, RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { createModelStore } from "../../stores/model";
import { createSessionStore } from "../../stores/session";
import { addRuntimeStore, SessionRuntimeProvider, type SessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { buildModelRows, formatCost, ModelCompare } from "./ModelCompare";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document, window, Event, HTMLElement, Element, Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList;

let root: Root | undefined;

function ok(command: string, data?: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

function settings(assignments: Record<string, string> = {}) {
	return { values: { modelRoles: assignments, modelTags: {}, cycleOrder: ["smol", "default", "slow"] } };
}

function configBackend(assignments: Record<string, string>) {
	const state = { assignments, saveGate: null as Promise<void> | null };
	const handler = async (request: RpcCommand): Promise<RpcResponse> => {
		if (!isConfigRpcCommand(request)) throw new Error(`Unexpected native command: ${request.type}`);
		return executeConfigRpcCommand(request, async args => {
			const values = settings(state.assignments).values;
			const entries = Object.fromEntries(Object.entries(values).map(([key, value]) => [
				key, { value, type: key === "cycleOrder" ? "array" : "record", description: "" },
			]));
			if (args[1] === "list") return JSON.stringify(entries);
			const { positionals } = parseArgs({ args: args.slice(2), options: { json: { type: "boolean" } }, allowPositionals: true });
			const key = positionals[0]!;
			if (args[1] === "get") return JSON.stringify({ key, ...entries[key] });
			if (args[1] !== "set" || key !== "modelRoles") throw new Error("Unexpected config invocation");
			await state.saveGate;
			state.assignments = JSON.parse(positionals[1]!);
			return JSON.stringify({ key, value: state.assignments });
		});
	};
	return { state, handler };
}

function provider(id: string, overrides: Partial<ProviderInfo> = {}): ProviderInfo {
	return { id, name: id, authenticated: true, loginAvailable: false, disabled: false, modelCount: 1, ...overrides };
}

function role(id: string, model?: string): ModelRoleEntry {
	return { id, name: id, tag: id.toUpperCase(), color: "default", source: "settings", section: "chat", candidates: [], model };
}

function catalog(ids: string[] = ["model-a", "model-b"], generation = 1) {
	return {
		providers: [provider("provider")],
		models: ids.map(id => ({ provider: "provider", id })),
		discoveryStates: [], refreshPending: false, generation,
	};
}

function readyRuntime(tabId: string, handler: (request: RpcCommand) => Promise<RpcResponse>, target: SessionTarget = { type: "local" }) {
	const runtime: SessionRuntime = { tabId, command: handler, stores: new Map() };
	const session = createSessionStore();
	const models = createModelStore(handler);
	session.setState({ status: "ready", cwd: `/srv/${tabId}` });
	addRuntimeStore(runtime, "session", session);
	addRuntimeStore(runtime, "model", models);
	useTabsStore.setState(state => ({
		tabs: [...state.tabs, { id: tabId, cwd: `/srv/${tabId}`, target, status: "ready", kind: "agent", unreadDone: false }],
	}));
	return { runtime, session, models };
}

async function renderCompare(runtime: SessionRuntime): Promise<void> {
	root ??= createRoot(document.body as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider><SessionRuntimeProvider runtime={runtime}><ModelCompare onClose={() => {}} open /></SessionRuntimeProvider></I18nProvider>);
	});
}

async function flush(): Promise<void> {
	await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });
}

function rowFor(modelId: string): HTMLElement {
	const row = Array.from(document.body.querySelectorAll("tbody tr")).find(item => item.textContent?.includes(modelId));
	if (!row) throw new Error(`No row for ${modelId}`);
	return row as unknown as HTMLElement;
}

function selectFor(modelId: string): HTMLSelectElement {
	const select = rowFor(modelId).querySelector("select");
	if (!select) throw new Error(`No role picker for ${modelId}`);
	return select as unknown as HTMLSelectElement;
}

function selectedRole(modelId: string): string | null {
	return selectFor(modelId).querySelector("option[selected]")?.getAttribute("value") ?? null;
}

function changeRole(select: HTMLSelectElement, value: string): void {
	Object.defineProperty(select, "value", { configurable: true, value });
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

function useButton(modelId: string): HTMLButtonElement {
	const button = rowFor(modelId).querySelector("button");
	if (!button) throw new Error(`No Use button for ${modelId}`);
	return button as unknown as HTMLButtonElement;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useTabsStore.setState({ tabs: [], activeTabId: null });
	useToastStore.setState({ toasts: [] });
});

describe("formatCost", () => {
	it("keeps integer zeros while trimming insignificant decimal zeros", () => {
		expect(formatCost(0)).toBe("$0");
		expect(formatCost(0.075)).toBe("$0.075");
		expect(formatCost(2.5)).toBe("$2.5");
		expect(formatCost(10)).toBe("$10");
		expect(formatCost(100)).toBe("$100");
	});
});

describe("model role selectors", () => {
	it("does not assign a same-named model from another provider or a bare selector", () => {
		const rows = buildModelRows({
			models: [{ provider: "anthropic", id: "claude" }, { provider: "openai", id: "claude" }],
			providers: [], roles: [role("default", "anthropic/claude"), role("smol", "claude")],
		});
		expect(rows[0].roles.map(item => item.id)).toEqual(["default"]);
		expect(rows[1].roles).toEqual([]);
	});
});

describe("ModelCompare tab-scoped catalog and role assignments", () => {
	it("updates local config roles and reloads the authoritative assignment", async () => {
		const backend = configBackend({ default: "provider/model-a", task: "other/task-model" });
		const tab = readyRuntime("local", async request => {
			if (request.type === "get_providers") return ok(request.type, catalog());
			return backend.handler(request);
		});
		await renderCompare(tab.runtime);
		expect(selectedRole("model-a")).toBe("default");
		await act(async () => changeRole(selectFor("model-b"), "default"));
		expect(backend.state.assignments).toEqual({ default: "provider/model-b", task: "other/task-model" });
		expect(selectedRole("model-a")).toBe("");
		expect(selectedRole("model-b")).toBe("default");
	});

	it("preserves sibling edits made by another window after comparison loaded", async () => {
		const backend = configBackend({ default: "provider/model-a", task: "old/task" });
		const tab = readyRuntime("stale-comparison", async request => {
			if (request.type === "get_providers") return ok(request.type, catalog());
			return backend.handler(request);
		});
		await renderCompare(tab.runtime);
		await backend.handler({ type: "set_model_role", role: "task", modelId: "other/new-task" });
		await act(async () => changeRole(selectFor("model-b"), "default"));
		expect(backend.state.assignments).toEqual({ default: "provider/model-b", task: "other/new-task" });
		await backend.handler({ type: "set_model_role", role: "task", modelId: "other/latest-task" });
		await act(async () => changeRole(selectFor("model-b"), ""));
		expect(backend.state.assignments).toEqual({ task: "other/latest-task" });
		expect(selectedRole("model-b")).toBe("");
	});

	it("saves SSH roles in the owning pane and prevents overlapping role assignments", async () => {
		const pending = Promise.withResolvers<void>();
		const backend = configBackend({ default: "provider/model-a", task: "other/task-model" });
		backend.state.saveGate = pending.promise;
		const other = readyRuntime("focused-local", async request => {
			throw new Error(`Wrong pane received ${request.type}`);
		});
		useTabsStore.setState({ activeTabId: other.runtime.tabId });
		const remote = readyRuntime("remote", async request => {
			if (request.type === "get_providers") return ok(request.type, catalog());
			return backend.handler(request);
		}, {
			type: "ssh", hostAlias: "server", host: { host: "server", sourceId: "test", sourceLevel: "user" },
			originCwd: "/srv/remote", cwd: "/srv/remote",
		});
		await renderCompare(remote.runtime);
		const first = selectFor("model-b");
		const second = selectFor("model-a");
		await act(async () => {
			changeRole(first, "default");
			changeRole(second, "slow");
		});
		expect(backend.state.assignments).toEqual({ default: "provider/model-a", task: "other/task-model" });
		expect(first.hasAttribute("disabled")).toBe(true);
		expect(second.hasAttribute("disabled")).toBe(true);
		pending.resolve();
		await flush();
		expect(selectedRole("model-a")).toBe("");
		expect(selectedRole("model-b")).toBe("default");
		expect(selectFor("model-b").hasAttribute("disabled")).toBe(false);
		await act(async () => changeRole(selectFor("model-b"), ""));
		expect(backend.state.assignments).toEqual({ task: "other/task-model" });
		expect(selectedRole("model-b")).toBe("");
	});

	it("keeps a newer pushed catalog when the opening response arrives late", async () => {
		const pending = Promise.withResolvers<RpcResponse>();
		const tab = readyRuntime("catalog-race", async request => {
			if (request.type === "get_providers") return pending.promise;
			if (request.type === "get_settings") return ok(request.type, settings());
			throw new Error(`Unexpected command: ${request.type}`);
		});
		await renderCompare(tab.runtime);
		await act(async () => {
			tab.models.getState().applyCatalogUpdate({ type: "model_catalog_update", ...catalog(["new-model"], 2) });
		});
		pending.resolve(ok("get_providers", catalog(["old-model"], 1)));
		await flush();
		expect(rowFor("new-model").textContent).toContain("new-model");
		expect(document.body.textContent).not.toContain("old-model");
	});

	it("ignores an old pane's role load after switching comparison to another runtime", async () => {
		const pending = Promise.withResolvers<RpcResponse>();
		const old = readyRuntime("old", async request => request.type === "get_settings" ? pending.promise : ok(request.type, catalog(["old-model"])));
		const current = readyRuntime("current", async request => request.type === "get_settings"
			? ok(request.type, settings({ plan: "provider/current-model" }))
			: ok(request.type, catalog(["current-model"])));
		await renderCompare(old.runtime);
		await renderCompare(current.runtime);
		expect(selectedRole("current-model")).toBe("plan");
		pending.resolve(ok("get_settings", settings({ default: "provider/old-model" })));
		await flush();
		expect(selectedRole("current-model")).toBe("plan");
		expect(document.body.textContent).not.toContain("old-model");
	});

	it("blocks row clicks for disabled and signed-out providers without blocking unknown auth", async () => {
		const changes: string[] = [];
		const tab = readyRuntime("availability", async request => {
			if (request.type === "get_providers") return ok(request.type, {
				...catalog(),
				providers: [provider("off", { disabled: true }), provider("noauth", { authenticated: false }), provider("serving")],
				models: ["off", "noauth", "unlisted", "serving"].map(id => ({ provider: id, id: `${id}-model` })),
			});
			if (request.type === "get_settings") return ok(request.type, settings());
			if (request.type === "set_model") { changes.push(`${request.provider}/${request.modelId}`); return ok(request.type); }
			throw new Error(`Unexpected command: ${request.type}`);
		});
		await renderCompare(tab.runtime);
		for (const id of ["off-model", "noauth-model"]) {
			expect(useButton(id).hasAttribute("disabled")).toBe(true);
			await act(async () => rowFor(id).click());
		}
		expect(changes).toEqual([]);
		for (const id of ["unlisted-model", "serving-model"]) {
			expect(useButton(id).hasAttribute("disabled")).toBe(false);
			await act(async () => rowFor(id).click());
		}
		expect(changes).toEqual(["unlisted/unlisted-model", "serving/serving-model"]);
	});

	it("locks every role control when role loading fails while leaving catalog selection usable", async () => {
		const changes: string[] = [];
		const tab = readyRuntime("role-error", async request => {
			if (request.type === "get_providers") return ok(request.type, catalog());
			if (request.type === "get_settings") return { type: "response", command: request.type, success: false, error: "Roles unavailable" };
			if (request.type === "set_model") { changes.push(request.modelId); return ok(request.type); }
			throw new Error(`Unexpected command: ${request.type}`);
		});
		await renderCompare(tab.runtime);
		expect(selectFor("model-a").hasAttribute("disabled")).toBe(true);
		expect(selectFor("model-b").hasAttribute("disabled")).toBe(true);
		await act(async () => { changeRole(selectFor("model-a"), "default"); rowFor("model-a").click(); });
		expect(changes).toEqual(["model-a"]);
	});

	it("locks stale assignments when the authoritative read fails after a successful save", async () => {
		let saved = false;
		const backend = configBackend({ default: "provider/model-a" });
		let writes = 0;
		const tab = readyRuntime("reload-error", async request => {
			if (request.type === "get_providers") return ok(request.type, catalog());
			if (request.type === "get_settings") {
				return saved
					? { type: "response", command: request.type, success: false, error: "Config unavailable" }
					: backend.handler(request);
			}
			if (request.type === "set_model_role") {
				writes++;
				saved = true;
				return backend.handler(request);
			}
			throw new Error(`Unexpected command: ${request.type}`);
		});
		await renderCompare(tab.runtime);
		await act(async () => changeRole(selectFor("model-b"), "default"));
		expect(backend.state.assignments).toEqual({ default: "provider/model-b" });
		expect(selectFor("model-a").hasAttribute("disabled")).toBe(true);
		expect(selectFor("model-b").hasAttribute("disabled")).toBe(true);
		await act(async () => changeRole(selectFor("model-a"), "slow"));
		expect(writes).toBe(1);
	});

	it("does not commit model or role changes after the owning runtime disconnects", async () => {
		const changes: string[] = [];
		const tab = readyRuntime("disconnect", async request => {
			if (request.type === "get_providers") return ok(request.type, catalog());
			if (request.type === "get_settings") return ok(request.type, settings({ default: "provider/model-a" }));
			changes.push(request.type);
			return ok(request.type);
		});
		await renderCompare(tab.runtime);
		const row = rowFor("model-b");
		const select = selectFor("model-b");
		await act(async () => tab.session.setState({ status: "starting" }));
		await act(async () => { row.click(); changeRole(select, "default"); });
		expect(changes).toEqual([]);
	});
});
