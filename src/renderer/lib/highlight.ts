import type { HLJSApi } from "highlight.js";

let hljsModule: HLJSApi | null = null;
let hljsPromise: Promise<HLJSApi> | null = null;

// Load the shared "common" language subset — the same grammars rehype-highlight
// registers via lowlight — so the lazy chunk shares modules with the markdown
// pipeline instead of duplicating the full highlight.js package.
export function loadHljs(): Promise<HLJSApi> {
	if (!hljsPromise) {
		hljsPromise = import("highlight.js/lib/common").then(mod => {
			hljsModule = mod.default;
			return mod.default;
		});
	}
	return hljsPromise;
}

/** The already-loaded hljs instance, or null while the lazy chunk is pending. */
export function getLoadedHljs(): HLJSApi | null {
	return hljsModule;
}
