/**
 * Todo panel: phases as collapsible sections, status badges, inline edit on
 * double-click, drag reorder via @dnd-kit, persisted through set_todos RPC.
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
import { AlertTriangle, Check, ChevronRight, GripVertical, Pencil, X } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import type { TodoPhase, TodoTask } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { type UiTodoPhase, type UiTodoTask, useTodoStore } from "../../stores/todo";
import { Badge, type BadgeVariant } from "../common";

const STATUS_META: Record<TodoTask["status"], { label: string; variant: BadgeVariant; dot: boolean }> = {
	pending: { label: "pending", variant: "muted", dot: false },
	in_progress: { label: "in progress", variant: "info", dot: true },
	completed: { label: "completed", variant: "success", dot: false },
	blocked: { label: "blocked", variant: "warning", dot: true },
	abandoned: { label: "abandoned", variant: "error", dot: false },
};

const STATUS_LABEL_KEY: Record<TodoTask["status"], string> = {
	pending: "todoPanel.status.pending",
	in_progress: "todoPanel.status.inProgress",
	completed: "todoPanel.status.completed",
	blocked: "todoPanel.status.blocked",
	abandoned: "todoPanel.status.abandoned",
};

/** Total label lookup for wire statuses outside the declared union. */
function statusLabelKey(status: string): string {
	return STATUS_LABEL_KEY[status as TodoTask["status"]] ?? "todoPanel.status.pending";
}

const STATUS_CYCLE: TodoTask["status"][] = ["pending", "in_progress", "completed", "blocked", "abandoned"];

function nextStatus(status: TodoTask["status"]): TodoTask["status"] {
	const index = STATUS_CYCLE.indexOf(status);
	return STATUS_CYCLE[(index + 1) % STATUS_CYCLE.length];
}

async function pushTodos(phases: UiTodoPhase[], t: (key: string) => string): Promise<void> {
	const payload: TodoPhase[] = phases.map(phase => ({
		name: phase.name,
		tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
	}));
	const response = await window.omp.rpc.setTodos(payload);
	if (!response.success) {
		toast({ variant: "error", title: t("todoPanel.updateFailed"), message: response.error });
	}
}

interface SortableTaskRowProps {
	task: UiTodoTask;
	phaseId: string;
	onPatch: (phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => void;
}

const SortableTaskRow = memo(function SortableTaskRow({ task, phaseId, onPatch }: SortableTaskRowProps) {
	const t = useT();
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(task.content);
	// task.status is free-form wire data (only the type is narrowed); an
	// out-of-union status must not deref an undefined meta (white-screen class).
	const meta = STATUS_META[task.status] ?? STATUS_META.pending;

	const commit = () => {
		const content = draft.trim();
		setEditing(false);
		if (content && content !== task.content) onPatch(phaseId, task.id, { content });
		else setDraft(task.content);
	};

	return (
		<div
			className={`group flex items-center gap-1.5 rounded-sm py-1 pr-1 pl-0.5 text-xs transition-colors ${
				isDragging ? "z-10 bg-(--omp-selected-bg) shadow-md shadow-black/30" : "hover:bg-(--omp-bg-tertiary)"
			}`}
			ref={setNodeRef}
			style={{
				transform: transform
					? `translate3d(${transform.x}px, ${transform.y}px, 0) scaleX(${transform.scaleX}) scaleY(${transform.scaleY})`
					: undefined,
				transition,
			}}
		>
			<button
				aria-label={t("todoPanel.reorder")}
				className="cursor-grab text-(--omp-dim) opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
				{...attributes}
				{...listeners}
				type="button"
			>
				<GripVertical size={12} />
			</button>
			<button
				aria-label={t("todoPanel.statusAria", { status: t(statusLabelKey(task.status)) })}
				className="shrink-0"
				onClick={() => onPatch(phaseId, task.id, { status: nextStatus(task.status) })}
				title={t("todoPanel.cycleHint")}
				type="button"
			>
				<Badge dot={meta.dot} pulse={task.status === "in_progress"} variant={meta.variant}>
					{t(statusLabelKey(task.status))}
				</Badge>
			</button>
			{editing ? (
				<span className="flex min-w-0 flex-1 items-center gap-1">
					<input
						autoFocus
						className="w-full min-w-0 rounded border border-(--omp-border-accent) bg-(--omp-bg-primary) px-1.5 py-0.5 text-xs text-(--omp-text) focus:outline-none"
						onBlur={commit}
						onChange={event => setDraft(event.target.value)}
						onKeyDown={event => {
							if (event.key === "Enter") commit();
							if (event.key === "Escape") {
								setDraft(task.content);
								setEditing(false);
							}
						}}
						value={draft}
					/>
					<button aria-label={t("common.save")} className="text-(--omp-success)" onClick={commit} type="button">
						<Check size={12} />
					</button>
					<button
						aria-label={t("common.cancel")}
						className="text-(--omp-muted)"
						onClick={() => {
							setDraft(task.content);
							setEditing(false);
						}}
						type="button"
					>
						<X size={12} />
					</button>
				</span>
			) : (
				<>
					<span
						className={`min-w-0 flex-1 truncate ${
							task.status === "abandoned"
								? "text-(--omp-dim) line-through"
								: task.status === "completed"
									? "text-(--omp-muted)"
									: "text-(--omp-text)"
						}`}
						onDoubleClick={() => {
							setDraft(task.content);
							setEditing(true);
						}}
						title={task.content}
					>
						{task.content}
					</span>
					<button
						aria-label={t("todoPanel.edit")}
						className="shrink-0 text-(--omp-dim) opacity-0 transition-opacity group-hover:opacity-100 hover:text-(--omp-text)"
						onClick={() => {
							setDraft(task.content);
							setEditing(true);
						}}
						type="button"
					>
						<Pencil size={11} />
					</button>
				</>
			)}
		</div>
	);
});

function PhaseSection({
	phase,
	collapsed,
	onToggle,
	onPatch,
}: {
	phase: UiTodoPhase;
	collapsed: boolean;
	onToggle: () => void;
	onPatch: (phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => void;
}) {
	const t = useT();
	const done = phase.tasks.filter(task => task.status === "completed").length;
	const total = phase.tasks.length;

	return (
		<section className="mb-1.5">
			<button
				aria-expanded={!collapsed}
				className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-(--omp-bg-tertiary)"
				onClick={onToggle}
				type="button"
			>
				<ChevronRight
					className="shrink-0 text-(--omp-dim) transition-transform duration-100"
					size={12}
					style={{ transform: collapsed ? undefined : "rotate(90deg)" }}
				/>
				<span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-(--omp-accent) uppercase">
					{phase.name}
				</span>
				<span className="shrink-0 text-[10px] tabular-nums text-(--omp-dim)">
					{done}/{total}
				</span>
			</button>
			{!collapsed && (
				<SortableContext items={phase.tasks.map(task => task.id)} strategy={verticalListSortingStrategy}>
					<div className="ml-2 border-l border-(--omp-border-muted) pl-2">
						{phase.tasks.map(task => (
							<SortableTaskRow key={task.id} onPatch={onPatch} phaseId={phase.id} task={task} />
						))}
						{total === 0 && (
							<div className="py-1 text-[11px] text-(--omp-dim) italic">{t("todoPanel.noTasks")}</div>
						)}
					</div>
				</SortableContext>
			)}
		</section>
	);
}

export function TodoPanel() {
	const t = useT();
	const phases = useTodoStore(state => state.phases) ?? [];
	const reminderVisible = useTodoStore(state => state.reminderVisible) ?? false;
	const reminderTodos = useTodoStore(state => state.reminderTodos) ?? [];
	const clearReminder = useTodoStore(state => state.clearReminder);
	const setPhases = useTodoStore(state => state.setPhases);

	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);

	const applyPhases = useCallback(
		(next: UiTodoPhase[]) => {
			setPhases(next);
			void pushTodos(next, t);
		},
		[setPhases, t],
	);

	const patchTask = useCallback(
		(phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => {
			const next = phases.map(phase =>
				phase.id !== phaseId
					? phase
					: {
							...phase,
							tasks: phase.tasks.map(task => (task.id === taskId ? { ...task, ...patch } : task)),
						},
			);
			applyPhases(next);
		},
		[phases, applyPhases],
	);

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const phase = phases.find(p => p.tasks.some(task => task.id === active.id));
			if (!phase) return;
			const from = phase.tasks.findIndex(task => task.id === active.id);
			const to = phase.tasks.findIndex(task => task.id === over.id);
			if (from < 0 || to < 0) return;
			applyPhases(phases.map(p => (p.id === phase.id ? { ...p, tasks: arrayMove(p.tasks, from, to) } : p)));
		},
		[phases, applyPhases],
	);

	const togglePhase = useCallback((id: string) => {
		setCollapsed(prev => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const openCount = useMemo(
		() =>
			(phases ?? []).reduce(
				(sum, phase) =>
					sum +
					(phase.tasks ?? []).filter(task => task.status !== "completed" && task.status !== "abandoned").length,
				0,
			),
		[phases],
	);

	return (
		<div className="flex h-full flex-col">
			{reminderVisible && (
				<div className="mx-2 mt-2 flex items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--omp-warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--omp-warning)_10%,transparent)] px-2.5 py-2">
					<AlertTriangle className="mt-px shrink-0 text-(--omp-warning)" size={13} />
					<div className="min-w-0 flex-1 text-[11px] leading-snug text-(--omp-warning)">
						<span className="font-semibold">{t("todoPanel.reminder")}</span>
						<span className="text-(--omp-muted)">
							{" — " + t("todoPanel.reminderCount", { count: reminderTodos.length })}
						</span>
					</div>
					<button
						aria-label={t("todoPanel.dismissReminder")}
						className="shrink-0 text-(--omp-warning) opacity-70 transition-opacity hover:opacity-100"
						onClick={clearReminder}
						type="button"
					>
						<X size={12} />
					</button>
				</div>
			)}
			<div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
				<span className="text-[10px] font-medium tracking-widest text-(--omp-dim) uppercase">
					{t("todoPanel.title")}
				</span>
				<span className="text-[10px] tabular-nums text-(--omp-dim)">
					{t("todoPanel.open", { count: openCount })}
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				{phases.length === 0 ? (
					<div className="px-3 py-8 text-center text-[11px] leading-relaxed text-(--omp-dim)">
						{t("todoPanel.empty")}
						<br />
						{t("todoPanel.emptyHint")}
					</div>
				) : (
					<DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
						{phases.map(phase => (
							<PhaseSection
								collapsed={collapsed.has(phase.id)}
								key={phase.id}
								onPatch={patchTask}
								onToggle={() => togglePhase(phase.id)}
								phase={phase}
							/>
						))}
					</DndContext>
				)}
			</div>
		</div>
	);
}
