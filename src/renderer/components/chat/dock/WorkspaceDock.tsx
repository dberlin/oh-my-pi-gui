/**
 * Workspace dock: the live execution-state region mounted between the
 * transcript and the composer, replacing the workspace drawer's
 * todo/plan/agents/queue tabs with always-current center cards. This region
 * is the single vertical scroll owner: large todo/agent collections render a
 * compact summary and temporarily focus one card for full-list inspection.
 * Each card
 * self-gates its visibility (no todos, no subagents, plan mode off, empty
 * queue → nothing rendered), so the region collapses to zero height on an
 * idle session. Chat tabs are tool-free — none of these surfaces can exist
 * there. Every card sits behind its own error boundary: a card crash must
 * never take down the composer.
 */

import { useQueuedMessages } from "../../../stores/queue";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { useActiveTabKind } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { PanelErrorBoundary } from "../../common";
import { AgentsDockCard } from "./AgentsDockCard";
import { GoalDockBar } from "./GoalDockBar";
import { PlanDockCard } from "./PlanDockCard";
import { QueueDockChip } from "./QueueDockChip";
import { TodoDockCard } from "./TodoDockCard";
import { useWorkspaceDockFocus, WorkspaceDockFocusProvider } from "./WorkspaceDockFocus";

function WorkspaceDockContent() {
	const { focusedCard } = useWorkspaceDockFocus();
	const planModeEnabled = useSessionStore(state => state.planModeEnabled);
	const goalVisible = useSessionStore(state => state.goal !== null);
	const todoVisible = useTodoStore(state => state.phases.length > 0 || state.reminderVisible);
	const agentsVisible = useSubagentsStore(state => state.subagents.size > 0);
	const queued = useQueuedMessages();
	const cardsVisible =
		planModeEnabled || todoVisible || agentsVisible || queued.steering.length > 0 || queued.followUp.length > 0;

	if (!cardsVisible && !goalVisible) return null;

	return (
		<div className="flex flex-col gap-1.5 pb-1.5" data-focused-card={focusedCard ?? undefined}>
			{cardsVisible && (
				<div
					className="flex max-h-[min(30vh,240px)] flex-col gap-1.5 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
					data-testid="workspace-dock-scroll"
				>
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
			)}
			<PanelErrorBoundary>
				<GoalDockBar />
			</PanelErrorBoundary>
		</div>
	);
}

export function WorkspaceDock() {
	const isChat = useActiveTabKind() === "chat";
	if (isChat) return null;

	return (
		<WorkspaceDockFocusProvider>
			<WorkspaceDockContent />
		</WorkspaceDockFocusProvider>
	);
}
