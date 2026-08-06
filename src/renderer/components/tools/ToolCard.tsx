import { Check, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cx, durationBetween } from "../../lib/format";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { getToolRenderer } from "./index";

export interface ToolRendererProps {
	args: Record<string, unknown>;
	result: unknown;
	isError?: boolean;
	isPartial?: boolean;
	partialResult?: unknown;
}

export interface ToolCardProps {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	/** One-line summary for the collapsed header (path, command, pattern…). */
	summary?: string;
}

/**
 * Chrome around every tool invocation: status rail, name, summary, duration,
 * expand/collapse. The body comes from the tool registry; the tool_result
 * arrives via the tools store keyed by toolCallId.
 */
export function ToolCard({ toolCallId, toolName, args, summary }: ToolCardProps) {
	const entry = useToolsStore(s => s.activeTools.get(toolCallId));
	const expandAll = useUiStore(s => s.toolsExpandAll);
	const [expanded, setExpanded] = useState(expandAll.expanded);

	// ⌃O expand/collapse-all: every card snaps to the latest shared target.
	useEffect(() => {
		setExpanded(expandAll.expanded);
	}, [expandAll]);

	const entryStatus = entry?.status ?? "running";
	// "pending" (args still streaming) is a live sub-state: spinner, not a check.
	const status = entryStatus === "pending" ? "running" : entryStatus;
	const isError = Boolean(entry?.isError);
	const isPartial = status === "running";
	// Live duration tick (VibeRenderer pattern): re-render every second while
	// running so the badge keeps counting; stops on its own once the tool ends.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!isPartial) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [isPartial]);
	const duration = entry ? durationBetween(entry.startTime, isPartial ? now : entry.endTime) : null;
	const Renderer = getToolRenderer(toolName);

	const railColor =
		status === "error" || isError
			? "var(--omp-tool-rail-error)"
			: status === "done"
				? "var(--omp-tool-rail-done)"
				: "var(--omp-tool-rail-running)";

	const statusBg =
		status === "error" || isError
			? "var(--omp-tool-error-bg)"
			: status === "done"
				? "var(--omp-tool-success-bg)"
				: "var(--omp-tool-pending-bg)";

	return (
		<div
			className={cx(
				"omp-fade-up relative my-2 overflow-hidden rounded-[10px] border border-[var(--omp-border-muted)] transition-[border-color,box-shadow,background-color] duration-200",
				status === "running" && "border-[var(--omp-border-accent)]/60",
			)}
			style={{
				background: statusBg,
				boxShadow: status === "running" ? "0 0 12px var(--omp-input-glow)" : "var(--omp-shadow-sm)",
			}}
		>
			{/* 2px status rail pinned to the card's left edge */}
			<span
				aria-hidden
				className="absolute inset-y-0 left-0 w-[2px] transition-colors duration-300"
				style={{ background: railColor }}
			/>
			<button
				type="button"
				onClick={() => setExpanded(v => !v)}
				className="flex w-full items-center gap-2 py-2 pl-3.5 pr-2.5 text-left transition-colors duration-150 hover:bg-[var(--omp-selected-bg)]/40"
			>
				{status === "running" ? (
					<Loader2 size={12} className="shrink-0 animate-spin text-[var(--omp-accent)]" />
				) : isError ? (
					<X size={12} className="shrink-0 text-[var(--omp-error)]" />
				) : (
					<Check size={12} className="shrink-0 text-[var(--omp-success)]" />
				)}
				<span className="shrink-0 font-mono text-[12px] font-semibold tracking-tight text-[var(--omp-text)]">
					{toolName}
				</span>
				{summary && (
					<span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--omp-tool-output)]">
						{summary}
					</span>
				)}
				{!summary && <span className="flex-1" />}
				{duration && (
					<span className="shrink-0 rounded-md bg-[var(--omp-bg-tertiary)] px-1.5 py-0.5 font-mono text-[9.5px] tabular-nums text-[var(--omp-muted)]">
						{duration}
					</span>
				)}
				{expanded ? (
					<ChevronDown size={13} className="shrink-0 text-[var(--omp-dim)] transition-transform duration-150" />
				) : (
					<ChevronRight size={13} className="shrink-0 text-[var(--omp-dim)] transition-transform duration-150" />
				)}
			</button>
			{expanded && (
				<div className="omp-fade-in border-t border-[var(--omp-border-muted)]/70 px-3.5 py-2.5">
					<Renderer
						args={args}
						result={entry?.result}
						isError={isError}
						isPartial={isPartial}
						partialResult={entry?.partialResult}
					/>
				</div>
			)}
		</div>
	);
}
