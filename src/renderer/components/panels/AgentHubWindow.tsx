/**
 * Agent Hub window: TUI parity for the Agent Control Center (agent-dashboard.ts)
 * and the multi-agent hub table (agent-hub.ts).
 *
 * Definitions tab (control center): enable/disable, per-agent model override,
 * and prewalk override, persisted through the set_setting RPC
 * (task.disabledAgents / task.agentModelOverrides / task.agentPrewalk — the
 * same settings the TUI dashboard writes). The sidecar exposes no RPC for
 * discovered agent definitions (discoverAgents is filesystem-side), so the
 * list is the union of agents referenced by those settings and agents
 * observed in this session; browsing every definition and the create-agent
 * flow are a noted RPC gap, surfaced inline.
 *
 * Hub tab (multi-agent table): live view of the session's subagents from the
 * subagents store (get_subagents hydration + lifecycle frames) with status,
 * elapsed time, last update, and expandable transcripts. Revive targets
 * parked peer processes in the TUI hub and has no RPC equivalent; the only
 * abort RPC is session-scoped, so the tab offers an honest "abort turn"
 * action and notes per-agent abort as a gap.
 */

import { ChevronRight, RefreshCw, Square } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RpcResponse, SubagentSnapshot } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { toast } from "../../stores/toast";
import { Badge, Button, Input, Modal, Spinner, type TabItem, Tabs } from "../common";
import { formatElapsed, noteFirstSeen, STATUS_LABEL_KEY, STATUS_META } from "./subagent-graph";
import { SubagentTranscript } from "./SubagentTranscript";

export interface AgentHubWindowProps {
	open: boolean;
	onClose: () => void;
	initialTab?: AgentHubTabId;
}

export type AgentHubTabId = "definitions" | "hub";

// ---------------------------------------------------------------------------
// Definitions: settings-backed agent control center
// ---------------------------------------------------------------------------

interface AgentSettingsState {
	disabledAgents: string[];
	modelOverrides: Record<string, string>;
	prewalkOverrides: Record<string, string>;
}

const SETTINGS_PATHS = ["task.disabledAgents", "task.agentModelOverrides", "task.agentPrewalk"] as const;

const fetchAgentSettings = (): Promise<RpcResponse> => window.omp.rpc.getSettings([...SETTINGS_PATHS]);

function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every(entry => typeof entry === "string");
}

function pickAgentSettings(data: unknown): AgentSettingsState {
	const values = (data as { values?: Record<string, unknown> } | undefined)?.values ?? {};
	const disabled = values["task.disabledAgents"];
	const models = values["task.agentModelOverrides"];
	const prewalk = values["task.agentPrewalk"];
	return {
		disabledAgents: Array.isArray(disabled) ? disabled.filter((v): v is string => typeof v === "string") : [],
		modelOverrides: isStringRecord(models) ? models : {},
		prewalkOverrides: isStringRecord(prewalk) ? prewalk : {},
	};
}

interface AgentSettingsRpc {
	state: AgentSettingsState | null;
	error: string | null;
	loading: boolean;
	busy: boolean;
	refresh: () => void;
	/** Apply an optimistic settings write; the optimistic value is authoritative on success. */
	mutate: (optimistic: AgentSettingsState, action: () => Promise<RpcResponse>) => Promise<void>;
}

/**
 * Lazy settings loader: fires on the tab's first activation, then silently
 * revalidates on re-activation. Mirrors ModesPanel's useModeRpc, except
 * mutations keep the optimistic snapshot — set_setting echoes `{path, value}`,
 * not the composite state, so re-picking the response would clobber it.
 */
function useAgentSettings(open: boolean, active: boolean): AgentSettingsRpc {
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const [state, setState] = useState<AgentSettingsState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const attemptedRef = useRef(false);
	const stateRef = useRef<AgentSettingsState | null>(null);

	const setBoth = useCallback((next: AgentSettingsState | null) => {
		stateRef.current = next;
		setState(next);
	}, []);

	const load = useCallback(
		async (silent: boolean) => {
			if (!sidecarReady) {
				if (!silent) setError(t("agentHub.notConnected"));
				return;
			}
			if (!silent) {
				setLoading(true);
				setError(null);
			}
			try {
				const res = await fetchAgentSettings();
				if (res.success) {
					setBoth(pickAgentSettings(res.data));
					if (!silent) setError(null);
				} else if (!silent) {
					setError(res.error);
				}
			} catch (cause) {
				if (!silent) setError(String(cause));
			} finally {
				if (!silent) setLoading(false);
			}
		},
		[sidecarReady, t, setBoth],
	);

	useEffect(() => {
		if (!open || !active) return;
		if (attemptedRef.current) {
			void load(true);
		} else {
			attemptedRef.current = true;
			void load(false);
		}
	}, [open, active, load]);

	const refresh = useCallback(() => void load(false), [load]);

	const mutate = useCallback(
		async (optimistic: AgentSettingsState, action: () => Promise<RpcResponse>) => {
			const prev = stateRef.current;
			setBoth(optimistic);
			setBusy(true);
			try {
				const res = await action();
				if (!res.success) {
					setBoth(prev);
					toast({ variant: "error", title: t("agentHub.actionFailed"), message: res.error });
					void load(true);
				}
			} catch (cause) {
				setBoth(prev);
				toast({ variant: "error", title: t("agentHub.actionFailed"), message: String(cause) });
				void load(true);
			} finally {
				setBusy(false);
			}
		},
		[t, load, setBoth],
	);

	return { state, error, loading, busy, refresh, mutate };
}

/** Labeled switch row (same pattern as the modes window's Toggle). */
function Toggle({
	checked,
	onChange,
	label,
	disabled,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	label: string;
	disabled?: boolean;
}) {
	return (
		<label className="flex cursor-pointer items-center gap-2">
			<button
				aria-checked={checked}
				aria-label={label}
				className={`relative h-4.5 w-8 shrink-0 rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
					checked ? "bg-(--omp-accent)" : "border border-(--omp-border-muted) bg-(--omp-bg-tertiary)"
				}`}
				disabled={disabled}
				onClick={() => onChange(!checked)}
				role="switch"
				type="button"
			>
				<span
					className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-all duration-150 ${
						checked ? "left-4" : "left-0.5"
					}`}
				/>
			</button>
			<span className="text-[11px] text-(--omp-muted)">{label}</span>
		</label>
	);
}

interface DefinitionEntry {
	name: string;
	/** Source is only known for agents observed in this session (subagent frames). */
	source?: string;
}

const PrewalkState = {
	default: "default",
	on: "on",
	off: "off",
} as const;
type PrewalkState = (typeof PrewalkState)[keyof typeof PrewalkState];

/** Current prewalk override state for an agent (TUI dashboard cycle: agent default → on → off). */
function prewalkStateOf(overrides: Record<string, string>, name: string): PrewalkState {
	const value = overrides[name]?.trim().toLowerCase();
	if (value === "on") return PrewalkState.on;
	if (value === "off") return PrewalkState.off;
	return PrewalkState.default;
}

const PREWALK_VARIANT: Record<PrewalkState, "default" | "info" | "muted"> = {
	default: "default",
	on: "info",
	off: "muted",
};

/** Known definition sources; anything else renders raw (e.g. future extension sources). */
const KNOWN_SOURCES: Record<string, true> = { project: true, user: true, bundled: true };

function sourceLabel(t: (key: string) => string, source: string): string {
	return KNOWN_SOURCES[source] ? t(`agentHub.source.${source}`) : source;
}

const DefinitionRow = memo(function DefinitionRow({
	entry,
	state,
	busy,
	editing,
	onToggle,
	onBeginModelEdit,
	onCancelModelEdit,
	onSaveModel,
	onCyclePrewalk,
}: {
	entry: DefinitionEntry;
	state: AgentSettingsState;
	busy: boolean;
	editing: boolean;
	onToggle: (name: string, disabled: boolean) => void;
	onBeginModelEdit: (name: string) => void;
	onCancelModelEdit: () => void;
	onSaveModel: (name: string, raw: string) => void;
	onCyclePrewalk: (name: string) => void;
}) {
	const t = useT();
	const [draft, setDraft] = useState("");
	const disabled = state.disabledAgents.includes(entry.name);
	const override = state.modelOverrides[entry.name]?.trim() || undefined;
	const prewalk = prewalkStateOf(state.prewalkOverrides, entry.name);

	// Seed the draft when this row enters edit mode.
	useEffect(() => {
		if (editing) setDraft(override ?? "");
	}, [editing, override]);

	const submit = () => onSaveModel(entry.name, draft);

	return (
		<div className="rounded-lg border border-(--omp-border-muted) bg-(--omp-bg-secondary) px-3 py-2">
			<div className="flex items-center gap-2.5">
				<span
					className={cx(
						"min-w-0 flex-1 truncate font-mono text-[12px] font-medium",
						disabled ? "text-(--omp-dim) line-through" : "text-(--omp-text)",
					)}
				>
					{entry.name}
				</span>
				{entry.source && <Badge variant="muted">{sourceLabel(t, entry.source)}</Badge>}
				{disabled && <Badge variant="warning">{t("agentHub.defs.disabledBadge")}</Badge>}
				<Toggle
					checked={!disabled}
					disabled={busy}
					label={t("agentHub.defs.enabled")}
					onChange={enabled => onToggle(entry.name, !enabled)}
				/>
			</div>
			<div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5">
				<span className="flex items-center gap-1.5 text-[11px]">
					<span className="text-(--omp-dim)">{t("agentHub.defs.modelLabel")}</span>
					{editing ? (
						<span className="flex items-center gap-1">
							<Input
								autoFocus
								className="h-6 w-52 text-[11px]"
								mono
								onChange={event => setDraft(event.target.value)}
								onKeyDown={event => {
									// Enter submits; Escape is owned by the Modal (closes the window),
									// matching every other GUI dialog's edit-in-place behavior.
									if (event.key === "Enter") submit();
								}}
								placeholder={t("agentHub.defs.modelPlaceholder")}
								value={draft}
							/>
							<Button disabled={busy} onClick={submit} size="sm" variant="secondary">
								{t("common.save")}
							</Button>
							<Button disabled={busy} onClick={onCancelModelEdit} size="sm" variant="ghost">
								{t("common.cancel")}
							</Button>
						</span>
					) : (
						<>
							<span className={override ? "font-mono text-(--omp-text)" : "text-(--omp-dim)"}>
								{override ?? t("agentHub.defs.modelSession")}
							</span>
							<Button disabled={busy} onClick={() => onBeginModelEdit(entry.name)} size="sm" variant="ghost">
								{t("agentHub.defs.modelEdit")}
							</Button>
						</>
					)}
				</span>
				<span className="flex items-center gap-1.5 text-[11px]">
					<span className="text-(--omp-dim)">{t("agentHub.defs.prewalkLabel")}</span>
					<button
						className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
						disabled={busy}
						onClick={() => onCyclePrewalk(entry.name)}
						title={t("agentHub.defs.prewalkHint")}
						type="button"
					>
						<Badge variant={PREWALK_VARIANT[prewalk]}>{t(`agentHub.defs.prewalk.${prewalk}`)}</Badge>
					</button>
				</span>
			</div>
		</div>
	);
});

function DefinitionsTab({ rpc }: { rpc: AgentSettingsRpc }) {
	const t = useT();
	const subagents = useSubagentsStore(s => s.subagents);
	const [query, setQuery] = useState("");
	const [editingName, setEditingName] = useState<string | null>(null);

	// Union of agents referenced by settings and agents observed this session —
	// the reachable subset until a definitions RPC exists (noted gap below).
	const entries = useMemo(() => {
		const state = rpc.state;
		const byName = new Map<string, DefinitionEntry>();
		if (state) {
			for (const name of state.disabledAgents) byName.set(name, { name });
			for (const name of Object.keys(state.modelOverrides)) {
				if (!byName.has(name)) byName.set(name, { name });
			}
			for (const name of Object.keys(state.prewalkOverrides)) {
				if (!byName.has(name)) byName.set(name, { name });
			}
		}
		for (const sub of subagents.values()) {
			const existing = byName.get(sub.agent);
			if (existing) {
				if (!existing.source) existing.source = sub.agentSource;
			} else {
				byName.set(sub.agent, { name: sub.agent, source: sub.agentSource });
			}
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	}, [rpc.state, subagents]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter(entry => entry.name.toLowerCase().includes(q));
	}, [entries, query]);

	const toggleAgent = useCallback(
		(name: string, disabled: boolean) => {
			const state = rpc.state;
			if (!state) return;
			const next = new Set(state.disabledAgents);
			if (disabled) next.add(name);
			else next.delete(name);
			const disabledAgents = [...next].sort((a, b) => a.localeCompare(b));
			void rpc.mutate({ ...state, disabledAgents }, () =>
				window.omp.rpc.setSetting("task.disabledAgents", disabledAgents),
			);
		},
		[rpc],
	);

	const saveModel = useCallback(
		(name: string, raw: string) => {
			const state = rpc.state;
			if (!state) return;
			const value = raw.trim();
			const modelOverrides = { ...state.modelOverrides };
			if (value) modelOverrides[name] = value;
			else delete modelOverrides[name];
			setEditingName(null);
			void rpc.mutate({ ...state, modelOverrides }, () =>
				window.omp.rpc.setSetting("task.agentModelOverrides", modelOverrides),
			);
		},
		[rpc],
	);

	const cyclePrewalk = useCallback(
		(name: string) => {
			const state = rpc.state;
			if (!state) return;
			const current = prewalkStateOf(state.prewalkOverrides, name);
			const next = current === PrewalkState.default ? "on" : current === PrewalkState.on ? "off" : undefined;
			const prewalkOverrides = { ...state.prewalkOverrides };
			if (next) prewalkOverrides[name] = next;
			else delete prewalkOverrides[name];
			void rpc.mutate({ ...state, prewalkOverrides }, () =>
				window.omp.rpc.setSetting("task.agentPrewalk", prewalkOverrides),
			);
		},
		[rpc],
	);

	const loadedState = rpc.state;

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
			<div className="flex shrink-0 items-center gap-2">
				<Input
					className="h-7 flex-1 text-[11.5px]"
					onChange={event => setQuery(event.target.value)}
					placeholder={t("agentHub.defs.searchPlaceholder")}
					value={query}
				/>
				<Button
					icon={<RefreshCw size={12} />}
					loading={rpc.loading}
					onClick={rpc.refresh}
					size="sm"
					variant="ghost"
				>
					{t("agentHub.refresh")}
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{!loadedState ? (
					rpc.loading ? (
						<div className="m-auto">
							<Spinner label={t("common.loading")} />
						</div>
					) : (
						<div className="m-auto flex max-w-md flex-col items-center gap-2 rounded-lg border border-(--omp-border-muted) px-4 py-6 text-center">
							<span className="text-[12px] font-medium text-(--omp-error)">{t("agentHub.loadFailed")}</span>
							<span className="text-[11px] break-all text-(--omp-dim)">{rpc.error}</span>
							<Button icon={<RefreshCw size={12} />} onClick={rpc.refresh} size="sm" variant="secondary">
								{t("agentHub.retry")}
							</Button>
						</div>
					)
				) : (
					<div className="flex flex-col gap-2">
						<p className="rounded-md border border-(--omp-border-muted) bg-(--omp-bg-tertiary) px-3 py-2 text-[10.5px] leading-relaxed text-(--omp-dim)">
							{t("agentHub.defs.gapNote")}
						</p>
						{filtered.length === 0 ? (
							<div className="px-3 py-8 text-center text-[11px] leading-relaxed text-(--omp-dim)">
								{t("agentHub.defs.empty")}
								<br />
								{t("agentHub.defs.emptyHint")}
							</div>
						) : (
							filtered.map(entry => (
								<DefinitionRow
									busy={rpc.busy}
									editing={editingName === entry.name}
									entry={entry}
									key={entry.name}
									onBeginModelEdit={setEditingName}
									onCancelModelEdit={() => setEditingName(null)}
									onCyclePrewalk={cyclePrewalk}
									onSaveModel={saveModel}
									onToggle={toggleAgent}
									state={loadedState}
								/>
							))
						)}
					</div>
				)}
			</div>
			<div className="shrink-0 border-t border-(--omp-border-muted) pt-2 text-[10.5px] text-(--omp-dim)">
				{t("agentHub.defs.footerNote")}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Hub: live multi-agent table
// ---------------------------------------------------------------------------

/** TUI hub ordering (running first); recency breaks ties. */
const HUB_STATUS_ORDER: Record<SubagentSnapshot["status"], number> = {
	started: 0,
	failed: 1,
	cancelled: 2,
	completed: 3,
};

const HubRow = memo(function HubRow({
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
	const elapsed = agent.status === "started" ? now - noteFirstSeen(agent.id) : null;
	const subtitle = agent.task ?? agent.description ?? agent.assignment;
	const lastUpdate = agent.progress?.description ?? agent.lastUpdate;

	return (
		<div className="rounded-lg border border-(--omp-border-muted) bg-(--omp-bg-secondary)">
			<button
				className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
				onClick={onToggle}
				type="button"
			>
				<ChevronRight
					className={cx("shrink-0 text-(--omp-dim) transition-transform", expanded && "rotate-90")}
					size={12}
				/>
				<Badge dot pulse={meta.live} variant={meta.variant}>
					{t(STATUS_LABEL_KEY[agent.status])}
				</Badge>
				<span className="shrink-0 font-mono text-[10.5px] text-(--omp-dim) tabular-nums">#{agent.index}</span>
				<span className="min-w-0 truncate text-[12px] font-medium text-(--omp-text)">{agent.agent}</span>
				<Badge variant="muted">{sourceLabel(t, agent.agentSource)}</Badge>
				<span className="ml-auto shrink-0 text-[10.5px] text-(--omp-dim) tabular-nums">
					{elapsed !== null ? formatElapsed(elapsed) : "—"}
				</span>
			</button>
			{(subtitle || lastUpdate) && (
				<div className="flex items-center gap-3 px-3 pb-2 pl-9 text-[10.5px]">
					{subtitle && <span className="min-w-0 flex-1 truncate text-(--omp-muted)">{subtitle}</span>}
					{lastUpdate && (
						<span className="ml-auto min-w-0 flex-1 truncate text-right text-(--omp-dim)">{lastUpdate}</span>
					)}
				</div>
			)}
			{expanded && (
				<div className="border-t border-(--omp-border-muted) px-3 py-2">
					<SubagentTranscript agent={agent} />
				</div>
			)}
		</div>
	);
});

function HubTab() {
	const t = useT();
	const subagents = useSubagentsStore(s => s.subagents);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [now, setNow] = useState(() => Date.now());
	const [aborting, setAborting] = useState(false);

	const sorted = useMemo(
		() =>
			[...subagents.values()].sort(
				(a, b) => HUB_STATUS_ORDER[a.status] - HUB_STATUS_ORDER[b.status] || b.index - a.index,
			),
		[subagents],
	);

	const counts = useMemo(() => {
		const result: Record<SubagentSnapshot["status"], number> = { started: 0, completed: 0, failed: 0, cancelled: 0 };
		for (const agent of subagents.values()) result[agent.status] += 1;
		return result;
	}, [subagents]);

	const hasRunning = counts.started > 0;

	useEffect(() => {
		if (!hasRunning) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasRunning]);

	const toggle = useCallback((id: string) => {
		setExpanded(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	// Session-scoped abort: the only abort the RPC surface exposes — it stops
	// the active turn (subagents included). Per-agent abort is a noted gap.
	const abortTurn = useCallback(async () => {
		setAborting(true);
		try {
			const res = await window.omp.rpc.abort();
			if (!res.success) {
				toast({ variant: "error", title: t("agentHub.hub.abortFailed"), message: res.error });
			}
		} catch (cause) {
			toast({ variant: "error", title: t("agentHub.hub.abortFailed"), message: String(cause) });
		} finally {
			setAborting(false);
		}
	}, [t]);

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
			<div className="flex shrink-0 flex-wrap items-center gap-2">
				{(["started", "failed", "cancelled", "completed"] as const).map(status =>
					counts[status] > 0 ? (
						<Badge dot key={status} pulse={STATUS_META[status].live} variant={STATUS_META[status].variant}>
							{t(STATUS_LABEL_KEY[status])} {counts[status]}
						</Badge>
					) : null,
				)}
				<span className="ml-auto">
					<Button
						disabled={!hasRunning}
						icon={<Square size={11} />}
						loading={aborting}
						onClick={() => void abortTurn()}
						size="sm"
						variant="danger"
					>
						{t("agentHub.hub.abortTurn")}
					</Button>
				</span>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
				{sorted.length === 0 ? (
					<div className="m-auto px-3 py-8 text-center text-[11px] leading-relaxed text-(--omp-dim)">
						{t("subagent.empty")}
						<br />
						{t("subagent.emptyHint")}
					</div>
				) : (
					sorted.map(agent => (
						<HubRow
							agent={agent}
							expanded={expanded.has(agent.id)}
							key={agent.id}
							now={now}
							onToggle={() => toggle(agent.id)}
						/>
					))
				)}
			</div>
			<div className="shrink-0 border-t border-(--omp-border-muted) pt-2 text-[10.5px] leading-relaxed text-(--omp-dim)">
				{t("agentHub.hub.gapNote")}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export function AgentHubWindow({ open, onClose, initialTab = "definitions" }: AgentHubWindowProps) {
	const t = useT();
	const [tab, setTab] = useState<AgentHubTabId>(initialTab);
	const settings = useAgentSettings(open, tab === "definitions");
	const runningCount = useSubagentsStore(s => {
		let count = 0;
		for (const agent of s.subagents.values()) if (agent.status === "started") count += 1;
		return count;
	});

	// Reopening starts on the requested tab.
	useEffect(() => {
		if (open) setTab(initialTab);
	}, [open, initialTab]);

	const tabs: TabItem[] = useMemo(
		() => [
			{ id: "definitions", label: t("agentHub.tabs.definitions") },
			{ id: "hub", label: t("agentHub.tabs.hub"), badge: runningCount > 0 ? runningCount : undefined },
		],
		[t, runningCount],
	);

	const handleTabChange = useCallback((id: string) => {
		setTab(id as AgentHubTabId);
	}, []);

	return (
		<Modal onClose={onClose} open={open} size="lg" title={t("agentHub.title")} bodyClassName="p-0">
			<div className="flex h-[70vh] min-h-0 flex-col">
				<Tabs
					activeId={tab}
					ariaLabel={t("agentHub.title")}
					className="shrink-0 px-4"
					onChange={handleTabChange}
					tabs={tabs}
				/>
				{tab === "definitions" && <DefinitionsTab rpc={settings} />}
				{tab === "hub" && <HubTab />}
			</div>
		</Modal>
	);
}
