import { Bot, ClipboardList, Diff, FolderTree, ListOrdered, ListTodo, ScrollText, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveTabRouteReady } from "../../hooks/use-active-tab-route";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useQueueStore } from "../../stores/queue";
import { useSubagentsStore } from "../../stores/subagents";
import { useActiveTabKind, useTabsStore } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";
import type { PanelTab } from "../../stores/ui";
import { useUiStore } from "../../stores/ui";
import { PanelErrorBoundary } from "../common";
import { DiffPanel } from "../panels/DiffPanel";
import { FilesPanel } from "../panels/FilesPanel";
import { LogPanel } from "../panels/LogPanel";
import { PlanPanel } from "../panels/PlanPanel";
import { QueuePanel } from "../panels/QueuePanel";
import { SubagentPanel } from "../panels/SubagentPanel";
import { isLiveSubagentStatus } from "../panels/subagent-graph";
import { TodoPanel } from "../panels/TodoPanel";

const MIN_WIDTH = 360;
const MAX_WIDTH = 840;

function defaultPanelWidth(): number {
	const viewportWidth = Number.isFinite(window.innerWidth) && window.innerWidth > 0 ? window.innerWidth : 1440;
	return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(viewportWidth * 0.28)));
}

const TABS: { id: PanelTab; labelKey: string; icon: typeof Bot }[] = [
	{ id: "todo", labelKey: "panel.tabs.todo", icon: ListTodo },
	{ id: "plan", labelKey: "panel.tabs.plan", icon: ClipboardList },
	{ id: "agents", labelKey: "panel.tabs.agents", icon: Bot },
	{ id: "queue", labelKey: "panel.tabs.queue", icon: ListOrdered },
	{ id: "diff", labelKey: "panel.tabs.diff", icon: Diff },
	{ id: "files", labelKey: "panel.tabs.files", icon: FolderTree },
	{ id: "logs", labelKey: "panel.tabs.logs", icon: ScrollText },
];

/** Drawer tabs meaningful in a tool-free chat tab (no todos, plans, agents, or diffs). */
const CHAT_TAB_IDS: ReadonlySet<PanelTab> = new Set(["files", "logs"]);

/**
 * Contextual workspace drawer. Hidden by default; opened explicitly for
 * plans, subagents, diffs, files, or logs without shrinking the core chat.
 */
export function PanelContainer() {
	const t = useT();
	const panelTab = useUiStore(s => s.panelTab);
	const setPanelTab = useUiStore(s => s.setPanelTab);
	const togglePanel = useUiStore(s => s.togglePanel);
	const subagents = useSubagentsStore(s => s.subagents);
	const phases = useTodoStore(s => s.phases);
	const activeTabId = useTabsStore(s => s.activeTabId);
	const routeReady = useActiveTabRouteReady();
	/** Chat tabs only expose files + logs — the rest can't exist without tools. */
	const isChat = useActiveTabKind() === "chat";
	const visibleTabs = isChat ? TABS.filter(tab => CHAT_TAB_IDS.has(tab.id)) : TABS;
	const visiblePanelTab = isChat && !CHAT_TAB_IDS.has(panelTab) ? "files" : panelTab;

	const [width, setWidth] = useState(defaultPanelWidth);
	const dragging = useRef(false);

	useEffect(() => {
		const clampToViewport = () => {
			const viewportLimit = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - 56));
			setWidth(current => Math.min(current, viewportLimit));
		};
		window.addEventListener("resize", clampToViewport);
		return () => window.removeEventListener("resize", clampToViewport);
	}, []);

	const startDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		dragging.current = true;
		e.currentTarget.setPointerCapture(e.pointerId);
	}, []);

	const onDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
		if (!dragging.current) return;
		// Panel is right-anchored: dragging left grows it.
		const host = e.currentTarget.parentElement;
		if (!host) return;
		const hostRect = host.getBoundingClientRect();
		const hostLimit = Math.min(MAX_WIDTH, Math.round(hostRect.width * 0.55));
		const next = Math.min(hostLimit, Math.max(MIN_WIDTH, hostRect.right - e.clientX));
		setWidth(next);
	}, []);

	const endDrag = useCallback(() => {
		dragging.current = false;
	}, []);

	const runningAgents = [...subagents.values()].filter(s => isLiveSubagentStatus(s.status)).length;
	const todoTaskCount = (phases ?? []).reduce((n, p) => n + (p.tasks?.length ?? 0), 0);
	const queuedCount = useQueueStore(s => s.steering.length + s.followUp.length);

	return (
		<aside
			aria-busy={!routeReady}
			className={cx(
				"omp-inspector relative flex h-full shrink-0 flex-col border-l border-[var(--omp-border-muted)] bg-[var(--omp-bg-primary)]",
				!routeReady && "pointer-events-none",
			)}
			style={{ width }}
		>
			<div className="flex h-[52px] shrink-0 items-center border-b border-[var(--omp-border-muted)] px-4">
				<div>
					<div className="text-[14px] font-semibold text-[var(--omp-text)]">{t("panel.title")}</div>
					<div className="text-[12px] text-[var(--omp-dim)]">{t("panel.subtitle")}</div>
				</div>
				<button
					type="button"
					onClick={togglePanel}
					title={t("panel.close")}
					className="omp-pressable ml-auto flex h-8 w-8 items-center justify-center rounded-lg text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
				>
					<X size={17} />
				</button>
			</div>
			<div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--omp-border-muted)] px-2">
				{visibleTabs.map(({ id, labelKey, icon: Icon }) => {
					const active = visiblePanelTab === id;
					const badge =
						id === "agents" && runningAgents > 0
							? runningAgents
							: id === "todo" && todoTaskCount > 0
								? todoTaskCount
								: id === "queue" && queuedCount > 0
									? queuedCount
									: null;
					return (
						<button
							key={id}
							type="button"
							onClick={() => setPanelTab(id)}
							className={cx(
								"relative flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12px] font-medium transition-colors",
								active
									? "bg-[var(--omp-selected-bg)] text-[var(--omp-text)]"
									: "text-[var(--omp-muted)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]",
							)}
						>
							<Icon size={14} />
							<span className="omp-inspector-tab-label">{t(labelKey)}</span>
							{badge != null && (
								<span
									className={cx(
										"min-w-4 rounded-full px-1 py-0.5 text-[10px] font-semibold tabular-nums",
										id === "agents"
											? "bg-[var(--omp-accent-dim)] text-[var(--omp-accent)]"
											: "bg-[var(--omp-bg-tertiary)] text-[var(--omp-muted)]",
									)}
								>
									{badge}
								</span>
							)}
							{active && (
								<span className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full bg-[var(--omp-accent)]" />
							)}
						</button>
					);
				})}
			</div>
			<div className="min-h-0 flex-1 overflow-hidden">
				<PanelErrorBoundary key={`${activeTabId ?? "no-tab"}:${visiblePanelTab}`}>
					{visiblePanelTab === "todo" && <TodoPanel />}
					{visiblePanelTab === "plan" && <PlanPanel />}
					{visiblePanelTab === "agents" && <SubagentPanel />}
					{visiblePanelTab === "queue" && <QueuePanel />}
					{visiblePanelTab === "diff" && <DiffPanel />}
					{visiblePanelTab === "files" && <FilesPanel />}
					{visiblePanelTab === "logs" && <LogPanel />}
				</PanelErrorBoundary>
			</div>
			<div
				role="separator"
				aria-orientation="vertical"
				onPointerDown={startDrag}
				onPointerMove={onDrag}
				onPointerUp={endDrag}
				className="absolute inset-y-0 left-0 z-10 w-1 -translate-x-1/2 cursor-col-resize transition-colors hover:bg-[var(--omp-accent)]/40 active:bg-[var(--omp-accent)] max-[1000px]:hidden"
			/>
		</aside>
	);
}
