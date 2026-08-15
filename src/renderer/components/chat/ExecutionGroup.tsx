import { ChevronRight } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { type ToolEntry, useToolsStore } from "../../stores/tools";

interface ExecutionGroupProps {
	activeTools?: ReadonlyMap<string, ToolEntry>;
	children: ReactNode;
	className?: string;
	expanded: boolean;
	failureCount?: number;
	live?: boolean;
	onExpandedChange: (expanded: boolean) => void;
	stepCount: number;
	toolCallIds: readonly string[];
}

interface GroupStatus {
	failed: number;
	running: number;
}

function countStatus(activeTools: ReadonlyMap<string, ToolEntry>, toolCallIds: readonly string[]): GroupStatus {
	let running = 0;
	let failed = 0;
	for (const id of toolCallIds) {
		const entry = activeTools.get(id);
		if (entry?.status === "pending" || entry?.status === "running") running++;
		else if (entry?.status === "error" || entry?.isError) failed++;
	}
	return { failed, running };
}

/**
 * One quiet disclosure for a reasoning/tool phase. Its open state is owned by
 * ChatStream so streaming updates and live-to-final row replacement cannot
 * override the user's choice. Agent transcripts pass their own tool map;
 * the main transcript reads the shared store.
 */
export function ExecutionGroup({ activeTools, ...props }: ExecutionGroupProps) {
	if (activeTools) return <AgentExecutionGroup {...props} activeTools={activeTools} />;
	return <MainExecutionGroup {...props} />;
}

function MainExecutionGroup(props: Omit<ExecutionGroupProps, "activeTools">) {
	const { toolCallIds } = props;
	// Primitive selector: encode (running, failed) so unrelated tool events —
	// partial results on cards outside this group — never re-render the group.
	const encoded = useToolsStore(s => {
		const { failed, running } = countStatus(s.activeTools, toolCallIds);
		return `${running}:${failed}`;
	});
	const [running, failed] = encoded.split(":").map(Number);
	return <ExecutionGroupContent {...props} status={{ failed, running }} />;
}

function AgentExecutionGroup({
	activeTools,
	...props
}: Omit<ExecutionGroupProps, "activeTools"> & { activeTools: ReadonlyMap<string, ToolEntry> }) {
	const { toolCallIds } = props;
	const status = useMemo(() => countStatus(activeTools, toolCallIds), [activeTools, toolCallIds]);
	return <ExecutionGroupContent {...props} status={status} />;
}

function ExecutionGroupContent({
	children,
	className,
	expanded,
	failureCount = 0,
	live = false,
	onExpandedChange,
	status,
	stepCount,
}: Omit<ExecutionGroupProps, "activeTools" | "toolCallIds"> & { status: GroupStatus }) {
	const t = useT();
	const failed = status.failed + failureCount;
	const active = live || status.running > 0;
	const state = active ? "running" : failed > 0 ? "failed" : "complete";

	const summary =
		failed > 0
			? t("chat.process.statusFailed", { failed, total: stepCount })
			: status.running > 0 || live
				? t("chat.process.statusRunning", { running: Math.max(1, status.running), total: stepCount })
				: t("chat.process.statusComplete", { total: stepCount });

	return (
		<section className={cx("omp-execution-group", className)} data-state={state}>
			<button
				aria-expanded={expanded}
				className="omp-execution-group-header omp-pressable flex w-full min-w-0 items-center gap-2 text-left"
				onClick={() => onExpandedChange(!expanded)}
				type="button"
				aria-label={`${t("chat.process.title")}: ${summary}`}
			>
				{active && (
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
						state === "failed" && "text-[var(--omp-error)]",
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
