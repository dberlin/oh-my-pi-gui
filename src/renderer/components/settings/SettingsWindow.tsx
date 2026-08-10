/**
 * Settings window (Cmd+,): schema-driven editor for the agent settings
 * schema. Tabs, groups, labels, and control types all come from the
 * sidecar (get_settings_schema / get_settings RPC); writes go through
 * set_setting and apply immediately. Three product-level tabs sit beside the
 * schema tabs: "OMP Capabilities" surfaces differentiating workflows first,
 * "Runtime" holds ordinary live toggles, and "GUI" contains renderer-local
 * preferences persisted via prefs IPC. Entries without UI metadata land in
 * "Advanced".
 * String-typed settings that reference a model or a provider (last path
 * segment ends in Model/Provider) render as searchable dropdowns fed by
 * get_available_models / get_providers instead of free-text inputs.
 */

import {
	Blocks,
	BookOpen,
	Bot,
	Braces,
	BrainCircuit,
	Check,
	ChevronDown,
	Database,
	Eye,
	EyeOff,
	HardDriveDownload,
	Network,
	Route,
	Search,
	Server,
	ShieldCheck,
	SlidersHorizontal,
	Sparkles,
	Webhook,
	Wrench,
	X,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SettingEntry, SettingsSchemaResult } from "../../../shared/rpc-types";
import { useLang, useT } from "../../lib/i18n";
import { flagsToCommandLine, type LaunchProfile, parseLaunchProfile, profileToFlags } from "../../lib/launch-profile";
import { setCodeLineNumbersPref } from "../../lib/markdown";
import { applyThemeByName, getPersistedThemeSelection, THEMES, type ThemeName } from "../../lib/themes";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { CodeBlock } from "../chat/CodeBlock";
import { Button, Input, PiLogo, Spinner, type TabItem, TextArea } from "../common";
import { isTopmostDialog, registerDialogLayer } from "../common/dialog-layer";
import { ExtensionSettingsPage } from "../panels/ExtensionsPanel";
import { InventorySettingsPage, type TabId as InventoryTabId } from "../panels/InventoryPanel";
import { ArrayChipEditor } from "./editors/ArrayChipEditor";
import { type EnumerableOption, EnumerableSelect } from "./editors/EnumerableSelect";
import { ProviderLimitsEditor } from "./editors/ProviderLimitsEditor";
import { RecordKvEditor } from "./editors/RecordKvEditor";
import { ModelValueSelect, settingRefKind } from "./ModelValueSelect";
import { SecuritySettingsPage } from "./SecuritySettingsPage";
import { SkillsSettingsPage } from "./SkillsSettingsPage";
import { SshSettingsPage } from "./SshSettingsPage";
import { ZH_GROUP_TITLES, ZH_SETTINGS } from "./schema-zh";
import { UpdatesSettingsPage } from "./UpdatesSettingsPage";

type LoadState = "loading" | "error" | "ready";

/** Launch-profile text fields that commit on blur (checkboxes/chips apply immediately). */
type LaunchTextField = "systemPrompt" | "appendSystemPrompt" | "profile" | "sessionDir" | "config";
const LAUNCH_TEXT_FIELDS: readonly LaunchTextField[] = [
	"systemPrompt",
	"appendSystemPrompt",
	"profile",
	"sessionDir",
	"config",
];
/** Prompt fields keep whitespace verbatim (the CLI takes the literal value); the rest trim. */
const LAUNCH_VERBATIM_FIELDS: Record<string, true> = { systemPrompt: true, appendSystemPrompt: true };

interface SettingsResponseData {
	values?: Record<string, unknown>;
	advisorEnabled?: boolean;
	advisorActive?: boolean;
}

/**
 * Client-evaluable visibility gates, mirroring the TUI's CONDITIONS table
 * (settings-defs.ts). Each key is a `condition` name carried on the schema
 * entry; the predicate reads the current settings values. Gates that depend
 * on terminal capabilities (hasImageProtocol) are intentionally absent:
 * unresolvable conditions keep the entry visible.
 */
const CONDITION_EVALUATORS: Record<string, (values: Record<string, unknown>) => boolean> = {
	advisorEnabled: values => values["advisor.enabled"] === true,
	hindsightActive: values => values["memory.backend"] === "hindsight",
	mnemopiActive: values => values["memory.backend"] === "mnemopi",
	autolearnActive: values => values["autolearn.enabled"] === true,
	autoThinkingActive: values => values.defaultThinkingLevel === "auto",
	usageAwareFallbackEnabled: values => values["retry.usageAwareFallback"] === true,
	planModeEnabled: values => values["plan.enabled"] === true,
	unexpectedStopDetection: values => values["features.unexpectedStopDetection"] === true,
};

/**
 * Condition-gated visibility (TUI #defToItem parity): an entry is hidden only
 * when its condition names a known, client-evaluable gate that currently
 * resolves false. Unknown gates fail open (visible).
 */
export function isSettingVisible(entry: SettingEntry, values: Record<string, unknown>): boolean {
	if (entry.condition === undefined) return true;
	const evaluate = CONDITION_EVALUATORS[entry.condition];
	return evaluate === undefined ? true : evaluate(values);
}

/** Settings the GUI can both display and apply honestly. */
export function isSettingVisibleInGui(entry: SettingEntry, values: Record<string, unknown>): boolean {
	return entry.tuiOnly !== true && isSettingVisible(entry, values);
}

// Theme live preview (TUI onThemePreview parity): browsing theme.dark/
// theme.light temporarily previews the same palette in the GUI. A commit
// flows through shared config/theme sync; cancelling clears the transient
// preview back to the persisted GUI selection.
let themePreviewActive = false;
function previewAgentTheme(name: string | null): void {
	if (name !== null && name !== "" && name in THEMES) {
		themePreviewActive = true;
		applyThemeByName(name as ThemeName, { persist: false });
		return;
	}
	if (!themePreviewActive) return;
	themePreviewActive = false;
	void getPersistedThemeSelection().then(selection => {
		// A newer preview may have started while the persisted selection was
		// loading; only revert when nothing replaced us.
		if (!themePreviewActive) applyThemeByName(selection, { persist: false });
	});
}

/** Option sources for enumerable string settings (dropdowns, not free text). */
async function themeOptions(): Promise<EnumerableOption[]> {
	const res = await window.omp.rpc.getThemes();
	if (!res.success) throw new Error(res.error);
	const data = res.data as { themes?: { name: string; path?: string }[] } | undefined;
	return (data?.themes ?? []).map(theme => ({ value: theme.name, detail: theme.path ? "custom" : "builtin" }));
}

const COMMON_SHELLS = [
	"/bin/zsh",
	"/bin/bash",
	"/bin/sh",
	"/bin/fish",
	"/usr/bin/zsh",
	"/usr/bin/bash",
	"/usr/local/bin/zsh",
	"/usr/local/bin/bash",
	"/opt/homebrew/bin/zsh",
	"/opt/homebrew/bin/bash",
	"/opt/homebrew/bin/fish",
];
function shellOptions(): Promise<EnumerableOption[]> {
	return Promise.resolve(COMMON_SHELLS.map(path => ({ value: path })));
}

export function Toggle({
	checked,
	onChange,
	label,
	description,
	disabled,
	badge,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	label: string;
	description?: string;
	disabled?: boolean;
	badge?: React.ReactNode;
}) {
	return (
		<button
			aria-checked={checked}
			aria-label={label}
			className="flex w-full cursor-pointer items-start justify-between gap-4 rounded-md px-2 py-2 text-left transition-colors hover:bg-(--omp-bg-tertiary) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
			disabled={disabled}
			onClick={() => onChange(!checked)}
			role="switch"
			type="button"
		>
			<span className="min-w-0">
				<span className="flex items-center gap-2">
					<span className="block text-xs font-medium text-(--omp-text)">{label}</span>
					{badge}
				</span>
				{description && (
					<span className="mt-0.5 block text-[11px] leading-snug text-(--omp-muted)">{description}</span>
				)}
			</span>
			<span
				aria-hidden
				className={`relative mt-0.5 h-4.5 w-8 shrink-0 rounded-full transition-colors duration-150 ${
					checked ? "bg-(--omp-accent)" : "bg-(--omp-bg-tertiary) border border-(--omp-border-muted)"
				}`}
			>
				<span
					className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-all duration-150 ${
						checked ? "left-4" : "left-0.5"
					}`}
				/>
			</span>
		</button>
	);
}

function RadioGroup<T extends string>({
	value,
	onChange,
	options,
	name,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; description?: string }[];
	name: string;
}) {
	return (
		<div className="space-y-1" role="radiogroup">
			{options.map(option => (
				<label
					className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors ${
						value === option.value
							? "border-(--omp-border-accent) bg-[color-mix(in_srgb,var(--omp-link)_8%,transparent)]"
							: "border-(--omp-border-muted) hover:bg-(--omp-bg-tertiary)"
					}`}
					key={option.value}
				>
					<input
						checked={value === option.value}
						className="mt-0.5 accent-(--omp-accent)"
						name={name}
						onChange={() => onChange(option.value)}
						type="radio"
					/>
					<span className="min-w-0">
						<span className="block text-xs font-medium text-(--omp-text)">{option.label}</span>
						{option.description && (
							<span className="mt-0.5 block text-[11px] leading-snug text-(--omp-muted)">
								{option.description}
							</span>
						)}
					</span>
				</label>
			))}
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<section className="mb-5">
			<h3 className="mb-2 text-[10px] font-semibold tracking-widest text-(--omp-dim) uppercase">{title}</h3>
			{children}
		</section>
	);
}

/** Per-setting state indicator: dirty (unsaved edit), saving, or freshly saved. */
function SettingStatus({ dirty, saving, saved }: { dirty: boolean; saving: boolean; saved: boolean }) {
	if (saving) return <span className="shrink-0 text-[10px] text-(--omp-muted)">Saving…</span>;
	if (dirty) {
		return (
			<span className="flex shrink-0 items-center gap-1 text-[10px] text-(--omp-warning)">
				<span className="size-1.5 rounded-full bg-(--omp-warning)" />
				Unsaved
			</span>
		);
	}
	if (saved) {
		return (
			<span className="flex shrink-0 items-center gap-0.5 text-[10px] text-(--omp-success)">
				<Check size={10} />
				Saved
			</span>
		);
	}
	return null;
}

/** Serialize a persisted value into the editable draft string for its control. */
function draftFor(entry: SettingEntry, value: unknown): string {
	if (entry.type === "array" || entry.type === "record") {
		return JSON.stringify(value ?? (entry.type === "array" ? [] : {}), null, 2);
	}
	return value === undefined || value === null ? "" : String(value);
}

const SELECT_CLASS =
	"w-full rounded-md border border-(--omp-border-muted) bg-(--omp-bg-primary) px-2.5 py-1.5 text-xs text-(--omp-text) transition-colors duration-100 focus:border-(--omp-border-accent) focus:outline-none disabled:cursor-not-allowed disabled:opacity-50";

/**
 * One schema-driven setting row. Commits through set_setting: booleans and
 * enums write immediately; model/provider-referencing strings pick from a
 * dynamic dropdown (immediate); text/number commit on blur/Enter;
 * array/record edits go through a validated JSON editor with an explicit
 * Apply.
 */
function SchemaSettingRow({
	entry,
	value,
	onCommitted,
}: {
	entry: SettingEntry;
	value: unknown;
	onCommitted: (path: string, value: unknown) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const t = useT();
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [revealed, setRevealed] = useState(false);
	const savedTimer = useRef<number | undefined>(undefined);

	useEffect(
		() => () => {
			window.clearTimeout(savedTimer.current);
		},
		[],
	);

	const { lang } = useLang();
	const zhEntry = lang === "zh" ? ZH_SETTINGS[entry.path] : undefined;
	const label = zhEntry?.label ?? entry.label ?? entry.path;
	const description = zhEntry?.description ?? entry.description;
	const baseDraft = draftFor(entry, value);
	const dirty = draft !== null && draft !== baseDraft;

	const commit = useCallback(
		async (next: unknown) => {
			setSaving(true);
			try {
				const res = await window.omp.rpc.setSetting(entry.path, next);
				if (res.success) {
					onCommitted(entry.path, next);
					setDraft(null);
					setError(null);
					if (entry.type !== "boolean") {
						setSaved(true);
						window.clearTimeout(savedTimer.current);
						savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
					}
				} else {
					toast({ variant: "error", title: "Setting not saved", message: res.error });
				}
			} catch (err) {
				toast({ variant: "error", title: "Setting not saved", message: String(err) });
			} finally {
				setSaving(false);
			}
		},
		[entry.path, entry.type, onCommitted],
	);

	const commitText = useCallback(() => {
		if (draft === null || draft === baseDraft) {
			setDraft(null);
			setError(null);
			return;
		}
		if (entry.type === "number") {
			const trimmed = draft.trim();
			const num = Number(trimmed);
			if (trimmed.length === 0 || !Number.isFinite(num)) {
				setError(t("settings.editors.errNumber"));
				return;
			}
			void commit(num);
			return;
		}
		void commit(draft);
	}, [draft, baseDraft, entry.type, commit, t]);

	const commitJson = useCallback(() => {
		if (draft === null || draft === baseDraft) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(draft);
		} catch (err) {
			setError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		if (entry.type === "array" && !Array.isArray(parsed)) {
			setError(t("settings.editors.errJsonArray"));
			return;
		}
		if (entry.type === "record" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
			setError(t("settings.editors.errJsonObject"));
			return;
		}
		void commit(parsed);
	}, [draft, baseDraft, entry.type, commit, t]);

	const onTextKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") event.currentTarget.blur();
		if (event.key === "Escape") {
			setDraft(null);
			setError(null);
			event.currentTarget.blur();
		}
	};

	const status = <SettingStatus dirty={dirty} saving={saving} saved={saved} />;
	// Values cached at session construction need a restart in every client.
	const restartBadge =
		entry.restartRequired === true ? (
			<span
				title={t("settings.restartRequired.hint")}
				className="shrink-0 rounded border border-[var(--omp-warning)]/40 px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-[var(--omp-warning)]"
			>
				{t("settings.restartRequired.badge")}
			</span>
		) : null;

	// Boolean settings render as one full-row switch and write immediately.
	// The switch position is the success feedback; transient "Saved" text would
	// compete with the control's hit target and obscure its actual state.
	if (entry.type === "boolean") {
		return (
			<Toggle
				badge={restartBadge}
				checked={value === true}
				description={description}
				disabled={saving}
				label={label}
				onChange={next => void commit(next)}
			/>
		);
	}

	// Array/record settings get a full-width JSON editor below the label.
	if (entry.type === "array" || entry.type === "record") {
		const masked = entry.secret === true && !revealed;
		// Structured editors for the common shapes; JSON stays the fallback.
		const stringArray =
			entry.type === "array" && Array.isArray(value) && (value as unknown[]).every(item => typeof item === "string");
		const flatRecord =
			entry.type === "record" &&
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.values(value as Record<string, unknown>).every(
				item => item === null || ["string", "number", "boolean"].includes(typeof item),
			);
		const approvalOptions =
			entry.path === "tools.approval"
				? [
						{ value: "allow", label: t("settings.editors.approval.allow") },
						{ value: "prompt", label: t("settings.editors.approval.prompt") },
						{ value: "deny", label: t("settings.editors.approval.deny") },
					]
				: undefined;
		// Model-valued records (modelRoles) get a model dropdown per value cell.
		const modelValued = entry.path === "modelRoles";
		// Per-provider concurrency caps get the dedicated provider+number editor.
		const providerLimits =
			entry.path === "providers.maxInFlightRequests" &&
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value);
		return (
			<div className="rounded-md px-2 py-2 transition-colors hover:bg-(--omp-bg-tertiary)">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-(--omp-text)" title={entry.path}>
						{label}
					</span>

					{restartBadge}
					{status}
				</div>
				{description && (
					<span className="mt-0.5 block text-[11px] leading-snug text-(--omp-muted)">{description}</span>
				)}
				{masked ? (
					<div className="mt-2 flex items-center justify-between rounded-md border border-(--omp-border-muted) bg-(--omp-bg-primary) px-2.5 py-2">
						<span className="text-xs text-(--omp-muted)">••••••••</span>
						<Button onClick={() => setRevealed(true)} size="sm" type="button" variant="ghost">
							<Eye size={12} className="mr-1 inline" />
							Reveal
						</Button>
					</div>
				) : stringArray ? (
					<div className="mt-2">
						<ArrayChipEditor
							disabled={saving}
							onCommit={next => void commit(next)}
							ordered={entry.ordered === true}
							values={value as string[]}
						/>
					</div>
				) : providerLimits ? (
					<div className="mt-2">
						<ProviderLimitsEditor
							disabled={saving}
							onCommit={next => void commit(next)}
							value={value as Record<string, unknown>}
						/>
					</div>
				) : flatRecord ? (
					<div className="mt-2">
						<RecordKvEditor
							disabled={saving}
							onCommit={next => void commit(next)}
							value={value as Record<string, unknown>}
							valueKind={modelValued ? "model" : undefined}
							valueOptions={approvalOptions}
						/>
					</div>
				) : (
					<>
						<TextArea
							autoGrow
							className="mt-2"
							disabled={saving}
							error={error ?? undefined}
							mono
							onChange={event => {
								setDraft(event.target.value);
								setError(null);
							}}
							rows={3}
							spellCheck={false}
							value={draft ?? baseDraft}
						/>
						<div className="mt-1.5 flex items-center justify-end gap-1.5">
							{entry.secret === true && (
								<Button onClick={() => setRevealed(false)} size="sm" type="button" variant="ghost">
									<EyeOff size={12} className="mr-1 inline" />
									Hide
								</Button>
							)}
							{dirty && (
								<Button
									onClick={() => {
										setDraft(null);
										setError(null);
									}}
									size="sm"
									type="button"
									variant="ghost"
								>
									Reset
								</Button>
							)}
							<Button
								disabled={!dirty || saving}
								loading={saving}
								onClick={commitJson}
								size="sm"
								type="button"
								variant="secondary"
							>
								Apply
							</Button>
						</div>
					</>
				)}
			</div>
		);
	}

	// enum / number / string share a label-left, control-right row.
	let control: React.ReactNode;
	if (entry.type === "enum") {
		const options = entry.options ?? [];
		const current = typeof value === "string" ? value : undefined;
		const hasCurrent = current !== undefined && options.some(option => option.value === current);
		if (options.length === 0) {
			control = (
				<Input
					disabled={saving}
					onBlur={commitText}
					onChange={event => setDraft(event.target.value)}
					onKeyDown={onTextKeyDown}
					value={draft ?? baseDraft}
				/>
			);
		} else {
			control = (
				<select
					className={SELECT_CLASS}
					disabled={saving}
					onChange={event => {
						if (event.target.value !== "") void commit(event.target.value);
					}}
					value={current ?? ""}
				>
					{current === undefined && <option value="">(unset)</option>}
					{!hasCurrent && current !== undefined && <option value={current}>{current}</option>}
					{options.map(option => (
						<option key={option.value} title={option.description} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			);
		}
	} else if (entry.type === "number") {
		control = (
			<Input
				disabled={saving}
				error={error ?? undefined}
				onBlur={commitText}
				onChange={event => {
					setDraft(event.target.value);
					setError(null);
				}}
				onKeyDown={onTextKeyDown}
				type="number"
				value={draft ?? baseDraft}
			/>
		);
	} else {
		const masked = entry.secret === true && !revealed;
		// Enumerable string settings get dropdowns (never hand-typed); then
		// model/provider references get searchable dropdowns; secrets stay text.
		const refKind = entry.secret === true ? null : settingRefKind(entry.path);
		const themeSetting = entry.secret !== true && /^theme\.(dark|light)$/.test(entry.path);
		const shellSetting = entry.secret !== true && entry.path === "shellPath";
		if (themeSetting) {
			control = (
				<EnumerableSelect
					allowCustom
					disabled={saving}
					fetchOptions={themeOptions}
					noun={t("settings.editors.themes")}
					onCommit={next => void commit(next)}
					onPreview={previewAgentTheme}
					value={typeof value === "string" ? value : ""}
				/>
			);
		} else if (shellSetting) {
			control = (
				<EnumerableSelect
					allowCustom
					disabled={saving}
					fetchOptions={shellOptions}
					noun={t("settings.editors.shells")}
					onCommit={next => void commit(next)}
					value={typeof value === "string" ? value : ""}
				/>
			);
		} else if (refKind !== null) {
			control = (
				<ModelValueSelect
					disabled={saving}
					kind={refKind}
					onCommit={next => void commit(next)}
					value={typeof value === "string" ? value : ""}
				/>
			);
		} else {
			control = (
				<div className="relative">
					<Input
						disabled={saving}
						onBlur={commitText}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={onTextKeyDown}
						type={masked ? "password" : "text"}
						value={draft ?? baseDraft}
					/>
					{entry.secret === true && (
						<button
							aria-label={masked ? "Reveal value" : "Hide value"}
							className="absolute top-1/2 right-2 -translate-y-1/2 text-(--omp-dim) hover:text-(--omp-text)"
							onClick={() => setRevealed(!revealed)}
							type="button"
						>
							{masked ? <Eye size={13} /> : <EyeOff size={13} />}
						</button>
					)}
				</div>
			);
		}
	}

	return (
		<div className="settings-field-row rounded-md px-2 py-2 transition-colors hover:bg-(--omp-bg-tertiary)">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-(--omp-text)" title={entry.path}>
						{label}
					</span>

					{restartBadge}
					{status}
				</div>
				{description && (
					<span className="mt-0.5 block text-[11px] leading-snug text-(--omp-muted)">{description}</span>
				)}
			</div>
			<div className="settings-field-control">{control}</div>
		</div>
	);
}

/**
 * Bucket one tab's entries for rendering: ungrouped settings first (no
 * heading), then groups in the schema-declared order, with groups missing
 * from the declared order appended defensively at the end.
 */
export function groupSchemaEntries(
	entries: SettingEntry[],
	tabId: string,
	groups: string[],
): {
	tabEntries: SettingEntry[];
	ungrouped: SettingEntry[];
	orderedGroups: { name: string; entries: SettingEntry[] }[];
} {
	const tabEntries = entries.filter(entry => entry.tab === tabId);
	const byGroup = new Map<string, SettingEntry[]>();
	const ungrouped: SettingEntry[] = [];
	for (const entry of tabEntries) {
		if (entry.group === undefined) {
			ungrouped.push(entry);
			continue;
		}
		const list = byGroup.get(entry.group) ?? [];
		list.push(entry);
		byGroup.set(entry.group, list);
	}
	const ordered = groups.filter(group => byGroup.has(group));
	for (const name of byGroup.keys()) {
		if (!ordered.includes(name)) ordered.push(name);
	}
	return {
		tabEntries,
		ungrouped,
		orderedGroups: ordered.map(name => ({ name, entries: byGroup.get(name) ?? [] })),
	};
}

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

/** Settings without UI metadata (advanced): searchable flat list. */
function AdvancedTab({
	entries,
	values,
	onCommitted,
}: {
	entries: SettingEntry[];
	values: Record<string, unknown>;
	onCommitted: (path: string, value: unknown) => void;
}) {
	const [query, setQuery] = useState("");
	const advanced = useMemo(
		() =>
			entries.filter(
				entry => (entry.advanced === true || entry.tab === undefined) && isSettingVisibleInGui(entry, values),
			),
		[entries, values],
	);
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (q.length === 0) return advanced;
		return advanced.filter(
			entry => entry.path.toLowerCase().includes(q) || (entry.label ?? "").toLowerCase().includes(q),
		);
	}, [advanced, query]);

	return (
		<>
			<div className="relative mb-3">
				<Search className="absolute top-1/2 left-2.5 -translate-y-1/2 text-(--omp-dim)" size={13} />
				<Input
					className="pl-7"
					onChange={event => setQuery(event.target.value)}
					placeholder={`Filter ${advanced.length} advanced settings…`}
					value={query}
				/>
			</div>
			{filtered.length === 0 ? (
				<div className="py-10 text-center text-xs text-(--omp-dim)">No advanced settings match.</div>
			) : (
				filtered.map(entry => (
					<SchemaSettingRow entry={entry} key={entry.path} onCommitted={onCommitted} value={values[entry.path]} />
				))
			)}
		</>
	);
}

function CapabilityCard({
	icon,
	title,
	description,
	status,
	statusActive = false,
	featured = false,
	children,
}: {
	icon: ReactNode;
	title: string;
	description: string;
	status?: string;
	statusActive?: boolean;
	featured?: boolean;
	children: ReactNode;
}) {
	return (
		<section
			className={`rounded-xl border bg-transparent p-4 ${
				featured
					? "settings-capability-featured border-[color-mix(in_srgb,var(--omp-accent)_45%,var(--omp-border-muted))]"
					: "border-(--omp-border-muted)"
			}`}
		>
			<div className="flex items-start gap-3">
				<div
					className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center ${featured ? "text-(--omp-accent)" : "text-(--omp-muted)"}`}
				>
					{icon}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="text-[13px] font-semibold text-(--omp-text)">{title}</h3>
						{status && (
							<span
								className={`rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium ${
									statusActive
										? "border-[color-mix(in_srgb,var(--omp-success)_35%,transparent)] bg-transparent text-(--omp-success)"
										: "border-(--omp-border-muted) text-(--omp-dim)"
								}`}
							>
								{status}
							</span>
						)}
					</div>
					<p className="mt-1 text-[11.5px] leading-relaxed text-(--omp-muted)">{description}</p>
				</div>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>
		</section>
	);
}

interface CapabilitiesHomeProps {
	ready: boolean;
	ttsrEnabled: boolean;
	advisorEnabled: boolean;
	advisorActive: boolean | undefined;
	memoryBackend: string;
	onConfigureTtsr: () => void;
	onOpenAgents: () => void;
	onOpenModelRoles: () => void;
	onConfigureAdvisor: () => void;
	onOpenGoal: () => void;
	onOpenLoop: () => void;
	onOpenMemory: () => void;
	onOpenTools: () => void;
}

export function CapabilitiesHome({
	ready,
	ttsrEnabled,
	advisorEnabled,
	advisorActive,
	memoryBackend,
	onConfigureTtsr,
	onOpenAgents,
	onOpenModelRoles,
	onConfigureAdvisor,
	onOpenGoal,
	onOpenLoop,
	onOpenMemory,
	onOpenTools,
}: CapabilitiesHomeProps) {
	const t = useT();
	const stateLabel = (enabled: boolean) =>
		ready
			? t(enabled ? "settings.capabilities.enabled" : "settings.capabilities.disabled")
			: t("settings.capabilities.loading");

	return (
		<div>
			<header className="mb-6 max-w-2xl">
				<div className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] text-(--omp-accent) uppercase">
					<Sparkles size={12} />
					{t("settings.capabilities.eyebrow")}
				</div>
				<h2 className="text-xl font-semibold tracking-tight text-(--omp-text)">
					{t("settings.capabilities.title")}
				</h2>
				<p className="mt-2 text-[12px] leading-relaxed text-(--omp-muted)">
					{t("settings.capabilities.description")}
				</p>
			</header>

			<div className="settings-capability-grid">
				<CapabilityCard
					description={t("settings.capabilities.ttsrDesc")}
					featured
					icon={<ShieldCheck size={17} />}
					status={stateLabel(ttsrEnabled)}
					statusActive={ready && ttsrEnabled}
					title={t("settings.capabilities.ttsr")}
				>
					{/* Toggle lives in Context › Rules (schema owns the value); this card
					    is discovery + navigation only. */}
					<Button onClick={onConfigureTtsr} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureRules")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.agentsDesc")}
					icon={<Network size={16} />}
					title={t("settings.capabilities.agents")}
				>
					<Button onClick={onOpenAgents} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.openAgentHub")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.modelRolesDesc")}
					icon={<Bot size={16} />}
					title={t("settings.capabilities.modelRoles")}
				>
					<Button onClick={onOpenModelRoles} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureModelRoles")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.advisorDesc")}
					icon={<BrainCircuit size={16} />}
					status={
						ready && advisorEnabled && advisorActive === false
							? t("settings.capabilities.advisorInactive")
							: stateLabel(advisorEnabled)
					}
					statusActive={ready && advisorEnabled && advisorActive !== false}
					title={t("settings.capabilities.advisor")}
				>
					{/* Toggle lives in Model › Advisor (schema owns the value). */}
					<Button onClick={onConfigureAdvisor} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureAdvisor")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.modesDesc")}
					icon={<Route size={16} />}
					title={t("settings.capabilities.modes")}
				>
					<Button onClick={onOpenGoal} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.goalMode")}
					</Button>
					<Button onClick={onOpenLoop} size="sm" type="button" variant="ghost">
						{t("settings.capabilities.loopMode")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.memoryDesc")}
					icon={<Database size={16} />}
					status={
						ready
							? t("settings.capabilities.memoryBackend", {
									backend: memoryBackend || t("settings.capabilities.unconfigured"),
								})
							: t("settings.capabilities.loading")
					}
					statusActive={ready && memoryBackend !== "" && memoryBackend !== "off"}
					title={t("settings.capabilities.memory")}
				>
					<Button onClick={onOpenMemory} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureMemory")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.toolsDesc")}
					icon={<Wrench size={16} />}
					title={t("settings.capabilities.tools")}
				>
					<Button onClick={onOpenTools} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureTools")}
					</Button>
				</CapabilityCard>
			</div>
		</div>
	);
}

const CAPABILITIES_TAB_ID = "capabilities";
const SKILLS_TAB_ID = "skills";
const MCP_TAB_ID = "mcp";
const RESOURCES_TAB_ID = "resources";
const HOOKS_TAB_ID = "hooks";
const COMMANDS_TAB_ID = "commands";
const SECURITY_TAB_ID = "security";
const SSH_TAB_ID = "ssh";
const UPDATES_TAB_ID = "updates";
const ADVANCED_TAB_ID = "advanced";
const GUI_TAB_ID = "gui";

const MANAGEMENT_TAB_IDS = new Set([
	SKILLS_TAB_ID,
	MCP_TAB_ID,
	RESOURCES_TAB_ID,
	HOOKS_TAB_ID,
	COMMANDS_TAB_ID,
	SECURITY_TAB_ID,
	SSH_TAB_ID,
	UPDATES_TAB_ID,
]);

const SEARCHABLE_MANAGEMENT_TAB_IDS = new Set([
	SKILLS_TAB_ID,
	MCP_TAB_ID,
	RESOURCES_TAB_ID,
	HOOKS_TAB_ID,
	COMMANDS_TAB_ID,
]);

export function resolveSettingsTarget(target: string | null | undefined): {
	tab: string;
	resourceTab?: InventoryTabId;
} {
	const requested = target || CAPABILITIES_TAB_ID;
	if (!requested.startsWith(`${RESOURCES_TAB_ID}:`)) return { tab: requested };
	const resource = requested.slice(RESOURCES_TAB_ID.length + 1);
	const resourceTab: InventoryTabId =
		resource === "marketplaces" || resource === "templates" || resource === "memory" ? resource : "plugins";
	return { tab: RESOURCES_TAB_ID, resourceTab };
}

interface SettingsNavGroup {
	id: "overview" | "extensions" | "operations" | "configuration" | "application";
	items: TabItem[];
}

export function SettingsWindow() {
	const t = useT();
	const open = useUiStore(state => state.settingsOpen);
	const requestedTab = useUiStore(state => state.settingsTab);
	const close = useUiStore(state => state.closeSettings);
	const setFontSize = useUiStore(state => state.setFontSize);
	const setPanelTab = useUiStore(state => state.setPanelTab);
	const setNotifications = useUiStore(state => state.setNotifications);
	const setTranscriptDetail = useUiStore(state => state.setTranscriptDetail);
	const fontSize = useUiStore(state => state.fontSize);
	const panelTab = useUiStore(state => state.panelTab);
	const notifications = useUiStore(state => state.notifications);
	const thinkingExpanded = useUiStore(state => state.thinkingExpanded);
	const transcriptDetail = useUiStore(state => state.transcriptDetail);
	const sidecarReady = useSessionStore(state => state.status === "ready");

	const [tab, setTab] = useState(CAPABILITIES_TAB_ID);
	const [resourceTab, setResourceTab] = useState<InventoryTabId>("plugins");
	const [query, setQuery] = useState("");
	const [loadState, setLoadState] = useState<LoadState>("loading");
	const [loadError, setLoadError] = useState<string | null>(null);
	const [schema, setSchema] = useState<SettingsSchemaResult | null>(null);
	const [values, setValues] = useState<Record<string, unknown>>({});
	const [fontSizeDraft, setFontSizeDraft] = useState<string | null>(null);
	const [proxyDraft, setProxyDraft] = useState<string | null>(null);
	const [savedProxy, setSavedProxy] = useState("");
	const [launchProfile, setLaunchProfile] = useState<LaunchProfile>({});
	const [launchDrafts, setLaunchDrafts] = useState<Partial<Record<LaunchTextField, string>>>({});
	const [launchRestarting, setLaunchRestarting] = useState(false);
	const [codeLineNumbers, setCodeLineNumbers] = useState(false);
	const cwd = useSessionStore(state => state.cwd);
	const workspaceName = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "oh-my-pi";
	// Never restart out from under a model run, compaction, or foreground
	// composer execution. Bash/eval pending bubbles are the live execution
	// signal and disappear only after their RPC settles.
	const sessionBusy = useSessionStore(state => state.isStreaming || state.isCompacting);
	const executionBusy = useMessagesStore(state =>
		state.messages.some(
			message =>
				(message.role === "bashExecution" || message.role === "pythonExecution") && message.running === true,
		),
	);
	const sidecarBusy = sessionBusy || executionBusy;
	const [reloadToken, setReloadToken] = useState(0);
	const [advisorActive, setAdvisorActive] = useState<boolean>();

	useEffect(() => {
		if (!open) return;
		const target = resolveSettingsTarget(requestedTab);
		if (target.resourceTab) setResourceTab(target.resourceTab);
		setTab(target.tab);
		setQuery("");
	}, [open, requestedTab]);

	// Hydrate the schema, current values, and GUI prefs each time the window
	// opens or the sidecar reconnects.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadToken is the explicit retry trigger.
	useEffect(() => {
		if (!open || !sidecarReady) return;
		let cancelled = false;
		setLoadState("loading");
		setLoadError(null);
		void (async () => {
			try {
				const [schemaRes, settingsRes] = await Promise.all([
					window.omp.rpc.getSettingsSchema(),
					window.omp.rpc.getSettings(),
				]);
				if (cancelled) return;
				if (!schemaRes.success) {
					setSchema(null);
					setLoadError(schemaRes.error);
					setLoadState("error");
					return;
				}
				const result = schemaRes.data as SettingsSchemaResult | undefined;
				if (!result || !Array.isArray(result.entries) || !Array.isArray(result.tabs)) {
					setSchema(null);
					setLoadError("Malformed settings schema response");
					setLoadState("error");
					return;
				}
				const nextValues: Record<string, unknown> = {};
				for (const entry of result.entries) nextValues[entry.path] = entry.value;
				if (settingsRes.success) {
					const data = settingsRes.data as SettingsResponseData | undefined;
					if (data?.values) Object.assign(nextValues, data.values);
					if (typeof data?.advisorEnabled === "boolean") nextValues["advisor.enabled"] = data.advisorEnabled;
					setAdvisorActive(data?.advisorActive);
				}
				setFontSizeDraft(null);
				setSchema(result);
				setValues(nextValues);
				setLoadState("ready");
			} catch (err) {
				if (!cancelled) {
					setSchema(null);
					setLoadError(String(err));
					setLoadState("error");
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [open, reloadToken, sidecarReady]);

	const handleCommitted = useCallback((path: string, value: unknown) => {
		setValues(prev => ({ ...prev, [path]: value }));
	}, []);

	// External edits (TUI selector, composer controls, another window) push
	// config_update — refresh the displayed values or this window goes stale
	// while sitting open. Values-only refetch: schema/labels don't change, and
	// per-row drafts win over `values` so an in-progress edit is never clobbered.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		const unsubscribe = window.omp.events.onConfigUpdate(() => {
			void window.omp.rpc.getSettings().then(res => {
				if (cancelled || !res.success) return;
				const data = res.data as SettingsResponseData | undefined;
				if (!data?.values) return;
				const nextValues = { ...data.values };
				if (typeof data.advisorEnabled === "boolean") nextValues["advisor.enabled"] = data.advisorEnabled;
				setValues(prev => ({ ...prev, ...nextValues }));
				setAdvisorActive(data.advisorActive);
			});
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [open]);

	const navGroups = useMemo<SettingsNavGroup[]>(() => {
		// No hardcoded Runtime tab: every row it had duplicates another surface —
		// model change (footer/⌥M), thinking (Model schema tab + footer), fast
		// mode (composer ⚡), plan (Tasks tab/⌥⇧P), auto-compact (Context tab),
		// auto-retry (Advanced), message handling (Interaction tab).
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
	}, [schema]);
	// Load the persisted proxy pref each time the window opens.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setProxyDraft(null);
		void window.omp.prefs
			.get("proxyUrl")
			.then(value => {
				if (!cancelled) setSavedProxy(typeof value === "string" ? value : "");
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [open]);

	// Load this workspace's launch profile (prefs `launchProfiles.<cwd>`) and
	// the codeLineNumbers pref each time the window opens or the workspace
	// changes. In-progress blur-commit drafts are workspace-local — reset them.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLaunchDrafts({});
		void window.omp.prefs
			.get("launchProfiles")
			.then(raw => {
				if (cancelled) return;
				const map =
					typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
				setLaunchProfile(parseLaunchProfile(map[cwd]));
			})
			.catch(() => {});
		void window.omp.prefs
			.get("codeLineNumbers")
			.then(value => {
				if (!cancelled) setCodeLineNumbers(value === true);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [open, cwd]);

	// ── GUI-local preferences (prefs IPC) ──
	const applyPanelTab = (next: typeof panelTab) => {
		setPanelTab(next);
		void window.omp.prefs.set("defaultPanelTab", next);
	};
	const applyNotifications = (next: boolean) => {
		setNotifications(next);
		void window.omp.prefs.set("notifications", next);
	};
	const applyThinkingExpanded = (next: boolean) => {
		useUiStore.getState().setThinkingExpanded(next);
		void window.omp.prefs.set("thinkingExpanded", next);
	};
	const applyTranscriptDetail = (next: typeof transcriptDetail) => {
		setTranscriptDetail(next);
		void window.omp.prefs.set("transcriptDetail", next);
	};
	const commitFontSize = () => {
		if (fontSizeDraft === null) return;
		const parsed = Number(fontSizeDraft);
		if (!Number.isFinite(parsed) || parsed < 10 || parsed > 20) {
			setFontSizeDraft(null);
			toast({ variant: "warning", message: "Font size must be between 10 and 20px" });
			return;
		}
		setFontSize(parsed);
		void window.omp.prefs.set("fontSize", parsed);
		setFontSizeDraft(null);
	};
	const commitProxy = () => {
		if (proxyDraft === null) return;
		const next = proxyDraft.trim();
		setProxyDraft(null);
		if (next === savedProxy) return;
		setSavedProxy(next);
		void window.omp.prefs.set("proxyUrl", next || null);
		// Apply immediately when the agent is idle; a busy sidecar keeps its
		// env until the next restart — killing a run to change proxy is never
		// right.
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (isStreaming || isCompacting) {
			toast({ variant: "info", message: t("settings.gui.proxySavedPending") });
			return;
		}
		void window.omp.sidecar.restart();
		toast({ variant: "info", message: t("settings.gui.proxyApplied") });
	};

	// ── Launch profile (per-workspace, prefs `launchProfiles.<cwd>`) ──
	// Write-through like the other GUI prefs: every committed change persists
	// immediately (read-modify-write so other workspaces' profiles survive),
	// so the effective-command preview is always truthful. The sidecar reads
	// the profile at spawn — changes need a restart (note in the section).
	const persistLaunchProfile = (next: LaunchProfile) => {
		setLaunchProfile(next);
		const cleaned = parseLaunchProfile(next);
		void window.omp.prefs
			.get("launchProfiles")
			.then(raw => {
				const map =
					typeof raw === "object" && raw !== null && !Array.isArray(raw)
						? { ...(raw as Record<string, unknown>) }
						: {};
				if (Object.keys(cleaned).length === 0) delete map[cwd];
				else map[cwd] = cleaned;
				void window.omp.prefs.set("launchProfiles", map);
			})
			.catch(() => {});
	};
	const updateLaunchProfile = (patch: Partial<LaunchProfile>) => persistLaunchProfile({ ...launchProfile, ...patch });
	const commitLaunchField = (field: LaunchTextField) => {
		const draft = launchDrafts[field];
		if (draft === undefined) return;
		setLaunchDrafts(prev => {
			const next = { ...prev };
			delete next[field];
			return next;
		});
		const value = LAUNCH_VERBATIM_FIELDS[field] === true ? draft : draft.trim();
		persistLaunchProfile({ ...launchProfile, [field]: value === "" ? undefined : value });
	};
	const pickLaunchAddDirs = async () => {
		const picked = await window.omp.system.showOpenDialog([], { directory: true }).catch(() => null);
		if (!picked || picked.length === 0) return;
		const current = launchProfile.addDirs ?? [];
		const merged = [...current];
		for (const dir of picked) if (!merged.includes(dir)) merged.push(dir);
		if (merged.length !== current.length) updateLaunchProfile({ addDirs: merged });
	};
	const restartForLaunchProfile = () => {
		if (sidecarBusy || launchRestarting) return;
		setLaunchRestarting(true);
		// Preserve the current conversation: the respawned sidecar resumes the
		// active session (--session) instead of starting a fresh one.
		const { sessionFile } = useSessionStore.getState();
		void window.omp.sidecar
			.restart(sessionFile ?? undefined)
			.then(() => {
				toast({ variant: "info", message: t("settings.launch.restarting") });
			})
			.catch(() => {})
			.finally(() => setLaunchRestarting(false));
	};
	const applyCodeLineNumbers = (next: boolean) => {
		setCodeLineNumbers(next);
		// Persists via prefs IPC and flips every mounted markdown code block live.
		setCodeLineNumbersPref(next);
	};

	// Effective command line, refreshed live as fields change: in-progress
	// blur-commit drafts win over persisted values so the preview shows exactly
	// what will run on the next sidecar start.
	const launchPreview = useMemo(() => {
		const effective: LaunchProfile = { ...launchProfile };
		for (const field of LAUNCH_TEXT_FIELDS) {
			const draft = launchDrafts[field];
			if (draft === undefined) continue;
			const value = LAUNCH_VERBATIM_FIELDS[field] === true ? draft : draft.trim();
			if (value === "") delete effective[field];
			else effective[field] = value;
		}
		const suffix = flagsToCommandLine(profileToFlags(effective));
		return suffix === "" ? "omp --mode rpc-ui" : `omp --mode rpc-ui ${suffix}`;
	}, [launchProfile, launchDrafts]);

	const isSchemaTab = schema?.tabs.some(schemaTab => schemaTab.id === tab) === true;
	const managementTab = MANAGEMENT_TAB_IDS.has(tab);
	const showGlobalSearch = !managementTab || SEARCHABLE_MANAGEMENT_TAB_IDS.has(tab);
	const contentWidthClass = managementTab
		? "max-w-[2560px]"
		: tab === CAPABILITIES_TAB_ID
			? "max-w-[1920px]"
			: "max-w-[1200px]";

	// Global search covers every GUI-relevant schema setting across all tabs.
	// TUI-only entries never appear in results.
	const searchGroups = useMemo(() => {
		if (MANAGEMENT_TAB_IDS.has(tab)) return null;
		const q = query.trim().toLowerCase();
		if (!q || !schema) return null;
		const matches = schema.entries.filter(entry => {
			if (!isSettingVisibleInGui(entry, values)) return false;
			const hay = `${entry.path} ${entry.label ?? ""} ${entry.description ?? ""}`.toLowerCase();
			return hay.includes(q);
		});
		const byTab = new Map<string, SettingEntry[]>();
		for (const entry of matches) {
			const key = entry.tab ?? "advanced";
			const list = byTab.get(key) ?? [];
			list.push(entry);
			byTab.set(key, list);
		}
		return byTab;
	}, [query, schema, tab, values]);

	// Focus management for the fullscreen dialog: initial focus, Tab trap, restore.
	const dialogRef = useRef<HTMLDivElement>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!open) return;
		const unregisterLayer = registerDialogLayer(dialogRef.current);
		restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const first = dialogRef.current?.querySelector<HTMLElement>("input, button, select, textarea, [tabindex]");
		first?.focus();
		return () => {
			const wasTopmost = isTopmostDialog(dialogRef.current);
			unregisterLayer();
			if (wasTopmost) restoreFocusRef.current?.focus();
		};
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (!isTopmostDialog(dialogRef.current)) return;
			if (event.key !== "Tab" || !dialogRef.current) return;
			const focusables = [
				...dialogRef.current.querySelectorAll<HTMLElement>(
					'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
				),
			].filter(el => el.offsetParent !== null);
			if (focusables.length === 0) return;
			const first = focusables[0];
			const last = focusables[focusables.length - 1];
			const active = document.activeElement as HTMLElement | null;
			if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open]);

	// Fullscreen page handles its own Escape (no Modal wrapper).
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (!isTopmostDialog(dialogRef.current)) return;
				// An open dropdown (listbox) handles its own Escape; don't close the page.
				if (document.querySelector('[role="listbox"]')) return;
				event.preventDefault();
				close();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open, close]);

	if (!open) return null;

	const tabTitle = (tb: TabItem): string => {
		const key = `settings.tabs.${tb.id}`;
		const translated = t(key);
		return translated === key ? tb.label : translated;
	};

	return createPortal(
		<div
			aria-label={t("settings.title")}
			aria-modal="true"
			className="fixed inset-0 z-50 flex flex-col bg-(--omp-bg-primary) text-(--omp-text)"
			ref={dialogRef}
			role="dialog"
			style={
				{
					"--omp-accent": "#0f8f83",
					"--omp-btn-primary-bg": "#0b8378",
					"--omp-input-focus-border": "#0f8f83",
					"--omp-selected-bg": "color-mix(in srgb, #0f8f83 9%, transparent)",
				} as CSSProperties
			}
		>
			<div className="flex min-h-0 flex-1">
				<nav className="settings-sidebar flex shrink-0 flex-col border-r border-(--omp-border-muted)">
					<div className="flex h-14 shrink-0 items-center gap-2 border-b border-(--omp-border-muted) px-4">
						<PiLogo className="!bg-[#1f2529]" size={24} tile />
						<span className="settings-nav-label min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-(--omp-text)">
							{workspaceName}
						</span>
						<ChevronDown aria-hidden="true" className="settings-nav-label text-(--omp-dim)" size={13} />
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
						{navGroups.map((group, groupIndex) => (
							<section className={groupIndex === 0 ? "" : "settings-nav-group mt-4"} key={group.id}>
								<div className="settings-nav-group-label mb-1 px-3 text-[9px] font-semibold uppercase tracking-[0.14em] text-(--omp-dim)">
									{t(`settings.nav.${group.id}`)}
								</div>
								{group.items.map(tb => {
									const active = tb.id === tab;
									return (
										<button
											className={`settings-nav-item flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[12.5px] transition-colors ${
												active
													? "bg-(--omp-selected-bg) font-medium text-(--omp-text)"
													: "text-(--omp-muted) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
											}`}
											key={tb.id}
											onClick={() => {
												setTab(tb.id);
												setQuery("");
											}}
											title={tabTitle(tb)}
											type="button"
										>
											<span className="flex size-4 shrink-0 items-center justify-center text-(--omp-dim)">
												{tb.id === CAPABILITIES_TAB_ID && <Sparkles aria-hidden="true" size={13} />}
												{tb.id === SKILLS_TAB_ID && <BookOpen aria-hidden="true" size={13} />}
												{tb.id === MCP_TAB_ID && <Network aria-hidden="true" size={13} />}
												{tb.id === RESOURCES_TAB_ID && <Blocks aria-hidden="true" size={13} />}
												{tb.id === HOOKS_TAB_ID && <Webhook aria-hidden="true" size={13} />}
												{tb.id === COMMANDS_TAB_ID && <Braces aria-hidden="true" size={13} />}
												{tb.id === SECURITY_TAB_ID && <ShieldCheck aria-hidden="true" size={13} />}
												{tb.id === SSH_TAB_ID && <Server aria-hidden="true" size={13} />}
												{tb.id === UPDATES_TAB_ID && <HardDriveDownload aria-hidden="true" size={13} />}
												{!MANAGEMENT_TAB_IDS.has(tb.id) &&
													tb.id !== CAPABILITIES_TAB_ID &&
													tb.id !== UPDATES_TAB_ID && <SlidersHorizontal aria-hidden="true" size={13} />}
											</span>
											<span className="settings-nav-label min-w-0 truncate">{tabTitle(tb)}</span>
										</button>
									);
								})}
							</section>
						))}
					</div>
				</nav>
				<main className="settings-main-canvas flex min-w-0 flex-1 flex-col overflow-hidden">
					<header className="flex h-14 shrink-0 items-center gap-3 border-b border-(--omp-border-muted) px-4 min-[1080px]:px-6">
						<div className="min-w-0 flex-1">
							{!managementTab && (
								<h1 className="truncate text-[15px] font-semibold tracking-[-0.015em] text-(--omp-text)">
									{tabTitle({ id: tab, label: tab })}
								</h1>
							)}
						</div>
						{showGlobalSearch && (
							<div className="relative w-[clamp(13rem,32vw,18rem)] max-w-full min-w-0 shrink">
								<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-(--omp-dim)" size={13} />
								<input
									aria-label={t("settings.searchPlaceholder")}
									className="h-8 w-full rounded-lg border border-(--omp-input-border) bg-(--omp-input-bg) pr-12 pl-8 text-[11px] text-(--omp-text) outline-none transition-colors placeholder:text-(--omp-dim) focus:border-(--omp-input-focus-border)"
									onChange={event => setQuery(event.target.value)}
									placeholder={t("settings.searchPlaceholder")}
									spellCheck={false}
									value={query}
								/>
								<span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-(--omp-border-muted) px-1.5 py-0.5 text-[8px] text-(--omp-dim)">
									⌘K
								</span>
							</div>
						)}
						<button
							aria-label={t("settings.close")}
							className="flex h-8 w-8 items-center justify-center rounded-lg text-(--omp-muted) transition-colors hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
							onClick={close}
							type="button"
						>
							<X size={16} />
						</button>
					</header>
					<div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 min-[1080px]:px-6 min-[1440px]:px-8 min-[1080px]:py-5">
						<div className={`settings-content mx-auto w-full ${contentWidthClass}`}>
							{searchGroups === null ? (
								<>
									{tab === SKILLS_TAB_ID && <SkillsSettingsPage query={query} />}
									{tab === MCP_TAB_ID && <ExtensionSettingsPage query={query} tabId="mcp" />}
									{tab === RESOURCES_TAB_ID && (
										<InventorySettingsPage initialTab={resourceTab} query={query} />
									)}
									{tab === HOOKS_TAB_ID && <ExtensionSettingsPage query={query} tabId="hooks" />}
									{tab === COMMANDS_TAB_ID && <ExtensionSettingsPage query={query} tabId="commands" />}
									{tab === SECURITY_TAB_ID && <SecuritySettingsPage />}
									{tab === SSH_TAB_ID && <SshSettingsPage />}
									{tab === UPDATES_TAB_ID && <UpdatesSettingsPage />}
									{tab === CAPABILITIES_TAB_ID && (
										<CapabilitiesHome
											advisorActive={advisorActive}
											advisorEnabled={values["advisor.enabled"] === true}
											memoryBackend={
												typeof values["memory.backend"] === "string" ? values["memory.backend"] : ""
											}
											onConfigureAdvisor={() => {
												setTab("model");
												setQuery("advisor");
											}}
											onConfigureTtsr={() => {
												setTab("context");
												setQuery("ttsr");
											}}
											onOpenAgents={() => {
												close();
												useUiStore.getState().openAgentHub("definitions");
											}}
											onOpenGoal={() => {
												close();
												useUiStore.getState().openModes("goal");
											}}
											onOpenLoop={() => {
												close();
												useUiStore.getState().openModes("loop");
											}}
											onOpenMemory={() => {
												setTab("memory");
												setQuery("");
											}}
											onOpenTools={() => {
												setTab("tools");
												setQuery("");
											}}
											onOpenModelRoles={() => {
												close();
												useUiStore.getState().openModelRoles();
											}}
											ready={loadState === "ready" && sidecarReady}
											ttsrEnabled={values["ttsr.enabled"] === true}
										/>
									)}

									{tab === GUI_TAB_ID && (
										<>
											{/* Theme + language live in the Sidebar's bottom rail — the only
										    home they need; approval mode is Interaction › Approvals'. */}
											<Section title={t("settings.gui.fontSize")}>
												<div className="w-40">
													<Input
														max={20}
														min={10}
														onBlur={commitFontSize}
														onChange={event => setFontSizeDraft(event.target.value)}
														onKeyDown={event => {
															if (event.key === "Enter") event.currentTarget.blur();
														}}
														type="number"
														value={fontSizeDraft ?? String(fontSize)}
													/>
												</div>
												<p className="mt-1.5 text-[11px] text-(--omp-muted)">
													{t("settings.gui.fontSizeDesc")}
												</p>
											</Section>
											<Section title={t("settings.gui.panelDefault")}>
												<RadioGroup
													name="defaultPanelTab"
													onChange={applyPanelTab}
													options={[
														{ value: "todo", label: t("settings.gui.panel.todo") },
														{ value: "agents", label: t("settings.gui.panel.agents") },
														{ value: "diff", label: t("settings.gui.panel.diff") },
														{ value: "files", label: t("settings.gui.panel.files") },
														{ value: "logs", label: t("settings.gui.panel.logs") },
													]}
													value={panelTab}
												/>
											</Section>
											<Section title={t("settings.gui.notifications")}>
												<Toggle
													checked={notifications}
													description={t("settings.gui.notificationsDesc")}
													label={t("settings.gui.notifications")}
													onChange={applyNotifications}
												/>
											</Section>
											<Section title={t("settings.gui.thinkingExpanded")}>
												<Toggle
													checked={thinkingExpanded}
													description={t("settings.gui.thinkingExpandedDesc")}
													label={t("settings.gui.thinkingExpanded")}
													onChange={applyThinkingExpanded}
												/>
											</Section>
											<Section title={t("settings.gui.transcriptDetail")}>
												<RadioGroup
													name="transcriptDetail"
													onChange={applyTranscriptDetail}
													options={[
														{
															value: "compact",
															label: t("settings.gui.transcript.compact"),
															description: t("settings.gui.transcript.compactDesc"),
														},
														{
															value: "full",
															label: t("settings.gui.transcript.full"),
															description: t("settings.gui.transcript.fullDesc"),
														},
													]}
													value={transcriptDetail}
												/>
											</Section>
											<Section title={t("codeblock.title")}>
												<Toggle
													checked={codeLineNumbers}
													description={t("codeblock.lineNumbersDesc")}
													label={t("codeblock.lineNumbers")}
													onChange={applyCodeLineNumbers}
												/>
											</Section>
											<Section title={t("settings.gui.proxy")}>
												<Input
													onBlur={commitProxy}
													onChange={event => setProxyDraft(event.target.value)}
													onKeyDown={event => {
														if (event.key === "Enter") event.currentTarget.blur();
													}}
													placeholder="http://127.0.0.1:7890"
													spellCheck={false}
													value={proxyDraft ?? savedProxy}
												/>
												<p className="mt-1.5 text-[11px] text-(--omp-muted)">
													{t("settings.gui.proxyDesc")}
												</p>
											</Section>
											<Section title={t("settings.launch.title")}>
												<div className="space-y-3">
													<div>
														<span className="mb-1 block text-xs font-medium text-(--omp-text)">
															{t("settings.launch.systemPrompt")}
														</span>
														<TextArea
															mono
															onBlur={() => commitLaunchField("systemPrompt")}
															onChange={event =>
																setLaunchDrafts(prev => ({ ...prev, systemPrompt: event.target.value }))
															}
															placeholder={t("settings.launch.systemPromptPlaceholder")}
															rows={4}
															spellCheck={false}
															value={launchDrafts.systemPrompt ?? launchProfile.systemPrompt ?? ""}
														/>
													</div>
													<div>
														<span className="mb-1 block text-xs font-medium text-(--omp-text)">
															{t("settings.launch.appendSystemPrompt")}
														</span>
														<TextArea
															mono
															onBlur={() => commitLaunchField("appendSystemPrompt")}
															onChange={event =>
																setLaunchDrafts(prev => ({
																	...prev,
																	appendSystemPrompt: event.target.value,
																}))
															}
															placeholder={t("settings.launch.appendSystemPromptPlaceholder")}
															rows={4}
															spellCheck={false}
															value={
																launchDrafts.appendSystemPrompt ??
																launchProfile.appendSystemPrompt ??
																""
															}
														/>
													</div>
													<div>
														<span className="mb-1 block text-xs font-medium text-(--omp-text)">
															{t("settings.launch.addDirs")}
														</span>
														<ArrayChipEditor
															onCommit={dirs => updateLaunchProfile({ addDirs: dirs })}
															placeholder={t("settings.launch.addDirsPlaceholder")}
															values={launchProfile.addDirs ?? []}
														/>
														<div className="mt-1.5">
															<Button
																onClick={() => void pickLaunchAddDirs()}
																size="sm"
																type="button"
																variant="secondary"
															>
																{t("settings.launch.addDirPick")}
															</Button>
														</div>
														<p className="mt-1.5 text-[11px] text-(--omp-muted)">
															{t("settings.launch.addDirsDesc")}
														</p>
													</div>
													<div>
														<span className="mb-1 block text-xs font-medium text-(--omp-text)">
															{t("settings.launch.tools")}
														</span>
														<ArrayChipEditor
															onCommit={tools => updateLaunchProfile({ tools })}
															values={launchProfile.tools ?? []}
														/>
														<p className="mt-1.5 text-[11px] text-(--omp-muted)">
															{t("settings.launch.toolsDesc")}
														</p>
													</div>
													<Toggle
														checked={launchProfile.noRules === true}
														description={t("settings.launch.noRulesDesc")}
														label={t("settings.launch.noRules")}
														onChange={value => updateLaunchProfile({ noRules: value })}
													/>
													<Toggle
														checked={launchProfile.noLsp === true}
														description={t("settings.launch.noLspDesc")}
														label={t("settings.launch.noLsp")}
														onChange={value => updateLaunchProfile({ noLsp: value })}
													/>
													<Toggle
														checked={launchProfile.planYolo === true}
														description={t("settings.launch.planYoloDesc")}
														label={t("settings.launch.planYolo")}
														onChange={value => updateLaunchProfile({ planYolo: value })}
													/>
													<div>
														<span className="mb-1 block text-xs font-medium text-(--omp-text)">
															{t("settings.launch.profile")}
														</span>
														<Input
															onBlur={() => commitLaunchField("profile")}
															onChange={event =>
																setLaunchDrafts(prev => ({ ...prev, profile: event.target.value }))
															}
															onKeyDown={event => {
																if (event.key === "Enter") event.currentTarget.blur();
															}}
															placeholder={t("settings.launch.profilePlaceholder")}
															spellCheck={false}
															value={launchDrafts.profile ?? launchProfile.profile ?? ""}
														/>
													</div>
													<div>
														<span className="mb-1 block text-xs font-medium text-(--omp-text)">
															{t("settings.launch.sessionDir")}
														</span>
														<Input
															onBlur={() => commitLaunchField("sessionDir")}
															onChange={event =>
																setLaunchDrafts(prev => ({ ...prev, sessionDir: event.target.value }))
															}
															onKeyDown={event => {
																if (event.key === "Enter") event.currentTarget.blur();
															}}
															placeholder={t("settings.launch.sessionDirPlaceholder")}
															spellCheck={false}
															value={launchDrafts.sessionDir ?? launchProfile.sessionDir ?? ""}
														/>
													</div>
													<div>
														<span className="mb-1 block text-xs font-medium text-(--omp-text)">
															{t("settings.launch.config")}
														</span>
														<Input
															onBlur={() => commitLaunchField("config")}
															onChange={event =>
																setLaunchDrafts(prev => ({ ...prev, config: event.target.value }))
															}
															onKeyDown={event => {
																if (event.key === "Enter") event.currentTarget.blur();
															}}
															placeholder={t("settings.launch.configPlaceholder")}
															spellCheck={false}
															value={launchDrafts.config ?? launchProfile.config ?? ""}
														/>
													</div>
													<div>
														<span className="mb-1 block text-xs font-medium text-(--omp-text)">
															{t("settings.launch.preview")}
														</span>
														<CodeBlock
															code={launchPreview}
															language="bash"
															showCopy={false}
															showLineNumbers={false}
														/>
													</div>
													<div className="flex items-center gap-3 rounded-md border border-[var(--omp-warning)]/40 px-3 py-2">
														<span className="min-w-0 flex-1 text-[11px] text-[var(--omp-warning)]">
															{t("settings.launch.restartNote")}
														</span>
														<Button
															disabled={sidecarBusy || launchRestarting}
															onClick={restartForLaunchProfile}
															size="sm"
															type="button"
															variant="secondary"
														>
															{launchRestarting
																? t("settings.launch.restarting")
																: t("settings.launch.restartNow")}
														</Button>
													</div>
													{sidecarBusy && (
														<p className="text-[11px] text-(--omp-muted)">
															{t("settings.launch.busyHint")}
														</p>
													)}
												</div>
											</Section>
										</>
									)}

									{(isSchemaTab || tab === ADVANCED_TAB_ID) && loadState === "loading" && (
										<div className="flex items-center justify-center gap-2 py-10">
											<Spinner size="sm" />
											<span className="text-xs text-(--omp-muted)">Loading settings schema…</span>
										</div>
									)}
									{(isSchemaTab || tab === ADVANCED_TAB_ID) && loadState === "error" && (
										<div className="flex flex-col items-center gap-3 py-10">
											<span className="text-xs text-(--omp-error)">
												{loadError ?? "Failed to load settings"}
											</span>
											<span className="text-[10px] text-(--omp-dim)">
												The agent process may not be responding. Runtime and GUI tabs remain available.
											</span>
											<Button
												onClick={() => setReloadToken(token => token + 1)}
												size="sm"
												type="button"
												variant="secondary"
											>
												Retry
											</Button>
										</div>
									)}
									{loadState === "ready" && schema && isSchemaTab && (
										<SchemaTabContent
											entries={schema.entries}
											groups={schema.tabs.find(schemaTab => schemaTab.id === tab)?.groups ?? []}
											onCommitted={handleCommitted}
											tabId={tab}
											values={values}
										/>
									)}
									{loadState === "ready" && schema && tab === ADVANCED_TAB_ID && (
										<AdvancedTab entries={schema.entries} onCommitted={handleCommitted} values={values} />
									)}
								</>
							) : searchGroups.size === 0 ? (
								<div className="py-10 text-center text-xs text-(--omp-dim)">{t("settings.noMatches")}</div>
							) : (
								[...searchGroups.entries()].map(([tabId, entries]) => (
									<Section key={tabId} title={tabTitle({ id: tabId, label: tabId })}>
										{entries.map(entry => (
											<SchemaSettingRow
												key={entry.path}
												entry={entry}
												onCommitted={handleCommitted}
												value={values[entry.path]}
											/>
										))}
									</Section>
								))
							)}
							{!managementTab && (
								<div className="mt-8 flex items-center justify-between gap-2 border-t border-(--omp-border-muted) pt-4">
									<span className="text-[11px] text-(--omp-dim)">{t("settings.applyImmediately")}</span>
									<Button onClick={close} type="button" variant="primary">
										{t("settings.close")}
									</Button>
								</div>
							)}
						</div>
					</div>
				</main>
			</div>
		</div>,
		document.body,
	);
}
