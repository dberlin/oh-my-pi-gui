/**
 * Read/write the agent's `models.yml` for third-party provider configuration.
 *
 * The agent's model registry watches this file's mtime and live-reloads, so an
 * upsert/delete here makes a custom provider available without a restart. The
 * GUI writes literal provider entries; API keys are stored in the file (as the
 * agent expects) but MASKED when read back for display.
 *
 * Runs in the Electron (Node) main process — no Bun APIs, no @oh-my-pi/*
 * imports. Resolves the agent dir the same way (`PI_CODING_AGENT_DIR` or
 * `~/.omp/agent`) and parses with `yaml`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { CustomProviderInput, CustomProviderModelInput, CustomProviderView } from "../shared/ipc-types";

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

function toView(id: string, raw: unknown): CustomProviderView & { apiKey?: string } {
	const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const models: CustomProviderModelInput[] = [];
	if (Array.isArray(rec.models)) {
		for (const m of rec.models) {
			if (!m || typeof m !== "object") continue;
			const mid = (m as Record<string, unknown>).id;
			if (typeof mid !== "string") continue;
			models.push({
				id: mid,
				name: typeof m.name === "string" ? m.name : undefined,
				reasoning: m.reasoning === true,
			});
		}
	}
	const headers: Record<string, string> = {};
	if (rec.headers && typeof rec.headers === "object") {
		for (const [k, v] of Object.entries(rec.headers as Record<string, unknown>)) {
			if (typeof v === "string") headers[k] = v;
		}
	}
	const { hasApiKey, apiKeyPreview } = maskApiKey(rec.apiKey);
	return {
		id,
		api: typeof rec.api === "string" ? rec.api : "openai-completions",
		baseUrl: typeof rec.baseUrl === "string" ? rec.baseUrl : "",
		hasApiKey,
		apiKeyPreview,
		headers: Object.keys(headers).length > 0 ? headers : undefined,
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

/** Insert or update a custom provider. Keeps the stored apiKey when not re-supplied. */
export function upsertModelsProvider(input: CustomProviderInput): void {
	if (BUILTIN_PROVIDERS.has(input.id)) {
		throw new Error(`"${input.id}" is a built-in provider id; choose a distinct custom id.`);
	}
	const data = readFile();
	const existing = toView(input.id, (data.providers ?? {})[input.id]);
	const apiKey = input.apiKey && input.apiKey.trim().length > 0 ? input.apiKey.trim() : existing.apiKey;
	const entry: Record<string, unknown> = {
		baseUrl: input.baseUrl,
		api: input.api,
	};
	if (apiKey) entry.apiKey = apiKey;
	if (input.headers && Object.keys(input.headers).length > 0) entry.headers = input.headers;
	entry.models = input.models.map(m => ({
		id: m.id,
		...(m.name ? { name: m.name } : {}),
		...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
	}));
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

/** Protocol options for the add-provider form (common OpenAI/Anthropic/Gemini-compatible). */
export const PROVIDER_PROTOCOLS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"gemini",
	"groq",
	"mistral",
	"openrouter",
] as const;
