import { create } from "zustand";
import type { RpcSessionState } from "../../shared/rpc-types";

export type ApprovalMode = "always-ask" | "write" | "yolo";
const APPROVAL_MODES = new Set<string>(["always-ask", "write", "yolo"]);

interface SettingsStore {
	approvalMode: ApprovalMode;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	autoCompaction: boolean;
	autoRetry: boolean;
	/** Agent `hideThinkingBlock` setting: suppress the reasoning block entirely. */
	hideThinkingBlock: boolean;
	/** Agent `proseOnlyThinking` setting: elide fenced code in thinking to `...`. */
	proseOnlyThinking: boolean;
	/**
	 * Agent `omitThinking` setting (provider-side summary omission). Read with the
	 * display settings for parity; intentionally display-neutral — the TUI gates
	 * thinking visibility on hideThinkingBlock alone.
	 */
	omitThinking: boolean;
	setFromState: (state: RpcSessionState) => void;
	setApprovalMode: (mode: ApprovalMode) => void;
	/** Re-read the live thinking-display settings via get_settings. */
	syncThinkingDisplay: () => Promise<void>;
	/** Re-read the live tools.approvalMode into the store (config_update / TUI edits). */
	syncApproval: () => Promise<void>;
	update: (
		partial: Partial<
			Pick<
				SettingsStore,
				"approvalMode" | "steeringMode" | "followUpMode" | "interruptMode" | "autoCompaction" | "autoRetry"
			>
		>,
	) => void;
	reset: () => void;
}

const initialState = {
	approvalMode: "yolo" as ApprovalMode,
	steeringMode: "all" as const,
	followUpMode: "all" as const,
	interruptMode: "immediate" as const,
	autoCompaction: true,
	autoRetry: true,
	// Schema defaults (settings-schema.ts): blocks shown, prose-only elision on.
	hideThinkingBlock: false,
	proseOnlyThinking: true,
	omitThinking: false,
};

/** Read the live tools.approvalMode config setting into the store. */
async function syncApprovalMode(set: (partial: Partial<SettingsStore>) => void): Promise<void> {
	try {
		// Migrate the legacy launch pref once, then config.yml is the source of truth.
		const pref = await window.omp.prefs.get("approvalMode");
		if (typeof pref === "string" && APPROVAL_MODES.has(pref)) {
			await window.omp.rpc.setSetting("tools.approvalMode", pref);
			await window.omp.prefs.set("approvalMode", null);
		}
		const res = await window.omp.rpc.getSettings(["tools.approvalMode"]);
		if (res.success) {
			const value = (res.data as { values?: Record<string, unknown> } | undefined)?.values?.["tools.approvalMode"];
			if (typeof value === "string" && APPROVAL_MODES.has(value)) set({ approvalMode: value as ApprovalMode });
		}
	} catch {
		// Settings unreadable - keep the current value.
	}
}

const THINKING_DISPLAY_KEYS = ["hideThinkingBlock", "proseOnlyThinking", "omitThinking"] as const;

/**
 * Read the live thinking-display config settings into the store. Re-run on
 * session hydration and on every config_update push so edits from either the
 * TUI or the GUI settings window apply to chat rendering immediately.
 */
async function syncThinkingDisplay(set: (partial: Partial<SettingsStore>) => void): Promise<void> {
	try {
		const res = await window.omp.rpc.getSettings([...THINKING_DISPLAY_KEYS]);
		if (res.success) {
			const values = (res.data as { values?: Record<string, unknown> } | undefined)?.values;
			const partial: Partial<SettingsStore> = {};
			if (typeof values?.hideThinkingBlock === "boolean") partial.hideThinkingBlock = values.hideThinkingBlock;
			if (typeof values?.proseOnlyThinking === "boolean") partial.proseOnlyThinking = values.proseOnlyThinking;
			if (typeof values?.omitThinking === "boolean") partial.omitThinking = values.omitThinking;
			if (Object.keys(partial).length > 0) set(partial);
		}
	} catch {
		// Settings unreadable - keep the current values.
	}
}

export const useSettingsStore = create<SettingsStore>()(set => ({
	...initialState,
	setFromState: state => {
		set({
			steeringMode: state.steeringMode,
			followUpMode: state.followUpMode,
			interruptMode: state.interruptMode,
			autoCompaction: state.autoCompactionEnabled,
			autoRetry: state.autoRetryEnabled,
		});
		// approvalMode lives in the tools.approvalMode config setting (set_setting
		// applies at runtime), not on the wire - re-sync from the live setting so
		// neither field goes stale across session switches.
		void syncApprovalMode(set);
		void syncThinkingDisplay(set);
	},
	setApprovalMode: mode => {
		set({ approvalMode: mode });
		void window.omp.rpc.setSetting("tools.approvalMode", mode);
	},
	syncThinkingDisplay: () => syncThinkingDisplay(set),
	/** Re-read the live tools.approvalMode into the store (config_update / TUI edits). */
	syncApproval: () => syncApprovalMode(set),
	update: partial => set(partial),
	reset: () => set(initialState),
}));
