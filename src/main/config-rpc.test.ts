import { parseArgs } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { RpcCommand } from "../shared/rpc-types";
import { executeConfigRpcCommand, isConfigRpcCommand } from "./config-rpc";

const configList = {
	modelRoles: { value: { plan: "anthropic/claude-sonnet" }, type: "record", description: "" },
	modelTags: { value: {}, type: "record", description: "" },
	cycleOrder: { value: ["smol", "default", "slow"], type: "array", description: "" },
	theme: { value: "dark", type: "enum", description: "Active theme" },
};

function configBackend(
	initial: Record<string, unknown>,
	shadow?: { key: string; value: unknown; overriddenBy?: string; fallbackEnv?: string },
) {
	const values = { ...initial };
	const runCli = async (args: string[]): Promise<string> => {
		const { positionals } = parseArgs({
			args: args.slice(2),
			options: { json: { type: "boolean" } },
			allowPositionals: true,
		});
		const [key, input] = positionals;
		if (!key) throw new Error("Missing config key");
		const current = values[key];
		const type =
			typeof current === "number"
				? "number"
				: typeof current === "string"
					? "string"
					: typeof current === "boolean"
						? "boolean"
						: "record";
		if (args[1] === "get") {
			return JSON.stringify({ key, value: shadow?.key === key ? shadow.value : current, type, description: "" });
		}
		if (args[1] !== "set" || input === undefined) throw new Error("Invalid config invocation");
		values[key] = type === "string" ? input : JSON.parse(input);
		return JSON.stringify({
			key,
			value: values[key],
			...(shadow?.key === key ? { overriddenBy: shadow.overriddenBy, fallbackEnv: shadow.fallbackEnv } : {}),
		});
	};
	return { values, runCli };
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

	it("serializes record settings and returns the effective CLI value after saving", async () => {
		const backend = configBackend({ modelRoles: { plan: "anthropic/claude" } });
		const response = await executeConfigRpcCommand(
			{
				id: "settings-2",
				type: "set_setting",
				path: "modelRoles",
				value: { plan: "openai/gpt-5" },
			},
			backend.runCli,
		);

		expect(backend.values.modelRoles).toEqual({ plan: "openai/gpt-5" });
		expect(response).toMatchObject({
			id: "settings-2",
			command: "set_setting",
			success: true,
			data: { path: "modelRoles", value: { plan: "openai/gpt-5" } },
		});
	});

	it.each([
		{
			path: "auth.broker.url",
			savedValue: "http://saved.test",
			effectiveValue: "http://env.test",
			overriddenBy: "OMP_AUTH_BROKER_URL",
		},
		{ path: "theme", savedValue: "dark", effectiveValue: "light", overriddenBy: "project" },
		{ path: "compaction.enabled", savedValue: true, effectiveValue: false, overriddenBy: "overlay" },
		{ path: "theme", savedValue: "dark", effectiveValue: "light", overriddenBy: "runtime" },
	])(
		"reports a persisted $path shadowed by $overriddenBy without active success",
		async ({ path, savedValue, effectiveValue, overriddenBy }) => {
			const backend = configBackend({ [path]: savedValue }, { key: path, value: effectiveValue, overriddenBy });
			const response = await executeConfigRpcCommand(
				{
					type: "set_setting",
					path,
					value: savedValue,
				},
				backend.runCli,
			);
			expect(backend.values[path]).toEqual(savedValue);
			expect(response).toMatchObject({
				success: false,
				code: "setting_not_applied",
				data: { path, saved: true, savedValue, effectiveValue, overriddenBy },
			});
		},
	);

	it("preserves fallback environment metadata when clearing exposes the fallback value", async () => {
		const backend = configBackend(
			{ "searxng.token": "old" },
			{
				key: "searxng.token",
				value: "environment-key",
				fallbackEnv: "SEARXNG_TOKEN",
			},
		);
		const response = await executeConfigRpcCommand(
			{
				type: "set_setting",
				path: "searxng.token",
				value: "",
			},
			backend.runCli,
		);
		expect(backend.values["searxng.token"]).toBe("");
		expect(response).toMatchObject({
			success: false,
			code: "setting_not_applied",
			data: { saved: true, savedValue: "", effectiveValue: "environment-key", fallbackEnv: "SEARXNG_TOKEN" },
		});
	});

	it("does not report an override as active success even when the effective value equals the saved value", async () => {
		const backend = configBackend({ theme: "dark" }, { key: "theme", value: "light", overriddenBy: "project" });
		expect(
			await executeConfigRpcCommand(
				{
					type: "set_setting",
					path: "theme",
					value: "light",
				},
				backend.runCli,
			),
		).toMatchObject({ success: false, code: "setting_not_applied" });
	});

	it("uses effective readback even when the set response has no precedence metadata", async () => {
		const backend = configBackend({ theme: "dark" }, { key: "theme", value: "light" });
		expect(
			await executeConfigRpcCommand(
				{
					type: "set_setting",
					path: "theme",
					value: "dark",
				},
				backend.runCli,
			),
		).toMatchObject({
			success: false,
			code: "setting_not_applied",
			data: { savedValue: "dark", effectiveValue: "light" },
		});
	});

	it("keeps saved metadata when effective readback fails rather than claiming active success", async () => {
		const backend = configBackend({ theme: "dark" });
		let saved = false;
		const response = await executeConfigRpcCommand(
			{ type: "set_setting", path: "theme", value: "light" },
			async args => {
				if (saved && args[1] === "get") throw new Error("connection lost");
				const output = await backend.runCli(args);
				if (args[1] === "set") saved = true;
				return output;
			},
		);
		expect(backend.values.theme).toBe("light");
		expect(response).toMatchObject({
			success: false,
			code: "setting_effect_unverified",
			data: { path: "theme", saved: true, savedValue: "light" },
		});
		expect(response.success ? "" : response.error).toContain("connection lost");
	});

	it.each([
		{ role: "plan", modelId: "global/new-plan", savedValue: { plan: "global/new-plan", task: "project/task" } },
		{ role: "plan", modelId: null, savedValue: { task: "project/task" } },
	])(
		"does not apply a saved role-map delta shadowed by project settings ($modelId)",
		async ({ role, modelId, savedValue }) => {
			const backend = configBackend(
				{ modelRoles: { plan: "global/old-plan" } },
				{
					key: "modelRoles",
					value: { plan: "project/plan", task: "project/task" },
					overriddenBy: "project",
				},
			);
			const response = await executeConfigRpcCommand({ type: "set_model_role", role, modelId }, backend.runCli);
			expect(backend.values.modelRoles).toEqual(savedValue);
			expect(response).toMatchObject({
				success: false,
				code: "setting_not_applied",
				data: {
					path: "modelRoles",
					saved: true,
					savedValue,
					overriddenBy: "project",
					effectiveValue: { plan: "project/plan", task: "project/task" },
				},
			});
			expect(response.data).not.toHaveProperty("assignments");
		},
	);

	it("compares role maps without treating key order as a changed effective value", async () => {
		const backend = configBackend(
			{ modelRoles: { task: "other/task" } },
			{
				key: "modelRoles",
				value: { plan: "global/plan", task: "other/task" },
			},
		);
		expect(
			await executeConfigRpcCommand(
				{
					type: "set_model_role",
					role: "plan",
					modelId: "global/plan",
				},
				backend.runCli,
			),
		).toMatchObject({
			success: true,
			data: { assignments: { plan: "global/plan", task: "other/task" } },
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
		const first = await executeConfigRpcCommand(
			{
				type: "set_model_role",
				role: "plan",
				modelId: "anthropic/claude",
			},
			backend.runCli,
		);
		const second = await executeConfigRpcCommand(
			{
				type: "set_model_role",
				role: "default",
				modelId: "openai/gpt",
			},
			args => backend.runCli(args),
		);
		const cleared = await executeConfigRpcCommand(
			{
				type: "set_model_role",
				role: "plan",
				modelId: null,
			},
			backend.runCli,
		);
		expect(first).toMatchObject({
			success: true,
			data: { assignments: { task: "other/task", plan: "anthropic/claude" } },
		});
		expect(second).toMatchObject({
			success: true,
			data: { assignments: { task: "other/task", plan: "anthropic/claude", default: "openai/gpt" } },
		});
		expect(cleared).toMatchObject({
			success: true,
			data: { assignments: { task: "other/task", default: "openai/gpt" } },
		});
		expect(backend.values.modelRoles).toEqual({ task: "other/task", default: "openai/gpt" });
	});

	it("serializes concurrent windows before reading the current role map", async () => {
		const backend = configBackend({ modelRoles: { task: "other/task" } });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = executeConfigRpcCommand(
			{ type: "set_model_role", role: "plan", modelId: "anthropic/claude" },
			async args => {
				if (args[1] === "set") {
					entered.resolve();
					await release.promise;
				}
				return backend.runCli(args);
			},
		);
		await entered.promise;
		const second = executeConfigRpcCommand(
			{
				type: "set_model_role",
				role: "default",
				modelId: "openai/gpt",
			},
			args => backend.runCli(args),
		);
		release.resolve();
		const responses = await Promise.all([first, second]);
		expect(responses[1]).toMatchObject({
			success: true,
			data: { assignments: { task: "other/task", plan: "anthropic/claude", default: "openai/gpt" } },
		});
		expect(backend.values.modelRoles).toEqual({
			task: "other/task",
			plan: "anthropic/claude",
			default: "openai/gpt",
		});
	});

	it("serializes intentional whole-map replacement against role deltas", async () => {
		const backend = configBackend({ modelRoles: { task: "old/task" } });
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const replacement = executeConfigRpcCommand(
			{
				type: "set_setting",
				path: "modelRoles",
				value: { slow: "replacement/model" },
			},
			async args => {
				if (args[1] === "set") {
					entered.resolve();
					await release.promise;
				}
				return backend.runCli(args);
			},
		);
		await entered.promise;
		const delta = executeConfigRpcCommand(
			{
				type: "set_model_role",
				role: "plan",
				modelId: "anthropic/claude",
			},
			backend.runCli,
		);
		release.resolve();
		await Promise.all([replacement, delta]);
		expect(backend.values.modelRoles).toEqual({ slow: "replacement/model", plan: "anthropic/claude" });

		await executeConfigRpcCommand(
			{
				type: "set_setting",
				path: "modelRoles",
				value: { default: "explicit/replacement" },
			},
			backend.runCli,
		);
		expect(backend.values.modelRoles).toEqual({ default: "explicit/replacement" });
	});

	it("does not poison queued saves after a rejected role write", async () => {
		const backend = configBackend({ modelRoles: { task: "other/task" } });
		const failed = executeConfigRpcCommand(
			{
				type: "set_model_role",
				role: "plan",
				modelId: "anthropic/claude",
			},
			async args => {
				if (args[1] === "set") throw new Error("permission denied");
				return backend.runCli(args);
			},
		);
		const saved = executeConfigRpcCommand(
			{
				type: "set_model_role",
				role: "default",
				modelId: "openai/gpt",
			},
			backend.runCli,
		);
		expect(await failed).toMatchObject({ success: false, error: "permission denied" });
		expect(await saved).toMatchObject({
			success: true,
			data: { assignments: { task: "other/task", default: "openai/gpt" } },
		});
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
		const data = response.data;
		if (!data || typeof data !== "object" || !("entries" in data) || !Array.isArray(data.entries)) {
			throw new Error("Missing settings schema entries");
		}
		expect(data.entries.every(entry => !Object.hasOwn(entry, "default"))).toBe(true);
	});
});
