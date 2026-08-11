/**
 * Read/write the agent's `models.yml` for third-party provider configuration.
 *
 * The file lives in the agent dir (models.yml preferred, models.yaml
 * fallback) and is parsed with the `yaml` package — the agent watches the
 * file and live-reloads providers on save.
 *
 * Field coverage mirrors the agent's ModelsConfigSchema
 * (coding-agent/src/config/models-config-schema-bundle.ts): every field the
 * GUI renders is written through, and every field it does NOT render
 * (compat beyond extraBody, remoteCompaction, modelOverrides, effortMap,
 * contextPromotionTarget, compactionModel…) is PRESERVED verbatim on save —
 * upserts merge over the existing entry instead of replacing it, so a rich
 * hand-written config never loses data to a GUI edit.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
	CUSTOM_MODEL_EFFORTS,
	CUSTOM_PROVIDER_APIS,
	type CustomProviderApi,
	type CustomProviderDiscovery,
	type CustomProviderInput,
	type CustomProviderModelCost,
	type CustomProviderModelInput,
	type CustomProviderModelThinking,
	type CustomProviderView,
} from "../shared/ipc-types";

export type { CustomProviderInput, CustomProviderModelInput, CustomProviderView };

const MASK_PREVIEW_LEN = 4;

/** Provider ids shipped in the bundled catalog (not user-editable here). */
const BUILTIN_PROVIDERS = new Set([
	"anthropic",
	"openai",
	"gemini",
	"google",
	"groq",
	"mistral",
	"openrouter",
	"deepseek",
	"xai",
	"azure",
	"bedrock",
	"vertex",
	"ollama",
	"lm-studio",
	"fireworks",
	"cerebras",
	"together",
	"cohere",
	"perplexity",
]);

const DISCOVERY_TYPES: ReadonlySet<string> = new Set([
	"ollama",
	"llama.cpp",
	"lm-studio",
	"openai-models-list",
	"proxy",
	"litellm",
]);
const AUTH_MODES: ReadonlySet<string> = new Set(["apiKey", "none", "oauth"]);
const THINKING_MODES: ReadonlySet<string> = new Set([
	"effort",
	"budget",
	"google-level",
	"anthropic-adaptive",
	"anthropic-budget-effort",
]);

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR && process.env.PI_CODING_AGENT_DIR.length > 0
		? process.env.PI_CODING_AGENT_DIR
		: join(homedir(), ".omp", "agent");
}

/** Absolute path to the agent's models file (`models.yml` preferred, `models.yaml` fallback). */
export function modelsPath(): string {
	const dir = agentDir();
	const yml = join(dir, "models.yml");
	if (existsSync(yml)) return yml;
	return join(dir, "models.yaml");
}

interface ModelsFileShape {
	providers?: Record<string, unknown>;
	[other: string]: unknown;
}

function readFile(): ModelsFileShape {
	const file = modelsPath();
	if (!existsSync(file)) return {};
	const parsed = parse(readFileSync(file, "utf8"));
	return parsed && typeof parsed === "object" ? (parsed as ModelsFileShape) : {};
}

function maskApiKey(key: unknown): { hasApiKey: boolean; apiKeyPreview?: string } {
	if (typeof key !== "string" || key.length === 0) return { hasApiKey: false };
	return { hasApiKey: true, apiKeyPreview: `•••${key.slice(-MASK_PREVIEW_LEN)}` };
}

// ============================================================================
// Wire ← file parsing (toView): surface every GUI-editable field, tolerate
// free-form file content (unknown shapes degrade to undefined, never throw).
// ============================================================================

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === "string") out[k] = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function asApi(value: unknown): CustomProviderApi | undefined {
	return typeof value === "string" && (CUSTOM_PROVIDER_APIS as readonly string[]).includes(value)
		? (value as CustomProviderApi)
		: undefined;
}

function asCost(value: unknown): CustomProviderModelCost | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	const cost: CustomProviderModelCost = {};
	if (asNumber(rec.input) !== undefined) cost.input = asNumber(rec.input);
	if (asNumber(rec.output) !== undefined) cost.output = asNumber(rec.output);
	if (asNumber(rec.cacheRead) !== undefined) cost.cacheRead = asNumber(rec.cacheRead);
	if (asNumber(rec.cacheWrite) !== undefined) cost.cacheWrite = asNumber(rec.cacheWrite);
	return Object.keys(cost).length > 0 ? cost : undefined;
}

function asThinking(value: unknown): CustomProviderModelThinking | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	if (typeof rec.mode !== "string" || !THINKING_MODES.has(rec.mode)) return undefined;
	const efforts = Array.isArray(rec.efforts)
		? rec.efforts.filter(
				(e): e is CustomProviderModelThinking["efforts"][number] =>
					typeof e === "string" && (CUSTOM_MODEL_EFFORTS as readonly string[]).includes(e),
			)
		: [];
	if (efforts.length === 0) return undefined;
	const thinking: CustomProviderModelThinking = {
		mode: rec.mode as CustomProviderModelThinking["mode"],
		efforts,
	};
	const defaultLevel = asString(rec.defaultLevel);
	if (defaultLevel && (CUSTOM_MODEL_EFFORTS as readonly string[]).includes(defaultLevel)) {
		thinking.defaultLevel = defaultLevel as CustomProviderModelThinking["defaultLevel"];
	}
	if (typeof rec.supportsDisplay === "boolean") thinking.supportsDisplay = rec.supportsDisplay;
	return thinking;
}

function asInput(value: unknown): Array<"text" | "image"> | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.filter((v): v is "text" | "image" => v === "text" || v === "image");
	return out.length > 0 ? out : undefined;
}

function asDiscovery(value: unknown): CustomProviderDiscovery | undefined {
	if (!value || typeof value !== "object") return undefined;
	const rec = value as Record<string, unknown>;
	if (typeof rec.type !== "string" || !DISCOVERY_TYPES.has(rec.type)) return undefined;
	const discovery: CustomProviderDiscovery = { type: rec.type as CustomProviderDiscovery["type"] };
	const timeoutMs = asNumber(rec.timeoutMs);
	if (timeoutMs !== undefined) discovery.timeoutMs = timeoutMs;
	return discovery;
}

function modelToView(raw: unknown): CustomProviderModelInput | null {
	if (!raw || typeof raw !== "object") return null;
	const m = raw as Record<string, unknown>;
	const id = asString(m.id);
	if (!id) return null;
	const view: CustomProviderModelInput = { id };
	const fields: Array<[keyof CustomProviderModelInput, unknown]> = [
		["name", asString(m.name)],
		["api", asApi(m.api)],
		["baseUrl", asString(m.baseUrl)],
		["reasoning", m.reasoning === true ? true : undefined],
		["thinking", asThinking(m.thinking)],
		["input", asInput(m.input)],
		["supportsTools", asBoolean(m.supportsTools)],
		["cost", asCost(m.cost)],
		["premiumMultiplier", asNumber(m.premiumMultiplier)],
		["contextWindow", asNumber(m.contextWindow)],
		["maxTokens", asNumber(m.maxTokens)],
		["omitMaxOutputTokens", asBoolean(m.omitMaxOutputTokens)],
		["headers", asStringRecord(m.headers)],
	];
	for (const [key, value] of fields) {
		if (value !== undefined) {
			view[key] = value as never;
		}
	}
	return view;
}

function toView(id: string, raw: unknown): CustomProviderView & { apiKey?: string } {
	const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const models: CustomProviderModelInput[] = [];
	if (Array.isArray(rec.models)) {
		for (const m of rec.models) {
			const view = modelToView(m);
			if (view) models.push(view);
		}
	}
	const { hasApiKey, apiKeyPreview } = maskApiKey(rec.apiKey);
	const compat = rec.compat && typeof rec.compat === "object" ? (rec.compat as Record<string, unknown>) : undefined;
	const extraBody =
		compat?.extraBody && typeof compat.extraBody === "object"
			? (compat.extraBody as Record<string, unknown>)
			: undefined;
	const auth = asString(rec.auth);
	return {
		id,
		api: asApi(rec.api) ?? "openai-completions",
		baseUrl: asString(rec.baseUrl) ?? "",
		hasApiKey,
		apiKeyPreview,
		auth: auth && AUTH_MODES.has(auth) ? (auth as CustomProviderView["auth"]) : undefined,
		authHeader: asBoolean(rec.authHeader),
		headers: asStringRecord(rec.headers),
		discovery: asDiscovery(rec.discovery),
		disableStrictTools: asBoolean(rec.disableStrictTools),
		transport: rec.transport === "pi-native" ? "pi-native" : undefined,
		extraBody: extraBody && Object.keys(extraBody).length > 0 ? extraBody : undefined,
		models,
		builtin: BUILTIN_PROVIDERS.has(id),
		apiKey: typeof rec.apiKey === "string" ? rec.apiKey : undefined,
	};
}

/** List configured providers (custom + user overrides), apiKey masked. */
export function listModelsProviders(): CustomProviderView[] {
	const data = readFile();
	const providers = data.providers ?? {};
	return Object.entries(providers).map(([id, raw]) => {
		const { apiKey: _secret, ...view } = toView(id, raw);
		return view;
	});
}

// ============================================================================
// File ← wire writing (upsert): merge over the existing entry. Rendered
// fields are set-or-deleted from the input; unrendered fields (compat minus
// extraBody, remoteCompaction, modelOverrides, effortMap,
// contextPromotionTarget, compactionModel) survive verbatim.
// ============================================================================

function setOrDelete(entry: Record<string, unknown>, key: string, value: unknown): void {
	if (value === undefined || value === "") delete entry[key];
	else entry[key] = value;
}

function mergeModel(existingModels: unknown, input: CustomProviderModelInput): Record<string, unknown> {
	const existing = Array.isArray(existingModels)
		? (existingModels.find(m => m && typeof m === "object" && (m as Record<string, unknown>).id === input.id) as
				| Record<string, unknown>
				| undefined)
		: undefined;
	const merged: Record<string, unknown> = { ...(existing ?? {}) };
	setOrDelete(merged, "name", input.name);
	setOrDelete(merged, "api", input.api);
	setOrDelete(merged, "baseUrl", input.baseUrl);
	setOrDelete(merged, "reasoning", input.reasoning);
	// thinking: merge over the existing object so unrendered keys (effortMap,
	// legacy levels/minLevel+maxLevel) survive a GUI edit of the efforts list.
	if (input.thinking) {
		const base =
			existing?.thinking && typeof existing.thinking === "object"
				? (existing.thinking as Record<string, unknown>)
				: {};
		merged.thinking = { ...base, ...input.thinking };
	} else {
		delete merged.thinking;
	}
	setOrDelete(merged, "input", input.input && input.input.length > 0 ? input.input : undefined);
	setOrDelete(merged, "supportsTools", input.supportsTools);
	setOrDelete(merged, "cost", input.cost && Object.keys(input.cost).length > 0 ? input.cost : undefined);
	setOrDelete(merged, "premiumMultiplier", input.premiumMultiplier);
	setOrDelete(merged, "contextWindow", input.contextWindow);
	setOrDelete(merged, "maxTokens", input.maxTokens);
	setOrDelete(merged, "omitMaxOutputTokens", input.omitMaxOutputTokens);
	setOrDelete(merged, "headers", input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined);
	return { id: input.id, ...merged };
}

/** Insert or update a custom provider. Keeps the stored apiKey when not re-supplied. */
export function upsertModelsProvider(input: CustomProviderInput): void {
	if (BUILTIN_PROVIDERS.has(input.id)) {
		throw new Error(`"${input.id}" is a built-in provider id; choose a distinct custom id.`);
	}
	const data = readFile();
	const existingRaw = data.providers?.[input.id];
	const existing = toView(input.id, existingRaw);
	const apiKey = input.apiKey && input.apiKey.trim().length > 0 ? input.apiKey.trim() : existing.apiKey;
	const entry: Record<string, unknown> =
		existingRaw && typeof existingRaw === "object" ? { ...(existingRaw as Record<string, unknown>) } : {};
	entry.baseUrl = input.baseUrl;
	entry.api = input.api;
	setOrDelete(entry, "apiKey", apiKey);
	setOrDelete(entry, "auth", input.auth);
	setOrDelete(entry, "authHeader", input.authHeader);
	setOrDelete(entry, "headers", input.headers && Object.keys(input.headers).length > 0 ? input.headers : undefined);
	setOrDelete(entry, "discovery", input.discovery);
	setOrDelete(entry, "disableStrictTools", input.disableStrictTools);
	setOrDelete(entry, "transport", input.transport);
	// compat: merge extraBody into the existing compat object (other flags survive).
	const compat =
		entry.compat && typeof entry.compat === "object" ? { ...(entry.compat as Record<string, unknown>) } : {};
	setOrDelete(
		compat,
		"extraBody",
		input.extraBody && Object.keys(input.extraBody).length > 0 ? input.extraBody : undefined,
	);
	if (Object.keys(compat).length > 0) entry.compat = compat;
	else delete entry.compat;
	entry.models = input.models.map(m => mergeModel(entry.models, m));
	if (!data.providers) data.providers = {};
	data.providers[input.id] = entry;
	writeFileSync(modelsPath(), stringify(data), "utf8");
}

/** Delete a custom provider entry (built-ins cannot be removed here). */
export function deleteModelsProvider(id: string): void {
	if (BUILTIN_PROVIDERS.has(id)) {
		throw new Error(`"${id}" is a built-in provider and cannot be removed from the GUI.`);
	}
	const data = readFile();
	if (!data.providers || !(id in data.providers)) return;
	delete data.providers[id];
	writeFileSync(modelsPath(), stringify(data), "utf8");
}

/** Protocol options for the add-provider form (ApiSchema in models-config-schema). */
export const PROVIDER_PROTOCOLS = CUSTOM_PROVIDER_APIS;
