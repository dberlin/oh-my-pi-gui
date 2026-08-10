import { AlertTriangle, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import type { RpcShareSessionResult } from "../../../shared/rpc-types";
import { copyText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Modal, Spinner } from "../common";

/**
 * Native /share: seals and uploads the session on open (TUI runs the command
 * eagerly too), then presents the encrypted viewer link with copy /
 * open-in-browser actions. The truncated flag surfaces the share server's
 * size-limit trim note.
 */
export function ShareSessionDialog() {
	const t = useT();
	const open = useUiStore(state => state.shareSessionOpen);
	const close = useUiStore(state => state.closeShareSession);
	const [result, setResult] = useState<RpcShareSessionResult | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setResult(null);
		setError(null);
		setLoading(true);
		void window.omp.rpc
			.shareSession()
			.then(response => {
				if (cancelled) return;
				if (response.success) setResult(response.data as RpcShareSessionResult);
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

	const copy = async (value: string) => {
		if (await copyText(value)) toast({ variant: "success", message: t("shareDialog.copied") });
		else toast({ variant: "error", message: t("shareDialog.copyFailed") });
	};

	return (
		<Modal onClose={close} open={open} size="md" title={t("shareDialog.title")}>
			{loading ? (
				<div className="flex items-center justify-center gap-2 py-8 text-sm text-(--omp-dim)">
					<Spinner size="sm" /> {t("shareDialog.sharing")}
				</div>
			) : error ? (
				<div className="py-4 text-sm text-(--omp-error)">
					{t("shareDialog.error")}: {error}
				</div>
			) : result ? (
				<div className="space-y-3">
					<div>
						<div className="mb-1 text-xs font-medium text-(--omp-dim)">{t("shareDialog.url")}</div>
						<div className="flex items-end gap-2">
							<code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded bg-(--omp-bg-tertiary) px-3 py-2 text-xs text-(--omp-text)">
								{result.url}
							</code>
							<Button
								aria-label={t("shareDialog.copy")}
								onClick={() => void copy(result.url)}
								size="sm"
								title={t("shareDialog.copy")}
								variant="secondary"
							>
								<Copy size={13} />
							</Button>
							<Button
								aria-label={t("shareDialog.open")}
								onClick={() => void window.omp.system.openExternal(result.url)}
								size="sm"
								title={t("shareDialog.open")}
								variant="secondary"
							>
								<ExternalLink size={13} />
							</Button>
						</div>
					</div>
					{result.truncated ? (
						<div className="flex items-start gap-2 rounded-lg border border-[color-mix(in_srgb,var(--omp-warning)_35%,transparent)] bg-transparent p-3 text-xs text-(--omp-warning)">
							<AlertTriangle className="mt-px shrink-0" size={14} />
							{t("shareDialog.truncated")}
						</div>
					) : null}
				</div>
			) : null}
		</Modal>
	);
}
