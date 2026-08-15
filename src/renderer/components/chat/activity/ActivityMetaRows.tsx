import { PanelErrorBoundary } from "../../common/PanelErrorBoundary";
import { GoalActivitySection } from "./GoalActivitySection";
import { PlanActivitySection } from "./PlanActivitySection";

export interface ActivityMetaRowsProps {
	readOnly: boolean;
	maxDetailHeight: number;
}

/** The sole ordering and mutually-exclusive disclosure owner for Plan and Goal. */
export function ActivityMetaRows({ readOnly, maxDetailHeight }: ActivityMetaRowsProps) {
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
		</div>
	);
}
