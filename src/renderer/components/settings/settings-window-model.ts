/**
 * SettingsWindow model: launch-profile field constants, tab id constants,
 * and nav-group metadata. Extracted verbatim from SettingsWindow.tsx.
 */

import type { TabItem } from "../common";

export type LoadState = "loading" | "error" | "ready";

/** Launch-profile text fields that commit on blur (checkboxes/chips apply immediately). */
export type LaunchTextField = "systemPrompt" | "appendSystemPrompt" | "profile" | "sessionDir" | "config";
export const LAUNCH_TEXT_FIELDS: readonly LaunchTextField[] = [
	"systemPrompt",
	"appendSystemPrompt",
	"profile",
	"sessionDir",
	"config",
];
/** Prompt fields keep whitespace verbatim (the CLI takes the literal value); the rest trim. */
export const LAUNCH_VERBATIM_FIELDS: Record<string, true> = { systemPrompt: true, appendSystemPrompt: true };

export interface SettingsResponseData {
	values?: Record<string, unknown>;
	advisorEnabled?: boolean;
	advisorActive?: boolean;
}

/** Settings without UI metadata (advanced): searchable flat list. */
export const CAPABILITIES_TAB_ID = "capabilities";
export const SKILLS_TAB_ID = "skills";
export const MCP_TAB_ID = "mcp";
export const RESOURCES_TAB_ID = "resources";
export const HOOKS_TAB_ID = "hooks";
export const COMMANDS_TAB_ID = "commands";
export const SECURITY_TAB_ID = "security";
export const SSH_TAB_ID = "ssh";
export const UPDATES_TAB_ID = "updates";
export const ADVANCED_TAB_ID = "advanced";
export const GUI_TAB_ID = "gui";

export const MANAGEMENT_TAB_IDS = new Set([
	SKILLS_TAB_ID,
	MCP_TAB_ID,
	RESOURCES_TAB_ID,
	HOOKS_TAB_ID,
	COMMANDS_TAB_ID,
	SECURITY_TAB_ID,
	SSH_TAB_ID,
	UPDATES_TAB_ID,
]);

export const SEARCHABLE_MANAGEMENT_TAB_IDS = new Set([
	SKILLS_TAB_ID,
	MCP_TAB_ID,
	RESOURCES_TAB_ID,
	HOOKS_TAB_ID,
	COMMANDS_TAB_ID,
]);

export interface SettingsNavGroup {
	id: "overview" | "extensions" | "operations" | "configuration" | "application";
	items: TabItem[];
}

/**
 * Build the settings navigation groups from the loaded schema. No hardcoded
 * Runtime tab: every row it had duplicates another surface — model change
 * (footer/⌥M), thinking (Model schema tab + footer), fast mode (composer ⚡),
 * plan (Tasks tab/⌥⇧P), auto-compact (Context tab), auto-retry (Advanced),
 * message handling (Interaction tab).
 */
export function buildSettingsNavGroups(
	schema: { tabs: { id: string; label: string }[]; entries: { tab?: string; tuiOnly?: boolean }[] } | null,
): SettingsNavGroup[] {
	const configuration: TabItem[] = [];
	if (schema) {
		for (const schemaTab of schema.tabs) {
			if (schema.entries.some(entry => entry.tab === schemaTab.id && entry.tuiOnly !== true)) {
				configuration.push({ id: schemaTab.id, label: schemaTab.label });
			}
		}
	}
	return [
		{ id: "overview", items: [{ id: CAPABILITIES_TAB_ID, label: "OMP Capabilities" }] },
		{
			id: "extensions",
			items: [
				{ id: SKILLS_TAB_ID, label: "Skills" },
				{ id: MCP_TAB_ID, label: "MCP" },
				{ id: RESOURCES_TAB_ID, label: "Plugins & resources" },
				{ id: HOOKS_TAB_ID, label: "Hooks" },
				{ id: COMMANDS_TAB_ID, label: "Commands" },
			],
		},
		{
			id: "operations",
			items: [
				{ id: SECURITY_TAB_ID, label: "Security Center" },
				{ id: SSH_TAB_ID, label: "SSH Hosts" },
			],
		},
		{ id: "configuration", items: configuration },
		{
			id: "application",
			items: [
				{ id: UPDATES_TAB_ID, label: "Updates" },
				{ id: ADVANCED_TAB_ID, label: "Advanced" },
				{ id: GUI_TAB_ID, label: "GUI" },
			],
		},
	];
}
