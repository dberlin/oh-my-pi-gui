/**
 * ActivityStrip agents segment: live subagent count with a jump to the
 * workspace drawer's agents tab (`setPanelTab("agents")`). Mounted by
 * ActivityStrip through its agents region; renders nothing when no subagent
 * is live (the strip hides itself entirely when both segments are empty).
 *
 * Owns stream-time polling of get_subagents: lifecycle/progress frames keep
 * the store fresh while agents run, but parked/idle transitions ride the
 * AgentRegistry (agent-lifecycle/executor setStatus) and emit NO wire frame —
 * without polling, a watchdog-parked agent shows "running" here until the
 * next session hydration. The store's refresh() merges, so finished agents
 * the server has forgotten survive the poll.
 */

import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { useActiveTabKind } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { isLiveSubagentStatus } from "../panels/subagent-graph";

/** Poll cadence while a turn streams (covers frame-less parked/idle transitions). */
const STREAM_POLL_MS = 3000;

export function ActivityStripAgents({ pollMs = STREAM_POLL_MS }: { pollMs?: number }) {
	const t = useT();
	const runningCount = useSubagentsStore(s => {
		let count = 0;
		for (const agent of s.subagents.values()) if (isLiveSubagentStatus(agent.status)) count += 1;
		return count;
	});
	const isStreaming = useSessionStore(s => s.isStreaming);
	const setPanelTab = useUiStore(s => s.setPanelTab);
	/** Chat tabs are tool-free: subagents can never exist there. */
	const isChat = useActiveTabKind() === "chat";

	useEffect(() => {
		if (!isStreaming) return;
		const timer = setInterval(() => void useSubagentsStore.getState().refresh(), pollMs);
		return () => clearInterval(timer);
	}, [isStreaming, pollMs]);

	if (isChat || runningCount === 0) return null;

	return (
		<button
			type="button"
			onClick={() => setPanelTab("agents")}
			title={t("activityStrip.agents.open")}
			className="omp-pressable flex items-center gap-1.5 rounded-full border border-[var(--omp-border)] bg-[var(--omp-bg-secondary)] px-2.5 py-1 font-medium whitespace-nowrap text-[var(--omp-muted)] hover:border-[var(--omp-border-strong)] hover:text-[var(--omp-text)]"
		>
			{t("activityStrip.agents.segment", { count: runningCount })}
		</button>
	);
}
