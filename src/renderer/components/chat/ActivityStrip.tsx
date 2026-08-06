/**
 * Activity strip: a slim always-visible bar mounted directly above the
 * composer, surfacing live execution state that otherwise hides behind the
 * workspace drawer. Left segment: the pending message queue (click opens the
 * queue panel tab). Right segment: running subagents — built by the agents
 * visibility slice and mounted into the marked region below (via the
 * optional agentsSlot composition seam). Renders nothing while both segments
 * are empty.
 */
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { useQueuedMessages } from "../../stores/queue";
import { useSubagentsStore } from "../../stores/subagents";
import { useUiStore } from "../../stores/ui";
import { isLiveSubagentStatus } from "../panels/subagent-graph";
import { ActivityStripAgents } from "./ActivityStripAgents";

export function ActivityStrip({ agentsSlot }: { agentsSlot?: ReactNode }) {
	const t = useT();
	const setPanelTab = useUiStore(s => s.setPanelTab);
	const { steering, followUp } = useQueuedMessages();
	const runningAgents = useSubagentsStore(
		s => [...s.subagents.values()].filter(agent => isLiveSubagentStatus(agent.status)).length,
	);

	const queuedTotal = steering.length + followUp.length;
	if (queuedTotal === 0 && runningAgents === 0) return null;

	return (
		<div className="flex items-center gap-2 px-2 pb-2 text-[11px]">
			{queuedTotal > 0 && (
				<button
					type="button"
					onClick={() => setPanelTab("queue")}
					title={t("activityStrip.queue.open")}
					className="omp-pressable flex items-center gap-1.5 rounded-full border border-[var(--omp-border)] bg-[var(--omp-bg-secondary)] px-2.5 py-1 font-medium text-[var(--omp-muted)] hover:border-[var(--omp-border-strong)] hover:text-[var(--omp-text)]"
				>
					<span aria-hidden="true">➤</span>
					<span>
						{t("activityStrip.queue.label")}{" "}
						<span className="tabular-nums text-[var(--omp-text)]">{followUp.length}</span>
					</span>
					<span aria-hidden="true" className="text-[var(--omp-dim)]">
						·
					</span>
					<span>
						{t("activityStrip.queue.steering")}{" "}
						<span className="tabular-nums text-[var(--omp-text)]">{steering.length}</span>
					</span>
				</button>
			)}
			<div className="flex-1" />
			{/* Agents segment — AgentsVisibilityAgent owns <ActivityStripAgents />;
			    the agentsSlot seam stays for tests/overrides. */}
			{agentsSlot ?? <ActivityStripAgents />}
		</div>
	);
}
