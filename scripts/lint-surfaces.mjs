#!/usr/bin/env node
/**
 * Surface policy lint — keeps content colorless and typography on the
 * unified scale (see the SURFACE POLICY block in src/renderer/styles/global.css).
 *
 * Errors:
 *  - static content fill: `bg-(--omp-bg-primary|secondary|tertiary)` or the
 *    `bg-[var(--omp-bg-*)]` form WITHOUT an interaction variant prefix
 *    (hover:/focus:/group-hover:/…). Content surfaces are transparent; only
 *    the canvas, chrome tokens, floating overlays, states, and semantic
 *    fills may paint.
 *  - raw pixel font class `text-[<N>px]` below 16px — use the text-omp-*
 *    scale (global.css @theme). Display sizes ≥16px are exempt.
 *
 * A deliberate exception carries `surface-ok` on the same line (spell the
 * reason next to it). The styles/ directory (token definitions) is skipped.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../src/renderer", import.meta.url).pathname;
const EXTENSIONS = new Set([".ts", ".tsx"]);

const FILL_PAREN = /(?:[a-z-]+:)*bg-\(--omp-bg-(?:primary|secondary|tertiary)\)/g;
const FILL_BRACKET = /(?:[a-z-]+:)*bg-\[var\(--omp-bg-(?:primary|secondary|tertiary)\)\]/g;
const RAW_PX = /\btext-\[(\d+(?:\.\d+)?)px\]/g;

/** @returns {string[]} */
function collect(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "styles" || entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...collect(full));
		else if (EXTENSIONS.has(full.slice(full.lastIndexOf(".")))) out.push(full);
	}
	return out;
}

const violations = [];
for (const file of collect(ROOT)) {
	const rel = relative(ROOT, file);
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, index) => {
		if (line.includes("surface-ok")) return;
		for (const pattern of [FILL_PAREN, FILL_BRACKET]) {
			pattern.lastIndex = 0;
			for (const match of line.matchAll(pattern)) {
				const token = match[0];
				// Variant-prefixed (hover:bg-…, group-hover:bg-…) = interaction state.
				if (token.includes(":")) continue;
				violations.push(`${rel}:${index + 1}  static content fill  ${token}`);
			}
		}
		RAW_PX.lastIndex = 0;
		for (const match of line.matchAll(RAW_PX)) {
			if (Number.parseFloat(match[1]) >= 16) continue;
			violations.push(`${rel}:${index + 1}  raw pixel font class  ${match[0]}  (use text-omp-*)`);
		}
	});
}

if (violations.length > 0) {
	console.error(`surface policy: ${violations.length} violation(s)`);
	for (const v of violations) console.error(`  ${v}`);
	process.exit(1);
}
console.log("surface policy: clean");
