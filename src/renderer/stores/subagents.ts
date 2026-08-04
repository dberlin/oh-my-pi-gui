import { create } from "zustand";
import type { SubagentFrame, SubagentLifecycleFrame, SubagentSnapshot } from "../../shared/rpc-types";

/**
 * GUI-local snapshot extension: `parentSubagentId` is on the wire
 * (RpcSubagentSnapshot) but not yet mirrored into shared/rpc-types.ts.
 * Drop this interface once the mirror lands.
 */
export interface SubagentNode extends SubagentSnapshot {
	parentSubagentId?: string;
}

/** Structural read of the wire field until shared/rpc-types.ts declares it. */
function parentSubagentIdFromFrame(frame: SubagentLifecycleFrame): string | undefined {
	return (frame.payload as SubagentLifecycleFrame["payload"] & { parentSubagentId?: string }).parentSubagentId;
}

interface SubagentsStore {
	subagents: Map<string, SubagentNode>;
	applyFrame: (frame: SubagentFrame) => void;
	setSnapshots: (snapshots: SubagentNode[]) => void;
	reset: () => void;
}

export const useSubagentsStore = create<SubagentsStore>()((set, get) => ({
	subagents: new Map(),
	applyFrame: frame => {
		// Copy-on-first-write: frames that match no known subagent leave the
		// map untouched and must not trigger a re-render.
		let subagents: Map<string, SubagentNode> | null = null;

		switch (frame.type) {
			case "subagent_lifecycle": {
				const p = frame.payload;
				subagents = new Map(get().subagents);
				const existing = subagents.get(p.id);
				subagents.set(p.id, {
					id: p.id,
					index: p.index,
					agent: p.agent,
					agentSource: p.agentSource,
					description: p.description ?? existing?.description,
					status: p.status,
					task: p.task ?? existing?.task,
					assignment: p.assignment ?? existing?.assignment,
					sessionFile: p.sessionFile ?? existing?.sessionFile,
					parentToolCallId: p.parentToolCallId ?? existing?.parentToolCallId,
					// ?? existing: follow-up frames that lack the field keep the spawn-time value.
					parentSubagentId: parentSubagentIdFromFrame(frame) ?? existing?.parentSubagentId,
				});
				break;
			}
			case "subagent_progress": {
				// Attribute by the subagent id on the wire — `index` is the
				// per-batch spawn ordinal and repeats across task batches.
				const id = frame.payload.progress?.id;
				if (!id) break;
				const existing = get().subagents.get(id);
				if (existing) {
					subagents = new Map(get().subagents);
					subagents.set(id, {
						...existing,
						progress: frame.payload.progress,
						lastUpdate: frame.payload.progress?.description,
					});
				}
				break;
			}
			case "subagent_event": {
				const id = frame.payload.id;
				const existing = get().subagents.get(id);
				if (existing) {
					subagents = new Map(get().subagents);
					subagents.set(id, { ...existing });
				}
				break;
			}
		}

		if (subagents) set({ subagents });
	},
	setSnapshots: snapshots => {
		const subagents = new Map<string, SubagentNode>();
		for (const snap of snapshots) {
			subagents.set(snap.id, snap);
		}
		set({ subagents });
	},
	reset: () => set({ subagents: new Map() }),
}));
