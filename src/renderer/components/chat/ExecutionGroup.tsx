import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";

interface ExecutionGroupProps {
	children: ReactNode;
	className?: string;
	expanded?: boolean;
	onExpandedChange?: (expanded: boolean) => void;
	live?: boolean;
	stepCount: number;
}

export function ExecutionGroup({
	children,
	className,
	expanded: controlledExpanded,
	live = false,
	onExpandedChange,
	stepCount,
}: ExecutionGroupProps) {
	const t = useT();
	const [localExpanded, setLocalExpanded] = useState(live);
	const expanded = controlledExpanded ?? localExpanded;
	const wasLiveRef = useRef(live);
	const changeExpanded = (next: boolean) => {
		setLocalExpanded(next);
		onExpandedChange?.(next);
	};

	useEffect(() => {
		if (live === wasLiveRef.current) return;
		wasLiveRef.current = live;
		setLocalExpanded(live);
		onExpandedChange?.(live);
	}, [live, onExpandedChange]);

	const summary = live
		? t("chat.process.statusRunning", { running: 1, total: stepCount })
		: t("chat.process.statusComplete", { total: stepCount });
	const state = live ? "running" : "complete";

	return (
		<section className={cx("omp-execution-group", className)} data-state={state}>
			<button
				aria-expanded={expanded}
				className="omp-execution-group-header omp-pressable flex w-full min-w-0 items-center gap-2 text-left"
				onClick={() => changeExpanded(!expanded)}
				type="button"
				aria-label={`${t("chat.process.title")}: ${summary}`}
			>
				{live && (
					<span
						aria-hidden="true"
						className="omp-execution-group-live-dot h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--omp-accent)]"
					/>
				)}
				<span className="omp-execution-group-title shrink-0 text-omp-sm font-medium text-[var(--omp-text)]">
					{t("chat.process.title")}
				</span>
				<span
					aria-atomic="true"
					aria-live="polite"
					className={cx(
						"omp-execution-group-summary min-w-0 flex-1 truncate text-omp-xs",
						state === "running" && "text-[var(--omp-accent)]",
						state === "complete" && "text-[var(--omp-muted)]",
					)}
					role="status"
				>
					{summary}
				</span>
				<ChevronRight
					aria-hidden="true"
					className={cx("omp-disclosure-chevron shrink-0 text-[var(--omp-dim)]", expanded && "rotate-90")}
					size={14}
				/>
			</button>
			{expanded && <div className="omp-execution-group-body">{children}</div>}
		</section>
	);
}
