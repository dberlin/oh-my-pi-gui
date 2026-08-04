import {
	BarChart3,
	Check,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	FolderTree,
	MessageSquarePlus,
	Palette,
	Pencil,
	Plus,
	Search,
	Settings,
	Trash2,
	X,
} from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../../../shared/ipc-types";
import { useAwaitingConfirmation } from "../../hooks/use-awaiting-confirmation";
import { hydrateSession } from "../../hooks/use-rpc-events";
import { useSessionList } from "../../hooks/use-session-list";
import { basename, cx, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { mergeContentMatches, rankSessions } from "../../lib/session-search";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { PiLogo } from "../common";
import { LangSwitcher } from "../common/LangSwitcher";
import { WorkspaceDialog } from "../dialogs/WorkspaceDialog";

export interface SidebarProps {
	onToggleStats: () => void;
}

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

/**
 * Left rail: one-row search+new-session, workspace-grouped collapsible session
 * list (Codex-style — grouped by cwd, current workspace first, others
 * collapsible), compact title-only items with inline rename for the active
 * session, and a bottom utility row (files/stats/theme/language/settings).
 */
export function Sidebar({ onToggleStats }: SidebarProps) {
	const [query, setQuery] = useState("");
	const t = useT();
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
	const [renaming, setRenaming] = useState(false);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [renameDraft, setRenameDraft] = useState("");
	const renameRef = useRef<HTMLInputElement>(null);
	const { sessions, isLoading, deleteSession } = useSessionList("global");
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	const cwd = useSessionStore(s => s.cwd);
	const isStreaming = useSessionStore(s => s.isStreaming);
	// Sidebar signal-light state for the ATTACHED session: a blocking
	// confirmation (plan approval / ask / permission) overrides the running
	// signal — it needs the user, not just time.
	const awaitingConfirmation = useAwaitingConfirmation();
	const openSettings = useUiStore(s => s.openSettings);
	const openThemePicker = useUiStore(s => s.openThemePicker);
	const setPanelTab = useUiStore(s => s.setPanelTab);

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

	// Group sessions by workspace (cwd), most-recently-modified workspace first.
	// Filtering ranks fuzzy/literal metadata matches first (TUI session-selector
	// parity), then full-transcript content hits.
	const groups = useMemo<WorkspaceGroup[]>(() => {
		const filtered = mergeContentMatches(rankSessions(sessions, query), sessions, contentPaths);
		const byCwd = new Map<string, SessionInfo[]>();
		for (const session of filtered) {
			const list = byCwd.get(session.cwd) ?? [];
			list.push(session);
			byCwd.set(session.cwd, list);
		}
		const result: WorkspaceGroup[] = [...byCwd.entries()].map(([groupCwd, groupSessions]) => ({
			cwd: groupCwd,
			name: basename(groupCwd) || groupCwd,
			sessions: groupSessions,
		}));
		result.sort(
			(a, b) =>
				Date.parse(b.sessions[0]?.modified ?? (0 as unknown as string)) -
				Date.parse(a.sessions[0]?.modified ?? (0 as unknown as string)),
		);
		return result;
	}, [sessions, query, contentPaths]);

	const totalCount = useMemo(() => groups.reduce((n, g) => n + g.sessions.length, 0), [groups]);

	const isCollapsed = (groupCwd: string) => {
		if (groupCwd in collapsed) return collapsed[groupCwd];
		// Default: current workspace expanded, others collapsed (Codex-style).
		return groupCwd !== cwd;
	};
	const toggleGroup = (groupCwd: string) => {
		setCollapsed(prev => ({ ...prev, [groupCwd]: !isCollapsed(groupCwd) }));
	};

	const openSession = async (session: SessionInfo) => {
		// No isStreaming guard: the server aborts the in-flight turn on switch
		// (`switchSession` → `abort({goalReason:"internal"})`), matching the TUI,
		// which never blocks switching mid-run. Locking here only hid that the
		// switch is allowed — it is not a parallel session, it replaces the
		// current one after aborting it.
		if (session.id === sessionId) return;
		try {
			const response = await window.omp.rpc.switchSession(session.path);
			if (!response.success) {
				toast({ variant: "error", title: t("sidebar.openFailed"), message: response.error });
				return;
			}
			// Hook veto: success:true with cancelled:true — stay on the current session.
			const data = response.data as { cancelled?: boolean } | undefined;
			if (data?.cancelled) {
				toast({ variant: "info", message: t("sidebar.openCancelled") });
				return;
			}
			await hydrateSession(session.title ?? session.firstMessage);
		} catch (error) {
			toast({ variant: "error", title: t("sidebar.openFailed"), message: String(error) });
		}
	};

	// Explicit parallel action: open this session in a NEW window with its own
	// sidecar, leaving the current window's running session untouched.
	const openSessionInNewWindow = async (session: SessionInfo) => {
		const ok = await window.omp.sessions.openInNewWindow({ sessionPath: session.path, cwd: session.cwd });
		if (!ok) {
			toast({ variant: "warning", message: t("sidebar.parallelCap") });
		}
	};

	const startRename = () => {
		setRenameDraft(sessionName ?? "");
		setRenaming(true);
		requestAnimationFrame(() => renameRef.current?.select());
	};
	const commitRename = () => {
		setRenaming(false);
		const name = renameDraft.trim();
		if (!name || name === sessionName) return;
		void window.omp.rpc
			.setSessionName(name)
			.then(response => {
				if (response.success) useSessionStore.setState({ sessionName: name });
				else toast({ variant: "error", title: t("sidebar.renameFailed"), message: response.error });
			})
			.catch(error => toast({ variant: "error", title: t("sidebar.renameFailed"), message: String(error) }));
	};

	const confirmDeleteSession = async (session: SessionInfo) => {
		setDeleting(true);
		try {
			await deleteSession(session.path);
			setConfirmingDeletePath(null);
		} finally {
			setDeleting(false);
		}
	};

	const confirmDeleteGroup = async (group: WorkspaceGroup) => {
		// Refuse to delete the workspace that owns the active session (or any
		// workspace mid-turn): its session file is still live on disk.
		if (group.sessions.some(session => session.id === sessionId)) {
			toast({ variant: "warning", message: t("sidebar.deleteGroupActive") });
			setConfirmingGroupDeleteCwd(null);
			return;
		}
		if (isStreaming) {
			toast({ variant: "warning", message: t("sidebar.deleteGroupStreaming") });
			setConfirmingGroupDeleteCwd(null);
			return;
		}
		setDeleting(true);
		try {
			// Delete every session file in this workspace, then dismiss the group.
			for (const session of group.sessions) {
				// eslint-disable-next-line no-await-in-loop -- sequential, keep FS load bounded
				await deleteSession(session.path);
			}
			setConfirmingGroupDeleteCwd(null);
		} finally {
			setDeleting(false);
		}
	};

	const utilityButton =
		"omp-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]";

	return (
		<>
			<aside
				className="omp-session-sidebar relative flex h-full shrink-0 flex-col border-r border-[var(--omp-border-muted)] bg-[var(--omp-sidebar-bg)]"
				style={{ width: sidebarWidth }}
			>
				<div className="drag-region flex h-12 shrink-0 items-center gap-2 border-b border-[var(--omp-border-muted)] px-3">
					<PiLogo tile size={24} />
					<div className="font-display text-[14px] font-semibold tracking-[-0.01em] text-[var(--omp-text)]">
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
							className="h-8 w-full rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-input-bg)] pl-8 pr-2 text-[12.5px] text-[var(--omp-text)] outline-none transition-colors placeholder:text-[var(--omp-dim)] focus:border-[var(--omp-input-focus-border)]"
						/>
					</div>
					<button
						type="button"
						onClick={() => setWorkspaceOpen(true)}
						title={t("sidebar.newSession")}
						aria-label={t("sidebar.newSession")}
						className="omp-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--omp-btn-primary-bg)] text-[var(--omp-btn-primary-text)] shadow-[var(--omp-shadow-sm)] hover:brightness-110"
					>
						<Plus size={16} strokeWidth={2.5} />
					</button>
				</div>

				<div className="flex items-center justify-between px-4 pb-1.5">
					<span className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--omp-dim)]">
						{t("sidebar.recent")}
					</span>
					{totalCount > 0 && (
						<span className="rounded-full bg-[var(--omp-bg-tertiary)] px-2 py-0.5 text-[10px] tabular-nums text-[var(--omp-dim)]">
							{totalCount}
						</span>
					)}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
					{isLoading && (
						<div className="px-3 py-6 text-center text-[13px] text-[var(--omp-dim)]">{t("sidebar.loading")}</div>
					)}
					{!isLoading && totalCount === 0 && (
						<div className="mx-1 mt-2 flex flex-col items-center rounded-xl border border-dashed border-[var(--omp-border-muted)] px-4 py-6 text-center">
							<MessageSquarePlus size={20} className="mb-2 text-[var(--omp-muted)]" />
							<div className="text-[13px] font-medium text-[var(--omp-muted)]">
								{query ? t("sidebar.noMatch") : t("sidebar.empty")}
							</div>
						</div>
					)}
					{groups.map(group => {
						const groupCollapsed = isCollapsed(group.cwd);
						const isCurrent = group.cwd === cwd;
						// Deleting a workspace deletes its session files — refuse while the
						// group owns the active session (same guard as single-session delete).
						const groupHasActive = group.sessions.some(session => session.id === sessionId);
						const groupDeleteBlocked = groupHasActive || isStreaming;
						const groupDeleteTitle = groupHasActive
							? t("sidebar.deleteGroupActive")
							: isStreaming
								? t("sidebar.deleteGroupStreaming")
								: t("sidebar.deleteGroup", { count: group.sessions.length });
						return (
							<div key={group.cwd} className="mb-1">
								<button
									type="button"
									onClick={() => toggleGroup(group.cwd)}
									className={cx(
										"omp-pressable group flex w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-[10px] font-medium uppercase tracking-[0.08em]",
										isCurrent
											? "text-[var(--omp-muted)]"
											: "text-[var(--omp-dim)] hover:text-[var(--omp-muted)]",
									)}
								>
									{groupCollapsed ? (
										<ChevronRight size={12} className="shrink-0" />
									) : (
										<ChevronDown size={12} className="shrink-0" />
									)}
									<span className="min-w-0 flex-1 truncate">{group.name}</span>
									<span className="shrink-0 tabular-nums text-[10px] font-normal text-[var(--omp-dim)]">
										{group.sessions.length}
									</span>
									{confirmingGroupDeleteCwd === group.cwd ? (
										<span className="flex shrink-0 items-center gap-0.5" onClick={e => e.stopPropagation()}>
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
										</span>
									) : (
										<span
											role="button"
											tabIndex={0}
											title={groupDeleteTitle}
											aria-label={groupDeleteTitle}
											aria-disabled={groupDeleteBlocked}
											className={cx(
												"hidden h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] group-hover:flex",
												groupDeleteBlocked
													? "cursor-not-allowed opacity-40"
													: "hover:bg-[var(--omp-tool-error-bg)] hover:text-[var(--omp-error)]",
											)}
											onClick={event => {
												event.stopPropagation();
												if (groupDeleteBlocked) {
													toast({ variant: "warning", message: groupDeleteTitle });
													return;
												}
												setConfirmingGroupDeleteCwd(group.cwd);
											}}
											onKeyDown={event => {
												if (event.key === "Enter") {
													event.stopPropagation();
													if (groupDeleteBlocked) {
														toast({ variant: "warning", message: groupDeleteTitle });
														return;
													}
													setConfirmingGroupDeleteCwd(group.cwd);
												}
											}}
										>
											<Trash2 size={11} />
										</span>
									)}
								</button>
								{!groupCollapsed && (
									<div className="space-y-0.5">
										{group.sessions.map(session => {
											const active = session.id === sessionId;
											// Signal light: attached session uses live store state; other
											// rows fall back to the session file's tail status ("pending"
											// means mid-run). Waiting-for-confirmation wins over running.
											const signal: "waiting" | "running" | null = active
												? awaitingConfirmation
													? "waiting"
													: isStreaming
														? "running"
														: null
												: session.status === "pending"
													? "running"
													: null;
											return (
												<div
													key={session.path}
													role="button"
													tabIndex={0}
													onClick={() => void openSession(session)}
													onKeyDown={event => {
														if (event.key === "Enter") void openSession(session);
													}}
													className={cx(
														"group cursor-pointer rounded-md border px-2 py-2 transition-all",
														active
															? "border-[var(--omp-border-accent)] bg-[var(--omp-selected-bg)]"
															: "border-transparent hover:border-[var(--omp-border-muted)] hover:bg-[var(--omp-sidebar-item-hover)]",
													)}
												>
													<div className="flex items-center gap-1.5">
														<span
															title={
																signal === "waiting"
																	? t("sidebar.signal.waiting")
																	: signal === "running"
																		? t("sidebar.signal.running")
																		: session.status
															}
															className={cx(
																"h-1.5 w-1.5 shrink-0 rounded-full",
																signal != null && "omp-pulse-dot",
															)}
															style={{
																background:
																	signal === "waiting"
																		? "var(--omp-warning)"
																		: signal === "running"
																			? "var(--omp-success)"
																			: STATUS_COLOR[session.status],
															}}
														/>
														{active && renaming ? (
															<input
																ref={renameRef}
																value={renameDraft}
																onChange={event => setRenameDraft(event.target.value)}
																onBlur={commitRename}
																onKeyDown={event => {
																	if (event.key === "Enter") commitRename();
																	if (event.key === "Escape") setRenaming(false);
																}}
																onClick={event => event.stopPropagation()}
																className="min-w-0 flex-1 rounded border border-[var(--omp-input-focus-border)] bg-[var(--omp-input-bg)] px-1.5 py-0.5 text-[12.5px] font-medium text-[var(--omp-text)] outline-none"
															/>
														) : (
															<span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--omp-text)]">
																{session.title ?? session.firstMessage ?? t("sidebar.untitled")}
															</span>
														)}
														{active && !renaming && (
															<button
																type="button"
																title={t("sidebar.rename")}
																aria-label={t("sidebar.rename")}
																onClick={event => {
																	event.stopPropagation();
																	startRename();
																}}
																className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
															>
																<Pencil size={11} />
															</button>
														)}
														{!active && (
															<button
																type="button"
																title={t("sidebar.openInNewWindow")}
																aria-label={t("sidebar.openInNewWindow")}
																onClick={event => {
																	event.stopPropagation();
																	void openSessionInNewWindow(session);
																}}
																className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)] group-hover:flex"
															>
																<ExternalLink size={11} />
															</button>
														)}
														<span className="shrink-0 tabular-nums text-[10px] text-[var(--omp-dim)]">
															{formatTimeAgo(session.modified)}
														</span>
														{confirmingDeletePath === session.path ? (
															<span
																className="flex shrink-0 items-center gap-0.5"
																onClick={e => e.stopPropagation()}
															>
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
															</span>
														) : (
															<button
																className="hidden h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--omp-dim)] hover:bg-[var(--omp-tool-error-bg)] hover:text-[var(--omp-error)] disabled:opacity-30 group-hover:flex"
																disabled={active || isStreaming}
																onClick={event => {
																	event.stopPropagation();
																	if (!active && !isStreaming) setConfirmingDeletePath(session.path);
																}}
																title={active ? t("sidebar.activeCannotDelete") : t("sidebar.delete")}
																type="button"
																aria-label={t("sidebar.delete")}
															>
																<Trash2 size={11} />
															</button>
														)}
													</div>
												</div>
											);
										})}
									</div>
								)}
							</div>
						);
					})}
				</div>

				{/* Bottom utility row: files, stats, theme, language, settings */}
				<div className="flex items-center gap-0.5 border-t border-[var(--omp-border-muted)] px-2 py-2">
					<button
						type="button"
						onClick={() => setPanelTab("files")}
						title={t("sidebar.fileTree")}
						aria-label={t("sidebar.fileTree")}
						className={utilityButton}
					>
						<FolderTree size={15} />
					</button>
					<button
						type="button"
						onClick={onToggleStats}
						title={t("titlebar.stats")}
						aria-label={t("titlebar.stats")}
						className={utilityButton}
					>
						<BarChart3 size={15} />
					</button>
					<button
						type="button"
						onClick={openThemePicker}
						title={t("themePicker.aria")}
						aria-label={t("themePicker.aria")}
						className={utilityButton}
					>
						<Palette size={15} />
					</button>
					<LangSwitcher className="h-8 px-1.5" />
					<div className="flex-1" />
					<button
						type="button"
						onClick={openSettings}
						title={t("titlebar.settings")}
						aria-label={t("titlebar.settings")}
						className={utilityButton}
					>
						<Settings size={15} />
					</button>
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
		</>
	);
}
