/**
 * Settings schema extraction (dev-time only).
 * Reads the settings-schema.ts from coding-agent and extracts
 * the subset of settings the GUI can display/configure.
 *
 * Usage: bun scripts/gen-settings-schema.ts
 * Output: src/renderer/lib/settings-schema.json
 */
import * as fs from "node:fs";
import * as path from "node:path";

const SETTINGS_SOURCE = path.resolve(__dirname, "../../coding-agent/src/config/settings-schema.ts");
const OUTPUT = path.resolve(__dirname, "../src/renderer/lib/settings-schema.json");

interface SettingEntry {
	key: string;
	type: string;
	default: unknown;
	description: string;
	values?: string[];
	category: string;
}

// Settings the GUI can display (read-only) or configure (via RPC)
const GUI_VISIBLE_SETTINGS: Record<string, string> = {
	"tools.approvalMode": "approval",
	"tools.approval": "approval",
	"memory.backend": "memory",
	"tui.theme": "general",
	"tui.fontSize": "general",
	"models.default": "models",
	"models.smol": "models",
	"models.slow": "models",
	"models.task": "models",
	"compaction.enabled": "general",
	"retry.enabled": "general",
	"retry.maxAttempts": "general",
};

async function main() {
	let content: string;
	try {
		content = await fs.promises.readFile(SETTINGS_SOURCE, "utf-8");
	} catch {
		console.log("⚠️  Settings source not found:", SETTINGS_SOURCE);
		console.log("   Generating minimal schema.");
		const minimal: SettingEntry[] = [
			{
				key: "tools.approvalMode",
				type: "enum",
				default: "yolo",
				description: "Tool approval mode",
				values: ["always-ask", "write", "yolo"],
				category: "approval",
			},
			{
				key: "memory.backend",
				type: "enum",
				default: "off",
				description: "Memory backend",
				values: ["off", "local", "hindsight"],
				category: "memory",
			},
			{
				key: "models.default",
				type: "string",
				default: "",
				description: "Default model pattern",
				category: "models",
			},
			{ key: "models.smol", type: "string", default: "", description: "Fast model pattern", category: "models" },
			{ key: "models.slow", type: "string", default: "", description: "Slow model pattern", category: "models" },
		];
		await fs.promises.mkdir(path.dirname(OUTPUT), { recursive: true });
		await fs.promises.writeFile(OUTPUT, JSON.stringify(minimal, null, 2));
		console.log(`✅ Wrote minimal schema (${minimal.length} entries) to ${OUTPUT}`);
		return;
	}

	// Extract setting entries via regex (the schema is a large object literal)
	const entries: SettingEntry[] = [];
	const entryRegex =
		/"([^"]+)":\s*\{[^}]*type:\s*"([^"]+)"[^}]*default:\s*([^,}]+)[^}]*description:\s*"([^"]*)"[^}]*\}/gs;
	let match: RegExpExecArray | null = entryRegex.exec(content);

	while (match !== null) {
		const [, key, type, defaultVal, description] = match;
		const category = GUI_VISIBLE_SETTINGS[key];
		match = entryRegex.exec(content);
		if (!category) continue;

		const entry: SettingEntry = {
			key,
			type,
			default: defaultVal.trim(),
			description,
			category,
		};

		// Extract enum values if present
		const valuesMatch = match[0].match(/values:\s*\[([^\]]+)\]/);
		if (valuesMatch) {
			entry.values = valuesMatch[1].split(",").map(v =>
				v
					.trim()
					.replace(/["'`]/g, "")
					.replace(/\s*as const/, ""),
			);
		}

		entries.push(entry);
	}

	await fs.promises.mkdir(path.dirname(OUTPUT), { recursive: true });
	await fs.promises.writeFile(OUTPUT, JSON.stringify(entries, null, 2));
	console.log(`✅ Wrote ${entries.length} setting entries to ${OUTPUT}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
