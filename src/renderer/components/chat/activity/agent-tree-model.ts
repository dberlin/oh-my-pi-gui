import type { AgentMessage, SubagentSnapshot } from "../../../../shared/rpc-types";
import { useSubagentsStore } from "../../../stores/subagents";
import type { BadgeVariant } from "../../common";

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

export function statusMeta(status: string): StatusMeta {
	return STATUS_META[status] ?? { label: status, variant: "muted", live: false, labelKey: "subagent.status.unknown" };
}

export function isLiveSubagentStatus(status: string): boolean {
	return statusMeta(status).live;
}

export function subagentElapsedMs(agent: SubagentSnapshot, now: number): number | null {
	const live = isLiveSubagentStatus(agent.status);
	const sampled = agent.progress?.durationMs;
	if (typeof sampled === "number" && Number.isFinite(sampled)) {
		const sinceSample = live && Number.isFinite(agent.lastUpdate) ? Math.max(0, now - agent.lastUpdate) : 0;
		return Math.max(0, sampled + sinceSample);
	}
	if (live && Number.isFinite(agent.lastUpdate)) return Math.max(0, now - agent.lastUpdate);
	return null;
}

export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

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

export function registerTranscriptToolCalls(agentId: string, messages: AgentMessage[]): void {
	const ids = extractTaskToolCallIds(messages);
	if (ids.length > 0) useSubagentsStore.getState().registerToolCallOwners(agentId, ids);
}

export function subagentPrimaryLabel(agent: SubagentSnapshot, maxLength = 60): string {
	const raw = agent.description ?? agent.assignment ?? agent.task ?? agent.agent;
	const text = raw.trim() || agent.agent;
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export interface SubagentListRow {
	agent: SubagentSnapshot;
	depth: number;
}

const MAIN_NODE_ID = "__main__";

function resolveParent(
	agent: SubagentSnapshot,
	byId: ReadonlyMap<string, SubagentSnapshot>,
	rootToolCallIds: ReadonlySet<string>,
	toolCallOwners: ReadonlyMap<string, string>,
): string {
	const explicitParentId = agent.parentSubagentId;
	if (explicitParentId && explicitParentId !== agent.id && byId.has(explicitParentId)) return explicitParentId;
	const callId = agent.parentToolCallId;
	if (!callId) return MAIN_NODE_ID;
	const owner = toolCallOwners.get(callId);
	if (owner && owner !== agent.id && byId.has(owner)) return owner;
	if (rootToolCallIds.has(callId)) return MAIN_NODE_ID;
	return MAIN_NODE_ID;
}

export function buildSubagentList(
	agents: SubagentSnapshot[],
	rootToolCallIds: ReadonlySet<string>,
	toolCallOwners: ReadonlyMap<string, string>,
): SubagentListRow[] {
	const sorted = [...agents].sort((left, right) => left.index - right.index);
	const byId = new Map(sorted.map(agent => [agent.id, agent]));
	const parentOf = new Map<string, string>();
	for (const agent of sorted) parentOf.set(agent.id, resolveParent(agent, byId, rootToolCallIds, toolCallOwners));

	for (const agent of sorted) {
		const seen = new Set<string>([agent.id]);
		let cursor = agent.id;
		while (cursor !== MAIN_NODE_ID) {
			const parent = parentOf.get(cursor) ?? MAIN_NODE_ID;
			if (parent !== MAIN_NODE_ID && seen.has(parent)) {
				parentOf.set(agent.id, MAIN_NODE_ID);
				break;
			}
			seen.add(parent);
			cursor = parent;
		}
	}

	const children = new Map<string, string[]>();
	for (const agent of sorted) {
		const parentId = parentOf.get(agent.id) ?? MAIN_NODE_ID;
		const siblings = children.get(parentId);
		if (siblings) siblings.push(agent.id);
		else children.set(parentId, [agent.id]);
	}

	const rows: SubagentListRow[] = [];
	const visited = new Set<string>();
	const visit = (parentId: string, depth: number): void => {
		for (const id of children.get(parentId) ?? []) {
			if (visited.has(id)) continue;
			visited.add(id);
			const agent = byId.get(id);
			if (agent) rows.push({ agent, depth });
			visit(id, depth + 1);
		}
	};
	visit(MAIN_NODE_ID, 0);
	return rows;
}
