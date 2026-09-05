import { describe, expect, it, vi } from "vitest";
import type { RpcCommand } from "../shared/rpc-types";
import { executeConfigRpcCommand, isConfigRpcCommand } from "./config-rpc";

const configList = {
	modelRoles: { value: { plan: "anthropic/claude-sonnet" }, type: "record", description: "" },
	modelTags: { value: {}, type: "record", description: "" },
	cycleOrder: { value: ["smol", "default", "slow"], type: "array", description: "" },
	theme: { value: "dark", type: "enum", description: "Active theme" },
};

describe("config RPC compatibility", () => {
	it("recognizes only CLI-backed settings commands", () => {
		expect(isConfigRpcCommand({ type: "get_settings", paths: ["modelRoles"] })).toBe(true);
		expect(isConfigRpcCommand({ type: "set_setting", path: "modelRoles", value: {} })).toBe(true);
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
		const runCli = vi.fn(async (args: string[]) => {
			if (args[1] === "get") {
				return JSON.stringify({ key: "modelRoles", value: {}, type: "record", description: "" });
			}
			return JSON.stringify({ key: "modelRoles", value: { plan: "openai/gpt-5" } });
		});
		const command: Extract<RpcCommand, { type: "set_setting" }> = {
			id: "settings-2",
			type: "set_setting",
			path: "modelRoles",
			value: { plan: "openai/gpt-5" },
		};

		const response = await executeConfigRpcCommand(command, runCli);

		expect(runCli.mock.calls).toEqual([
			[["config", "get", "modelRoles", "--json"]],
			[["config", "set", "modelRoles", '{"plan":"openai/gpt-5"}', "--json"]],
		]);
		expect(response).toMatchObject({
			id: "settings-2",
			command: "set_setting",
			success: true,
			data: { value: { plan: "openai/gpt-5" } },
		});
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
});
