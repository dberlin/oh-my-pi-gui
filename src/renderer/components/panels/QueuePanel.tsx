/**
 * Queue panel: the agent's pending message queue as two sortable lanes —
 * 引导 (steering, delivered mid-run) and 排队 (follow-up, delivered after the
 * run). Drag reorder rides queue_move (same-lane, server-clamped), the
 * lane-switch rides queue_move with toLane (appended to the target lane's
 * end), per-item delete rides queue_remove, per-lane clear rides
 * queue_clear. Mutations apply optimistically, then resync from get_queue
 * on settle so the server stays the single source of truth.
 */

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { ArrowLeftRight, ChevronDown, ChevronUp, GripVertical, ListX, X } from "lucide-react";
import { memo, useCallback } from "react";
import type { RpcQueuedMessage } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { type QueueLane, useQueuedMessages, useQueueStore } from "../../stores/queue";
import { toast } from "../../stores/toast";
import { Badge } from "../common";

/** Apply a lane-local mutation optimistically, persist via `persist`, and
 *  resync from get_queue on FAILURE only — success is confirmed by the
 *  authoritative queue_update frame the mutation itself emits. */
async function applyLaneMutation(
	lane: QueueLane,
	optimistic: (items: RpcQueuedMessage[]) => RpcQueuedMessage[],
	persist: () => Promise<{ success: boolean; error?: string }>,
	failureKey: string,
	t: (key: string) => string,
): Promise<void> {
	const store = useQueueStore.getState();
	useQueueStore.setState({ [lane]: optimistic(store[lane]) });
	const response = await persist();
	if (!response.success) {
		toast({ variant: "error", title: t(failureKey), message: response.error ?? "RPC call failed" });
		await store.refresh();
	}
}

interface SortableQueuedRowProps {
	item: RpcQueuedMessage;
	lane: QueueLane;
	index: number;
	count: number;
	onMove: (lane: QueueLane, id: string, toIndex: number) => void;
	onMoveToLane: (lane: QueueLane, id: string) => void;
	onRemove: (lane: QueueLane, id: string) => void;
	removeLabel: string;
}

/** Optimistically move an entry to the END of the other lane (queue_move with
 *  toLane); failure toasts and resyncs, success is confirmed by the emitted
 *  queue_update frame like every other lane mutation. */
async function applyCrossLaneMove(lane: QueueLane, id: string, t: (key: string) => string): Promise<void> {
	const target: QueueLane = lane === "steering" ? "followUp" : "steering";
	const store = useQueueStore.getState();
	const item = store[lane].find(entry => entry.id === id);
	if (!item) return;
	if (lane === "steering") {
		useQueueStore.setState({
			steering: store.steering.filter(entry => entry.id !== id),
			followUp: [...store.followUp, item],
		});
	} else {
		useQueueStore.setState({
			followUp: store.followUp.filter(entry => entry.id !== id),
			steering: [...store.steering, item],
		});
	}
	const response = await window.omp.rpc.queueMove(id, Number.MAX_SAFE_INTEGER, target);
	if (!response.success) {
		toast({ variant: "error", title: t("queuePanel.moveFailed"), message: response.error });
		await store.refresh();
	}
}

const SortableQueuedRow = memo(function SortableQueuedRow({
	item,
	lane,
	index,
	count,
	onMove,
	onMoveToLane,
	onRemove,
	removeLabel,
}: SortableQueuedRowProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
	const t = useT();
	const targetLane: QueueLane = lane === "steering" ? "followUp" : "steering";
	return (
		<div
			ref={setNodeRef}
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition,
				opacity: isDragging ? 0.6 : undefined,
			}}
			className="group flex items-start gap-1.5 rounded-md border border-(--omp-border-muted) bg-transparent px-2 py-1.5"
		>
			<button
				{...attributes}
				{...listeners}
				aria-label={t("queuePanel.drag")}
				className="mt-0.5 shrink-0 cursor-grab touch-none text-(--omp-dim) hover:text-(--omp-text) active:cursor-grabbing"
				type="button"
			>
				<GripVertical size={12} />
			</button>
			<span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-omp-md leading-snug text-(--omp-text)">
				{item.text || "…"}
			</span>
			{/* Explicit reorder buttons alongside the drag handle (a11y): same
			    queue_move path, disabled at the lane edges. */}
			<button
				aria-label={t("queuePanel.moveUp")}
				className="mt-0.5 shrink-0 text-(--omp-dim) opacity-0 transition-opacity group-hover:opacity-100 hover:text-(--omp-text) disabled:cursor-not-allowed disabled:hover:text-(--omp-dim)"
				disabled={index === 0}
				onClick={() => onMove(lane, item.id, index - 1)}
				type="button"
			>
				<ChevronUp size={12} />
			</button>
			<button
				aria-label={t("queuePanel.moveDown")}
				className="mt-0.5 shrink-0 text-(--omp-dim) opacity-0 transition-opacity group-hover:opacity-100 hover:text-(--omp-text) disabled:cursor-not-allowed disabled:hover:text-(--omp-dim)"
				disabled={index === count - 1}
				onClick={() => onMove(lane, item.id, index + 1)}
				type="button"
			>
				<ChevronDown size={12} />
			</button>
			<button
				aria-label={t("queuePanel.moveToLane", { lane: t(`queuePanel.lane.${targetLane}`) })}
				className="mt-0.5 shrink-0 text-(--omp-dim) opacity-0 transition-opacity group-hover:opacity-100 hover:text-(--omp-text)"
				onClick={() => onMoveToLane(lane, item.id)}
				title={t("queuePanel.moveToLane", { lane: t(`queuePanel.lane.${targetLane}`) })}
				type="button"
			>
				<ArrowLeftRight size={12} />
			</button>
			<button
				aria-label={removeLabel}
				className="mt-0.5 shrink-0 text-(--omp-dim) opacity-0 transition-opacity group-hover:opacity-100 hover:text-(--omp-error)"
				onClick={() => onRemove(lane, item.id)}
				type="button"
			>
				<X size={12} />
			</button>
		</div>
	);
});

function LaneSection({
	lane,
	items,
	onRemove,
	onClear,
	onMove,
	onMoveToLane,
}: {
	lane: QueueLane;
	items: RpcQueuedMessage[];
	onRemove: (lane: QueueLane, id: string) => void;
	onClear: (lane: QueueLane) => void;
	onMove: (lane: QueueLane, id: string, toIndex: number) => void;
	onMoveToLane: (lane: QueueLane, id: string) => void;
}) {
	const t = useT();
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const from = items.findIndex(item => item.id === active.id);
			const to = items.findIndex(item => item.id === over.id);
			if (from < 0 || to < 0) return;
			onMove(lane, String(active.id), to);
		},
		[items, lane, onMove],
	);

	return (
		<section className="mb-2">
			<div className="flex items-center gap-1.5 px-1 py-1">
				<span className="min-w-0 flex-1 truncate text-omp-sm font-semibold tracking-wide text-(--omp-accent) uppercase">
					{t(lane === "steering" ? "queuePanel.lane.steering" : "queuePanel.lane.followUp")}
				</span>
				<Badge variant="muted">{items.length}</Badge>
				{items.length > 0 && (
					<button
						aria-label={t("queuePanel.clearLane")}
						className="omp-pressable flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-omp-xs text-(--omp-dim) hover:bg-(--omp-bg-tertiary) hover:text-(--omp-error)"
						onClick={() => onClear(lane)}
						type="button"
					>
						<ListX size={11} />
						{t("queuePanel.clearLane")}
					</button>
				)}
			</div>
			<DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
				<SortableContext items={items.map(item => item.id)} strategy={verticalListSortingStrategy}>
					<div className="ml-1 flex flex-col gap-1 border-l border-(--omp-border-muted) pl-2">
						{items.map((item, index) => (
							<SortableQueuedRow
								count={items.length}
								index={index}
								item={item}
								key={item.id}
								lane={lane}
								onMove={onMove}
								onMoveToLane={onMoveToLane}
								onRemove={onRemove}
								removeLabel={t("queuePanel.remove")}
							/>
						))}
						{items.length === 0 && (
							<div className="py-1 text-omp-sm text-(--omp-dim) italic">{t("queuePanel.laneEmpty")}</div>
						)}
					</div>
				</SortableContext>
			</DndContext>
		</section>
	);
}

export function QueuePanel() {
	const t = useT();
	const { steering, followUp } = useQueuedMessages();
	const total = steering.length + followUp.length;

	const removeItem = useCallback(
		(lane: QueueLane, id: string) => {
			void applyLaneMutation(
				lane,
				items => items.filter(item => item.id !== id),
				() => window.omp.rpc.queueRemove(id),
				"queuePanel.removeFailed",
				t,
			);
		},
		[t],
	);

	const moveItem = useCallback(
		(lane: QueueLane, id: string, toIndex: number) => {
			void applyLaneMutation(
				lane,
				items => {
					const from = items.findIndex(item => item.id === id);
					return from < 0 ? items : arrayMove(items, from, toIndex);
				},
				async () => {
					const response = await window.omp.rpc.queueMove(id, toIndex);
					return response.success
						? { success: true as const }
						: { success: false as const, error: response.error };
				},
				"queuePanel.moveFailed",
				t,
			);
		},
		[t],
	);

	const moveToLane = useCallback(
		(lane: QueueLane, id: string) => {
			void applyCrossLaneMove(lane, id, t);
		},
		[t],
	);

	const clearLane = useCallback(
		(lane: QueueLane) => {
			void applyLaneMutation(
				lane,
				() => [],
				async () => {
					const response = await window.omp.rpc.queueClear(lane);
					return response.success
						? { success: true as const }
						: { success: false as const, error: response.error };
				},
				"queuePanel.clearFailed",
				t,
			);
		},
		[t],
	);

	return (
		<div className="flex h-full flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
				{total === 0 ? (
					<div className="px-3 py-8 text-center text-omp-sm leading-relaxed text-(--omp-dim)">
						{t("queuePanel.empty")}
						<br />
						{t("queuePanel.emptyHint")}
					</div>
				) : (
					<>
						<LaneSection
							items={steering}
							lane="steering"
							onClear={clearLane}
							onMove={moveItem}
							onMoveToLane={moveToLane}
							onRemove={removeItem}
						/>
						<LaneSection
							items={followUp}
							lane="followUp"
							onClear={clearLane}
							onMove={moveItem}
							onMoveToLane={moveToLane}
							onRemove={removeItem}
						/>
					</>
				)}
			</div>
		</div>
	);
}
