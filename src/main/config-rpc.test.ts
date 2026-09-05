import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { executeConfigRpcCommand, isConfigRpcCommand } from "./config-rpc";

const configList = {
	modelRoles: { value: { plan: "anthropic/claude-sonnet" }, type: "record", description: "" },
	modelTags: { value: {}, type: "record", description: "" },
	cycleOrder: { value: ["smol", "default", "slow"], type: "array", description: "" },
	theme: { value: "dark", type: "enum", description: "Active theme" },
};

function configBackend(initial: Record<string, unknown>) {
	const values = { ...initial };
	const runCli = async (args: string[]): Promise<string> => {
		const { positionals } = parseArgs({ args: args.slice(2), options: { json: { type: "boolean" } }, allowPositionals: true });
		const [key, input] = positionals;
		if (!key) throw new Error("Missing config key");
		const current = values[key];
		const type = typeof current === "number" ? "number" : typeof current === "string" ? "string" : "record";
		if (args[1] === "get") return JSON.stringify({ key, value: current, type, description: "" });
		if (args[1] !== "set" || input === undefined) throw new Error("Invalid config invocation");
		values[key] = type === "string" ? input : JSON.parse(input);
		return JSON.stringify({ key, value: values[key] });
	};
	return { values, runCli };
}

const nativeBackendDirs: string[] = [];
afterEach(() => {
	for (const directory of nativeBackendDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Model the native settings layers independently: whole-map writes leave runtime
// overrides intact, while per-role saves merge fresh persisted siblings and adopt them.
function nativeRoleBackend(initial: Record<string, string>) {
	const directory = mkdtempSync(join(tmpdir(), "gui-native-roles-"));
	nativeBackendDirs.push(directory);
	const file = join(directory, "model-roles.json");
	const disk = {
		get assignments(): Record<string, string> {
			return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(file, "utf8")));
		},
		set assignments(value: Record<string, string>) {
			writeFileSync(file, JSON.stringify(value));
		},
	};
	disk.assignments = initial;
	const session = (overrides: Record<string, string> = {}, beforeSave = async () => {}) => {
		let global = { ...disk.assignments };
		const runtime = { ...overrides };
		const effective = () => ({ ...global, ...runtime });
		const runNative = async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "get_settings") {
				return {
					type: "response", command: command.type, success: true,
					data: { values: { modelRoles: effective() } },
				};
			}
			if (command.type === "set_model_role") {
				if (Object.hasOwn(runtime, command.role)) {
					if (command.modelId === null) delete runtime[command.role];
					else runtime[command.role] = command.modelId;
				}
				await beforeSave();
				const fresh = { ...disk.assignments };
				if (command.modelId === null) delete fresh[command.role];
				else fresh[command.role] = command.modelId;
				disk.assignments = fresh;
				global = { ...fresh };
				return {
					type: "response", command: command.type, success: true,
					data: { role: command.role, modelId: command.modelId },
				};
			}
			if (command.type === "set_setting" && command.path === "modelRoles") {
				await beforeSave();
				disk.assignments = { ...(command.value as Record<string, string>) };
				global = { ...disk.assignments };
				return {
					type: "response", command: command.type, success: true,
					data: { path: command.path, value: effective() },
				};
			}
			throw new Error(`Unexpected native command: ${command.type}`);
		};
		return { runNative, effective };
	};
	return { disk, session };
}

describe("config RPC compatibility", () => {
	it("recognizes settings commands without intercepting unrelated native APIs", () => {
		expect(isConfigRpcCommand({ type: "get_settings", paths: ["modelRoles"] })).toBe(true);
		expect(isConfigRpcCommand({ type: "set_setting", path: "modelRoles", value: {} })).toBe(true);
		expect(isConfigRpcCommand({ type: "set_model_role", role: "plan", modelId: "openai/gpt" })).toBe(true);
		expect(isConfigRpcCommand({ type: "set_model_role", role: "plan", modelId: null })).toBe(true);
		expect(isConfigRpcCommand({ type: "get_plugins" })).toBe(false);
	});

	it("loads requested settings through omp config list", async () => {
		const runCli = vi.fn(async () => JSON.stringify(configList));
		const command: Extract<RpcCommand, { type: "get_settings" }> = {
			id: "settings-1",
			type: "get_settings",
			paths: ["modelRoles", "cycleOrder"],
		};

		const response = await executeConfigRpcCommand(command, runCli);

		expect(runCli).toHaveBeenCalledWith(["config", "list", "--json"]);
		expect(response).toEqual({
			id: "settings-1",
			type: "response",
			command: "get_settings",
			success: true,
			data: {
				values: {
					modelRoles: { plan: "anthropic/claude-sonnet" },
					cycleOrder: ["smol", "default", "slow"],
				},
			},
		});
	});

	it("serializes record settings and returns the persisted CLI value", async () => {
		const backend = configBackend({ modelRoles: { plan: "anthropic/claude" } });
		const response = await executeConfigRpcCommand({
			id: "settings-2", type: "set_setting", path: "modelRoles", value: { plan: "openai/gpt-5" },
		}, backend.runCli);

		expect(backend.values.modelRoles).toEqual({ plan: "openai/gpt-5" });
		expect(response).toMatchObject({
			id: "settings-2", command: "set_setting", success: true,
			data: { path: "modelRoles", value: { plan: "openai/gpt-5" } },
		});
	});

	it.each([
		{ path: "temperature", value: -1 },
		{ path: "systemPrompt", value: "-leading-hyphen" },
	])("persists option-like $path values through the active CLI parser", async ({ path, value }) => {
		const backend = configBackend({ temperature: 0, systemPrompt: "" });
		const response = await executeConfigRpcCommand({ type: "set_setting", path, value }, backend.runCli);
		expect(response).toMatchObject({ success: true, data: { path, value } });
		expect(backend.values[path]).toBe(value);
	});

	it("preserves another window's completed role save and siblings when clearing", async () => {
		const backend = configBackend({ modelRoles: { task: "other/task" } });
		const first = await executeConfigRpcCommand({
			type: "set_model_role", role: "plan", modelId: "anthropic/claude",
		}, backend.runCli);
		const second = await executeConfigRpcCommand({
			type: "set_model_role", role: "default", modelId: "openai/gpt",
		}, args => backend.runCli(args));
		const cleared = await executeConfigRpcCommand({
			type: "set_model_role", role: "plan", modelId: null,
		}, backend.runCli);
		expect(first).toMatchObject({ success: true, data: { assignments: { task: "other/task", plan: "anthropic/claude" } } });
		expect(second).toMatchObject({
			success: true, data: { assignments: { task: "other/task", plan: "anthropic/claude", default: "openai/gpt" } },
		});
		expect(cleared).toMatchObject({ success: true, data: { assignments: { task: "other/task", default: "openai/gpt" } } });
		expect(backend.values.modelRoles).toEqual({ task: "other/task", default: "openai/gpt" });
	});

	it("serializes concurrent windows before reading the current role map", async () => {
		const backend = configBackend({ modelRoles: { task: "other/task" } });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = executeConfigRpcCommand({ type: "set_model_role", role: "plan", modelId: "anthropic/claude" }, async args => {
			if (args[1] === "set") { entered.resolve(); await release.promise; }
			return backend.runCli(args);
		});
		await entered.promise;
		const second = executeConfigRpcCommand({
			type: "set_model_role", role: "default", modelId: "openai/gpt",
		}, args => backend.runCli(args));
		release.resolve();
		const responses = await Promise.all([first, second]);
		expect(responses[1]).toMatchObject({
			success: true, data: { assignments: { task: "other/task", plan: "anthropic/claude", default: "openai/gpt" } },
		});
		expect(backend.values.modelRoles).toEqual({ task: "other/task", plan: "anthropic/claude", default: "openai/gpt" });
	});

	it("serializes intentional whole-map replacement against role deltas", async () => {
		const backend = configBackend({ modelRoles: { task: "old/task" } });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const replacement = executeConfigRpcCommand({
			type: "set_setting", path: "modelRoles", value: { slow: "replacement/model" },
		}, async args => {
			if (args[1] === "set") { entered.resolve(); await release.promise; }
			return backend.runCli(args);
		});
		await entered.promise;
		const delta = executeConfigRpcCommand({
			type: "set_model_role", role: "plan", modelId: "anthropic/claude",
		}, backend.runCli);
		release.resolve();
		await Promise.all([replacement, delta]);
		expect(backend.values.modelRoles).toEqual({ slow: "replacement/model", plan: "anthropic/claude" });

		await executeConfigRpcCommand({
			type: "set_setting", path: "modelRoles", value: { default: "explicit/replacement" },
		}, backend.runCli);
		expect(backend.values.modelRoles).toEqual({ default: "explicit/replacement" });
	});

	it("does not poison queued saves after a rejected role write", async () => {
		const backend = configBackend({ modelRoles: { task: "other/task" } });
		const failed = executeConfigRpcCommand({
			type: "set_model_role", role: "plan", modelId: "anthropic/claude",
		}, async args => {
			if (args[1] === "set") throw new Error("permission denied");
			return backend.runCli(args);
		});
		const saved = executeConfigRpcCommand({
			type: "set_model_role", role: "default", modelId: "openai/gpt",
		}, backend.runCli);
		expect(await failed).toMatchObject({ success: false, error: "permission denied" });
		expect(await saved).toMatchObject({ success: true, data: { assignments: { task: "other/task", default: "openai/gpt" } } });
		expect(backend.values.modelRoles).toEqual({ task: "other/task", default: "openai/gpt" });
	});

	it("derives a usable advanced schema from config list metadata", async () => {
		const runCli = vi.fn(async () => JSON.stringify(configList));
		const command: Extract<RpcCommand, { type: "get_settings_schema" }> = {
			type: "get_settings_schema",
		};

		const response = await executeConfigRpcCommand(command, runCli);

		expect(response).toMatchObject({
			success: true,
			data: {
				tabs: [],
				entries: expect.arrayContaining([
					expect.objectContaining({ path: "theme", type: "enum", value: "dark", description: "Active theme" }),
				]),
			},
		});
	});

	it("replaces a pinned runtime role and preserves fresh persisted siblings when assigning and clearing", async () => {
		const backend = nativeRoleBackend({ task: "old/task", smol: "persisted/smol" });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const firstSession = backend.session({ smol: "runtime/A", slow: "runtime/slow" }, async () => {
			entered.resolve();
			await release.promise;
		});
		const staleSession = backend.session({ smol: "stale/A" });
		const runCli = async () => { throw new Error("Local roles must not use a differently configured CLI"); };
		const first = executeConfigRpcCommand({
			type: "set_model_role", role: "smol", modelId: "selected/B",
		}, runCli, firstSession.runNative);
		await entered.promise;
		backend.disk.assignments = { ...backend.disk.assignments, task: "external/task", plan: "external/plan" };
		release.resolve();
		const assignments = {
			task: "external/task", smol: "selected/B", plan: "external/plan", slow: "runtime/slow",
		};
		expect(await first).toMatchObject({ success: true, data: { assignments } });
		expect(firstSession.effective()).toEqual(assignments);
		expect(backend.disk.assignments).toEqual({
			task: "external/task", smol: "selected/B", plan: "external/plan",
		});
		const cleared = await executeConfigRpcCommand({
			type: "set_model_role", role: "smol", modelId: null,
		}, runCli, staleSession.runNative);
		expect(cleared).toMatchObject({
			success: true, data: { assignments: { task: "external/task", plan: "external/plan" } },
		});
		expect(staleSession.effective()).toEqual({ task: "external/task", plan: "external/plan" });
		expect(backend.disk.assignments).toEqual(staleSession.effective());
	});

	it("serializes local whole-map replacements with deltas", async () => {
		const backend = nativeRoleBackend({ task: "old/task" });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const replacementSession = backend.session({}, async () => { entered.resolve(); await release.promise; });
		const staleSession = backend.session();
		const runCli = async () => { throw new Error("Local roles must not use the CLI"); };
		const replacement = executeConfigRpcCommand({
			id: "replace", type: "set_setting", path: "modelRoles", value: { slow: "replacement/model" },
		}, runCli, replacementSession.runNative);
		await entered.promise;
		const delta = executeConfigRpcCommand({
			type: "set_model_role", role: "plan", modelId: "anthropic/claude",
		}, runCli, staleSession.runNative);
		release.resolve();
		const responses = await Promise.all([replacement, delta]);
		expect(responses[1]).toMatchObject({
			success: true, data: { assignments: { slow: "replacement/model", plan: "anthropic/claude" } },
		});
		expect(backend.disk.assignments).toEqual({ slow: "replacement/model", plan: "anthropic/claude" });
	});

	it("reports native role rejection without falling back to a disk-only write", async () => {
		const backend = configBackend({ modelRoles: { task: "other/task" } });
		const response = await executeConfigRpcCommand({
			id: "role-failed", type: "set_model_role", role: "plan", modelId: "anthropic/claude",
		}, backend.runCli, async () => ({
			type: "response", command: "set_model_role", success: false, error: "permission denied", code: "write_denied",
		}));
		expect(response).toEqual({
			id: "role-failed", type: "response", command: "set_model_role",
			success: false, error: "permission denied", code: "write_denied",
		});
		expect(backend.values.modelRoles).toEqual({ task: "other/task" });
		const saved = await executeConfigRpcCommand({
			type: "set_model_role", role: "default", modelId: "openai/gpt",
		}, backend.runCli);
		expect(saved).toMatchObject({ success: true, data: { assignments: { task: "other/task", default: "openai/gpt" } } });
	});

	it("preserves native readback failures instead of reporting an unverified role save", async () => {
		const response = await executeConfigRpcCommand({
			id: "read-failed", type: "set_model_role", role: "smol", modelId: "selected/B",
		}, async () => { throw new Error("Unexpected CLI access"); }, async command => ({
			type: "response", command: command.type,
			...(command.type === "set_model_role"
				? { success: true as const, data: { role: "smol", modelId: "selected/B" } }
				: { success: false as const, error: "settings unavailable", code: "read_denied" }),
		}));
		expect(response).toEqual({
			id: "read-failed", type: "response", command: "set_model_role",
			success: false, error: "settings unavailable", code: "read_denied",
		});
	});

	it("rejects malformed native assignments instead of exposing them to role helpers", async () => {
		const response = await executeConfigRpcCommand({
			type: "set_model_role", role: "smol", modelId: "selected/B",
		}, async () => { throw new Error("Unexpected CLI access"); }, async command => ({
			type: "response", command: command.type, success: true,
			data: command.type === "set_model_role"
				? { role: "smol", modelId: "selected/B" }
				: { values: { modelRoles: { smol: 42 } } },
		}));
		expect(response).toMatchObject({ command: "set_model_role", success: false, error: expect.any(String) });
	});
});
