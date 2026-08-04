/**
 * Settings window (Cmd+,): schema-driven editor for the agent settings
 * schema. Tabs, groups, labels, and control types all come from the
 * sidecar (get_settings_schema / get_settings RPC); writes go through
 * set_setting and apply immediately. Two dedicated tabs sit beside the
 * schema tabs: "Runtime" for live RPC toggles (fast mode, steering,
 * plan mode, …) and "GUI" for renderer-local preferences persisted via
 * prefs IPC. Schema entries without UI metadata land in "Advanced".
 * String-typed settings that reference a model or a provider (last path
 * segment ends in Model/Provider) render as searchable dropdowns fed by
 * get_available_models / get_providers instead of free-text inputs.
 */

import { Check, Eye, EyeOff, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SettingEntry, SettingsSchemaResult, ThinkingLevel } from "../../../shared/rpc-types";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { useLang, useT } from "../../lib/i18n";
import { applyThemeByName, getPersistedThemeSelection, THEMES, type ThemeName } from "../../lib/themes";
import { Button, Input, LangSwitcher, Modal, Spinner, type TabItem, Tabs, TextArea } from "../common";
import { ArrayChipEditor } from "./editors/ArrayChipEditor";
import { EnumerableSelect, type EnumerableOption } from "./editors/EnumerableSelect";
import { ProviderLimitsEditor } from "./editors/ProviderLimitsEditor";
import { RecordKvEditor } from "./editors/RecordKvEditor";
import { ModelValueSelect, settingRefKind } from "./ModelValueSelect";
import { ZH_GROUP_TITLES, ZH_SETTINGS } from "./schema-zh";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type ApprovalMode = "always-ask" | "write" | "yolo";
type LoadState = "loading" | "error" | "ready";

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
	autoThinkingActive: values => values["defaultThinkingLevel"] === "auto",
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

// Theme live preview (TUI onThemePreview parity): browsing theme.dark/
// theme.light options temporarily applies the same-named GUI theme — the GUI
// ports the agent palettes — then reverts to the persisted GUI selection on
// close/commit, since the agent theme setting never drives GUI appearance.
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

function Toggle({
	checked,
	onChange,
	label,
	description,
	disabled,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	label: string;
	description?: string;
	disabled?: boolean;
}) {
	return (
		<label className="flex cursor-pointer items-start justify-between gap-4 rounded-md px-2 py-2 transition-colors hover:bg-(--omp-bg-tertiary)">
			<span className="min-w-0">
				<span className="block text-xs font-medium text-(--omp-text)">{label}</span>
				{description && (
					<span className="mt-0.5 block text-[11px] leading-snug text-(--omp-muted)">{description}</span>
				)}
			</span>
			<button
				aria-checked={checked}
				className={`relative mt-0.5 h-4.5 w-8 shrink-0 rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
					checked ? "bg-(--omp-accent)" : "bg-(--omp-bg-tertiary) border border-(--omp-border-muted)"
				}`}
				disabled={disabled}
				onClick={() => onChange(!checked)}
				role="switch"
				type="button"
			>
				<span
					className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-all duration-150 ${
						checked ? "left-4" : "left-0.5"
					}`}
				/>
			</button>
		</label>
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
					setSaved(true);
					window.clearTimeout(savedTimer.current);
					savedTimer.current = window.setTimeout(() => setSaved(false), 2000);
				} else {
					toast({ variant: "error", title: "Setting not saved", message: res.error });
				}
			} catch (err) {
				toast({ variant: "error", title: "Setting not saved", message: String(err) });
			} finally {
				setSaving(false);
			}
		},
		[entry.path, onCommitted],
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
	}, [draft, baseDraft, entry.type, commit]);

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
	}, [draft, baseDraft, entry.type, commit]);

	const onTextKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") event.currentTarget.blur();
		if (event.key === "Escape") {
			setDraft(null);
			setError(null);
			event.currentTarget.blur();
		}
	};

	const status = <SettingStatus dirty={dirty} saving={saving} saved={saved} />;
	// Honest labeling: settings that only drive TUI chrome get a badge so a GUI
	// user doesn't expect an effect this client can't deliver; settings cached
	// at session construction get a restart badge (applies in EVERY client).
	const tuiBadge =
		entry.tuiOnly === true ? (
			<span
				title={t("settings.tuiOnly.hint")}
				className="shrink-0 rounded border border-(--omp-border-muted) px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-(--omp-dim)"
			>
				{t("settings.tuiOnly.badge")}
			</span>
		) : null;
	const restartBadge =
		entry.restartRequired === true ? (
			<span
				title={t("settings.restartRequired.hint")}
				className="shrink-0 rounded border border-[var(--omp-warning)]/40 px-1 py-px text-[9.5px] font-medium uppercase tracking-wide text-[var(--omp-warning)]"
			>
				{t("settings.restartRequired.badge")}
			</span>
		) : null;

	// Boolean settings render as a full-row toggle and write immediately.
	if (entry.type === "boolean") {
		return (
			<div className="relative">
				<Toggle
					checked={value === true}
					description={description}
					disabled={saving}
					label={label}
					onChange={next => void commit(next)}
				/>
				<div className="absolute top-2 right-10 flex items-center gap-1.5">
					{tuiBadge}
					{restartBadge}
					<div className="pointer-events-none">{status}</div>
				</div>
			</div>
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
					{tuiBadge}
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
		<div className="flex items-start justify-between gap-4 rounded-md px-2 py-2 transition-colors hover:bg-(--omp-bg-tertiary)">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-(--omp-text)" title={entry.path}>
						{label}
					</span>
					{tuiBadge}
					{restartBadge}
					{status}
				</div>
				{description && (
					<span className="mt-0.5 block text-[11px] leading-snug text-(--omp-muted)">{description}</span>
				)}
			</div>
			<div className="w-56 shrink-0">{control}</div>
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
	// Drop entries whose condition gate currently resolves false; groups left
	// empty by the filter emit no heading (groupSchemaEntries skips them).
	const visibleEntries = useMemo(() => entries.filter(entry => isSettingVisible(entry, values)), [entries, values]);
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
		() => entries.filter(entry => (entry.advanced === true || entry.tab === undefined) && isSettingVisible(entry, values)),
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

const RUNTIME_TAB_ID = "runtime";
const ADVANCED_TAB_ID = "advanced";
const GUI_TAB_ID = "gui";

export function SettingsWindow() {
	const t = useT();
	const open = useUiStore(state => state.settingsOpen);
	const close = useUiStore(state => state.closeSettings);
	const setTheme = useUiStore(state => state.setTheme);
	const setFontSize = useUiStore(state => state.setFontSize);
	const setPanelTab = useUiStore(state => state.setPanelTab);
	const setNotifications = useUiStore(state => state.setNotifications);
	const theme = useUiStore(state => state.theme);
	const fontSize = useUiStore(state => state.fontSize);
	const panelTab = useUiStore(state => state.panelTab);
	const notifications = useUiStore(state => state.notifications);
	const thinkingExpanded = useUiStore(state => state.thinkingExpanded);
	const settings = useSettingsStore();
	const model = useModelStore(state => state.model);
	const thinkingLevel = useModelStore(state => state.thinkingLevel);
	const fastModeEnabled = useModelStore(state => state.fastModeEnabled);
	const planModeEnabled = useSessionStore(state => state.planModeEnabled);

	const [tab, setTab] = useState(RUNTIME_TAB_ID);
	const [query, setQuery] = useState("");
	const [loadState, setLoadState] = useState<LoadState>("loading");
	const [loadError, setLoadError] = useState<string | null>(null);
	const [schema, setSchema] = useState<SettingsSchemaResult | null>(null);
	const [values, setValues] = useState<Record<string, unknown>>({});
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>("yolo");
	const [fontSizeDraft, setFontSizeDraft] = useState<string | null>(null);
	const [reloadToken, setReloadToken] = useState(0);

	// Hydrate the schema, current values, and GUI prefs each time the window opens.
	useEffect(() => {
		if (!open) return;
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
					const data = settingsRes.data as { values?: Record<string, unknown> } | undefined;
					if (data?.values) Object.assign(nextValues, data.values);
				}
				const configured = nextValues["tools.approvalMode"];
				setApprovalMode(
					configured === "always-ask" || configured === "write" || configured === "yolo" ? configured : "yolo",
				);
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
	}, [open, reloadToken]);

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
				const data = res.data as { values?: Record<string, unknown> } | undefined;
				if (!data?.values) return;
				setValues(prev => ({ ...prev, ...data.values }));
				const configured = data.values["tools.approvalMode"];
				if (configured === "always-ask" || configured === "write" || configured === "yolo") {
					setApprovalMode(configured);
				}
			});
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [open]);

	const tabs = useMemo<TabItem[]>(() => {
		const list: TabItem[] = [{ id: RUNTIME_TAB_ID, label: "Runtime" }];
		if (schema) {
			for (const schemaTab of schema.tabs) list.push({ id: schemaTab.id, label: schemaTab.label });
		}
		list.push({ id: ADVANCED_TAB_ID, label: "Advanced" }, { id: GUI_TAB_ID, label: "GUI" });
		return list;
	}, [schema]);

	// ── Runtime RPC toggles (existing behaviour, applied immediately) ──
	const applyFastMode = async (enabled: boolean) => {
		const res = await window.omp.rpc.setFastMode(enabled);
		if (res.success) {
			const data = res.data as { enabled?: boolean; active?: boolean } | undefined;
			useModelStore.setState({
				fastModeEnabled: data?.enabled ?? enabled,
				fastModeActive: data?.active ?? false,
			});
		} else {
			toast({ variant: "error", title: "Fast mode", message: res.error });
		}
	};
	const applyPlanMode = async (enabled: boolean) => {
		const res = await window.omp.rpc.setPlanMode(enabled);
		if (res.success) {
			const data = res.data as { enabled?: boolean } | undefined;
			useSessionStore.setState({ planModeEnabled: data?.enabled ?? enabled });
		} else {
			toast({ variant: "error", title: "Plan mode", message: res.error });
		}
	};
	const applySteeringMode = async (mode: "all" | "one-at-a-time") => {
		const res = await window.omp.rpc.setSteeringMode(mode);
		if (res.success) settings.update({ steeringMode: mode });
		else toast({ variant: "error", title: "Steering mode", message: res.error });
	};
	const applyFollowUpMode = async (mode: "all" | "one-at-a-time") => {
		const res = await window.omp.rpc.setFollowUpMode(mode);
		if (res.success) settings.update({ followUpMode: mode });
		else toast({ variant: "error", title: "Follow-up mode", message: res.error });
	};
	const applyInterruptMode = async (mode: "immediate" | "wait") => {
		const res = await window.omp.rpc.setInterruptMode(mode);
		if (res.success) settings.update({ interruptMode: mode });
		else toast({ variant: "error", title: "Interrupt mode", message: res.error });
	};
	const applyAutoCompaction = async (enabled: boolean) => {
		const res = await window.omp.rpc.setAutoCompaction(enabled);
		if (res.success) settings.update({ autoCompaction: enabled });
		else toast({ variant: "error", title: "Auto-compaction", message: res.error });
	};
	const applyAutoRetry = async (enabled: boolean) => {
		const res = await window.omp.rpc.setAutoRetry(enabled);
		if (res.success) settings.update({ autoRetry: enabled });
		else toast({ variant: "error", title: "Auto-retry", message: res.error });
	};
	const applyThinkingLevel = async (level: ThinkingLevel) => {
		const res = await window.omp.rpc.setThinkingLevel(level);
		if (res.success) useModelStore.setState({ thinkingLevel: level });
		else toast({ variant: "error", title: "Thinking level", message: res.error });
	};

	// ── GUI-local preferences (prefs IPC) ──
	// Route through applyThemeByName: it persists `themeName` (read FIRST at
	// boot by getPersistedThemeSelection) and the legacy `theme` pref
	// coherently. Writing only the legacy pref left a previously picked named
	// theme to silently win on the next launch.
	const applyTheme = (next: "dark" | "light" | "system") => {
		setTheme(next);
		applyThemeByName(next);
	};
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
	const applyApprovalMode = (next: ApprovalMode) => {
		setApprovalMode(next);
		// Update the shared store too so the composer ApprovalControl + tray reflect
		// the change immediately (set_setting applies at runtime, no restart).
		useSettingsStore.getState().setApprovalMode(next);
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

	const isSchemaTab = schema !== null && schema.tabs.some(schemaTab => schemaTab.id === tab);

	// Global search: filter every schema setting by path/label/description across
	// all tabs (TUI type-to-search parity). Grouped by tab for display.
	const searchGroups = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q || !schema) return null;
		const matches = schema.entries.filter(entry => {
			if (!isSettingVisible(entry, values)) return false;
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
	}, [query, schema, values]);

	// Focus management for the fullscreen dialog: initial focus, Tab trap, restore.
	const dialogRef = useRef<HTMLDivElement>(null);
	const restoreFocusRef = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (!open) return;
		restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const first = dialogRef.current?.querySelector<HTMLElement>("input, button, select, textarea, [tabindex]");
		first?.focus();
		return () => restoreFocusRef.current?.focus();
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || !dialogRef.current) return;
			const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
			)].filter(el => el.offsetParent !== null);
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
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-b border-(--omp-border-muted) px-5">
				<h1 className="text-[15px] font-semibold text-(--omp-text)">{t("settings.title")}</h1>
				<div className="relative ml-4 flex-1 max-w-md">
					<Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-(--omp-dim)" />
					<input
						aria-label={t("settings.searchPlaceholder")}
						className="w-full rounded-md border border-(--omp-input-border) bg-(--omp-input-bg) py-1.5 pr-3 pl-8 text-xs text-(--omp-text) outline-none transition-colors placeholder:text-(--omp-dim) focus:border-(--omp-input-focus-border)"
						onChange={e => setQuery(e.target.value)}
						placeholder={t("settings.searchPlaceholder")}
						spellCheck={false}
						value={query}
					/>
				</div>
				<button
					aria-label={t("settings.close")}
					className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-(--omp-muted) transition-colors hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
					onClick={close}
					type="button"
				>
					<X size={18} />
				</button>
			</header>
			<div className="flex min-h-0 flex-1">
				<nav className="w-56 shrink-0 overflow-y-auto border-r border-(--omp-border-muted) px-3 py-4">
					{tabs.map(tb => {
						const active = tb.id === tab;
						return (
							<button
								className={`flex w-full items-center rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
									active
										? "bg-(--omp-selected-bg) font-medium text-(--omp-text)"
										: "text-(--omp-muted) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
								}`}
								key={tb.id}
								onClick={() => setTab(tb.id)}
								type="button"
							>
								{tabTitle(tb)}
							</button>
						);
					})}
				</nav>
				<main className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
					<div className="mx-auto max-w-3xl">
					{searchGroups === null ? (
						<>
					{tab === RUNTIME_TAB_ID && (
						<>
							<Section title={t("settings.runtime.activeModel")}>
								<div className="flex items-center gap-2 rounded-md border border-(--omp-border-muted) bg-(--omp-bg-primary) px-3 py-2.5">
									<span className="min-w-0 flex-1 truncate font-mono text-xs text-(--omp-status-model)">
										{model ? `${model.provider}/${model.id}` : t("settings.runtime.noModel")}
									</span>
									<Button
										onClick={() => {
											close();
											useUiStore.getState().openModelPicker();
										}}
										size="sm"
										type="button"
										variant="secondary"
									>
										{t("settings.runtime.change")}
									</Button>
								</div>
							</Section>
							<Section title={t("settings.runtime.thinkingLevel")}>
								<div className="flex flex-wrap gap-1">
									{THINKING_LEVELS.map(level => {
										const active = thinkingLevel === level;
										return (
											<button
												className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors ${
													active
														? "border-(--omp-accent) bg-[color-mix(in_srgb,var(--omp-accent)_12%,transparent)] text-(--omp-accent)"
														: "border-(--omp-border-muted) text-(--omp-muted) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
												}`}
												key={level}
												onClick={() => void applyThinkingLevel(level)}
												type="button"
											>
												{level}
											</button>
										);
									})}
								</div>
								<p className="mt-2 text-[11px] text-(--omp-muted)">
									{t("settings.runtime.thinkingDesc")}
								</p>
							</Section>
							<Section title={t("settings.runtime.runtime")}>
								<Toggle
									checked={fastModeEnabled}
									description={t("settings.runtime.fastModeDesc")}
									label={t("settings.runtime.fastMode")}
									onChange={enabled => void applyFastMode(enabled)}
								/>
								<Toggle
									checked={planModeEnabled}
									description={t("settings.runtime.planModeDesc")}
									label={t("settings.runtime.planMode")}
									onChange={enabled => void applyPlanMode(enabled)}
								/>
								<Toggle
									checked={settings.autoCompaction}
									description={t("settings.runtime.autoCompactionDesc")}
									label={t("settings.runtime.autoCompaction")}
									onChange={enabled => void applyAutoCompaction(enabled)}
								/>
								<Toggle
									checked={settings.autoRetry}
									description={t("settings.runtime.autoRetryDesc")}
									label={t("settings.runtime.autoRetry")}
									onChange={enabled => void applyAutoRetry(enabled)}
								/>
							</Section>
							<Section title={t("settings.runtime.messageHandling")}>
								<RadioGroup
									name="steeringMode"
									onChange={value => void applySteeringMode(value)}
									options={[
										{
											value: "all",
											label: t("settings.runtime.steerAll"),
											description: t("settings.runtime.steerAllDesc"),
										},
										{
											value: "one-at-a-time",
											label: t("settings.runtime.steerOne"),
											description: t("settings.runtime.steerOneDesc"),
										},
									]}
									value={settings.steeringMode}
								/>
								<div className="h-2" />
								<RadioGroup
									name="followUpMode"
									onChange={value => void applyFollowUpMode(value)}
									options={[
										{
											value: "all",
											label: t("settings.runtime.followUpAll"),
											description: t("settings.runtime.followUpAllDesc"),
										},
										{
											value: "one-at-a-time",
											label: t("settings.runtime.followUpOne"),
											description: t("settings.runtime.followUpOneDesc"),
										},
									]}
									value={settings.followUpMode}
								/>
								<div className="h-2" />
								<RadioGroup
									name="interruptMode"
									onChange={value => void applyInterruptMode(value)}
									options={[
										{
											value: "immediate",
											label: t("settings.runtime.interruptImmediate"),
											description: t("settings.runtime.interruptImmediateDesc"),
										},
										{
											value: "wait",
											label: t("settings.runtime.interruptWait"),
											description: t("settings.runtime.interruptWaitDesc"),
										},
									]}
									value={settings.interruptMode}
								/>
							</Section>
						</>
					)}

					{tab === GUI_TAB_ID && (
						<>
							<Section title={t("settings.gui.theme")}>
								<RadioGroup
									name="theme"
									onChange={applyTheme}
									options={[
										{ value: "dark", label: t("settings.gui.dark") },
										{ value: "light", label: t("settings.gui.light") },
										{ value: "system", label: t("settings.gui.system"), description: t("settings.gui.systemDesc") },
									]}
									value={theme}
								/>
							</Section>
							<Section title={t("lang.switch")}>
								<div className="flex items-center gap-2">
									<LangSwitcher />
								</div>
							</Section>
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
								<p className="mt-1.5 text-[11px] text-(--omp-muted)">{t("settings.gui.fontSizeDesc")}</p>
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
							<Section title={t("settings.gui.approvalMode")}>
								<RadioGroup
									name="approvalMode"
									onChange={applyApprovalMode}
									options={[
										{
											value: "always-ask",
											label: t("settings.gui.approval.alwaysAsk"),
											description: t("settings.gui.approval.alwaysAskDesc"),
										},
										{
											value: "write",
											label: t("settings.gui.approval.write"),
											description: t("settings.gui.approval.writeDesc"),
										},
										{
											value: "yolo",
											label: t("settings.gui.approval.yolo"),
											description: t("settings.gui.approval.yoloDesc"),
										},
									]}
									value={approvalMode}
								/>
								<p className="mt-2 text-[11px] text-(--omp-muted)">
									{t("settings.gui.approval.note")}
								</p>
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
							<span className="text-xs text-(--omp-error)">{loadError ?? "Failed to load settings"}</span>
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
									<SchemaSettingRow key={entry.path} entry={entry} onCommitted={handleCommitted} value={values[entry.path]} />
								))}
							</Section>
						))
					)}
					<div className="mt-8 flex items-center justify-between gap-2 border-t border-(--omp-border-muted) pt-4">
						<span className="text-[11px] text-(--omp-dim)">{t("settings.applyImmediately")}</span>
						<Button onClick={close} type="button" variant="primary">
							{t("settings.close")}
						</Button>
					</div>
					</div>
				</main>
			</div>
		</div>,
		document.body,
	);
}
