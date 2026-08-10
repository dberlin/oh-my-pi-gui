import { GitBranch, MessageCircleQuestion } from "lucide-react";
import { useEffect, useState } from "react";
import { hydrateSession } from "../../hooks/use-rpc-events";
import { copyText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Modal, Spinner } from "../common";

interface BtwResult {
	question: string;
	replyText: string;
	canBranch: boolean;
}

export function BtwDialog() {
	const t = useT();
	const question = useUiStore(state => state.btwRequest);
	const close = useUiStore(state => state.closeBtw);
	const [result, setResult] = useState<BtwResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [branching, setBranching] = useState(false);

	useEffect(() => {
		if (question === null) return;
		let cancelled = false;
		setResult(null);
		setError(null);
		setLoading(true);
		void window.omp.rpc
			.btw(question)
			.then(response => {
				if (cancelled) return;
				if (!response.success) {
					setError(response.error);
					return;
				}
				setResult(response.data as BtwResult);
			})
			.catch(cause => {
				if (!cancelled) setError(String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [question]);

	const copyAnswer = async (): Promise<void> => {
		if (!result) return;
		if (!(await copyText(result.replyText))) {
			toast({ variant: "error", message: t("btw.copyFailed") });
			return;
		}
		toast({ variant: "success", message: t("btw.copied") });
	};

	const branch = async (): Promise<void> => {
		if (!result?.canBranch || branching) return;
		setBranching(true);
		try {
			const response = await window.omp.rpc.btwBranch();
			if (!response.success) throw new Error(response.error);
			const data = response.data as { cancelled?: boolean } | undefined;
			if (data?.cancelled) {
				toast({ variant: "info", message: t("btw.branchCancelled") });
				return;
			}
			await hydrateSession();
			close();
			toast({ variant: "success", message: t("btw.branched") });
		} catch (cause) {
			toast({ variant: "error", title: t("btw.branchFailed"), message: String(cause) });
		} finally {
			setBranching(false);
		}
	};

	return (
		<Modal onClose={close} open={question !== null} size="lg" title={t("btw.title")}>
			<div className="mb-4 flex items-start gap-2 rounded-lg border border-(--omp-border-muted) bg-transparent px-3 py-2.5 text-xs text-(--omp-dim)">
				<MessageCircleQuestion className="mt-0.5 shrink-0" size={14} />
				<span className="whitespace-pre-wrap">{question}</span>
			</div>
			{loading ? (
				<div className="flex items-center justify-center gap-2 py-16 text-sm text-(--omp-dim)">
					<Spinner size="sm" /> {t("btw.thinking")}
				</div>
			) : error ? (
				<div className="rounded-lg border border-[color-mix(in_srgb,var(--omp-error)_35%,transparent)] bg-transparent p-3 text-sm text-[var(--omp-error)]">
					{error}
				</div>
			) : result ? (
				<div className="max-h-[55vh] overflow-y-auto pr-1">
					<MarkdownRenderer content={result.replyText} />
				</div>
			) : null}
			<div className="mt-5 flex justify-end gap-2 border-t border-(--omp-border-muted) pt-3">
				<Button disabled={!result} onClick={() => void copyAnswer()} size="sm" variant="secondary">
					{t("btw.copy")}
				</Button>
				<Button disabled={!result?.canBranch || branching} onClick={() => void branch()} size="sm">
					{branching ? <Spinner size="sm" /> : <GitBranch size={13} />}
					{t("btw.branch")}
				</Button>
			</div>
		</Modal>
	);
}
