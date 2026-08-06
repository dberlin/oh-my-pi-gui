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
import { mergeReadGroupEntries, type ReadGroupEntry, type ReadGroupUsage, readGroupTitle } from "../../lib/read-group";
import { useToolsStore } from "../../stores/tools";
import { UsageRow } from "../chat/UsageRow";
import { ToolCard } from "./ToolCard";

function statusOf(status: string | undefined): "pending" | "success" | "error" {
	if (status === "error") return "error";
	if (status === "pending" || status === "running") return "pending";
	return "success";
}

export function ReadGroupCard({
	entries,
	inset,
	usage,
}: {
	entries: ReadGroupEntry[];
	inset?: boolean;
	/** Usage carried from fully-consumed assistant turns (TUI parity). */
	usage?: ReadGroupUsage[];
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const rows = mergeReadGroupEntries(entries);
	const single = entries.length === 1;
	const pad = inset ? "py-0.5" : "px-6 py-0.5";

	// Per-call status from the tools store: select the stable map reference and
	// derive statuses in a memo — building a Map INSIDE the selector returns a
	// fresh snapshot on every read, which loops forceStoreRerender until React
	// throws error #185 (white screen on any session containing a read group).
	const activeTools = useToolsStore(s => s.activeTools);
	const statuses = useMemo(() => {
		const map = new Map<string, "pending" | "success" | "error">();
		for (const entry of entries) {
			map.set(entry.toolKey, statusOf(activeTools.get(entry.toolKey)?.status));
		}
		return map;
	}, [activeTools, entries]);
	const anyPending = entries.some(entry => statuses.get(entry.toolKey) === "pending");
	const anyError = entries.some(entry => statuses.get(entry.toolKey) === "error");

	if (single) {
		const entry = entries[0]!;
		const status = statuses.get(entry.toolKey);
		return (
			<div className={pad}>
				<button
					type="button"
					onClick={() => setOpen(value => !value)}
					className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[12px] text-(--omp-muted) hover:bg-(--omp-selected-bg) hover:text-(--omp-text)"
				>
					{status === "pending" ? (
						<Loader2 size={11} className="shrink-0 animate-spin text-(--omp-accent)" />
					) : (
						<span
							className={cx(
								"h-1.5 w-1.5 shrink-0 rounded-full",
								status === "error" ? "bg-(--omp-error)" : "bg-(--omp-accent)",
							)}
						/>
					)}
					<span className="font-medium">Read</span>
					<span className="truncate font-mono text-[11px] text-(--omp-accent)">
						{entry.path}
						{entry.selector ? `:${entry.selector}` : ""}
					</span>
					<ChevronRight size={12} className={cx("ml-auto shrink-0 transition-transform", open && "rotate-90")} />
				</button>
				{open && (
					<div className="ml-4 mt-1">
						<ToolCard toolCallId={entry.toolKey} toolName="read" args={entry.args} />
					</div>
				)}
				{usage?.map((item, index) => (
					<UsageRow key={index} message={item} />
				))}
			</div>
		);
	}

	return (
		<div className={pad}>
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
				className="flex w-full items-center gap-2 rounded-lg border border-(--omp-border-muted) bg-(--omp-bg-secondary) px-3 py-1.5 text-left text-[12px] text-(--omp-muted) hover:border-(--omp-border) hover:text-(--omp-text)"
			>
				<ChevronRight size={13} className={cx("shrink-0 transition-transform", open && "rotate-90")} />
				{anyPending ? (
					<Loader2 size={12} className="shrink-0 animate-spin text-(--omp-accent)" />
				) : (
					<span
						className={cx(
							"h-1.5 w-1.5 shrink-0 rounded-full",
							anyError ? "bg-(--omp-error)" : "bg-(--omp-accent)",
						)}
					/>
				)}
				<span className="font-medium text-(--omp-text)">{readGroupTitle(entries)}</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-(--omp-dim)">
					{rows.length === 1 ? rows[0]!.path : t("readGroup.files", { count: rows.length })}
				</span>
			</button>
			{/* Tree preview rows (always visible, TUI parity) */}
			<div className="ml-6 mt-0.5 font-mono text-[11px] leading-[1.6] text-(--omp-muted)">
				{rows.map((row, index) => (
					<div key={`${row.path}:${index}`} className="flex items-baseline gap-2 truncate">
						<span className="shrink-0 text-(--omp-dim)">{index === rows.length - 1 ? "└─" : "├─"}</span>
						<span className="truncate text-(--omp-accent)">{row.path}</span>
						{row.selector && <span className="shrink-0 text-(--omp-dim)">:{row.selector}</span>}
						{row.toolKeys.some(key => statuses.get(key) === "pending") && (
							<Loader2 size={9} className="shrink-0 animate-spin text-(--omp-accent)" />
						)}
						{!row.toolKeys.some(key => statuses.get(key) === "pending") &&
							row.toolKeys.some(key => statuses.get(key) === "error") && (
								<span className="shrink-0 text-(--omp-error)">✗</span>
							)}
					</div>
				))}
			</div>
			{open && (
				<div className="ml-6 mt-1 space-y-1.5">
					{entries.map(entry => (
						<ToolCard key={entry.toolKey} toolCallId={entry.toolKey} toolName="read" args={entry.args} />
					))}
				</div>
			)}
			{usage?.map((item, index) => (
				<UsageRow key={index} message={item} />
			))}
		</div>
	);
}
