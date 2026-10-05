import { isDeepStrictEqual } from "node:util";
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
const ConfigSetSchema = z.object({
	key: z.string(),
	value: z.unknown(),
	overriddenBy: z.string().optional(),
	fallbackEnv: z.string().optional(),
});
const ModelRoleAssignmentsSchema = z.record(z.string(), z.string());
const ConfigRpcCommandSchema = z.discriminatedUnion("type", [
	z.object({ id: z.string().optional(), type: z.literal("get_settings"), paths: z.array(z.string()).optional() }),
	z.object({ id: z.string().optional(), type: z.literal("get_settings_schema") }),
	z.object({ id: z.string().optional(), type: z.literal("set_setting"), path: z.string(), value: z.unknown() }),
	z.object({
		id: z.string().optional(),
		type: z.literal("set_model_role"),
		role: z.string(),
		modelId: z.string().nullable(),
	}),
]);

export type ConfigRpcCommand = Extract<
	RpcCommand,
	{ type: "get_settings" | "get_settings_schema" | "set_setting" | "set_model_role" }
>;
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

// One main-process queue spans windows and profiles, including explicit role-map replacements.
let roleWriteQueue: Promise<void> = Promise.resolve();

function serializeRoleWrite(write: () => Promise<RpcResponse>): Promise<RpcResponse> {
	const result = roleWriteQueue.then(write);
	roleWriteQueue = result.then(
		() => {},
		() => {},
	);
	return result;
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
						description: entry.description,
						secret: entry.redacted === true,
						advanced: true,
					})),
					tabs: [],
				},
			};
		}

		const write = async (): Promise<RpcResponse> => {
			const path = command.type === "set_model_role" ? "modelRoles" : command.path;
			const current = ConfigGetSchema.parse(parseJson(await runCli(["config", "get", path, "--json"])));
			let value: unknown;
			if (command.type === "set_model_role") {
				const assignments = ModelRoleAssignmentsSchema.parse(current.value ?? {});
				if (command.modelId === null) delete assignments[command.role];
				else assignments[command.role] = command.modelId;
				value = assignments;
			} else {
				value = command.value;
			}
			const persisted = ConfigSetSchema.parse(
				parseJson(await runCli(["config", "set", path, "--json", "--", cliValue(value, current.type)])),
			);
			const savedData = {
				path: persisted.key,
				saved: true,
				savedValue: persisted.value,
				...(persisted.overriddenBy ? { overriddenBy: persisted.overriddenBy } : {}),
				...(persisted.fallbackEnv ? { fallbackEnv: persisted.fallbackEnv } : {}),
			};
			let effective: z.infer<typeof ConfigGetSchema>;
			try {
				effective = ConfigGetSchema.parse(parseJson(await runCli(["config", "get", persisted.key, "--json"])));
			} catch (cause) {
				return {
					id: command.id,
					type: "response",
					command: command.type,
					success: false,
					code: "setting_effect_unverified",
					error: `Saved ${persisted.key} globally, but its effective value could not be confirmed: ${cause instanceof Error ? cause.message : String(cause)}`,
					data: savedData,
				};
			}
			if (persisted.overriddenBy || persisted.fallbackEnv || !isDeepStrictEqual(persisted.value, effective.value)) {
				const source = persisted.overriddenBy ?? persisted.fallbackEnv;
				return {
					id: command.id,
					type: "response",
					command: command.type,
					success: false,
					code: "setting_not_applied",
					error: source
						? `Saved ${persisted.key} globally, but ${source} still supplies the effective value. The saved value is not applied.`
						: `Saved ${persisted.key} globally, but the effective value differs. The saved value is not applied.`,
					data: { ...savedData, effectiveValue: effective.value },
				};
			}
			return {
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data:
					command.type === "set_model_role"
						? { assignments: ModelRoleAssignmentsSchema.parse(effective.value) }
						: { path: effective.key, value: effective.value },
			};
		};
		return await (command.type === "set_model_role" || command.path === "modelRoles"
			? serializeRoleWrite(write)
			: write());
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
