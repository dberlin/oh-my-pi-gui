/**
 * Plan-approval store: holds the pending structured plan proposal emitted by
 * the agent (`plan_proposal` event) for the PlanApprovalDialog. The sidecar
 * can only have one plan awaiting approval at a time, so a new proposal
 * replaces the previous one (latest wins). The refine feedback lives here too
 * so it resets with the proposal lifecycle and survives dialog remounts.
 */

import { create } from "zustand";

export interface PendingPlanProposal {
	planFilePath: string;
	title?: string;
	planContent: string;
	/** Approval choices advertised on the frame: "execute" | "compact" | "keep_context" | "refine". */
	options: string[];
}

interface PlanApprovalStore {
	/** The proposal awaiting a host decision; null when the dialog is closed. */
	pending: PendingPlanProposal | null;
	/** Refine feedback sent back to the agent when the host asks for changes. */
	feedback: string;
	/** Show a proposal, replacing any previous one (latest wins). */
	showProposal: (proposal: PendingPlanProposal) => void;
	setFeedback: (feedback: string) => void;
	/** Drop the pending proposal once it has been answered or dismissed. */
	clearProposal: () => void;
}

export const usePlanApprovalStore = create<PlanApprovalStore>()(set => ({
	pending: null,
	feedback: "",
	showProposal: proposal => set({ pending: proposal, feedback: "" }),
	setFeedback: feedback => set({ feedback }),
	clearProposal: () => set({ pending: null, feedback: "" }),
}));

/** Fire-and-forget helper for non-component call sites. */
export function clearPendingPlanProposal(): void {
	usePlanApprovalStore.getState().clearProposal();
}
