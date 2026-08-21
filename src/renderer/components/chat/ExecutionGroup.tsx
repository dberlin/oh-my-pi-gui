import { AlertCircle, CheckCircle2, ChevronRight, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useToolsStore } from "../../stores/tools";

interface ExecutionGroupProps {
	children: ReactNode;
	className?: string;
	expanded: boolean;
	live?: boolean;
	onExpandedChange: (expanded: boolean) => void;
	stepCount: number;
	toolCallIds: readonly string[];
}

/**
 * One quiet disclosure for a reasoning/tool phase. Its open state is owned by
 * ChatStream so streaming updates and live-to-final row replacement cannot
 * override the user's choice.
 */
export function ExecutionGroup({
	children,
	className,
	expanded,
	live = false,
	onExpandedChange,
	stepCount,
	toolCallIds,
}: ExecutionGroupProps) {
	const t = useT();
	// Primitive selector: encode (running, failed) so unrelated tool events —
	// partial results on cards outside this group — never re-render the group.
	const encoded = useToolsStore(s => {
		let running = 0;
		let failed = 0;
		for (const id of toolCallIds) {
			const entry = s.activeTools.get(id);
			if (entry?.status === "pending" || entry?.status === "running") running++;
			else if (entry?.status === "error" || entry?.isError) failed++;
		}
		return `${running}:${failed}`;
	});
	const [running, failed] = encoded.split(":").map(Number);

	const active = live || running > 0;
	const state = active ? "running" : failed > 0 ? "failed" : "complete";

	const summary =
		failed > 0
			? t("chat.process.statusFailed", { failed, total: stepCount })
			: running > 0 || live
				? t("chat.process.statusRunning", { running: Math.max(1, running), total: stepCount })
				: t("chat.process.statusComplete", { total: stepCount });

	return (
		<section className={cx("omp-execution-group", className)} data-state={state}>
			<button
				aria-expanded={expanded}
				className="omp-execution-group-header omp-pressable flex w-full min-w-0 items-center gap-2 text-left"
				onClick={() => onExpandedChange(!expanded)}
				type="button"
			>
				{active ? (
					<LoaderCircle aria-hidden="true" className="shrink-0 animate-spin text-[var(--omp-link)]" size={14} />
				) : failed > 0 ? (
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
