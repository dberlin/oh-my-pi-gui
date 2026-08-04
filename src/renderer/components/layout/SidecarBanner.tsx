/**
 * Global sidecar status banner. Shows when the sidecar is not responsive:
 * error state, exited, or "ready" but failing health checks.
 * Provides a restart button and clear error messaging.
 */

import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";

export function SidecarBanner() {
	const t = useT();
	const status = useSessionStore(s => s.status);
	const cwd = useSessionStore(s => s.cwd);
	const sidecarError = useUiStore(s => s.sidecarError);
	const clearSidecarError = useUiStore(s => s.clearSidecarError);

	// Show banner when sidecar is in error/exited state, or when a health check failed
	const showError = status === "error" || status === "exited" || sidecarError !== null;
	if (!showError) return null;

	const message =
		sidecarError ??
		(status === "error"
			? t("sidecar.failedStart")
			: status === "exited"
				? t("sidecar.exited")
				: t("sidecar.notResponding"));

	return (
		<div className="flex items-center gap-3 border-b border-[var(--omp-error)]/30 bg-[var(--omp-error)]/10 px-4 py-2.5">
			<AlertTriangle size={16} className="shrink-0 text-[var(--omp-error)]" />
			<div className="min-w-0 flex-1">
				<div className="text-[12px] font-medium text-[var(--omp-error)]">{t("sidecar.title")}</div>
				<div className="truncate text-[11px] text-[var(--omp-muted)]">{message}</div>
				{cwd && <div className="text-[10px] text-[var(--omp-dim)]">{t("sidecar.project", { cwd })}</div>}
			</div>
			<button
				type="button"
				onClick={() => {
					clearSidecarError();
					void window.omp.sidecar.restart();
				}}
				className="omp-pressable flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--omp-border-muted)] px-2.5 py-1 text-[11px] font-medium text-[var(--omp-text)] hover:bg-[var(--omp-selected-bg)]"
			>
				<RefreshCw size={11} />
				{t("sidecar.restart")}
			</button>
			<button
				type="button"
				onClick={clearSidecarError}
				aria-label={t("common.close")}
				className="omp-pressable flex shrink-0 items-center justify-center rounded-md p-1 text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
			>
				<X size={12} />
			</button>
		</div>
	);
}
