/**
 * Plugin install activation: a restart-required install restarts the active
 * tab's sidecar immediately when idle, or queues until the current run
 * settles. After the restart, the plugin's presence is verified via
 * get_plugins so "installed" never silently means "failed to load". Other
 * tabs/windows pick the plugin up on their next restart — v1 scope (D3).
 */

import { usePluginActivationStore } from "../stores/plugin-activation";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { toast } from "../stores/toast";
import { translate } from "./i18n";

interface ActivationTiming {
	verifyAttempts?: number;
	verifyIntervalMs?: number;
}

import { refreshPluginThemes } from "./themes";
/**
 * Consume a mutation result's `activation` verdict: restart now when idle,
 * queue until the run settles otherwise, no-op for live activations.
 */
export function handlePluginActivation(activation: unknown, pluginId: string, timing?: ActivationTiming): void {
	if (activation !== "restart-required") return;
	const { isStreaming, isCompacting } = useSessionStore.getState();
	if (isStreaming || isCompacting) {
		// Bind the queued restart to THIS tab: the settle-watcher fires on the
		// foreground session store, which may already belong to another tab.
		const tabId = useTabsStore.getState().activeTabId ?? "";
		usePluginActivationStore.getState().requestActivation(pluginId, tabId);
		toast({ variant: "info", message: translate("pluginActivation.waiting", { name: pluginId }) });
		return;
	}
	void restartForActivation(pluginId, timing);
}

/**
 * Restart the active sidecar (resuming its session), then poll get_plugins
 * until the plugin is listed and enabled. Resolves "restarted" when verified,
 * "missing" when the poll deadline passes without seeing it, undefined when
 * there was nothing to verify (or the restart itself failed).
 */
export async function restartForActivation(
	pluginId: string | null,
	timing?: ActivationTiming,
): Promise<"restarted" | "missing" | undefined> {
	usePluginActivationStore.getState().clearActivation();
	const { sessionFile } = useSessionStore.getState();
	try {
		await window.omp.sidecar.restart(sessionFile ?? undefined);
	} catch (cause) {
		toast({ variant: "error", message: translate("pluginActivation.restartFailed", { message: String(cause) }) });
		return undefined;
	}
	if (!pluginId) return undefined;

	const attempts = timing?.verifyAttempts ?? 20;
	const intervalMs = timing?.verifyIntervalMs ?? 400;
	for (let attempt = 0; attempt < attempts; attempt++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, intervalMs);
		await promise;
		try {
			const res = await window.omp.rpc.getPlugins();
			if (res.success) {
				const data = res.data as { plugins?: Array<{ id?: string; name: string; enabled: boolean }> } | undefined;
				const match = data?.plugins?.find(plugin => (plugin.id ?? plugin.name) === pluginId);
				if (match?.enabled) {
					toast({ variant: "success", message: translate("pluginActivation.restarted", { name: pluginId }) });
					void refreshPluginThemes();
					return "restarted";
				}
			}
		} catch {
			// Sidecar still restarting — keep polling until the deadline.
		}
	}
	toast({ variant: "error", message: translate("pluginActivation.verifyFailed", { name: pluginId }) });
	return "missing";
}

/**
 * Session-store subscription body: fire the queued restart once the run
 * settles. App mounts this once; the pendingId guard keeps it idempotent.
 */
export function watchPluginActivation(): () => void {
	return useSessionStore.subscribe(state => {
		if (state.isStreaming || state.isCompacting) return;
		const { pendingId, tabId } = usePluginActivationStore.getState();
		if (!pendingId) return;
		// Only the requesting tab may fire the restart: the foreground session
		// going idle in ANOTHER tab must not restart (or resume) this sidecar
		// with that tab's session file.
		if (tabId != null && useTabsStore.getState().activeTabId !== tabId) return;
		void restartForActivation(pendingId);
	});
}
