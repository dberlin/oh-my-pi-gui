import { describe, expect, it } from "vitest";
import {
	buildSessionTreeLayout,
	SESSION_ROOT_ID,
	type SessionTreeEntry,
	TREE_NODE_HEIGHT,
	TREE_NODE_WIDTH,
} from "./session-tree-layout";

function entry(entryId: string, parentId: string | null, timestamp = 0): SessionTreeEntry {
	return {
		entryId,
		parentId,
		role: timestamp % 2 === 0 ? "user" : "assistant",
		textPreview: `message ${entryId}`,
		timestamp,
		onActiveBranch: true,
		isLeaf: false,
	};
}

describe("buildSessionTreeLayout", () => {
	it.each(["root-first", "leaf-first"])("lays out every message and edge of a 12,000-deep %s session", order => {
		// The dialog consumes these coordinates for cards, edges, culling, and
		// fit-to-view bounds. A recursive placement cannot complete this lineage.
		const count = 12_000;
		const entries = Array.from({ length: count }, (_, index) =>
			entry(`e${index}`, index === 0 ? null : `e${index - 1}`, index),
		);
		entries[count - 1]!.isLeaf = true;
		if (order === "leaf-first") entries.reverse();
		const layout = buildSessionTreeLayout(entries);

		expect(layout.nodeCount).toBe(count);
		expect(layout.nodes).toHaveLength(count + 1);
		expect(layout.edges).toHaveLength(count);
		expect(layout.forkCount).toBe(0);
		expect(layout.width).toBe(272);
		expect(layout.height).toBe(1_320_102);
		expect(layout.nodes[0]).toEqual({ id: SESSION_ROOT_ID, entry: null, depth: 0, x: 20, y: 20 });
		expect(layout.nodes.find(node => node.id === "e11999")).toMatchObject({
			depth: 12_000,
			x: 20,
			y: 1_320_020,
		});

		const invalidNodes: string[] = [];
		const invalidEdges: string[] = [];
		for (let index = 0; index < entries.length; index++) {
			const expectedEntry = entries[index]!;
			const node = layout.nodes[index + 1]!;
			const depth = expectedEntry.timestamp + 1;
			if (
				node.id !== expectedEntry.entryId ||
				node.entry !== expectedEntry ||
				node.depth !== depth ||
				node.x !== 20 ||
				node.y !== 20 + depth * 110 ||
				node.x + TREE_NODE_WIDTH > layout.width ||
				node.y + TREE_NODE_HEIGHT > layout.height
			) {
				invalidNodes.push(expectedEntry.entryId);
			}
			const edge = layout.edges[index]!;
			const parentId = expectedEntry.parentId ?? SESSION_ROOT_ID;
			if (
				edge.parentId !== parentId ||
				edge.childId !== expectedEntry.entryId ||
				edge.id !== `${parentId}->${expectedEntry.entryId}`
			) {
				invalidEdges.push(expectedEntry.entryId);
			}
		}
		expect(invalidNodes).toEqual([]);
		expect(invalidEdges).toEqual([]);
	});

	it("retains uneven fork geometry and sibling wire order when children precede parents", () => {
		const entries = [
			entry("right-leaf", "right"),
			entry("left", "parent"),
			entry("parent", null),
			entry("left-first", "left"),
			entry("right", "parent"),
			entry("left-second", "left"),
			entry("orphan", "missing"),
		];
		const layout = buildSessionTreeLayout(entries);

		expect(layout.nodes.map(({ id, depth, x, y }) => ({ id, depth, x, y }))).toEqual([
			{ id: SESSION_ROOT_ID, depth: 0, x: 572.5, y: 20 },
			{ id: "right-leaf", depth: 3, x: 540, y: 350 },
			{ id: "left", depth: 2, x: 150, y: 240 },
			{ id: "parent", depth: 1, x: 345, y: 130 },
			{ id: "left-first", depth: 3, x: 20, y: 350 },
			{ id: "right", depth: 2, x: 540, y: 240 },
			{ id: "left-second", depth: 3, x: 280, y: 350 },
			{ id: "orphan", depth: 1, x: 800, y: 130 },
		]);
		expect(layout.edges.map(({ parentId, childId }) => [parentId, childId])).toEqual([
			["right", "right-leaf"],
			["parent", "left"],
			[SESSION_ROOT_ID, "parent"],
			["left", "left-first"],
			["parent", "right"],
			["left", "left-second"],
			[SESSION_ROOT_ID, "orphan"],
		]);
		expect(layout).toMatchObject({ width: 1052, height: 432, forkCount: 2, nodeCount: 7 });
		expect(layout.nodes.slice(1).map(node => node.entry)).toEqual(entries);
	});

	it("breaks a cycle reached through a feeder while retaining resolved descendants and independent roots", () => {
		const layout = buildSessionTreeLayout([
			entry("feeder", "tail"),
			entry("a", "c"),
			entry("b", "a"),
			entry("c", "b"),
			entry("tail", "a"),
			entry("self", "self"),
			entry("orphan", "missing"),
			entry("orphan-child", "orphan"),
		]);

		expect(layout.nodes.map(node => [node.id, node.depth])).toEqual([
			[SESSION_ROOT_ID, 0],
			["feeder", 1],
			["a", 1],
			["b", 2],
			["c", 3],
			["tail", 2],
			["self", 1],
			["orphan", 1],
			["orphan-child", 2],
		]);
		expect(layout.edges.map(({ parentId, childId }) => [parentId, childId])).toEqual([
			[SESSION_ROOT_ID, "feeder"],
			[SESSION_ROOT_ID, "a"],
			["a", "b"],
			["b", "c"],
			["a", "tail"],
			[SESSION_ROOT_ID, "self"],
			[SESSION_ROOT_ID, "orphan"],
			["orphan", "orphan-child"],
		]);
		expect(layout).toMatchObject({ width: 1312, height: 432, forkCount: 1, nodeCount: 8 });

		// Every non-root has one edge from a shallower, present node: following
		// parents must terminate at the synthetic root, not another cycle.
		const nodes = new Map(layout.nodes.map(node => [node.id, node]));
		expect(new Set(layout.edges.map(edge => edge.childId)).size).toBe(8);
		for (const edge of layout.edges) {
			const parent = nodes.get(edge.parentId)!;
			const child = nodes.get(edge.childId)!;
			expect(child.depth).toBe(parent.depth + 1);
			expect(child.y).toBeGreaterThan(parent.y);
			expect(Number.isFinite(child.x)).toBe(true);
			expect(child.x).toBeGreaterThanOrEqual(20);
			expect(child.x + TREE_NODE_WIDTH).toBeLessThanOrEqual(layout.width);
			expect(child.y + TREE_NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
		}
	});

	it("keeps a padded synthetic root and no edges for an empty session", () => {
		expect(buildSessionTreeLayout([])).toEqual({
			nodes: [{ id: SESSION_ROOT_ID, entry: null, depth: 0, x: 20, y: 20 }],
			edges: [],
			width: 272,
			height: 102,
			forkCount: 0,
			nodeCount: 0,
		});
	});
});
