/**
 * Requests: the canonical stats server's bounded recent request list, with a
 * detail drawer that fetches /api/request/:id on row click.
 */

import { useEffect, useMemo, useState } from "react";
import type { RequestDetail, RequestRow } from "../../../shared/stats-types";
import { useStatsList } from "../../hooks/use-stats";
import { compact, formatMs, formatUsd } from "../../lib/chart";
import { useT } from "../../lib/i18n";
import { Badge, Modal, Spinner } from "../common";
import { RouteFrame, SectionTitle, type StatColumn, StatTable } from "./shared";

const RECENT_LIMIT = 100;

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
				if (result && typeof result === "object" && "error" in result) throw new Error(String(result.error));
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
		<Modal
			open
			onClose={onClose}
			size="lg"
			title={`${row.model} · ${new Date(row.timestamp).toLocaleString()}`}
			bodyClassName="p-0"
			panelClassName="ml-auto mr-0"
		>
			<div className="min-h-0 flex-1 overflow-y-auto p-4">
				<div className="mb-3 grid grid-cols-2 gap-2 text-omp-sm">
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
						<div className="rounded-md border border-(--omp-border-muted) px-2.5 py-1.5" key={label}>
							<div className="text-omp-xxs font-semibold tracking-widest text-(--omp-dim) uppercase">
								{label}
							</div>
							<div className="mt-0.5 truncate font-mono text-(--omp-text)">{value}</div>
						</div>
					))}
				</div>
				{row.errorMessage && (
					<div className="mb-3 rounded-md border border-[color-mix(in_srgb,var(--omp-error)_40%,transparent)] bg-transparent px-3 py-2 font-mono text-omp-xs break-words text-(--omp-error)">
						{row.errorMessage}
					</div>
				)}
				<SectionTitle>{t("stats.requests.payload")}</SectionTitle>
				{loading ? (
					<div className="flex items-center gap-2 py-4">
						<Spinner size="sm" />
						<span className="text-omp-sm text-(--omp-dim)">{t("stats.requests.loadingDetail")}</span>
					</div>
				) : error ? (
					<div className="text-omp-sm text-(--omp-error)">{error}</div>
				) : (
					<pre className="max-h-[45vh] overflow-auto rounded-md border border-(--omp-border-muted) bg-(--omp-code-bg) p-3 font-mono text-omp-xs leading-[1.5] break-words whitespace-pre-wrap text-(--omp-muted)">
						{JSON.stringify({ messages: detail?.messages, output: detail?.output }, null, 2)?.slice(0, 40_000) ??
							t("stats.requests.emptyPayload")}
					</pre>
				)}
			</div>
		</Modal>
	);
}

export function RequestsRoute({ refreshKey }: { refreshKey: number }) {
	const t = useT();
	// Upstream supports only limit: neither range filtering nor server pagination.
	const { data, isLoading, error, refetch } = useStatsList<RequestRow>("/api/stats/recent", {
		limit: String(RECENT_LIMIT),
	});
	const [selected, setSelected] = useState<RequestRow | null>(null);
	useEffect(() => {
		if (refreshKey > 0) refetch();
	}, [refreshKey, refetch]);
	const rows = data ?? [];

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
						<span className="block text-omp-xs text-(--omp-dim)">{row.provider}</span>
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
				render: row => <span className="text-omp-xs text-(--omp-dim)">{row.folder}</span>,
			},
		],
		[t],
	);

	return (
		<RouteFrame hasData={data !== null} empty={rows.length === 0} error={error} loading={isLoading} onRetry={refetch}>
			<SectionTitle>{t("stats.requests.sectionTitle", { count: rows.length })}</SectionTitle>
			<StatTable
				columns={columns}
				keyFor={row => `${row.id ?? row.entryId}-${row.timestamp}`}
				onRowClick={setSelected}
				rows={rows}
			/>
			<p className="mt-2 text-omp-xs text-(--omp-dim)">{t("stats.requests.rowHint")}</p>
			{selected && <DetailDrawer onClose={() => setSelected(null)} row={selected} />}
		</RouteFrame>
	);
}
