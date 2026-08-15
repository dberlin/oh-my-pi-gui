import { z } from "zod";
import { create } from "zustand";
import type { AgentMessage, SubagentFrame, SubagentSnapshot } from "../../shared/rpc-types";
import { useAgentViewStore } from "./agent-view";

export type SubagentNode = SubagentSnapshot;

const historicalTaskEvidenceSchema = z.looseObject({
	index: z.number().int().optional(),
	id: z.string().optional(),
	agent: z.string().optional(),
	status: z.string().optional(),
	task: z.string().optional(),
	assignment: z.string().optional(),
	description: z.string().optional(),
	sessionFile: z.string().optional(),
	aborted: z.boolean().optional(),
	error: z.string().optional(),
	exitCode: z.number().optional(),
});
type HistoricalTaskEvidence = z.infer<typeof historicalTaskEvidenceSchema>;

const historicalTaskDetailsSchema = z.looseObject({
	progress: z.array(historicalTaskEvidenceSchema).optional(),
	results: z.array(historicalTaskEvidenceSchema).optional(),
});

const requestedHistoricalTaskSchema = z.looseObject({
	name: z.string().optional(),
	agent: z.string().optional(),
	task: z.string().optional(),
});
const HISTORICAL_TERMINAL_STATUSES = new Set(["completed", "failed", "aborted", "cancelled"]);

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function taskEvidenceQueues(messages: AgentMessage[]): Map<string, Map<number, HistoricalTaskEvidence>[]> {
	const queues = new Map<string, Map<number, HistoricalTaskEvidence>[]>();
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolName !== "task" || !message.toolCallId) continue;
		const parsed = historicalTaskDetailsSchema.safeParse(message.details);
		if (!parsed.success) continue;
		const byIndex = new Map<number, HistoricalTaskEvidence>();
		for (const rows of [parsed.data.progress, parsed.data.results]) {
			if (!rows) continue;
			for (const [position, value] of rows.entries()) byIndex.set(value.index ?? position, value);
		}
		const queue = queues.get(message.toolCallId);
		if (queue) queue.push(byIndex);
		else queues.set(message.toolCallId, [byIndex]);
	}
	return queues;
}

function historicalStatus(evidence: HistoricalTaskEvidence | undefined): string {
	const status = nonEmptyString(evidence?.status);
	if (status && HISTORICAL_TERMINAL_STATUSES.has(status)) return status;
	if (evidence?.aborted === true) return "aborted";
	if (nonEmptyString(evidence?.error)) return "failed";
	if (typeof evidence?.exitCode === "number") return evidence.exitCode === 0 ? "completed" : "failed";
	return "unknown";
}
/** Recover inspectable terminal agents after the live registry has released them. */
export function historicalSubagentsFromMessages(
	messages: AgentMessage[],
	parentSessionFile?: string | null,
): SubagentNode[] {
	const sessionDirectory = parentSessionFile?.endsWith(".jsonl") ? parentSessionFile.slice(0, -".jsonl".length) : null;
	const evidenceQueues = taskEvidenceQueues(messages);
	const snapshots: SubagentNode[] = [];
	const seen = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || block.name !== "task") continue;
			const taskValues = Array.isArray(block.arguments.tasks) ? block.arguments.tasks : [];
			const evidenceByIndex = evidenceQueues.get(block.id)?.shift();
			for (const [taskIndex, taskValue] of taskValues.entries()) {
				const requested = requestedHistoricalTaskSchema.safeParse(taskValue);
				if (!requested.success) continue;
				const evidence = evidenceByIndex?.get(taskIndex);
				const requestedName = nonEmptyString(requested.data.name);
				const canonicalId = nonEmptyString(evidence?.id);
				const id = canonicalId ?? requestedName;
				if (!id || seen.has(id)) continue;
				seen.add(id);
				const requestedTask = nonEmptyString(requested.data.task);
				const task = nonEmptyString(evidence?.task) ?? requestedTask;
				const assignment = nonEmptyString(evidence?.assignment) ?? requestedTask;
				const timestamp =
					typeof message.timestamp === "number"
						? message.timestamp
						: typeof message.timestamp === "string"
							? Date.parse(message.timestamp)
							: Number.NaN;
				snapshots.push({
					id,
					index: snapshots.length,
					agent: nonEmptyString(evidence?.agent) ?? nonEmptyString(requested.data.agent) ?? "task",
					status: historicalStatus(evidence),
					task,
					assignment,
					description: nonEmptyString(evidence?.description) ?? requestedName ?? id,
					sessionFile:
						nonEmptyString(evidence?.sessionFile) ??
						(sessionDirectory ? `${sessionDirectory}/${id}.jsonl` : undefined),
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
 * components/chat/activity/agent-tree-model (component layer — not importable here).
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
