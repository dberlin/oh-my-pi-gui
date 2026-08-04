import {
	BarChart3,
	ChevronRight,
	Coins,
	FolderOpen,
	PanelLeft,
	PanelRight,
	Plug,
	Search,
	Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSessionList } from "../../hooks/use-session-list";
import { basename, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { WorkspaceDialog } from "../dialogs/WorkspaceDialog";

export interface TitleBarProps {
	onToggleStats: () => void;
}

/**
 * Native desktop toolbar. Session controls stay here; model and execution
 * controls live beside the composer where they affect the next message.
 */
export function TitleBar({ onToggleStats }: TitleBarProps) {
	const t = useT();
	const sessionId = useSessionStore(s => s.sessionId);
	const sessionName = useSessionStore(s => s.sessionName);
	const cwd = useSessionStore(s => s.cwd);
	const status = useSessionStore(s => s.status);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const contextUsage = useSessionStore(s => s.contextUsage);
	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const sidebarVisible = useUiStore(s => s.sidebarVisible);
	const panelVisible = useUiStore(s => s.panelVisible);
	const toggleSidebar = useUiStore(s => s.toggleSidebar);
	const togglePanel = useUiStore(s => s.togglePanel);
	const openCommandPalette = useUiStore(s => s.openCommandPalette);
	const openUsage = useUiStore(s => s.openUsage);
	const openProviders = useUiStore(s => s.openProviders);
	const openSettings = useUiStore(s => s.openSettings);
	const { sessions } = useSessionList("local");
	const projectName = cwd ? basename(cwd) : t("titlebar.openProject");

	const [editingName, setEditingName] = useState(false);
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const nameInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (editingName) nameInputRef.current?.select();
	}, [editingName]);

	const current = sessions.find(s => s.id === sessionId);
	const displayName = sessionName ?? current?.title ?? t("sidebar.newSession");

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
				: status;

	return (
		<header className="drag-region flex h-12 shrink-0 items-center gap-1 border-b border-[var(--omp-border-muted)] bg-[var(--omp-titlebar-bg)] px-2.5">
			<button type="button" onClick={toggleSidebar} title={t("titlebar.toggleSidebar")} className={iconButton}>
				<PanelLeft size={18} className={cx(sidebarVisible && "text-[var(--omp-text)]")} />
			</button>

			<div className="no-drag flex min-w-0 items-center gap-1.5">
				<button
					className="omp-pressable flex max-w-48 items-center gap-2 truncate rounded-lg px-2 py-1.5 text-[13px] font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)] disabled:cursor-not-allowed disabled:opacity-50"
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
						className="w-56 rounded-lg border border-[var(--omp-input-focus-border)] bg-[var(--omp-input-bg)] px-2.5 py-1.5 text-[14px] font-medium text-[var(--omp-text)] outline-none"
					/>
				) : (
					<button
						type="button"
						title={t("titlebar.rename")}
						onClick={() => {
							setDraft(sessionName ?? "");
							setEditingName(true);
						}}
						className="omp-pressable max-w-72 truncate rounded-lg px-2 py-1.5 text-[14px] font-semibold text-[var(--omp-text)] hover:bg-[var(--omp-selected-bg)]"
					>
						{displayName}
					</button>
				)}
			</div>

			<div className="flex-1" />

			<button
				type="button"
				onClick={openCommandPalette}
				className="no-drag omp-pressable hidden h-9 min-w-44 items-center gap-2 rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-input-bg)] px-3 text-[12px] text-[var(--omp-muted)] shadow-[var(--omp-shadow-sm)] hover:border-[var(--omp-border)] hover:text-[var(--omp-text)] lg:flex"
			>
				<Search size={14} />
				<span>{t("titlebar.commands")}</span>
				<kbd className="ml-auto rounded border border-[var(--omp-border-muted)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--omp-dim)]">
					⌘K
				</kbd>
			</button>

			<div className="no-drag mx-1 flex items-center gap-2 rounded-full border border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--omp-muted)]">
				<span
					className={cx(
						"h-2 w-2 rounded-full",
						isStreaming
							? "animate-pulse bg-[var(--omp-accent)]"
							: status === "ready"
								? "bg-[var(--omp-success)]"
								: "bg-[var(--omp-warning)]",
					)}
				/>
				{statusLabel}
			</div>

			{planModeEnabled && (
				<span
					className="no-drag shrink-0 rounded-full border border-[var(--omp-border-accent)] bg-[var(--omp-accent-dim)] px-2 py-1 text-[10px] font-semibold text-[var(--omp-accent)]"
					title={t("titlebar.planMode")}
				>
					{t("titlebar.plan")}
				</span>
			)}
			{contextUsage && (
				<span
					className="no-drag shrink-0 rounded-full border border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] px-2 py-1 font-mono text-[10px] text-[var(--omp-muted)]"
					title={t("titlebar.contextTooltip")}
				>
					{Math.round(contextUsage.percent)}%
				</span>
			)}

			<button type="button" onClick={onToggleStats} title={t("titlebar.stats")} className={iconButton}>
				<BarChart3 size={17} />
			</button>
			<button type="button" onClick={openUsage} title={t("titlebar.usage")} className={iconButton}>
				<Coins size={17} />
			</button>
			<button type="button" onClick={openProviders} title={t("titlebar.providers")} className={iconButton}>
				<Plug size={17} />
			</button>
			<button type="button" onClick={togglePanel} title={t("titlebar.workspace")} className={iconButton}>
				<PanelRight size={18} className={cx(panelVisible && "text-[var(--omp-text)]")} />
			</button>
			<button type="button" onClick={openSettings} title={t("titlebar.settings")} className={iconButton}>
				<Settings size={17} />
			</button>
			<WorkspaceDialog open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />
		</header>
	);
}
