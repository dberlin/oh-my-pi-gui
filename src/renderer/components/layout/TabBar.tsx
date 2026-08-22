/**
 * Session tab strip, mounted between TitleBar and SidecarBanner. One chip per
 * pooled sidecar tab: session title (or local cwd basename / host-qualified
 * remote basename; identical untitled labels disambiguate with an index
 * suffix), a slow status signal, a muted workspace subtitle, a close ×
 * (hidden at the single-tab floor, inline-confirmed while a run is live), and
 * a trailing "+" that opens a fresh session tab in the current cwd. The strip
 * scrolls horizontally on overflow instead of shrinking chips past
 * readability.
 */

import { Check, GitBranch, GitBranchPlus, MessageCircle, MessageCirclePlus, Plus, Server, X } from "lucide-react";
import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSessionList } from "../../hooks/use-session-list";
import { basename, cx, sanitizeDisplayText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { sessionDisplayTitle, sessionHasContent } from "../../lib/session-title";
import { useComposerStore } from "../../stores/composer";
import { useMessagesStore } from "../../stores/messages";
import { useQueueStore } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { type SessionTab, tabChipLabel, useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor } from "../common/ContextMenu";

/** Auto-cancel window for the armed close confirm (injectable for tests). */
const CONFIRM_CLOSE_MS = 3000;

/** Chip subtitle bound; matches the per-component limit the chip title uses. */
const TAB_WORKSPACE_LABEL_LIMIT = 64;

function TabChip({
	tab,
	active,
	label,
	workspaceLabel,
	confirmingClose,
	onArmClose,
	onConfirmClose,
	onCancelClose,
	onContextMenu,
}: {
	tab: SessionTab;
	active: boolean;
	label: string;
	workspaceLabel: string;
	confirmingClose: boolean;
	onArmClose: () => void;
	onConfirmClose: () => void;
	onCancelClose: () => void;
	onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
	const t = useT();
	const switchTab = useTabsStore(s => s.switchTab);
	const closable = useTabsStore(s => s.tabs.length > 1);
	// The active tab's live stream state sharpens the signal between status pushes.
	const activeStreaming = useSessionStore(s => (active ? s.isStreaming : false));
	const running = tab.status === "running" || tab.compacting === true || (active && activeStreaming);
	const signalActive = running || tab.status === "starting" || tab.status === "restarting";
	const signalLabel = running
		? t("titlebar.status.working")
		: tab.unreadDone
			? t("tabs.done")
			: tab.status === "ready"
				? t("titlebar.status.ready")
				: tab.status === "starting"
					? t("titlebar.status.connecting")
					: t(`titlebar.status.${tab.status}`);
	const signalColor = running
		? "var(--omp-accent)"
		: tab.unreadDone
			? "var(--omp-success)"
			: tab.status === "ready"
				? "var(--omp-dim)"
				: tab.status === "error" || tab.status === "exited"
					? "var(--omp-error)"
					: "var(--omp-warning)";
	// Closing kills the tab's sidecar: a live run (running, starting, or the
	// active tab's stream outrunning the pool's status pushes) dies with it,
	// so those route through the inline confirm. Idle tabs go straight to the
	// confirm handler (which detours worktree tabs to the cleanup prompt).
	const closeNeedsConfirm = running || tab.status === "starting";

	return (
		<div
			role="tab"
			aria-selected={active}
			tabIndex={0}
			onClick={() => void switchTab(tab.id)}
			onContextMenu={onContextMenu}
			onKeyDown={event => {
				// Only the tab itself: Enter on a nested close/confirm button must
				// activate that button, not switch tabs.
				if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
					event.preventDefault();
					void switchTab(tab.id);
				}
			}}
			title={`${label} — ${workspaceLabel}${tab.worktree ? ` — ${tab.worktree.branch}` : ""}`}
			className={cx(
				"no-drag group relative flex h-9 min-w-0 max-w-44 shrink-0 cursor-pointer items-center gap-2 overflow-hidden px-2.5 text-omp-md select-none",
				active
					? "bg-[var(--omp-selected-bg)] font-medium text-[var(--omp-text)]"
					: "text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]",
			)}
		>
			<span
				role="img"
				aria-label={signalLabel}
				title={signalLabel}
				className={cx("omp-signal-light omp-tab-signal", signalActive && "omp-signal-light--active")}
				style={{ color: signalColor }}
			/>
			{tab.worktree && (
				<GitBranch size={11} className="shrink-0 text-[var(--omp-accent)]" aria-label={t("tabs.kind.worktree")} />
			)}
			{tab.target?.type === "ssh" && (
				<Server size={11} className="shrink-0 text-[var(--omp-accent)]" aria-label={t("remote.title.ssh")} />
			)}
			{tab.kind === "chat" && (
				<MessageCircle size={11} className="shrink-0 text-[var(--omp-muted)]" aria-label={t("tabs.kind.chat")} />
			)}
			{confirmingClose ? (
				<span className="min-w-0 truncate text-[var(--omp-error)]" title={t("tabs.confirmClose")}>
					{t("tabs.confirmClose")}
				</span>
			) : (
				<span className="min-w-0 flex-1 leading-tight">
					<span className="block truncate" data-tab-title>
						{label}
					</span>
					<span className="block truncate text-omp-xxs font-normal text-[var(--omp-dim)]" data-tab-workspace>
						{workspaceLabel}
					</span>
				</span>
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
							// run); idle tabs skip the arm but STILL route through the
							// confirm handler — it detours worktree-bound tabs to the
							// cleanup prompt before closing (plan/20).
							if (closeNeedsConfirm) onArmClose();
							else onConfirmClose();
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
	const { sessions } = useSessionList("global");
	const tabs = useTabsStore(s => s.tabs);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const bundles = useTabsStore(s => s.bundles);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	const closeTab = useTabsStore(s => s.closeTab);
	const openTab = useTabsStore(s => s.openTab);
	const liveDraft = useComposerStore(s => s.draft);
	const liveImageCount = useComposerStore(s => s.images.length);
	const liveMessageCount = useSessionStore(s => s.messageCount);
	const liveStreaming = useSessionStore(s => s.isStreaming);
	const liveCompacting = useSessionStore(s => s.isCompacting);
	const liveRenderedMessages = useMessagesStore(s => s.messages.length);
	const liveQueuedMessages = useQueueStore(s => s.steering.length + s.followUp.length);
	const pruningPlaceholderRef = useRef<string | null>(null);
	const sessionsById = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);
	const sessionsByPath = useMemo(() => new Map(sessions.map(session => [session.path, session])), [sessions]);
	// Inline close confirm for live tabs (AgentHub abort parity): the first
	// click arms, the ✓ executes, ✕ or the timeout cancels. One arm at a time.
	const [confirmCloseId, setConfirmCloseId] = useState<string | null>(null);
	const [tabMenu, setTabMenu] = useState<{ anchor: ContextMenuAnchor; tabId: string } | null>(null);
	const confirmTimerRef = useRef<number | undefined>(undefined);

	useEffect(() => {
		return () => {
			window.clearTimeout(confirmTimerRef.current);
		};
	}, []);

	// The untargeted startup chat is an idle landing surface, not a permanent
	// tab. Replace it once an explicit tab exists, but only while it is truly
	// empty; a typed draft, queued input, message, or live run makes it real.
	// The first-chat fallback cleans up layouts saved before the placeholder bit
	// existed, after SessionIndex confirms that transcript has no content.
	useEffect(() => {
		if (tabs.length <= 1 || pruningPlaceholderRef.current) return;
		const candidate = tabs.find((tab, index) => {
			const indexedSession =
				(tab.sessionPath ? sessionsByPath.get(tab.sessionPath) : undefined) ??
				(tab.sessionId ? sessionsById.get(tab.sessionId) : undefined);
			const legacyEmptyStartupChat =
				index === 0 &&
				tab.placeholder === undefined &&
				tab.kind === "chat" &&
				indexedSession !== undefined &&
				!sessionHasContent(indexedSession);
			if (tab.placeholder !== true && !legacyEmptyStartupChat) return false;
			if (indexedSession && sessionHasContent(indexedSession)) return false;
			if (tab.worktree || tab.pendingSessionPath || tab.status === "running" || tab.compacting) return false;
			if (!tabs.some(other => other.id !== tab.id && other.placeholder !== true)) return false;

			if (tab.id === activeTabId) {
				return (
					!liveStreaming &&
					!liveCompacting &&
					liveMessageCount === 0 &&
					liveRenderedMessages === 0 &&
					liveQueuedMessages === 0 &&
					liveDraft.trim().length === 0 &&
					liveImageCount === 0
				);
			}

			const bundle = bundles.get(tab.id);
			if (!bundle) return true;
			return (
				!bundle.session.isStreaming &&
				!bundle.session.isCompacting &&
				bundle.session.messageCount === 0 &&
				bundle.messages.messages.length === 0 &&
				bundle.queue.steering.length === 0 &&
				bundle.queue.followUp.length === 0 &&
				bundle.composer.draft.trim().length === 0 &&
				bundle.composer.images.length === 0
			);
		});
		if (!candidate) return;
		pruningPlaceholderRef.current = candidate.id;
		void closeTab(candidate.id).finally(() => {
			pruningPlaceholderRef.current = null;
		});
	}, [
		activeTabId,
		bundles,
		closeTab,
		liveCompacting,
		liveDraft,
		liveImageCount,
		liveMessageCount,
		liveQueuedMessages,
		liveRenderedMessages,
		liveStreaming,
		sessionsById,
		sessionsByPath,
		tabs,
	]);

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
		// Worktree-bound tabs detour through the cleanup prompt (delete/keep)
		// before the tab actually closes (plan/20).
		const tab = tabs.find(entry => entry.id === id);
		if (tab?.worktree) {
			useUiStore.getState().openWorktreeClosePrompt(id);
			return;
		}
		void closeTab(id);
	};

	const closeTabs = async (ids: readonly string[]) => {
		for (const id of ids) {
			// Sequential close preserves the store's active-neighbor routing and
			// single-tab floor while the list shrinks.
			await closeTab(id);
		}
	};

	const closeAllTabs = async (target: SessionTab) => {
		await closeTabs(tabs.filter(tab => tab.id !== target.id).map(tab => tab.id));
		const replacement = await openTab({ cwd: target.cwd, kind: target.kind });
		if (replacement) await closeTab(target.id);
	};

	const protectedFromBatchClose = (tab: SessionTab) =>
		tab.worktree != null ||
		tab.status === "running" ||
		tab.status === "starting" ||
		tab.compacting === true ||
		(tab.id === activeTabId && (liveStreaming || liveCompacting));

	return (
		<>
			<div
				role="tablist"
				aria-label={t("tabs.strip")}
				className="drag-region flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--omp-border-muted)] bg-[var(--omp-titlebar-bg)] px-2"
			>
				{tabs.map(tab => {
					const indexedSession =
						(tab.sessionPath ? sessionsByPath.get(tab.sessionPath) : undefined) ??
						(tab.sessionId ? sessionsById.get(tab.sessionId) : undefined);
					const label = indexedSession
						? sessionDisplayTitle(indexedSession, t("sidebar.untitled"))
						: tabChipLabel(tab, tabs);
					// The subtitle shares the chip with the sanitized title, so a
					// remote cwd carrying control or bidi characters gets the same
					// bounded treatment rather than rendering raw.
					const workspaceLabel =
						tab.kind === "chat"
							? t("sidebar.chats")
							: sanitizeDisplayText(
									groupAliases[tab.cwd] ?? basename(tab.cwd) ?? tab.cwd,
									TAB_WORKSPACE_LABEL_LIMIT,
								);
					return (
						<TabChip
							key={tab.id}
							tab={tab}
							active={tab.id === activeTabId}
							label={label}
							workspaceLabel={workspaceLabel}
							confirmingClose={confirmCloseId === tab.id}
							onArmClose={() => armCloseConfirm(tab.id)}
							onConfirmClose={() => confirmClose(tab.id)}
							onCancelClose={cancelCloseConfirm}
							onContextMenu={event => setTabMenu({ anchor: anchorFromEvent(event), tabId: tab.id })}
						/>
					);
				})}
				<NewTabMenu />
			</div>
			{tabMenu &&
				(() => {
					const index = tabs.findIndex(tab => tab.id === tabMenu.tabId);
					const target = tabs[index];
					if (!target) return null;
					const left = tabs.slice(0, index);
					const right = tabs.slice(index + 1);
					const closeItems = (ids: readonly string[]) => {
						setTabMenu(null);
						void closeTabs(ids);
					};
					const blockedReason = t("tabs.menu.closeProtected");
					return (
						<ContextMenu
							x={tabMenu.anchor.x}
							y={tabMenu.anchor.y}
							onClose={() => setTabMenu(null)}
							items={[
								{
									id: "close-left",
									label: t("tabs.menu.closeLeft"),
									disabled: left.length === 0 || left.some(protectedFromBatchClose),
									disabledReason: left.some(protectedFromBatchClose) ? blockedReason : undefined,
									onSelect: () => closeItems(left.map(tab => tab.id)),
								},
								{
									id: "close-right",
									label: t("tabs.menu.closeRight"),
									disabled: right.length === 0 || right.some(protectedFromBatchClose),
									disabledReason: right.some(protectedFromBatchClose) ? blockedReason : undefined,
									onSelect: () => closeItems(right.map(tab => tab.id)),
								},
								{
									id: "close-all",
									label: t("tabs.menu.closeAll"),
									danger: true,
									disabled: tabs.some(protectedFromBatchClose),
									disabledReason: tabs.some(protectedFromBatchClose) ? blockedReason : undefined,
									onSelect: () => {
										setTabMenu(null);
										void closeAllTabs(target);
									},
								},
							]}
						/>
					);
				})()}
		</>
	);
}

/**
 * New-tab affordance: agent, tool-free chat, and worktree.
 */
function NewTabMenu() {
	const t = useT();
	const openTab = useTabsStore(s => s.openTab);
	const openWorktreeDialog = useUiStore(s => s.openWorktreeDialog);
	const buttonClass =
		"no-drag omp-pressable flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]";
	return (
		<>
			<button
				type="button"
				aria-label={t("tabs.new.agent")}
				title={t("tabs.new.agentHint")}
				onClick={() => void openTab()}
				className={buttonClass}
			>
				<Plus size={14} />
			</button>
			<button
				type="button"
				aria-label={t("tabs.new.chat")}
				title={t("tabs.new.chatHint")}
				onClick={() => void openTab({ kind: "chat" })}
				className={buttonClass}
			>
				<MessageCirclePlus size={14} />
			</button>
			<button
				type="button"
				aria-label={t("tabs.new.worktree")}
				title={t("tabs.new.worktreeHint")}
				onClick={() => openWorktreeDialog()}
				className={buttonClass}
			>
				<GitBranchPlus size={14} />
			</button>
		</>
	);
}
