/**
 * Agents dock card: the live agent roster rendered in the center dock above
 * the composer. The list is a navigation surface for the shared transcript
 * canvas; its synthetic Main root and subagent rows keep selection separate
 * from activation. A List/Graph toggle switches the compact spawn tree for
 * the graphical DAG.
 *
 * Owns stream-time polling of get_subagents (moved from the ActivityStrip
 * agents chip): lifecycle/progress frames keep the store fresh while agents
 * run, but parked/idle transitions ride the AgentRegistry and emit NO wire
 * frame — without polling, a watchdog-parked agent would show "running"
 * until the next session hydration.
 */

import { Bot, List, Network, RefreshCw, Square } from "lucide-react";
import { type FocusEvent, type KeyboardEvent, memo, useCallback, useEffect, useMemo, useState } from "react";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { useActiveTabRouteReady } from "../../../hooks/use-active-tab-route";
import { useTabGuard } from "../../../hooks/use-tab-guard";
import { cx, formatCost, formatTokens } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { acceptsActiveTabEvents } from "../../../lib/tab-routing";
import { type AgentViewTarget, useAgentViewStore } from "../../../stores/agent-view";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { toast } from "../../../stores/toast";
import { Badge } from "../../common";
import { SubagentDag, type SubagentLifecycleAction } from "../../panels/SubagentDag";
import {
	buildSubagentList,
	extractTaskToolCallIds,
	formatElapsed,
	isLiveSubagentStatus,
	type SubagentListRow,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
} from "../../panels/subagent-graph";
import { DockCard } from "./DockCard";
import { buildAgentDockSummary } from "./dock-summary";
import { useWorkspaceDockFocus } from "./WorkspaceDockFocus";

type PanelView = "list" | "graph";
type AgentDockRow = { kind: "main" } | { kind: "subagent"; agent: SubagentSnapshot; depth: number };

function rowKey(row: AgentDockRow | AgentViewTarget): string {
	return row.kind === "main" ? "main" : row.kind === "subagent" && "agent" in row ? row.agent.id : row.id;
}

function lifecycleActionSucceeded(data: unknown): boolean {
	return typeof data === "object" && data !== null && "ok" in data && data.ok === true;
}

/**
 * Compact rosters keep the active subagent visible by replacing a terminal
 * preview leaf. Ancestry comes from buildSubagentList's resolved pre-order
 * projection, so explicit and parent-tool-call fallback links behave alike.
 */
function keepActiveRowInSummary(
	rows: SubagentListRow[],
	summaryRows: SubagentListRow[],
	activeTarget: AgentViewTarget,
): SubagentListRow[] {
	if (activeTarget.kind === "main" || summaryRows.some(({ agent }) => agent.id === activeTarget.id)) {
		return summaryRows;
	}

	const rowById = new Map<string, SubagentListRow>();
	const parentIdById = new Map<string, string>();
	const ancestry: SubagentListRow[] = [];
	for (const row of rows) {
		rowById.set(row.agent.id, row);
		ancestry.length = row.depth;
		const parent = row.depth > 0 ? ancestry[row.depth - 1] : undefined;
		if (parent) parentIdById.set(row.agent.id, parent.agent.id);
		ancestry[row.depth] = row;
	}
	const activeRow = rowById.get(activeTarget.id);
	if (!activeRow) return summaryRows;

	const requiredIds = new Set<string>();
	let required: SubagentListRow | undefined = activeRow;
	while (required && !requiredIds.has(required.agent.id)) {
		requiredIds.add(required.agent.id);
		const parentId = parentIdById.get(required.agent.id);
		required = parentId ? rowById.get(parentId) : undefined;
	}

	const visibleIds = new Set(summaryRows.map(row => row.agent.id));
	for (const id of requiredIds) visibleIds.add(id);
	for (const { agent } of summaryRows.toReversed()) {
		if (visibleIds.size <= summaryRows.length) break;
		if (
			requiredIds.has(agent.id) ||
			isLiveSubagentStatus(agent.status) ||
			agent.status === "waiting" ||
			agent.status === "failed"
		) {
			continue;
		}
		const hasVisibleChild = rows.some(
			row => visibleIds.has(row.agent.id) && parentIdById.get(row.agent.id) === agent.id,
		);
		if (!hasVisibleChild) visibleIds.delete(agent.id);
	}

	return rows.filter(row => visibleIds.has(row.agent.id));
}
/** Poll cadence while a turn streams (covers frame-less parked/idle transitions). */
const STREAM_POLL_MS = 3000;

const AgentRow = memo(function AgentRow({
	row,
	selected,
	viewing,
	now,
	working,
	onSelect,
	onActivate,
	onLifecycleAction,
}: {
	row: AgentDockRow;
	selected: boolean;
	viewing: boolean;
	now: number;
	working: boolean;
	onSelect: (row: AgentDockRow) => void;
	onActivate: (agent: SubagentSnapshot | null) => void;
	onLifecycleAction: (action: SubagentLifecycleAction, agent: SubagentSnapshot) => void;
}) {
	const t = useT();
	const agent = row.kind === "subagent" ? row.agent : null;
	const depth = row.kind === "subagent" ? row.depth + 1 : 0;
	const meta = agent ? statusMeta(agent.status) : null;
	const live = agent ? isLiveSubagentStatus(agent.status) : false;
	const elapsed = agent ? subagentElapsedMs(agent, now) : null;
	const title = agent ? subagentPrimaryLabel(agent) : t("agentView.main");
	const progressLine = agent && live ? agent.progress?.description?.trim() : undefined;
	const description = agent?.description?.trim();
	const detail = [progressLine, description].find(line => line && line !== title);
	const model = agent?.progress?.resolvedModel;
	const usage =
		agent?.progress && (agent.progress.requests > 0 || agent.progress.tokens > 0 || agent.progress.cost > 0)
			? `${formatTokens(agent.progress.tokens)} ${t("sessionInfo.tokens")} · ${formatCost(agent.progress.cost)}`
			: undefined;
	const actionable = agent !== null && live && agent.kind !== "advisor";
	const revivable = agent?.status === "parked" && agent.kind !== "advisor";

	const stopActionKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		event.stopPropagation();
	};

	return (
		<div
			aria-current={viewing || undefined}
			aria-level={depth + 1}
			aria-selected={selected}
			onClick={() => onSelect(row)}
			onDoubleClick={() => onActivate(agent)}
			onFocus={(event: FocusEvent<HTMLDivElement>) => {
				if (event.currentTarget === event.target) onSelect(row);
			}}
			onKeyDown={event => {
				if (event.currentTarget !== event.target || event.key !== "Enter") return;
				event.preventDefault();
				onActivate(agent);
			}}
			role="treeitem"
			style={{ marginLeft: Math.min(depth, 7) * 14 }}
			tabIndex={0}
		>
			{depth > 0 && (
				<span className="pointer-events-none absolute top-0 -left-2.5 h-5 w-2.5 rounded-bl-md border-b border-l border-(--omp-border-muted)" />
			)}
			<div
				className={cx(
					"relative flex min-w-0 items-start gap-1.5 overflow-hidden rounded-lg border py-2 pr-2.5 pl-2 text-left transition-colors duration-150",
					selected
						? "border-(--omp-border-strong) bg-(--omp-bg-tertiary)"
						: "border-(--omp-border-muted) bg-transparent hover:bg-(--omp-bg-tertiary)",
					agent?.status === "cancelled" && "opacity-70",
				)}
			>
				<span
					aria-hidden
					className={cx(
						"absolute inset-y-2 left-0 w-0.5 rounded-full",
						viewing
							? "bg-(--omp-link)"
							: live
								? "bg-(--omp-status-subagents)"
								: agent?.status === "failed"
									? "bg-(--omp-error)"
									: "bg-(--omp-border)",
					)}
				/>
				<Bot className="mt-0.5 shrink-0 text-(--omp-status-subagents)" size={12} />
				<span className="min-w-0 flex-1">
					<span className="flex min-w-0 items-center gap-1.5">
						<span className="min-w-0 flex-1 truncate text-omp-sm font-medium text-(--omp-text)" title={title}>
							{title}
						</span>
						{viewing && <Badge variant="info">{t("agentView.viewing")}</Badge>}
						{meta && (
							<Badge dot={meta.live} pulse={meta.live} variant={meta.variant}>
								{t(meta.labelKey)}
							</Badge>
						)}
					</span>
					{agent && (
						<span className="mt-1 flex min-w-0 items-center gap-1 text-omp-xxs text-(--omp-dim)">
							<span className="shrink-0">{agent.agent}</span>
							<span className="shrink-0 tabular-nums">#{agent.index + 1}</span>
							{model && <span className="min-w-0 truncate">· {model}</span>}
							{usage && <span className="shrink-0 tabular-nums">· {usage}</span>}
							{elapsed !== null && (
								<span className="ml-auto shrink-0 tabular-nums">{formatElapsed(elapsed)}</span>
							)}
						</span>
					)}
					{detail && (
						<span className="mt-1 block truncate text-omp-xs text-(--omp-muted)" title={detail}>
							{detail}
						</span>
					)}
				</span>
				{actionable && (
					<button
						aria-label={t("agentHub.hub.abortAgent")}
						className="omp-pressable flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-(--omp-muted) hover:bg-(--omp-error-dim) hover:text-(--omp-error) disabled:opacity-40"
						disabled={working}
						onClick={event => {
							event.stopPropagation();
							if (agent) onLifecycleAction("abort", agent);
						}}
						onDoubleClick={event => event.stopPropagation()}
						onKeyDown={stopActionKey}
						title={t("agentHub.hub.abortAgent")}
						type="button"
					>
						<Square fill="currentColor" size={10} />
					</button>
				)}
				{revivable && (
					<button
						aria-label={t("agentHub.hub.reviveAgent")}
						className="omp-pressable flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-(--omp-muted) hover:bg-(--omp-selected-bg) hover:text-(--omp-accent) disabled:opacity-40"
						disabled={working}
						onClick={event => {
							event.stopPropagation();
							if (agent) onLifecycleAction("revive", agent);
						}}
						onDoubleClick={event => event.stopPropagation()}
						onKeyDown={stopActionKey}
						title={t("agentHub.hub.reviveAgent")}
						type="button"
					>
						<RefreshCw size={11} />
					</button>
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
						"flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-omp-xs transition-colors",
						view === option
							? "bg-(--omp-bg-tertiary) text-(--omp-text)" // surface-ok: aria-pressed selected-view fill
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

export function AgentsDockCard({ pollMs = STREAM_POLL_MS }: { pollMs?: number }) {
	const t = useT();
	const { capture, isActive } = useTabGuard();
	const routeReady = useActiveTabRouteReady();
	const { managed, focusedCard, focusCard, clearFocus } = useWorkspaceDockFocus();
	const focused = focusedCard === "agents";
	const showFull = !managed || focused;
	const subagents = useSubagentsStore(state => state.subagents);
	const toolCallOwners = useSubagentsStore(state => state.toolCallOwners);
	const messages = useMessagesStore(state => state.messages);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const activeTarget = useAgentViewStore(state => state.target);
	const activeKey = rowKey(activeTarget);
	const [selectedKey, setSelectedKey] = useState(activeKey);
	const [workingAgentId, setWorkingAgentId] = useState<string | null>(null);
	const [view, setView] = useState<PanelView>("list");
	const [now, setNow] = useState(() => Date.now());

	const agents = useMemo(() => [...subagents.values()].sort((a, b) => a.index - b.index), [subagents]);
	const hasRunning = agents.some(agent => isLiveSubagentStatus(agent.status));
	const runningCount = agents.filter(agent => isLiveSubagentStatus(agent.status)).length;

	useEffect(() => {
		if (!hasRunning) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasRunning]);

	useEffect(() => {
		if (!isStreaming) return;
		const timer = setInterval(() => {
			// A poll resolving after a tab/session switch must not paint this
			// tab's agents over the new foreground session — the guard is
			// re-checked inside the store AFTER the await, before the write.
			const origin = capture();
			if (!isActive(origin)) return;
			void useSubagentsStore.getState().refresh({ expect: () => isActive(origin) });
		}, pollMs);
		return () => clearInterval(timer);
	}, [capture, isActive, isStreaming, pollMs]);

	const rootToolCallIds = useMemo(() => new Set(extractTaskToolCallIds(messages)), [messages]);
	const rows = useMemo(
		() => buildSubagentList(agents, rootToolCallIds, toolCallOwners),
		[agents, rootToolCallIds, toolCallOwners],
	);
	const summary = useMemo(() => buildAgentDockSummary(rows), [rows]);
	const displayedRows = useMemo(
		() => (showFull ? rows : keepActiveRowInSummary(rows, summary.rows, activeTarget)),
		[activeTarget, rows, showFull, summary.rows],
	);
	const navigationRows = useMemo<AgentDockRow[]>(
		() => [
			{ kind: "main" },
			...displayedRows.map(({ agent, depth }) => ({ kind: "subagent" as const, agent, depth })),
		],
		[displayedRows],
	);

	useEffect(() => setSelectedKey(activeKey), [activeKey]);

	const selectAgentRow = useCallback((row: AgentDockRow) => {
		setSelectedKey(rowKey(row));
	}, []);

	const activateAgentView = useCallback(
		(agent: SubagentSnapshot | null) => {
			if (agent && (!routeReady || !acceptsActiveTabEvents())) return;
			setSelectedKey(agent?.id ?? "main");
			if (agent) void useAgentViewStore.getState().selectSubagent(agent);
			else useAgentViewStore.getState().selectMain();
			clearFocus();
		},
		[clearFocus, routeReady],
	);

	const runLifecycleAction = useCallback(
		async (action: SubagentLifecycleAction, agent: SubagentSnapshot) => {
			setWorkingAgentId(agent.id);
			const failureTitle = action === "abort" ? t("agentHub.hub.abortAgentFailed") : t("agentHub.hub.reviveFailed");
			try {
				const response =
					action === "abort"
						? await window.omp.rpc.abortSubagent(agent.id)
						: await window.omp.rpc.reviveSubagent(agent.id);
				if (!response.success) {
					toast({ variant: "error", title: failureTitle, message: response.error });
					return;
				}
				if (!lifecycleActionSucceeded(response.data)) {
					toast({ variant: "error", title: failureTitle, message: failureTitle });
					return;
				}
				await useSubagentsStore.getState().refresh();
			} catch (cause) {
				toast({ variant: "error", title: failureTitle, message: String(cause) });
			} finally {
				setWorkingAgentId(null);
			}
		},
		[t],
	);
	const changeView = useCallback(
		(next: PanelView) => {
			if (managed && next === "graph" && !focused) focusCard("agents");
			setView(next);
		},
		[focusCard, focused, managed],
	);

	useEffect(() => {
		if (focused && agents.length === 0) clearFocus();
	}, [agents.length, clearFocus, focused]);

	if (agents.length === 0) return null;

	return (
		<DockCard
			actions={<ViewToggle onChange={changeView} view={view} />}
			badge={
				<span className="shrink-0 text-omp-xs tabular-nums text-[var(--omp-dim)]">
					{runningCount > 0 ? `${runningCount}/${agents.length}` : agents.length}
				</span>
			}
			icon={Bot}
			id="agents"
			title={t("dock.agents")}
		>
			{view === "graph" ? (
				<div className="h-72 min-h-0">
					<SubagentDag
						onActivate={activateAgentView}
						onLifecycleAction={runLifecycleAction}
						viewedAgentId={activeTarget.kind === "subagent" ? activeTarget.id : null}
						working={workingAgentId !== null}
					/>
				</div>
			) : (
				<div className="space-y-1.5 px-2 py-1.5" role="tree">
					{navigationRows.map(row => (
						<AgentRow
							key={rowKey(row)}
							now={now}
							onActivate={activateAgentView}
							onLifecycleAction={runLifecycleAction}
							onSelect={selectAgentRow}
							row={row}
							selected={selectedKey === rowKey(row)}
							viewing={activeKey === rowKey(row)}
							working={workingAgentId !== null}
						/>
					))}
					{managed && !focused && rows.length - displayedRows.length > 0 && (
						<button
							className="omp-pressable flex w-full items-center justify-center rounded-md border border-dashed border-[var(--omp-border-muted)] px-2 py-1.5 text-omp-xs font-medium text-[var(--omp-link)] hover:border-[var(--omp-border-strong)]"
							onClick={() => focusCard("agents")}
							type="button"
						>
							{t("dock.viewAllAgents", {
								hidden: rows.length - displayedRows.length,
								total: summary.totalCount,
							})}
						</button>
					)}
				</div>
			)}
		</DockCard>
	);
}
