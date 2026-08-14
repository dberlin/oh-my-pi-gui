import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, ListTodo, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
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
 * One compact disclosure for a reasoning/tool phase. Completed history stays
 * on a single line until requested; live and failed work opens itself so the
 * user never loses current progress or an actionable error.
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
	const forcedOpen = live || status.running > 0 || status.failed > 0;
	const [expanded, setExpanded] = useState(forcedOpen);

	useEffect(() => {
		if (forcedOpen) setExpanded(true);
	}, [forcedOpen]);

	const summary =
		status.failed > 0
			? t("chat.process.statusFailed", { failed: status.failed, total: stepCount })
			: status.running > 0 || live
				? t("chat.process.statusRunning", { running: Math.max(1, status.running), total: stepCount })
				: t("chat.process.statusComplete", { total: stepCount });

	return (
		<section className={cx("omp-execution-group", className)} data-live={forcedOpen || undefined}>
			<button
				aria-expanded={expanded}
				className="omp-execution-group-header omp-pressable flex w-full min-w-0 items-center gap-2 text-left"
				onClick={() => setExpanded(value => !value)}
				type="button"
			>
				<ListTodo aria-hidden="true" className="shrink-0 text-[var(--omp-muted)]" size={16} />
				<span className="shrink-0 text-omp-lg font-semibold text-[var(--omp-text)]">{t("chat.process.title")}</span>
				<span className="min-w-0 flex-1 truncate text-omp-lg text-[var(--omp-muted)]">{summary}</span>
				{status.running > 0 || live ? (
					<LoaderCircle aria-hidden="true" className="shrink-0 animate-spin text-[var(--omp-link)]" size={15} />
				) : status.failed > 0 ? (
					<AlertCircle aria-hidden="true" className="shrink-0 text-[var(--omp-error)]" size={15} />
				) : (
					<CheckCircle2 aria-hidden="true" className="shrink-0 text-[var(--omp-dim)]" size={15} />
				)}
				{expanded ? (
					<ChevronDown aria-hidden="true" className="shrink-0 text-[var(--omp-dim)]" size={15} />
				) : (
					<ChevronRight aria-hidden="true" className="shrink-0 text-[var(--omp-dim)]" size={15} />
				)}
			</button>
			{expanded && <div className="omp-execution-group-body">{children}</div>}
		</section>
	);
}
