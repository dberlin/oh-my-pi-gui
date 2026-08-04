/**
 * Shared subagent graph model: status metadata, elapsed-time helpers, the
 * tool-call ownership registry used to recover parent→child spawn edges, and
 * the pure layered-tree layout builder behind SubagentDag.
 *
 * The wire carries an explicit parent link for nested spawns
 * (`parentSubagentId`); frames that predate it fall back to attributing the
 * spawning `task` tool call (`parentToolCallId`) to its owning session —
 * the main session's messages for top-level spawns, the tool-call ownership
 * registry (filled in as transcripts load) for nested ones.
 */

import { create } from "zustand";
import type { AgentMessage, SubagentSnapshot } from "../../../shared/rpc-types";
import type { BadgeVariant } from "../common";

/**
 * Status presentation for a subagent row. The wire's status is FREE-FORM
 * (lifecycle statuses plus arbitrary progress payloads: "started", "running",
 * "pending", "completed", "failed", "aborted", "cancelled", "idle", "parked",
 * and anything an agent emits). Never index a Record with it unchecked — a
 * missing key was the white-screen crash on the agents tab (meta.live of
 * undefined). Always go through statusMeta()/isLiveSubagentStatus().
 */
export interface StatusMeta {
	label: string;
	variant: BadgeVariant;
	live: boolean;
	labelKey: string;
}

const STATUS_META: Record<string, StatusMeta> = {
	started: { label: "running", variant: "info", live: true, labelKey: "subagent.status.started" },
	running: { label: "running", variant: "info", live: true, labelKey: "subagent.status.started" },
	pending: { label: "pending", variant: "muted", live: true, labelKey: "subagent.status.pending" },
	idle: { label: "idle", variant: "muted", live: true, labelKey: "subagent.status.idle" },
	parked: { label: "parked", variant: "muted", live: true, labelKey: "subagent.status.parked" },
	completed: { label: "completed", variant: "success", live: false, labelKey: "subagent.status.completed" },
	failed: { label: "failed", variant: "error", live: false, labelKey: "subagent.status.failed" },
	aborted: { label: "cancelled", variant: "muted", live: false, labelKey: "subagent.status.cancelled" },
	cancelled: { label: "cancelled", variant: "muted", live: false, labelKey: "subagent.status.cancelled" },
};

/** Total lookup — unknown/future statuses degrade to a muted badge with the raw status text. */
export function statusMeta(status: string): StatusMeta {
	return STATUS_META[status] ?? { label: status, variant: "muted", live: false, labelKey: "subagent.status.unknown" };
}

/** True for non-terminal statuses (drives elapsed timers, pulse dots, running counts). */
export function isLiveSubagentStatus(status: string): boolean {
	return statusMeta(status).live;
}

/** First time each agent id was observed, for elapsed-time display. */
const firstSeen = new Map<string, number>();

/** Record (once) when an agent id was first observed; returns that timestamp. */
export function noteFirstSeen(id: string): number {
	const existing = firstSeen.get(id);
	if (existing !== undefined) return existing;
	const seen = Date.now();
	firstSeen.set(id, seen);
	return seen;
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Ids of `task` tool calls found in a message list (main session or a subagent transcript). */
export function extractTaskToolCallIds(messages: AgentMessage[]): string[] {
	const ids: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "toolCall" && part.name === "task") ids.push(part.id);
		}
	}
	return ids;
}

interface SubagentGraphStore {
	/** Maps a `task` tool call id to the id of the subagent whose transcript contains it. */
	toolCallOwners: Map<string, string>;
	registerToolCallOwners: (agentId: string, toolCallIds: string[]) => void;
}

export const useSubagentGraphStore = create<SubagentGraphStore>()((set, get) => ({
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
}));

/** Register every `task` tool call found in a loaded transcript page as owned by that subagent. */
export function registerTranscriptToolCalls(agentId: string, messages: AgentMessage[]): void {
	const ids = extractTaskToolCallIds(messages);
	if (ids.length > 0) useSubagentGraphStore.getState().registerToolCallOwners(agentId, ids);
}

// ============================================================================
// DAG layout
// ============================================================================

/** Synthetic node anchoring every top-level (or unresolved) spawn. */
export const MAIN_NODE_ID = "__main__";
export const DAG_NODE_WIDTH = 216;
export const DAG_NODE_HEIGHT = 56;
const DAG_GAP_X = 64;
const DAG_GAP_Y = 14;
const DAG_PAD = 14;

export interface DagNode {
	id: string;
	/** Null only for the synthetic main-session node. */
	agent: SubagentSnapshot | null;
	depth: number;
	x: number;
	y: number;
}

export interface DagEdge {
	id: string;
	parentId: string;
	childId: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface SubagentDagLayout {
	nodes: DagNode[];
	edges: DagEdge[];
	width: number;
	height: number;
	/** Agent ids whose parent tool call could not be attributed; attached to the main node instead. */
	unresolved: string[];
}

/**
 * Reads the spawn-parent link off a snapshot. The field is on the wire
 * (RpcSubagentSnapshot.parentSubagentId — the spawning subagent's registry
 * id, absent for root spawns) but not yet mirrored into shared/rpc-types.ts,
 * hence the structural read. Drop the cast once the mirror lands.
 */
export function parentSubagentIdOf(agent: SubagentSnapshot): string | undefined {
	return (agent as SubagentSnapshot & { parentSubagentId?: string }).parentSubagentId;
}

function resolveParent(
	agent: SubagentSnapshot,
	byId: Map<string, SubagentSnapshot>,
	rootToolCallIds: ReadonlySet<string>,
	toolCallOwners: ReadonlyMap<string, string>,
): { parentId: string; inferred: boolean } {
	// Preferred: explicit spawn link on the wire.
	const parentId = parentSubagentIdOf(agent);
	if (parentId && parentId !== agent.id && byId.has(parentId)) return { parentId, inferred: false };

	// Fallback: attribute the spawning `task` tool call to its owning session.
	const callId = agent.parentToolCallId;
	if (!callId) return { parentId: MAIN_NODE_ID, inferred: parentId !== undefined };
	const owner = toolCallOwners.get(callId);
	if (owner && owner !== agent.id && byId.has(owner)) return { parentId: owner, inferred: false };
	if (rootToolCallIds.has(callId)) return { parentId: MAIN_NODE_ID, inferred: false };
	return { parentId: MAIN_NODE_ID, inferred: true };
}

/**
 * Layered tidy-tree layout: depth columns left→right, siblings stacked
 * vertically, parents centered on their children. Every agent hangs off the
 * synthetic main node unless its `parentToolCallId` resolves to another
 * subagent, so the result is always a single tree.
 */
export function buildSubagentDag(
	agents: SubagentSnapshot[],
	rootToolCallIds: ReadonlySet<string>,
	toolCallOwners: ReadonlyMap<string, string>,
): SubagentDagLayout {
	const sorted = [...agents].sort((a, b) => a.index - b.index);
	const byId = new Map<string, SubagentSnapshot>();
	for (const agent of sorted) byId.set(agent.id, agent);

	const parentOf = new Map<string, string>();
	const unresolved: string[] = [];
	for (const agent of sorted) {
		const { parentId, inferred } = resolveParent(agent, byId, rootToolCallIds, toolCallOwners);
		parentOf.set(agent.id, parentId);
		if (inferred) unresolved.push(agent.id);
	}

	// Depth via walk-up with cycle protection; a cycle re-attaches the node to main.
	const depthOf = new Map<string, number>([[MAIN_NODE_ID, 0]]);
	for (const agent of sorted) {
		const seen = new Set<string>([agent.id]);
		let cursor = agent.id;
		let hops = 0;
		let cycled = false;
		while (cursor !== MAIN_NODE_ID) {
			const parent = parentOf.get(cursor) ?? MAIN_NODE_ID;
			if (parent !== MAIN_NODE_ID) {
				if (seen.has(parent)) {
					cycled = true;
					break;
				}
				seen.add(parent);
			}
			cursor = parent;
			hops++;
		}
		if (cycled) parentOf.set(agent.id, MAIN_NODE_ID);
		depthOf.set(agent.id, cycled ? 1 : hops);
	}

	const childrenOf = new Map<string, string[]>();
	for (const agent of sorted) {
		const parent = parentOf.get(agent.id) ?? MAIN_NODE_ID;
		const siblings = childrenOf.get(parent);
		if (siblings) siblings.push(agent.id);
		else childrenOf.set(parent, [agent.id]);
	}

	// Tidy rows: leaves take successive slots; internal nodes center on children.
	let leafCount = 0;
	const slotOf = new Map<string, number>();
	const place = (id: string): number => {
		const kids = childrenOf.get(id) ?? [];
		if (kids.length === 0) {
			const slot = leafCount++;
			slotOf.set(id, slot);
			return slot;
		}
		let first = Number.POSITIVE_INFINITY;
		let last = Number.NEGATIVE_INFINITY;
		for (const kid of kids) {
			const slot = place(kid);
			first = Math.min(first, slot);
			last = Math.max(last, slot);
		}
		const slot = (first + last) / 2;
		slotOf.set(id, slot);
		return slot;
	};
	place(MAIN_NODE_ID);

	const rowPitch = DAG_NODE_HEIGHT + DAG_GAP_Y;
	const colPitch = DAG_NODE_WIDTH + DAG_GAP_X;
	const nodes: DagNode[] = [
		{
			id: MAIN_NODE_ID,
			agent: null,
			depth: 0,
			x: DAG_PAD,
			y: DAG_PAD + (slotOf.get(MAIN_NODE_ID) ?? 0) * rowPitch,
		},
	];
	let maxDepth = 0;
	for (const agent of sorted) {
		const depth = depthOf.get(agent.id) ?? 1;
		maxDepth = Math.max(maxDepth, depth);
		nodes.push({
			id: agent.id,
			agent,
			depth,
			x: DAG_PAD + depth * colPitch,
			y: DAG_PAD + (slotOf.get(agent.id) ?? 0) * rowPitch,
		});
	}

	const nodeById = new Map<string, DagNode>();
	for (const node of nodes) nodeById.set(node.id, node);
	const edges: DagEdge[] = [];
	for (const node of nodes) {
		if (node.id === MAIN_NODE_ID) continue;
		const parentId = parentOf.get(node.id) ?? MAIN_NODE_ID;
		const parent = nodeById.get(parentId);
		if (!parent) continue;
		edges.push({
			id: `${parentId}->${node.id}`,
			parentId,
			childId: node.id,
			x1: parent.x + DAG_NODE_WIDTH,
			y1: parent.y + DAG_NODE_HEIGHT / 2,
			x2: node.x,
			y2: node.y + DAG_NODE_HEIGHT / 2,
		});
	}

	return {
		nodes,
		edges,
		width: DAG_PAD * 2 + maxDepth * colPitch + DAG_NODE_WIDTH,
		height: DAG_PAD * 2 + Math.max(1, leafCount) * rowPitch - DAG_GAP_Y,
		unresolved,
	};
}
