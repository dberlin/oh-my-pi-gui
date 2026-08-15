import { Bot, RefreshCw, Square } from "lucide-react";
import {
	type FocusEvent,
	type KeyboardEvent,
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { SubagentSnapshot } from "../../../../shared/rpc-types";
import { useActiveTabRouteReady } from "../../../hooks/use-active-tab-route";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { acceptsActiveTabEvents } from "../../../lib/tab-routing";
import { type AgentViewTarget, useAgentViewStore } from "../../../stores/agent-view";
import { useMessagesStore } from "../../../stores/messages";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { toast } from "../../../stores/toast";
import { Badge } from "../../common";
import {
	buildSubagentList,
	extractTaskToolCallIds,
	formatElapsed,
	isLiveSubagentStatus,
	statusMeta,
	subagentElapsedMs,
	subagentPrimaryLabel,
} from "./agent-tree-model";

type AgentTreeRow = { kind: "main" } | { kind: "subagent"; agent: SubagentSnapshot; depth: number };
type SubagentLifecycleAction = "abort" | "revive";

const STREAM_POLL_MS = 3000;

function rowKey(row: AgentTreeRow | AgentViewTarget): string {
	return row.kind === "main" ? "main" : row.kind === "subagent" && "agent" in row ? row.agent.id : row.id;
}

function lifecycleActionSucceeded(data: unknown): boolean {
	return typeof data === "object" && data !== null && "ok" in data && data.ok === true;
}

const AgentRow = memo(function AgentRow({
	row,
	selected,
	viewing,
	expanded,
	now,
	lifecycleDisabled,
	working,
	onActivate,
	onLifecycleAction,
	onKeyDown,
	onRowFocus,
	setElement,
	tabIndex,
}: {
	row: AgentTreeRow;
	selected: boolean;
	viewing: boolean;
	expanded: boolean | undefined;
	now: number;
	lifecycleDisabled: boolean;
	working: boolean;
	onActivate: (agent: SubagentSnapshot | null) => void;
	onLifecycleAction: (action: SubagentLifecycleAction, agent: SubagentSnapshot) => void;
	onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: AgentTreeRow) => void;
	onRowFocus: (row: AgentTreeRow) => void;
	setElement: (element: HTMLDivElement | null) => void;
	tabIndex: number;
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
	const actionable = agent !== null && live && agent.kind !== "advisor";
	const revivable = agent?.status === "parked" && agent.kind !== "advisor";

	return (
		<div
			aria-current={viewing || undefined}
			aria-expanded={expanded}
			aria-level={depth + 1}
			aria-selected={selected}
			onClick={() => onActivate(agent)}
			onFocus={(event: FocusEvent<HTMLDivElement>) => {
				if (event.currentTarget === event.target) onRowFocus(row);
			}}
			onKeyDown={event => onKeyDown(event, row)}
			ref={setElement}
			role="treeitem"
			style={{ marginLeft: Math.min(depth, 7) * 14 }}
			tabIndex={tabIndex}
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
						disabled={working || lifecycleDisabled}
						onClick={event => {
							event.stopPropagation();
							if (agent) onLifecycleAction("abort", agent);
						}}
						onDoubleClick={event => event.stopPropagation()}
						onKeyDown={event => event.stopPropagation()}
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
						disabled={working || lifecycleDisabled}
						onClick={event => {
							event.stopPropagation();
							if (agent) onLifecycleAction("revive", agent);
						}}
						onDoubleClick={event => event.stopPropagation()}
						onKeyDown={event => event.stopPropagation()}
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

export function AgentTree({ pollMs = STREAM_POLL_MS }: { pollMs?: number }) {
	const t = useT();
	const routeReady = useActiveTabRouteReady();
	const subagents = useSubagentsStore(state => state.subagents);
	const toolCallOwners = useSubagentsStore(state => state.toolCallOwners);
	const messages = useMessagesStore(state => state.messages);
	const isStreaming = useSessionStore(state => state.isStreaming);
	const sessionId = useSessionStore(state => state.sessionId);
	const sessionFile = useSessionStore(state => state.sessionFile);
	const activeTabId = useTabsStore(state => state.activeTabId);
	const activeTarget = useAgentViewStore(state => state.target);
	const activeKey = rowKey(activeTarget);
	const [selectedKey, setSelectedKey] = useState(activeKey);
	const [rovingKey, setRovingKey] = useState(activeKey);
	const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set());
	const [workingAgentId, setWorkingAgentId] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const rowElements = useRef(new Map<string, HTMLDivElement>());
	const focusedKey = useRef<string | null>(null);
	const treeHadFocus = useRef(false);
	const synchronizedActiveKey = useRef(activeKey);
	const boundaryActiveTabId = useRef(activeTabId);
	const boundarySessionId = useRef(sessionId);
	const boundarySessionFile = useRef(sessionFile);

	const agents = useMemo(() => [...subagents.values()].sort((left, right) => left.index - right.index), [subagents]);
	const hasRunning = agents.some(agent => isLiveSubagentStatus(agent.status));

	useEffect(() => {
		if (!hasRunning) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasRunning]);

	useEffect(() => {
		if (!isStreaming) return;
		const timer = setInterval(() => void useSubagentsStore.getState().refresh(), pollMs);
		return () => clearInterval(timer);
	}, [isStreaming, pollMs]);

	const rootToolCallIds = useMemo(() => new Set(extractTaskToolCallIds(messages)), [messages]);
	const listRows = useMemo(
		() => buildSubagentList(agents, rootToolCallIds, toolCallOwners),
		[agents, rootToolCallIds, toolCallOwners],
	);
	const navigationRows = useMemo<AgentTreeRow[]>(
		() => [{ kind: "main" }, ...listRows.map(({ agent, depth }) => ({ kind: "subagent" as const, agent, depth }))],
		[listRows],
	);
	const parentByKey = useMemo(() => {
		const parents = new Map<string, string>();
		const ancestry: string[] = [];
		for (const { agent, depth } of listRows) {
			const key = agent.id;
			parents.set(key, depth === 0 ? "main" : (ancestry[depth - 1] ?? "main"));
			ancestry.length = depth;
			ancestry[depth] = key;
		}
		return parents;
	}, [listRows]);
	const childrenByKey = useMemo(() => {
		const children = new Map<string, string[]>();
		for (const [key, parentKey] of parentByKey) {
			const childKeys = children.get(parentKey);
			if (childKeys) childKeys.push(key);
			else children.set(parentKey, [key]);
		}
		return children;
	}, [parentByKey]);
	const visibleRows = useMemo(
		() =>
			navigationRows.filter(row => {
				const key = rowKey(row);
				let parentKey = parentByKey.get(key);
				while (parentKey) {
					if (collapsedKeys.has(parentKey)) return false;
					parentKey = parentByKey.get(parentKey);
				}
				return true;
			}),
		[collapsedKeys, navigationRows, parentByKey],
	);
	const visibleKeys = useMemo(() => new Set(visibleRows.map(rowKey)), [visibleRows]);

	useEffect(() => {
		if (
			boundaryActiveTabId.current === activeTabId &&
			boundarySessionId.current === sessionId &&
			boundarySessionFile.current === sessionFile
		) {
			return;
		}
		boundaryActiveTabId.current = activeTabId;
		boundarySessionId.current = sessionId;
		boundarySessionFile.current = sessionFile;
		synchronizedActiveKey.current = activeKey;
		focusedKey.current = activeKey;
		setSelectedKey(activeKey);
		setRovingKey(activeKey);
		setCollapsedKeys(new Set());
	}, [activeKey, activeTabId, sessionFile, sessionId]);

	useEffect(() => {
		if (synchronizedActiveKey.current === activeKey) return;
		synchronizedActiveKey.current = activeKey;
		setSelectedKey(activeKey);
		if (navigationRows.some(row => rowKey(row) === activeKey)) setRovingKey(activeKey);
		setCollapsedKeys(current => {
			if (activeKey === "main") return current;
			const next = new Set(current);
			let parentKey = parentByKey.get(activeKey);
			let changed = false;
			while (parentKey) {
				changed = next.delete(parentKey) || changed;
				parentKey = parentByKey.get(parentKey);
			}
			return changed ? next : current;
		});
	}, [activeKey, navigationRows, parentByKey]);

	useLayoutEffect(() => {
		const focusedRowKey =
			treeHadFocus.current && focusedKey.current && visibleKeys.has(focusedKey.current)
				? focusedKey.current
				: undefined;
		const retainedKey =
			focusedRowKey ??
			(visibleKeys.has(rovingKey) ? rovingKey : undefined) ??
			(visibleKeys.has(selectedKey) ? selectedKey : undefined) ??
			(visibleKeys.has(activeKey) ? activeKey : "main");
		focusedKey.current = retainedKey;
		if (rovingKey !== retainedKey) setRovingKey(retainedKey);
		if (!visibleKeys.has(selectedKey)) setSelectedKey(retainedKey);
		if (!treeHadFocus.current) return;
		const element = rowElements.current.get(retainedKey);
		const activeElement = document.activeElement;
		if (element && activeElement !== element && !element.contains(activeElement)) element.focus();
	}, [activeKey, rovingKey, selectedKey, visibleKeys]);

	const selectAgentRow = useCallback((row: AgentTreeRow) => {
		const key = rowKey(row);
		setSelectedKey(key);
		setRovingKey(key);
	}, []);

	const activateAgentView = useCallback(
		(agent: SubagentSnapshot | null) => {
			if (agent && (!routeReady || !acceptsActiveTabEvents())) return;
			const key = agent?.id ?? "main";
			setSelectedKey(key);
			setRovingKey(key);
			if (agent) void useAgentViewStore.getState().selectSubagent(agent);
			else useAgentViewStore.getState().selectMain();
		},
		[routeReady],
	);

	const runLifecycleAction = useCallback(
		async (action: SubagentLifecycleAction, agent: SubagentSnapshot) => {
			if (!routeReady || !acceptsActiveTabEvents()) return;
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
		[routeReady, t],
	);

	const focusRow = useCallback((key: string) => {
		setRovingKey(key);
		rowElements.current.get(key)?.focus();
	}, []);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>, row: AgentTreeRow) => {
			if (event.currentTarget !== event.target) return;
			const key = rowKey(row);
			const index = visibleRows.findIndex(candidate => rowKey(candidate) === key);
			if (event.key === "Enter") {
				event.preventDefault();
				activateAgentView(row.kind === "subagent" ? row.agent : null);
				return;
			}
			if (event.key === " " || event.key === "Spacebar") {
				event.preventDefault();
				selectAgentRow(row);
				return;
			}
			if (event.key === "ArrowDown" && index < visibleRows.length - 1) {
				event.preventDefault();
				focusRow(rowKey(visibleRows[index + 1]!));
				return;
			}
			if (event.key === "ArrowUp" && index > 0) {
				event.preventDefault();
				focusRow(rowKey(visibleRows[index - 1]!));
				return;
			}
			if (event.key === "Home") {
				event.preventDefault();
				focusRow(rowKey(visibleRows[0]!));
				return;
			}
			if (event.key === "End") {
				event.preventDefault();
				focusRow(rowKey(visibleRows.at(-1)!));
				return;
			}
			const childKeys = childrenByKey.get(key);
			if (event.key === "ArrowRight" && childKeys?.length) {
				event.preventDefault();
				if (collapsedKeys.has(key)) {
					setCollapsedKeys(current => {
						const next = new Set(current);
						next.delete(key);
						return next;
					});
				} else {
					focusRow(childKeys[0]!);
				}
				return;
			}
			if (event.key === "ArrowLeft") {
				if (childKeys?.length && !collapsedKeys.has(key)) {
					event.preventDefault();
					setCollapsedKeys(current => new Set(current).add(key));
					return;
				}
				const parentKey = parentByKey.get(key);
				if (parentKey) {
					event.preventDefault();
					focusRow(parentKey);
				}
			}
		},
		[activateAgentView, childrenByKey, collapsedKeys, focusRow, parentByKey, selectAgentRow, visibleRows],
	);

	return (
		<div
			className="space-y-1.5 px-2 py-1.5"
			onBlur={event => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null)) treeHadFocus.current = false;
			}}
			role="tree"
		>
			{visibleRows.map(row => {
				const key = rowKey(row);
				const childKeys = childrenByKey.get(key);
				return (
					<AgentRow
						expanded={childKeys?.length ? !collapsedKeys.has(key) : undefined}
						lifecycleDisabled={!routeReady || !acceptsActiveTabEvents()}
						key={key}
						now={now}
						onActivate={activateAgentView}
						onKeyDown={handleKeyDown}
						onLifecycleAction={runLifecycleAction}
						onRowFocus={focusedRow => {
							const focusedRowKey = rowKey(focusedRow);
							treeHadFocus.current = true;
							focusedKey.current = focusedRowKey;
							selectAgentRow(focusedRow);
						}}
						row={row}
						selected={selectedKey === key}
						setElement={element => {
							if (element) rowElements.current.set(key, element);
							else rowElements.current.delete(key);
						}}
						tabIndex={rovingKey === key ? 0 : -1}
						viewing={activeKey === key}
						working={workingAgentId !== null}
					/>
				);
			})}
			{listRows.length === 0 && (
				<p className="px-2 py-1 text-omp-xs text-(--omp-dim)" role="status">
					{t("activitySidebar.agents.empty")}
				</p>
			)}
		</div>
	);
}
