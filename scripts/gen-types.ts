/**
 * Type generation script (dev-time only).
 * Extracts RPC types from the coding-agent source for reference.
 * The GUI's shared/rpc-types.ts is hand-maintained from verified source;
 * this script validates it hasn't drifted.
 *
 * Usage: bun scripts/gen-types.ts [--check]
 */
import * as fs from "node:fs";
import * as path from "node:path";

const RPC_TYPES_SOURCE = path.resolve(__dirname, "../../coding-agent/src/modes/rpc/rpc-types.ts");
const GUI_TYPES = path.resolve(__dirname, "../src/shared/rpc-types.ts");

function extractCommandTypes(source: string): string[] {
	const commands: string[] = [];
	const regex = /type:\s*"([^"]+)"/g;

	// Find the RpcCommand union section
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

async function main() {
	const checkMode = process.argv.includes("--check");

	// Read source
	let sourceContent: string;
	try {
		sourceContent = await fs.promises.readFile(RPC_TYPES_SOURCE, "utf-8");
	} catch {
		console.log("⚠️  Source file not found (expected in monorepo context):", RPC_TYPES_SOURCE);
		console.log("   Skipping type drift check.");
		return;
	}

	const sourceCommands = extractCommandTypes(sourceContent);
	console.log(`Source RPC commands: ${sourceCommands.length}`);

	// Read GUI types
	const guiContent = await fs.promises.readFile(GUI_TYPES, "utf-8");
	const guiCommands = extractCommandTypes(guiContent);
	console.log(`GUI RPC commands: ${guiCommands.length}`);

	// Compare
	const missing = sourceCommands.filter(cmd => !guiCommands.includes(cmd));
	const extra = guiCommands.filter(cmd => !sourceCommands.includes(cmd));

	if (missing.length > 0) {
		console.log("\n❌ Commands in source but MISSING from GUI types:");
		for (const cmd of missing) console.log(`   - ${cmd}`);
	}
	if (extra.length > 0) {
		console.log("\n⚠️  Commands in GUI types but NOT in source:");
		for (const cmd of extra) console.log(`   - ${cmd}`);
	}

	if (missing.length === 0 && extra.length === 0) {
		console.log("\n✅ GUI types are in sync with source.");
	} else if (checkMode && missing.length > 0) {
		process.exit(1);
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
