/**
 * Queue store: the GUI's snapshot of the agent's pending steer/follow-up
 * queues. The `queue_update` session event is the authoritative update
 * channel — it fires on every queue mutation (enqueue, drain/consume,
 * remove, move, clear, dequeue restore) and lands here via setFromFrame from
 * the onBatch handler. get_queue survives only as the hydrate fallback
 * (mount, sidecar reconnect) since no snapshot predates the subscription.
 * Shared by the QueueDockChip manager modal and the pending bubbles at the
 * message-stream tail.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { RpcGetQueueResult, RpcQueuedMessage } from "../../shared/rpc-types";

export type QueueLane = "steering" | "followUp";

interface QueueStore {
	steering: RpcQueuedMessage[];
	followUp: RpcQueuedMessage[];
	/** Hydrate fallback pull via get_queue; only the latest response may apply. */
	refresh: () => Promise<void>;
	/** Apply an authoritative queue_update frame. */
	setFromFrame: (snapshot: RpcGetQueueResult) => void;
}

/** Invalidates stale get_queue responses across rapid session/tab switches. */
let refreshVersion = 0;

export const useQueueStore = create<QueueStore>()(set => ({
	steering: [],
	followUp: [],
	refresh: async () => {
		const version = ++refreshVersion;
		try {
			const response = await window.omp.rpc.getQueue();
			if (version !== refreshVersion || !response.success) return;
			const data = response.data as RpcGetQueueResult;
			set({ steering: data.steering, followUp: data.followUp });
		} catch {
			// Sidecar mid-restart or a stale session: keep the last snapshot;
			// the next hydrate/queue_update refetches.
		}
	},
	setFromFrame: snapshot => {
		refreshVersion += 1;
		set({ steering: snapshot.steering, followUp: snapshot.followUp });
	},
}));

/**
 * Queue data plus the hydrate-fallback wiring: pull get_queue on mount (the
 * frame stream only carries mutations after subscription). Steady-state
 * updates arrive as queue_update frames via use-rpc-events.
 */
export function useQueuedMessages(): { steering: RpcQueuedMessage[]; followUp: RpcQueuedMessage[] } {
	const steering = useQueueStore(s => s.steering);
	const followUp = useQueueStore(s => s.followUp);
	useEffect(() => {
		void useQueueStore.getState().refresh();
	}, []);
	return { steering, followUp };
}
