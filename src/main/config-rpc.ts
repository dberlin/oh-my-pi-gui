import { z } from "zod";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";

const SettingTypeSchema = z.enum(["boolean", "string", "number", "enum", "array", "record"]);
const ConfigEntrySchema = z.object({
	value: z.unknown().optional(),
	redacted: z.literal(true).optional(),
	type: SettingTypeSchema,
	description: z.string(),
});
const ConfigListSchema = z.record(z.string(), ConfigEntrySchema);
const ConfigGetSchema = ConfigEntrySchema.extend({ key: z.string() });
const ConfigSetSchema = z.object({ key: z.string(), value: z.unknown() });
const ConfigRpcCommandSchema = z.discriminatedUnion("type", [
	z.object({ id: z.string().optional(), type: z.literal("get_settings"), paths: z.array(z.string()).optional() }),
	z.object({ id: z.string().optional(), type: z.literal("get_settings_schema") }),
	z.object({ id: z.string().optional(), type: z.literal("set_setting"), path: z.string(), value: z.unknown() }),
]);

export type ConfigRpcCommand = Extract<RpcCommand, { type: "get_settings" | "get_settings_schema" | "set_setting" }>;
export type ConfigCliRunner = (args: string[]) => Promise<string>;

export function isConfigRpcCommand(command: unknown): command is ConfigRpcCommand {
	return ConfigRpcCommandSchema.safeParse(command).success;
}

function parseJson(output: string): unknown {
	return JSON.parse(output.trim());
}

function cliValue(value: unknown, type: z.infer<typeof SettingTypeSchema>): string {
	if (type === "array" || type === "record") return JSON.stringify(value);
	if ((type === "string" || type === "enum") && typeof value !== "string") {
		throw new TypeError(`Expected ${type} setting value`);
	}
	return String(value);
}

export async function executeConfigRpcCommand(
	command: ConfigRpcCommand,
	runCli: ConfigCliRunner,
): Promise<RpcResponse> {
	try {
		if (command.type === "get_settings" || command.type === "get_settings_schema") {
			const config = ConfigListSchema.parse(parseJson(await runCli(["config", "list", "--json"])));
			if (command.type === "get_settings") {
				const paths = command.paths ? new Set(command.paths) : null;
				const values: Record<string, unknown> = {};
				for (const [path, entry] of Object.entries(config)) {
					if ((!paths || paths.has(path)) && entry.redacted !== true) values[path] = entry.value;
				}
				return {
					id: command.id,
					type: "response",
					command: command.type,
					success: true,
					data: { values },
				};
			}

			return {
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data: {
					entries: Object.entries(config).map(([path, entry]) => ({
						path,
						type: entry.type,
						value: entry.value,
						default: entry.value,
						description: entry.description,
						secret: entry.redacted === true,
						advanced: true,
					})),
					tabs: [],
				},
			};
		}

		const current = ConfigGetSchema.parse(parseJson(await runCli(["config", "get", command.path, "--json"])));
		const persisted = ConfigSetSchema.parse(
			parseJson(await runCli(["config", "set", command.path, cliValue(command.value, current.type), "--json"])),
		);
		return {
			id: command.id,
			type: "response",
			command: command.type,
			success: true,
			data: { path: persisted.key, value: persisted.value },
		};
	} catch (cause) {
		return {
			id: command.id,
			type: "response",
			command: command.type,
			success: false,
			error: cause instanceof Error ? cause.message : String(cause),
		};
	}
}
