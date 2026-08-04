/**
 * Structured plan-approval dialog. The agent submits a plan by writing to
 * `xd://propose` while plan mode is active; the sidecar emits a
 * `plan_proposal` frame, silently stops the proposal turn, and waits for the
 * host's `plan_approval` answer. This dialog renders the proposal as
 * scrollable markdown with one approve button per advertised option:
 *
 * - execute      → planApproval(true, "execute")       (fresh session)
 * - compact      → planApproval(true, "compact")       (distill transcript first)
 * - keep_context → planApproval(true, "keep_context")  (intact transcript)
 * - refine       → planApproval(false, undefined, feedback) (re-plan with feedback)
 * - dismiss/Esc  → planApproval(false)                 (plain reject)
 *
 * Mirrors the TUI plan-review overlay ("Approve and execute" / "Approve and
 * compact context" / "keep context" / "Refine plan"). Zero props and
 * self-subscribing — mount once in App.
 */

import { ClipboardList, History, ListCollapse, Play, Send } from "lucide-react";
import { type ReactNode, useState } from "react";
import { usePlanApproval } from "../../hooks/use-plan-approval";
import { basename } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { type PendingPlanProposal, usePlanApprovalStore } from "../../stores/plan-approval";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import { Button, Modal, TextArea } from "../common";

type PlanApprovalOption = "execute" | "compact" | "keep_context";
type SubmitKind = "approve" | "refine" | "dismiss";

/** Which control is in flight; `option` distinguishes the approve buttons. */
interface SubmitState {
	kind: SubmitKind;
	option?: PlanApprovalOption;
}

/** Wire result of the `plan_approval` command (RpcPlanApprovalResult). */
interface PlanApprovalResult {
	approved: boolean;
	dispatched: boolean;
	reason?: string;
}

const APPROVE_CHOICES: Record<PlanApprovalOption, { labelKey: string; hintKey: string; icon: ReactNode }> = {
	execute: {
		labelKey: "planApproval.approve.execute.label",
		hintKey: "planApproval.approve.execute.hint",
		icon: <Play size={12} />,
	},
	compact: {
		labelKey: "planApproval.approve.compact.label",
		hintKey: "planApproval.approve.compact.hint",
		icon: <ListCollapse size={12} />,
	},
	keep_context: {
		labelKey: "planApproval.approve.keepContext.label",
		hintKey: "planApproval.approve.keepContext.hint",
		icon: <History size={12} />,
	},
};

/** Approve buttons from the advertised options; falls back to execute when none are recognizable. */
function approveOptionsOf(options: string[]): PlanApprovalOption[] {
	const known = options.filter(
		(option): option is PlanApprovalOption =>
			option === "execute" || option === "compact" || option === "keep_context",
	);
	return known.length > 0 ? known : ["execute"];
}

export function PlanApprovalDialog() {
	// Self-contained: mounting this component also subscribes to plan_proposal events.
	usePlanApproval();
	const t = useT();
	const pending = usePlanApprovalStore(state => state.pending);
	const feedback = usePlanApprovalStore(state => state.feedback);
	const setFeedback = usePlanApprovalStore(state => state.setFeedback);
	const clearProposal = usePlanApprovalStore(state => state.clearProposal);

	const [submitting, setSubmitting] = useState<SubmitState | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	// A new proposal replaces the old one (latest wins) — reset transient UI
	// state during render (React's adjust-state-when-props-change pattern).
	// Feedback resets in the store alongside the proposal.
	const [lastPending, setLastPending] = useState<PendingPlanProposal | null>(null);
	if (pending !== lastPending) {
		setLastPending(pending);
		setSubmitting(null);
		setNotice(null);
	}

	if (!pending) return null;

	/** Clear the store only when the answered proposal is still the one shown. */
	const clearIfCurrent = (target: PendingPlanProposal) => {
		if (usePlanApprovalStore.getState().pending === target) clearProposal();
	};

	const respond = async (kind: SubmitKind, option?: PlanApprovalOption) => {
		if (submitting !== null) return;
		const target = pending;
		const trimmed = feedback.trim();
		setSubmitting({ kind, option });
		try {
			const response =
				kind === "approve"
					? await window.omp.rpc.planApproval(true, option)
					: kind === "refine"
						? await window.omp.rpc.planApproval(false, undefined, trimmed)
						: await window.omp.rpc.planApproval(false);
			if (!response.success) {
				toast({ variant: "error", title: t("planApproval.failed"), message: response.error });
				return;
			}
			if (kind === "approve") {
				// Accepting exits plan mode server-side (rpc-plan.ts resolve) but
				// emits no event — sync the store now so the composer chip and
				// titlebar badge turn off immediately instead of waiting for the
				// next get_state. Holds even when dispatched=false (compaction
				// failed): the server exited plan mode before compacting.
				useSessionStore.setState({ planModeEnabled: false });
			}
			const result = response.data as PlanApprovalResult | null | undefined;
			if (result && !result.dispatched) {
				if (kind === "approve") {
					// Approval stands but nothing was dispatched (e.g. compaction
					// failed) — surface the reason and stay open so the host can
					// pick another option.
					setNotice(result.reason ?? t("planApproval.notDispatched"));
					return;
				}
				// Plain reject / empty refine: resolved with nothing dispatched.
				clearIfCurrent(target);
				return;
			}
			clearIfCurrent(target);
			toast({
				variant: "success",
				message:
					kind === "approve"
						? t("planApproval.approved")
						: kind === "refine"
							? t("planApproval.refined")
							: t("planApproval.dismissed"),
			});
		} catch (cause) {
			toast({ variant: "error", title: t("planApproval.failed"), message: String(cause) });
		} finally {
			setSubmitting(null);
		}
	};

	// Esc, backdrop click, and the X button all answer planApproval(false).
	const requestDismiss = () => {
		if (submitting !== null) return;
		void respond("dismiss");
	};

	const approveOptions = approveOptionsOf(pending.options);
	const showRefine = pending.options.length === 0 || pending.options.includes("refine");
	const busy = submitting !== null;

	return (
		<Modal
			onClose={requestDismiss}
			open
			size="lg"
			title={
				<span className="flex items-center gap-2">
					<ClipboardList className="shrink-0 text-(--omp-accent)" size={14} />
					{pending.title ?? t("planApproval.reviewFallback")}
				</span>
			}
		>
			<div className="flex flex-col gap-3 p-4">
				<div className="flex items-center gap-2 text-[10px] text-(--omp-dim)">
					<span className="shrink-0">{t("planApproval.planFile")}</span>
					<span className="truncate font-mono" title={pending.planFilePath}>
						{basename(pending.planFilePath)}
					</span>
				</div>
				<div className="max-h-[52vh] overflow-y-auto rounded-md border border-(--omp-border-muted) bg-(--omp-bg-primary) px-4 py-3">
					{pending.planContent.trim().length > 0 ? (
						<MarkdownRenderer content={pending.planContent} />
					) : (
						<p className="text-xs text-(--omp-dim)">{t("planApproval.emptyPlan")}</p>
					)}
				</div>
				{notice !== null && (
					<div className="rounded-md border border-(--omp-border-muted) bg-(--omp-bg-tertiary) px-3 py-2 text-[11px] text-(--omp-warning)">
						{notice}
					</div>
				)}
				{showRefine && (
					<TextArea
						autoGrow
						disabled={busy}
						hint={t("planApproval.refineHint")}
						label={t("planApproval.refineLabel")}
						maxLength={8000}
						onChange={event => setFeedback(event.target.value)}
						placeholder={t("planApproval.refinePlaceholder")}
						rows={2}
						value={feedback}
					/>
				)}
				<div className="flex flex-wrap items-center justify-end gap-2">
					<Button onClick={requestDismiss} size="sm" variant="ghost">
						{t("planApproval.dismiss")}
					</Button>
					{showRefine && (
						<Button
							disabled={busy || feedback.trim().length === 0}
							icon={<Send size={12} />}
							loading={submitting?.kind === "refine"}
							onClick={() => void respond("refine")}
							size="sm"
							title={t("planApproval.refineTitle")}
							variant="secondary"
						>
							{t("planApproval.refine")}
						</Button>
					)}
					{approveOptions.map((option, index) => {
						const choice = APPROVE_CHOICES[option];
						return (
							<Button
								disabled={busy}
								icon={choice.icon}
								key={option}
								loading={submitting?.kind === "approve" && submitting.option === option}
								onClick={() => void respond("approve", option)}
								size="sm"
								title={t(choice.hintKey)}
								variant={index === 0 ? "primary" : "secondary"}
							>
								{t(choice.labelKey)}
							</Button>
						);
					})}
				</div>
			</div>
		</Modal>
	);
}
