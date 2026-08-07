/**
 * Cmd+K command palette: fuzzy-searches the declarative command registry
 * and executes typed UI affordances (RPC actions, toggles, pickers, windows,
 * submenus, prompts) instead of injecting "/command" text into the composer.
 */

import { Check, ChevronRight, CornerDownLeft, History, Search, Slash, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AvailableCommand } from "../../../shared/rpc-types";
import { hydrateSession } from "../../hooks/use-rpc-events";
import {
	buildCommandMenu,
	type CommandAffordance,
	type CommandMenuItem,
	forkSessionFromGui,
	groupByCategory,
} from "../../lib/command-registry";
import { useT } from "../../lib/i18n";
import { retryLastTurn as retryLastTurnShared } from "../../lib/messages";
import { openHandoffDialog } from "../../stores/fork-handoff";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Spinner } from "../common";

const RECENT_KEY = "omp.palette.recent";
const RECENT_LIMIT = 5;

function loadRecent(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		return raw ? (JSON.parse(raw) as string[]) : [];
	} catch {
		return [];
	}
}

function saveRecent(names: string[]) {
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(names.slice(0, RECENT_LIMIT)));
	} catch {
		// Storage unavailable — recents are best-effort.
	}
}

/** Subsequence fuzzy score; null = no match. Earlier + denser wins. */
function fuzzyScore(query: string, target: string): number | null {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	if (q.length === 0) return 0;
	let qi = 0;
	let score = 0;
	let last = -2;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			score += ti === last + 1 ? 2 : 1;
			last = ti;
			qi++;
		}
	}
	return qi === q.length ? score : null;
}

interface ScoredItem {
	item: CommandMenuItem;
	score: number;
}

/** Execute an affordance, closing the palette and surfacing errors. */
async function runAffordance(
	affordance: CommandAffordance,
	close: () => void,
	t: (key: string) => string,
): Promise<void> {
	switch (affordance.kind) {
		case "action":
			close();
			try {
				await affordance.run();
			} catch (error) {
				toast({ variant: "error", title: t("palette.failed"), message: String(error) });
			}
			return;
		case "toggle":
			close();
			try {
				await affordance.set(!affordance.get());
			} catch (error) {
				toast({ variant: "error", title: t("palette.failed"), message: String(error) });
			}
			return;
		case "picker":
			close();
			affordance.open();
			return;
		case "window":
			close();
			affordance.open();
			return;
		case "prompt":
			close();
			try {
				await window.omp.rpc.prompt(affordance.text.trim());
			} catch (error) {
				toast({ variant: "error", title: t("palette.failed"), message: String(error) });
			}
			return;
		case "submenu":
		case "unavailable":
			// Handled by the caller (submenu expands; unavailable is disabled).
			return;
	}
}

export function CommandPalette() {
	const t = useT();
	const open = useUiStore(state => state.commandPaletteOpen);
	const close = useUiStore(state => state.closeCommandPalette);
	const openModelPicker = useUiStore(state => state.openModelPicker);
	const openSettings = useUiStore(state => state.openSettings);
	const openUsage = useUiStore(state => state.openUsage);
	const openProviders = useUiStore(state => state.openProviders);
	const openModelRoles = useUiStore(state => state.openModelRoles);
	const openStatsDashboard = useUiStore(state => state.openStatsDashboard);
	const openRenameDialog = useUiStore(state => state.openRenameDialog);
	const openSessionPicker = useUiStore(state => state.openSessionPicker);
	const openBranchPicker = useUiStore(state => state.openBranchPicker);
	const openSessionTree = useUiStore(state => state.openSessionTree);
	const openSessionInfo = useUiStore(state => state.openSessionInfo);
	const openModelCompare = useUiStore(state => state.openModelCompare);
	const openExtensions = useUiStore(state => state.openExtensions);
	const openInventory = useUiStore(state => state.openInventory);
	const openThemePicker = useUiStore(state => state.openThemePicker);
	const openModes = useUiStore(state => state.openModes);
	const openAgentHub = useUiStore(state => state.openAgentHub);
	const openPrCenter = useUiStore(state => state.openPrCenter);
	const openHotkeys = useUiStore(state => state.openHotkeys);
	const openImportDialog = useUiStore(state => state.openImportDialog);
	const openProviderConfig = useUiStore(state => state.openProviderConfig);
	const setPanelTab = useUiStore(state => state.setPanelTab);

	const isStreaming = useSessionStore(s => s.isStreaming);
	const fastModeEnabled = useModelStore(s => s.fastModeEnabled);
	const autoCompaction = useSettingsStore(s => s.autoCompaction);
	const autoRetry = useSettingsStore(s => s.autoRetry);
	const steeringMode = useSettingsStore(s => s.steeringMode);
	const followUpMode = useSettingsStore(s => s.followUpMode);
	const interruptMode = useSettingsStore(s => s.interruptMode);
	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const prewalkArmed = useSessionStore(s => s.prewalkArmed);

	const [query, setQuery] = useState("");
	const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
	const [loading, setLoading] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const [recent, setRecent] = useState<string[]>(loadRecent);
	/** When set, the palette is drilled into a submenu's items. */
	const [submenu, setSubmenu] = useState<CommandMenuItem | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActiveIndex(0);
		setSubmenu(null);
		requestAnimationFrame(() => inputRef.current?.focus());
		let cancelled = false;
		setLoading(true);
		window.omp.rpc
			.getAvailableCommands()
			.then(response => {
				if (cancelled) return;
				if (response.success) {
					const data = response.data as { commands?: AvailableCommand[] } | undefined;
					setAvailableCommands(data?.commands ?? []);
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	/** Retry: re-send the most recent user message; interrupt the active turn when streaming. */
	const retryLastTurn = useCallback(
		() =>
			retryLastTurnShared(() =>
				toast({ variant: "warning", title: t("palette.retryNothing"), message: t("palette.retryNothingDesc") }),
			),
		[t],
	);

	/** Retry the last FAILED turn via the retry RPC (TUI /retry parity). */
	const retryTurn = useCallback(async () => {
		const response = await window.omp.rpc.retry();
		if (!response.success) {
			toast({ variant: "error", title: t("palette.failed"), message: response.error });
			return;
		}
		const data = response.data as { retried?: boolean } | undefined;
		if (!data?.retried) {
			toast({ variant: "warning", title: t("palette.retryNothing"), message: t("palette.retryNothingDesc") });
		}
	}, [t]);

	const menuItems = useMemo(
		() =>
			buildCommandMenu({
				t,
				isStreaming,
				fastModeEnabled,
				autoCompaction,
				autoRetry,
				steeringMode,
				followUpMode,
				interruptMode,
				planModeEnabled,
				prewalkArmed,
				availableCommands,
				openModelPicker,
				openSettings,
				openUsage,
				openProviders,
				openModelRoles,
				openStatsDashboard,
				openRenameDialog,
				openSessionPicker,
				openBranchPicker,
				openSessionTree,
				openSessionInfo,
				openModelCompare,
				openHandoffDialog,
				forkSession: forkSessionFromGui,
				hydrateSession,
				openExtensions,
				openInventory,
				openThemePicker,
				openModes,
				openAgentHub,
				openPrCenter,
				openHotkeys,
				openImportDialog,
				openProviderConfig,
				openWorkspaceTab: setPanelTab,
				openCommandPalette: () => {},
				retryTurn,
				retryLastTurn,
				rpc: {
					setFastMode: enabled => window.omp.rpc.setFastMode(enabled),
					setAutoCompaction: enabled => window.omp.rpc.setAutoCompaction(enabled),
					setAutoRetry: enabled => window.omp.rpc.setAutoRetry(enabled),
					setSteeringMode: mode => window.omp.rpc.setSteeringMode(mode),
					setFollowUpMode: mode => window.omp.rpc.setFollowUpMode(mode),
					setInterruptMode: mode => window.omp.rpc.setInterruptMode(mode),
					compact: instructions => window.omp.rpc.compact(instructions),
					newSession: () => window.omp.rpc.newSession(),
					handoff: () => window.omp.rpc.handoff(),
					prompt: message => window.omp.rpc.prompt(message),
					setPlanMode: enabled => window.omp.rpc.setPlanMode(enabled),
					setPrewalk: enabled => window.omp.rpc.setPrewalk(enabled),
					exportHtml: path => window.omp.rpc.exportHtml(path),
					setSessionName: name => window.omp.rpc.setSessionName(name),
					cycleModel: () => window.omp.rpc.cycleModel(),
					cycleThinkingLevel: () => window.omp.rpc.cycleThinkingLevel(),
				},
			}),
		[
			t,
			isStreaming,
			fastModeEnabled,
			autoCompaction,
			autoRetry,
			steeringMode,
			followUpMode,
			interruptMode,
			planModeEnabled,
			prewalkArmed,
			availableCommands,
			openModelPicker,
			openSettings,
			openUsage,
			openProviders,
			openModelRoles,
			openStatsDashboard,
			openRenameDialog,
			openSessionPicker,
			openBranchPicker,
			openSessionTree,
			openSessionInfo,
			retryLastTurn,
			retryTurn,
			openModes,
			openProviderConfig,
			setPanelTab,
			openModelCompare,
			openAgentHub,
			openPrCenter,
			openHotkeys,
			openImportDialog,
			openThemePicker,
			openInventory,
			openExtensions,
		],
	);

	// The working set: submenu items when drilled in, else the full menu.
	const workingItems = useMemo(
		() => (submenu?.affordance.kind === "submenu" ? submenu.affordance.items : menuItems),
		[submenu, menuItems],
	);

	const results = useMemo<ScoredItem[]>(() => {
		const q = query.trim();
		const scored: ScoredItem[] = [];
		for (const item of workingItems) {
			const targets = [item.name, item.label, item.description ?? "", ...(item.aliases ?? [])];
			let best: number | null = null;
			for (const target of targets) {
				const score = fuzzyScore(q, target);
				if (score !== null && (best === null || score > best)) best = score;
			}
			if (best !== null) scored.push({ item, score: best });
		}
		return scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
	}, [workingItems, query]);

	// When not searching the top level, group by category for readability.
	const grouped = useMemo(() => {
		if (submenu || query.trim().length > 0) return null;
		return groupByCategory(results.map(r => r.item));
	}, [results, submenu, query]);

	// Pinned recents: top level with an empty query only, resolved against the
	// live menu so stale names from a previous session are dropped.
	const recentItems = useMemo(() => {
		if (submenu || query.trim().length > 0) return [];
		const byName = new Map(menuItems.map(item => [item.name, item]));
		return recent.map(name => byName.get(name)).filter((item): item is CommandMenuItem => item != null);
	}, [menuItems, recent, submenu, query]);

	const flatList = useMemo(() => {
		if (grouped) {
			const flat: CommandMenuItem[] = [...recentItems];
			for (const items of grouped.values()) flat.push(...items);
			return flat;
		}
		return results.map(r => r.item);
	}, [grouped, recentItems, results]);

	const recordRecent = useCallback(
		(name: string) => {
			const next = [name, ...recent.filter(n => n !== name)].slice(0, RECENT_LIMIT);
			setRecent(next);
			saveRecent(next);
		},
		[recent],
	);

	const execute = useCallback(
		(item: CommandMenuItem) => {
			if (item.affordance.kind === "unavailable") {
				toast({ variant: "warning", message: `${item.label}: ${item.affordance.reason}` });
				return;
			}
			if (item.affordance.kind === "submenu") {
				setSubmenu(item);
				setQuery("");
				setActiveIndex(0);
				requestAnimationFrame(() => inputRef.current?.focus());
				return;
			}
			recordRecent(item.name);
			void runAffordance(item.affordance, close, t);
		},
		[recordRecent, close, t],
	);

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				setActiveIndex(index => Math.min(index + 1, flatList.length - 1));
				break;
			case "ArrowUp":
				event.preventDefault();
				setActiveIndex(index => Math.max(index - 1, 0));
				break;
			case "ArrowLeft":
				if (submenu) {
					event.preventDefault();
					setSubmenu(null);
					setActiveIndex(0);
				}
				break;
			case "Enter": {
				event.preventDefault();
				const item = flatList[activeIndex];
				if (item) execute(item);
				break;
			}
			case "Escape":
				event.preventDefault();
				if (submenu) setSubmenu(null);
				else close();
				break;
		}
	};

	useEffect(() => {
		setActiveIndex(0);
	}, []);

	useEffect(() => {
		listRef.current?.querySelector(`[data-palette-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	if (!open) return null;

	let flatIndex = -1;

	const renderItem = (item: CommandMenuItem, options?: { categoryLabel?: string; recent?: boolean }) => {
		flatIndex++;
		const index = flatIndex;
		const isActive = index === activeIndex;
		const disabled = item.affordance.kind === "unavailable";
		const isSubmenu = item.affordance.kind === "submenu";
		const toggleOn = item.affordance.kind === "toggle" ? item.affordance.get() : null;

		return (
			<button
				className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
					isActive ? "bg-(--omp-selected-bg)" : "hover:bg-(--omp-bg-tertiary)"
				} ${disabled ? "opacity-45" : ""}`}
				data-palette-index={index}
				key={item.name}
				onClick={() => execute(item)}
				onMouseEnter={() => setActiveIndex(index)}
				type="button"
			>
				{options?.recent ? (
					<History className="shrink-0 text-(--omp-accent)" size={12} />
				) : (
					<Slash className="shrink-0 text-(--omp-accent)" size={12} />
				)}
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5">
						<span className="truncate text-xs font-medium text-(--omp-text)">{item.label}</span>
						{toggleOn !== null && (
							<span
								className={`rounded px-1 text-[9px] font-semibold uppercase ${
									toggleOn
										? "bg-(--omp-success)/15 text-(--omp-success)"
										: "bg-(--omp-bg-tertiary) text-(--omp-dim)"
								}`}
							>
								{toggleOn ? t("palette.on") : t("palette.off")}
							</span>
						)}
						{item.shortcut && (
							<kbd className="rounded border border-(--omp-border-muted) px-1 text-[9px] text-(--omp-dim)">
								{item.shortcut}
							</kbd>
						)}
					</span>
					<span className="block truncate text-[10.5px] text-(--omp-muted)">
						{disabled && item.affordance.kind === "unavailable" ? item.affordance.reason : item.description}
					</span>
				</span>
				{options?.categoryLabel && (
					<span className="shrink-0 text-[9px] tracking-wide text-(--omp-dim) uppercase">
						{options.categoryLabel}
					</span>
				)}
				{isSubmenu ? (
					<ChevronRight className="shrink-0 text-(--omp-dim)" size={12} />
				) : (
					toggleOn !== null && (
						<Check className={`shrink-0 ${toggleOn ? "text-(--omp-success)" : "text-transparent"}`} size={12} />
					)
				)}
				{isActive && !isSubmenu && toggleOn === null && (
					<CornerDownLeft className="shrink-0 text-(--omp-dim)" size={11} />
				)}
			</button>
		);
	};

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[14vh] backdrop-blur-[2px]"
			onMouseDown={event => {
				if (event.target === event.currentTarget) close();
			}}
			role="presentation"
		>
			<div className="w-[560px] max-w-[92vw] overflow-hidden rounded-lg border border-(--omp-border-muted) bg-(--omp-bg-secondary) shadow-2xl shadow-black/60">
				<div className="flex items-center gap-2.5 border-b border-(--omp-border-muted) px-3.5 py-2.5">
					{submenu && (
						<button
							type="button"
							onClick={() => setSubmenu(null)}
							className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-(--omp-accent) hover:bg-(--omp-bg-tertiary)"
						>
							<X size={11} />
							{submenu.label}
						</button>
					)}
					<Search className="shrink-0 text-(--omp-dim)" size={14} />
					<input
						aria-label={t("palette.searchLabel")}
						className="min-w-0 flex-1 bg-transparent text-sm text-(--omp-text) placeholder:text-(--omp-dim) focus:outline-none"
						onChange={event => setQuery(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={submenu ? t("palette.searchSubmenu", { name: submenu.label }) : t("palette.search")}
						ref={inputRef}
						value={query}
					/>
					{loading && <Spinner size="sm" />}
					<kbd className="shrink-0 rounded border border-(--omp-border-muted) bg-(--omp-bg-tertiary) px-1.5 py-0.5 text-[9px] text-(--omp-dim)">
						esc
					</kbd>
				</div>
				<div className="max-h-[46vh] overflow-y-auto p-1.5" ref={listRef}>
					{flatList.length === 0 && !loading && (
						<div className="px-3 py-8 text-center text-xs text-(--omp-dim)">
							{workingItems.length === 0 ? t("palette.noCommands") : t("palette.noMatch")}
						</div>
					)}

					{grouped ? (
						<>
							{recentItems.length > 0 && (
								<div className="mb-1">
									<div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[9px] font-semibold tracking-widest text-(--omp-dim) uppercase">
										{t("palette.recent")}
									</div>
									{recentItems.map(item => renderItem(item, { recent: true }))}
								</div>
							)}
							{Array.from(grouped.entries()).map(([category, items]) => (
								<div key={category} className="mb-1">
									<div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-[9px] font-semibold tracking-widest text-(--omp-dim) uppercase">
										{t(`category.${category}`)}
									</div>
									{items.map(item => renderItem(item))}
								</div>
							))}
						</>
					) : (
						flatList.map(item => renderItem(item))
					)}
				</div>
			</div>
		</div>
	);
}
