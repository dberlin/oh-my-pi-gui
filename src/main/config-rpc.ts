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
const ModelRoleAssignmentsSchema = z.record(z.string(), z.string());
const NativeRoleSettingsSchema = z.object({ values: z.object({ modelRoles: ModelRoleAssignmentsSchema }) });
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
	runNative?: (command: RpcCommand) => Promise<RpcResponse>,
): Promise<RpcResponse> {
	try {
		// Local settings keep native schema, provenance, validation and live-session effects.
		// SSH uses the CLI adapter because remote runtimes need not expose these GUI APIs.
		if (runNative) {
			if (command.type === "set_model_role") {
				return await serializeRoleWrite(async () => {
					const saved = await runNative(command);
					if (!saved.success) return { ...saved, id: command.id, command: command.type };
					// The native per-role setter updates explicit runtime overrides and
					// adopts fresh persisted siblings during flush; a CLI pre-read cannot.
					const settings = await runNative({ type: "get_settings", paths: ["modelRoles"] });
					if (!settings.success) return { ...settings, id: command.id, command: command.type };
					const { values } = NativeRoleSettingsSchema.parse(settings.data);
					return {
						id: command.id,
						type: "response",
						command: command.type,
						success: true,
						data: { assignments: values.modelRoles },
					};
				});
			}
			return await (command.type === "set_setting" && command.path === "modelRoles"
				? serializeRoleWrite(() => runNative(command))
				: runNative(command));
		}
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
			return {
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data:
					command.type === "set_model_role"
						? { assignments: ModelRoleAssignmentsSchema.parse(persisted.value) }
						: { path: persisted.key, value: persisted.value },
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
