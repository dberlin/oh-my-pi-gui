import { AlertCircle, CheckCircle2, ChevronRight, LoaderCircle } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { type ToolEntry, useToolsStore } from "../../stores/tools";

interface ExecutionGroupProps {
	activeTools?: ReadonlyMap<string, ToolEntry>;
	children: ReactNode;
	className?: string;
	expanded: boolean;
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
	live = false,
	onExpandedChange,
	status,
	stepCount,
}: Omit<ExecutionGroupProps, "activeTools" | "toolCallIds"> & { status: GroupStatus }) {
	const t = useT();
	const active = live || status.running > 0;
	const state = active ? "running" : status.failed > 0 ? "failed" : "complete";

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
				onClick={() => onExpandedChange(!expanded)}
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
