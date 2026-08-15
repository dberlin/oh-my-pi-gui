import { AlertCircle, CheckCircle2, ChevronRight, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useToolsStore } from "../../stores/tools";

interface ExecutionGroupProps {
	children: ReactNode;
	className?: string;
	live?: boolean;
	stepCount: number;
	toolCallIds: readonly string[];
}

/**
 * One quiet disclosure for a reasoning/tool phase. Work opens while it is
 * active, then returns to a single summary line regardless of its outcome.
 * Errors remain called out in the summary and can be inspected on demand.
 */
export function ExecutionGroup({ children, className, live = false, stepCount, toolCallIds }: ExecutionGroupProps) {
	const t = useT();
	const activeTools = useToolsStore(state => state.activeTools);
	const status = useMemo(() => {
		let running = 0;
		let failed = 0;
		for (const id of toolCallIds) {
			const entry = activeTools.get(id);
			if (entry?.status === "pending" || entry?.status === "running") running++;
			else if (entry?.status === "error" || entry?.isError) failed++;
		}
		return { failed, running };
	}, [activeTools, toolCallIds]);
	const active = live || status.running > 0;
	const state = active ? "running" : status.failed > 0 ? "failed" : "complete";
	const [expanded, setExpanded] = useState(active);
	const wasActiveRef = useRef(active);

	useEffect(() => {
		const wasActive = wasActiveRef.current;
		if (active && !wasActive) setExpanded(true);
		else if (!active && wasActive) setExpanded(false);
		wasActiveRef.current = active;
	}, [active]);

	const summary =
		status.failed > 0
			? t("chat.process.statusFailed", { failed: status.failed, total: stepCount })
			: status.running > 0 || live
				? t("chat.process.statusRunning", { running: Math.max(1, status.running), total: stepCount })
				: t("chat.process.statusComplete", { total: stepCount });

	return (
		<section className={cx("omp-execution-group", className)} data-state={state}>
			<button
				aria-expanded={expanded}
				className="omp-execution-group-header omp-pressable flex w-full min-w-0 items-center gap-2 text-left"
				onClick={() => setExpanded(value => !value)}
				type="button"
			>
				{active ? (
					<LoaderCircle aria-hidden="true" className="shrink-0 animate-spin text-[var(--omp-link)]" size={14} />
				) : status.failed > 0 ? (
					<AlertCircle aria-hidden="true" className="shrink-0 text-[var(--omp-error)]" size={14} />
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
