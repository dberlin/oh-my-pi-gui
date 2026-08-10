/**
 * Shared building blocks for stats routes: frame with loading/error/empty
 * states, metric cards, generic table, chart container.
 */

import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { Button, Spinner } from "../common";

export function RouteFrame({
	loading,
	error,
	empty,
	onRetry,
	children,
}: {
	loading: boolean;
	error: string | null;
	empty?: boolean;
	onRetry: () => void;
	children: ReactNode;
}) {
	const t = useT();
	if (loading) {
		return (
			<div className="flex h-64 items-center justify-center gap-2.5">
				<Spinner size="md" />
				<span className="text-xs text-(--omp-dim)">{t("stats.loading")}</span>
			</div>
		);
	}
	if (error) {
		return (
			<div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
				<AlertTriangle className="text-(--omp-warning)" size={20} />
				<div className="max-w-sm text-xs leading-relaxed text-(--omp-muted)">
					<span className="font-semibold text-(--omp-text)">{t("stats.unavailable")}</span>
					<br />
					{error}
				</div>
				<Button icon={<RefreshCw size={12} />} onClick={onRetry} size="sm" variant="secondary">
					{t("stats.retry")}
				</Button>
			</div>
		);
	}
	if (empty) {
		return (
			<div className="flex h-64 flex-col items-center justify-center gap-2 text-center">
				<Inbox className="text-(--omp-dim)" size={20} />
				<span className="text-xs text-(--omp-dim)">{t("stats.emptyRange")}</span>
			</div>
		);
	}
	return <>{children}</>;
}

export function MetricCard({
	label,
	value,
	sub,
	tone = "default",
}: {
	label: string;
	value: string;
	sub?: string;
	tone?: "default" | "accent" | "success" | "warning" | "error";
}) {
	const valueColor = {
		default: "text-(--omp-text)",
		accent: "text-(--omp-accent)",
		success: "text-(--omp-success)",
		warning: "text-(--omp-warning)",
		error: "text-(--omp-error)",
	}[tone];
	return (
		<div className="rounded-lg border border-(--omp-border-muted) bg-transparent px-3.5 py-3 transition-colors hover:border-(--omp-border)">
			<div className="text-[9px] font-semibold tracking-widest text-(--omp-dim) uppercase">{label}</div>
			<div className={`mt-1 text-xl font-semibold tabular-nums ${valueColor}`}>{value}</div>
			{sub && <div className="mt-0.5 text-[10px] text-(--omp-muted)">{sub}</div>}
		</div>
	);
}

export interface StatColumn<T> {
	key: string;
	label: string;
	align?: "left" | "right";
	render: (row: T) => ReactNode;
}

export function StatTable<T>({
	columns,
	rows,
	keyFor,
	onRowClick,
}: {
	columns: StatColumn<T>[];
	rows: T[];
	keyFor: (row: T) => string;
	/** Makes rows clickable (e.g. opening a detail drawer). */
	onRowClick?: (row: T) => void;
}) {
	return (
		<div className="overflow-x-auto rounded-lg border border-(--omp-border-muted)">
			<table className="w-full border-collapse text-[11px]">
				<thead>
					<tr className="border-b border-(--omp-border-muted) bg-transparent">
						{columns.map(column => (
							<th
								className={`px-2.5 py-1.5 text-[9px] font-semibold tracking-widest whitespace-nowrap text-(--omp-dim) uppercase ${
									column.align === "right" ? "text-right" : "text-left"
								}`}
								key={column.key}
							>
								{column.label}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map(row => (
						<tr
							className={`border-b border-(--omp-border-muted) transition-colors last:border-b-0 hover:bg-(--omp-bg-tertiary) ${onRowClick ? "cursor-pointer" : ""}`}
							key={keyFor(row)}
							onClick={onRowClick ? () => onRowClick(row) : undefined}
						>
							{columns.map(column => (
								<td
									className={`px-2.5 py-1.5 align-top ${column.align === "right" ? "text-right tabular-nums" : ""}`}
									key={column.key}
								>
									{column.render(row)}
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function ChartBox({ height = 260, children }: { height?: number; children: ReactNode }) {
	return (
		<div className="rounded-lg border border-(--omp-border-muted) bg-transparent p-3" style={{ height: height + 24 }}>
			<div className="relative h-full w-full">{children}</div>
		</div>
	);
}

export function SectionTitle({ children }: { children: ReactNode }) {
	return (
		<h3 className="mb-2 mt-5 text-[10px] font-semibold tracking-widest text-(--omp-dim) uppercase first:mt-0">
			{children}
		</h3>
	);
}
