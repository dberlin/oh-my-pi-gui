import { ChevronRight, Clock3, Coins, Database, FolderOpen, Gauge, PanelLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionStats } from "../../../shared/rpc-types";
import { useSessionList } from "../../hooks/use-session-list";
import { basename, cx, formatCost, formatDuration, formatPercent, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { useActiveTabKind } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { WorkspaceDialog } from "../dialogs/WorkspaceDialog";
import { sessionCacheHitPercent, sessionExecutionDurationMs } from "./session-metrics";

/**
 * Native desktop toolbar. Session controls stay here; model and execution
 * controls live beside the composer where they affect the next message.
 */
export function TitleBar() {
	const t = useT();
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	const cwd = useSessionStore(s => s.cwd);
	const status = useSessionStore(s => s.status);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const isChat = useActiveTabKind() === "chat";

	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const awaitingModelSince = useSessionStore(s => s.awaitingModelSince);
	const messages = useMessagesStore(s => s.messages);
	const streamingMessage = useMessagesStore(s => s.streamingMessage);
	const tools = useToolsStore(s => s.activeTools);
	const sidebarVisible = useUiStore(s => s.sidebarVisible);
	const toggleSidebar = useUiStore(s => s.toggleSidebar);
	const { sessions } = useSessionList("local");
	const projectName = !isChat && cwd ? basename(cwd) : t("titlebar.openProject");

	const [editingName, setEditingName] = useState(false);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [stats, setStats] = useState<SessionStats | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const nameInputRef = useRef<HTMLInputElement>(null);
	const statsMessageCount = messages.length;
	const prevSessionRef = useRef<string | null>(null);

	useEffect(() => {
		if (editingName) nameInputRef.current?.select();
	}, [editingName]);

	useEffect(() => {
		if (!sessionId || status !== "ready") {
			setStats(null);
			prevSessionRef.current = null;
			return;
		}
		// Cross-session staleness is the bug: session A's tokens/cost must never
		// display over session B. Within ONE session, keeping the previous read
		// while the refetch is in flight beats a clear-refetch flicker on every
		// message append; the message-count guard rejects mismatched responses.
		if (prevSessionRef.current !== sessionId) setStats(null);
		prevSessionRef.current = sessionId;
		let cancelled = false;
		const requestedSessionId = sessionId;
		const requestedMessageCount = statsMessageCount;
		void window.omp.rpc
			.getSessionStats()
			.then(response => {
				if (
					!cancelled &&
					response.success &&
					useSessionStore.getState().sessionId === requestedSessionId &&
					useMessagesStore.getState().messages.length === requestedMessageCount
				) {
					setStats(response.data as SessionStats);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [sessionId, statsMessageCount, status]);

	const hasRunningTool = [...tools.values()].some(tool => tool.endTime === null);
	useEffect(() => {
		setNow(Date.now());
		if (!isStreaming && !hasRunningTool) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [hasRunningTool, isStreaming]);

	const current = sessions.find(s => s.id === sessionId);
	// `||` everywhere: empty-string titles (never-generated auto-title slot)
	// fall through like null, ending at the "New Session" placeholder.
	const displayName = sessionName || current?.title || t("sidebar.newSession");
	const cacheHit = sessionCacheHitPercent(stats);
	const executionDuration = sessionExecutionDurationMs({
		messages,
		streamingMessage,
		tools,
		awaitingModelSince,
		isStreaming,
		now,
	});

	const commitName = () => {
		const name = draft.trim();
		setEditingName(false);
		if (!name || name === displayName) return;
		void window.omp.rpc
			.setSessionName(name)
			.then(response => {
				if (response.success) useSessionStore.setState({ sessionName: name });
				else toast({ variant: "error", title: t("titlebar.renameFailed"), message: response.error });
			})
			.catch(error => {
				toast({ variant: "error", title: t("titlebar.renameFailed"), message: String(error) });
			});
	};

	const iconButton =
		"no-drag omp-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]";
	const statusLabel = isStreaming
		? t("titlebar.status.working")
		: status === "ready"
			? t("titlebar.status.ready")
			: status === "starting"
				? t("titlebar.status.connecting")
				: status === "error" || status === "exited" || status === "restarting"
					? t(`titlebar.status.${status}`)
					: status;

	return (
		<header className="omp-titlebar drag-region flex h-12 min-w-0 shrink-0 items-center gap-1 overflow-hidden border-b border-[var(--omp-border-muted)] bg-[var(--omp-titlebar-bg)] px-2.5">
			<button type="button" onClick={toggleSidebar} title={t("titlebar.toggleSidebar")} className={iconButton}>
				<PanelLeft size={18} className={cx(sidebarVisible && "text-[var(--omp-text)]")} />
			</button>

			<div className="omp-titlebar-identity no-drag flex min-w-0 items-center gap-1.5">
				<button
					className="omp-pressable flex min-w-0 max-w-48 items-center gap-2 truncate rounded-lg px-2 py-1.5 text-omp-lg font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)] disabled:cursor-not-allowed disabled:opacity-50"
					disabled={isStreaming}
					onClick={() => setWorkspaceOpen(true)}
					title={isStreaming ? t("titlebar.abortHint") : t("titlebar.openProject")}
					type="button"
				>
					<FolderOpen className="shrink-0" size={15} />
					<span className="truncate">{projectName}</span>
				</button>
				<ChevronRight size={14} className="text-[var(--omp-dim)]" />
				{editingName ? (
					<input
						ref={nameInputRef}
						value={draft}
						onChange={event => setDraft(event.target.value)}
						onBlur={commitName}
						onKeyDown={event => {
							if (event.key === "Enter") commitName();
							if (event.key === "Escape") setEditingName(false);
						}}
						className="min-w-0 max-w-56 rounded-lg border border-[var(--omp-input-focus-border)] bg-[var(--omp-input-bg)] px-2.5 py-1.5 text-omp-lg font-medium text-[var(--omp-text)] outline-none"
					/>
				) : (
					<button
						type="button"
						title={t("titlebar.rename")}
						onClick={() => {
							setDraft(sessionName ?? "");
							setEditingName(true);
						}}
						className="omp-pressable min-w-0 max-w-72 truncate rounded-lg px-2 py-1.5 text-omp-lg font-semibold text-[var(--omp-text)] hover:bg-[var(--omp-selected-bg)]"
					>
						{displayName}
					</button>
				)}
			</div>

			<div className="omp-titlebar-status no-drag flex shrink-0 items-center gap-1.5 px-1 text-omp-sm font-medium text-[var(--omp-muted)]">
				<span
					className={cx(
						"h-2 w-2 rounded-full",
						isStreaming
							? "bg-[var(--omp-accent)]"
							: status === "ready"
								? "bg-[var(--omp-success)]"
								: "bg-[var(--omp-warning)]",
					)}
				/>
				<span className="omp-titlebar-status-label">{statusLabel}</span>
			</div>

			{planModeEnabled && (
				<span
					className="no-drag shrink-0 rounded-full border border-[var(--omp-border-accent)] bg-[var(--omp-accent-dim)] px-2 py-1 text-omp-xs font-semibold text-[var(--omp-accent)]"
					title={t("titlebar.planMode")}
				>
					{t("titlebar.plan")}
				</span>
			)}

			<div className="flex-1" />

			<div className="omp-session-metrics no-drag flex shrink-0 items-center gap-3 font-mono text-omp-sm tabular-nums text-[var(--omp-muted)]">
				<span className="flex items-center gap-1" title={t("titlebar.metric.tokens")}>
					<Database aria-hidden="true" size={14} />
					{stats ? formatTokens(stats.tokens.total) : "—"}
				</span>
				<span className="flex items-center gap-1" title={t("titlebar.metric.cost")}>
					<Coins aria-hidden="true" size={14} />
					{stats ? formatCost(stats.cost, 4) : "—"}
				</span>
				<span className="flex items-center gap-1" title={t("titlebar.metric.cacheHit")}>
					<Gauge aria-hidden="true" size={14} />
					{formatPercent(cacheHit, 0)}
				</span>
				<span className="flex items-center gap-1" title={t("titlebar.metric.duration")}>
					<Clock3 aria-hidden="true" size={14} />
					{executionDuration > 0 ? formatDuration(executionDuration) : t("time.secondsShort", { count: 0 })}
				</span>
			</div>
			<WorkspaceDialog open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />
		</header>
	);
}
