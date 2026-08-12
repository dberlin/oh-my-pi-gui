import * as path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { esmShim } from "vite-plugin-electron/plugin";
import electron from "vite-plugin-electron/simple";

/**
 * Heavy renderer vendor libs split out of the eager main chunk. Patterns match
 * node_modules path segments; each family (and its transitive deps) lands in a
 * named chunk that lazy overlays load on demand instead of up front.
 */
const VENDOR_CHUNK_RULES: ReadonlyArray<readonly [RegExp, string]> = [
	// React core: every chunk depends on it, so shared interop helpers land
	// here — keeping cross-chunk imports one-way (no circular chunks).
	[/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, "react"],
	// Markdown pipeline: react-markdown + the unified/remark/rehype/mdast/hast ecosystem.
	[
		/[\\/]node_modules[\\/](react-markdown|lowlight|remark-|rehype-|mdast-|hast-|hastscript|unist-|unified|micromark|vfile|devlop|trough|bail|extend|zwitch|ccount|comma-separated-tokens|space-separated-tokens|decode-named-character-reference|character-entities|property-information|html-url-attributes|trim-lines|markdown-table|longest-streak|is-plain-obj|estree-util-|estree-walker|stringify-entities|web-namespaces)/,
		"markdown",
	],
	// KaTeX (pulled in by rehype-katex; kept separate so the markdown chunk stays lean).
	[/[\\/]node_modules[\\/]katex[\\/]/, "katex"],
	// Mermaid + its rendering stack (lazy-imported).
	[
		/[\\/]node_modules[\\/](mermaid|@mermaid-js|d3[^\\/]*|dagre[^\\/]*|@dagrejs|elkjs|dompurify|khroma|cytoscape|stylis|ts-dedent|marked|lodash-es|dayjs|uuid|robust-predicates|topojson-client)[\\/]/,
		"mermaid",
	],
	// chart.js + react-chartjs-2.
	[/[\\/]node_modules[\\/](chart\.js|react-chartjs-2|@kurkle)[\\/]/, "charts"],
	// xterm terminal.
	[/[\\/]node_modules[\\/]@xterm[\\/]/, "xterm"],
	// CodeMirror editor.
	[/[\\/]node_modules[\\/](@codemirror|@lezer)[\\/]/, "codemirror"],
	// highlight.js core + common grammars, shared by rehype-highlight (static,
	// via lowlight in the markdown chunk) and CodeBlock (dynamic import of
	// highlight.js/lib/common). Kept lowlight-free so chunk imports stay one-way.
	[/[\\/]node_modules[\\/]highlight\.js[\\/]/, "highlight"],
	// dnd-kit drag and drop.
	[/[\\/]node_modules[\\/]@dnd-kit[\\/]/, "dnd-kit"],
];

function manualChunks(id: string): string | undefined {
	if (!id.includes("node_modules")) return undefined;
	for (const [pattern, chunk] of VENDOR_CHUNK_RULES) {
		if (pattern.test(id)) return chunk;
	}
	return undefined;
}

export default defineConfig({
	root: path.resolve(import.meta.dirname, "src/renderer"),
	base: "./",
	plugins: [
		tailwindcss(),
		electron({
			main: {
				entry: path.resolve(import.meta.dirname, "src/main/index.ts"),
				onstart: async ({ startup }) => {
					await startup(undefined, { cwd: import.meta.dirname });
				},
				vite: {
					plugins: [esmShim()],
					build: {
						outDir: path.resolve(import.meta.dirname, "out/main"),
						emptyOutDir: false,
					},
				},
			},
			preload: {
				input: { index: path.resolve(import.meta.dirname, "src/preload/index.ts") },
				onstart: async ({ startup }) => {
					await startup(undefined, { cwd: import.meta.dirname });
				},
				vite: {
					build: {
						outDir: path.resolve(import.meta.dirname, "out/preload"),
						emptyOutDir: false,
						rolldownOptions: {
							output: {
								format: "cjs",
								entryFileNames: "[name].cjs",
								chunkFileNames: "[name].cjs",
							},
						},
					},
				},
			},
		}),
	],
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@renderer": path.resolve(import.meta.dirname, "src/renderer"),
			"@shared": path.resolve(import.meta.dirname, "src/shared"),
		},
	},
	build: {
		outDir: path.resolve(import.meta.dirname, "out/renderer"),
		emptyOutDir: true,
		rolldownOptions: {
			input: { index: path.resolve(import.meta.dirname, "src/renderer/index.html") },
			output: { manualChunks },
		},
	},
});
