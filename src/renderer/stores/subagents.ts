import { create } from "zustand";
import type { AgentMessage, SubagentFrame, SubagentSnapshot } from "../../shared/rpc-types";
import { useAgentViewStore } from "./agent-view";

export type SubagentNode = SubagentSnapshot;

/** Recover inspectable terminal agents after the live registry has released them. */
export function historicalSubagentsFromMessages(
	messages: AgentMessage[],
	parentSessionFile?: string | null,
): SubagentNode[] {
	const sessionDirectory = parentSessionFile?.endsWith(".jsonl") ? parentSessionFile.slice(0, -".jsonl".length) : null;
	const snapshots: SubagentNode[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "task") continue;
			const taskValues = Array.isArray(block.arguments.tasks) ? block.arguments.tasks : [];
			for (const taskValue of taskValues) {
				if (taskValue === null || typeof taskValue !== "object" || Array.isArray(taskValue)) continue;
				const task = taskValue as Record<string, unknown>;
				const name = typeof task.name === "string" ? task.name.trim() : "";
				if (!name || seen.has(name)) continue;
				seen.add(name);
				const assignment = typeof task.task === "string" ? task.task : undefined;
				const timestamp =
					typeof message.timestamp === "number"
						? message.timestamp
						: typeof message.timestamp === "string"
							? Date.parse(message.timestamp)
							: Number.NaN;
				snapshots.push({
					id: name,
					index: snapshots.length,
					agent: typeof task.agent === "string" && task.agent ? task.agent : "task",
					status: "unknown",
					task: assignment,
					assignment,
					description: name,
					sessionFile: sessionDirectory ? `${sessionDirectory}/${name}.jsonl` : undefined,
					lastUpdate: Number.isFinite(timestamp) ? timestamp : Date.now(),
					parentToolCallId: block.id,
					kind: "sub",
				});
			}
		}
	}
	return snapshots;
}
interface SubagentsStore {
	subagents: Map<string, SubagentNode>;
	/** Maps a `task` tool call id to the id of the subagent whose transcript contains it. */
	toolCallOwners: Map<string, string>;
	registerToolCallOwners: (agentId: string, toolCallIds: string[]) => void;
	applyFrame: (frame: SubagentFrame) => void;
	invalidateRefresh: () => void;
	/** Replace from a successful authoritative get_subagents response. */
	setSnapshots: (snapshots: SubagentNode[]) => void;
	/**
	 * Pull the full roster over get_subagents and MERGE it. Unlike
	 * setSnapshots this keeps local terminal rows: the RPC registry deletes
	 * completed/failed agents on their terminal lifecycle frame (AgentRegistry
	 * retains only parked/aborted refs), so a wholesale replace would make
	 * finished agents vanish from the UI on every poll. Best-effort — a
	 * failed fetch leaves frame-driven state untouched.
	 */
	refresh: (options?: { expect?: () => boolean }) => Promise<void>;
	reset: () => void;
}

/**
 * Live (non-terminal) wire statuses, mirror of statusMeta().live in
 * components/panels/subagent-graph (component layer — not importable here).
 * Rows absent from a refresh fetch are dropped when live (released) but kept
 * when terminal (the server forgets them; the user is still looking at them).
 */
const LIVE_STATUSES: Record<string, true> = {
	started: true,
	running: true,
	pending: true,
	idle: true,
	parked: true,
	// Stale registrations remain server-owned rows and must disappear after
	// hub cancel removes them; do not retain them as terminal history.
	stale: true,
};

function normalizeSnapshot(snapshot: SubagentNode): SubagentNode {
	return snapshot.status === "running" && snapshot.live === false ? { ...snapshot, status: "stale" } : snapshot;
}

/**
 * Merge one fetched row over the local one: the fetch wins EXCEPT it may never
 * blank a populated label/progress field. Server rows discovered late (bare
 * AgentRegistry refs) can lack task/assignment/description/progress/sessionFile
 * that a progress frame already delivered — replacing wholesale would blank
 * the card and lose durationMs mid-poll.
 */
function mergeFetchedSnapshot(fresh: SubagentNode, prev: SubagentNode): SubagentNode {
	return {
		...fresh,
		task: fresh.task ?? prev.task,
		assignment: fresh.assignment ?? prev.assignment,
		description: fresh.description ?? prev.description,
		progress: fresh.progress ?? prev.progress,
		sessionFile: fresh.sessionFile ?? prev.sessionFile,
	};
}
let refreshRevision = 0;
export const useSubagentsStore = create<SubagentsStore>()((set, get) => ({
	subagents: new Map(),
	toolCallOwners: new Map(),
	registerToolCallOwners: (agentId, toolCallIds) => {
		const current = get().toolCallOwners;
		let next: Map<string, string> | null = null;
		for (const id of toolCallIds) {
			if (current.get(id) === agentId) continue;
			if (!next) next = new Map(current);
			next.set(id, agentId);
		}
		if (next) set({ toolCallOwners: next });
	},
	applyFrame: frame => {
		refreshRevision += 1;
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
					status: p.status === "started" ? "running" : p.status,
					task: existing?.task,
					assignment: existing?.assignment,
					sessionFile: p.sessionFile ?? existing?.sessionFile,
					lastUpdate: Date.now(),
					parentToolCallId: p.parentToolCallId ?? existing?.parentToolCallId,
					parentSubagentId: p.parentSubagentId ?? existing?.parentSubagentId,
					progress: existing?.progress,
					kind: existing?.kind ?? "sub",
				});
				break;
			}
			case "subagent_progress": {
				// Attribute by stable id, not the per-batch index. A progress
				// frame can be the first frame observed after a late subscription,
				// so materialize the row instead of silently dropping it.
				const progress = frame.payload.progress;
				if (!progress?.id) break;
				const existing = get().subagents.get(progress.id);
				subagents = new Map(get().subagents);
				subagents.set(progress.id, {
					id: progress.id,
					index: frame.payload.index,
					agent: frame.payload.agent,
					agentSource: frame.payload.agentSource,
					description: progress.description ?? existing?.description,
					status: progress.status,
					task: frame.payload.task,
					assignment: frame.payload.assignment ?? existing?.assignment,
					sessionFile: frame.payload.sessionFile ?? existing?.sessionFile,
					lastUpdate: Date.now(),
					parentToolCallId: frame.payload.parentToolCallId ?? existing?.parentToolCallId,
					parentSubagentId: frame.payload.parentSubagentId ?? existing?.parentSubagentId,
					kind: existing?.kind ?? "sub",
					progress,
				});
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

		if (subagents) {
			set({ subagents });
			const view = useAgentViewStore.getState();
			if (view.target.kind === "subagent") {
				const selected = subagents.get(view.target.id);
				if (selected) view.updateSnapshot(selected);
			}
		}
	},
	setSnapshots: snapshots => {
		refreshRevision += 1;
		const subagents = new Map<string, SubagentNode>();
		for (const snap of snapshots) {
			const normalized = normalizeSnapshot(snap);
			subagents.set(normalized.id, normalized);
		}
		set({ subagents });
		useAgentViewStore.getState().reconcileRoster(subagents.values());
	},
	refresh: async options => {
		const revision = ++refreshRevision;
		try {
			const res = await window.omp.rpc.getSubagents();
			// Post-await guard: the poll may have been sent for a tab/session
			// that is no longer foreground — its snapshots must not merge into
			// the new session's store.
			if (options?.expect && !options.expect()) return;
			if (revision !== refreshRevision || !res.success) return;
			const data = res.data as { subagents?: SubagentNode[] } | undefined;
			if (!data?.subagents) return;
			const current = get().subagents;
			const fetched = new Set<string>();
			const subagents = new Map<string, SubagentNode>();
			for (const snap of data.subagents) {
				const normalized = normalizeSnapshot(snap);
				fetched.add(normalized.id);
				const prev = current.get(normalized.id);
				subagents.set(normalized.id, prev ? mergeFetchedSnapshot(normalized, prev) : normalized);
			}
			// Terminal rows the server has forgotten survive the merge — see the
			// refresh docstring (RPC registry deletes completed/failed agents).
			for (const [id, node] of current) {
				if (!fetched.has(id) && !LIVE_STATUSES[node.status]) subagents.set(id, node);
			}
			set({ subagents });
			useAgentViewStore.getState().reconcileRoster(subagents.values());
		} catch {
			// Best-effort poll: frames + hydration remain authoritative.
		}
	},
	invalidateRefresh: () => {
		refreshRevision += 1;
	},
	reset: () => {
		refreshRevision += 1;
		set({ subagents: new Map(), toolCallOwners: new Map() });
	},
}));
