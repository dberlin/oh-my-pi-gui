/**
 * Workspace dock: the live execution-state region mounted between the
 * transcript and the composer, replacing the workspace drawer's
 * todo/plan/agents/queue tabs with always-current center cards. Each card
 * self-gates its visibility (no todos, no subagents, plan mode off, empty
 * queue → nothing rendered), so the region collapses to zero height on an
 * idle session. Chat tabs are tool-free — none of these surfaces can exist
 * there. Every card sits behind its own error boundary: a card crash must
 * never take down the composer.
 */

import { useActiveTabKind } from "../../../stores/tabs";
import { PanelErrorBoundary } from "../../common";
import { AgentsDockCard } from "./AgentsDockCard";
import { PlanDockCard } from "./PlanDockCard";
import { QueueDockChip } from "./QueueDockChip";
import { TodoDockCard } from "./TodoDockCard";

export function WorkspaceDock() {
	const isChat = useActiveTabKind() === "chat";
	if (isChat) return null;

	return (
		<div className="flex max-h-[45vh] flex-col gap-2 overflow-y-auto overscroll-contain pb-2">
			<PanelErrorBoundary>
				<PlanDockCard />
			</PanelErrorBoundary>
			<PanelErrorBoundary>
				<TodoDockCard />
			</PanelErrorBoundary>
			<PanelErrorBoundary>
				<AgentsDockCard />
			</PanelErrorBoundary>
			<PanelErrorBoundary>
				<QueueDockChip />
			</PanelErrorBoundary>
		</div>
	);
}
