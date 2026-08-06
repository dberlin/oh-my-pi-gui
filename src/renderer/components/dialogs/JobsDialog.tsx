import { useEffect, useState } from "react";
import type { RpcAsyncJobItem, RpcJobsResult } from "../../../shared/rpc-types";
import { formatDuration } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Badge, Modal, Spinner } from "../common";

type JobStatusVariant = "success" | "default" | "error" | "warning";

const STATUS_VARIANT: Record<RpcAsyncJobItem["status"], JobStatusVariant> = {
	running: "success",
	completed: "default",
	failed: "error",
	cancelled: "warning",
};

/**
 * Native /jobs: async background jobs owned by the session — running first,
 * then recent, exactly the snapshot ordering the agent sends. Rows render
 * the job object's own fields (id, type, status, elapsed time, label).
 */
export function JobsDialog() {
	const t = useT();
	const open = useUiStore(state => state.jobsOpen);
	const close = useUiStore(state => state.closeJobs);
	const [jobs, setJobs] = useState<RpcAsyncJobItem[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setJobs([]);
		setError(null);
		setLoading(true);
		void window.omp.rpc
			.getJobs()
			.then(response => {
				if (cancelled) return;
				if (response.success) setJobs((response.data as RpcJobsResult).jobs);
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

	const now = Date.now();
	const running = jobs.filter(job => job.status === "running");
	const recent = jobs.filter(job => job.status !== "running");

	const renderJob = (job: RpcAsyncJobItem) => (
		<div className="px-3 py-2" key={job.id}>
			<div className="flex items-center gap-2">
				<span className="font-mono text-xs text-(--omp-dim)">[{job.id}]</span>
				<span className="text-xs font-medium text-(--omp-text)">{t(`jobs.type.${job.type}`)}</span>
				<Badge dot pulse={job.status === "running"} variant={STATUS_VARIANT[job.status]}>
					{t(`jobs.status.${job.status}`)}
				</Badge>
				<span className="ml-auto shrink-0 text-xs tabular-nums text-(--omp-dim)">
					{formatDuration(Math.max(0, now - job.startTime))}
				</span>
			</div>
			<div className="mt-0.5 truncate text-xs text-(--omp-dim)">{job.label}</div>
		</div>
	);

	return (
		<Modal onClose={close} open={open} size="lg" title={t("jobs.title")}>
			{loading ? (
				<div className="flex items-center justify-center gap-2 py-8 text-sm text-(--omp-dim)">
					<Spinner size="sm" /> {t("jobs.loading")}
				</div>
			) : error ? (
				<div className="py-4 text-sm text-(--omp-error)">
					{t("jobs.error")}: {error}
				</div>
			) : jobs.length === 0 ? (
				<div className="space-y-2 py-4">
					<div className="text-sm text-(--omp-text)">{t("jobs.empty")}</div>
					<div className="text-xs text-(--omp-dim)">{t("jobs.emptyHint")}</div>
				</div>
			) : (
				<div className="space-y-4">
					{running.length > 0 ? (
						<section>
							<div className="mb-1.5 flex items-center gap-2">
								<span className="text-xs font-semibold text-(--omp-text)">{t("jobs.running")}</span>
								<Badge variant="muted">{running.length}</Badge>
							</div>
							<div className="divide-y divide-(--omp-border-muted) rounded-lg border border-(--omp-border-muted)">
								{running.map(renderJob)}
							</div>
						</section>
					) : null}
					{recent.length > 0 ? (
						<section>
							<div className="mb-1.5 flex items-center gap-2">
								<span className="text-xs font-semibold text-(--omp-text)">{t("jobs.recent")}</span>
								<Badge variant="muted">{recent.length}</Badge>
							</div>
							<div className="divide-y divide-(--omp-border-muted) rounded-lg border border-(--omp-border-muted)">
								{recent.map(renderJob)}
							</div>
						</section>
					) : null}
				</div>
			)}
		</Modal>
	);
}
