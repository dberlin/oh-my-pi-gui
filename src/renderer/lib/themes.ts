/**
 * Named theme registry for the omp GUI.
 *
 * Every theme defines the exact same set of `--omp-*` design tokens (see
 * THEME_TOKEN_KEYS — the canonical 119 keys shared with theme-dark.css and
 * theme-light.css). `dark` and `light` are ports of those stylesheets; the
 * remaining themes are original palettes. applyThemeByName() writes the full
 * token map as inline custom properties on <html> (beating the `:root`
 * stylesheet rules), keeps `data-theme` / the color-scheme meta in sync via
 * lib/theme's applyTheme(), and persists the selection under the
 * `themeName` pref (plus the legacy `theme` pref for backwards compat).
 * "system" is a special selection that resolves to dark or light via the OS
 * media query and stays stylesheet-driven.
 *
 * On top of the named themes sits the agent theme overlay (bottom of this
 * file): the coding-agent's `theme.dark` / `theme.light` settings name TUI
 * themes whose resolved colors are translated onto a subset of the same
 * tokens (see TUI_TOKEN_TO_CSS_VAR) and layered inline over the active GUI
 * theme, re-synced on config_update frames and data-theme flips.
 */

import type { RpcThemeColorsResult } from "../../shared/rpc-types";
import { applyTheme, markCustomThemeTokens, resolveTheme } from "./theme";

/** Canonical token keys, in stylesheet order. Every theme defines all of them. */
export const THEME_TOKEN_KEYS = [
	"--omp-accent",
	"--omp-accent-bright",
	"--omp-accent-dim",
	"--omp-accent-glow",
	"--omp-border",
	"--omp-border-accent",
	"--omp-border-muted",
	"--omp-border-strong",
	"--omp-success",
	"--omp-success-dim",
	"--omp-error",
	"--omp-error-dim",
	"--omp-warning",
	"--omp-warning-dim",
	"--omp-info",
	"--omp-info-dim",
	"--omp-text",
	"--omp-text-secondary",
	"--omp-bg-primary",
	"--omp-bg-secondary",
	"--omp-bg-tertiary",
	"--omp-bg-elevated",
	"--omp-selected-bg",
	"--omp-user-msg-bg",
	"--omp-user-msg-border",
	"--omp-custom-msg-bg",
	"--omp-code-bg",
	"--omp-tool-pending-bg",
	"--omp-tool-success-bg",
	"--omp-tool-error-bg",
	"--omp-tool-output",
	"--omp-tool-rail-running",
	"--omp-tool-rail-done",
	"--omp-tool-rail-error",
	"--omp-md-heading",
	"--omp-md-link",
	"--omp-md-link-url",
	"--omp-md-code",
	"--omp-md-code-block",
	"--omp-md-code-block-border",
	"--omp-md-quote",
	"--omp-md-quote-border",
	"--omp-md-hr",
	"--omp-md-list-bullet",
	"--omp-diff-added",
	"--omp-diff-added-bg",
	"--omp-diff-removed",
	"--omp-diff-removed-bg",
	"--omp-diff-context",
	"--omp-syntax-comment",
	"--omp-syntax-keyword",
	"--omp-syntax-function",
	"--omp-syntax-variable",
	"--omp-syntax-string",
	"--omp-syntax-number",
	"--omp-syntax-type",
	"--omp-syntax-operator",
	"--omp-syntax-punctuation",
	"--omp-thinking-off",
	"--omp-thinking-minimal",
	"--omp-thinking-low",
	"--omp-thinking-medium",
	"--omp-thinking-high",
	"--omp-thinking-xhigh",
	"--omp-status-bg",
	"--omp-status-model",
	"--omp-status-path",
	"--omp-status-git-clean",
	"--omp-status-git-dirty",
	"--omp-status-context",
	"--omp-status-spend",
	"--omp-status-subagents",
	"--omp-status-muted",
	"--omp-status-dim",
	"--omp-status-text",
	"--omp-status-sep",
	"--omp-muted",
	"--omp-dim",
	"--omp-link",
	"--omp-custom-msg-label",
	"--omp-input-bg",
	"--omp-input-border",
	"--omp-input-focus-border",
	"--omp-input-glow",
	"--omp-btn-primary-bg",
	"--omp-btn-primary-text",
	"--omp-btn-secondary-bg",
	"--omp-btn-secondary-text",
	"--omp-btn-danger-bg",
	"--omp-btn-danger-text",
	"--omp-badge-bg",
	"--omp-badge-text",
	"--omp-badge-accent",
	"--omp-overlay-bg",
	"--omp-modal-bg",
	"--omp-modal-border",
	"--omp-toast-bg",
	"--omp-toast-text",
	"--omp-toast-border",
	"--omp-progress-bg",
	"--omp-progress-fill",
	"--omp-sidebar-bg",
	"--omp-sidebar-item-hover",
	"--omp-sidebar-item-active",
	"--omp-selection-bg",
	"--omp-selection-text",
	"--omp-scrollbar-thumb",
	"--omp-scrollbar-track",
	"--omp-streaming-cursor",
	"--omp-streaming-highlight",
	"--omp-panel-bg",
	"--omp-panel-border",
	"--omp-panel-header",
	"--omp-titlebar-bg",
	"--omp-titlebar-text",
	"--omp-shadow-sm",
	"--omp-shadow-md",
	"--omp-shadow-lg",
	"--omp-shadow-glow",
] as const;

export type ThemeTokenKey = (typeof THEME_TOKEN_KEYS)[number];
export type ThemeTokens = Record<ThemeTokenKey, string>;

export interface ThemeDefinition {
	/** Human-readable name shown in the picker. */
	label: string;
	/** One-line picker blurb. */
	description: string;
	/** Base color scheme — drives data-theme, the color-scheme meta, and native controls. */
	scheme: "dark" | "light";
	tokens: ThemeTokens;
}

const dark: ThemeDefinition = {
	label: "Dark",
	description: "Neutral graphite surfaces with a cobalt accent.",
	scheme: "dark",
	tokens: {
		"--omp-accent": "#5b8cff",
		"--omp-accent-bright": "#78a1ff",
		"--omp-accent-dim": "rgba(91, 140, 255, 0.16)",
		"--omp-accent-glow": "rgba(91, 140, 255, 0.28)",
		"--omp-border": "#344052",
		"--omp-border-accent": "rgba(91, 140, 255, 0.62)",
		"--omp-border-muted": "#273142",
		"--omp-border-strong": "#4a596f",
		"--omp-success": "#4ade80",
		"--omp-success-dim": "rgba(74, 222, 128, 0.12)",
		"--omp-error": "#f87171",
		"--omp-error-dim": "rgba(248, 113, 113, 0.12)",
		"--omp-warning": "#fbbf24",
		"--omp-warning-dim": "rgba(251, 191, 36, 0.12)",
		"--omp-info": "#60a5fa",
		"--omp-info-dim": "rgba(96, 165, 250, 0.12)",
		"--omp-text": "#f4f7fb",
		"--omp-text-secondary": "#c3ccda",
		"--omp-bg-primary": "#11151c",
		"--omp-bg-secondary": "#171c25",
		"--omp-bg-tertiary": "#202733",
		"--omp-bg-elevated": "#2a3342",
		"--omp-selected-bg": "#263754",
		"--omp-user-msg-bg": "#1d2d49",
		"--omp-user-msg-border": "#36598c",
		"--omp-custom-msg-bg": "#242538",
		"--omp-code-bg": "#0f141c",
		"--omp-tool-pending-bg": "#172137",
		"--omp-tool-success-bg": "#15271d",
		"--omp-tool-error-bg": "#2b1b25",
		"--omp-tool-output": "#c7d0dd",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#427253",
		"--omp-tool-rail-error": "#87454d",
		"--omp-md-heading": "#ffffff",
		"--omp-md-link": "#8db8ff",
		"--omp-md-link-url": "#95a1b5",
		"--omp-md-code": "#d7a5ff",
		"--omp-md-code-block": "#dce5f4",
		"--omp-md-code-block-border": "#344052",
		"--omp-md-quote": "#bdc7d5",
		"--omp-md-quote-border": "#586981",
		"--omp-md-hr": "#344052",
		"--omp-md-list-bullet": "var(--omp-accent)",
		"--omp-diff-added": "#4ade80",
		"--omp-diff-added-bg": "rgba(74, 222, 128, 0.09)",
		"--omp-diff-removed": "#f87171",
		"--omp-diff-removed-bg": "rgba(248, 113, 113, 0.09)",
		"--omp-diff-context": "#9aa5bc",
		"--omp-syntax-comment": "#829181",
		"--omp-syntax-keyword": "#8db8ff",
		"--omp-syntax-function": "#d7a5ff",
		"--omp-syntax-variable": "#d5def8",
		"--omp-syntax-string": "#76d3c5",
		"--omp-syntax-number": "#e6bc76",
		"--omp-syntax-type": "#79c8ef",
		"--omp-syntax-operator": "#d7dbea",
		"--omp-syntax-punctuation": "#9aa5bc",
		"--omp-thinking-off": "#68738b",
		"--omp-thinking-minimal": "#8792aa",
		"--omp-thinking-low": "#64a9dc",
		"--omp-thinking-medium": "#8db8ff",
		"--omp-thinking-high": "#c18ae2",
		"--omp-thinking-xhigh": "#e9c2ff",
		"--omp-status-bg": "#0d121a",
		"--omp-status-model": "#d7a5ff",
		"--omp-status-path": "#76d3c5",
		"--omp-status-git-clean": "#4ade80",
		"--omp-status-git-dirty": "#fbbf24",
		"--omp-status-context": "#9ba5ff",
		"--omp-status-spend": "#76d3c5",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#8792aa",
		"--omp-status-dim": "#68738b",
		"--omp-status-text": "#f4f7fb",
		"--omp-status-sep": "#34405a",
		"--omp-muted": "#a9b4c5",
		"--omp-dim": "#77849a",
		"--omp-link": "#8db8ff",
		"--omp-custom-msg-label": "#c18ae2",
		"--omp-input-bg": "#171d27",
		"--omp-input-border": "#3a475b",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(91, 140, 255, 0.18)",
		"--omp-btn-primary-bg": "var(--omp-accent)",
		"--omp-btn-primary-text": "#08152f",
		"--omp-btn-secondary-bg": "#273142",
		"--omp-btn-secondary-text": "#f4f7fb",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#08152f",
		"--omp-badge-bg": "#253047",
		"--omp-badge-text": "#c4cbda",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(7, 10, 16, 0.74)",
		"--omp-modal-bg": "#1b222d",
		"--omp-modal-border": "#364356",
		"--omp-toast-bg": "#1b222d",
		"--omp-toast-text": "#f4f7fb",
		"--omp-toast-border": "#364356",
		"--omp-progress-bg": "#253047",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#121720",
		"--omp-sidebar-item-hover": "#1d2531",
		"--omp-sidebar-item-active": "#253149",
		"--omp-selection-bg": "rgba(91, 140, 255, 0.25)",
		"--omp-selection-text": "#f4f7fb",
		"--omp-scrollbar-thumb": "#46556a",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(91, 140, 255, 0.07)",
		"--omp-panel-bg": "#171d26",
		"--omp-panel-border": "#273142",
		"--omp-panel-header": "#a9b4c5",
		"--omp-titlebar-bg": "#141923",
		"--omp-titlebar-text": "#f4f7fb",
		"--omp-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.42)",
		"--omp-shadow-md": "0 5px 16px rgba(0, 0, 0, 0.48)",
		"--omp-shadow-lg": "0 16px 40px rgba(0, 0, 0, 0.58)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent), 0 0 20px var(--omp-input-glow)",
	},
};

const light: ThemeDefinition = {
	label: "Light",
	description: "Warm paper neutrals with a deep teal accent.",
	scheme: "light",
	tokens: {
		"--omp-accent": "#0f766e",
		"--omp-accent-bright": "#0d9488",
		"--omp-accent-dim": "rgba(15, 118, 110, 0.08)",
		"--omp-accent-glow": "rgba(15, 118, 110, 0.15)",
		"--omp-border": "#e5e2dc",
		"--omp-border-accent": "rgba(15, 118, 110, 0.4)",
		"--omp-border-muted": "#edebe6",
		"--omp-border-strong": "#d2cec5",
		"--omp-success": "#15803d",
		"--omp-success-dim": "rgba(21, 128, 61, 0.09)",
		"--omp-error": "#c2373f",
		"--omp-error-dim": "rgba(194, 55, 63, 0.08)",
		"--omp-warning": "#a16207",
		"--omp-warning-dim": "rgba(161, 98, 7, 0.09)",
		"--omp-info": "#0f766e",
		"--omp-info-dim": "rgba(15, 118, 110, 0.08)",
		"--omp-text": "#1f2328",
		"--omp-text-secondary": "#4b5057",
		"--omp-bg-primary": "#ffffff",
		"--omp-bg-secondary": "#faf9f8",
		"--omp-bg-tertiary": "#f2f0ed",
		"--omp-bg-elevated": "#ffffff",
		"--omp-selected-bg": "#eceae6",
		"--omp-user-msg-bg": "#f4f2ee",
		"--omp-user-msg-border": "#dedad3",
		"--omp-custom-msg-bg": "#f1effa",
		"--omp-code-bg": "#f6f5f3",
		"--omp-tool-pending-bg": "#f5f4f2",
		"--omp-tool-success-bg": "#edf6ef",
		"--omp-tool-error-bg": "#f9efef",
		"--omp-tool-output": "#55606b",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#5da877",
		"--omp-tool-rail-error": "#cd7a82",
		"--omp-md-heading": "#1a1d21",
		"--omp-md-link": "#0f766e",
		"--omp-md-link-url": "#7d8590",
		"--omp-md-code": "#9d4e15",
		"--omp-md-code-block": "#3a3f46",
		"--omp-md-code-block-border": "#e5e2dc",
		"--omp-md-quote": "#5b636d",
		"--omp-md-quote-border": "#cfcabf",
		"--omp-md-hr": "#e5e2dc",
		"--omp-md-list-bullet": "var(--omp-accent)",
		"--omp-diff-added": "#15803d",
		"--omp-diff-added-bg": "rgba(21, 128, 61, 0.08)",
		"--omp-diff-removed": "#c2373f",
		"--omp-diff-removed-bg": "rgba(194, 55, 63, 0.08)",
		"--omp-diff-context": "#6d7681",
		"--omp-syntax-comment": "#8a9199",
		"--omp-syntax-keyword": "#7c3aed",
		"--omp-syntax-function": "#0f766e",
		"--omp-syntax-variable": "#1f2328",
		"--omp-syntax-string": "#9d4e15",
		"--omp-syntax-number": "#0369a1",
		"--omp-syntax-type": "#a16207",
		"--omp-syntax-operator": "#4b5057",
		"--omp-syntax-punctuation": "#6d7681",
		"--omp-thinking-off": "#aab0b8",
		"--omp-thinking-minimal": "#828a94",
		"--omp-thinking-low": "#3d8a84",
		"--omp-thinking-medium": "#0f766e",
		"--omp-thinking-high": "#9d4e15",
		"--omp-thinking-xhigh": "#b45309",
		"--omp-status-bg": "#f0eeeb",
		"--omp-status-model": "#6d28d9",
		"--omp-status-path": "#0d7377",
		"--omp-status-git-clean": "#15803d",
		"--omp-status-git-dirty": "#a16207",
		"--omp-status-context": "#0f766e",
		"--omp-status-spend": "#0d7377",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#828a94",
		"--omp-status-dim": "#aab0b8",
		"--omp-status-text": "#1f2328",
		"--omp-status-sep": "#e0dcd5",
		"--omp-muted": "#5d646d",
		"--omp-dim": "#6d7681",
		"--omp-link": "#0f766e",
		"--omp-custom-msg-label": "#6d28d9",
		"--omp-input-bg": "#ffffff",
		"--omp-input-border": "#d8d4cc",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(15, 118, 110, 0.12)",
		"--omp-btn-primary-bg": "#21262c",
		"--omp-btn-primary-text": "#ffffff",
		"--omp-btn-secondary-bg": "#f0eeeb",
		"--omp-btn-secondary-text": "#1f2328",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#ffffff",
		"--omp-badge-bg": "#f0eeeb",
		"--omp-badge-text": "#525a63",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(24, 28, 33, 0.34)",
		"--omp-modal-bg": "#ffffff",
		"--omp-modal-border": "#e5e2dc",
		"--omp-toast-bg": "#ffffff",
		"--omp-toast-text": "#1f2328",
		"--omp-toast-border": "#e5e2dc",
		"--omp-progress-bg": "#e9e6e1",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#faf9f8",
		"--omp-sidebar-item-hover": "#f1efec",
		"--omp-sidebar-item-active": "#eae7e3",
		"--omp-selection-bg": "rgba(15, 118, 110, 0.15)",
		"--omp-selection-text": "#1a1d21",
		"--omp-scrollbar-thumb": "#c9c4bb",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(15, 118, 110, 0.05)",
		"--omp-panel-bg": "#faf9f8",
		"--omp-panel-border": "#e8e5df",
		"--omp-panel-header": "#5d646d",
		"--omp-titlebar-bg": "#ffffff",
		"--omp-titlebar-text": "#1f2328",
		"--omp-shadow-sm": "0 1px 2px rgba(24, 28, 33, 0.06)",
		"--omp-shadow-md": "0 4px 14px rgba(24, 28, 33, 0.08)",
		"--omp-shadow-lg": "0 14px 38px rgba(24, 28, 33, 0.12)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent), 0 0 14px var(--omp-input-glow)",
	},
};

const titanium: ThemeDefinition = {
	label: "Titanium",
	description: "Mid-dark graphite with a steel-blue accent.",
	scheme: "dark",
	tokens: {
		"--omp-accent": "#86a8f0",
		"--omp-accent-bright": "#a3bdf5",
		"--omp-accent-dim": "rgba(134, 168, 240, 0.15)",
		"--omp-accent-glow": "rgba(134, 168, 240, 0.26)",
		"--omp-border": "#454c58",
		"--omp-border-accent": "rgba(134, 168, 240, 0.6)",
		"--omp-border-muted": "#383e48",
		"--omp-border-strong": "#596273",
		"--omp-success": "#5fd08a",
		"--omp-success-dim": "rgba(95, 208, 138, 0.12)",
		"--omp-error": "#ee7d7d",
		"--omp-error-dim": "rgba(238, 125, 125, 0.12)",
		"--omp-warning": "#f0c060",
		"--omp-warning-dim": "rgba(240, 192, 96, 0.12)",
		"--omp-info": "#7ab5f5",
		"--omp-info-dim": "rgba(122, 181, 245, 0.12)",
		"--omp-text": "#eef1f6",
		"--omp-text-secondary": "#bcc3cf",
		"--omp-bg-primary": "#22262c",
		"--omp-bg-secondary": "#282c33",
		"--omp-bg-tertiary": "#30353d",
		"--omp-bg-elevated": "#3a404a",
		"--omp-selected-bg": "#33425e",
		"--omp-user-msg-bg": "#2a3852",
		"--omp-user-msg-border": "#46618c",
		"--omp-custom-msg-bg": "#32304a",
		"--omp-code-bg": "#1e2228",
		"--omp-tool-pending-bg": "#27334a",
		"--omp-tool-success-bg": "#223a2c",
		"--omp-tool-error-bg": "#402831",
		"--omp-tool-output": "#c2cad6",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#50805f",
		"--omp-tool-rail-error": "#96555e",
		"--omp-md-heading": "#ffffff",
		"--omp-md-link": "#a5c2ff",
		"--omp-md-link-url": "#98a2b3",
		"--omp-md-code": "#d4aeff",
		"--omp-md-code-block": "#dde4f0",
		"--omp-md-code-block-border": "#454c58",
		"--omp-md-quote": "#bfc8d4",
		"--omp-md-quote-border": "#626e82",
		"--omp-md-hr": "#454c58",
		"--omp-md-list-bullet": "var(--omp-accent)",
		"--omp-diff-added": "#5fd08a",
		"--omp-diff-added-bg": "rgba(95, 208, 138, 0.09)",
		"--omp-diff-removed": "#ee7d7d",
		"--omp-diff-removed-bg": "rgba(238, 125, 125, 0.09)",
		"--omp-diff-context": "#9da7ba",
		"--omp-syntax-comment": "#8a9484",
		"--omp-syntax-keyword": "#a5c2ff",
		"--omp-syntax-function": "#d4aeff",
		"--omp-syntax-variable": "#d8e0f5",
		"--omp-syntax-string": "#7fd8c8",
		"--omp-syntax-number": "#ecc280",
		"--omp-syntax-type": "#84cdf2",
		"--omp-syntax-operator": "#d8dce6",
		"--omp-syntax-punctuation": "#9da7ba",
		"--omp-thinking-off": "#707a8c",
		"--omp-thinking-minimal": "#8b95a8",
		"--omp-thinking-low": "#6fb0e0",
		"--omp-thinking-medium": "#a5c2ff",
		"--omp-thinking-high": "#c794e6",
		"--omp-thinking-xhigh": "#ecc9ff",
		"--omp-status-bg": "#1c2026",
		"--omp-status-model": "#d4aeff",
		"--omp-status-path": "#7fd8c8",
		"--omp-status-git-clean": "#5fd08a",
		"--omp-status-git-dirty": "#f0c060",
		"--omp-status-context": "#a0abff",
		"--omp-status-spend": "#7fd8c8",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#8b95a8",
		"--omp-status-dim": "#707a8c",
		"--omp-status-text": "#eef1f6",
		"--omp-status-sep": "#3c4452",
		"--omp-muted": "#aab3c0",
		"--omp-dim": "#8b94a3",
		"--omp-link": "#a5c2ff",
		"--omp-custom-msg-label": "#c794e6",
		"--omp-input-bg": "#282e37",
		"--omp-input-border": "#48505e",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(134, 168, 240, 0.17)",
		"--omp-btn-primary-bg": "var(--omp-accent)",
		"--omp-btn-primary-text": "#101c38",
		"--omp-btn-secondary-bg": "#383e48",
		"--omp-btn-secondary-text": "#eef1f6",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#101c38",
		"--omp-badge-bg": "#343c4c",
		"--omp-badge-text": "#c0c7d4",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(10, 13, 18, 0.72)",
		"--omp-modal-bg": "#2b3038",
		"--omp-modal-border": "#454e5c",
		"--omp-toast-bg": "#2b3038",
		"--omp-toast-text": "#eef1f6",
		"--omp-toast-border": "#454e5c",
		"--omp-progress-bg": "#343c4c",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#242932",
		"--omp-sidebar-item-hover": "#2d333d",
		"--omp-sidebar-item-active": "#333d52",
		"--omp-selection-bg": "rgba(134, 168, 240, 0.25)",
		"--omp-selection-text": "#eef1f6",
		"--omp-scrollbar-thumb": "#4d5666",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(134, 168, 240, 0.07)",
		"--omp-panel-bg": "#282d36",
		"--omp-panel-border": "#383e48",
		"--omp-panel-header": "#aab3c0",
		"--omp-titlebar-bg": "#252a32",
		"--omp-titlebar-text": "#eef1f6",
		"--omp-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.4)",
		"--omp-shadow-md": "0 5px 16px rgba(0, 0, 0, 0.45)",
		"--omp-shadow-lg": "0 16px 40px rgba(0, 0, 0, 0.55)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent), 0 0 20px var(--omp-input-glow)",
	},
};

const nord: ThemeDefinition = {
	label: "Nord",
	description: "Cool polar-night blues with a frost accent.",
	scheme: "dark",
	tokens: {
		"--omp-accent": "#88c0d0",
		"--omp-accent-bright": "#8fbcbb",
		"--omp-accent-dim": "rgba(136, 192, 208, 0.16)",
		"--omp-accent-glow": "rgba(136, 192, 208, 0.28)",
		"--omp-border": "#434c5e",
		"--omp-border-accent": "rgba(136, 192, 208, 0.6)",
		"--omp-border-muted": "#3b4252",
		"--omp-border-strong": "#4c566a",
		"--omp-success": "#a3be8c",
		"--omp-success-dim": "rgba(163, 190, 140, 0.12)",
		"--omp-error": "#bf616a",
		"--omp-error-dim": "rgba(191, 97, 106, 0.12)",
		"--omp-warning": "#ebcb8b",
		"--omp-warning-dim": "rgba(235, 203, 139, 0.12)",
		"--omp-info": "#81a1c1",
		"--omp-info-dim": "rgba(129, 161, 193, 0.12)",
		"--omp-text": "#eceff4",
		"--omp-text-secondary": "#d8dee9",
		"--omp-bg-primary": "#2e3440",
		"--omp-bg-secondary": "#343b47",
		"--omp-bg-tertiary": "#3b4252",
		"--omp-bg-elevated": "#434c5e",
		"--omp-selected-bg": "#3d4a63",
		"--omp-user-msg-bg": "#33405a",
		"--omp-user-msg-border": "#4c6186",
		"--omp-custom-msg-bg": "#3a3a52",
		"--omp-code-bg": "#272c36",
		"--omp-tool-pending-bg": "#2f3a4e",
		"--omp-tool-success-bg": "#2c4034",
		"--omp-tool-error-bg": "#422f33",
		"--omp-tool-output": "#cdd5e1",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#5c8264",
		"--omp-tool-rail-error": "#8a4f56",
		"--omp-md-heading": "#ffffff",
		"--omp-md-link": "#8fbcbb",
		"--omp-md-link-url": "#9aa5b8",
		"--omp-md-code": "#b48ead",
		"--omp-md-code-block": "#e5e9f0",
		"--omp-md-code-block-border": "#434c5e",
		"--omp-md-quote": "#c3ccd9",
		"--omp-md-quote-border": "#5a6480",
		"--omp-md-hr": "#434c5e",
		"--omp-md-list-bullet": "var(--omp-accent)",
		"--omp-diff-added": "#a3be8c",
		"--omp-diff-added-bg": "rgba(163, 190, 140, 0.09)",
		"--omp-diff-removed": "#bf616a",
		"--omp-diff-removed-bg": "rgba(191, 97, 106, 0.09)",
		"--omp-diff-context": "#9aa5b8",
		"--omp-syntax-comment": "#7c8698",
		"--omp-syntax-keyword": "#81a1c1",
		"--omp-syntax-function": "#88c0d0",
		"--omp-syntax-variable": "#d8dee9",
		"--omp-syntax-string": "#a3be8c",
		"--omp-syntax-number": "#b48ead",
		"--omp-syntax-type": "#8fbcbb",
		"--omp-syntax-operator": "#81a1c1",
		"--omp-syntax-punctuation": "#9aa5b8",
		"--omp-thinking-off": "#5f6b7e",
		"--omp-thinking-minimal": "#7c8698",
		"--omp-thinking-low": "#81a1c1",
		"--omp-thinking-medium": "#88c0d0",
		"--omp-thinking-high": "#b48ead",
		"--omp-thinking-xhigh": "#d8b4e2",
		"--omp-status-bg": "#272c36",
		"--omp-status-model": "#b48ead",
		"--omp-status-path": "#a3be8c",
		"--omp-status-git-clean": "#a3be8c",
		"--omp-status-git-dirty": "#ebcb8b",
		"--omp-status-context": "#81a1c1",
		"--omp-status-spend": "#a3be8c",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#7c8698",
		"--omp-status-dim": "#5f6b7e",
		"--omp-status-text": "#eceff4",
		"--omp-status-sep": "#3f4756",
		"--omp-muted": "#aab3c5",
		"--omp-dim": "#9ea5b2",
		"--omp-link": "#8fbcbb",
		"--omp-custom-msg-label": "#b48ead",
		"--omp-input-bg": "#333a48",
		"--omp-input-border": "#47506a",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(136, 192, 208, 0.18)",
		"--omp-btn-primary-bg": "var(--omp-accent)",
		"--omp-btn-primary-text": "#1c2430",
		"--omp-btn-secondary-bg": "#3b4252",
		"--omp-btn-secondary-text": "#eceff4",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#10141c",
		"--omp-badge-bg": "#3a4356",
		"--omp-badge-text": "#c3ccd9",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(24, 28, 36, 0.72)",
		"--omp-modal-bg": "#333a48",
		"--omp-modal-border": "#47506a",
		"--omp-toast-bg": "#333a48",
		"--omp-toast-text": "#eceff4",
		"--omp-toast-border": "#47506a",
		"--omp-progress-bg": "#3a4356",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#2b303c",
		"--omp-sidebar-item-hover": "#353c4a",
		"--omp-sidebar-item-active": "#3a4459",
		"--omp-selection-bg": "rgba(136, 192, 208, 0.26)",
		"--omp-selection-text": "#eceff4",
		"--omp-scrollbar-thumb": "#4c566a",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(136, 192, 208, 0.07)",
		"--omp-panel-bg": "#303744",
		"--omp-panel-border": "#3b4252",
		"--omp-panel-header": "#aab3c5",
		"--omp-titlebar-bg": "#2b303c",
		"--omp-titlebar-text": "#eceff4",
		"--omp-shadow-sm": "0 1px 2px rgba(0, 0, 0, 0.4)",
		"--omp-shadow-md": "0 5px 16px rgba(0, 0, 0, 0.45)",
		"--omp-shadow-lg": "0 16px 40px rgba(0, 0, 0, 0.55)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent), 0 0 20px var(--omp-input-glow)",
	},
};

const solarized: ThemeDefinition = {
	label: "Solarized",
	description: "Warm solarized-light with a blue accent.",
	scheme: "light",
	tokens: {
		"--omp-accent": "#268bd2",
		"--omp-accent-bright": "#2aa198",
		"--omp-accent-dim": "rgba(38, 139, 210, 0.14)",
		"--omp-accent-glow": "rgba(38, 139, 210, 0.24)",
		"--omp-border": "#d9d2bd",
		"--omp-border-accent": "rgba(38, 139, 210, 0.55)",
		"--omp-border-muted": "#e6dfc8",
		"--omp-border-strong": "#c9c0a5",
		"--omp-success": "#859900",
		"--omp-success-dim": "rgba(133, 153, 0, 0.12)",
		"--omp-error": "#dc322f",
		"--omp-error-dim": "rgba(220, 50, 47, 0.12)",
		"--omp-warning": "#b58900",
		"--omp-warning-dim": "rgba(181, 137, 0, 0.12)",
		"--omp-info": "#2aa198",
		"--omp-info-dim": "rgba(42, 161, 152, 0.12)",
		"--omp-text": "#4d5f66",
		"--omp-text-secondary": "#586e75",
		"--omp-bg-primary": "#fdf6e3",
		"--omp-bg-secondary": "#f5efdb",
		"--omp-bg-tertiary": "#eee8d5",
		"--omp-bg-elevated": "#e6dfc8",
		"--omp-selected-bg": "#dfe6ee",
		"--omp-user-msg-bg": "#e3ecf5",
		"--omp-user-msg-border": "#b3c9e0",
		"--omp-custom-msg-bg": "#eae6d2",
		"--omp-code-bg": "#f2ecd9",
		"--omp-tool-pending-bg": "#e4ebf2",
		"--omp-tool-success-bg": "#e6ecd9",
		"--omp-tool-error-bg": "#f3e0dd",
		"--omp-tool-output": "#5a6a71",
		"--omp-tool-rail-running": "var(--omp-accent)",
		"--omp-tool-rail-done": "#859900",
		"--omp-tool-rail-error": "#dc322f",
		"--omp-md-heading": "#073642",
		"--omp-md-link": "#268bd2",
		"--omp-md-link-url": "#93a1a1",
		"--omp-md-code": "#6c71c4",
		"--omp-md-code-block": "#4d5f66",
		"--omp-md-code-block-border": "#d9d2bd",
		"--omp-md-quote": "#657b83",
		"--omp-md-quote-border": "#c9c0a5",
		"--omp-md-hr": "#d9d2bd",
		"--omp-md-list-bullet": "var(--omp-accent)",
		"--omp-diff-added": "#859900",
		"--omp-diff-added-bg": "rgba(133, 153, 0, 0.10)",
		"--omp-diff-removed": "#dc322f",
		"--omp-diff-removed-bg": "rgba(220, 50, 47, 0.10)",
		"--omp-diff-context": "#93a1a1",
		"--omp-syntax-comment": "#93a1a1",
		"--omp-syntax-keyword": "#859900",
		"--omp-syntax-function": "#268bd2",
		"--omp-syntax-variable": "#4d5f66",
		"--omp-syntax-string": "#2aa198",
		"--omp-syntax-number": "#d33682",
		"--omp-syntax-type": "#b58900",
		"--omp-syntax-operator": "#859900",
		"--omp-syntax-punctuation": "#657b83",
		"--omp-thinking-off": "#b3b09a",
		"--omp-thinking-minimal": "#93a1a1",
		"--omp-thinking-low": "#2aa198",
		"--omp-thinking-medium": "#268bd2",
		"--omp-thinking-high": "#6c71c4",
		"--omp-thinking-xhigh": "#d33682",
		"--omp-status-bg": "#eee8d5",
		"--omp-status-model": "#6c71c4",
		"--omp-status-path": "#859900",
		"--omp-status-git-clean": "#859900",
		"--omp-status-git-dirty": "#b58900",
		"--omp-status-context": "#268bd2",
		"--omp-status-spend": "#2aa198",
		"--omp-status-subagents": "var(--omp-accent)",
		"--omp-status-muted": "#93a1a1",
		"--omp-status-dim": "#b3b09a",
		"--omp-status-text": "#4d5f66",
		"--omp-status-sep": "#d9d2bd",
		"--omp-muted": "#576b73",
		"--omp-dim": "#606f6f",
		"--omp-link": "#268bd2",
		"--omp-custom-msg-label": "#6c71c4",
		"--omp-input-bg": "#f5efdb",
		"--omp-input-border": "#cfc6ab",
		"--omp-input-focus-border": "var(--omp-accent)",
		"--omp-input-glow": "rgba(38, 139, 210, 0.16)",
		"--omp-btn-primary-bg": "var(--omp-accent)",
		"--omp-btn-primary-text": "#042128",
		"--omp-btn-secondary-bg": "#e6dfc8",
		"--omp-btn-secondary-text": "#4d5f66",
		"--omp-btn-danger-bg": "var(--omp-error)",
		"--omp-btn-danger-text": "#ffffff",
		"--omp-badge-bg": "#e6dfc8",
		"--omp-badge-text": "#586e75",
		"--omp-badge-accent": "var(--omp-accent)",
		"--omp-overlay-bg": "rgba(238, 232, 213, 0.72)",
		"--omp-modal-bg": "#f5efdb",
		"--omp-modal-border": "#cfc6ab",
		"--omp-toast-bg": "#f5efdb",
		"--omp-toast-text": "#4d5f66",
		"--omp-toast-border": "#cfc6ab",
		"--omp-progress-bg": "#e6dfc8",
		"--omp-progress-fill": "var(--omp-accent)",
		"--omp-sidebar-bg": "#f2ecd9",
		"--omp-sidebar-item-hover": "#eae4d0",
		"--omp-sidebar-item-active": "#e0d9c2",
		"--omp-selection-bg": "rgba(38, 139, 210, 0.22)",
		"--omp-selection-text": "#073642",
		"--omp-scrollbar-thumb": "#cfc6ab",
		"--omp-scrollbar-track": "transparent",
		"--omp-streaming-cursor": "var(--omp-accent)",
		"--omp-streaming-highlight": "rgba(38, 139, 210, 0.07)",
		"--omp-panel-bg": "#f2ecd9",
		"--omp-panel-border": "#e6dfc8",
		"--omp-panel-header": "#657b83",
		"--omp-titlebar-bg": "#eee8d5",
		"--omp-titlebar-text": "#4d5f66",
		"--omp-shadow-sm": "0 1px 2px rgba(101, 123, 131, 0.18)",
		"--omp-shadow-md": "0 5px 16px rgba(101, 123, 131, 0.22)",
		"--omp-shadow-lg": "0 16px 40px rgba(101, 123, 131, 0.28)",
		"--omp-shadow-glow": "0 0 0 1px var(--omp-border-accent), 0 0 20px var(--omp-input-glow)",
	},
};

export const THEMES = {
	dark,
	light,
	titanium,
	nord,
	solarized,
} as const satisfies Record<string, ThemeDefinition>;

export type ThemeName = keyof typeof THEMES;

/** A picker selection: a named theme, or "system" to follow the OS. */
export type ThemeSelection = ThemeName | "system";

export function isThemeSelection(value: unknown): value is ThemeSelection {
	return typeof value === "string" && (value === "system" || value in THEMES);
}

/** The theme actually shown for a selection ("system" resolves via the OS). */
export function resolveThemeSelection(selection: ThemeSelection): ThemeDefinition {
	return THEMES[selection === "system" ? resolveTheme("system") : selection];
}

/**
 * Inline tokens most recently written by applyThemeByName for a named theme;
 * null while the "system" selection is stylesheet-driven. The agent theme
 * overlay (bottom of this file) restores these when an override goes away.
 */
let baseThemeTokens: ThemeTokens | null = null;

/**
 * Applies a theme selection live: flips `data-theme` + the color-scheme meta
 * to the theme's base scheme, then writes every token inline on <html>.
 * "system" stays purely stylesheet-driven (dark/light resolve per the OS
 * media query, and lib/theme's watcher re-applies on OS changes). Persists
 * the selection under the `themeName` pref and mirrors the base scheme (or
 * "system") into the legacy `theme` pref so older boot paths stay coherent.
 * Pass `{ persist: false }` for ephemeral previews (settings-window theme
 * browsing) so the user's stored selection is left untouched.
 */
export function applyThemeByName(selection: ThemeSelection, opts: { persist?: boolean } = {}): void {
	const { persist = true } = opts;
	const legacyTheme = selection === "system" ? "system" : THEMES[selection].scheme;
	if (selection !== "system") {
		const theme = THEMES[selection];
		applyTheme(theme.scheme);
		const style = document.documentElement.style;
		for (const key of THEME_TOKEN_KEYS) style.setProperty(key, theme.tokens[key]);
		baseThemeTokens = theme.tokens;
		markCustomThemeTokens(theme.scheme);
	} else {
		baseThemeTokens = null;
		applyTheme("system");
	}
	if (persist) {
		void window.omp.prefs.set("themeName", selection);
		void window.omp.prefs.set("theme", legacyTheme);
	}
}

/**
 * Reads the persisted selection: the `themeName` pref first, then the legacy
 * `theme` pref (dark/light/system written by older builds and the settings
 * window), falling back to "light" — the historical store default.
 */
export async function getPersistedThemeSelection(): Promise<ThemeSelection> {
	try {
		const named = await window.omp.prefs.get("themeName");
		if (isThemeSelection(named)) return named;
		const legacy = await window.omp.prefs.get("theme");
		if (isThemeSelection(legacy)) return legacy;
	} catch {
		// prefs IPC unavailable (tests, storybook) — use the default.
	}
	return "light";
}

/**
 * Resolves one level of `var(--omp-…)` indirection for swatch previews.
 * Values that are not a bare var() reference are returned unchanged.
 */
export function resolveTokenColor(theme: ThemeDefinition, key: ThemeTokenKey): string {
	const value = theme.tokens[key];
	const match = /^var\((--omp-[a-z-]+)\)$/.exec(value);
	if (!match) return value;
	return theme.tokens[match[1] as ThemeTokenKey] ?? value;
}

// ============================================================================
// Agent theme overlay (theme.dark / theme.light)
// ============================================================================

/**
 * TUI theme token → GUI `--omp-*` custom property. Only tokens with an exact
 * counterpart on both sides are mapped; everything else stays owned by the
 * active GUI named theme. TUI tokens deliberately left unmapped (no verified
 * GUI semantic — do not approximate):
 * - thinkingText, toolTitle, userMessageText, customMessageText: the GUI has
 *   no dedicated foreground tokens for these surfaces.
 * - thinkingMax: the GUI thinking ramp ends at --omp-thinking-xhigh.
 * - bashMode, pythonMode: TUI REPL prompt-mode accents with no GUI counterpart.
 * - statusLineStaged / statusLineDirty / statusLineUntracked /
 *   statusLineOutput / statusLineCost: TUI status-line counters the GUI
 *   footer does not tokenize.
 * - "link": an undeclared colors key some theme files carry; it is not part
 *   of the TUI theme schema (ThemeColor), so its role is unverifiable.
 *   mdLink already covers --omp-md-link.
 */
const TUI_TOKEN_TO_CSS_VAR: Record<string, ThemeTokenKey> = {
	accent: "--omp-accent",
	border: "--omp-border",
	borderAccent: "--omp-border-accent",
	borderMuted: "--omp-border-muted",
	success: "--omp-success",
	error: "--omp-error",
	warning: "--omp-warning",
	muted: "--omp-muted",
	dim: "--omp-dim",
	text: "--omp-text",
	selectedBg: "--omp-selected-bg",
	userMessageBg: "--omp-user-msg-bg",
	customMessageBg: "--omp-custom-msg-bg",
	customMessageLabel: "--omp-custom-msg-label",
	toolPendingBg: "--omp-tool-pending-bg",
	toolSuccessBg: "--omp-tool-success-bg",
	toolErrorBg: "--omp-tool-error-bg",
	toolOutput: "--omp-tool-output",
	mdHeading: "--omp-md-heading",
	mdLink: "--omp-md-link",
	mdLinkUrl: "--omp-md-link-url",
	mdCode: "--omp-md-code",
	mdCodeBlock: "--omp-md-code-block",
	mdCodeBlockBorder: "--omp-md-code-block-border",
	mdQuote: "--omp-md-quote",
	mdQuoteBorder: "--omp-md-quote-border",
	mdHr: "--omp-md-hr",
	mdListBullet: "--omp-md-list-bullet",
	toolDiffAdded: "--omp-diff-added",
	toolDiffRemoved: "--omp-diff-removed",
	toolDiffContext: "--omp-diff-context",
	syntaxComment: "--omp-syntax-comment",
	syntaxKeyword: "--omp-syntax-keyword",
	syntaxFunction: "--omp-syntax-function",
	syntaxVariable: "--omp-syntax-variable",
	syntaxString: "--omp-syntax-string",
	syntaxNumber: "--omp-syntax-number",
	syntaxType: "--omp-syntax-type",
	syntaxOperator: "--omp-syntax-operator",
	syntaxPunctuation: "--omp-syntax-punctuation",
	thinkingOff: "--omp-thinking-off",
	thinkingMinimal: "--omp-thinking-minimal",
	thinkingLow: "--omp-thinking-low",
	thinkingMedium: "--omp-thinking-medium",
	thinkingHigh: "--omp-thinking-high",
	thinkingXhigh: "--omp-thinking-xhigh",
	statusLineBg: "--omp-status-bg",
	statusLineSep: "--omp-status-sep",
	statusLineModel: "--omp-status-model",
	statusLinePath: "--omp-status-path",
	statusLineGitClean: "--omp-status-git-clean",
	statusLineGitDirty: "--omp-status-git-dirty",
	statusLineContext: "--omp-status-context",
	statusLineSpend: "--omp-status-spend",
	statusLineSubagents: "--omp-status-subagents",
};

const AGENT_THEME_SETTING_PATHS = ["theme.dark", "theme.light"] as const;

/** Agent theme names keyed by GUI base scheme; null until the first settings sync lands. */
let agentThemeNames: { dark: string; light: string } | null = null;
/** CSS vars currently driven by the overlay (null = overlay inactive). */
let agentOverrides: Partial<Record<ThemeTokenKey, string>> | null = null;
/**
 * scheme:name of the last applied overlay. Combined with an intactness probe
 * so same-value data-theme refires (font-size changes, boot) skip re-fetching.
 */
let lastOverlaySignature: string | null = null;
/** Monotonic id — a slow get_theme_colors response must never clobber a newer overlay. */
let agentThemeRequestId = 0;

/**
 * Fetches one agent theme's resolved colors from the sidecar and maps them
 * onto GUI tokens. Returns null when the theme can't be resolved (unknown
 * name, sidecar down) so callers fall back to the plain named theme.
 */
async function fetchAgentThemeOverrides(name: string): Promise<Partial<Record<ThemeTokenKey, string>> | null> {
	let colors: Record<string, string> | undefined;
	try {
		const res = await window.omp.rpc.getThemeColors(name);
		if (!res.success) return null;
		colors = (res.data as RpcThemeColorsResult | undefined)?.colors;
	} catch {
		return null;
	}
	if (!colors || typeof colors !== "object") return null;
	const overrides: Partial<Record<ThemeTokenKey, string>> = {};
	for (const [token, cssVar] of Object.entries(TUI_TOKEN_TO_CSS_VAR)) {
		const value = colors[token];
		if (typeof value === "string" && value !== "") overrides[cssVar] = value;
	}
	return overrides;
}

/**
 * Writes the overlay on top of whatever base is active: each override becomes
 * an inline custom property, and vars the previous overlay no longer covers
 * are restored to the named theme's inline tokens (or dropped back to the
 * stylesheet while the "system" selection is stylesheet-driven).
 */
function applyAgentOverrides(next: Partial<Record<ThemeTokenKey, string>> | null): void {
	const style = document.documentElement.style;
	if (agentOverrides) {
		for (const key of Object.keys(agentOverrides) as ThemeTokenKey[]) {
			if (next && key in next) continue;
			const base = baseThemeTokens?.[key];
			if (base !== undefined) style.setProperty(key, base);
			else style.removeProperty(key);
		}
	}
	if (next) {
		for (const [key, value] of Object.entries(next)) {
			if (typeof value === "string") style.setProperty(key, value);
		}
	}
	agentOverrides = next;
}

/**
 * True while every var of the active overlay is still present inline.
 * applyTheme() clears inline tokens on base-scheme switches; this detects
 * that wipe so the overlay gets re-applied on top.
 */
function agentOverridesIntact(): boolean {
	if (!agentOverrides) return true;
	const style = document.documentElement.style;
	for (const key of Object.keys(agentOverrides) as ThemeTokenKey[]) {
		if (style.getPropertyValue(key) === "") return false;
	}
	return true;
}

/**
 * Resolves which agent theme (if any) applies to the current GUI base scheme
 * and re-layers it. No-ops until data-theme exists — the App boot effects set
 * it synchronously and the MutationObserver re-fires once they do.
 */
async function refreshAgentThemeOverrides(): Promise<void> {
	const attr = document.documentElement.getAttribute("data-theme");
	if (attr !== "dark" && attr !== "light") return;
	const name = agentThemeNames?.[attr] ?? "";
	if (name === "") {
		agentThemeRequestId++;
		lastOverlaySignature = null;
		applyAgentOverrides(null);
		return;
	}
	const signature = `${attr}:${name}`;
	if (signature === lastOverlaySignature && agentOverridesIntact()) return;
	const requestId = ++agentThemeRequestId;
	const overrides = await fetchAgentThemeOverrides(name);
	if (requestId !== agentThemeRequestId) return;
	lastOverlaySignature = overrides ? signature : null;
	applyAgentOverrides(overrides);
}

/** Reads theme.dark / theme.light from the agent and forces a re-layer. */
async function syncAgentThemeSettings(): Promise<void> {
	try {
		const res = await window.omp.rpc.getSettings([...AGENT_THEME_SETTING_PATHS]);
		const values = res.success ? (res.data as { values?: Record<string, unknown> } | undefined)?.values : undefined;
		const dark = values?.["theme.dark"];
		const light = values?.["theme.light"];
		agentThemeNames = {
			dark: typeof dark === "string" ? dark : "",
			light: typeof light === "string" ? light : "",
		};
	} catch {
		agentThemeNames = null;
	}
	lastOverlaySignature = null;
	await refreshAgentThemeOverrides();
}

/**
 * Starts layering the agent's theme.dark / theme.light TUI themes on top of
 * the active GUI theme: the theme matching the GUI's current base scheme
 * (theme.dark while data-theme is dark, theme.light while light) is resolved
 * into inline CSS var overrides over the GUI named theme, re-applied on every
 * config_update frame and on every GUI theme/scheme change (observed via
 * data-theme). Unset or unresolvable agent themes leave the GUI named theme
 * untouched. Call once at App boot; the returned teardown restores the base.
 */
export function initAgentThemeSync(): () => void {
	void syncAgentThemeSettings();
	const unsubscribe = window.omp.events.onConfigUpdate(() => {
		void syncAgentThemeSettings();
	});
	const observer = new MutationObserver(() => {
		void refreshAgentThemeOverrides();
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
	return () => {
		unsubscribe();
		observer.disconnect();
		agentThemeRequestId++;
		agentThemeNames = null;
		lastOverlaySignature = null;
		applyAgentOverrides(null);
	};
}
