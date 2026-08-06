/**
 * Queue store: the GUI's snapshot of the agent's pending steer/follow-up
 * queues. The `queue_update` session event is the authoritative update
 * channel — it fires on every queue mutation (enqueue, drain/consume,
 * remove, move, clear, dequeue restore) and lands here via setFromFrame from
 * the onBatch handler. get_queue survives only as the hydrate fallback
 * (mount, sidecar reconnect) since no snapshot predates the subscription.
 * Shared by the ActivityStrip queue segment, the QueuePanel drawer tab, and
 * the pending bubbles at the message-stream tail.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { RpcGetQueueResult, RpcQueuedMessage } from "../../shared/rpc-types";

export type QueueLane = "steering" | "followUp";

interface QueueStore {
	steering: RpcQueuedMessage[];
	followUp: RpcQueuedMessage[];
	/** Hydrate fallback pull via get_queue; concurrent refreshes share it. */
	refresh: () => Promise<void>;
	/** Apply an authoritative queue_update frame. */
	setFromFrame: (snapshot: RpcGetQueueResult) => void;
}

/** Guards against overlapping get_queue fetches; latest call wins on settle. */
let refreshInFlight: Promise<void> | undefined;

const EMPTY_QUEUE: RpcGetQueueResult = { steering: [], followUp: [] };

export const useQueueStore = create<QueueStore>()(set => ({
	steering: [],
	followUp: [],
	refresh: async () => {
		if (refreshInFlight) return refreshInFlight;
		refreshInFlight = (async () => {
			try {
				const response = await window.omp.rpc.getQueue();
				const data = response.success ? (response.data as RpcGetQueueResult | undefined) : undefined;
				set({
					steering: data?.steering ?? EMPTY_QUEUE.steering,
					followUp: data?.followUp ?? EMPTY_QUEUE.followUp,
				});
			} catch {
				// Sidecar mid-restart or a stale session: keep the last snapshot;
				// the next hydrate/queue_update refetches.
			} finally {
				refreshInFlight = undefined;
			}
		})();
		return refreshInFlight;
	},
	setFromFrame: snapshot => set({ steering: snapshot.steering, followUp: snapshot.followUp }),
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
