/**
 * Theme registry contract: every named theme must define the full
 * THEME_TOKEN_KEYS map — applyThemeByName writes tokens inline, so a missing
 * key silently falls back to whatever the previous theme left on <html>.
 */

import { describe, expect, it } from "vitest";
import { THEME_TOKEN_KEYS, THEMES } from "./themes";

describe("theme registry", () => {
	it("defines every canonical token on every theme", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			const missing = THEME_TOKEN_KEYS.filter(key => !(key in theme.tokens));
			expect(missing, `${name} missing tokens: ${missing.join(", ")}`).toEqual([]);
		}
	});

	it("has no unknown tokens beyond the canonical set", () => {
		const canonical: Record<string, true> = Object.fromEntries(THEME_TOKEN_KEYS.map(key => [key, true]));
		for (const [name, theme] of Object.entries(THEMES)) {
			const extra = Object.keys(theme.tokens).filter(key => !canonical[key]);
			expect(extra, `${name} unknown tokens: ${extra.join(", ")}`).toEqual([]);
		}
	});

	it("carries picker metadata and a valid scheme", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			expect(theme.label.trim().length, `${name} label`).toBeGreaterThan(0);
			expect(theme.description?.trim().length ?? 0, `${name} description`).toBeGreaterThan(0);
			expect(["dark", "light"], `${name} scheme`).toContain(theme.scheme);
		}
	});

	it("keeps at least one light and one dark theme available", () => {
		const schemes = Object.values(THEMES).map(theme => theme.scheme);
		expect(schemes).toContain("light");
		expect(schemes).toContain("dark");
	});
});
