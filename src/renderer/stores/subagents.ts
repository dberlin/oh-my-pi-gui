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
	return (frame as SubagentLifecycleFrame & { parentSubagentId?: string }).parentSubagentId;
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
				subagents = new Map(get().subagents);
				const existing = subagents.get(frame.id);
				subagents.set(frame.id, {
					id: frame.id,
					index: frame.index,
					agent: frame.agent,
					agentSource: frame.agentSource,
					description: frame.description,
					status: frame.status,
					task: frame.task,
					assignment: frame.assignment,
					sessionFile: frame.sessionFile,
					parentToolCallId: frame.parentToolCallId,
					// ?? existing: follow-up frames that lack the field keep the spawn-time value.
					parentSubagentId: parentSubagentIdFromFrame(frame) ?? existing?.parentSubagentId,
				});
				break;
			}
			case "subagent_progress": {
				const existing = [...get().subagents.values()].find(s => s.index === frame.index);
				if (existing) {
					subagents = new Map(get().subagents);
					subagents.set(existing.id, {
						...existing,
						progress: frame.progress,
						lastUpdate: frame.progress.description,
					});
				}
				break;
			}
			case "subagent_event": {
				const existing = get().subagents.get(frame.id);
				if (existing) {
					subagents = new Map(get().subagents);
					subagents.set(frame.id, { ...existing });
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
