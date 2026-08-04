/**
 * Type-shape drift check (dev-time only).
 *
 * The GUI's shared/rpc-types.ts is hand-maintained from the agent's
 * `coding-agent/src/modes/rpc/rpc-types.ts`. This script validates the
 * hand-maintained copy has not drifted from the source — at the SHAPE level,
 * not just the command-name level.
 *
 * What it checks:
 *   1. Command coverage: every `type: "..."` literal in the agent's RpcCommand
 *      union exists in the GUI's RpcCommand union (unchanged from before).
 *   2. Interface shape: for each `Rpc*` interface in the agent source, the
 *      GUI's same-named interface (with the `Rpc` prefix stripped) declares
 *      the same field-name set. Drift here is what silently broke the
 *      host-tool, subagent, and toolcall_delta paths — fields renamed or
 *      reshaped on one side but not the other.
 *
 * What it deliberately does NOT check:
 *   - Optional-vs-required (`?`) — the GUI legitimately narrows some fields.
 *   - Field types — comparing union/record types across two files needs a
 *     full TS type checker; field-name coverage catches the drift class that
 *     has actually bitten us.
 *   - Value types that are `type X = ...` unions (events) — those are checked
 *     by name at the union level, not by member shape.
 *
 * Usage: bun scripts/gen-types.ts [--check]
 *   --check  exit 1 on any drift (CI hook); otherwise report-only.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const RPC_TYPES_SOURCE = path.resolve(__dirname, "../../coding-agent/src/modes/rpc/rpc-types.ts");
const GUI_TYPES = path.resolve(__dirname, "../src/shared/rpc-types.ts");

// ============================================================================
// Command-name coverage (unchanged behavior)
// ============================================================================

function extractCommandTypes(source: string): string[] {
	const commands: string[] = [];
	const regex = /type:\s*"([^"]+)"/g;
	const commandSection = source.slice(
		source.indexOf("export type RpcCommand"),
		source.indexOf("// ====", source.indexOf("export type RpcCommand") + 100),
	);
	let match: RegExpExecArray | null = regex.exec(commandSection);
	while (match !== null) {
		commands.push(match[1]);
		match = regex.exec(commandSection);
	}
	return [...new Set(commands)].sort();
}

// ============================================================================
// Interface shape extraction
// ============================================================================

interface InterfaceShape {
	name: string;
	fields: string[];
}

/**
 * Parse every `export interface X { ... }` block in `source` and return the
 * declared field names. Handles nested braces (object-typed fields) by
 * scanning brace depth rather than splitting on lines.
 */
function extractInterfaceShapes(source: string): InterfaceShape[] {
	const shapes: InterfaceShape[] = [];
	const declRe = /export\s+interface\s+(\w+)\s*\{/g;
	let match: RegExpExecArray | null;
	while ((match = declRe.exec(source)) !== null) {
		const name = match[1];
		let depth = 1;
		let i = match.index + match[0].length;
		const bodyStart = i;
		while (i < source.length && depth > 0) {
			const ch = source[i];
			if (ch === "{") depth++;
			else if (ch === "}") depth--;
			i++;
		}
		const body = source.slice(bodyStart, i - 1);
		shapes.push({ name, fields: extractFieldNames(body) });
	}
	return shapes;
}

/**
 * Field names at depth 1 of an interface body. Strips comments first so
 * `// id: string` inside a doc comment does not count as a field.
 */
function extractFieldNames(body: string): string[] {
	const noBlock = body.replace(/\/\*[\s\S]*?\*\//g, "");
	const fields: string[] = [];
	let depth = 0;
	let token = "";
	for (let i = 0; i < noBlock.length; i++) {
		const ch = noBlock[i];
		if (ch === "{") depth++;
		else if (ch === "}") depth--;
		// Collect identifiers at depth 0 followed by `:` or `?:`
		if (depth === 0) {
			if (/[\w$]/.test(ch)) {
				token += ch;
			} else {
				if (token && (ch === ":" || ch === "?" || ch === "(")) {
					fields.push(token);
				}
				token = "";
			}
		}
	}
	return fields;
}

/** Map an agent `Rpc*` interface name to the GUI's expected name.
 *  Try the exact name first (GUI keeps the `Rpc` prefix for most types),
 *  then the prefix-stripped name (GUI drops it for host/subagent types). */
function guiNameFor(sourceName: string, guiNames: Set<string>): string {
	if (guiNames.has(sourceName)) return sourceName;
	const stripped = sourceName.replace(/^Rpc/, "");
	if (guiNames.has(stripped)) return stripped;
	return sourceName; // report as missing under the source name
}

// Interfaces the GUI intentionally does NOT mirror (agent-internal plumbing,
// response unions consumed structurally, frames the GUI never routes).
const IGNORED_SOURCE_INTERFACES = new Set([
	"RpcCommand", // a union, not an interface — checked by command-name coverage
	"RpcResponse", // a union; GUI consumes success/data structurally
	"RpcSessionEventFrame", // alias union
	"RpcExtensionUIRequest", // union; GUI mirrors it field-by-field in a single type
	"RpcHostUriOperation", // type alias, not an interface
	"RpcSubagentSubscriptionLevel", // type alias
	"RpcEvalLanguage", // type alias
	"RpcPlanApprovalOption", // type alias
	"RpcLoopModeRunState", // type alias
	"RpcHandoffResult", // GUI reads handoff result structurally
	"RpcDequeueResult", // same
	"RpcEvalResult", // same
	"RpcPlanApprovalResult", // same
	"RpcSettingsSchemaResult", // GUI re-uses its entry/tab shapes via SettingsSchemaResult
	"RpcProvidersResult", // GUI mirrors as ProvidersResult
	"RpcModelRolesResult", // GUI mirrors as ModelRolesResult
	"RpcModelRoleMetadataResult", // GUI mirrors as ModelRoleMetadataResult
	"RpcSkillsResult", // GUI mirrors as SkillsResult
	"RpcHooksResult", // GUI mirrors as HooksResult
	"RpcMcpServersResult", // GUI mirrors as McpServersResult
	"RpcPluginsResult", // GUI mirrors as PluginsResult
	"RpcMarketplacesResult", // GUI mirrors as MarketplacesResult
	"RpcPromptTemplatesResult", // GUI mirrors as PromptTemplatesResult
	"RpcSessionTreeResult", // GUI mirrors as SessionTreeResult
	"RpcThemesResult", // GUI mirrors as ThemesResult
	"RpcThemeColorsResult", // GUI mirrors as ThemeColorsResult
	"RpcSubagentMessagesResult", // GUI mirrors as SubagentMessagesResult
	"RpcUsageResult", // GUI mirrors as UsageResult
	"RpcAvailableCommandsUpdateFrame", // GUI mirrors as AvailableCommandsUpdateFrame
	"RpcLoopModeUpdateFrame", // GUI mirrors as LoopModeUpdateFrame (subset)
	"RpcPluginSetEnabledResult", // GUI reads result structurally
	"RpcMcpActionResult", // same
	// GUI mirrors these inline rather than as standalone interfaces:
	"RpcAvailableSlashCommand", // its fields live inline on GUI's AvailableCommand.subcommands
	"RpcPlanProposalFrame", // its fields live inline on GUI's AgentSessionEvent plan_proposal variant
	// Host-side response shapes the main process constructs itself (string
	// results from executeGuiHostTool, not agent-side AgentToolResult objects).
	// The wire authority is the agent's RpcHostTool* / RpcHostUri*; these GUI
	// interfaces are the host's own payloads, not mirrors of the agent's.
	"RpcHostToolDefinition", // GUI narrows (no hidden/loadMode — not registered)
	"RpcHostToolUpdate", // GUI sends {id, update: string}, not partialResult
	"RpcHostToolResult", // GUI sends {id, result?: string, error?: string}
	"RpcHostUriResult", // GUI sends {id, content?, error?}
]);

// GUI interfaces that intentionally add fields not on the wire (client-local
// state) or narrow the source shape — allow-list so real drift still fails.
const GUI_EXTRA_FIELDS_ALLOWLIST: Record<string, string[]> = {
	// GUI-only: snapshot extension marked as client-local in subagents.ts
	SubagentNode: ["parentSubagentId"],
};

async function main() {
	const checkMode = process.argv.includes("--check");

	let sourceContent: string;
	try {
		sourceContent = await fs.promises.readFile(RPC_TYPES_SOURCE, "utf-8");
	} catch {
		console.log("⚠️  Source file not found (expected in monorepo context):", RPC_TYPES_SOURCE);
		console.log("   Skipping type drift check.");
		return;
	}

	let guiContent: string;
	try {
		guiContent = await fs.promises.readFile(GUI_TYPES, "utf-8");
	} catch {
		console.log("⚠️  GUI types file not found:", GUI_TYPES);
		return;
	}

	// ---- Command-name coverage ------------------------------------------
	const sourceCommands = extractCommandTypes(sourceContent);
	const guiCommands = extractCommandTypes(guiContent);
	const missingCommands = sourceCommands.filter(cmd => !guiCommands.includes(cmd));
	const extraCommands = guiCommands.filter(cmd => !sourceCommands.includes(cmd));

	console.log(`Source RPC commands: ${sourceCommands.length}`);
	console.log(`GUI RPC commands:    ${guiCommands.length}`);
	if (missingCommands.length > 0) {
		console.log("\n❌ Commands in source but MISSING from GUI types:");
		for (const cmd of missingCommands) console.log(`   - ${cmd}`);
	}
	if (extraCommands.length > 0) {
		console.log("\n⚠️  Commands in GUI types but NOT in source:");
		for (const cmd of extraCommands) console.log(`   - ${cmd}`);
	}

	// ---- Interface-shape coverage ----------------------------------------
	const sourceShapes = extractInterfaceShapes(sourceContent);
	const guiShapes = extractInterfaceShapes(guiContent);
	const guiByName = new Map(guiShapes.map(s => [s.name, s]));
	const guiNames = new Set(guiShapes.map(s => s.name));

	const shapeProblems: string[] = [];
	for (const src of sourceShapes) {
		if (IGNORED_SOURCE_INTERFACES.has(src.name)) continue;
		const guiName = guiNameFor(src.name, guiNames);
		const gui = guiByName.get(guiName);
		if (!gui) {
			shapeProblems.push(`GUI missing interface "${guiName}" (source: ${src.name})`);
			continue;
		}
		const guiFields = new Set(gui.fields);
		const allowExtra = new Set(GUI_EXTRA_FIELDS_ALLOWLIST[guiName] ?? []);
		const missing = src.fields.filter(f => !guiFields.has(f));
		const extra = gui.fields.filter(f => !src.fields.includes(f) && !allowExtra.has(f));
		if (missing.length > 0 || extra.length > 0) {
			shapeProblems.push(
				`"${guiName}": ` +
					(missing.length > 0 ? `missing fields [${missing.join(", ")}]` : "") +
					(missing.length > 0 && extra.length > 0 ? "; " : "") +
					(extra.length > 0 ? `extra fields [${extra.join(", ")}]` : ""),
			);
		}
	}

	if (shapeProblems.length > 0) {
		console.log("\n❌ Interface shape drift detected:");
		for (const problem of shapeProblems) console.log(`   - ${problem}`);
	} else {
		console.log(`\n✅ Interface shapes in sync (${sourceShapes.length - IGNORED_SOURCE_INTERFACES.size} checked).`);
	}

	const drifted = missingCommands.length > 0 || shapeProblems.length > 0;
	if (!drifted && extraCommands.length === 0) {
		console.log("\n✅ GUI types are in sync with source.");
	}
	if (checkMode && drifted) {
		process.exit(1);
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
