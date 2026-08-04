/**
 * Usage window: provider quota reports (limit bars with reset countdowns)
 * plus local session token/cost tallies. Fed by rpc.getUsage().
 */

import { Coins, Database, RefreshCw, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { UsageLimit, UsageReport, UsageResult } from "../../../shared/rpc-types";
import { formatDuration, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, Modal, ProgressBar, Spinner } from "../common";

function resetCountdown(
	resetsAt: number | undefined,
	t: (k: string, p?: Record<string, string | number>) => string,
): string | null {
	if (!resetsAt) return null;
	const ms = resetsAt - Date.now();
	if (ms <= 0) return t("usage.resetting");
	return t("usage.resetsIn", { time: formatDuration(ms) });
}

function limitValueText(limit: UsageLimit, t: (k: string, p?: Record<string, string | number>) => string): string {
	const unit = limit.unit === "percent" ? "%" : ` ${limit.unit ?? ""}`;
	if (limit.used !== undefined && limit.limit !== undefined) {
		return `${limit.used.toFixed(limit.unit === "percent" ? 1 : 0)}${unit} / ${limit.limit.toFixed(0)}${unit}`;
	}
	if (limit.used !== undefined) return t("usage.valueUsed", { value: `${limit.used.toFixed(1)}${unit}` });
	if (limit.usedFraction !== undefined) return `${(limit.usedFraction * 100).toFixed(1)}%`;
	return t("usage.valueUnknown");
}

function LimitRow({ limit, t }: { limit: UsageLimit; t: (k: string, p?: Record<string, string | number>) => string }) {
	const fraction = limit.usedFraction ?? (limit.used !== undefined && limit.limit ? limit.used / limit.limit : 0);
	return (
		<div className="flex flex-col gap-1 py-1.5">
			<div className="flex items-center justify-between gap-2">
				<span className="text-[12px] font-medium text-[var(--omp-text)]">{limit.label}</span>
				<div className="flex items-center gap-2">
					{limit.status && limit.status !== "ok" && (
						<Badge variant={limit.status === "exhausted" ? "error" : "warning"}>{limit.status}</Badge>
					)}
					<span className="font-mono text-[11px] tabular-nums text-[var(--omp-muted)]">
						{limitValueText(limit, t)}
					</span>
				</div>
			</div>
			<ProgressBar value={fraction} height={5} valueText={`${Math.round(fraction * 100)}%`} />
			{resetCountdown(limit.resetsAt, t) && (
				<span className="text-[10px] text-[var(--omp-dim)]">{resetCountdown(limit.resetsAt, t)}</span>
			)}
			{limit.notes && limit.notes.length > 0 && (
				<div className="flex flex-col gap-0.5">
					{limit.notes.map(note => (
						<span key={note} className="text-[10px] text-[var(--omp-dim)]">
							{note}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

function ProviderReportCard({
	report,
	t,
}: {
	report: UsageReport;
	t: (k: string, p?: Record<string, string | number>) => string;
}) {
	return (
		<div className="rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] p-3">
			<div className="mb-2 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="text-[13px] font-semibold text-[var(--omp-text)]">{report.provider}</span>
					{report.account && <span className="text-[11px] text-[var(--omp-muted)]">{report.account}</span>}
				</div>
				{report.resetCreditsAvailable !== undefined && report.resetCreditsAvailable > 0 && (
					<Badge variant="info">{t("usage.resetsAvailable", { count: report.resetCreditsAvailable })}</Badge>
				)}
			</div>
			{report.notes && report.notes.length > 0 && (
				<div className="mb-2 flex flex-col gap-0.5">
					{report.notes.map(note => (
						<span key={note} className="text-[10px] text-[var(--omp-dim)]">
							{note}
						</span>
					))}
				</div>
			)}
			<div className="divide-y divide-[var(--omp-border-muted)]">
				{report.limits.map(limit => (
					<LimitRow key={limit.id} limit={limit} t={t} />
				))}
			</div>
		</div>
	);
}

export function UsageWindow() {
	const open = useUiStore(s => s.usageOpen);
	const close = useUiStore(s => s.closeUsage);
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const [result, setResult] = useState<UsageResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		if (!sidecarReady) {
			setError(t("usage.notConnected"));
			setLoading(false);
			return;
		}
		try {
			const res = await window.omp.rpc.getUsage();
			if (res.success) setResult(res.data as UsageResult);
			else setError(res.error);
		} catch (cause) {
			setError(String(cause));
		} finally {
			setLoading(false);
		}
	}, [sidecarReady, t]);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	const session = result?.session;
	const sessionRows = session
		? [
				{ icon: Zap, label: t("usage.inputTokens"), value: formatTokens(session.input) },
				{ icon: Database, label: t("usage.outputTokens"), value: formatTokens(session.output) },
				{ icon: Database, label: t("usage.cacheRead"), value: formatTokens(session.cacheRead) },
				{ icon: Database, label: t("usage.cacheWrite"), value: formatTokens(session.cacheWrite) },
				{ icon: Coins, label: t("usage.totalTokens"), value: formatTokens(session.totalTokens) },
				...(session.orchestrationTokens > 0
					? [{ icon: Zap, label: t("usage.orchestration"), value: formatTokens(session.orchestrationTokens) }]
					: []),
				{ icon: Coins, label: t("usage.premiumRequests"), value: String(session.premiumRequests) },
				{ icon: Coins, label: t("usage.cost"), value: `$${session.cost.toFixed(6)}` },
			]
		: [];

	return (
		<Modal open={open} onClose={close} title={t("usage.title")} size="lg">
			<div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
				<div className="flex items-center justify-between">
					<span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--omp-muted)]">
						{t("usage.providerQuotas")}
					</span>
					<Button
						size="sm"
						variant="ghost"
						icon={<RefreshCw size={12} />}
						onClick={() => void load()}
						loading={loading}
					>
						{t("usage.refresh")}
					</Button>
				</div>

				{error && (
					<div className="rounded-md bg-[var(--omp-tool-error-bg)] px-3 py-2 text-[12px] text-[var(--omp-error)]">
						{error}
					</div>
				)}
				{loading && !result && (
					<div className="flex items-center justify-center py-8">
						<Spinner />
					</div>
				)}

				{result && result.reports.length === 0 && !loading && (
					<div className="rounded-md border border-[var(--omp-border-muted)] px-3 py-4 text-center text-[12px] text-[var(--omp-dim)]">
						{t("usage.noApi")}
					</div>
				)}

				{result && result.reports.length > 0 && (
					<div className="flex flex-col gap-3">
						{result.reports.map(report => (
							<ProviderReportCard key={`${report.provider}-${report.account ?? ""}`} report={report} t={t} />
						))}
					</div>
				)}

				{session && (
					<>
						<span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--omp-muted)]">
							{t("usage.sessionTallies")}
						</span>
						<div className="grid grid-cols-2 gap-2">
							{sessionRows.map(({ icon: Icon, label, value }) => (
								<div
									key={label}
									className="flex items-center gap-2 rounded-md border border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] px-3 py-2"
								>
									<Icon size={13} className="text-[var(--omp-dim)]" />
									<span className="flex-1 text-[12px] text-[var(--omp-muted)]">{label}</span>
									<span className="font-mono text-[12px] font-medium tabular-nums text-[var(--omp-text)]">
										{value}
									</span>
								</div>
							))}
						</div>
					</>
				)}
			</div>
		</Modal>
	);
}
