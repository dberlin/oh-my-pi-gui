/**
 * Per-tab authoritative pending queues, hydrated from get_state.queuedMessages
 * and replaced by queue_update events. Stable-ID extension snapshots remain
 * supported, but vanilla text snapshots never acquire server IDs.
 */
import { useEffect } from "react";
import { createStore } from "zustand/vanilla";
import type { RpcGetQueueResult, RpcQueuedMessage, RpcResponse, RpcSessionState } from "../../shared/rpc-types";
import { activeTabCommand, createScopedStoreHook, type TabCommand } from "./session-runtime-context";

export type QueueLane = "steering" | "followUp";
type QueueSnapshot = NonNullable<RpcSessionState["queuedMessages"]> | RpcGetQueueResult;

export interface QueueStore {
	steering: RpcQueuedMessage[];
	followUp: RpcQueuedMessage[];
	/** True only after observing actual stable server IDs in an extension snapshot. */
	idOperations: boolean;
	/** Hydration can share its get_state read; the guard retires replaced owners. */
	refresh: (stateResponse?: Promise<RpcResponse>, isCurrent?: () => boolean) => Promise<void>;
	setFromFrame: (snapshot: QueueSnapshot) => void;
}

function displayLane(items: string[] | RpcQueuedMessage[], lane: QueueLane): RpcQueuedMessage[] {
	return items.map((item, index) => {
		if (typeof item !== "string") return item;
		// `id` here is a React/display key only, including duplicate occurrences.
		// Never send it as a queueId: vanilla mutations address the exact text.
		return { id: `display:${lane}:${index}`, text: item, editable: false, timestamp: 0 };
	});
}

function displaySnapshot(snapshot: QueueSnapshot) {
	const first = snapshot.steering[0] ?? snapshot.followUp[0];
	return {
		steering: displayLane(snapshot.steering, "steering"),
		followUp: displayLane(snapshot.followUp, "followUp"),
		idOperations: first !== undefined && typeof first !== "string",
	};
}

export const createQueueStore = (command: TabCommand = activeTabCommand) => {
	let refreshVersion = 0;
	return createStore<QueueStore>()((set, get) => ({
		steering: [],
		followUp: [],
		idOperations: false,
		refresh: async (stateResponse, isCurrent = () => true) => {
			const version = ++refreshVersion;
			try {
				const response = await (stateResponse ?? command({ type: "get_state" }));
				if (version !== refreshVersion || !isCurrent() || !response.success) return;
				const state = response.data as RpcSessionState | undefined;
				if (state?.queuedMessages) {
					set(displaySnapshot(state.queuedMessages));
					return;
				}
				// Only observed stable-ID snapshots prove the extension API exists.
				// Absent optional vanilla metadata must not trigger fork-only RPC.
				if (!get().idOperations) return;
				const legacy = await command({ type: "get_queue" });
				if (version !== refreshVersion || !isCurrent() || !legacy.success || !legacy.data) return;
				set(displaySnapshot(legacy.data as RpcGetQueueResult));
			} catch {
				// Keep the last authoritative snapshot during a transport restart.
			}
		},
		setFromFrame: snapshot => {
			refreshVersion += 1;
			set(displaySnapshot(snapshot));
		},
	}));
};

const defaultQueueStore = createQueueStore();
export const useQueueStore = createScopedStoreHook("queue", defaultQueueStore);

/** Pull the initial queue once; subsequent mutations arrive as snapshots. */
export function useQueuedMessages(): { steering: RpcQueuedMessage[]; followUp: RpcQueuedMessage[] } {
	const steering = useQueueStore(s => s.steering);
	const followUp = useQueueStore(s => s.followUp);
	const refresh = useQueueStore(s => s.refresh);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	return { steering, followUp };
}
