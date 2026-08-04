/**
 * Diff panel: latest edit-tool diffs from the tools store, with a file
 * selector when several edits exist, and unified/split view toggle.
 * Unified rendering delegates to lib/diff DiffView; split mode is built
 * on parseDiff directly.
 *
 * The Timeline view is a chronological feed of every edit/write/apply_patch
 * operation this session (same tools-store source), grouped by file with
 * per-file cumulative and session-total +/- summaries plus an activity
 * strip; the feed is virtualized to handle many edits.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Columns2, FileCode2, Rows3 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type DiffLine, DiffView, parseDiff } from "../../lib/diff";
import { basename, dirname, formatClock, formatTimeAgo, resultDetails } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useToolsStore } from "../../stores/tools";

const DIFF_TOOLS = new Set(["edit", "apply_patch", "ast_edit", "write"]);

interface DiffCandidate {
	id: string;
	toolName: string;
	file: string;
	diff: string;
	timestamp: number;
	adds: number;
	removes: number;
	isError: boolean;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Best-effort file name from tool args, result details, or hashline input header. */
function deriveFile(args: Record<string, unknown>, diff: string, details: Record<string, unknown> | undefined): string {
	const path =
		asString(args.path) ??
		asString(args.file_path) ??
		asString(args.file) ??
		asString(details?.path) ??
		asString(details?.resolvedPath) ??
		firstPerFilePath(details?.perFileResults);
	if (path) return path;
	const header = diff.match(/^\[([^\]#]+)#/);
	return header?.[1] ?? "edit";
}

/** Joined non-empty per-file diffs of a multi-file edit result, when present. */
function perFileDiff(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	const diffs: string[] = [];
	for (const entry of value) {
		if (entry == null || typeof entry !== "object") continue;
		const diff = (entry as Record<string, unknown>).diff;
		if (typeof diff === "string" && diff.length > 0) diffs.push(diff);
	}
	return diffs.length > 0 ? diffs.join("\n") : null;
}

/** First per-file path of a multi-file edit result, when present. */
function firstPerFilePath(value: unknown): string | null {
	if (!Array.isArray(value)) return null;
	for (const entry of value) {
		if (entry == null || typeof entry !== "object") continue;
		const path = (entry as Record<string, unknown>).path;
		if (typeof path === "string" && path.length > 0) return path;
	}
	return null;
}

/** Cheap +/- line counter mirroring parseDiff's prefix rules (no per-line objects). */
function countChanges(diff: string): { adds: number; removes: number } {
	let adds = 0;
	let removes = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) adds += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removes += 1;
	}
	return { adds, removes };
}

/** Pair remove/add runs into side-by-side rows for split view. */
function toSplitRows(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
	const rows: { left: DiffLine | null; right: DiffLine | null }[] = [];
	let removes: DiffLine[] = [];
	const flush = (adds: DiffLine[]) => {
		const width = Math.max(removes.length, adds.length);
		for (let i = 0; i < width; i++) {
			rows.push({ left: removes[i] ?? null, right: adds[i] ?? null });
		}
		removes = [];
	};
	let adds: DiffLine[] = [];
	for (const line of lines) {
		if (line.type === "remove") {
			if (adds.length > 0) {
				flush(adds);
				adds = [];
			}
			removes.push(line);
		} else if (line.type === "add") {
			adds.push(line);
		} else {
			if (removes.length > 0 || adds.length > 0) {
				flush(adds);
				adds = [];
			}
			rows.push({ left: line, right: line });
		}
	}
	if (removes.length > 0 || adds.length > 0) flush(adds);
	return rows;
}

const LINE_CLASS: Record<DiffLine["type"], string> = {
	add: "bg-[color-mix(in_srgb,var(--omp-diff-added)_12%,transparent)] text-(--omp-diff-added)",
	remove: "bg-[color-mix(in_srgb,var(--omp-diff-removed)_12%,transparent)] text-(--omp-diff-removed)",
	context: "text-(--omp-diff-context)",
};

function SplitDiff({ diff }: { diff: string }) {
	const rows = useMemo(() => toSplitRows(parseDiff(diff)), [diff]);
	return (
		<div className="grid grid-cols-2 gap-px overflow-x-auto rounded-md border border-(--omp-border-muted) bg-(--omp-border-muted) font-mono text-[11px] leading-[1.45]">
			{(["left", "right"] as const).map(side => (
				<div className="min-w-0 bg-(--omp-code-bg)" key={side}>
					{rows.map((row, index) => {
						const line = row[side];
						return (
							<div
								className={`px-2 whitespace-pre ${line ? LINE_CLASS[line.type] : "bg-(--omp-bg-primary) text-transparent"}`}
								key={index}
							>
								{line
									? `${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.content}`
									: "·"}
							</div>
						);
					})}
				</div>
			))}
		</div>
	);
}

// ─── Timeline view ──────────────────────────────────────────────────────────

interface FileGroup {
	file: string;
	edits: DiffCandidate[];
	adds: number;
	removes: number;
	latest: number;
}

/** Group edits (already newest-first) by file; groups sorted by latest activity. */
function buildFileGroups(candidates: DiffCandidate[]): FileGroup[] {
	const byFile = new Map<string, FileGroup>();
	for (const candidate of candidates) {
		let group = byFile.get(candidate.file);
		if (!group) {
			group = { file: candidate.file, edits: [], adds: 0, removes: 0, latest: 0 };
			byFile.set(candidate.file, group);
		}
		group.edits.push(candidate);
		group.adds += candidate.adds;
		group.removes += candidate.removes;
		group.latest = Math.max(group.latest, candidate.timestamp);
	}
	return [...byFile.values()].sort((a, b) => b.latest - a.latest);
}

type TimelineRow = { kind: "file"; group: FileGroup } | { kind: "edit"; entry: DiffCandidate };

const ACTIVITY_BINS = 36;

/** Compact sparkline/heat strip of edit activity across the session time span. */
function ActivityStrip({ edits }: { edits: DiffCandidate[] }) {
	const t = useT();
	const activity = useMemo(() => {
		const bins = Array.from({ length: ACTIVITY_BINS }, () => ({ adds: 0, removes: 0, edits: 0 }));
		// `edits` arrives newest-first.
		const start = edits[edits.length - 1]?.timestamp ?? 0;
		const end = edits[0]?.timestamp ?? start;
		const span = Math.max(1, end - start);
		let peak = 1;
		for (const edit of edits) {
			const index = Math.min(ACTIVITY_BINS - 1, Math.floor(((edit.timestamp - start) / span) * ACTIVITY_BINS));
			const bin = bins[index];
			if (!bin) continue;
			bin.adds += edit.adds;
			bin.removes += edit.removes;
			bin.edits += 1;
			peak = Math.max(peak, bin.adds + bin.removes);
		}
		return { bins, peak, start, span };
	}, [edits]);

	return (
		<div aria-hidden className="flex h-7 items-stretch gap-px">
			{activity.bins.map((bin, index) => {
				const total = bin.adds + bin.removes;
				const binStart = activity.start + (activity.span * index) / ACTIVITY_BINS;
				const binEnd = activity.start + (activity.span * (index + 1)) / ACTIVITY_BINS;
				return (
					<div
						className="flex min-w-0 flex-1 flex-col justify-end"
						key={index}
						title={
							total === 0
								? undefined
								: t("diffPanel.activity", {
										edits: bin.edits,
										plural: bin.edits === 1 ? "" : "s",
										adds: bin.adds,
										removes: bin.removes,
										start: formatClock(binStart),
										end: formatClock(binEnd),
									})
						}
					>
						{total > 0 && (
							<div
								className="flex w-full flex-col overflow-hidden rounded-[2px]"
								style={{ height: `${Math.max(15, (total / activity.peak) * 100)}%` }}
							>
								<div className="bg-(--omp-diff-removed)" style={{ height: `${(bin.removes / total) * 100}%` }} />
								<div className="bg-(--omp-diff-added)" style={{ height: `${(bin.adds / total) * 100}%` }} />
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

function FileGroupHeader({
	group,
	collapsed,
	onToggle,
}: {
	group: FileGroup;
	collapsed: boolean;
	onToggle: () => void;
}) {
	const base = basename(group.file);
	const dir = dirname(group.file);
	// dirname() returns "/" for directory-less relative paths — hide it there.
	const dirPrefix = dir === "/" ? (group.file.startsWith("/") ? "/" : "") : `${dir}/`;
	return (
		<button
			aria-expanded={!collapsed}
			className="flex w-full items-center gap-1.5 rounded px-1 py-1.5 text-left transition-colors hover:bg-(--omp-selected-bg)"
			onClick={onToggle}
			title={group.file}
			type="button"
		>
			{collapsed ? (
				<ChevronRight className="shrink-0 text-(--omp-dim)" size={12} />
			) : (
				<ChevronDown className="shrink-0 text-(--omp-dim)" size={12} />
			)}
			<FileCode2 className="shrink-0 text-(--omp-dim)" size={12} />
			<span className="min-w-0 truncate font-mono text-[11px] text-(--omp-text)">
				{dirPrefix && <span className="text-(--omp-dim)">{dirPrefix}</span>}
				{base}
			</span>
			<span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
				<span className="text-(--omp-diff-added)">+{group.adds}</span>
				<span className="text-(--omp-diff-removed)">-{group.removes}</span>
				<span className="rounded bg-(--omp-bg-tertiary) px-1 py-px text-[9px] text-(--omp-dim)">
					×{group.edits.length}
				</span>
			</span>
		</button>
	);
}

function EditTimelineRow({
	entry,
	expanded,
	onToggle,
}: {
	entry: DiffCandidate;
	expanded: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	return (
		<div className="pb-0.5 pl-4">
			<button
				aria-expanded={expanded}
				className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left transition-colors hover:bg-(--omp-selected-bg)"
				onClick={onToggle}
				type="button"
			>
				{expanded ? (
					<ChevronDown className="shrink-0 text-(--omp-dim)" size={12} />
				) : (
					<ChevronRight className="shrink-0 text-(--omp-dim)" size={12} />
				)}
				<span className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
					<span className="text-(--omp-diff-added)">+{entry.adds}</span>
					<span className="text-(--omp-diff-removed)">-{entry.removes}</span>
				</span>
				<span className="shrink-0 rounded bg-(--omp-bg-tertiary) px-1.5 py-px text-[9px] text-(--omp-dim)">
					{entry.toolName}
				</span>
				{entry.isError && (
					<span className="shrink-0 rounded bg-(--omp-bg-tertiary) px-1 py-px text-[9px] text-(--omp-diff-removed)">
						{t("diffPanel.error")}
					</span>
				)}
				<span className="ml-auto shrink-0 text-[10px] text-(--omp-dim)" title={formatClock(entry.timestamp)}>
					{formatTimeAgo(new Date(entry.timestamp).toISOString())}
				</span>
			</button>
			{expanded && (
				<div className="mt-0.5 overflow-hidden rounded-md border border-(--omp-border-muted) bg-(--omp-code-bg) py-1">
					<DiffView diff={entry.diff} filePath={entry.file} />
				</div>
			)}
		</div>
	);
}

function DiffTimeline({ candidates }: { candidates: DiffCandidate[] }) {
	const t = useT();
	const groups = useMemo(() => buildFileGroups(candidates), [candidates]);
	const totals = useMemo(() => {
		let adds = 0;
		let removes = 0;
		for (const candidate of candidates) {
			adds += candidate.adds;
			removes += candidate.removes;
		}
		return { adds, removes };
	}, [candidates]);

	const [collapsedFiles, setCollapsedFiles] = useState<ReadonlySet<string>>(new Set());
	const [expandedId, setExpandedId] = useState<string | null>(null);

	const rows = useMemo<TimelineRow[]>(() => {
		const out: TimelineRow[] = [];
		for (const group of groups) {
			out.push({ kind: "file", group });
			if (collapsedFiles.has(group.file)) continue;
			for (const entry of group.edits) out.push({ kind: "edit", entry });
		}
		return out;
	}, [groups, collapsedFiles]);

	const parentRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: index => {
			const row = rows[index];
			if (!row) return 28;
			if (row.kind === "file") return 30;
			return row.entry.id === expandedId ? 280 : 26;
		},
		overscan: 10,
		measureElement: element => element.getBoundingClientRect().height,
	});

	// Expanding/collapsing a diff changes row heights without changing the count.
	useEffect(() => {
		virtualizer.measure();
	}, [virtualizer, expandedId]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="space-y-1.5 px-3 pb-2">
				<div className="flex items-center gap-2 text-[10px] text-(--omp-dim)">
					<span>
						{t("diffPanel.summary", {
							edits: candidates.length,
							editPlural: candidates.length === 1 ? "" : "s",
							files: groups.length,
							filePlural: groups.length === 1 ? "" : "s",
						})}
					</span>
					<span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono">
						<span className="text-(--omp-diff-added)">+{totals.adds}</span>
						<span className="text-(--omp-diff-removed)">-{totals.removes}</span>
					</span>
				</div>
				<ActivityStrip edits={candidates} />
			</div>

			<div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
				<div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
					{virtualizer.getVirtualItems().map(item => {
						const row = rows[item.index];
						if (!row) return null;
						return (
							<div
								data-index={item.index}
								key={row.kind === "file" ? `file:${row.group.file}` : row.entry.id}
								ref={virtualizer.measureElement}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${item.start}px)`,
								}}
							>
								{row.kind === "file" ? (
									<FileGroupHeader
										collapsed={collapsedFiles.has(row.group.file)}
										group={row.group}
										onToggle={() =>
											setCollapsedFiles(previous => {
												const next = new Set(previous);
												if (next.has(row.group.file)) next.delete(row.group.file);
												else next.add(row.group.file);
												return next;
											})
										}
									/>
								) : (
									<EditTimelineRow
										entry={row.entry}
										expanded={expandedId === row.entry.id}
										onToggle={() => setExpandedId(previous => (previous === row.entry.id ? null : row.entry.id))}
									/>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}

export function DiffPanel() {
	const t = useT();
	const activeTools = useToolsStore(state => state.activeTools);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [split, setSplit] = useState(false);
	const [mode, setMode] = useState<"current" | "timeline">("current");

	const candidates = useMemo<DiffCandidate[]>(() => {
		const out: DiffCandidate[] = [];
		for (const [id, entry] of activeTools) {
			if (!DIFF_TOOLS.has(entry.toolName)) continue;
			// Tool results arrive as `{content, details}` envelopes — the real diff
			// lives in details (aggregate `diff`, else joined per-file diffs).
			// Replace-mode edits and hashline/apply_patch all land there; only
			// `write` carries no details diff, so it falls back to its content arg.
			const details = resultDetails(entry.result) ?? resultDetails(entry.partialResult);
			const diff =
				asString(details?.diff) ??
				perFileDiff(details?.perFileResults) ??
				(entry.toolName === "write" ? asString(entry.args.content) : null);
			if (!diff) continue;
			const { adds, removes } = countChanges(diff);
			out.push({
				id,
				toolName: entry.toolName,
				file: deriveFile(entry.args, diff, details),
				diff,
				timestamp: entry.endTime ?? entry.startTime,
				adds,
				removes,
				isError: entry.isError,
			});
		}
		return out.sort((a, b) => b.timestamp - a.timestamp);
	}, [activeTools]);

	const selected = candidates.find(c => c.id === selectedId) ?? candidates[0] ?? null;

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
				<span className="text-[10px] font-medium tracking-widest text-(--omp-dim) uppercase">
					{t("diffPanel.title")}
				</span>
				<div className="flex items-center gap-1">
					<div className="flex items-center gap-0.5 rounded-md border border-(--omp-border-muted) p-0.5">
						{(["current", "timeline"] as const).map(value => (
							<button
								aria-label={value === "current" ? t("diffPanel.mode.currentAria") : t("diffPanel.mode.timelineAria")}
								aria-pressed={mode === value}
								className={`rounded px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase transition-colors ${mode === value ? "bg-(--omp-selected-bg) text-(--omp-text)" : "text-(--omp-dim) hover:text-(--omp-text)"}`}
								key={value}
								onClick={() => setMode(value)}
								type="button"
							>
								{value === "current" ? t("diffPanel.mode.current") : t("diffPanel.mode.timeline")}
							</button>
						))}
					</div>
					{mode === "current" && (
						<div className="flex items-center gap-0.5 rounded-md border border-(--omp-border-muted) p-0.5">
							<button
								aria-label={t("diffPanel.unified")}
								aria-pressed={!split}
								className={`rounded p-1 transition-colors ${!split ? "bg-(--omp-selected-bg) text-(--omp-text)" : "text-(--omp-dim) hover:text-(--omp-text)"}`}
								onClick={() => setSplit(false)}
								type="button"
							>
								<Rows3 size={12} />
							</button>
							<button
								aria-label={t("diffPanel.split")}
								aria-pressed={split}
								className={`rounded p-1 transition-colors ${split ? "bg-(--omp-selected-bg) text-(--omp-text)" : "text-(--omp-dim) hover:text-(--omp-text)"}`}
								onClick={() => setSplit(true)}
								type="button"
							>
								<Columns2 size={12} />
							</button>
						</div>
					)}
				</div>
			</div>

			{candidates.length === 0 ? (
				<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
					<div className="px-3 py-8 text-center text-[11px] leading-relaxed text-(--omp-dim)">
						{t("diffPanel.empty")}
						<br />
						{t("diffPanel.emptyHint")}
					</div>
				</div>
			) : mode === "timeline" ? (
				<DiffTimeline candidates={candidates} />
			) : (
				<>
					{candidates.length > 1 && (
						<div className="px-3 pb-1.5">
							<select
								aria-label={t("diffPanel.selectFile")}
								className="w-full rounded-md border border-(--omp-border-muted) bg-(--omp-bg-primary) px-2 py-1 font-mono text-[11px] text-(--omp-text) focus:border-(--omp-border-accent) focus:outline-none"
								onChange={event => setSelectedId(event.target.value)}
								value={selected?.id ?? ""}
							>
								{candidates.map(candidate => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.file} — {candidate.toolName}
									</option>
								))}
							</select>
						</div>
					)}

					<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
						{selected && (
							<div className="space-y-1.5">
								<div className="flex items-center gap-1.5 text-[11px] text-(--omp-muted)">
									<FileCode2 className="shrink-0 text-(--omp-dim)" size={12} />
									<span className="truncate font-mono">{selected.file}</span>
									<span className="ml-auto shrink-0 rounded bg-(--omp-bg-tertiary) px-1.5 py-px text-[9px] text-(--omp-dim)">
										{selected.toolName}
									</span>
								</div>
								{split ? <SplitDiff diff={selected.diff} /> : <DiffView diff={selected.diff} filePath={selected.file} />}
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
