#!/usr/bin/env bun
/**
 * Build the GUI's bundled (built-in) omp binary.
 *
 * Produces a self-contained `resources/omp` executable from the workspace
 * coding-agent source via compileCodingAgent (Bun.build --compile). The
 * native addon archive is embedded as an asset, so the binary needs no
 * external omp, no node_modules, and no bun runtime — the GUI spawns it as
 * its dedicated sidecar.
 *
 * Prereq: packages/natives/native/embedded-addon.js (run `gen:native`).
 * Run: `bun --cwd=packages/gui run build:omp`
 */
import { createRequire } from "node:module";
import * as path from "node:path";
import { compileCodingAgent } from "../../coding-agent/scripts/compile-binary";

const guiRoot = path.join(import.meta.dir, "..");
const repoRoot = path.join(guiRoot, "..", "..");
const require = createRequire(import.meta.url);
const transformersManifest = require("@huggingface/transformers/package.json") as { version?: string };
const transformersVersion = transformersManifest.version;
if (!transformersVersion) {
	throw new Error("@huggingface/transformers package.json has no version");
}

const outfile = path.join(guiRoot, "resources", "omp");

// Optional cross-arch build: `--target bun-darwin-x64 --out resources/omp.x64`.
// Defaults to the host arch at resources/omp (no explicit target).
const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};
const target = argValue("--target") as Bun.Build.CompileTarget | undefined;
const out = argValue("--out") ?? outfile;

await compileCodingAgent({
	repoRoot,
	entrypoint: path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts"),
	outfile: out,
	transformersVersion,
	...(target ? { target } : {}),
});

console.log(`built bundled omp → ${out}${target ? ` (target ${target})` : ""}`);
