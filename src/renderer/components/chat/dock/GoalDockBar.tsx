import { LoaderCircle, Pause, Pencil, Play, Target, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTabGuard } from "../../../hooks/use-tab-guard";
import { useT } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { toast } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";

type GoalAction = "pause" | "resume" | "drop";

/** Compact, persistent control strip for the session's active goal. */
export function GoalDockBar() {
	const t = useT();
	const goal = useSessionStore(state => state.goal);
	const goalState = useSessionStore(state => state.goalState);
	const openModes = useUiStore(state => state.openModes);
	const [busy, setBusy] = useState<GoalAction | null>(null);
	const { capture, isActive } = useTabGuard();

	if (!goal) return null;

	const paused = goalState?.status === "paused";
	const objective = goal.objective?.trim() || t("input.goal.label");

	const runAction = async (action: GoalAction) => {
		if (busy) return;
		const previous = useSessionStore.getState();
		const origin = capture();
		setBusy(action);
		if (action === "drop") useSessionStore.setState({ goal: null, goalState: null });
		else useSessionStore.setState({ goalState: { status: action === "pause" ? "paused" : "active" } });

		try {
			const response = await window.omp.rpc.setGoal({ action });
			// Settled after a tab switch: the optimistic write already belonged to
			// the origin session — do not restore it over the new foreground one.
			if (!isActive(origin)) return;
			if (!response.success) {
				useSessionStore.setState({ goal: previous.goal, goalState: previous.goalState });
				toast({ variant: "error", title: t("dock.goal.actionFailed"), message: response.error });
			}
		} catch (cause) {
			if (!isActive(origin)) return;
			useSessionStore.setState({ goal: previous.goal, goalState: previous.goalState });
			toast({ variant: "error", title: t("dock.goal.actionFailed"), message: String(cause) });
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="omp-goal-dock flex min-w-0 items-center gap-2 rounded-[14px] border border-[var(--omp-border)] px-3 py-2">
			<Target aria-hidden="true" className="shrink-0 text-[var(--omp-muted)]" size={16} />
			<span className="shrink-0 text-omp-lg font-semibold text-[var(--omp-text)]">
				{paused ? t("dock.goal.paused") : t("dock.goal.active")}
			</span>
			<span className="min-w-0 flex-1 truncate text-omp-lg text-[var(--omp-text)]" title={objective}>
				{objective}
			</span>
			<button
				aria-label={paused ? t("modesPanel.goal.resume") : t("modesPanel.goal.pause")}
				className="omp-goal-dock-action omp-pressable"
				disabled={busy !== null}
				onClick={() => void runAction(paused ? "resume" : "pause")}
				type="button"
			>
				{busy === "pause" || busy === "resume" ? (
					<LoaderCircle className="animate-spin" size={15} />
				) : paused ? (
					<Play size={15} />
				) : (
					<Pause size={15} />
				)}
			</button>
			<button
				aria-label={t("dock.goal.edit")}
				className="omp-goal-dock-action omp-pressable"
				disabled={busy !== null}
				onClick={() => openModes("goal")}
				type="button"
			>
				<Pencil size={15} />
			</button>
			<button
				aria-label={t("modesPanel.goal.drop")}
				className="omp-goal-dock-action omp-pressable hover:text-[var(--omp-error)]"
				disabled={busy !== null}
				onClick={() => void runAction("drop")}
				type="button"
			>
				{busy === "drop" ? <LoaderCircle className="animate-spin" size={15} /> : <Trash2 size={15} />}
			</button>
		</div>
	);
}
