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
import {
	AlertCircle,
	AlertTriangle,
	Check,
	CheckCircle2,
	ChevronRight,
	Circle,
	GripVertical,
	LoaderCircle,
	Pencil,
	X,
} from "lucide-react";
import {
	memo,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import type { TodoPhase, TodoTask } from "../../../../shared/rpc-types";
import { useT } from "../../../lib/i18n";
import { toast } from "../../../stores/toast";
import { type UiTodoPhase, type UiTodoTask, useTodoStore } from "../../../stores/todo";

const STATUS_LABEL_KEY: Record<TodoTask["status"], string> = {
	pending: "todoPanel.status.pending",
	in_progress: "todoPanel.status.inProgress",
	completed: "todoPanel.status.completed",
	blocked: "todoPanel.status.blocked",
	abandoned: "todoPanel.status.abandoned",
};

const STATUS_CYCLE: TodoTask["status"][] = ["pending", "in_progress", "completed", "blocked", "abandoned"];

interface VisibleRow {
	id: string;
	kind: "phase" | "task";
	phaseId: string;
}

interface SortableTaskState {
	dragHandle: ReactNode;
	isDragging: boolean;
	setNodeRef: (node: HTMLElement | null) => void;
	transform: { scaleX: number; scaleY: number; x: number; y: number } | null;
	transition?: string;
}

interface TaskRowProps {
	focused: boolean;
	onFocus: () => void;
	onPatch: (phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => void;
	onTreeKeyDown: (event: ReactKeyboardEvent<HTMLElement>, row: VisibleRow) => void;
	phaseId: string;
	readOnly: boolean;
	sortable?: SortableTaskState;
	task: UiTodoTask;
}

function TodoStatusIcon({ status }: { status: TodoTask["status"] }) {
	if (status === "in_progress") {
		return <LoaderCircle aria-hidden="true" className="animate-spin text-[var(--omp-link)]" size={15} />;
	}
	if (status === "completed") {
		return <CheckCircle2 aria-hidden="true" className="text-[var(--omp-muted)]" size={15} />;
	}
	if (status === "blocked" || status === "abandoned") {
		return <AlertCircle aria-hidden="true" className="text-[var(--omp-error)]" size={15} />;
	}
	return <Circle aria-hidden="true" className="text-[var(--omp-dim)]" size={15} strokeDasharray="2.5 2.5" />;
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

const TaskRow = memo(function TaskRow({
	focused,
	onFocus,
	onPatch,
	onTreeKeyDown,
	phaseId,
	readOnly,
	sortable,
	task,
}: TaskRowProps) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(task.content);
	const isDragging = sortable?.isDragging ?? false;

	useEffect(() => {
		if (readOnly) setEditing(false);
	}, [readOnly]);

	const beginEditing = () => {
		if (readOnly) return;
		setDraft(task.content);
		setEditing(true);
	};
	const commit = () => {
		const content = draft.trim();
		setEditing(false);
		if (content && content !== task.content) onPatch(phaseId, task.id, { content });
		else setDraft(task.content);
	};

	return (
		<div
			aria-label={task.content}
			aria-level={2}
			aria-keyshortcuts={readOnly ? undefined : "Space Enter Alt+ArrowUp Alt+ArrowDown"}
			className={`group flex min-h-8 items-center gap-2 rounded-lg py-1 pr-1 pl-0.5 text-omp-lg transition-colors ${
				isDragging ? "z-10 bg-(--omp-selected-bg) shadow-md shadow-black/30" : "hover:bg-(--omp-bg-tertiary)"
			}`}
			data-todo-tree-id={task.id}
			data-todo-id-generated={String(task.generatedId)}
			onFocus={onFocus}
			onKeyDown={event => {
				if (event.target !== event.currentTarget) return;
				if (!readOnly && event.key === "Enter") {
					event.preventDefault();
					beginEditing();
					return;
				}
				onTreeKeyDown(event, { id: task.id, kind: "task", phaseId });
			}}
			ref={sortable?.setNodeRef}
			role="treeitem"
			style={{
				transform: sortable?.transform
					? `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0) scaleX(${sortable.transform.scaleX}) scaleY(${sortable.transform.scaleY})`
					: undefined,
				transition: sortable?.transition,
			}}
			tabIndex={focused ? 0 : -1}
		>
			{sortable?.dragHandle}
			{readOnly ? (
				<span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full">
					<TodoStatusIcon status={task.status} />
				</span>
			) : (
				<button
					aria-label={t("todoPanel.statusAria", {
						status: t(STATUS_LABEL_KEY[task.status] ?? "todoPanel.status.pending"),
					})}
					className="omp-pressable flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
					onClick={() =>
						onPatch(phaseId, task.id, {
							status: STATUS_CYCLE[(STATUS_CYCLE.indexOf(task.status) + 1) % STATUS_CYCLE.length],
						})
					}
					title={t("todoPanel.cycleHint")}
					tabIndex={-1}
					type="button"
				>
					<TodoStatusIcon status={task.status} />
				</button>
			)}
			{editing ? (
				<span className="flex min-w-0 flex-1 items-center gap-1">
					<input
						autoFocus
						className="w-full min-w-0 rounded border border-(--omp-border-accent) bg-(--omp-input-bg) px-1.5 py-0.5 text-xs text-(--omp-text) focus:outline-none"
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
						onDoubleClick={readOnly ? undefined : beginEditing}
						title={task.content}
					>
						{task.content}
					</span>
					{!readOnly && (
						<button
							aria-label={t("todoPanel.edit")}
							className="shrink-0 text-(--omp-dim) opacity-0 transition-opacity group-hover:opacity-100 hover:text-(--omp-text)"
							onClick={beginEditing}
							tabIndex={-1}
							type="button"
						>
							<Pencil size={11} />
						</button>
					)}
				</>
			)}
		</div>
	);
});

function MutableTaskRow(props: Omit<TaskRowProps, "sortable">) {
	const t = useT();
	const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({
		id: props.task.id,
	});
	const dragHandle = (
		<button
			aria-label={t("todoPanel.reorder")}
			className="cursor-grab text-(--omp-dim) opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
			{...attributes}
			{...listeners}
			tabIndex={-1}
			type="button"
		>
			<GripVertical size={12} />
		</button>
	);
	return (
		<TaskRow
			{...props}
			sortable={{ dragHandle, isDragging, setNodeRef, transform, transition: transition ?? undefined }}
		/>
	);
}

interface PhaseSectionProps {
	collapsed: boolean;
	focusedId: string | null;
	onPatch: (phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => void;
	onToggle: () => void;
	onTreeKeyDown: (event: ReactKeyboardEvent<HTMLElement>, row: VisibleRow) => void;
	phase: UiTodoPhase;
	readOnly: boolean;
	setFocusedId: (id: string) => void;
}

function PhaseSection({
	collapsed,
	focusedId,
	onPatch,
	onToggle,
	onTreeKeyDown,
	phase,
	readOnly,
	setFocusedId,
}: PhaseSectionProps) {
	const t = useT();
	const groupId = useId();
	const done = phase.tasks.filter(task => task.status === "completed").length;
	const taskRows = (
		<div className="ml-2 border-l border-(--omp-border-muted) pl-2" id={groupId} role="group">
			{phase.tasks.map(task => {
				const props = {
					focused: focusedId === task.id,
					onFocus: () => setFocusedId(task.id),
					onPatch,
					onTreeKeyDown,
					phaseId: phase.id,
					readOnly,
					task,
				};
				return readOnly ? <TaskRow key={task.id} {...props} /> : <MutableTaskRow key={task.id} {...props} />;
			})}
			{phase.tasks.length === 0 && (
				<div className="py-1 text-omp-sm text-(--omp-dim) italic">{t("todoPanel.noTasks")}</div>
			)}
		</div>
	);

	return (
		<section className="mb-1.5">
			<div
				aria-expanded={!collapsed}
				aria-label={phase.name}
				aria-level={1}
				aria-owns={collapsed ? undefined : groupId}
				className="flex w-full items-center gap-1.5 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-(--omp-bg-tertiary)"
				data-todo-tree-id={phase.id}
				data-todo-id-generated={String(phase.generatedId)}
				onClick={onToggle}
				onFocus={() => setFocusedId(phase.id)}
				onKeyDown={event => onTreeKeyDown(event, { id: phase.id, kind: "phase", phaseId: phase.id })}
				role="treeitem"
				tabIndex={focusedId === phase.id ? 0 : -1}
			>
				<ChevronRight
					className="shrink-0 text-(--omp-dim) transition-transform duration-100"
					size={12}
					style={{ transform: collapsed ? undefined : "rotate(90deg)" }}
				/>
				<span className="min-w-0 flex-1 truncate text-omp-sm font-semibold tracking-wide text-(--omp-accent) uppercase">
					{phase.name}
				</span>
				<span className="shrink-0 text-omp-xs tabular-nums text-(--omp-dim)">
					{done}/{phase.tasks.length}
				</span>
			</div>
			{!collapsed &&
				(readOnly ? (
					taskRows
				) : (
					<SortableContext items={phase.tasks.map(task => task.id)} strategy={verticalListSortingStrategy}>
						{taskRows}
					</SortableContext>
				))}
		</section>
	);
}

function TreeWithDnd({ children, onDragEnd }: { children: ReactNode; onDragEnd: (event: DragEndEvent) => void }) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	);
	return (
		<DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd} sensors={sensors}>
			{children}
		</DndContext>
	);
}

export function TodoTree({ readOnly }: { readOnly: boolean }) {
	const t = useT();
	const phases = useTodoStore(state => state.phases) ?? [];
	const reminderVisible = useTodoStore(state => state.reminderVisible) ?? false;
	const reminderTodos = useTodoStore(state => state.reminderTodos) ?? [];
	const clearReminder = useTodoStore(state => state.clearReminder);
	const setPhases = useTodoStore(state => state.setPhases);
	const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const treeRef = useRef<HTMLDivElement>(null);

	const applyPhases = useCallback(
		(next: UiTodoPhase[]) => {
			if (readOnly) return;
			setPhases(next);
			void pushTodos(next, t);
		},
		[readOnly, setPhases, t],
	);

	const patchTask = useCallback(
		(phaseId: string, taskId: string, patch: Partial<UiTodoTask>) => {
			if (readOnly) return;
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
		[applyPhases, phases, readOnly],
	);

	const reorderTask = useCallback(
		(phaseId: string, from: number, to: number) => {
			if (readOnly || from < 0 || to < 0 || from === to) return;
			applyPhases(
				phases.map(phase => (phase.id === phaseId ? { ...phase, tasks: arrayMove(phase.tasks, from, to) } : phase)),
			);
		},
		[applyPhases, phases, readOnly],
	);

	const moveTask = useCallback(
		(phaseId: string, taskId: string, offset: -1 | 1) => {
			const phase = phases.find(candidate => candidate.id === phaseId);
			if (!phase) return;
			const from = phase.tasks.findIndex(task => task.id === taskId);
			const to = Math.max(0, Math.min(from + offset, phase.tasks.length - 1));
			reorderTask(phaseId, from, to);
		},
		[phases, reorderTask],
	);

	const onDragEnd = useCallback(
		(event: DragEndEvent) => {
			if (readOnly) return;
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const phase = phases.find(candidate => candidate.tasks.some(task => task.id === active.id));
			if (!phase) return;
			const from = phase.tasks.findIndex(task => task.id === active.id);
			const to = phase.tasks.findIndex(task => task.id === over.id);
			reorderTask(phase.id, from, to);
		},
		[phases, readOnly, reorderTask],
	);

	const togglePhase = useCallback((id: string) => {
		setCollapsed(previous => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}, []);

	const visibleRows = useMemo<VisibleRow[]>(() => {
		const rows: VisibleRow[] = [];
		for (const phase of phases) {
			rows.push({ id: phase.id, kind: "phase", phaseId: phase.id });
			if (!collapsed.has(phase.id)) {
				for (const task of phase.tasks) rows.push({ id: task.id, kind: "task", phaseId: phase.id });
			}
		}
		return rows;
	}, [collapsed, phases]);

	useEffect(() => {
		if (visibleRows.length === 0) {
			setFocusedId(null);
			return;
		}
		if (!focusedId || !visibleRows.some(row => row.id === focusedId)) setFocusedId(visibleRows[0]!.id);
	}, [focusedId, visibleRows]);

	const focusRow = useCallback((id: string) => {
		setFocusedId(id);
		const items = treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [];
		for (const item of items) {
			if (item.dataset.todoTreeId === id) {
				item.focus();
				break;
			}
		}
	}, []);

	const handleTreeKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLElement>, row: VisibleRow) => {
			if (event.target !== event.currentTarget) return;
			const index = visibleRows.findIndex(candidate => candidate.id === row.id);
			if (index < 0) return;
			if (
				!readOnly &&
				row.kind === "task" &&
				event.altKey &&
				(event.key === "ArrowUp" || event.key === "ArrowDown")
			) {
				event.preventDefault();
				moveTask(row.phaseId, row.id, event.key === "ArrowUp" ? -1 : 1);
				return;
			}
			let targetId: string | undefined;
			switch (event.key) {
				case "ArrowDown":
					targetId = visibleRows[Math.min(index + 1, visibleRows.length - 1)]?.id;
					break;
				case "ArrowUp":
					targetId = visibleRows[Math.max(index - 1, 0)]?.id;
					break;
				case "Home":
					targetId = visibleRows[0]?.id;
					break;
				case "End":
					targetId = visibleRows.at(-1)?.id;
					break;
				case "ArrowRight": {
					if (row.kind !== "phase") return;
					if (collapsed.has(row.phaseId)) togglePhase(row.phaseId);
					else targetId = phases.find(phase => phase.id === row.phaseId)?.tasks[0]?.id;
					break;
				}
				case "ArrowLeft":
					if (row.kind === "task") targetId = row.phaseId;
					else if (!collapsed.has(row.phaseId)) togglePhase(row.phaseId);
					else return;
					break;
				case " ":
					if (readOnly || row.kind !== "task") return;
					{
						const phase = phases.find(candidate => candidate.id === row.phaseId);
						const task = phase?.tasks.find(candidate => candidate.id === row.id);
						if (!task) return;
						patchTask(row.phaseId, row.id, {
							status: STATUS_CYCLE[(STATUS_CYCLE.indexOf(task.status) + 1) % STATUS_CYCLE.length],
						});
					}
					break;
				case "Enter":
					if (row.kind !== "phase") return;
					togglePhase(row.phaseId);
					break;
				default:
					return;
			}
			event.preventDefault();
			if (targetId) focusRow(targetId);
		},
		[collapsed, focusRow, moveTask, patchTask, phases, readOnly, togglePhase, visibleRows],
	);

	const tree = (
		<div aria-label={t("activitySidebar.todo.label")} ref={treeRef} role="tree">
			{phases.length === 0 ? (
				<div className="px-2 py-3 text-omp-sm text-(--omp-dim)">{t("activitySidebar.todo.empty")}</div>
			) : (
				phases.map(phase => (
					<PhaseSection
						collapsed={collapsed.has(phase.id)}
						focusedId={focusedId}
						key={phase.id}
						onPatch={patchTask}
						onToggle={() => togglePhase(phase.id)}
						onTreeKeyDown={handleTreeKeyDown}
						phase={phase}
						readOnly={readOnly}
						setFocusedId={setFocusedId}
					/>
				))
			)}
		</div>
	);

	return (
		<div className="px-2 py-1.5">
			{reminderVisible && (
				<div className="mb-1.5 flex items-start gap-2 rounded-md border border-[color-mix(in_srgb,var(--omp-warning)_40%,transparent)] bg-transparent px-2.5 py-2">
					<AlertTriangle className="mt-px shrink-0 text-(--omp-warning)" size={13} />
					<div className="min-w-0 flex-1 text-omp-sm leading-snug text-(--omp-warning)">
						<span className="font-semibold">{t("todoPanel.reminder")}</span>
						<span className="text-(--omp-muted)">
							{` — ${t("todoPanel.reminderCount", { count: reminderTodos.length })}`}
						</span>
					</div>
					{!readOnly && (
						<button
							aria-label={t("todoPanel.dismissReminder")}
							className="shrink-0 text-(--omp-warning) opacity-70 transition-opacity hover:opacity-100"
							onClick={clearReminder}
							type="button"
						>
							<X size={12} />
						</button>
					)}
				</div>
			)}
			{readOnly ? tree : <TreeWithDnd onDragEnd={onDragEnd}>{tree}</TreeWithDnd>}
		</div>
	);
}
