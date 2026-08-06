/**
 * Updater store: the renderer's mirror of the main-process update status
 * machine (pushed via updater:status, replayed on boot via getStatus), plus
 * the banner dismissal. Dismissal is per-version: snoozing v0.4.1 doesn't
 * hide v0.4.2 when it lands.
 */
import { create } from "zustand";
import type { UpdateStatus } from "../../shared/ipc-types";

interface UpdaterStore {
	status: UpdateStatus;
	/** Version the user dismissed the banner for; undefined = nothing dismissed. */
	dismissedVersion: string | undefined;
	setStatus: (status: UpdateStatus) => void;
	dismiss: (version: string) => void;
	clearDismissed: () => void;
}

export const useUpdaterStore = create<UpdaterStore>()(set => ({
	status: { state: "idle" },
	dismissedVersion: undefined,
	setStatus: status => set({ status }),
	dismiss: version => set({ dismissedVersion: version }),
	clearDismissed: () => set({ dismissedVersion: undefined }),
}));

/** Wire the main-process push + boot replay once (App mount). Returns unsubscribe. */
export function subscribeUpdaterStatus(): () => void {
	const unsubscribe = window.omp.events.onUpdaterStatus(status => {
		useUpdaterStore.getState().setStatus(status);
	});
	void window.omp.updater.getStatus().then(status => {
		useUpdaterStore.getState().setStatus(status);
	});
	return unsubscribe;
}
