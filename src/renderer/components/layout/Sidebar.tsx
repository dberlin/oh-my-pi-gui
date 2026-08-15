import {
	Check,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	GitBranchPlus,
	MessageCircle,
	MessageCirclePlus,
	MessageSquarePlus,
	MoreHorizontal,
	Palette,
	Pencil,
	Pin,
	PinOff,
	Plus,
	Search,
	SquareTerminal,
	Trash2,
	X,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../../../shared/ipc-types";
import { useAwaitingConfirmation } from "../../hooks/use-awaiting-confirmation";
import { useSessionList } from "../../hooks/use-session-list";
import { dropSessionNow } from "../../hooks/use-session-switch";
import { basename, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { mergeContentMatches, rankSessions } from "../../lib/session-search";
import { sessionDisplayTitle } from "../../lib/session-title";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { PiLogo } from "../common";
import { anchorFromEvent, ContextMenu, type ContextMenuAnchor } from "../common/ContextMenu";
import { LangSwitcher } from "../common/LangSwitcher";
import { WorkspaceDialog } from "../dialogs/WorkspaceDialog";

const STATUS_COLOR: Record<SessionInfo["status"], string> = {
	complete: "var(--omp-success)",
	interrupted: "var(--omp-warning)",
	aborted: "var(--omp-warning)",
	error: "var(--omp-error)",
	pending: "var(--omp-dim)",
	unknown: "var(--omp-dim)",
};

interface WorkspaceGroup {
	cwd: string;
	name: string;
	sessions: SessionInfo[];
}

function modifiedAt(session: SessionInfo): number {
	const timestamp = Date.parse(session.modified);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function SidebarRowTitle({ className, title }: { className?: string; title: string }) {
	return (
		<span className={cx("omp-sidebar-title min-w-0 flex-1 truncate", className)} title={title}>
			{title}
		</span>
	);
}

/**
 * Left rail: one-row search+new-session, Agent sessions grouped under their
 * workspaces, and a separate global Chat section. Chat sessions never appear
 * inside a workspace even though their files retain a cwd for runtime use.
 * Compact title-only items share the same task actions, followed by a bottom
 * utility row (theme + language — stats/settings live
 * in the TitleBar, no duplicated chrome).
 */
export function Sidebar() {
	const [query, setQuery] = useState("");
	const t = useT();
	const switchPendingTo = useUiStore(s => s.switchPending?.toId ?? null);
	// Resizable left rail (mirrors PanelContainer's right-rail drag, but the
	// handle sits on the right edge and dragging right grows the sidebar).
	const SIDEBAR_MIN = 180;
	const SIDEBAR_MAX = 420;
	const [sidebarWidth, setSidebarWidth] = useState(236);
	const sidebarDragging = useRef(false);
	const startSidebarDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		sidebarDragging.current = true;
		e.currentTarget.setPointerCapture(e.pointerId);
	}, []);
	const onSidebarDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		if (!sidebarDragging.current) return;
		// Sidebar is left-anchored: dragging right grows it.
		const host = e.currentTarget.parentElement;
		if (!host) return;
		const hostRect = host.getBoundingClientRect();
		setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX - hostRect.left)));
	}, []);
	const endSidebarDrag = useCallback(() => {
		sidebarDragging.current = false;
	}, []);
	const [contentPaths, setContentPaths] = useState<ReadonlySet<string>>(new Set());
	const searchGenerationRef = useRef(0);
	const [deleting, setDeleting] = useState(false);
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
	// Inline delete confirmation: the first click swaps the trash button for an
	// in-place ✓/✕ pair (confirm sits exactly where delete was); ✓ deletes,
	// ✕ or clicking elsewhere cancels. No modal, no mouse travel to center.
	const [confirmingDeletePath, setConfirmingDeletePath] = useState<string | null>(null);
	const [confirmingGroupDeleteCwd, setConfirmingGroupDeleteCwd] = useState<string | null>(null);
	const [renamingSessionPath, setRenamingSessionPath] = useState<string | null>(null);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [renameDraft, setRenameDraft] = useState("");
	// "+" type dropdown, workspace group context menu, session row context menu.
	const [plusMenu, setPlusMenu] = useState<ContextMenuAnchor | null>(null);
	const [groupMenu, setGroupMenu] = useState<{ anchor: ContextMenuAnchor; group: WorkspaceGroup } | null>(null);
	const [sessionMenu, setSessionMenu] = useState<{ anchor: ContextMenuAnchor; session: SessionInfo } | null>(null);
	// Workspace display alias rename (group header inline input).
	const [renamingGroupCwd, setRenamingGroupCwd] = useState<string | null>(null);
	const [groupRenameDraft, setGroupRenameDraft] = useState("");
	const groupRenameRef = useRef<HTMLInputElement>(null);
	const openTab = useTabsStore(s => s.openTab);
	const tabs = useTabsStore(s => s.tabs);
	const pinnedGroups = useSidebarPrefs(s => s.pinnedGroups);
	const pinnedSessions = useSidebarPrefs(s => s.pinnedSessions);
	const groupAliases = useSidebarPrefs(s => s.groupAliases);
	const workspaceLastUsed = useSidebarPrefs(s => s.workspaceLastUsed);
	const sessionLastUsed = useSidebarPrefs(s => s.sessionLastUsed);
	const touchSession = useSidebarPrefs(s => s.touchSession);
	const renameRef = useRef<HTMLInputElement>(null);
	const { sessions, isLoading, deleteSession, renameSession } = useSessionList("global");
	const sessionId = useSessionStore(s => s.sessionId);
	const cwd = useSessionStore(s => s.cwd);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isCompacting = useSessionStore(s => s.isCompacting);
	// Sidebar signal-light state for the ATTACHED session: a blocking
	// confirmation (plan approval / ask / permission) overrides the running
	// signal — it needs the user, not just time.
	const awaitingConfirmation = useAwaitingConfirmation();
	const openThemePicker = useUiStore(s => s.openThemePicker);

	// Debounced full-transcript content search (main-process grep over the
	// session files). Best-effort: failures simply yield no content matches.
	useEffect(() => {
		const q = query.trim();
		if (q.length < 2) {
			setContentPaths(new Set());
			return;
		}
		const generation = ++searchGenerationRef.current;
		const timer = setTimeout(() => {
			window.omp.sessions
				.search(q, "global")
				.then(paths => {
					if (searchGenerationRef.current === generation) setContentPaths(new Set(paths));
				})
				.catch(() => {});
		}, 200);
		return () => clearTimeout(timer);
	}, [query]);

	// Filter once, then split the navigation model by immutable session kind.
	// Agent sessions remain workspace-owned; chats are a global peer section.
	const filteredSessions = useMemo(
		() => mergeContentMatches(rankSessions(sessions, query), sessions, contentPaths),
		[sessions, query, contentPaths],
	);

	const browsingByRecency = query.trim().length === 0;
	const recencyForSession = useCallback(
		(session: SessionInfo) => sessionLastUsed[session.path] ?? modifiedAt(session),
		[sessionLastUsed],
	);

	// Group Agent sessions by workspace. Normal browsing is MRU; search keeps
	// relevance order. Pins remain a priority partition, with MRU inside it.
	const groups = useMemo<WorkspaceGroup[]>(() => {
		const byCwd = new Map<string, SessionInfo[]>();
		for (const session of filteredSessions) {
			if (session.kind === "chat") continue;
			const list = byCwd.get(session.cwd) ?? [];
			list.push(session);
			byCwd.set(session.cwd, list);
		}
		const result: WorkspaceGroup[] = [...byCwd.entries()].map(([groupCwd, groupSessions]) => ({
			cwd: groupCwd,
			name: groupAliases[groupCwd] ?? (basename(groupCwd) || groupCwd),
			sessions: [...groupSessions].sort((a, b) => {
				const aPinned = pinnedSessions.includes(a.path) ? 0 : 1;
				const bPinned = pinnedSessions.includes(b.path) ? 0 : 1;
				if (aPinned !== bPinned) return aPinned - bPinned;
				return browsingByRecency ? recencyForSession(b) - recencyForSession(a) : 0;
			}),
		}));
		result.sort((a, b) => {
			const aPinned = pinnedGroups.includes(a.cwd) ? 0 : 1;
			const bPinned = pinnedGroups.includes(b.cwd) ? 0 : 1;
			if (aPinned !== bPinned) return aPinned - bPinned;
			if (!browsingByRecency) return 0;
			const aRecency = Math.max(workspaceLastUsed[a.cwd] ?? 0, ...a.sessions.map(recencyForSession));
			const bRecency = Math.max(workspaceLastUsed[b.cwd] ?? 0, ...b.sessions.map(recencyForSession));
			return bRecency - aRecency;
		});
		return result;
	}, [
		browsingByRecency,
		filteredSessions,
		groupAliases,
		pinnedGroups,
		pinnedSessions,
		recencyForSession,
		workspaceLastUsed,
	]);

	const chatSessions = useMemo(
		() =>
			filteredSessions
				.filter(session => session.kind === "chat")
				.toSorted((a, b) => {
					const aPinned = pinnedSessions.includes(a.path) ? 0 : 1;
					const bPinned = pinnedSessions.includes(b.path) ? 0 : 1;
					if (aPinned !== bPinned) return aPinned - bPinned;
					return browsingByRecency ? recencyForSession(b) - recencyForSession(a) : 0;
				}),
		[browsingByRecency, filteredSessions, pinnedSessions, recencyForSession],
	);
	const agentCount = useMemo(() => groups.reduce((n, group) => n + group.sessions.length, 0), [groups]);
	const totalCount = agentCount + chatSessions.length;
	const chatsCollapsed = collapsed.__chats__ ?? false;

	const isCollapsed = (groupCwd: string) => {
		if (groupCwd in collapsed) return collapsed[groupCwd];
		// Default: current workspace expanded, others collapsed (Codex-style).
		return groupCwd !== cwd;
	};
	const toggleGroup = (groupCwd: string) => {
		setCollapsed(prev => ({ ...prev, [groupCwd]: !isCollapsed(groupCwd) }));
	};
	const isSessionRunning = (session: SessionInfo) => {
		if (session.id === sessionId && (isStreaming || isCompacting)) return true;
		const ownerTab = tabs.find(tab => tab.sessionId === session.id);
		if (ownerTab) return ownerTab.status === "running" || ownerTab.compacting === true;
		return session.status === "pending";
	};

	const openSession = (session: SessionInfo) => {
		if (session.id === sessionId) return;
		void openTab({ cwd: session.cwd, sessionPath: session.path, kind: session.kind ?? "agent" });
	};

	// Explicit parallel action: open this session in a NEW window with its own
	// sidecar, leaving the current window's running session untouched.
	const openSessionInNewWindow = async (session: SessionInfo) => {
		const ok = await window.omp.sessions.openInNewWindow({ sessionPath: session.path, cwd: session.cwd });
		if (!ok) {
			toast({ variant: "warning", message: t("sidebar.parallelCap") });
			return;
		}
		touchSession(session.path, session.kind === "chat" ? undefined : session.cwd);
	};

	const startRename = (session: SessionInfo) => {
		setRenameDraft(session.title || session.firstMessage || "");
		setRenamingSessionPath(session.path);
		requestAnimationFrame(() => renameRef.current?.select());
	};
	const commitRename = (session: SessionInfo, value = renameDraft) => {
		setRenamingSessionPath(null);
		const name = value.trim();
		if (!name || name === session.title) return;
		void renameSession(session.path, name)
			.then(() => {
				if (session.id === sessionId) useSessionStore.setState({ sessionName: name });
			})
			.catch(error => toast({ variant: "error", title: t("sidebar.renameFailed"), message: String(error) }));
	};

	const confirmDeleteSession = async (session: SessionInfo) => {
		if (isSessionRunning(session)) {
			toast({ variant: "warning", message: t("sidebar.menu.taskRunning") });
			setConfirmingDeletePath(null);
			return;
		}
		setDeleting(true);
		try {
			if (session.id === sessionId) {
				await dropSessionNow();
			} else {
				await deleteSession(session.path);
			}
			setConfirmingDeletePath(null);
		} catch (error) {
			toast({ variant: "error", title: t("sidebar.deleteFailed"), message: String(error) });
		} finally {
			setDeleting(false);
		}
	};

	const confirmDeleteGroup = async (group: WorkspaceGroup) => {
		if (group.sessions.some(isSessionRunning)) {
			toast({ variant: "warning", message: t("sidebar.deleteGroupStreaming") });
			setConfirmingGroupDeleteCwd(null);
			return;
		}
		setDeleting(true);
		try {
			// Delete every session file in this workspace, then dismiss the group.
			for (const session of group.sessions) {
				// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
				if (session.id === sessionId) await dropSessionNow();
				else await deleteSession(session.path);
			}
			setConfirmingGroupDeleteCwd(null);
		} catch (error) {
			toast({ variant: "error", title: t("sidebar.deleteFailed"), message: String(error) });
		} finally {
			setDeleting(false);
		}
	};

	const renderSessionRow = (session: SessionInfo) => {
		const active = session.id === sessionId;
		// Signal light: every open task uses its owning tab's live status.
		// Waiting-for-confirmation wins for the attached task.
		const signal: "waiting" | "running" | null = active
			? awaitingConfirmation
				? "waiting"
				: isStreaming
					? "running"
					: null
			: isSessionRunning(session)
				? "running"
				: null;
		const title = sessionDisplayTitle(session, t("sidebar.untitled"));
		const hasActions = signal == null || !active;
		const actionsOpen = confirmingDeletePath === session.path || renamingSessionPath === session.path;
		return (
			<div
				key={session.path}
				role="button"
				tabIndex={0}
				onClick={() => void openSession(session)}
				onContextMenu={event => setSessionMenu({ anchor: anchorFromEvent(event), session })}
				onKeyDown={event => {
					if (event.key === "Enter") void openSession(session);
				}}
				data-active={active}
				data-switch-pending={switchPendingTo === session.id || undefined}
				data-has-actions={hasActions}
				data-actions-open={actionsOpen}
				data-session-kind={session.kind ?? "agent"}
				className={cx(
					"omp-sidebar-session-row omp-color-fade group cursor-pointer rounded-md border px-2 py-1",
					active
						? "border-[var(--omp-border-accent)] bg-[var(--omp-selected-bg)]"
						: "border-transparent hover:border-[var(--omp-border-muted)] hover:bg-[var(--omp-sidebar-item-hover)]",
				)}
			>
				<div className="flex min-w-0 items-center">
					<span
						title={
							signal === "waiting"
								? t("sidebar.signal.waiting")
								: signal === "running"
									? t("sidebar.signal.running")
									: session.status
						}
						className={cx("mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full", signal === "waiting" && "omp-pulse-dot")}
						style={{
							background:
								signal === "waiting"
									? "var(--omp-warning)"
									: signal === "running"
										? "var(--omp-success)"
										: STATUS_COLOR[session.status],
						}}
					/>
					{pinnedSessions.includes(session.path) && (
						<Pin
							size={10}
							className="mr-1.5 shrink-0 text-[var(--omp-accent)]"
							aria-label={t("sidebar.pinned")}
						/>
					)}
					{renamingSessionPath === session.path ? (
						<input
							ref={renameRef}
							value={renameDraft}
							onChange={event => setRenameDraft(event.target.value)}
							onBlur={event => commitRename(session, event.currentTarget.value)}
							onKeyDown={event => {
								if (event.key === "Enter") commitRename(session, event.currentTarget.value);
								if (event.key === "Escape") setRenamingSessionPath(null);
							}}
							onClick={event => event.stopPropagation()}
							className="min-w-0 flex-1 rounded border border-[var(--omp-input-focus-border)] bg-[var(--omp-input-bg)] px-1.5 py-0.5 text-omp-md font-normal text-[var(--omp-muted)] outline-none"
						/>
					) : (
						<SidebarRowTitle
							className="text-omp-md font-normal leading-5 text-[var(--omp-muted)]"
							title={title}
						/>
					)}
					<span
						className="omp-sidebar-session-actions flex shrink-0 items-center justify-end gap-0.5"
						onClick={event => event.stopPropagation()}
					>
						{confirmingDeletePath === session.path ? (
							<>
								<button
									type="button"
									disabled={deleting}
									title={t("common.delete")}
									aria-label={t("common.delete")}
									onClick={() => void confirmDeleteSession(session)}
									className="flex h-5 w-5 items-center justify-center rounded bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)] hover:brightness-110 disabled:opacity-40"
								>
									<Check size={11} strokeWidth={3} />
								</button>
								<button
									type="button"
									disabled={deleting}
									title={t("common.cancel")}
									aria-label={t("common.cancel")}
									onClick={() => setConfirmingDeletePath(null)}
									className="flex h-5 w-5 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)] disabled:opacity-40"
								>
									<X size={11} strokeWidth={3} />
								</button>
							</>
						) : (
							<>
								{!signal && renamingSessionPath !== session.path ? (
									<button
										type="button"
										title={t("sidebar.rename")}
										aria-label={t("sidebar.rename")}
										onClick={() => startRename(session)}
										className="omp-sidebar-action order-2 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
									>
										<Pencil size={11} />
									</button>
								) : !active ? (
									<button
										type="button"
										title={t("sidebar.menu.openNewTab")}
										aria-label={t("sidebar.menu.openNewTab")}
										onClick={() => void openSession(session)}
										className="omp-sidebar-action flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
									>
										<Plus size={11} />
									</button>
								) : (
									<span className="h-5 w-5 shrink-0" />
								)}
								{!signal ? (
									<button
										className="omp-sidebar-action flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-tool-error-bg)] hover:text-[var(--omp-error)]"
										onClick={() => setConfirmingDeletePath(session.path)}
										title={t("sidebar.delete")}
										type="button"
										aria-label={t("sidebar.delete")}
									>
										<Trash2 size={11} />
									</button>
								) : (
									<span className="order-1 h-5 w-5 shrink-0" />
								)}
							</>
						)}
					</span>
				</div>
			</div>
		);
	};

	const utilityButton =
		"omp-pressable flex h-6 w-7 shrink-0 items-center justify-center rounded-md text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]";

	return (
		<>
			<aside
				className="omp-session-sidebar relative flex h-full shrink-0 flex-col border-r border-[var(--omp-border-muted)] bg-[var(--omp-sidebar-bg)]"
				style={{ width: sidebarWidth }}
			>
				<div className="drag-region flex h-12 shrink-0 items-center gap-2 border-b border-[var(--omp-border-muted)] px-3">
					<PiLogo tile size={24} />
					<div className="font-display text-omp-lg font-semibold tracking-[-0.01em] text-[var(--omp-text)]">
						oh-my-pi
					</div>
				</div>

				{/* One row: search + new-session "+" button */}
				<div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
					<div className="relative min-w-0 flex-1">
						<Search
							size={13}
							className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--omp-dim)]"
						/>
						<input
							value={query}
							onChange={event => setQuery(event.target.value)}
							placeholder={t("sidebar.search")}
							className="h-8 w-full rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-input-bg)] pl-8 pr-2 text-omp-md text-[var(--omp-text)] outline-none transition-colors placeholder:text-[var(--omp-dim)] focus:border-[var(--omp-input-focus-border)]"
						/>
					</div>
					<button
						type="button"
						onClick={event => {
							const rect = event.currentTarget.getBoundingClientRect();
							setPlusMenu({ x: rect.left, y: rect.bottom + 6 });
						}}
						title={t("sidebar.newSession")}
						aria-label={t("sidebar.newSession")}
						aria-expanded={plusMenu !== null}
						aria-haspopup="menu"
						className="omp-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--omp-btn-primary-bg)] text-[var(--omp-btn-primary-text)] shadow-[var(--omp-shadow-sm)] hover:brightness-110"
					>
						<Plus size={16} strokeWidth={2.5} />
					</button>
				</div>

				<div className="flex items-center justify-between px-4 pb-1.5">
					<span className="text-omp-xs font-semibold uppercase tracking-[0.12em] text-[var(--omp-dim)]">
						{t("sidebar.recent")}
					</span>
					{totalCount > 0 && (
						<span
							className="rounded-full bg-[var(--omp-bg-tertiary)] px-2 py-0.5 text-omp-xs tabular-nums text-[var(--omp-dim)]" // surface-ok: count pill
						>
							{totalCount}
						</span>
					)}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2 [overflow-anchor:none]">
					{isLoading && sessions.length === 0 && (
						<div className="px-3 py-6 text-center text-omp-lg text-[var(--omp-dim)]">{t("sidebar.loading")}</div>
					)}
					{!isLoading && totalCount === 0 && (
						<div className="mx-1 mt-2 flex flex-col items-center rounded-xl border border-dashed border-[var(--omp-border-muted)] px-4 py-6 text-center">
							<MessageSquarePlus size={20} className="mb-2 text-[var(--omp-muted)]" />
							<div className="text-omp-lg font-medium text-[var(--omp-muted)]">
								{query ? t("sidebar.noMatch") : t("sidebar.empty")}
							</div>
						</div>
					)}
					{chatSessions.length > 0 && (
						<div className="mb-1" data-chat-section>
							<div className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-omp-xs font-medium uppercase tracking-[0.08em] text-[var(--omp-dim)]">
								<button
									type="button"
									onClick={() => setCollapsed(prev => ({ ...prev, __chats__: !chatsCollapsed }))}
									aria-expanded={!chatsCollapsed}
									className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-[var(--omp-muted)]"
								>
									{chatsCollapsed ? (
										<ChevronRight size={12} className="shrink-0" />
									) : (
										<ChevronDown size={12} className="shrink-0" />
									)}
									<MessageCircle size={11} className="shrink-0" />
									<span className="min-w-0 flex-1 truncate">{t("sidebar.chats")}</span>
									<span className="shrink-0 tabular-nums font-normal">{chatSessions.length}</span>
								</button>
								<button
									type="button"
									title={t("sidebar.menu.newChat")}
									aria-label={t("sidebar.menu.newChat")}
									className="omp-sidebar-action flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
									onClick={() => void openTab({ kind: "chat" })}
								>
									<Plus size={12} strokeWidth={2.5} />
								</button>
							</div>
							<div
								className="omp-sidebar-group"
								data-session-group="__chats__"
								data-state={chatsCollapsed ? "collapsed" : "expanded"}
								aria-hidden={chatsCollapsed}
								inert={chatsCollapsed}
							>
								<div className="omp-sidebar-group-content">
									<div className="space-y-px">{chatSessions.map(renderSessionRow)}</div>
								</div>
							</div>
						</div>
					)}
					{groups.map(group => {
						const groupCollapsed = isCollapsed(group.cwd);
						const isCurrent = group.cwd === cwd;
						const groupActionsOpen = confirmingGroupDeleteCwd === group.cwd || renamingGroupCwd === group.cwd;
						return (
							<div key={group.cwd} className="mb-0.5">
								<div
									data-workspace-group={group.cwd}
									data-actions-open={groupActionsOpen}
									onContextMenu={event => setGroupMenu({ anchor: anchorFromEvent(event), group })}
									className={cx(
										"omp-sidebar-workspace-row omp-color-fade group flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 pr-8 text-left text-omp-xs font-medium uppercase tracking-[0.08em]",
										isCurrent
											? "text-[var(--omp-muted)]"
											: "text-[var(--omp-dim)] hover:text-[var(--omp-muted)]",
									)}
								>
									{renamingGroupCwd === group.cwd ? (
										<>
											<button
												type="button"
												onClick={() => toggleGroup(group.cwd)}
												aria-expanded={!groupCollapsed}
												aria-label={group.name}
												className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-[var(--omp-bg-tertiary)]"
											>
												{groupCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
											</button>
											{pinnedGroups.includes(group.cwd) && (
												<Pin
													size={10}
													className="shrink-0 text-[var(--omp-accent)]"
													aria-label={t("sidebar.pinned")}
												/>
											)}
											<input
												ref={groupRenameRef}
												value={groupRenameDraft}
												onChange={event => setGroupRenameDraft(event.target.value)}
												onBlur={() => {
													useSidebarPrefs.getState().setGroupAlias(group.cwd, groupRenameDraft);
													setRenamingGroupCwd(null);
												}}
												onKeyDown={event => {
													if (event.key === "Enter") {
														useSidebarPrefs.getState().setGroupAlias(group.cwd, groupRenameDraft);
														setRenamingGroupCwd(null);
													}
													if (event.key === "Escape") setRenamingGroupCwd(null);
												}}
												className="min-w-0 flex-1 rounded border border-[var(--omp-input-focus-border)] bg-[var(--omp-input-bg)] px-1 py-0 text-omp-xs font-medium uppercase tracking-[0.08em] text-[var(--omp-text)] outline-none"
											/>
											<span className="shrink-0 tabular-nums text-omp-xs font-normal text-[var(--omp-dim)]">
												{group.sessions.length}
											</span>
										</>
									) : (
										<button
											type="button"
											onClick={() => toggleGroup(group.cwd)}
											aria-expanded={!groupCollapsed}
											className="flex min-w-0 flex-1 items-center gap-1 text-left"
										>
											{groupCollapsed ? (
												<ChevronRight size={12} className="shrink-0" />
											) : (
												<ChevronDown size={12} className="shrink-0" />
											)}
											{pinnedGroups.includes(group.cwd) && (
												<Pin
													size={10}
													className="shrink-0 text-[var(--omp-accent)]"
													aria-label={t("sidebar.pinned")}
												/>
											)}
											<SidebarRowTitle className="text-left" title={group.name} />
											<span className="shrink-0 tabular-nums text-omp-xs font-normal text-[var(--omp-dim)]">
												{group.sessions.length}
											</span>
										</button>
									)}
									<span
										className="omp-sidebar-workspace-actions flex shrink-0 items-center justify-end gap-0.5"
										onClick={event => event.stopPropagation()}
									>
										{confirmingGroupDeleteCwd === group.cwd ? (
											<>
												<button
													type="button"
													disabled={deleting}
													title={t("common.delete")}
													aria-label={t("common.delete")}
													onClick={() => void confirmDeleteGroup(group)}
													className="flex h-4 w-4 items-center justify-center rounded bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)] hover:brightness-110 disabled:opacity-40"
												>
													<Check size={10} strokeWidth={3} />
												</button>
												<button
													type="button"
													disabled={deleting}
													title={t("common.cancel")}
													aria-label={t("common.cancel")}
													onClick={() => setConfirmingGroupDeleteCwd(null)}
													className="flex h-4 w-4 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)] disabled:opacity-40"
												>
													<X size={10} strokeWidth={3} />
												</button>
											</>
										) : (
											<>
												<button
													type="button"
													title={t("sidebar.menu.newAgentHere")}
													aria-label={t("sidebar.menu.newAgentHere")}
													className="omp-sidebar-action flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
													onClick={event => {
														event.stopPropagation();
														void openTab({ cwd: group.cwd });
													}}
												>
													<Plus size={12} strokeWidth={2.5} />
												</button>
												<button
													type="button"
													title={t("sidebar.groupMenu")}
													aria-label={t("sidebar.groupMenu")}
													className="omp-sidebar-action flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
													onClick={event => {
														event.stopPropagation();
														const rect = event.currentTarget.getBoundingClientRect();
														setGroupMenu({ anchor: { x: rect.left, y: rect.bottom + 4 }, group });
													}}
												>
													<MoreHorizontal size={11} />
												</button>
											</>
										)}
									</span>
								</div>
								{/* Keep the content mounted for a smooth exit, but inert while collapsed. */}
								<div
									className="omp-sidebar-group"
									data-session-group={group.cwd}
									data-state={groupCollapsed ? "collapsed" : "expanded"}
									aria-hidden={groupCollapsed}
									inert={groupCollapsed}
								>
									<div className="omp-sidebar-group-content">
										<div className="space-y-px">{group.sessions.map(renderSessionRow)}</div>
									</div>
								</div>
							</div>
						);
					})}
				</div>

				{/* Bottom utility row: theme + language only — stats/settings live in the
				    TitleBar, and the files button was a subset of the drawer toggle. */}
				<div className="flex h-7 shrink-0 items-center gap-0.5 border-t border-[var(--omp-border-muted)] px-2">
					<button
						type="button"
						onClick={openThemePicker}
						title={t("themePicker.aria")}
						aria-label={t("themePicker.aria")}
						className={utilityButton}
					>
						<Palette size={13} />
					</button>
					<LangSwitcher className="h-6 max-h-6 rounded-md px-1.5 text-omp-sm [&_svg]:size-[14px]" />
					<div className="flex-1" />
				</div>
				<div
					role="separator"
					aria-orientation="vertical"
					onPointerDown={startSidebarDrag}
					onPointerMove={onSidebarDrag}
					onPointerUp={endSidebarDrag}
					className="absolute inset-y-0 right-0 z-10 w-1 translate-x-1/2 cursor-col-resize transition-colors hover:bg-[var(--omp-accent)]/40 active:bg-[var(--omp-accent)] max-[1000px]:hidden"
				/>
			</aside>
			<WorkspaceDialog open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} intent="new-session" />

			{/* "+" type dropdown: Agent (workspace chooser flow) or Chat (direct tab). */}
			{plusMenu && (
				<ContextMenu
					x={plusMenu.x}
					y={plusMenu.y}
					onClose={() => setPlusMenu(null)}
					items={[
						{
							id: "new-agent",
							label: t("sidebar.menu.newAgent"),
							icon: SquareTerminal,
							hint: "⌘T",
							onSelect: () => {
								setPlusMenu(null);
								setWorkspaceOpen(true);
							},
						},
						{
							id: "new-chat",
							label: t("sidebar.menu.newChat"),
							icon: MessageCirclePlus,
							hint: "⇧⌘T",
							onSelect: () => {
								setPlusMenu(null);
								void openTab({ kind: "chat" });
							},
						},
					]}
				/>
			)}

			{/* Workspace group menu: new sessions, rename (alias), pin, delete. */}
			{groupMenu &&
				(() => {
					const groupHasRunningSession = groupMenu.group.sessions.some(isSessionRunning);
					return (
						<ContextMenu
							x={groupMenu.anchor.x}
							y={groupMenu.anchor.y}
							onClose={() => setGroupMenu(null)}
							items={[
								{
									id: "group-new-agent",
									label: t("sidebar.menu.newAgentHere"),
									icon: SquareTerminal,
									onSelect: () => {
										setGroupMenu(null);
										void openTab({ cwd: groupMenu.group.cwd });
									},
								},
								{
									id: "group-new-worktree",
									label: t("sidebar.menu.newWorktreeHere"),
									icon: GitBranchPlus,
									onSelect: () => {
										setGroupMenu(null);
										useUiStore.getState().openWorktreeDialog({ baseCwd: groupMenu.group.cwd });
									},
								},
								{
									id: "group-rename",
									label: t("sidebar.menu.rename"),
									icon: Pencil,
									onSelect: () => {
										setGroupRenameDraft(groupMenu.group.name);
										setRenamingGroupCwd(groupMenu.group.cwd);
										setGroupMenu(null);
										requestAnimationFrame(() => groupRenameRef.current?.select());
									},
								},
								{
									id: "group-pin",
									label: pinnedGroups.includes(groupMenu.group.cwd)
										? t("sidebar.menu.unpin")
										: t("sidebar.menu.pin"),
									icon: pinnedGroups.includes(groupMenu.group.cwd) ? PinOff : Pin,
									onSelect: () => {
										useSidebarPrefs.getState().toggleGroupPin(groupMenu.group.cwd);
										setGroupMenu(null);
									},
								},
								{
									id: "group-delete",
									label: t("common.delete"),
									icon: Trash2,
									danger: true,
									disabled: groupHasRunningSession,
									disabledReason: t("sidebar.deleteGroupStreaming"),
									onSelect: () => {
										setConfirmingGroupDeleteCwd(groupMenu.group.cwd);
										setGroupMenu(null);
									},
								},
							]}
						/>
					);
				})()}

			{/* Session row menu: open variants, per-task rename, pin, and delete. */}
			{sessionMenu &&
				(() => {
					const targetRunning = isSessionRunning(sessionMenu.session);
					return (
						<ContextMenu
							x={sessionMenu.anchor.x}
							y={sessionMenu.anchor.y}
							onClose={() => setSessionMenu(null)}
							items={[
								{
									id: "session-open",
									label: t("sidebar.menu.open"),
									icon: ChevronRight,
									onSelect: () => {
										setSessionMenu(null);
										void openSession(sessionMenu.session);
									},
								},
								{
									id: "session-open-tab",
									label: t("sidebar.menu.openNewTab"),
									icon: Plus,
									onSelect: () => {
										setSessionMenu(null);
										void openTab({
											cwd: sessionMenu.session.cwd,
											kind: sessionMenu.session.kind ?? "agent",
											sessionPath: sessionMenu.session.path,
										});
									},
								},
								{
									id: "session-open-window",
									label: t("sidebar.openInNewWindow"),
									icon: ExternalLink,
									onSelect: () => {
										setSessionMenu(null);
										void openSessionInNewWindow(sessionMenu.session);
									},
								},
								{
									id: "session-rename",
									label: t("sidebar.rename"),
									icon: Pencil,
									disabled: targetRunning,
									disabledReason: t("sidebar.menu.taskRunning"),
									onSelect: () => {
										setSessionMenu(null);
										startRename(sessionMenu.session);
									},
								},
								{
									id: "session-pin",
									label: pinnedSessions.includes(sessionMenu.session.path)
										? t("sidebar.menu.unpin")
										: t("sidebar.menu.pin"),
									icon: pinnedSessions.includes(sessionMenu.session.path) ? PinOff : Pin,
									onSelect: () => {
										useSidebarPrefs.getState().toggleSessionPin(sessionMenu.session.path);
										setSessionMenu(null);
									},
								},
								{
									id: "session-delete",
									label: t("common.delete"),
									icon: Trash2,
									danger: true,
									disabled: targetRunning,
									disabledReason: t("sidebar.menu.taskRunning"),
									onSelect: () => {
										setConfirmingDeletePath(sessionMenu.session.path);
										setSessionMenu(null);
									},
								},
							]}
						/>
					);
				})()}
		</>
	);
}
