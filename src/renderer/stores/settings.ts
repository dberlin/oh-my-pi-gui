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
	/** Agent `display.showTokenUsage` setting: per-turn usage row on assistant messages. */
	showTokenUsage: boolean;
	/** Agent `display.collapseCompacted` setting: fold pre-compaction history behind an expander. */
	collapseCompacted: boolean;
	/** Agent `tui.titleState` setting: run-state marker in the window title. */
	titleState: boolean;
	/** Agent `goal.statusInFooter` setting: goal status chip in the composer. */
	goalStatusInFooter: boolean;
	/** Agent `terminal.showProgress` setting: run progress in dock/tray. */
	showProgress: boolean;
	/** Agent `speech.enabled` setting: speak assistant output. */
	speechEnabled: boolean;
	/** Agent `stt.enabled` setting: microphone input in the composer. */
	sttEnabled: boolean;
	/** Agent `tui.tight` setting: compact UI density. */
	tuiTight: boolean;
	/** Agent `colorBlindMode` setting: color-blind-safe palette. */
	colorBlindMode: boolean;
	/** Agent `paste.largeMenuThreshold` setting: line count at which a paste offers the menu (0 = never). */
	pasteMenuThreshold: number;
	/** Agent `emojiAutocomplete` setting: `:name:`/emoticon completion and expansion in the composer. */
	emojiAutocomplete: boolean;
	setFromState: (state: RpcSessionState) => void;
	setApprovalMode: (mode: ApprovalMode) => void;
	/** Re-read the live display settings via get_settings. */
	syncDisplaySettings: () => Promise<void>;
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
	// Schema defaults: usage row off, compaction folded, title/goal chrome on.
	showTokenUsage: false,
	collapseCompacted: true,
	titleState: true,
	goalStatusInFooter: true,
	// Schema defaults: progress/speech/stt/tight/colorblind all off.
	showProgress: false,
	speechEnabled: false,
	sttEnabled: false,
	tuiTight: false,
	colorBlindMode: false,
	// Schema default (settings-schema.ts paste.largeMenuThreshold): menu at 100 lines.
	pasteMenuThreshold: 100,
	// Schema default (settings-schema.ts emojiAutocomplete): on.
	emojiAutocomplete: true,
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

/** Setting path → store field for the boolean display keys synced below. */
const DISPLAY_BOOL_MAP: Record<
	string,
	| "hideThinkingBlock"
	| "proseOnlyThinking"
	| "omitThinking"
	| "showTokenUsage"
	| "collapseCompacted"
	| "titleState"
	| "goalStatusInFooter"
	| "showProgress"
	| "speechEnabled"
	| "sttEnabled"
	| "tuiTight"
	| "colorBlindMode"
	| "emojiAutocomplete"
> = {
	hideThinkingBlock: "hideThinkingBlock",
	proseOnlyThinking: "proseOnlyThinking",
	omitThinking: "omitThinking",
	"display.showTokenUsage": "showTokenUsage",
	"display.collapseCompacted": "collapseCompacted",
	"tui.titleState": "titleState",
	"goal.statusInFooter": "goalStatusInFooter",
	"terminal.showProgress": "showProgress",
	"speech.enabled": "speechEnabled",
	"stt.enabled": "sttEnabled",
	"tui.tight": "tuiTight",
	colorBlindMode: "colorBlindMode",
	emojiAutocomplete: "emojiAutocomplete",
};
const DISPLAY_SYNC_KEYS = Object.keys(DISPLAY_BOOL_MAP);

/** Setting path → store field for numeric display keys. */
const DISPLAY_NUM_MAP: Record<string, "pasteMenuThreshold"> = {
	"paste.largeMenuThreshold": "pasteMenuThreshold",
};
const DISPLAY_NUM_KEYS = Object.keys(DISPLAY_NUM_MAP);

/**
 * Read the live display config settings into the store. Re-run on session
 * hydration and on every config_update push so edits from either the
 * TUI or the GUI settings window apply to rendering immediately.
 */
async function syncDisplaySettings(set: (partial: Partial<SettingsStore>) => void): Promise<void> {
	try {
		const res = await window.omp.rpc.getSettings([...DISPLAY_SYNC_KEYS, ...DISPLAY_NUM_KEYS]);
		if (res.success) {
			const values = (res.data as { values?: Record<string, unknown> } | undefined)?.values;
			const partial: Partial<SettingsStore> = {};
			for (const [path, field] of Object.entries(DISPLAY_BOOL_MAP)) {
				const value = values?.[path];
				if (typeof value === "boolean") partial[field] = value;
			}
			for (const [path, field] of Object.entries(DISPLAY_NUM_MAP)) {
				const value = values?.[path];
				if (typeof value === "number") partial[field] = value;
			}
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
		void syncDisplaySettings(set);
	},
	setApprovalMode: mode => {
		set({ approvalMode: mode });
		void window.omp.rpc.setSetting("tools.approvalMode", mode);
	},
	syncDisplaySettings: () => syncDisplaySettings(set),
	/** Re-read the live tools.approvalMode into the store (config_update / TUI edits). */
	syncApproval: () => syncApprovalMode(set),
	update: partial => set(partial),
	reset: () => set(initialState),
}));
