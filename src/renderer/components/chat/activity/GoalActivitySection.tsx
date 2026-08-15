import { LoaderCircle, Pause, Pencil, Play, Target, Trash2 } from "lucide-react";
import { useState } from "react";
import { useT } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { toast } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { ActivitySection } from "./ActivitySection";

type GoalAction = "pause" | "resume" | "drop";

/** Goal summary and controls rendered in the activity rail. */
export function GoalActivitySection({ readOnly, maxDetailHeight }: { readOnly: boolean; maxDetailHeight: number }) {
	const t = useT();
	const goal = useSessionStore(state => state.goal);
	const goalState = useSessionStore(state => state.goalState);
	const openModes = useUiStore(state => state.openModes);
	const [busy, setBusy] = useState<GoalAction | null>(null);

	const paused = goalState?.status === "paused";
	const objective = goal?.objective?.trim() || t("activitySidebar.goal.empty");

	const runAction = async (action: GoalAction) => {
		if (busy || !goal) return;
		const previous = useSessionStore.getState();
		setBusy(action);
		if (action === "drop") useSessionStore.setState({ goal: null, goalState: null });
		else useSessionStore.setState({ goalState: { status: action === "pause" ? "paused" : "active" } });

		try {
			const response = await window.omp.rpc.setGoal({ action });
			if (!response.success) {
				useSessionStore.setState({ goal: previous.goal, goalState: previous.goalState });
				toast({ variant: "error", title: t("dock.goal.actionFailed"), message: response.error });
			}
		} catch (cause) {
			useSessionStore.setState({ goal: previous.goal, goalState: previous.goalState });
			toast({ variant: "error", title: t("dock.goal.actionFailed"), message: String(cause) });
		} finally {
			setBusy(null);
		}
	};

	const summary = goal ? (paused ? t("dock.goal.paused") : t("dock.goal.active")) : t("activitySidebar.goal.empty");

	return (
		<ActivitySection
			badge={<span className="truncate text-omp-xs text-(--omp-dim)">{summary}</span>}
			icon={Target}
			id="goal"
			title={t("input.goal.label")}
		>
			<div
				className="overflow-y-auto"
				data-activity-meta-detail="goal"
				style={{ maxHeight: `${Math.max(0, maxDetailHeight)}px` }}
			>
				<div className="flex min-w-0 flex-col gap-3 px-3 py-3">
					<span className="text-omp-lg text-[var(--omp-text)]" title={objective}>
						{objective}
					</span>
					{!readOnly && (
						<div className="flex items-center gap-2">
							{goal && (
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
							)}
							<button
								aria-label={t("dock.goal.edit")}
								className="omp-goal-dock-action omp-pressable"
								disabled={busy !== null}
								onClick={() => openModes("goal")}
								type="button"
							>
								<Pencil size={15} />
							</button>
							{goal && (
								<button
									aria-label={t("modesPanel.goal.drop")}
									className="omp-goal-dock-action omp-pressable hover:text-[var(--omp-error)]"
									disabled={busy !== null}
									onClick={() => void runAction("drop")}
									type="button"
								>
									{busy === "drop" ? (
										<LoaderCircle className="animate-spin" size={15} />
									) : (
										<Trash2 size={15} />
									)}
								</button>
							)}
						</div>
					)}
				</div>
			</div>
		</ActivitySection>
	);
}
