/**
 * Plugin gui.theme overlay contract: validation rejects unknown keys and
 * non-color values, accepted tokens land as inline CSS vars, and a null map
 * clears the layer. DOM via linkedom — the overlay writer only touches
 * documentElement.style.
 */

import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPluginThemeOverlay, validatePluginThemeTokens } from "./themes";

const { document } = parseHTML("<html><body></body></html>");
(globalThis as unknown as Record<string, unknown>).document = document;

afterEach(() => {
	// Clear the module-level plugin layer between tests.
	applyPluginThemeOverlay(null);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("validatePluginThemeTokens", () => {
	it("accepts transcript-scoped keys with color-shaped values", () => {
		const { tokens, rejected } = validatePluginThemeTokens({
			mdLink: "#ff0000",
			thinkingLow: "oklch(0.7 0.1 200)",
			toolOutput: "var(--omp-tool-output)",
		});
		expect(rejected).toEqual([]);
		expect(tokens).toMatchObject({
			"--omp-md-link": "#ff0000",
			"--omp-thinking-low": "oklch(0.7 0.1 200)",
			"--omp-tool-output": "var(--omp-tool-output)",
		});
	});

	it("rejects unknown keys, chrome aspirations, and non-color values", () => {
		const { tokens, rejected } = validatePluginThemeTokens({
			accent: "#ff0000", // not in TRANSCRIPT_OVERLAY_VARS — chrome stays host-owned
			mdCode: "url(javascript:alert(1))",
			toolSuccessBg: 42,
			mdQuoteBorder: "#123456",
		});
		expect(rejected).toEqual(["accent", "mdCode", "toolSuccessBg"]);
		expect(tokens).toEqual({ "--omp-md-quote-border": "#123456" });
	});

	it("rejects malformed color values instead of truncating them", () => {
		const { tokens, rejected } = validatePluginThemeTokens({
			mdLink: "#12345", // 5-digit hex is invalid CSS
			thinkingLow: "#1234567", // 7-digit hex
			toolOutput: "rgb(255, 0, 0", // unclosed functional
			mdQuoteBorder: "var(--omp-md-quote-border); evil: 1", // trailing garbage
		});
		expect(rejected).toEqual(["mdLink", "thinkingLow", "toolOutput", "mdQuoteBorder"]);
		expect(tokens).toEqual({});
	});

	it("rejects syntactically shaped values the browser does not parse as colors", () => {
		vi.stubGlobal("CSS", { supports: (_property: string, value: string) => value !== "rgb(not-a-color)" });
		const { tokens, rejected } = validatePluginThemeTokens({ mdLink: "rgb(not-a-color)" });
		expect(rejected).toEqual(["mdLink"]);
		expect(tokens).toEqual({});
	});

	it("accepts nested functional colors and anchored var references", () => {
		const { tokens, rejected } = validatePluginThemeTokens({
			toolSuccessBg: "color-mix(in oklch, oklch(0.7 0.1 200), red)",
			mdLinkUrl: "var(--omp-md-link-url)",
		});
		expect(rejected).toEqual([]);
		expect(tokens).toMatchObject({
			"--omp-tool-success-bg": "color-mix(in oklch, oklch(0.7 0.1 200), red)",
			"--omp-md-link-url": "var(--omp-md-link-url)",
		});
	});
});

describe("applyPluginThemeOverlay", () => {
	it("writes accepted tokens as inline CSS vars", () => {
		const rejected = applyPluginThemeOverlay({ mdLink: "#00ff00" });
		expect(rejected).toEqual([]);
		expect(document.documentElement.style.getPropertyValue("--omp-md-link")).toBe("#00ff00");
	});

	it("clears the layer on a null map", () => {
		applyPluginThemeOverlay({ mdLink: "#00ff00" });
		applyPluginThemeOverlay(null);
		expect(document.documentElement.style.getPropertyValue("--omp-md-link")).toBe("");
	});

	it("applies nothing when every token is rejected", () => {
		const rejected = applyPluginThemeOverlay({ accent: "#ff0000", bogus: "nope" });
		expect(rejected).toEqual(["accent", "bogus"]);
		expect(document.documentElement.style.getPropertyValue("--omp-md-link")).toBe("");
	});
});
