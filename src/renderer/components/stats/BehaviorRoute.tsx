/**
 * Behavior: user-frustration signals (yelling, profanity, anguish, negation,
 * repetition, blame) — overall cards, per-model table, and a stacked trend.
 */

import { useEffect, useMemo } from "react";
import { Line } from "react-chartjs-2";
import { baseChartOptions, bucketLabels, CHART_COLORS, compact } from "../../lib/chart";
import "../../lib/chart";
import { useStats } from "../../hooks/use-stats";
import { useT } from "../../lib/i18n";
import type { StatsRange } from "./StatsDashboard";
import { ChartBox, MetricCard, RouteFrame, SectionTitle, type StatColumn, StatTable } from "./shared";

interface Overall {
	totalMessages: number;
	totalYelling: number;
	totalProfanity: number;
	totalAnguish: number;
	totalNegation: number;
	totalRepetition: number;
	totalBlame: number;
	totalChars: number;
}

interface ModelRow {
	model: string;
	provider: string;
	totalMessages: number;
	totalYelling: number;
	totalProfanity: number;
	totalAnguish: number;
	totalNegation: number;
	totalRepetition: number;
	totalBlame: number;
	totalChars: number;
}

interface SeriesPoint {
	timestamp: number;
	model: string;
	messages: number;
	yelling: number;
	profanity: number;
	anguish: number;
	negation: number;
	repetition: number;
	blame: number;
}

interface BehaviorData {
	overall: Overall;
	byModel: ModelRow[];
	behaviorSeries: SeriesPoint[];
}

const SIGNALS = [
	{ key: "yelling", labelKey: "stats.behavior.signal.yelling" },
	{ key: "profanity", labelKey: "stats.behavior.signal.profanity" },
	{ key: "anguish", labelKey: "stats.behavior.signal.anguish" },
	{ key: "negation", labelKey: "stats.behavior.signal.negation" },
	{ key: "repetition", labelKey: "stats.behavior.signal.repetition" },
	{ key: "blame", labelKey: "stats.behavior.signal.blame" },
] as const;

type SignalKey = (typeof SIGNALS)[number]["key"];

export function BehaviorRoute({ range, refreshKey }: { range: StatsRange; refreshKey: number }) {
	const t = useT();
	const params = useMemo(() => ({ range }), [range]);
	const { data, isLoading, error, refetch } = useStats("/api/stats/behavior", params);

	useEffect(() => {
		if (refreshKey > 0) refetch();
	}, [refreshKey, refetch]);

	const stats = (data ?? null) as BehaviorData | null;
	const overall = stats?.overall;

	const columns: StatColumn<ModelRow>[] = useMemo(
		() => [
			{
				key: "model",
				label: t("stats.col.model"),
				render: row => (
					<span>
						<span className="block font-mono font-medium text-(--omp-text)">{row.model}</span>
						<span className="block text-[10px] text-(--omp-dim)">{row.provider}</span>
					</span>
				),
			},
			{ key: "messages", label: t("stats.col.messages"), align: "right", render: row => compact(row.totalMessages) },
			...SIGNALS.map(
				(signal): StatColumn<ModelRow> => ({
					key: signal.key,
					label: t(signal.labelKey),
					align: "right",
					render: row => {
						const value = row[
							`total${signal.key[0].toUpperCase()}${signal.key.slice(1)}` as keyof ModelRow
						] as number;
						return value > 0 ? (
							<span className="text-(--omp-warning)">{value}</span>
						) : (
							<span className="text-(--omp-dim)">0</span>
						);
					},
				}),
			),
		],
		[t],
	);

	const trend = useMemo(() => {
		const series = stats?.behaviorSeries ?? [];
		const timestamps = [...new Set(series.map(point => point.timestamp))].sort((a, b) => a - b);
		return {
			labels: bucketLabels(timestamps),
			datasets: SIGNALS.map((signal, index) => ({
				label: t(signal.labelKey),
				data: timestamps.map(ts =>
					series
						.filter(point => point.timestamp === ts)
						.reduce((acc, point) => acc + point[signal.key as SignalKey], 0),
				),
				borderColor: CHART_COLORS[index % CHART_COLORS.length],
				backgroundColor: "transparent",
				tension: 0.3,
				pointRadius: 0,
				borderWidth: 1.5,
			})),
		};
	}, [stats, t]);

	return (
		<RouteFrame empty={!overall || overall.totalMessages === 0} error={error} loading={isLoading} onRetry={refetch}>
			{overall && (
				<>
					<div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 xl:grid-cols-7">
						<MetricCard label={t("stats.col.messages")} tone="accent" value={compact(overall.totalMessages)} />
						{SIGNALS.map(signal => (
							<MetricCard
								key={signal.key}
								label={t(signal.labelKey)}
								tone={
									(overall[
										`total${signal.key[0].toUpperCase()}${signal.key.slice(1)}` as keyof Overall
									] as number) > 0
										? "warning"
										: "default"
								}
								value={String(
									overall[`total${signal.key[0].toUpperCase()}${signal.key.slice(1)}` as keyof Overall] ?? 0,
								)}
							/>
						))}
					</div>
					<SectionTitle>{t("stats.behavior.trend")}</SectionTitle>
					<ChartBox height={240}>
						<Line data={trend} options={baseChartOptions()} />
					</ChartBox>
					<SectionTitle>{t("stats.behavior.byModel")}</SectionTitle>
					<StatTable
						columns={columns}
						keyFor={row => `${row.provider}/${row.model}`}
						rows={stats?.byModel ?? []}
					/>
				</>
			)}
		</RouteFrame>
	);
}
