/**
 * Session tab strip, mounted between TitleBar and SidecarBanner. One chip per
 * pooled sidecar tab: session title (or cwd basename), a streaming dot while
 * the tab's agent runs, a done badge when a background run settled since the
 * last visit, a close × (hidden at the single-tab floor), and a trailing "+"
 * that opens a fresh session tab in the current cwd. The strip scrolls
 * horizontally on overflow instead of shrinking chips past readability.
 */

import { Plus, X } from "lucide-react";
import { basename, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { type SessionTab, useTabsStore } from "../../stores/tabs";

function TabChip({ tab, active }: { tab: SessionTab; active: boolean }) {
	const t = useT();
	const switchTab = useTabsStore(s => s.switchTab);
	const closeTab = useTabsStore(s => s.closeTab);
	const closable = useTabsStore(s => s.tabs.length > 1);
	// The active tab's live stream state sharpens the dot between status pushes.
	const activeStreaming = useSessionStore(s => (active ? s.isStreaming : false));
	const running = tab.status === "running" || (active && activeStreaming);
	// `||` everywhere: empty-string titles (never-generated auto-title slot)
	// fall through to the cwd basename like null.
	const label = tab.title || basename(tab.cwd) || t("sidebar.newSession");

	return (
		<div
			role="tab"
			aria-selected={active}
			tabIndex={0}
			onClick={() => void switchTab(tab.id)}
			onKeyDown={event => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					void switchTab(tab.id);
				}
			}}
			title={tab.cwd || label}
			className={cx(
				"no-drag group flex h-7 min-w-0 max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 text-[12px] select-none",
				active
					? "bg-[var(--omp-selected-bg)] font-medium text-[var(--omp-text)]"
					: "text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]",
			)}
		>
			{running && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--omp-accent)]" />}
			<span className="min-w-0 truncate">{label}</span>
			{tab.unreadDone && (
				<span
					role="img"
					aria-label={t("tabs.done")}
					title={t("tabs.done")}
					className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--omp-success)]"
				/>
			)}
			{closable && (
				<button
					type="button"
					aria-label={t("tabs.close")}
					title={t("tabs.close")}
					onClick={event => {
						event.stopPropagation();
						void closeTab(tab.id);
					}}
					className={cx(
						"omp-pressable -mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-primary)] hover:text-[var(--omp-text)]",
						active ? "flex" : "hidden group-hover:flex",
					)}
				>
					<X size={11} />
				</button>
			)}
		</div>
	);
}

export function TabBar() {
	const t = useT();
	const tabs = useTabsStore(s => s.tabs);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const openTab = useTabsStore(s => s.openTab);

	return (
		<div
			role="tablist"
			aria-label={t("tabs.strip")}
			className="drag-region flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--omp-border-muted)] bg-[var(--omp-titlebar-bg)] px-2"
		>
			{tabs.map(tab => (
				<TabChip key={tab.id} tab={tab} active={tab.id === activeTabId} />
			))}
			<button
				type="button"
				aria-label={t("tabs.new")}
				title={t("tabs.new")}
				onClick={() => void openTab()}
				className="no-drag omp-pressable flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
			>
				<Plus size={14} />
			</button>
		</div>
	);
}
