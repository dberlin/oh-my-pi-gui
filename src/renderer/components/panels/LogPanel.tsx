/**
 * Log panel: subscribes to batched log:line IPC, keeps a 1000-line ring buffer,
 * with search filtering, level filter, and pin-aware auto-scroll.
 */

import { ArrowDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { acceptsActiveTabEvents } from "../../lib/tab-routing";

const MAX_LINES = 1000;

type LogLevel = "info" | "warn" | "error" | "other";

interface LogLine {
	seq: number;
	text: string;
	level: LogLevel;
}

const LEVEL_CLASS: Record<LogLevel, string> = {
	info: "text-(--omp-muted)",
	warn: "text-(--omp-warning)",
	error: "text-(--omp-error)",
	other: "text-(--omp-dim)",
};

const LEVEL_LABEL_KEY = {
	all: "logPanel.level.all",
	info: "logPanel.level.info",
	warn: "logPanel.level.warn",
	error: "logPanel.level.error",
} as const;

let nextSeq = 0;

function detectLevel(text: string): LogLevel {
	const lower = text.toLowerCase();
	if (/\b(error|err!|fatal)\b/.test(lower)) return "error";
	if (/\b(warn|warning)\b/.test(lower)) return "warn";
	if (/\binfo\b/.test(lower)) return "info";
	return "other";
}

export function LogPanel() {
	const t = useT();
	const [lines, setLines] = useState<LogLine[]>([]);
	const [query, setQuery] = useState("");
	const [levelFilter, setLevelFilter] = useState<"all" | LogLevel>("all");
	const [pinned, setPinned] = useState(true);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		// Lines arrive batched (LogWatcher flushes every 150ms): one setState
		// per batch instead of one per line.
		const unsubscribe = window.omp.events.onLogLines(batch => {
			if (!acceptsActiveTabEvents()) return;
			setLines(prev => {
				const appended = batch.map(text => ({ seq: nextSeq++, text, level: detectLevel(text) }));
				const next = [...prev, ...appended];
				return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
			});
		});
		return unsubscribe;
	}, []);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return lines.filter(line => {
			if (levelFilter !== "all" && line.level !== levelFilter) return false;
			return q.length === 0 || line.text.toLowerCase().includes(q);
		});
	}, [lines, query, levelFilter]);

	// Follow the tail whenever pinned and new (filtered) lines render.
	useEffect(() => {
		if (!pinned) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = filtered.length === 0 ? 0 : el.scrollHeight;
	}, [pinned, filtered]);

	const onScroll = () => {
		const el = scrollRef.current;
		if (!el) return;
		setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
	};

	const jumpToBottom = () => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
		setPinned(true);
	};

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
				<span className="text-[10px] font-medium tracking-widest text-(--omp-dim) uppercase">
					{t("logPanel.title")}
				</span>
				<span className="text-[10px] tabular-nums text-(--omp-dim)">{filtered.length}</span>
				<div className="ml-auto flex items-center gap-0.5">
					{(["all", "info", "warn", "error"] as const).map(level => (
						<button
							className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
								levelFilter === level
									? "bg-(--omp-selected-bg) text-(--omp-text)"
									: "text-(--omp-dim) hover:text-(--omp-text)"
							}`}
							key={level}
							onClick={() => setLevelFilter(level)}
							type="button"
						>
							{t(LEVEL_LABEL_KEY[level])}
						</button>
					))}
				</div>
			</div>
			<div className="relative px-3 pb-1.5">
				<Search
					className="pointer-events-none absolute top-1/2 left-5.5 -translate-y-1/2 text-(--omp-dim)"
					size={11}
				/>
				<input
					aria-label={t("logPanel.searchLabel")}
					className="w-full rounded-md border border-(--omp-border-muted) bg-(--omp-bg-primary) py-1 pr-7 pl-6.5 text-[11px] text-(--omp-text) placeholder:text-(--omp-dim) focus:border-(--omp-border-accent) focus:outline-none"
					onChange={event => setQuery(event.target.value)}
					placeholder={t("logPanel.placeholder")}
					value={query}
				/>
				{query && (
					<button
						aria-label={t("logPanel.clearSearch")}
						className="absolute top-1/2 right-5 -translate-y-1/2 text-(--omp-dim) hover:text-(--omp-text)"
						onClick={() => setQuery("")}
						type="button"
					>
						<X size={11} />
					</button>
				)}
			</div>
			<div className="relative min-h-0 flex-1">
				<div
					className="h-full overflow-y-auto px-3 py-1 font-mono text-[10.5px] leading-[1.5]"
					onScroll={onScroll}
					ref={scrollRef}
				>
					{filtered.length === 0 ? (
						<div className="py-8 text-center font-sans text-[11px] text-(--omp-dim)">
							{lines.length === 0 ? t("logPanel.waiting") : t("logPanel.noMatch")}
						</div>
					) : (
						filtered.map(line => (
							<div className={`break-all whitespace-pre-wrap ${LEVEL_CLASS[line.level]}`} key={line.seq}>
								{line.text}
							</div>
						))
					)}
				</div>
				{!pinned && (
					<button
						aria-label={t("logPanel.jumpLabel")}
						className="absolute right-3 bottom-3 flex items-center gap-1 rounded-full border border-(--omp-border-muted) bg-(--omp-bg-secondary) px-2 py-1 text-[10px] text-(--omp-muted) shadow-lg shadow-black/40 transition-colors hover:text-(--omp-text)"
						onClick={jumpToBottom}
						type="button"
					>
						<ArrowDown size={10} />
						{t("logPanel.latest")}
					</button>
				)}
			</div>
		</div>
	);
}
