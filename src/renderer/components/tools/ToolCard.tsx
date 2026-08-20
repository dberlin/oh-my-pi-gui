import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { Component, type ComponentType, type ErrorInfo, useEffect, useRef, useState } from "react";
import { cx, durationBetween } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { reportRuntimeError } from "../../lib/runtime-errors";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { scopedDisclosureKey, TOOL_DISCLOSURE_PREFIX, useDisclosureScope, useUiStore } from "../../stores/ui";
import { GenericRenderer } from "./GenericRenderer";
import { getToolRenderer, type ToolRendererView } from "./index";
import { isPeerIrcInvocation, resolveToolPresentation, toolPresentationSummary } from "./tool-presentation";

export interface ToolRendererProps {
	args: Record<string, unknown>;
	result: unknown;
	isError?: boolean;
	isPartial?: boolean;
	partialResult?: unknown;
	view: ToolRendererView;
}

export interface ToolCardProps {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	/** A parent activity indicator can own animation for a live tool group. */
	runningIndicator?: RunningIndicator;
	/** Explicit transcript-local entry. `null` prevents fallback to the active session store. */
	entry?: ToolEntry | null;
}

export type RunningIndicator = "spinner" | "dot";
type AccessibleToolStatus = "running" | "completed" | "failed";

interface ToolRendererErrorBoundaryProps {
	component: ComponentType<ToolRendererProps>;
	effectiveName: string;
	rendererProps: ToolRendererProps;
}

interface ToolRendererErrorBoundaryState {
	failed: boolean;
}

class ToolRendererErrorBoundary extends Component<ToolRendererErrorBoundaryProps, ToolRendererErrorBoundaryState> {
	state: ToolRendererErrorBoundaryState = { failed: false };

	static getDerivedStateFromError(): ToolRendererErrorBoundaryState {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		reportRuntimeError("react-render", error, {
			componentStack: info.componentStack ?? undefined,
			details: { boundary: "tool-renderer", tool: this.props.effectiveName },
		});
	}

	render() {
		const Renderer = this.state.failed ? GenericRenderer : this.props.component;
		return <Renderer {...this.props.rendererProps} />;
	}
}

/**
 * Chrome around every tool invocation: status rail, name, summary, duration,
 * expand/collapse. The body comes from the tool registry; the tool_result
 * arrives via the tools store keyed by toolCallId.
 */
export function ToolCard({ entry, ...props }: ToolCardProps) {
	if (entry !== undefined) return <ToolCardContent {...props} entry={entry ?? undefined} />;
	return <MainToolCard {...props} />;
}

function MainToolCard(props: Omit<ToolCardProps, "entry">) {
	const entry = useToolsStore(state => state.activeTools.get(props.toolCallId));
	return <ToolCardContent {...props} entry={entry} />;
}

function ToolCardContent({
	args,
	entry,
	runningIndicator = "spinner",
	toolCallId,
	toolName,
}: Omit<ToolCardProps, "entry"> & { entry: ToolEntry | undefined }) {
	const t = useT();
	const expandAll = useUiStore(s => s.toolsExpandAll);
	// The virtualizer unmounts rows that scroll out of view, so a card's own
	// choice lives in the ui store rather than component state. ⌃O clears these
	// overrides, which drops every card back onto the shared target below.
	const disclosureKey = scopedDisclosureKey(useDisclosureScope(), `${TOOL_DISCLOSURE_PREFIX}${toolCallId}`);
	const storedExpanded = useUiStore(s => s.disclosureOpen[disclosureKey]);
	const setDisclosureOpen = useUiStore(s => s.setDisclosureOpen);
	const expanded = storedExpanded ?? expandAll.expanded;
	const setExpanded = (next: boolean) => setDisclosureOpen(disclosureKey, next);

	const entryStatus = entry?.status ?? "running";
	// "pending" (args still streaming) is a live sub-state: spinner, not a check.
	const status = entryStatus === "pending" ? "running" : entryStatus;
	const effective = resolveToolPresentation({
		name: toolName,
		args: entry ? { ...args, ...entry.args } : args,
		result: entry?.result ?? null,
		partialResult: entry?.partialResult ?? null,
		isError: Boolean(entry?.isError),
		streamingArgs: entry?.streamingArgs,
	});
	const isError = effective.isError;
	const accessibleStatus: AccessibleToolStatus =
		status === "error" || isError ? "failed" : status === "done" ? "completed" : "running";
	const statusText = t(`tools.status.${accessibleStatus}`);
	const previousStatusRef = useRef({ toolCallId, status: accessibleStatus });
	const [announcement, setAnnouncement] = useState<{ toolCallId: string; text: string } | null>(null);
	useEffect(() => {
		const previous = previousStatusRef.current;
		if (previous.toolCallId !== toolCallId) {
			previousStatusRef.current = { toolCallId, status: accessibleStatus };
			setAnnouncement(null);
			return;
		}
		if (previous.status === accessibleStatus) return;
		previousStatusRef.current = { toolCallId, status: accessibleStatus };
		setAnnouncement({ toolCallId, text: statusText });
	}, [accessibleStatus, statusText, toolCallId]);
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
	const definition = getToolRenderer(effective);
	const peerIrc = isPeerIrcInvocation(effective);
	const displayName = peerIrc ? "IRC" : effective.name;
	const summary = toolPresentationSummary(effective);
	const view: ToolRendererView = expanded ? "expanded" : "preview";
	const rendererProps: ToolRendererProps = {
		args: effective.args,
		result: effective.result,
		isError,
		isPartial,
		partialResult: effective.partialResult,
		view,
	};
	const showsCollapsedPreview = peerIrc || (!isPartial && (effective.mode === "help" || effective.mcp != null));
	const renderer =
		definition.component === GenericRenderer ? (
			<GenericRenderer {...rendererProps} />
		) : (
			<ToolRendererErrorBoundary
				key={`${toolCallId}:${effective.name}`}
				component={definition.component}
				effectiveName={effective.name}
				rendererProps={rendererProps}
			/>
		);

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
				"omp-tool-card omp-fade-up relative my-2 overflow-hidden rounded-[10px] border border-[var(--omp-border-muted)] transition-[border-color,box-shadow,background-color] duration-200",
				status === "running" && "border-[var(--omp-border-accent)]/60",
			)}
			data-tool-name={effective.name}
			data-tool-shell={definition.shell}
			data-tool-status={status}
			data-tool-error={isError ? "true" : undefined}
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
				aria-expanded={expanded}
				aria-label={`${displayName}${summary ? ` ${summary}` : ""}, ${statusText}`}
				onClick={() => setExpanded(!expanded)}
				className="omp-tool-header flex w-full items-center gap-2 py-2 pl-3.5 pr-2.5 text-left transition-colors duration-150 hover:bg-[var(--omp-selected-bg)]/40"
			>
				{status === "running" && runningIndicator === "spinner" ? (
					<Loader2 size={12} className="omp-tool-status-icon shrink-0 animate-spin text-[var(--omp-accent)]" />
				) : status === "running" ? (
					<span aria-hidden className="omp-tool-status-icon flex h-3 w-3 shrink-0 items-center justify-center">
						<span className="h-1.5 w-1.5 rounded-full bg-[var(--omp-accent)]" />
					</span>
				) : accessibleStatus === "failed" ? (
					<X aria-hidden size={12} className="omp-tool-status-icon shrink-0 text-[var(--omp-error)]" />
				) : (
					<Check aria-hidden size={12} className="omp-tool-status-icon shrink-0 text-[var(--omp-success)]" />
				)}
				<span className="omp-tool-name shrink-0 font-mono text-omp-md font-semibold tracking-tight text-[var(--omp-text)]">
					{displayName}
				</span>
				{summary && (
					<span className="omp-tool-summary min-w-0 flex-1 truncate font-mono text-omp-sm text-[var(--omp-tool-output)]">
						{summary}
					</span>
				)}
				{!summary && streamingSummary && (
					<span className="omp-tool-summary min-w-0 flex-1 truncate font-mono text-omp-sm opacity-60 text-[var(--omp-tool-output)]">
						{streamingSummary}…
					</span>
				)}
				{!summary && !streamingSummary && <span className="flex-1" />}
				{duration && (
					<span
						className="omp-tool-duration shrink-0 rounded-md bg-[var(--omp-bg-tertiary)] px-1.5 py-0.5 font-mono text-omp-xxs tabular-nums text-[var(--omp-muted)]" // surface-ok: tiny duration pill
					>
						{duration}
					</span>
				)}
				<ChevronRight
					size={13}
					className={cx(
						"omp-tool-chevron omp-disclosure-chevron shrink-0 text-[var(--omp-dim)]",
						expanded && "rotate-90",
					)}
				/>
			</button>
			{announcement?.toolCallId === toolCallId && (
				<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
					{announcement.text}
				</span>
			)}
			{(expanded || definition.shell === "compact" || showsCollapsedPreview) && (
				<div
					className={cx(
						"omp-fade-in border-t border-[var(--omp-border-muted)]/70 px-3.5 py-2.5",
						expanded || definition.shell === "compact" ? "omp-tool-body" : "omp-tool-preview",
					)}
				>
					{renderer}
				</div>
			)}
		</div>
	);
}
