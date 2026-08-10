/**
 * Theme picker: searchable overlay of the GUI's named themes plus "system".
 * Each card shows a live swatch preview from the theme's token set. Selecting
 * a theme applies it live (inline `--omp-*` tokens), persists the choice, and
 * keeps the legacy dark/light/system store coherent so the App effect and the
 * settings window stay in sync.
 */

import { Check, Monitor, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
	applyThemeByName,
	getPersistedThemeSelection,
	resolveTokenColor,
	THEMES,
	type ThemeName,
	type ThemeSelection,
} from "../../lib/themes";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { registerDialogLayer } from "../common/dialog-layer";

const SWATCH_KEYS = [
	"--omp-bg-primary",
	"--omp-bg-secondary",
	"--omp-bg-tertiary",
	"--omp-accent",
	"--omp-text",
] as const;

interface ThemeEntry {
	selection: ThemeSelection;
	label: string;
	description: string;
}

/** Catalog themes (labels/descriptions are theme metadata and stay as-authored). */
const THEME_ENTRIES: ThemeEntry[] = (Object.keys(THEMES) as ThemeName[]).map(name => ({
	selection: name as ThemeSelection,
	label: THEMES[name].label,
	description: THEMES[name].description ?? "",
}));

export function ThemePickerDialog() {
	const t = useT();
	const open = useUiStore(s => s.themePickerOpen);
	const close = useUiStore(s => s.closeThemePicker);
	const setTheme = useUiStore(s => s.setTheme);

	const [query, setQuery] = useState("");
	const [current, setCurrent] = useState<ThemeSelection>("system");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);

	const entries = useMemo<ThemeEntry[]>(
		() => [
			{ selection: "system", label: t("themePicker.system"), description: t("themePicker.systemDesc") },
			...THEME_ENTRIES,
		],
		[t],
	);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter(e => e.label.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
	}, [entries, query]);

	useEffect(() => {
		if (!open) return;
		const unregisterLayer = registerDialogLayer(dialogRef.current);
		setQuery("");
		setActive(0);
		void getPersistedThemeSelection().then(sel => {
			setCurrent(sel);
			const themeIndex = THEME_ENTRIES.findIndex(e => e.selection === sel);
			setActive(sel === "system" ? 0 : Math.max(0, themeIndex + 1));
		});
		requestAnimationFrame(() => inputRef.current?.focus());
		return unregisterLayer;
	}, [open]);

	const select = (entry: ThemeEntry) => {
		const sel = entry.selection;
		applyThemeByName(sel);
		setTheme(sel === "system" ? "system" : THEMES[sel].scheme);
		setCurrent(sel);
		toast({ variant: "success", message: t("themePicker.applied", { name: entry.label }) });
		close();
	};

	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive(i => Math.min(filtered.length - 1, i + 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive(i => Math.max(0, i - 1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const entry = filtered[active];
			if (entry) select(entry);
		} else if (e.key === "Escape") {
			e.preventDefault();
			close();
		}
	};

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	if (!open) return null;

	return (
		<div
			ref={dialogRef}
			aria-modal="true"
			className="omp-dialog-overlay fixed inset-0 z-50 flex items-start justify-center bg-[var(--omp-overlay-bg)] p-4 pt-[12dvh] backdrop-blur-[2px]"
			onClick={close}
			onKeyDown={onKey}
			role="dialog"
			aria-label={t("themePicker.aria")}
		>
			<div
				className="omp-dialog-panel omp-dialog-size-picker overflow-hidden rounded-[14px] border border-[var(--omp-modal-border)] bg-[var(--omp-modal-bg)] shadow-[var(--omp-shadow-lg)]"
				onClick={e => e.stopPropagation()}
			>
				<div className="flex items-center gap-2 border-b border-[var(--omp-border-muted)] px-4 py-3">
					<Search size={15} className="shrink-0 text-[var(--omp-dim)]" />
					<input
						ref={inputRef}
						value={query}
						onChange={e => {
							setQuery(e.target.value);
							setActive(0);
						}}
						placeholder={t("themePicker.search")}
						className="w-full bg-transparent text-[14px] text-[var(--omp-text)] outline-none placeholder:text-[var(--omp-dim)]"
					/>
				</div>
				<div ref={listRef} className="omp-command-list overflow-y-auto p-2">
					{filtered.length === 0 && (
						<div className="px-3 py-8 text-center text-[13px] text-[var(--omp-dim)]">
							{t("themePicker.empty")}
						</div>
					)}
					{filtered.map((entry, i) => {
						const isSystem = entry.selection === "system";
						const theme = isSystem ? null : THEMES[entry.selection as ThemeName];
						const isCurrent = entry.selection === current;
						return (
							<button
								key={entry.selection}
								type="button"
								data-index={i}
								onClick={() => select(entry)}
								onMouseEnter={() => setActive(i)}
								className={cx(
									"flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
									i === active ? "bg-[var(--omp-selected-bg)]" : "hover:bg-[var(--omp-bg-tertiary)]",
								)}
							>
								<span className="flex h-9 w-14 shrink-0 items-center overflow-hidden rounded-md border border-[var(--omp-border-muted)]">
									{isSystem ? (
										<span className="flex h-full w-full items-center justify-center bg-[var(--omp-bg-tertiary)] text-[var(--omp-dim)]">
											<Monitor size={15} />
										</span>
									) : (
										SWATCH_KEYS.map(key => (
											<span
												key={key}
												className="h-full flex-1"
												style={{ background: resolveTokenColor(theme!, key) }}
											/>
										))
									)}
								</span>
								<span className="min-w-0 flex-1">
									<span className="flex items-center gap-2 text-[13.5px] font-medium text-[var(--omp-text)]">
										{entry.label}
										{isCurrent && <Check size={14} className="text-[var(--omp-accent)]" />}
									</span>
									<span className="block truncate text-[12px] text-[var(--omp-dim)]">{entry.description}</span>
								</span>
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}
