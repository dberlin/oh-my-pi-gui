import { create } from "zustand";

/**
 * Pending restart-activation for a restart-required plugin install while the
 * sidecar is mid-run. The App-level session watcher (lib/plugin-activation.ts)
 * restarts the sidecar once the run settles — bound to the tab that requested
 * it, so switching to another tab's session can never hijack the restart.
 */
interface PluginActivationStore {
	/** Plugin id awaiting a sidecar restart; null when nothing is pending. */
	pendingId: string | null;
	/** Tab that requested the activation; only this tab may fire the restart. */
	tabId: string | null;
	requestActivation: (pluginId: string, tabId: string) => void;
	clearActivation: () => void;
}

export const usePluginActivationStore = create<PluginActivationStore>(set => ({
	pendingId: null,
	tabId: null,
	requestActivation: (pluginId, tabId) => set({ pendingId: pluginId, tabId }),
	clearActivation: () => set({ pendingId: null, tabId: null }),
}));
