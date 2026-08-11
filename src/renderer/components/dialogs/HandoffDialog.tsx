/**
 * Handoff dialog: explains the handoff flow, collects optional custom
 * instructions, and calls rpc.handoff(instructions?) — the agent summarizes
 * this session into a handoff document and opens a new session carrying that
 * context (the current session is preserved). Mirrors the TUI /handoff guard:
 * unavailable while the agent is streaming, with the reason shown inline.
 */

import { Handshake } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hydrateSession } from "../../hooks/use-rpc-events";
import { useT } from "../../lib/i18n";
import { useForkHandoffStore } from "../../stores/fork-handoff";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import { Button, Modal, Spinner, TextArea } from "../common";

interface HandoffResult {
	savedPath?: string;
}

export function HandoffDialog() {
	const t = useT();
	const open = useForkHandoffStore(state => state.handoffDialogOpen);
	const close = useForkHandoffStore(state => state.closeHandoffDialog);
	const isStreaming = useSessionStore(state => state.isStreaming);
	const messageCount = useSessionStore(state => state.messageCount);

	const [instructions, setInstructions] = useState("");
	const [running, setRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const textRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (!open) return;
		setInstructions("");
		setRunning(false);
		setError(null);
		requestAnimationFrame(() => textRef.current?.focus());
	}, [open]);

	// The handoff RPC cannot be cancelled from the GUI — block dismissal while
	// the agent is generating the handoff document.
	const requestClose = () => {
		if (!running) close();
	};

	const blockedReason = isStreaming
		? t("handoff.blockedStreaming")
		: messageCount === 0
			? t("handoff.blockedEmpty")
			: null;

	const submit = async () => {
		if (running || blockedReason !== null) return;
		setRunning(true);
		setError(null);
		try {
			const trimmed = instructions.trim();
			const response = await window.omp.rpc.handoff(trimmed.length > 0 ? trimmed : undefined);
			if (!response.success) {
				setError(response.error);
				return;
			}
			const result = response.data as HandoffResult | null | undefined;
			if (result == null) {
				// null data = the agent-side handoff was cancelled.
				close();
				toast({ variant: "info", message: t("handoff.cancelled") });
				return;
			}
			await hydrateSession();
			close();
			toast({
				variant: "success",
				title: t("handoff.successTitle"),
				message: result.savedPath ? t("handoff.successSaved", { path: result.savedPath }) : t("handoff.success"),
			});
		} catch (cause) {
			setError(String(cause));
		} finally {
			setRunning(false);
		}
	};

	return (
		<Modal open={open} onClose={requestClose} title={t("handoff.title")} size="md">
			<div className="flex flex-col gap-3">
				<div className="flex items-start gap-2.5 rounded-md border border-(--omp-border-muted) bg-transparent px-3 py-2.5">
					<Handshake className="mt-0.5 shrink-0 text-(--omp-accent)" size={14} />
					<p className="text-omp-sm leading-relaxed text-(--omp-muted)">{t("handoff.desc")}</p>
				</div>
				<TextArea
					autoGrow
					disabled={running}
					hint={t("handoff.instructionsHint")}
					label={t("handoff.instructionsLabel")}
					maxLength={2000}
					onChange={event => setInstructions(event.target.value)}
					placeholder={t("handoff.instructionsPlaceholder")}
					ref={textRef}
					rows={3}
					value={instructions}
				/>
				{blockedReason !== null && (
					<div className="rounded-md border border-[color-mix(in_srgb,var(--omp-warning)_35%,transparent)] bg-transparent px-3 py-2 text-omp-sm text-(--omp-warning)">
						{blockedReason}
					</div>
				)}
				{error !== null && (
					<div className="rounded-md border border-[var(--omp-error)] bg-transparent px-3 py-2 text-omp-sm text-[var(--omp-error)]">
						{error}
					</div>
				)}
				{running && (
					<div className="flex items-center gap-2 text-omp-sm text-(--omp-dim)">
						<Spinner size="sm" />
						{t("handoff.generating")}
					</div>
				)}
				<div className="flex justify-end gap-2">
					<Button disabled={running} onClick={requestClose} type="button" variant="ghost">
						{t("common.cancel")}
					</Button>
					<Button
						disabled={blockedReason !== null}
						loading={running}
						onClick={() => void submit()}
						title={blockedReason ?? undefined}
						type="button"
						variant="primary"
					>
						{t("handoff.start")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
