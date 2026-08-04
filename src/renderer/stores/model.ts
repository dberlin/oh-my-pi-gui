import { create } from "zustand";
import type { ModelInfo, RpcSessionState, ThinkingLevel } from "../../shared/rpc-types";
import { toast } from "./toast";

interface ModelStore {
	model: ModelInfo | null;
	thinkingLevel: ThinkingLevel | undefined;
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
			toast({ variant: "error", title: "Fast mode", message: res.error });
		}
	},
	reset: () => set(initialState),
}));
