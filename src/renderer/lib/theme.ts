/**
 * Theme application for the omp GUI.
 *
 * Single source of truth for design tokens is the stylesheets
 * `theme-dark.css` (`:root`) and `theme-light.css` (`:root[data-theme="light"]`).
 * This module only resolves the mode and flips the `data-theme` attribute;
 * it holds no color values itself.
 */

export type ThemeMode = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

// SSR-safe: `window` is undefined under react-dom/server (tests, SSR smoke).
const darkMedia: MediaQueryList | null =
	typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

/** Resolve "system" against the OS preference; identity otherwise. */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
	return mode === "system" ? (darkMedia?.matches ? "dark" : "light") : mode;
}

/**
 * Removes any inline `--omp-*` token overrides from <html> so the stylesheet
 * themes (theme-dark.css / theme-light.css) take over again.
 */
export function clearInlineThemeTokens(): void {
	const style = document.documentElement.style;
	const toRemove: string[] = [];
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (prop.startsWith("--omp-")) toRemove.push(prop);
	}
	for (const prop of toRemove) style.removeProperty(prop);
}

let lastAppliedMode: ThemeMode | null = null;
let customTokensActive = false;

/**
 * Marks a full custom token set (lib/themes.ts) as applied on top of the given
 * base scheme. While active, re-applying the SAME mode (e.g. the App effect
 * re-firing on an unrelated font-size change) keeps the custom tokens instead
 * of clearing them. Switching to a different mode still clears, so explicit
 * dark/light/system switches always win.
 */
export function markCustomThemeTokens(scheme: ResolvedTheme): void {
	lastAppliedMode = scheme;
	customTokensActive = true;
}

/**
 * Applies the theme by setting `data-theme` on <html>. Also mirrors the
 * resolved scheme into the `color-scheme` meta so native controls and
 * scrollbars match. Clears custom inline token overrides unless this is a
 * same-mode re-fire while a custom theme is active (see markCustomThemeTokens).
 */
export function applyTheme(mode: ThemeMode): void {
	const isSameModeRefire = customTokensActive && mode === lastAppliedMode;
	lastAppliedMode = mode;
	if (!isSameModeRefire) {
		customTokensActive = false;
		clearInlineThemeTokens();
	}
	const resolved = resolveTheme(mode);
	document.documentElement.setAttribute("data-theme", resolved);
	let meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
	if (!meta) {
		meta = document.createElement("meta");
		meta.name = "color-scheme";
		document.head.append(meta);
	}
	meta.content = resolved;
}

/**
 * Applies the user's font size to the body (default 13px). Components size
 * in px, so this scales prose and inherited text; em-based markdown sizes
 * follow automatically.
 */
export function applyFontSize(size: number): void {
	document.body.style.fontSize = `${size}px`;
}

/**
 * Subscribes to OS theme changes and re-applies while in "system" mode.
 * Returns an unsubscribe function.
 */
export function watchSystemTheme(mode: ThemeMode, onResolved: (theme: ResolvedTheme) => void): () => void {
	if (mode !== "system" || !darkMedia) return () => {};
	const handler = (e: MediaQueryListEvent) => onResolved(e.matches ? "dark" : "light");
	darkMedia.addEventListener("change", handler);
	return () => darkMedia.removeEventListener("change", handler);
}
