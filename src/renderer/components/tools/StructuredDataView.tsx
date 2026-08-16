import { useState } from "react";
import { useT } from "../../lib/i18n";

export interface StructuredDataViewProps {
	value: unknown;
	defaultExpandedDepth?: number;
	maxDepth?: number;
	maxChildren?: number;
	maxNodes?: number;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

type StructuredEntry = {
	key: string;
	label: string;
	value: unknown;
};
type StructuredEntrySet = {
	entries: StructuredEntry[];
	total: number;
	omittedCount: number;
};
type StructuredEntryPlan = {
	key: string;
	label: string;
	node: StructuredNodePlan;
	budgetTruncated: boolean;
};
type StructuredChildrenPlan = {
	entries: StructuredEntryPlan[];
	omittedCount: number;
};
type StructuredNodePlan =
	| { kind: "scalar"; value: unknown }
	| { kind: "cycle" }
	| { kind: "depth-limit" }
	| { kind: "structured"; summary: string; children: StructuredChildrenPlan };
type StructuredPlanResult<T> = {
	plan: T;
	budgetTruncated: boolean;
};
type StructuredNodeProps = {
	node: StructuredNodePlan;
	label?: string;
	depth: number;
	defaultExpandedDepth: number;
	t: Translate;
};

const DEFAULT_EXPANDED_DEPTH = 1;
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_CHILDREN = 100;
const DEFAULT_MAX_NODES = 1_000;

function finiteLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function isStructured(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function semanticArrayKey(value: unknown, index: number): string {
	if (isStructured(value) && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		for (const name of ["id", "key", "name"] as const) {
			const candidate = record[name];
			if (typeof candidate === "string" || typeof candidate === "number") {
				return `${name}:${String(candidate)}`;
			}
		}
	}

	if (value === null) return "null";
	if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
		return `${typeof value}:${String(value)}`;
	}
	return `index:${index}`;
}

function structuredEntries(value: object, maxChildren: number, budgetCapacity: number): StructuredEntrySet {
	if (!Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		let total = 0;
		for (const key in record) {
			if (Object.hasOwn(record, key)) total += 1;
		}

		const omittedCount = Math.max(0, total - maxChildren);
		const capacity = Math.min(maxChildren, Math.max(0, budgetCapacity - (omittedCount > 0 ? 1 : 0)));
		const entries: StructuredEntry[] = [];
		if (capacity > 0) {
			for (const key in record) {
				if (!Object.hasOwn(record, key)) continue;
				entries.push({ key: `property:${key}`, label: key, value: record[key] });
				if (entries.length === capacity) break;
			}
		}
		return { entries, total, omittedCount };
	}

	const omittedCount = Math.max(0, value.length - maxChildren);
	const capacity = Math.min(maxChildren, Math.max(0, budgetCapacity - (omittedCount > 0 ? 1 : 0)));
	const duplicateCounts = new Map<string, number>();
	const entries: StructuredEntry[] = [];
	const visibleCount = Math.min(value.length, capacity);
	for (let index = 0; index < visibleCount; index += 1) {
		const entry = value[index];
		const semanticKey = semanticArrayKey(entry, index);
		const duplicateCount = duplicateCounts.get(semanticKey) ?? 0;
		duplicateCounts.set(semanticKey, duplicateCount + 1);
		entries.push({
			key: duplicateCount === 0 ? semanticKey : `${semanticKey}:duplicate:${duplicateCount}`,
			label: `[${index}]`,
			value: entry,
		});
	}
	return { entries, total: value.length, omittedCount };
}

function StructuredMarker({ kind, text }: { kind: "depth-limit" | "omitted" | "cycle" | "budget"; text: string }) {
	return (
		<span data-structured-marker={kind} className="text-omp-xs text-(--omp-dim)">
			{text}
		</span>
	);
}

function StructuredLabel({ label }: { label?: string }) {
	if (label == null) return null;
	return <span className="shrink-0 text-(--omp-muted)">{label}:</span>;
}

function ScalarValue({ value }: { value: unknown }) {
	if (value === null) {
		return <span data-value-type="null">null</span>;
	}
	if (typeof value === "string") {
		return <span data-value-type="string">{value}</span>;
	}
	if (typeof value === "boolean") {
		return <span data-value-type="boolean">{String(value)}</span>;
	}
	if (typeof value === "number") {
		return <span data-value-type="number">{String(value)}</span>;
	}
	if (typeof value === "undefined") {
		return <span>undefined</span>;
	}
	if (typeof value === "bigint") {
		return <span>{`${String(value)}n`}</span>;
	}
	if (typeof value === "symbol") {
		return <span>{String(value)}</span>;
	}
	if (typeof value === "function") {
		return <span>{value.name || "function"}</span>;
	}
	return <span>{String(value)}</span>;
}

function hasStructuredContent(value: object): boolean {
	if (Array.isArray(value)) return value.length > 0;
	const record = value as Record<string, unknown>;
	for (const key in record) {
		if (Object.hasOwn(record, key)) return true;
	}
	return false;
}

function minimumNodeBudget(value: unknown, depth: number, maxDepth: number, ancestors: WeakSet<object>): number {
	if (!isStructured(value) || ancestors.has(value) || depth >= maxDepth) return 1;
	return hasStructuredContent(value) ? 2 : 1;
}

function fairChildBudgets(
	entries: readonly StructuredEntry[],
	budget: number,
	depth: number,
	maxDepth: number,
	ancestors: WeakSet<object>,
): number[] {
	const minimums = entries.map(entry => minimumNodeBudget(entry.value, depth, maxDepth, ancestors));
	const selectedMinimums: number[] = [];
	let minimumTotal = 0;

	for (const minimum of minimums) {
		if (minimumTotal + minimum > budget) break;
		selectedMinimums.push(minimum);
		minimumTotal += minimum;
	}

	if (selectedMinimums.length === 0 && entries.length > 0 && budget > 0) {
		return [budget];
	}

	const remaining = budget - minimumTotal;
	const shared = selectedMinimums.length > 0 ? Math.floor(remaining / selectedMinimums.length) : 0;
	const extra = selectedMinimums.length > 0 ? remaining % selectedMinimums.length : 0;
	return selectedMinimums.map((minimum, index) => minimum + shared + (index < extra ? 1 : 0));
}

function planStructuredChildren(
	value: object,
	depth: number,
	budget: number,
	maxDepth: number,
	maxChildren: number,
	ancestorPath: readonly object[],
	ancestors: WeakSet<object>,
): StructuredPlanResult<StructuredChildrenPlan> {
	const { entries, total, omittedCount } = structuredEntries(value, maxChildren, budget);
	const showsOmittedMarker = omittedCount > 0 && budget > 0;
	const entryBudget = budget - (showsOmittedMarker ? 1 : 0);
	const childBudgets = fairChildBudgets(entries, entryBudget, depth, maxDepth, ancestors);
	const visibleCount = Math.min(total, maxChildren);
	let budgetTruncated = childBudgets.length < visibleCount || (omittedCount > 0 && !showsOmittedMarker);
	const plannedEntries: StructuredEntryPlan[] = [];

	for (let index = 0; index < childBudgets.length; index += 1) {
		const entry = entries[index];
		const result = planStructuredNode(
			entry.value,
			depth,
			childBudgets[index],
			maxDepth,
			maxChildren,
			ancestorPath,
			ancestors,
		);
		plannedEntries.push({
			key: entry.key,
			label: entry.label,
			node: result.plan,
			budgetTruncated: result.budgetTruncated,
		});
		budgetTruncated ||= result.budgetTruncated;
	}

	return {
		plan: {
			entries: plannedEntries,
			omittedCount: showsOmittedMarker ? omittedCount : 0,
		},
		budgetTruncated,
	};
}

function planStructuredNode(
	value: unknown,
	depth: number,
	budget: number,
	maxDepth: number,
	maxChildren: number,
	ancestorPath: readonly object[],
	ancestors: WeakSet<object>,
): StructuredPlanResult<StructuredNodePlan> {
	if (!isStructured(value)) {
		return { plan: { kind: "scalar", value }, budgetTruncated: false };
	}
	if (ancestors.has(value)) {
		return { plan: { kind: "cycle" }, budgetTruncated: false };
	}
	if (depth >= maxDepth) {
		return { plan: { kind: "depth-limit" }, budgetTruncated: false };
	}

	const nextAncestorPath = [...ancestorPath, value];
	const nextAncestors = new WeakSet<object>(nextAncestorPath);
	const children = planStructuredChildren(
		value,
		depth + 1,
		budget - 1,
		maxDepth,
		maxChildren,
		nextAncestorPath,
		nextAncestors,
	);
	return {
		plan: {
			kind: "structured",
			summary: Array.isArray(value) ? `[${value.length}]` : "{…}",
			children: children.plan,
		},
		budgetTruncated: children.budgetTruncated,
	};
}

function structuredNodeCount(node: StructuredNodePlan): number {
	if (node.kind !== "structured") return 1;
	return 1 + structuredChildrenCount(node.children);
}

function structuredChildrenCount(plan: StructuredChildrenPlan): number {
	let count = plan.omittedCount > 0 ? 1 : 0;
	for (const entry of plan.entries) count += structuredNodeCount(entry.node);
	return count;
}

function trimStructuredNodeByOne(node: StructuredNodePlan): StructuredNodePlan | undefined {
	if (node.kind !== "structured") return undefined;
	const children = trimStructuredChildrenByOne(node.children);
	return children ? { ...node, children } : undefined;
}

function trimStructuredChildrenByOne(plan: StructuredChildrenPlan): StructuredChildrenPlan | undefined {
	if (plan.entries.length > 0) {
		const truncatedIndex = plan.entries.findIndex(entry => entry.budgetTruncated);
		const targetIndex = truncatedIndex >= 0 ? truncatedIndex : plan.entries.length - 1;
		const target = plan.entries[targetIndex];
		const trimmedNode = trimStructuredNodeByOne(target.node);
		const entries = trimmedNode
			? [
					...plan.entries.slice(0, targetIndex),
					{ ...target, node: trimmedNode },
					...plan.entries.slice(targetIndex + 1),
				]
			: [...plan.entries.slice(0, targetIndex), ...plan.entries.slice(targetIndex + 1)];
		return { ...plan, entries };
	}
	if (plan.omittedCount > 0) return { ...plan, omittedCount: 0 };
	return undefined;
}

function StructuredChildren({
	plan,
	depth,
	defaultExpandedDepth,
	t,
}: {
	plan: StructuredChildrenPlan;
	depth: number;
	defaultExpandedDepth: number;
	t: Translate;
}) {
	return (
		<div className="flex flex-col gap-0.5 border-l border-(--omp-border-muted) pl-3">
			{plan.entries.map(entry => (
				<StructuredNode
					key={entry.key}
					node={entry.node}
					label={entry.label}
					depth={depth}
					defaultExpandedDepth={defaultExpandedDepth}
					t={t}
				/>
			))}
			{plan.omittedCount > 0 ? (
				<StructuredMarker kind="omitted" text={t("tools.structured.omitted", { count: plan.omittedCount })} />
			) : null}
		</div>
	);
}

function StructuredNode({ node, label, depth, defaultExpandedDepth, t }: StructuredNodeProps) {
	const [expanded, setExpanded] = useState(() => depth < defaultExpandedDepth);

	if (node.kind === "scalar") {
		return (
			<div className="flex min-w-0 gap-2 font-mono text-omp-xs text-(--omp-text)">
				<StructuredLabel label={label} />
				<ScalarValue value={node.value} />
			</div>
		);
	}

	if (node.kind === "cycle" || node.kind === "depth-limit") {
		const markerKind = node.kind === "cycle" ? "cycle" : "depth-limit";
		const markerText = node.kind === "cycle" ? t("tools.structured.cycle") : t("tools.structured.depthLimit");
		return (
			<div className="flex min-w-0 gap-2 font-mono text-omp-xs">
				<StructuredLabel label={label} />
				<StructuredMarker kind={markerKind} text={markerText} />
			</div>
		);
	}

	return (
		<div className="min-w-0 font-mono text-omp-xs">
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded(current => !current)}
				className="flex min-w-0 items-center gap-2 rounded px-1 text-left text-(--omp-muted) hover:bg-(--omp-selected-bg) hover:text-(--omp-text)"
			>
				<span aria-hidden="true" className="w-2 shrink-0">
					{expanded ? "▾" : "▸"}
				</span>
				{label == null ? null : <span className="text-(--omp-text)">{label}</span>}
				<span className="text-(--omp-dim)">{node.summary}</span>
			</button>
			{expanded ? (
				<StructuredChildren
					plan={node.children}
					depth={depth + 1}
					defaultExpandedDepth={defaultExpandedDepth}
					t={t}
				/>
			) : null}
		</div>
	);
}

export function StructuredDataView({
	value,
	defaultExpandedDepth = DEFAULT_EXPANDED_DEPTH,
	maxDepth = DEFAULT_MAX_DEPTH,
	maxChildren = DEFAULT_MAX_CHILDREN,
	maxNodes = DEFAULT_MAX_NODES,
}: StructuredDataViewProps) {
	const t = useT();
	const expandedDepth = finiteLimit(defaultExpandedDepth, DEFAULT_EXPANDED_DEPTH);
	const depthLimit = finiteLimit(maxDepth, DEFAULT_MAX_DEPTH);
	const childLimit = finiteLimit(maxChildren, DEFAULT_MAX_CHILDREN);
	const nodeLimit = finiteLimit(maxNodes, DEFAULT_MAX_NODES);

	if (!isStructured(value)) {
		return <div data-structured-view="true">{nodeLimit > 0 ? <ScalarValue value={value} /> : null}</div>;
	}

	if (depthLimit === 0) {
		return (
			<div data-structured-view="true">
				{nodeLimit > 0 ? <StructuredMarker kind="depth-limit" text={t("tools.structured.depthLimit")} /> : null}
			</div>
		);
	}

	const ancestorPath = [value];
	const result = planStructuredChildren(
		value,
		1,
		nodeLimit,
		depthLimit,
		childLimit,
		ancestorPath,
		new WeakSet<object>(ancestorPath),
	);
	const showsBudgetMarker = result.budgetTruncated && nodeLimit > 0;
	const plannedCount = structuredChildrenCount(result.plan);
	const contentPlan =
		showsBudgetMarker && plannedCount >= nodeLimit
			? (trimStructuredChildrenByOne(result.plan) ?? { entries: [], omittedCount: 0 })
			: result.plan;

	return (
		<div data-structured-view="true">
			<StructuredChildren plan={contentPlan} depth={1} defaultExpandedDepth={expandedDepth} t={t} />
			{showsBudgetMarker ? <StructuredMarker kind="budget" text={t("tools.structured.budget")} /> : null}
		</div>
	);
}
