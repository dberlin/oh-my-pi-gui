/**
 * Graphical subagent DAG: a full-height navigation and lifecycle surface.
 * Nodes retain spawn relationships and live metadata while the shared main
 * canvas remains the only transcript viewer.
 *
 * Layout is a hand-rolled layered tidy tree (depth columns left→right,
 * parents centered on children) rendered as HTML nodes over an SVG edge
 * layer — no graph dependency. Live-updates as subagent frames arrive.
 */

import { Bot, RefreshCw, Square, Terminal } from "lucide-react";
import { type FocusEvent, type KeyboardEvent, memo, useEffect, useMemo, useState } from "react";
import type { SubagentSnapshot } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
import { Badge } from "../common";
import {
	buildSubagentDag,
	DAG_NODE_HEIGHT,
	DAG_NODE_WIDTH,
	type DagEdge,
	type DagNode,
	extractTaskToolCallIds,
	formatElapsed,
	isLiveSubagentStatus,
	MAIN_NODE_ID,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
} from "./subagent-graph";

function nodeBorderClass(agent: SubagentSnapshot): string {
	if (isLiveSubagentStatus(agent.status)) {
		return "border-[color-mix(in_srgb,var(--omp-link)_35%,transparent)]";
	}
	switch (agent.status) {
		case "failed":
			return "border-[color-mix(in_srgb,var(--omp-error)_35%,transparent)]";
		default:
			return "border-(--omp-border-muted)";
	}
}

function edgePath(edge: DagEdge): string {
	const bend = Math.max(24, (edge.x2 - edge.x1) / 2);
	return `M ${edge.x1} ${edge.y1} C ${edge.x1 + bend} ${edge.y1}, ${edge.x2 - bend} ${edge.y2}, ${edge.x2} ${edge.y2}`;
}

export type SubagentLifecycleAction = "abort" | "revive";

interface SubagentDagProps {
	viewedAgentId: string | null;
	working: boolean;
	onActivate: (agent: SubagentSnapshot | null) => void;
	onLifecycleAction: (action: SubagentLifecycleAction, agent: SubagentSnapshot) => void;
}

const DagAgentNode = memo(function DagAgentNode({
	agent,
	depth,
	x,
	y,
	selected,
	viewing,
	now,
	working,
	onSelect,
	onActivate,
	onLifecycleAction,
}: {
	agent: SubagentSnapshot;
	depth: number;
	x: number;
	y: number;
	selected: boolean;
	viewing: boolean;
	now: number;
	working: boolean;
	onSelect: () => void;
	onActivate: () => void;
	onLifecycleAction: (action: SubagentLifecycleAction, agent: SubagentSnapshot) => void;
}) {
	const t = useT();
	const meta = statusMeta(agent.status);
	const live = isLiveSubagentStatus(agent.status);
	const elapsed = subagentElapsedMs(agent, now);
	const line = live && agent.progress?.description ? agent.progress.description : `${agent.agent} #${agent.index + 1}`;
	const actionable = live && agent.kind !== "advisor";
	const revivable = agent.status === "parked" && agent.kind !== "advisor";
	const stopActionKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		event.stopPropagation();
	};

	return (
		<div
			aria-current={viewing || undefined}
			aria-level={depth + 1}
			aria-selected={selected}
			className={cx(
				"absolute flex flex-col rounded-md border px-2 py-1.5 text-left transition-colors duration-150 hover:bg-(--omp-bg-tertiary)",
				viewing ? "border-(--omp-link)" : nodeBorderClass(agent),
				(agent.status === "completed" || agent.status === "cancelled") && "opacity-70",
				selected && "ring-1 ring-(--omp-link)",
			)}
			onClick={onSelect}
			onDoubleClick={onActivate}
			onFocus={(event: FocusEvent<HTMLDivElement>) => {
				if (event.currentTarget === event.target) onSelect();
			}}
			onKeyDown={event => {
				if (event.currentTarget !== event.target || event.key !== "Enter") return;
				event.preventDefault();
				onActivate();
			}}
			role="treeitem"
			style={{ left: x, top: y, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT }}
			tabIndex={0}
		>
			<div className="flex min-w-0 items-center gap-1">
				<Bot className="shrink-0 text-(--omp-status-subagents)" size={12} />
				<span className="min-w-0 flex-1 truncate text-omp-sm font-medium text-(--omp-text)">
					{subagentPrimaryLabel(agent, 36)}
					{agent.index > 0 && <span className="ml-1 text-omp-xxs text-(--omp-dim)">#{agent.index + 1}</span>}
				</span>
				{viewing && <Badge variant="info">{t("agentView.viewing")}</Badge>}
				<Badge dot={meta.live} pulse={meta.live} variant={meta.variant}>
					{t(meta.labelKey)}
				</Badge>
			</div>
			<div className="mt-1 flex min-w-0 items-center gap-1 pl-[18px]">
				<span
					className={cx(
						"min-w-0 flex-1 truncate text-omp-xxs",
						live && agent.progress?.description ? "text-(--omp-muted) italic" : "text-(--omp-dim)",
					)}
				>
					{line}
				</span>
				{elapsed !== null && (
					<span className="shrink-0 text-omp-xxs tabular-nums text-(--omp-dim)">{formatElapsed(elapsed)}</span>
				)}
				{actionable && (
					<button
						aria-label={t("agentHub.hub.abortAgent")}
						className="omp-pressable flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--omp-muted) hover:bg-(--omp-error-dim) hover:text-(--omp-error) disabled:opacity-40"
						disabled={working}
						onClick={event => {
							event.stopPropagation();
							onLifecycleAction("abort", agent);
						}}
						onDoubleClick={event => event.stopPropagation()}
						onKeyDown={stopActionKey}
						title={t("agentHub.hub.abortAgent")}
						type="button"
					>
						<Square fill="currentColor" size={9} />
					</button>
				)}
				{revivable && (
					<button
						aria-label={t("agentHub.hub.reviveAgent")}
						className="omp-pressable flex h-5 w-5 shrink-0 items-center justify-center rounded text-(--omp-muted) hover:bg-(--omp-selected-bg) hover:text-(--omp-accent) disabled:opacity-40"
						disabled={working}
						onClick={event => {
							event.stopPropagation();
							onLifecycleAction("revive", agent);
						}}
						onDoubleClick={event => event.stopPropagation()}
						onKeyDown={stopActionKey}
						title={t("agentHub.hub.reviveAgent")}
						type="button"
					>
						<RefreshCw size={10} />
					</button>
				)}
			</div>
		</div>
	);
});

function MainNode({
	x,
	y,
	selected,
	viewing,
	onSelect,
	onActivate,
}: {
	x: number;
	y: number;
	selected: boolean;
	viewing: boolean;
	onSelect: () => void;
	onActivate: () => void;
}) {
	const t = useT();
	return (
		<div
			aria-current={viewing || undefined}
			aria-level={1}
			aria-selected={selected}
			className={cx(
				"absolute flex flex-col justify-center rounded-md border border-dashed bg-transparent px-2 py-1.5 text-left transition-colors hover:bg-(--omp-bg-tertiary)",
				viewing ? "border-(--omp-link)" : "border-(--omp-border-muted)",
				selected && "ring-1 ring-(--omp-link)",
			)}
			onClick={onSelect}
			onDoubleClick={onActivate}
			onFocus={(event: FocusEvent<HTMLDivElement>) => {
				if (event.currentTarget === event.target) onSelect();
			}}
			onKeyDown={event => {
				if (event.currentTarget !== event.target || event.key !== "Enter") return;
				event.preventDefault();
				onActivate();
			}}
			role="treeitem"
			style={{ left: x, top: y, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT }}
			tabIndex={0}
		>
			<div className="flex items-center gap-1.5">
				<Terminal className="shrink-0 text-(--omp-dim)" size={12} />
				<span className="min-w-0 flex-1 truncate text-omp-sm font-medium text-(--omp-muted)">{t("dag.main")}</span>
				{viewing && <Badge variant="info">{t("agentView.viewing")}</Badge>}
			</div>
			<div className="truncate pl-[18px] text-omp-xxs text-(--omp-dim)">{t("dag.mainSub")}</div>
		</div>
	);
}

export function SubagentDag({ viewedAgentId, working, onActivate, onLifecycleAction }: SubagentDagProps) {
	const t = useT();
	const subagents = useSubagentsStore(state => state.subagents);
	const toolCallOwners = useSubagentsStore(state => state.toolCallOwners);
	const messages = useMessagesStore(state => state.messages);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());

	const agents = useMemo(() => [...subagents.values()].sort((a, b) => a.index - b.index), [subagents]);
	const hasRunning = agents.some(agent => isLiveSubagentStatus(agent.status));

	useEffect(() => {
		if (!hasRunning) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasRunning]);

	useEffect(() => {
		if (selectedId && selectedId !== MAIN_NODE_ID && !subagents.has(selectedId)) setSelectedId(null);
	}, [selectedId, subagents]);

	// Top-level spawn edges resolve against the main session's `task` tool calls.
	const rootToolCallIds = useMemo(() => new Set(extractTaskToolCallIds(messages)), [messages]);
	const layout = useMemo(
		() => buildSubagentDag(agents, rootToolCallIds, toolCallOwners),
		[agents, rootToolCallIds, toolCallOwners],
	);

	if (agents.length === 0) {
		return (
			<div className="px-3 py-8 text-center text-omp-sm leading-relaxed text-(--omp-dim)">
				{t("subagent.empty")}
				<br />
				{t("subagent.emptyHint")}
			</div>
		);
	}

	return (
		<div
			aria-label={t("subagentPanel.graphView")}
			className="h-full min-h-0 overflow-auto"
			data-subagent-dag
			role="tree"
		>
			<div className="relative" style={{ width: layout.width, height: layout.height }}>
				<svg aria-hidden className="absolute top-0 left-0" height={layout.height} width={layout.width}>
					<defs>
						<marker id="subagent-dag-arrow" markerHeight="6" markerWidth="6" orient="auto" refX="5" refY="3">
							<path d="M 0 0 L 6 3 L 0 6 z" fill="context-stroke" />
						</marker>
					</defs>
					{layout.edges.map(edge => (
						<path
							d={edgePath(edge)}
							fill="none"
							key={edge.id}
							markerEnd="url(#subagent-dag-arrow)"
							stroke={edge.childId === selectedId ? "var(--omp-link)" : "var(--omp-border-muted)"}
							strokeWidth={edge.childId === selectedId ? 2 : 1.25}
						/>
					))}
				</svg>
				{layout.nodes.map((node: DagNode) =>
					node.agent === null ? (
						<MainNode
							key={node.id}
							onActivate={() => onActivate(null)}
							onSelect={() => setSelectedId(MAIN_NODE_ID)}
							selected={selectedId === MAIN_NODE_ID}
							viewing={viewedAgentId === null}
							x={node.x}
							y={node.y}
						/>
					) : (
						<DagAgentNode
							agent={node.agent}
							depth={node.depth}
							key={node.id}
							now={now}
							onActivate={() => onActivate(node.agent)}
							onLifecycleAction={onLifecycleAction}
							onSelect={() => setSelectedId(node.id)}
							selected={node.id === selectedId}
							viewing={node.id === viewedAgentId}
							working={working}
							x={node.x}
							y={node.y}
						/>
					),
				)}
			</div>
			{layout.unresolved.length > 0 && (
				<div className="sticky bottom-1 ml-3 w-fit rounded bg-(--omp-bg-secondary) px-1.5 py-0.5 text-omp-xxs text-(--omp-dim) italic">
					{t("dag.unresolved", {
						count: layout.unresolved.length,
						plural: layout.unresolved.length === 1 ? "agent" : "agents",
					})}
				</div>
			)}
		</div>
	);
}
