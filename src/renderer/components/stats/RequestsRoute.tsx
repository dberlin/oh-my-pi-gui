/**
 * Requests: paginated table of recent requests with a detail drawer that
 * fetches /api/request/:id on row click.
 */

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useStats } from "../../hooks/use-stats";
import { compact, formatMs, formatUsd } from "../../lib/chart";
import { useT } from "../../lib/i18n";
import { Badge, Button, Spinner } from "../common";
import type { StatsRange } from "./StatsDashboard";
import { RouteFrame, SectionTitle, type StatColumn, StatTable } from "./shared";

const PAGE_SIZE = 25;

interface RequestRow {
	id?: number;
	entryId: string;
	sessionFile: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stopReason: string;
	errorMessage: string | null;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: { total: number };
	};
}

interface RequestDetail extends RequestRow {
	messages: unknown[];
	output: unknown;
}

function DetailDrawer({ row, onClose }: { row: RequestRow; onClose: () => void }) {
	const t = useT();
	const [detail, setDetail] = useState<RequestDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (row.id === undefined) {
			setDetail(null);
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		window.omp.stats
			.fetch(`/api/request/${row.id}`)
			.then(result => {
				if (!cancelled) setDetail(result as RequestDetail);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [row.id]);

	return (
		<div className="fixed inset-0 z-[60] flex justify-end bg-black/40" role="presentation">
			<div className="flex h-full w-[560px] max-w-[92vw] flex-col border-l border-(--omp-border-muted) bg-(--omp-bg-secondary) shadow-2xl">
				<div className="flex items-center justify-between gap-2 border-b border-(--omp-border-muted) px-4 py-2.5">
					<span className="min-w-0 truncate font-mono text-xs font-semibold text-(--omp-text)">
						{row.model}
						<span className="ml-2 font-normal text-(--omp-dim)">{new Date(row.timestamp).toLocaleString()}</span>
					</span>
					<button
						aria-label={t("stats.requests.closeDetails")}
						className="rounded p-1 text-(--omp-muted) transition-colors hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
						onClick={onClose}
						type="button"
					>
						<X size={14} />
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					<div className="mb-3 grid grid-cols-2 gap-2 text-[11px]">
						{[
							[t("stats.col.provider"), row.provider],
							[t("stats.requests.detail.api"), row.api],
							[t("stats.requests.detail.stopReason"), row.stopReason],
							[t("stats.col.duration"), formatMs(row.duration)],
							[t("stats.col.ttft"), formatMs(row.ttft)],
							[t("stats.col.cost"), formatUsd(row.usage?.cost?.total ?? 0)],
							[t("stats.requests.detail.input"), compact(row.usage?.input ?? 0)],
							[t("stats.requests.detail.output"), compact(row.usage?.output ?? 0)],
							[t("stats.requests.detail.cacheRead"), compact(row.usage?.cacheRead ?? 0)],
							[t("stats.requests.detail.cacheWrite"), compact(row.usage?.cacheWrite ?? 0)],
						].map(([label, value]) => (
							<div
								className="rounded-md border border-(--omp-border-muted) bg-(--omp-bg-primary) px-2.5 py-1.5"
								key={label}
							>
								<div className="text-[9px] font-semibold tracking-widest text-(--omp-dim) uppercase">
									{label}
								</div>
								<div className="mt-0.5 truncate font-mono text-(--omp-text)">{value}</div>
							</div>
						))}
					</div>
					{row.errorMessage && (
						<div className="mb-3 rounded-md border border-[color-mix(in_srgb,var(--omp-error)_40%,transparent)] bg-[color-mix(in_srgb,var(--omp-error)_8%,transparent)] px-3 py-2 font-mono text-[10.5px] break-words text-(--omp-error)">
							{row.errorMessage}
						</div>
					)}
					<SectionTitle>{t("stats.requests.payload")}</SectionTitle>
					{loading ? (
						<div className="flex items-center gap-2 py-4">
							<Spinner size="sm" />
							<span className="text-[11px] text-(--omp-dim)">{t("stats.requests.loadingDetail")}</span>
						</div>
					) : error ? (
						<div className="text-[11px] text-(--omp-error)">{error}</div>
					) : (
						<pre className="max-h-[45vh] overflow-auto rounded-md border border-(--omp-border-muted) bg-(--omp-code-bg) p-3 font-mono text-[10px] leading-[1.5] break-words whitespace-pre-wrap text-(--omp-muted)">
							{JSON.stringify({ messages: detail?.messages, output: detail?.output }, null, 2)?.slice(
								0,
								40_000,
							) ?? t("stats.requests.emptyPayload")}
						</pre>
					)}
				</div>
			</div>
		</div>
	);
}

export function RequestsRoute({ range, refreshKey }: { range: StatsRange; refreshKey: number }) {
	const t = useT();
	const params = useMemo(() => ({ range, limit: "200" }), [range]);
	const { data, isLoading, error, refetch } = useStats("/api/stats/recent", params);
	const [page, setPage] = useState(0);
	const [selected, setSelected] = useState<RequestRow | null>(null);

	useEffect(() => {
		if (refreshKey > 0) refetch();
	}, [refreshKey, refetch]);

	useEffect(() => {
		setPage(0);
	}, []);

	const rows = useMemo(() => {
		const list = Array.isArray(data) ? (data as RequestRow[]) : [];
		return [...list].sort((a, b) => b.timestamp - a.timestamp);
	}, [data]);

	const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
	const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

	const columns: StatColumn<RequestRow>[] = useMemo(
		() => [
			{
				key: "time",
				label: t("stats.col.when"),
				render: row => (
					<span className="whitespace-nowrap text-(--omp-muted)">
						{new Date(row.timestamp).toLocaleString(undefined, {
							month: "short",
							day: "numeric",
							hour: "2-digit",
							minute: "2-digit",
							second: "2-digit",
						})}
					</span>
				),
			},
			{
				key: "model",
				label: t("stats.col.model"),
				render: row => (
					<span>
						<span className="block font-mono text-(--omp-text)">{row.model}</span>
						<span className="block text-[10px] text-(--omp-dim)">{row.provider}</span>
					</span>
				),
			},
			{
				key: "status",
				label: t("stats.col.status"),
				render: row =>
					row.errorMessage ? (
						<Badge variant="error">{row.stopReason || "error"}</Badge>
					) : (
						<Badge variant="success">{row.stopReason || "ok"}</Badge>
					),
			},
			{ key: "duration", label: t("stats.col.duration"), align: "right", render: row => formatMs(row.duration) },
			{ key: "ttft", label: t("stats.col.ttft"), align: "right", render: row => formatMs(row.ttft) },
			{
				key: "tokens",
				label: t("stats.col.tokens"),
				align: "right",
				render: row => compact(row.usage?.totalTokens ?? 0),
			},
			{
				key: "cost",
				label: t("stats.col.cost"),
				align: "right",
				render: row => formatUsd(row.usage?.cost?.total ?? 0),
			},
			{
				key: "folder",
				label: t("stats.col.project"),
				render: row => <span className="text-[10px] text-(--omp-dim)">{row.folder}</span>,
			},
		],
		[t],
	);

	return (
		<RouteFrame empty={rows.length === 0} error={error} loading={isLoading} onRetry={refetch}>
			<SectionTitle>{t("stats.requests.sectionTitle", { count: rows.length })}</SectionTitle>
			<StatTable
				columns={columns}
				keyFor={row => `${row.id ?? row.entryId}-${row.timestamp}`}
				onRowClick={setSelected}
				rows={pageRows}
			/>
			<div className="mt-2 flex items-center justify-between">
				<span className="text-[10px] text-(--omp-dim)">{t("stats.requests.rowHint")}</span>
				<div className="flex items-center gap-1.5">
					<Button
						disabled={page === 0}
						icon={<ChevronLeft size={11} />}
						onClick={() => setPage(p => Math.max(0, p - 1))}
						size="sm"
						variant="ghost"
					>
						{t("stats.requests.prev")}
					</Button>
					<span className="text-[10px] tabular-nums text-(--omp-muted)">
						{page + 1} / {pages}
					</span>
					<Button
						disabled={page >= pages - 1}
						onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
						size="sm"
						trailingIcon={<ChevronRight size={11} />}
						variant="ghost"
					>
						{t("stats.requests.next")}
					</Button>
				</div>
			</div>
			{selected && <DetailDrawer onClose={() => setSelected(null)} row={selected} />}
		</RouteFrame>
	);
}
