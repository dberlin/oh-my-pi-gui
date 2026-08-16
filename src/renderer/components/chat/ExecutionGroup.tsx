import { CheckCircle2, ChevronRight, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";

interface ExecutionGroupProps {
	children: ReactNode;
	className?: string;
	live?: boolean;
	stepCount: number;
}

export function ExecutionGroup({ children, className, live = false, stepCount }: ExecutionGroupProps) {
	const t = useT();
	const [expanded, setExpanded] = useState(live);
	const wasLiveRef = useRef(live);

	useEffect(() => {
		const wasLive = wasLiveRef.current;
		if (live && !wasLive) setExpanded(true);
		else if (!live && wasLive) setExpanded(false);
		wasLiveRef.current = live;
	}, [live]);

	const summary = live
		? t("chat.process.statusRunning", { running: 1, total: stepCount })
		: t("chat.process.statusComplete", { total: stepCount });
	const state = live ? "running" : "complete";

	return (
		<section className={cx("omp-execution-group", className)} data-state={state}>
			<button
				aria-expanded={expanded}
				className="omp-execution-group-header omp-pressable flex w-full min-w-0 items-center gap-2 text-left"
				onClick={() => setExpanded(value => !value)}
				type="button"
			>
				{live ? (
					<LoaderCircle aria-hidden="true" className="shrink-0 animate-spin text-[var(--omp-link)]" size={14} />
				) : (
					<CheckCircle2 aria-hidden="true" className="shrink-0 text-[var(--omp-dim)]" size={14} />
				)}
				<span
					aria-atomic="true"
					aria-live="polite"
					className="min-w-0 flex-1 truncate text-omp-md font-medium text-[var(--omp-muted)]"
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
