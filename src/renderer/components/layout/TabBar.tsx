/**
 * Session tab strip, mounted between TitleBar and SidecarBanner. One chip per
 * pooled sidecar tab: session title (or cwd basename; identical untitled
 * labels disambiguate with an index suffix), a streaming dot while the tab's
 * agent runs, a done badge when a background run settled since the last
 * visit, a close × (hidden at the single-tab floor, inline-confirmed while a
 * run is live), and a trailing "+" that opens a fresh session tab in the
 * current cwd. The strip scrolls horizontally on overflow instead of
 * shrinking chips past readability.
 */

import { Check, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { type SessionTab, tabChipLabel, useTabsStore } from "../../stores/tabs";

/** Auto-cancel window for the armed close confirm (injectable for tests). */
const CONFIRM_CLOSE_MS = 3000;

function TabChip({
	tab,
	active,
	label,
	confirmingClose,
	onArmClose,
	onConfirmClose,
	onCancelClose,
}: {
	tab: SessionTab;
	active: boolean;
	label: string;
	confirmingClose: boolean;
	onArmClose: () => void;
	onConfirmClose: () => void;
	onCancelClose: () => void;
}) {
	const t = useT();
	const switchTab = useTabsStore(s => s.switchTab);
	const closeTab = useTabsStore(s => s.closeTab);
	const closable = useTabsStore(s => s.tabs.length > 1);
	// The active tab's live stream state sharpens the dot between status pushes.
	const activeStreaming = useSessionStore(s => (active ? s.isStreaming : false));
	const running = tab.status === "running" || (active && activeStreaming);
	// Closing kills the tab's sidecar: a live run (running, starting, or the
	// active tab's stream outrunning the pool's status pushes) dies with it,
	// so those route through the inline confirm. Idle tabs close immediately.
	const closeNeedsConfirm = running || tab.status === "starting";

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
			{confirmingClose ? (
				<span className="min-w-0 truncate text-[var(--omp-error)]" title={t("tabs.confirmClose")}>
					{t("tabs.confirmClose")}
				</span>
			) : (
				<span className="min-w-0 truncate">{label}</span>
			)}
			{tab.unreadDone && (
				<span
					role="img"
					aria-label={t("tabs.done")}
					title={t("tabs.done")}
					className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--omp-success)]"
				/>
			)}
			{closable &&
				(confirmingClose ? (
					<span className="-mr-1 flex shrink-0 items-center gap-0.5">
						<button
							type="button"
							aria-label={t("common.confirm")}
							title={t("tabs.confirmClose")}
							onClick={event => {
								event.stopPropagation();
								onConfirmClose();
							}}
							className="omp-pressable flex h-4 w-4 items-center justify-center rounded bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)] hover:brightness-110"
						>
							<Check size={11} strokeWidth={3} />
						</button>
						<button
							type="button"
							aria-label={t("common.cancel")}
							title={t("common.cancel")}
							onClick={event => {
								event.stopPropagation();
								onCancelClose();
							}}
							className="omp-pressable flex h-4 w-4 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-primary)] hover:text-[var(--omp-text)]"
						>
							<X size={11} />
						</button>
					</span>
				) : (
					<button
						type="button"
						aria-label={t("tabs.close")}
						title={t("tabs.close")}
						onClick={event => {
							event.stopPropagation();
							// Live tabs arm the inline confirm (the close kills their
							// run); idle tabs close immediately.
							if (closeNeedsConfirm) onArmClose();
							else void closeTab(tab.id);
						}}
						className={cx(
							"omp-pressable -mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-primary)] hover:text-[var(--omp-text)]",
							active ? "flex" : "hidden group-hover:flex",
						)}
					>
						<X size={11} />
					</button>
				))}
		</div>
	);
}

export function TabBar({ confirmCloseMs = CONFIRM_CLOSE_MS }: { confirmCloseMs?: number }) {
	const t = useT();
	const tabs = useTabsStore(s => s.tabs);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const openTab = useTabsStore(s => s.openTab);
	const closeTab = useTabsStore(s => s.closeTab);
	// Inline close confirm for live tabs (AgentHub abort parity): the first
	// click arms, the ✓ executes, ✕ or the timeout cancels. One arm at a time.
	const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
	const confirmTimerRef = useRef<number | undefined>(undefined);

	useEffect(() => {
		return () => {
			window.clearTimeout(confirmTimerRef.current);
		};
	}, []);

	const cancelCloseConfirm = () => {
		window.clearTimeout(confirmTimerRef.current);
		confirmTimerRef.current = undefined;
		setConfirmCloseId(null);
	};

	const armCloseConfirm = (id: string) => {
		cancelCloseConfirm();
		setConfirmCloseId(id);
		confirmTimerRef.current = window.setTimeout(() => {
			confirmTimerRef.current = undefined;
			setConfirmCloseId(null);
		}, confirmCloseMs);
	};

	const confirmClose = (id: string) => {
		cancelCloseConfirm();
		void closeTab(id);
	};

	return (
		<div
			role="tablist"
			aria-label={t("tabs.strip")}
			className="drag-region flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--omp-border-muted)] bg-[var(--omp-titlebar-bg)] px-2"
		>
			{tabs.map(tab => (
				<TabChip
					key={tab.id}
					tab={tab}
					active={tab.id === activeTabId}
					label={tabChipLabel(tab, tabs)}
					confirmingClose={confirmCloseId === tab.id}
					onArmClose={() => armCloseConfirm(tab.id)}
					onConfirmClose={() => confirmClose(tab.id)}
					onCancelClose={cancelCloseConfirm}
				/>
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
