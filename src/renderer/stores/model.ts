import { create } from "zustand";
import type {
	AvailableModelsResult,
	ModelCatalogUpdateFrame,
	ModelInfo,
	ProviderDiscoveryState,
	RpcSessionState,
	ThinkingLevel,
} from "../../shared/rpc-types";
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
	discoveryStates: ProviderDiscoveryState[];
	catalogRefreshPending: boolean;
	catalogGeneration: number;
	setFromState: (state: RpcSessionState) => void;
	setAvailableModels: (models: ModelInfo[]) => void;
	/** Fetch the authoritative, cache-aware catalog from the active sidecar. */
	refreshAvailableModels: (forceRefresh?: boolean) => Promise<AvailableModelsResult>;
	applyCatalogUpdate: (update: ModelCatalogUpdateFrame) => void;
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
	discoveryStates: [] as ProviderDiscoveryState[],
	catalogRefreshPending: false,
	catalogGeneration: 0,
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
	refreshAvailableModels: async (forceRefresh = false) => {
		const response = await window.omp.rpc.getAvailableModels(forceRefresh);
		if (!response.success) throw new Error(response.error);
		const data = response.data as AvailableModelsResult | undefined;
		const result: AvailableModelsResult = {
			models: data?.models ?? [],
			discoveryStates: data?.discoveryStates ?? [],
			refreshPending: data?.refreshPending ?? false,
			generation: data?.generation ?? 0,
		};
		set(state =>
			result.generation < state.catalogGeneration
				? {}
				: {
						availableModels: result.models,
						discoveryStates: result.discoveryStates,
						catalogRefreshPending: result.refreshPending,
						catalogGeneration: result.generation,
					},
		);
		return result;
	},
	applyCatalogUpdate: update =>
		set(state =>
			update.generation < state.catalogGeneration
				? {}
				: {
						availableModels: update.models,
						discoveryStates: update.discoveryStates,
						catalogRefreshPending: update.refreshPending,
						catalogGeneration: update.generation,
					},
		),
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
