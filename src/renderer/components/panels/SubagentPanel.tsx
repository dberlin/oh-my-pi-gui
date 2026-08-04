/**
 * Subagent panel: live tree of subagent nodes with status badges, elapsed
 * time, progress line, and lazily loaded transcripts (byte pagination).
 * A List/Graph toggle switches the flat list for the graphical spawn DAG.
 */

import { Bot, ChevronRight, List, Network } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSubagentsStore } from "../../stores/subagents";
import { Badge } from "../common";
import { SubagentDag } from "./SubagentDag";
import { SubagentTranscript } from "./SubagentTranscript";
import { formatElapsed, noteFirstSeen, STATUS_LABEL_KEY, STATUS_META } from "./subagent-graph";

type PanelView = "list" | "graph";

const SubagentRow = memo(function SubagentRow({
	agent,
	expanded,
	onToggle,
	now,
}: {
	agent: SubagentSnapshot;
	expanded: boolean;
	onToggle: () => void;
	now: number;
}) {
	const t = useT();
	const meta = STATUS_META[agent.status];
	const elapsed = agent.status === "started" ? now - noteFirstSeen(agent.id) : 0;

	return (
		<div
			className={`rounded-md border transition-colors duration-150 ${
				agent.status === "started"
					? "border-[color-mix(in_srgb,var(--omp-link)_35%,transparent)]"
					: agent.status === "failed"
						? "border-[color-mix(in_srgb,var(--omp-error)_35%,transparent)]"
						: "border-(--omp-border-muted)"
			} ${agent.status === "completed" || agent.status === "cancelled" ? "opacity-70" : ""}`}
		>
			<button
				aria-expanded={expanded}
				className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-(--omp-bg-tertiary)"
				onClick={onToggle}
				type="button"
			>
				<ChevronRight
					className="shrink-0 text-(--omp-dim) transition-transform duration-100"
					size={12}
					style={{ transform: expanded ? "rotate(90deg)" : undefined }}
				/>
				<Bot className="shrink-0 text-(--omp-status-subagents)" size={13} />
				<span className="min-w-0 flex-1 truncate text-xs font-medium text-(--omp-text)">
					{agent.agent}
					{agent.index > 0 && <span className="ml-1 text-[10px] text-(--omp-dim)">#{agent.index + 1}</span>}
				</span>
				<Badge dot={meta.live} pulse={meta.live} variant={meta.variant}>
					{t(STATUS_LABEL_KEY[agent.status])}
				</Badge>
				{agent.status === "started" && (
					<span className="shrink-0 text-[10px] tabular-nums text-(--omp-dim)">{formatElapsed(elapsed)}</span>
				)}
			</button>
			{agent.progress?.description && agent.status === "started" && (
				<div className="truncate border-t border-(--omp-border-muted) px-7 py-1 text-[10px] text-(--omp-muted) italic">
					{agent.progress.description}
				</div>
			)}
			{agent.description && (
				<div className="truncate px-7 pb-1 text-[10px] text-(--omp-dim)">{agent.description}</div>
			)}
			{expanded && (
				<div className="border-t border-(--omp-border-muted)">
					<SubagentTranscript agent={agent} />
				</div>
			)}
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
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [view, setView] = useState<PanelView>("list");
	const [now, setNow] = useState(() => Date.now());

	const hasRunning = [...subagents.values()].some(agent => agent.status === "started");

	useEffect(() => {
		if (!hasRunning) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasRunning]);

	const sorted = [...subagents.values()].sort((a, b) => a.index - b.index);

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
					{t("subagentPanel.title")} <span className="tabular-nums normal-case">{sorted.length}</span>
				</span>
				<ViewToggle onChange={setView} view={view} />
			</div>
			{sorted.length === 0 ? (
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
				<div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-2">
					{sorted.map(agent => (
						<SubagentRow
							agent={agent}
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
