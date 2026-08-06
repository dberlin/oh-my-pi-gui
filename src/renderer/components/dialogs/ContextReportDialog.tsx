import { useEffect, useState } from "react";
import type { RpcContextReportResult } from "../../../shared/rpc-types";
import { formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Modal, ProgressBar, Spinner } from "../common";

interface CategoryRow {
	key: string;
	tokens: number;
	color: string;
}

/**
 * Native /context: per-category token bars over the provider-anchored
 * breakdown returned by get_context_report. Bars are sized against the full
 * context window so their sum (plus Free) always fills it — the TUI grid's
 * invariant.
 */
export function ContextReportDialog() {
	const t = useT();
	const open = useUiStore(state => state.contextReportOpen);
	const close = useUiStore(state => state.closeContextReport);
	const [report, setReport] = useState<RpcContextReportResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setReport(null);
		setError(null);
		setLoading(true);
		void window.omp.rpc
			.getContextReport()
			.then(response => {
				if (cancelled) return;
				if (response.success) setReport(response.data as RpcContextReportResult);
				else setError(response.error);
			})
			.catch(cause => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const breakdown = report?.breakdown;
	const contextWindow = report?.contextWindow ?? 0;
	const categories: CategoryRow[] = [];
	if (breakdown && contextWindow > 0) {
		const rows: CategoryRow[] = [
			{
				key: "systemPrompt",
				tokens: breakdown.systemPromptTokens,
				color: "var(--omp-accent)",
			},
			{
				key: "systemContext",
				tokens: breakdown.systemContextTokens,
				color: "var(--omp-dim)",
			},
			{
				key: "systemTools",
				tokens: breakdown.systemToolsTokens,
				color: "var(--omp-warning)",
			},
			{ key: "skills", tokens: breakdown.skillsTokens, color: "var(--omp-success)" },
			{ key: "messages", tokens: breakdown.messagesTokens, color: "var(--omp-link)" },
		];
		for (const row of rows) {
			if (row.tokens > 0) categories.push(row);
		}
		const free = contextWindow - breakdown.usedTokens;
		if (free > 0) categories.push({ key: "free", tokens: free, color: "var(--omp-muted)" });
	}
	const usedPercent = breakdown && contextWindow > 0 ? Math.round((breakdown.usedTokens / contextWindow) * 100) : 0;

	return (
		<Modal onClose={close} open={open} size="md" title={t("contextReport.title")}>
			{loading ? (
				<div className="flex items-center justify-center gap-2 py-8 text-sm text-(--omp-dim)">
					<Spinner size="sm" /> {t("contextReport.loading")}
				</div>
			) : error ? (
				<div className="py-4 text-sm text-(--omp-error)">
					{t("contextReport.error")}: {error}
				</div>
			) : !report || contextWindow <= 0 ? (
				<div className="py-4 text-sm text-(--omp-dim)">{t("contextReport.unavailable")}</div>
			) : (
				<div className="space-y-4">
					<div className="flex items-baseline justify-between gap-3">
						<div className="min-w-0 truncate text-sm font-medium text-(--omp-text)">
							{report.model || t("contextReport.noModel")}
						</div>
						<div className="shrink-0 text-xs tabular-nums text-(--omp-dim)">
							{breakdown
								? t("contextReport.usedOf", {
										used: formatTokens(breakdown.usedTokens),
										window: formatTokens(contextWindow),
										percent: usedPercent,
									})
								: formatTokens(contextWindow)}
						</div>
					</div>
					{breakdown ? (
						<>
							<div className="space-y-2">
								{categories.map(row => {
									const fraction = row.tokens / contextWindow;
									return (
										<div className="flex items-center gap-3" key={row.key}>
											<span className="w-28 shrink-0 truncate text-xs text-(--omp-text)">
												{t(`contextReport.cat.${row.key}`)}
											</span>
											<ProgressBar
												className="flex-1"
												color={row.color}
												height={8}
												value={fraction}
												valueText={`${formatTokens(row.tokens)} · ${Math.round(fraction * 100)}%`}
											/>
										</div>
									);
								})}
							</div>
							<div className="text-xs text-(--omp-dim)">
								{breakdown.anchored ? t("contextReport.anchored") : t("contextReport.estimated")}
							</div>
						</>
					) : null}
				</div>
			)}
		</Modal>
	);
}
