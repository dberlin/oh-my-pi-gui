/**
 * Modes window: Vibe / Goal / Loop session modes, backed by the mode RPCs
 * (get/set_vibe_mode, get/set_goal, get/set_loop_mode) plus live sidecar
 * events (`goal_updated` → silent re-fetch, `loop_mode_update` → applied in
 * place).
 *
 * Each tab lazy-loads on first view, then silently revalidates whenever it is
 * re-activated. Mutations are optimistic: applied immediately; on failure an
 * error toast fires, the optimistic state is reverted, and the canonical
 * state is silently re-fetched.
 *
 * Parent wiring (parent-owned files): mount once beside the other windows and
 * drive it from a ui-store flag + command-registry entry; deep-link a tab via:
 *   <ModesPanel open={modesOpen} onClose={closeModes} initialTab="goal" />
 */

import { RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AgentSessionEvent,
	RpcGoalState,
	RpcLoopModeState,
	RpcResponse,
	RpcVibeModeState,
} from "../../../shared/rpc-types";
import { formatDuration, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { loopLimitText, normalizeLoopUpdate, parseLoopLimit } from "../../lib/loop-mode";
import { acceptsActiveTabEvents } from "../../lib/tab-routing";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import {
	Badge,
	type BadgeVariant,
	Button,
	Input,
	Modal,
	ProgressBar,
	Spinner,
	type TabItem,
	Tabs,
	TextArea,
} from "../common";

export interface ModesPanelProps {
	open: boolean;
	onClose: () => void;
	/** Deep-link a specific tab on open (defaults to "vibe"). */
	initialTab?: ModesTabId;
}

export type ModesTabId = "vibe" | "goal" | "loop";

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface ModeRpc<T> {
	state: T | null;
	error: string | null;
	loading: boolean;
	/** A mutation is in flight (inputs disable while it settles). */
	busy: boolean;
	/** Loud re-fetch: spinner while loading, inline error on failure. */
	refresh: () => void;
	/** Silent re-fetch: updates state on success, leaves the UI alone on failure. */
	sync: () => void;
	/** Apply an event payload directly. */
	apply: (next: T) => void;
	/** Optimistic mutation: apply `optimistic`, run `action`, toast + revert + re-sync on failure. */
	mutate: (optimistic: T, action: () => Promise<RpcResponse>) => Promise<void>;
}

const fetchVibeMode = (): Promise<RpcResponse> => window.omp.rpc.getVibeMode();
const pickVibeMode = (data: unknown): RpcVibeModeState => (data as RpcVibeModeState | undefined) ?? { enabled: false };
const fetchGoal = (): Promise<RpcResponse> => window.omp.rpc.getGoal();
const pickGoal = (data: unknown): RpcGoalState =>
	(data as RpcGoalState | undefined) ?? { enabled: false, status: "none" };
const fetchLoopMode = (): Promise<RpcResponse> => window.omp.rpc.getLoopMode();
const pickLoopMode = (data: unknown): RpcLoopModeState =>
	(data as RpcLoopModeState | undefined) ?? { enabled: false, state: "off" };

/**
 * Lazy per-tab mode loader: fires on the tab's first activation, then silently
 * revalidates on re-activation. Errors surface inline with a Retry button.
 */
function useModeRpc<T>(
	open: boolean,
	active: boolean,
	fetcher: () => Promise<RpcResponse>,
	pick: (data: unknown) => T,
): ModeRpc<T> {
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const [state, setState] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const attemptedRef = useRef(false);
	const stateRef = useRef<T | null>(null);

	/** Keep the ref in lockstep so mutations can snapshot for revert. */
	const setBoth = useCallback((next: T | null) => {
		stateRef.current = next;
		setState(next);
	}, []);

	const load = useCallback(
		async (silent: boolean) => {
			if (!sidecarReady) {
				if (!silent) setError(t("modesPanel.notConnected"));
				return;
			}
			if (!silent) {
				setLoading(true);
				setError(null);
			}
			try {
				const res = await fetcher();
				if (res.success) {
					setBoth(pick(res.data));
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
		[sidecarReady, fetcher, pick, t, setBoth],
	);

	// First activation loads loudly; later re-activations silently revalidate.
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
	const sync = useCallback(() => void load(true), [load]);
	const apply = useCallback((next: T) => setBoth(next), [setBoth]);

	const mutate = useCallback(
		async (optimistic: T, action: () => Promise<RpcResponse>) => {
			const prev = stateRef.current;
			setBoth(optimistic);
			setBusy(true);
			try {
				const res = await action();
				if (res.success) {
					if (res.data != null) setBoth(pick(res.data));
				} else {
					setBoth(prev);
					toast({ variant: "error", title: t("modesPanel.actionFailed"), message: res.error });
					void load(true);
				}
			} catch (cause) {
				setBoth(prev);
				toast({ variant: "error", title: t("modesPanel.actionFailed"), message: String(cause) });
				void load(true);
			} finally {
				setBusy(false);
			}
		},
		[pick, t, load, setBoth],
	);

	return { state, error, loading, busy, refresh, sync, apply, mutate };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Loop run-state → badge color (running pulses, off dims). */
export const LOOP_STATE_VARIANT: Record<RpcLoopModeState["state"], BadgeVariant> = {
	off: "muted",
	waiting: "info",
	running: "success",
	paused: "warning",
};

const GOAL_STATUS_KEY: Record<string, string> = {
	active: "modesPanel.goal.statusValue.active",
	paused: "modesPanel.goal.statusValue.paused",
	"budget-limited": "modesPanel.goal.statusValue.budgetLimited",
	complete: "modesPanel.goal.statusValue.complete",
	dropped: "modesPanel.goal.statusValue.dropped",
};

/** Goal status → badge color (unknown statuses fall back to muted + raw text). */
export function goalStatusVariant(status: string): BadgeVariant {
	switch (status) {
		case "active":
			return "success";
		case "paused":
			return "warning";
		case "budget-limited":
			return "error";
		case "complete":
			return "info";
		default:
			return "muted";
	}
}

function goalStatusLabel(t: (key: string) => string, status: string): string {
	const key = GOAL_STATUS_KEY[status];
	return key ? t(key) : status;
}

// ---------------------------------------------------------------------------
// Shared frame: refresh toolbar + loading/error states
// ---------------------------------------------------------------------------

interface ModeFrameProps {
	loading: boolean;
	loaded: boolean;
	error: string | null;
	onRefresh: () => void;
	children: ReactNode;
}

function ModeFrame({ loading, loaded, error, onRefresh, children }: ModeFrameProps) {
	const t = useT();

	let body: ReactNode = null;
	if (!loaded) {
		if (loading) {
			body = (
				<div className="m-auto">
					<Spinner label={t("common.loading")} />
				</div>
			);
		} else if (error) {
			body = (
				<div className="m-auto flex max-w-md flex-col items-center gap-2 rounded-lg border border-(--omp-border-muted) px-4 py-6 text-center">
					<span className="text-omp-md font-medium text-(--omp-error)">{t("modesPanel.loadFailed")}</span>
					<span className="text-omp-sm break-all text-(--omp-dim)">{error}</span>
					<Button icon={<RefreshCw size={12} />} onClick={onRefresh} size="sm" variant="secondary">
						{t("modesPanel.retry")}
					</Button>
				</div>
			);
		}
	} else {
		body = children;
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
			<div className="flex shrink-0 items-center justify-end">
				<Button icon={<RefreshCw size={12} />} loading={loading} onClick={onRefresh} size="sm" variant="ghost">
					{t("modesPanel.refresh")}
				</Button>
			</div>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{body}</div>
		</div>
	);
}

/** Labeled switch row (same pattern as the settings window's Toggle). */
function Toggle({
	checked,
	onChange,
	label,
	description,
	disabled,
}: {
	checked: boolean;
	onChange: (value: boolean) => void;
	label: string;
	description?: string;
	disabled?: boolean;
}) {
	return (
		<label className="flex cursor-pointer items-start justify-between gap-4 rounded-md px-2 py-2 transition-colors hover:bg-(--omp-bg-tertiary)">
			<span className="min-w-0">
				<span className="block text-xs font-medium text-(--omp-text)">{label}</span>
				{description && (
					<span className="mt-0.5 block text-omp-sm leading-snug text-(--omp-muted)">{description}</span>
				)}
			</span>
			<button
				aria-checked={checked}
				className={`relative mt-0.5 h-4.5 w-8 shrink-0 rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${
					checked ? "bg-(--omp-accent)" : "border border-(--omp-border-muted)"
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
		</label>
	);
}

function SectionLabel({ children }: { children: ReactNode }) {
	return (
		<span className="block text-omp-xs font-semibold tracking-wider text-(--omp-muted) uppercase">{children}</span>
	);
}

// ---------------------------------------------------------------------------
// Vibe tab
// ---------------------------------------------------------------------------

function VibeTab({ rpc }: { rpc: ModeRpc<RpcVibeModeState> }) {
	const t = useT();
	const state = rpc.state;
	return (
		<ModeFrame error={rpc.error} loaded={state !== null} loading={rpc.loading} onRefresh={rpc.refresh}>
			{state && (
				<div className="flex flex-col gap-4">
					<p className="text-omp-sm leading-relaxed text-(--omp-muted)">{t("modesPanel.vibe.desc")}</p>
					<div className="rounded-lg border border-(--omp-border-muted) bg-transparent px-3 py-1.5">
						<Toggle
							checked={state.enabled}
							description={t("modesPanel.vibe.toggleDesc")}
							disabled={rpc.busy}
							label={t("modesPanel.vibe.toggleLabel")}
							onChange={next =>
								// set_vibe_mode emits no event — mirror the settled value into
								// the session store so the footer badge tracks it live.
								void rpc.mutate({ enabled: next }, async () => {
									const res = await window.omp.rpc.setVibeMode(next);
									if (res.success) useSessionStore.setState({ vibeModeEnabled: next });
									return res;
								})
							}
						/>
					</div>
					{!state.enabled && typeof state.killedWorkers === "number" && state.killedWorkers > 0 && (
						<div className="rounded-md border border-[color-mix(in_srgb,var(--omp-warning)_35%,transparent)] bg-transparent px-3 py-2 text-omp-sm text-(--omp-warning)">
							{t("modesPanel.vibe.killedWorkers", { count: state.killedWorkers })}
						</div>
					)}
				</div>
			)}
		</ModeFrame>
	);
}

// ---------------------------------------------------------------------------
// Goal tab
// ---------------------------------------------------------------------------

function GoalEnabledView({ rpc, state }: { rpc: ModeRpc<RpcGoalState>; state: RpcGoalState }) {
	const t = useT();
	const [objectiveDraft, setObjectiveDraft] = useState(state.objective ?? "");

	// A fresh objective from the sidecar (event re-fetch) replaces the draft.
	const loadedObjective = state.objective ?? "";
	useEffect(() => {
		setObjectiveDraft(loadedObjective);
	}, [loadedObjective]);

	const trimmedObjective = objectiveDraft.trim();
	const objectiveDirty = trimmedObjective !== "" && trimmedObjective !== loadedObjective;

	const tokensUsed = state.tokensUsed ?? 0;
	const timeUsedSeconds = state.timeUsedSeconds ?? 0;
	const tokenBudget = typeof state.tokenBudget === "number" && state.tokenBudget > 0 ? state.tokenBudget : null;

	const saveObjective = () => {
		if (!objectiveDirty) return;
		void rpc.mutate({ ...state, objective: trimmedObjective }, () =>
			window.omp.rpc.setGoal({ objective: trimmedObjective }),
		);
	};

	const runAction = (action: "pause" | "resume" | "drop") => {
		const optimistic: RpcGoalState =
			action === "drop"
				? { enabled: false, status: "dropped" }
				: { ...state, status: action === "pause" ? "paused" : "active" };
		void rpc.mutate(optimistic, () => window.omp.rpc.setGoal({ action }));
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<SectionLabel>{t("modesPanel.goal.statusLabel")}</SectionLabel>
				<Badge dot pulse={state.status === "active"} variant={goalStatusVariant(state.status)}>
					{goalStatusLabel(t, state.status)}
				</Badge>
				{state.mode && <Badge variant="muted">{state.mode}</Badge>}
			</div>

			<div className="flex flex-col gap-1.5">
				<TextArea
					autoGrow
					label={t("modesPanel.goal.objectiveLabel")}
					onChange={event => setObjectiveDraft(event.target.value)}
					placeholder={t("modesPanel.goal.objectivePlaceholder")}
					rows={3}
					value={objectiveDraft}
				/>
				<div className="flex justify-end">
					<Button disabled={!objectiveDirty || rpc.busy} onClick={saveObjective} size="sm" variant="secondary">
						{t("modesPanel.goal.saveObjective")}
					</Button>
				</div>
			</div>

			<div className="flex flex-col gap-2 rounded-lg border border-(--omp-border-muted) bg-transparent px-3 py-2.5">
				{tokenBudget !== null ? (
					<ProgressBar
						label={t("modesPanel.goal.budget")}
						value={tokensUsed / tokenBudget}
						valueText={`${formatTokens(tokensUsed)} / ${formatTokens(tokenBudget)}`}
					/>
				) : (
					<span className="text-omp-sm text-(--omp-dim)">{t("modesPanel.goal.noBudget")}</span>
				)}
				<div className="flex flex-wrap gap-x-4 gap-y-1 text-omp-sm text-(--omp-muted)">
					<span>
						{t("modesPanel.goal.tokensUsed")}:{" "}
						<span className="tabular-nums text-(--omp-text)">{formatTokens(tokensUsed)}</span>
					</span>
					<span>
						{t("modesPanel.goal.timeUsed")}:{" "}
						<span className="tabular-nums text-(--omp-text)">{formatDuration(timeUsedSeconds * 1000)}</span>
					</span>
				</div>
			</div>

			<div className="flex items-center gap-2">
				{state.status === "paused" ? (
					<Button disabled={rpc.busy} onClick={() => runAction("resume")} size="sm" variant="primary">
						{t("modesPanel.goal.resume")}
					</Button>
				) : (
					<Button
						disabled={rpc.busy || state.status !== "active"}
						onClick={() => runAction("pause")}
						size="sm"
						variant="secondary"
					>
						{t("modesPanel.goal.pause")}
					</Button>
				)}
				<Button disabled={rpc.busy} onClick={() => runAction("drop")} size="sm" variant="danger">
					{t("modesPanel.goal.drop")}
				</Button>
			</div>
		</div>
	);
}

function GoalStartForm({ rpc }: { rpc: ModeRpc<RpcGoalState> }) {
	const t = useT();
	const [objective, setObjective] = useState("");
	const [budget, setBudget] = useState("");

	const trimmed = objective.trim();
	const parsedBudget = Number(budget);
	const tokenBudget =
		budget.trim() !== "" && Number.isFinite(parsedBudget) && parsedBudget > 0 ? Math.floor(parsedBudget) : null;

	const start = () => {
		if (!trimmed) return;
		void rpc.mutate(
			{ enabled: true, status: "active", objective: trimmed, tokenBudget, tokensUsed: 0, timeUsedSeconds: 0 },
			() =>
				window.omp.rpc.setGoal(tokenBudget === null ? { objective: trimmed } : { objective: trimmed, tokenBudget }),
		);
	};

	return (
		<div className="flex flex-col gap-3">
			<SectionLabel>{t("modesPanel.goal.startFormTitle")}</SectionLabel>
			<TextArea
				autoGrow
				label={t("modesPanel.goal.objectiveLabel")}
				onChange={event => setObjective(event.target.value)}
				placeholder={t("modesPanel.goal.objectivePlaceholder")}
				rows={3}
				value={objective}
			/>
			<Input
				hint={t("modesPanel.goal.budgetHint")}
				label={t("modesPanel.goal.budgetLabel")}
				min={0}
				onChange={event => setBudget(event.target.value)}
				placeholder={t("modesPanel.goal.budgetPlaceholder")}
				step={1000}
				type="number"
				value={budget}
			/>
			<div>
				<Button disabled={!trimmed || rpc.busy} loading={rpc.busy} onClick={start} size="sm" variant="primary">
					{t("modesPanel.goal.start")}
				</Button>
			</div>
		</div>
	);
}

function GoalTab({ rpc }: { rpc: ModeRpc<RpcGoalState> }) {
	const t = useT();
	const state = rpc.state;
	return (
		<ModeFrame error={rpc.error} loaded={state !== null} loading={rpc.loading} onRefresh={rpc.refresh}>
			{state && (
				<div className="flex flex-col gap-4">
					<p className="text-omp-sm leading-relaxed text-(--omp-muted)">{t("modesPanel.goal.desc")}</p>
					{state.enabled ? <GoalEnabledView rpc={rpc} state={state} /> : <GoalStartForm rpc={rpc} />}
				</div>
			)}
		</ModeFrame>
	);
}

// ---------------------------------------------------------------------------
// Loop tab
// ---------------------------------------------------------------------------

function LoopTab({ rpc }: { rpc: ModeRpc<RpcLoopModeState> }) {
	const t = useT();
	const state = rpc.state;
	const [argsDraft, setArgsDraft] = useState("");

	const toggle = (next: boolean) => {
		if (!state) return;
		const args = argsDraft.trim();
		void rpc.mutate({ ...state, enabled: next, state: next ? "waiting" : "off" }, () =>
			window.omp.rpc.setLoopMode(next, args === "" ? undefined : args),
		);
	};

	const limit = state ? parseLoopLimit(state.limit) : null;

	return (
		<ModeFrame error={rpc.error} loaded={state !== null} loading={rpc.loading} onRefresh={rpc.refresh}>
			{state && (
				<div className="flex flex-col gap-4">
					<p className="text-omp-sm leading-relaxed text-(--omp-muted)">{t("modesPanel.loop.desc")}</p>
					<div className="rounded-lg border border-(--omp-border-muted) bg-transparent px-3 py-1.5">
						<Toggle
							checked={state.enabled}
							description={t("modesPanel.loop.toggleDesc")}
							disabled={rpc.busy}
							label={t("modesPanel.loop.toggleLabel")}
							onChange={toggle}
						/>
					</div>

					<div className="flex flex-wrap items-center gap-2">
						<SectionLabel>{t("modesPanel.loop.statusLabel")}</SectionLabel>
						<Badge dot pulse={state.state === "running"} variant={LOOP_STATE_VARIANT[state.state]}>
							{t(`modesPanel.loop.state.${state.state}`)}
						</Badge>
					</div>

					<div className="flex flex-col gap-1.5">
						<SectionLabel>{t("modesPanel.loop.promptLabel")}</SectionLabel>
						{state.prompt ? (
							<p className="rounded-md border border-(--omp-border-muted) bg-transparent px-3 py-2 font-mono text-omp-sm break-words whitespace-pre-wrap text-(--omp-text)">
								{state.prompt}
							</p>
						) : (
							<p className="text-omp-sm text-(--omp-dim)">{t("modesPanel.loop.noPrompt")}</p>
						)}
					</div>

					<div className="flex flex-wrap items-center gap-2 text-omp-sm text-(--omp-muted)">
						<SectionLabel>{t("modesPanel.loop.limitLabel")}</SectionLabel>
						<span className="tabular-nums text-(--omp-text)">
							{limit ? loopLimitText(t, limit) : t("modesPanel.loop.noLimit")}
						</span>
					</div>

					<Input
						hint={t("modesPanel.loop.argsHint")}
						label={t("modesPanel.loop.argsLabel")}
						onChange={event => setArgsDraft(event.target.value)}
						placeholder={t("modesPanel.loop.argsPlaceholder")}
						value={argsDraft}
					/>
				</div>
			)}
		</ModeFrame>
	);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export function ModesPanel({ open, onClose, initialTab = "vibe" }: ModesPanelProps) {
	const t = useT();
	const [tab, setTab] = useState<ModesTabId>(initialTab);

	const vibe = useModeRpc(open, tab === "vibe", fetchVibeMode, pickVibeMode);
	const goal = useModeRpc(open, tab === "goal", fetchGoal, pickGoal);
	const loop = useModeRpc(open, tab === "loop", fetchLoopMode, pickLoopMode);

	// Reopening starts on the requested tab.
	useEffect(() => {
		if (open) setTab(initialTab);
	}, [open, initialTab]);

	// Live updates while open: goal changes re-fetch silently (the event payload
	// shape is loose), loop frames apply in place.
	const syncGoal = goal.sync;
	const applyLoop = loop.apply;
	useEffect(() => {
		if (!open) return;
		return window.omp.events.onBatch((events: AgentSessionEvent[]) => {
			if (!acceptsActiveTabEvents()) return;
			for (const event of events) {
				if (event.type === "goal_updated") {
					syncGoal();
				} else if (event.type === "loop_mode_update") {
					const next = normalizeLoopUpdate(event);
					if (next) applyLoop(next);
				}
			}
		});
	}, [open, syncGoal, applyLoop]);

	const tabs: TabItem[] = useMemo(
		() => [
			{
				id: "vibe",
				label: t("modesPanel.tabs.vibe"),
				badge: vibe.state?.enabled ? t("modesPanel.on") : undefined,
			},
			{
				id: "goal",
				label: t("modesPanel.tabs.goal"),
				badge: goal.state?.enabled ? goalStatusLabel(t, goal.state.status) : undefined,
			},
			{
				id: "loop",
				label: t("modesPanel.tabs.loop"),
				badge:
					loop.state && loop.state.state !== "off" ? t(`modesPanel.loop.state.${loop.state.state}`) : undefined,
			},
		],
		[t, vibe.state, goal.state, loop.state],
	);

	const handleTabChange = useCallback((id: string) => {
		setTab(id as ModesTabId);
	}, []);

	return (
		<Modal onClose={onClose} open={open} size="lg" title={t("modesPanel.title")} bodyClassName="p-0">
			<div className="flex h-[70vh] min-h-0 flex-col">
				<Tabs
					activeId={tab}
					ariaLabel={t("modesPanel.title")}
					className="shrink-0 px-4"
					onChange={handleTabChange}
					tabs={tabs}
				/>
				{tab === "vibe" && <VibeTab rpc={vibe} />}
				{tab === "goal" && <GoalTab rpc={goal} />}
				{tab === "loop" && <LoopTab rpc={loop} />}
				<div className="shrink-0 border-t border-(--omp-border-muted) px-4 py-2 text-omp-xs text-(--omp-dim)">
					{t("modesPanel.footerNote")}
				</div>
			</div>
		</Modal>
	);
}
