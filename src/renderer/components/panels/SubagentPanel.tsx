/**
 * Subagent panel: live tree of subagent nodes with status badges, elapsed
 * time, progress line, and lazily loaded transcripts (byte pagination).
 * A List/Graph toggle switches the compact spawn tree for the graphical DAG.
 */

import { Bot, ChevronRight, List, Network } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
import { Badge } from "../common";
import { SubagentDag } from "./SubagentDag";
import { SubagentTranscript } from "./SubagentTranscript";
import {
	buildSubagentList,
	extractTaskToolCallIds,
	formatElapsed,
	isLiveSubagentStatus,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
	useSubagentGraphStore,
} from "./subagent-graph";

type PanelView = "list" | "graph";

const SubagentRow = memo(function SubagentRow({
	agent,
	depth,
	expanded,
	onToggle,
	now,
}: {
	agent: SubagentSnapshot;
	depth: number;
	expanded: boolean;
	onToggle: () => void;
	now: number;
}) {
	const t = useT();
	const meta = statusMeta(agent.status);
	const live = isLiveSubagentStatus(agent.status);
	const elapsed = subagentElapsedMs(agent, now);
	const title = subagentPrimaryLabel(agent);
	const progressLine = live ? agent.progress?.description?.trim() : undefined;
	const description = agent.description?.trim();
	const detail = [progressLine, description].find(line => line && line !== title);
	const model = agent.progress?.resolvedModel;

	return (
		<div aria-level={depth + 1} className="relative" role="treeitem" style={{ marginLeft: Math.min(depth, 6) * 14 }}>
			{depth > 0 && (
				<span className="pointer-events-none absolute top-0 -left-2.5 h-5 w-2.5 rounded-bl-md border-b border-l border-(--omp-border-muted)" />
			)}
			<div
				className={cx(
					"relative overflow-hidden rounded-lg bg-(--omp-bg-secondary) transition-colors duration-150 hover:bg-(--omp-bg-tertiary)",
					agent.status === "cancelled" && "opacity-70",
				)}
			>
				<span
					aria-hidden
					className={cx(
						"absolute inset-y-2 left-0 w-0.5 rounded-full",
						live ? "bg-(--omp-link)" : agent.status === "failed" ? "bg-(--omp-error)" : "bg-(--omp-border)",
					)}
				/>
				<button
					aria-expanded={expanded}
					className="flex w-full items-start gap-1.5 py-2 pr-2.5 pl-2 text-left"
					onClick={onToggle}
					type="button"
				>
					<ChevronRight
						className="mt-0.5 shrink-0 text-(--omp-dim) transition-transform duration-100"
						size={12}
						style={{ transform: expanded ? "rotate(90deg)" : undefined }}
					/>
					<span className="min-w-0 flex-1">
						<span className="flex min-w-0 items-center gap-1.5">
							<span
								className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-(--omp-text)"
								title={title}
							>
								{title}
							</span>
							<Badge dot={meta.live} pulse={meta.live} variant={meta.variant}>
								{t(meta.labelKey)}
							</Badge>
						</span>
						<span className="mt-1 flex min-w-0 items-center gap-1 text-[9.5px] text-(--omp-dim)">
							<Bot className="shrink-0 text-(--omp-status-subagents)" size={10} />
							<span className="shrink-0">{agent.agent}</span>
							<span className="shrink-0 tabular-nums">#{agent.index + 1}</span>
							{model && <span className="min-w-0 truncate">· {model}</span>}
							{elapsed !== null && (
								<span className="ml-auto shrink-0 tabular-nums">{formatElapsed(elapsed)}</span>
							)}
						</span>
					</span>
				</button>
				{detail && (
					<div className="truncate px-6 pb-2 text-[10px] text-(--omp-muted)" title={detail}>
						{detail}
					</div>
				)}
				{expanded && (
					<div className="border-t border-(--omp-border-muted)">
						<SubagentTranscript agent={agent} />
					</div>
				)}
			</div>
		</div>
	);
});

function ViewToggle({ view, onChange }: { view: PanelView; onChange: (view: PanelView) => void }) {
	const t = useT();
	return (
		<div
			aria-label={t("subagentPanel.viewAria")}
			className="flex items-center gap-0.5 rounded-md border border-(--omp-border-muted) p-0.5"
			role="group"
		>
			{(["list", "graph"] as const).map(option => (
				<button
					aria-pressed={view === option}
					className={cx(
						"flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] transition-colors",
						view === option
							? "bg-(--omp-bg-tertiary) text-(--omp-text)"
							: "text-(--omp-dim) hover:text-(--omp-text)",
					)}
					key={option}
					onClick={() => onChange(option)}
					title={option === "list" ? t("subagentPanel.listView") : t("subagentPanel.graphView")}
					type="button"
				>
					{option === "list" ? <List size={11} /> : <Network size={11} />}
					{option === "list" ? t("subagentPanel.list") : t("subagentPanel.graph")}
				</button>
			))}
		</div>
	);
}

export function SubagentPanel() {
	const t = useT();
	const subagents = useSubagentsStore(state => state.subagents);
	const toolCallOwners = useSubagentGraphStore(state => state.toolCallOwners);
	const messages = useMessagesStore(state => state.messages);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [view, setView] = useState<PanelView>("list");
	const [now, setNow] = useState(() => Date.now());

	const agents = useMemo(() => [...subagents.values()].sort((a, b) => a.index - b.index), [subagents]);
	const hasRunning = agents.some(agent => isLiveSubagentStatus(agent.status));

	useEffect(() => {
		if (!hasRunning) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasRunning]);

	const rootToolCallIds = useMemo(() => new Set(extractTaskToolCallIds(messages)), [messages]);
	const rows = useMemo(
		() => buildSubagentList(agents, rootToolCallIds, toolCallOwners),
		[agents, rootToolCallIds, toolCallOwners],
	);

	const toggle = useCallback((id: string) => {
		setExpanded(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
				<span className="text-[10px] font-medium tracking-widest text-(--omp-dim) uppercase">
					{t("subagentPanel.title")} <span className="tabular-nums normal-case">{agents.length}</span>
				</span>
				<ViewToggle onChange={setView} view={view} />
			</div>
			{agents.length === 0 ? (
				<div className="px-3 py-8 text-center text-[11px] leading-relaxed text-(--omp-dim)">
					{t("subagent.empty")}
					<br />
					{t("subagent.emptyHint")}
				</div>
			) : view === "graph" ? (
				<div className="min-h-0 flex-1">
					<SubagentDag />
				</div>
			) : (
				<div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2" role="tree">
					{rows.map(({ agent, depth }) => (
						<SubagentRow
							agent={agent}
							depth={depth}
							expanded={expanded.has(agent.id)}
							key={agent.id}
							now={now}
							onToggle={() => toggle(agent.id)}
						/>
					))}
				</div>
			)}
		</div>
	);
}
