import { z } from "zod";
import type { ModelInfo, ModelRoleCandidate, ModelRoleEntry, ModelRoleMetadata } from "../../shared/rpc-types";
import type { TabRpc } from "./tab-rpc";

const ModelRoleSettingsDataSchema = z.object({
	values: z
		.object({
			modelRoles: z.record(z.string(), z.string()).optional().default({}),
			modelTags: z
				.record(
					z.string(),
					z.object({
						name: z.string(),
						color: z.string().optional(),
						hidden: z.boolean().optional(),
					}),
				)
				.optional()
				.default({}),
			cycleOrder: z.array(z.string()).optional().default([]),
		})
		.passthrough(),
	provenance: z
		.record(
			z.string(),
			z
				.object({
					layers: z.array(z.enum(["global", "project", "overlay", "runtime"])),
				})
				.passthrough(),
		)
		.optional()
		.default({}),
});
const ModelRoleAssignmentDataSchema = z.object({ assignments: z.record(z.string(), z.string()) });

export interface ModelRoleSettingsSnapshot {
	assignments: Record<string, string>;
	metadata: ModelRoleMetadata[];
	roles: ModelRoleEntry[];
}

const BUILTIN_ROLE_METADATA: readonly ModelRoleMetadata[] = [
	{ id: "default", tag: "DEFAULT", name: "Default", color: "success", section: "chat" },
	{ id: "smol", tag: "SMOL", name: "Fast", color: "warning", section: "chat" },
	{ id: "slow", tag: "SLOW", name: "Thinking", color: "accent", section: "chat" },
	{ id: "vision", tag: "VISION", name: "Vision", color: "error", section: "chat" },
	{ id: "plan", tag: "PLAN", name: "Architect", color: "muted", section: "chat" },
	{ id: "commit", tag: "COMMIT", name: "Commit", color: "dim", section: "chat" },
	{ id: "tiny", tag: "TINY", name: "Tiny", color: "dim", section: "chat" },
	{ id: "memory", tag: "MEMORY", name: "Memory", color: "dim", section: "chat" },
	{ id: "task", tag: "TASK", name: "Subtask", color: "muted", section: "chat" },
	{ id: "advisor", tag: "ADVISOR", name: "Advisor", color: "accent", section: "chat" },
	{ id: "image", tag: "IMAGE", name: "Image generation", color: "accent", section: "kind" },
	{ id: "web", tag: "WEB", name: "Web search", color: "success", section: "kind" },
	{ id: "speech", tag: "SPEECH", name: "Speech", color: "warning", section: "kind" },
	{ id: "dictation", tag: "DICTATION", name: "Dictation", color: "warning", section: "kind" },
	{ id: "judge", tag: "JUDGE", name: "Judge", color: "muted", section: "kind" },
];

function roleCandidates(role: string, models: readonly ModelInfo[]): ModelRoleCandidate[] {
	const candidates: ModelRoleCandidate[] = [];
	for (const model of models) {
		const kind = model.kind ?? "chat";
		let eligible: boolean;
		switch (role) {
			case "tiny":
			case "memory":
				eligible = kind === "tiny" || kind === "chat";
				break;
			case "image":
				eligible = kind === "image";
				break;
			case "web":
				eligible = kind === "search" || (kind === "chat" && model.webSearch !== undefined);
				break;
			case "speech":
				eligible = kind === "tts";
				break;
			case "dictation":
				eligible = kind === "stt";
				break;
			case "judge":
				eligible = kind === "judge" || kind === "tiny" || kind === "chat";
				break;
			default:
				eligible = kind === "chat";
		}
		if (eligible && kind !== "embedding" && kind !== "rerank" && kind !== "video") {
			candidates.push({ provider: model.provider, id: model.id, name: model.name ?? model.id, kind });
		}
	}
	return candidates;
}

export function modelRoleSettingsSnapshot(data: unknown, models: readonly ModelInfo[] = []): ModelRoleSettingsSnapshot {
	const parsed = ModelRoleSettingsDataSchema.safeParse(data);
	if (!parsed.success) throw new Error("Malformed model role settings response");
	const { values, provenance } = parsed.data;
	const assignments: Record<string, string> = {};
	for (const [role, selector] of Object.entries(values.modelRoles)) {
		if (selector.trim()) assignments[role] = selector;
	}
	const tags = values.modelTags;
	const cycleOrder = values.cycleOrder.filter(role => role.length > 0);
	const metadataById: Record<string, ModelRoleMetadata> = {};
	const roleIds: string[] = [];
	const addRole = (id: string): void => {
		if (metadataById[id]) return;
		roleIds.push(id);
		metadataById[id] = { id, name: id, tag: id.toUpperCase(), color: "muted", section: "chat" };
	};
	for (const metadata of BUILTIN_ROLE_METADATA) {
		addRole(metadata.id);
		metadataById[metadata.id] = { ...metadata };
	}
	for (const id of cycleOrder) addRole(id);
	for (const id of Object.keys(assignments)) addRole(id);
	for (const id of Object.keys(tags)) addRole(id);
	for (const [id, tag] of Object.entries(tags)) {
		const current = metadataById[id];
		if (!current) continue;
		metadataById[id] = {
			...current,
			name: tag.name || current.name,
			...(tag.color ? { color: tag.color } : {}),
			...(tag.hidden !== undefined ? { hidden: tag.hidden } : {}),
		};
	}
	const source = provenance.modelRoles;
	const metadata = roleIds
		.map(id => metadataById[id])
		.filter((entry): entry is ModelRoleMetadata => entry !== undefined);
	return {
		assignments,
		metadata,
		roles: metadata.map(role => ({
			...role,
			model: assignments[role.id],
			source: Object.hasOwn(assignments, role.id) ? (source?.layers.at(-1) ?? "settings") : "catalog",
			candidates: roleCandidates(role.id, models),
		})),
	};
}

export async function loadModelRoleSettings(
	rpc: TabRpc,
	models: readonly ModelInfo[] = [],
): Promise<ModelRoleSettingsSnapshot> {
	const response = await rpc.getSettings(["modelRoles", "modelTags", "cycleOrder"]);
	if (!response.success) throw new Error(response.error);
	return modelRoleSettingsSnapshot(response.data, models);
}

export async function saveModelRoleAssignment(
	rpc: TabRpc,
	role: string,
	modelId: string | null,
): Promise<Record<string, string>> {
	const response = await rpc.setModelRole(role, modelId);
	if (!response.success) throw new Error(response.error);
	const parsed = ModelRoleAssignmentDataSchema.safeParse(response.data);
	if (!parsed.success) throw new Error("Malformed model role assignment response");
	return parsed.data.assignments;
}
