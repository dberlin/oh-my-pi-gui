/**
 * SchemaTabContent: all settings for one schema tab, sectioned by its
 * ordered groups. Extracted verbatim from SettingsWindow.tsx.
 */

import { useMemo } from "react";
import type { SettingEntry } from "../../../../shared/rpc-types";
import { useLang } from "../../../lib/i18n";
import { Section } from "../editors/Section";
import { SchemaSettingRow } from "../SchemaSettingRow";
import { ZH_GROUP_TITLES } from "../schema-zh";
import { groupSchemaEntries, isSettingVisibleInGui } from "../settings-schema-utils";

/** All settings for one schema tab, sectioned by its ordered groups. */
export function SchemaTabContent({
	tabId,
	groups,
	entries,
	values,
	onCommitted,
}: {
	tabId: string;
	groups: string[];
	entries: SettingEntry[];
	values: Record<string, unknown>;
	onCommitted: (path: string, value: unknown) => void;
}) {
	// Drop TUI-only entries and entries whose condition resolves false. Groups
	// left empty by either filter emit no heading.
	const visibleEntries = useMemo(
		() => entries.filter(entry => isSettingVisibleInGui(entry, values)),
		[entries, values],
	);
	const { tabEntries, ungrouped, orderedGroups } = useMemo(
		() => groupSchemaEntries(visibleEntries, tabId, groups),
		[visibleEntries, tabId, groups],
	);
	const { lang } = useLang();

	if (tabEntries.length === 0) {
		return <div className="py-10 text-center text-xs text-(--omp-dim)">No settings in this section.</div>;
	}

	const renderRow = (entry: SettingEntry) => (
		<SchemaSettingRow entry={entry} key={entry.path} onCommitted={onCommitted} value={values[entry.path]} />
	);

	return (
		<>
			{ungrouped.length > 0 && <div className="mb-4">{ungrouped.map(renderRow)}</div>}
			{orderedGroups.map(group => (
				<Section key={group.name} title={lang === "zh" ? (ZH_GROUP_TITLES[group.name] ?? group.name) : group.name}>
					{group.entries.map(renderRow)}
				</Section>
			))}
		</>
	);
}
