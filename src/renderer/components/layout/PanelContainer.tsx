import { Bot, ClipboardList, Diff, FolderTree, ListTodo, ScrollText, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSubagentsStore } from "../../stores/subagents";
import { useTodoStore } from "../../stores/todo";
import type { PanelTab } from "../../stores/ui";
import { useUiStore } from "../../stores/ui";
import { DiffPanel } from "../panels/DiffPanel";
import { FilesPanel } from "../panels/FilesPanel";
import { LogPanel } from "../panels/LogPanel";
import { PlanPanel } from "../panels/PlanPanel";
import { SubagentPanel } from "../panels/SubagentPanel";
import { TodoPanel } from "../panels/TodoPanel";

const MIN_WIDTH = 320;
const MAX_WIDTH = 680;
const DEFAULT_WIDTH = 400;

const TABS: { id: PanelTab; labelKey: string; icon: typeof Bot }[] = [
	{ id: "todo", labelKey: "panel.tabs.todo", icon: ListTodo },
	{ id: "plan", labelKey: "panel.tabs.plan", icon: ClipboardList },
	{ id: "agents", labelKey: "panel.tabs.agents", icon: Bot },
	{ id: "diff", labelKey: "panel.tabs.diff", icon: Diff },
	{ id: "files", labelKey: "panel.tabs.files", icon: FolderTree },
	{ id: "logs", labelKey: "panel.tabs.logs", icon: ScrollText },
];

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

	const [width, setWidth] = useState(DEFAULT_WIDTH);
	const dragging = useRef(false);

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
		const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, hostRect.right - e.clientX));
		setWidth(next);
	}, []);

	const endDrag = useCallback(() => {
		dragging.current = false;
	}, []);

	const runningAgents = [...subagents.values()].filter(s => s.status === "started").length;
	const todoTaskCount = (phases ?? []).reduce((n, p) => n + (p.tasks?.length ?? 0), 0);

	return (
		<aside
			className="omp-inspector relative flex h-full shrink-0 flex-col border-l border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] shadow-[-12px_0_32px_rgba(0,0,0,0.08)]"
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
				{TABS.map(({ id, labelKey, icon: Icon }) => {
					const active = panelTab === id;
					const badge =
						id === "agents" && runningAgents > 0
							? runningAgents
							: id === "todo" && todoTaskCount > 0
								? todoTaskCount
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
							<span className="hidden min-[1180px]:inline">{t(labelKey)}</span>
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
				{panelTab === "todo" && <TodoPanel />}
				{panelTab === "plan" && <PlanPanel />}
				{panelTab === "agents" && <SubagentPanel />}
				{panelTab === "diff" && <DiffPanel />}
				{panelTab === "files" && <FilesPanel />}
				{panelTab === "logs" && <LogPanel />}
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
