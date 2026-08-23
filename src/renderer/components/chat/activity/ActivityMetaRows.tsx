import { MessagesSquare } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { PanelErrorBoundary } from "../../common/PanelErrorBoundary";
import { type ConversationNavigationModel, ConversationNavigator } from "../ConversationNavigator";
import { ActivitySection } from "./ActivitySection";
import { GoalActivitySection } from "./GoalActivitySection";
import { PlanActivitySection } from "./PlanActivitySection";

export interface ActivityMetaRowsProps {
	readOnly: boolean;
	maxDetailHeight: number;
	conversationNavigation?: ConversationNavigationModel | null;
}

/** The sole ordering and mutually-exclusive disclosure owner for Plan, Goal, and Conversations. */
export function ActivityMetaRows({ readOnly, maxDetailHeight, conversationNavigation }: ActivityMetaRowsProps) {
	const t = useT();
	return (
		<div className="min-h-0" data-activity-meta-rows>
			<div data-activity-section="plan">
				<PanelErrorBoundary>
					<PlanActivitySection maxDetailHeight={maxDetailHeight} readOnly={readOnly} />
				</PanelErrorBoundary>
			</div>
			<div data-activity-section="goal">
				<PanelErrorBoundary>
					<GoalActivitySection maxDetailHeight={maxDetailHeight} readOnly={readOnly} />
				</PanelErrorBoundary>
			</div>
			<div data-activity-section="conversations">
				<PanelErrorBoundary>
					<ActivitySection
						badge={
							<span className="text-omp-xs tabular-nums text-(--omp-dim)">
								{conversationNavigation?.anchors.length ?? 0}
							</span>
						}
						bodyClassName="overflow-y-auto"
						icon={MessagesSquare}
						id="conversations"
						title={t("activitySidebar.conversations.label")}
					>
						<div style={{ maxHeight: `${maxDetailHeight}px` }}>
							{conversationNavigation ? (
								<ConversationNavigator {...conversationNavigation} />
							) : (
								<div className="px-3 py-2 text-omp-sm text-(--omp-dim)">
									{t("activitySidebar.conversations.empty")}
								</div>
							)}
						</div>
					</ActivitySection>
				</PanelErrorBoundary>
			</div>
		</div>
	);
}
