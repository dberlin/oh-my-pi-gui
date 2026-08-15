/**
 * Grouped read-tool card (TUI read-tool-group parity): one collapsible read
 * renders inline (`● Read <path:sel>`); consecutive reads fold into a
 * `Read (N)` tree with same-file selector merges. Per-call status resolves
 * from the tools store (same source as ToolCard). Expanding reveals the
 * individual read cards with full content.
 */

import { ChevronRight, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import {
	type ReadGroupEntry,
	type ReadGroupUsage,
	type ResolveToolCall,
	mergeReadGroupEntries,
	readGroupTitle,
} from "../../lib/read-group";
import { type ResolvedToolCall, type ToolEntry, useToolsStore } from "../../stores/tools";
import { UsageRow } from "../chat/UsageRow";
import { type RunningIndicator, ToolCard } from "./ToolCard";

type ReadEntryStatus = "pending" | "success" | "error";

function statusOf(status: string | undefined): ReadEntryStatus {
	if (status === "error") return "error";
	if (status === "pending" || status === "running") return "pending";
	return "success";
}

interface ReadGroupCardProps {
	activeTools?: ReadonlyMap<string, ToolEntry>;
	entries: ReadGroupEntry[];
	inset?: boolean;
	runningIndicator?: RunningIndicator;
	/** Usage carried from fully-consumed assistant turns (TUI parity). */
	usage?: ReadGroupUsage[];
	/** Transcript-local occurrence resolver; omitted for the active Main transcript. */
	resolveToolCall?: ResolveToolCall;
}

interface ResolvedReadEntry extends ResolvedToolCall {
	source: ReadGroupEntry;
}
export function ReadGroupCard(props: ReadGroupCardProps) {
	if (props.resolveToolCall || props.activeTools) {
		return <ProjectedReadGroupCard {...props} />;
	}
	return <MainReadGroupCard {...props} />;
}

function ProjectedReadGroupCard({ activeTools, entries, resolveToolCall, ...props }: ReadGroupCardProps) {
	const resolvedEntries = useMemo<ResolvedReadEntry[]>(
		() =>
			entries.map(source => {
				const resolved =
					source.call && resolveToolCall
						? resolveToolCall(source.call)
						: { key: source.toolKey, entry: undefined };
				return {
					source,
					key: resolved.key,
					entry: resolved.entry ?? activeTools?.get(resolved.key),
				};
			}),
		[activeTools, entries, resolveToolCall],
	);
	const statuses = useMemo(() => {
		const map = new Map<string, ReadEntryStatus>();
		for (const resolved of resolvedEntries) {
			map.set(resolved.source.toolKey, statusOf(resolved.entry?.status));
		}
		return map;
	}, [resolvedEntries]);
	return (
		<ReadGroupCardContent
			{...props}
			entries={entries}
			explicit
			resolvedEntries={resolvedEntries}
			statuses={statuses}
		/>
	);
}

function MainReadGroupCard(props: ReadGroupCardProps) {
	const { entries } = props;
	// One primitive snapshot for this group's calls: unrelated tool events may
	// replace the store Map without re-rendering historical read groups. The
	// resolved entries stay entry-free here — ToolCard reads the store itself
	// on the Main transcript (`explicit` is false).
	const statusKey = useToolsStore(s =>
		entries.map(entry => statusOf(s.activeTools.get(entry.toolKey)?.status)).join("|"),
	);
	const statuses = useMemo(() => {
		const values = statusKey.split("|") as ReadEntryStatus[];
		return new Map(entries.map((entry, index) => [entry.toolKey, values[index] ?? "success"]));
	}, [entries, statusKey]);
	const resolvedEntries = useMemo<ResolvedReadEntry[]>(
		() => entries.map(source => ({ source, key: source.toolKey, entry: undefined })),
		[entries],
	);
	return <ReadGroupCardContent {...props} explicit={false} resolvedEntries={resolvedEntries} statuses={statuses} />;
}

function ReadGroupCardContent({
	entries,
	explicit,
	inset,
	resolvedEntries,
	runningIndicator = "spinner",
	statuses,
	usage,
}: ReadGroupCardProps & {
	explicit: boolean;
	resolvedEntries: ResolvedReadEntry[];
	statuses: ReadonlyMap<string, ReadEntryStatus>;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const rows = mergeReadGroupEntries(entries);
	const single = entries.length === 1;
	const pad = inset ? "py-0.5" : "ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-0.5";
	const anyPending = entries.some(entry => statuses.get(entry.toolKey) === "pending");
	const anyError = entries.some(entry => statuses.get(entry.toolKey) === "error");

	if (single) {
		const resolved = resolvedEntries[0]!;
		const entry = resolved.source;
		const status = statuses.get(entry.toolKey);
		return (
			<div className={cx("omp-read-group", pad)}>
				<button
					type="button"
					aria-expanded={open}
					onClick={() => setOpen(value => !value)}
					className="omp-read-group-header flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-omp-md text-(--omp-muted) hover:bg-(--omp-selected-bg) hover:text-(--omp-text)"
				>
					{status === "pending" && runningIndicator === "spinner" ? (
						<Loader2 size={11} className="shrink-0 animate-spin text-(--omp-accent)" />
					) : status === "pending" ? (
						<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--omp-accent)" />
					) : (
						<span
							className={cx(
								"h-1.5 w-1.5 shrink-0 rounded-full",
								status === "error" ? "bg-(--omp-error)" : "bg-(--omp-accent)",
							)}
						/>
					)}
					<span className="font-medium">{t("tools.read.label")}</span>
					<span className="truncate font-mono text-omp-sm text-(--omp-accent)">
						{entry.path}
						{entry.selector ? `:${entry.selector}` : ""}
					</span>
					<ChevronRight size={12} className={cx("omp-disclosure-chevron ml-auto shrink-0", open && "rotate-90")} />
				</button>
				{open && (
					<div className="omp-read-group-body ml-4 mt-1">
						<ToolCard
							toolCallId={resolved.key}
							toolName="read"
							args={entry.args}
							entry={explicit ? (resolved.entry ?? null) : undefined}
							runningIndicator="dot"
						/>
					</div>
				)}
				{usage?.map((item, index) => (
					<UsageRow key={index} message={item} />
				))}
			</div>
		);
	}

	return (
		<div className={cx("omp-read-group", pad)}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				className="omp-read-group-header flex w-full items-center gap-2 rounded-lg border border-(--omp-border-muted) bg-transparent px-3 py-1.5 text-left text-omp-md text-(--omp-muted) hover:border-(--omp-border) hover:text-(--omp-text)"
			>
				<ChevronRight size={13} className={cx("omp-disclosure-chevron shrink-0", open && "rotate-90")} />
				{anyPending && runningIndicator === "spinner" ? (
					<Loader2 size={12} className="shrink-0 animate-spin text-(--omp-accent)" />
				) : anyPending ? (
					<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--omp-accent)" />
				) : (
					<span
						className={cx(
							"h-1.5 w-1.5 shrink-0 rounded-full",
							anyError ? "bg-(--omp-error)" : "bg-(--omp-accent)",
						)}
					/>
				)}
				<span className="font-medium text-(--omp-text)">{readGroupTitle(entries)}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-omp-xs text-(--omp-dim)">
					{rows.length === 1 ? rows[0]!.path : t("readGroup.files", { count: rows.length })}
				</span>
			</button>
			{/* Tree preview rows (always visible, TUI parity) */}
			<div className="omp-read-group-preview ml-6 mt-0.5 font-mono text-omp-sm leading-[1.6] text-(--omp-muted)">
				{rows.map((row, index) => (
					<div key={`${row.path}:${index}`} className="flex items-baseline gap-2 truncate">
						<span className="shrink-0 text-(--omp-dim)">{index === rows.length - 1 ? "└─" : "├─"}</span>
						<span className="truncate text-(--omp-accent)">{row.path}</span>
						{row.selector && <span className="shrink-0 text-(--omp-dim)">:{row.selector}</span>}
						{row.toolKeys.some(key => statuses.get(key) === "pending") && (
							<span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--omp-accent)" />
						)}
						{!row.toolKeys.some(key => statuses.get(key) === "pending") &&
							row.toolKeys.some(key => statuses.get(key) === "error") && (
								<span className="shrink-0 text-(--omp-error)">✗</span>
							)}
					</div>
				))}
			</div>
			{open && (
				<div className="omp-read-group-body ml-6 mt-1 space-y-1.5">
					{resolvedEntries.map(resolved => (
						<ToolCard
							key={resolved.key}
							toolCallId={resolved.key}
							toolName="read"
							args={resolved.source.args}
							entry={explicit ? (resolved.entry ?? null) : undefined}
							runningIndicator="dot"
						/>
					))}
				</div>
			)}
			{usage?.map((item, index) => (
				<UsageRow key={index} message={item} />
			))}
		</div>
	);
}
