import { cx, formatShortClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ConversationAnchor } from "./chat-stream-utils";

export interface ConversationNavigationModel {
	activeIndex: number;
	anchors: readonly ConversationAnchor[];
	onNavigate: (rowIndex: number) => void;
}

export function ConversationNavigator({ activeIndex, anchors, onNavigate }: ConversationNavigationModel) {
	const t = useT();
	if (anchors.length === 0) {
		return <div className="px-3 py-2 text-omp-sm text-(--omp-dim)">{t("activitySidebar.conversations.empty")}</div>;
	}

	return (
		<div className="omp-conversation-list max-h-full overflow-y-auto p-1" role="list">
			{anchors.map((anchor, index) => {
				const preview = anchor.preview || t("chat.navigator.imagePrompt");
				const clock = formatShortClock(anchor.timestamp);
				return (
					<button
						aria-current={index === activeIndex ? "location" : undefined}
						aria-label={t("chat.navigator.jumpTo", {
							current: index + 1,
							total: anchors.length,
							preview,
						})}
						className={cx(
							"omp-pressable flex w-full min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
							index === activeIndex
								? "bg-(--omp-selected-bg) text-(--omp-text)"
								: "text-(--omp-muted) hover:bg-(--omp-selected-bg)",
						)}
						key={anchor.key}
						onClick={() => onNavigate(anchor.rowIndex)}
						role="listitem"
						type="button"
					>
						<span className="flex w-full items-center gap-2 text-omp-xs">
							<span className="font-semibold text-(--omp-accent)">
								{t("chat.navigator.turn", { current: index + 1, total: anchors.length })}
							</span>
							{clock ? (
								<time
									className="ml-auto shrink-0 font-mono text-(--omp-dim)"
									dateTime={String(anchor.timestamp)}
								>
									{clock}
								</time>
							) : null}
						</span>
						<span className="w-full truncate text-omp-sm" title={preview}>
							{preview}
						</span>
					</button>
				);
			})}
		</div>
	);
}
