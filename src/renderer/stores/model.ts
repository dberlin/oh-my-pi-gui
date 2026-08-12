import { create } from "zustand";
import type { ModelInfo, RpcSessionState, ThinkingLevel } from "../../shared/rpc-types";
import { translate } from "../lib/i18n";
import { toast } from "./toast";

interface ModelStore {
	model: ModelInfo | null;
	thinkingLevel: ThinkingLevel | undefined;
	/** Configured selector ("auto" or a level) — what the composer picker checks, vs the effective `thinkingLevel`. */
	thinkingConfigured: ThinkingLevel | "auto" | undefined;
	/** Levels the active model supports; empty = model does not reason. */
	availableThinkingLevels: ThinkingLevel[];
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	tokensPerSecond: number | null;
	availableModels: ModelInfo[];
	setFromState: (state: RpcSessionState) => void;
	setAvailableModels: (models: ModelInfo[]) => void;
	/** Toggle fast mode via RPC and apply the returned {enabled, active} (fixes
	 * call sites that fired setFastMode and ignored the response, desyncing the store). */
	toggleFastMode: () => Promise<void>;
	reset: () => void;
}

const initialState = {
	model: null as ModelInfo | null,
	thinkingLevel: undefined as ThinkingLevel | undefined,
	thinkingConfigured: undefined as ThinkingLevel | "auto" | undefined,
	availableThinkingLevels: [] as ThinkingLevel[],
	fastModeEnabled: false,
	fastModeActive: false,
	tokensPerSecond: null as number | null,
	availableModels: [] as ModelInfo[],
};

export const useModelStore = create<ModelStore>()(set => ({
	...initialState,
	setFromState: state =>
		set({
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			thinkingConfigured: state.thinkingConfigured,
			availableThinkingLevels: state.availableThinkingLevels ?? [],
			fastModeEnabled: state.fastModeEnabled,
			fastModeActive: state.fastModeActive,
			tokensPerSecond: state.tokensPerSecond,
		}),
	setAvailableModels: models => set({ availableModels: models }),
	toggleFastMode: async () => {
		const res = await window.omp.rpc.setFastMode(!useModelStore.getState().fastModeEnabled);
		if (res.success) {
			const data = res.data as { enabled?: boolean; active?: boolean } | undefined;
			set({ fastModeEnabled: data?.enabled ?? false, fastModeActive: data?.active ?? false });
		} else {
			toast({ variant: "error", title: translate("model.fastMode"), message: res.error });
		}
	},
	reset: () => set(initialState),
}));
