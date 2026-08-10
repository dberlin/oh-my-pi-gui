/**
 * Update banner: the visible half of the auto-update flow. Shows when the
 * main-process updater reports `available` (version + download action),
 * turns into a progress bar while `downloading`, and offers restart-and-
 * install on `downloaded`. Dismissible per version; errors surface only
 * after a user-initiated action (manual check/download), never from the
 * passive 4h poll.
 */
import { Download, RefreshCw, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useUpdaterStore } from "../../stores/updater";
import { Button } from "../common";

function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
	return `${bytes} B`;
}

export function UpdateBanner() {
	const t = useT();
	const status = useUpdaterStore(s => s.status);
	const dismissedVersion = useUpdaterStore(s => s.dismissedVersion);
	const dismiss = useUpdaterStore(s => s.dismiss);

	if (status.state === "available") {
		if (dismissedVersion === status.version) return null;
		return (
			<div className="flex items-center gap-2 border-b border-(--omp-border-muted) bg-transparent px-3 py-1.5 text-[12px]">
				<Download size={13} className="shrink-0 text-(--omp-accent)" />
				<span className="min-w-0 flex-1 truncate text-(--omp-text)">
					{t("updater.available", { version: status.version })}
				</span>
				<Button size="sm" onClick={() => void window.omp.updater.download()}>
					{t("updater.download")}
				</Button>
				<button
					type="button"
					aria-label={t("updater.dismiss")}
					className="shrink-0 text-(--omp-dim) hover:text-(--omp-text)"
					onClick={() => dismiss(status.version)}
				>
					<X size={13} />
				</button>
			</div>
		);
	}

	if (status.state === "downloading") {
		return (
			<div className="flex items-center gap-2 border-b border-(--omp-border-muted) bg-transparent px-3 py-1.5 text-[12px]">
				<Download size={13} className="shrink-0 animate-pulse text-(--omp-accent)" />
				<div className="min-w-0 flex-1">
					<div className="mb-1 flex justify-between text-(--omp-text)">
						<span>{t("updater.downloading")}</span>
						<span className="tabular-nums text-(--omp-dim)">
							{status.percent}% · {formatBytes(status.transferred)}/{formatBytes(status.total)}
						</span>
					</div>
					<div className="h-1 overflow-hidden rounded-full bg-(--omp-bg-primary)">
						<div
							className="h-full bg-(--omp-accent) transition-[width] duration-200"
							style={{ width: `${status.percent}%` }}
						/>
					</div>
				</div>
			</div>
		);
	}

	if (status.state === "downloaded") {
		return (
			<div className="flex items-center gap-2 border-b border-(--omp-border-muted) bg-transparent px-3 py-1.5 text-[12px]">
				<RefreshCw size={13} className="shrink-0 text-(--omp-success)" />
				<span className="min-w-0 flex-1 truncate text-(--omp-text)">
					{t("updater.ready", { version: status.version })}
				</span>
				<Button size="sm" onClick={() => void window.omp.updater.install()}>
					{t("updater.restart")}
				</Button>
			</div>
		);
	}

	return null;
}
