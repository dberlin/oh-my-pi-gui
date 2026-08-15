import { Bot, ChevronRight, ListTodo, PanelRightClose } from "lucide-react";
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useActiveTabRouteReady } from "../../../hooks/use-active-tab-route";
import { useT } from "../../../lib/i18n";
import { ACTIVITY_TREE_MIN_BODY_HEIGHT, useActivitySidebarStore } from "../../../stores/activity-sidebar";
import { useAgentViewStore } from "../../../stores/agent-view";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTodoStore } from "../../../stores/todo";
import { PanelErrorBoundary } from "../../common/PanelErrorBoundary";
import { ActivityMetaRows } from "./ActivityMetaRows";
import { ActivitySection } from "./ActivitySection";
import { AgentTree } from "./AgentTree";
import { TodoTree } from "./TodoTree";

const ACTIVITY_RAIL_HEADER_HEIGHT = 40;
const ACTIVITY_SECTION_HEADER_HEIGHT = 25;
const ACTIVITY_TREE_SEPARATOR_HEIGHT = 8;
const RESERVED_SECTION_HEADERS = 4;

function useObservedHeight<T extends HTMLElement>(): [RefObject<T | null>, number] {
	const ref = useRef<T>(null);
	const [height, setHeight] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		setHeight(Math.max(0, element.getBoundingClientRect().height));
		const observer = new ResizeObserver(entries => {
			const next = entries.at(-1)?.contentRect.height;
			if (next != null) setHeight(Math.max(0, next));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, height];
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

interface TreeGeometry {
	todoBody: number;
	agentsBody: number;
	separatorDisabled: boolean;
	minimumRatio: number;
	maximumRatio: number;
}

function treeGeometry(height: number, ratio: number, todoCollapsed: boolean, agentsCollapsed: boolean): TreeGeometry {
	if (todoCollapsed && agentsCollapsed) {
		return { todoBody: 0, agentsBody: 0, separatorDisabled: true, minimumRatio: 0, maximumRatio: 1 };
	}
	if (todoCollapsed) {
		return {
			todoBody: 0,
			agentsBody: Math.max(0, height - 2 * ACTIVITY_SECTION_HEADER_HEIGHT),
			separatorDisabled: true,
			minimumRatio: 0,
			maximumRatio: 1,
		};
	}
	if (agentsCollapsed) {
		return {
			todoBody: Math.max(0, height - 2 * ACTIVITY_SECTION_HEADER_HEIGHT),
			agentsBody: 0,
			separatorDisabled: true,
			minimumRatio: 0,
			maximumRatio: 1,
		};
	}

	const bodiesHeight = Math.max(0, height - 2 * ACTIVITY_SECTION_HEADER_HEIGHT - ACTIVITY_TREE_SEPARATOR_HEIGHT);
	if (bodiesHeight < 2 * ACTIVITY_TREE_MIN_BODY_HEIGHT) {
		const equalBody = bodiesHeight / 2;
		return {
			todoBody: equalBody,
			agentsBody: bodiesHeight - equalBody,
			separatorDisabled: true,
			minimumRatio: 0.5,
			maximumRatio: 0.5,
		};
	}
	const minimumRatio = ACTIVITY_TREE_MIN_BODY_HEIGHT / bodiesHeight;
	const maximumRatio = 1 - minimumRatio;
	const effectiveRatio = clamp(ratio, minimumRatio, maximumRatio);
	const todoBody = bodiesHeight * effectiveRatio;
	return {
		todoBody,
		agentsBody: bodiesHeight - todoBody,
		separatorDisabled: false,
		minimumRatio,
		maximumRatio,
	};
}

function CompactActivityLauncher({ activeTabId }: { activeTabId: string }) {
	const t = useT();
	const todoCount = useTodoStore(state => state.phases.reduce((count, phase) => count + phase.tasks.length, 0));
	const hasLiveTodo = useTodoStore(state =>
		state.phases.some(phase => phase.tasks.some(task => task.status === "pending" || task.status === "in_progress")),
	);
	const agents = useSubagentsStore(state => state.subagents);
	const revealSection = useActivitySidebarStore(state => state.revealSection);
	const agentCount = agents.size;
	const hasLiveAgent = [...agents.values()].some(agent => agent.status === "running" || agent.status === "queued");

	return (
		<aside
			aria-label={t("activitySidebar.title")}
			className="flex h-full w-10 flex-col items-center gap-1 border-l border-(--omp-border) py-2"
		>
			<button
				aria-label={t("activitySidebar.expand")}
				className="omp-pressable flex size-8 items-center justify-center rounded-lg"
				onClick={() => revealSection(null, activeTabId)}
				type="button"
			>
				<ChevronRight size={16} />
			</button>
			<button
				aria-label={`${t("activitySidebar.todo.label")} ${todoCount}${hasLiveTodo ? `, ${t("todoPanel.status.inProgress")}` : ""}`}
				className="omp-pressable relative flex size-8 items-center justify-center rounded-lg"
				data-live={hasLiveTodo || undefined}
				onClick={() => revealSection("todo", activeTabId)}
				type="button"
			>
				<ListTodo size={15} />
				{hasLiveTodo && (
					<span
						aria-hidden="true"
						className="absolute top-0 right-0 size-2 rounded-full bg-(--omp-accent)"
						data-activity-live-indicator="todo"
					/>
				)}
				<span className="absolute right-0 bottom-0 text-[9px] tabular-nums">{todoCount}</span>
			</button>
			<button
				aria-label={`${t("dock.agents")} ${agentCount}${hasLiveAgent ? `, ${t("sidebar.signal.running")}` : ""}`}
				className="omp-pressable relative flex size-8 items-center justify-center rounded-lg"
				data-live={hasLiveAgent || undefined}
				onClick={() => revealSection("agents", activeTabId)}
				type="button"
			>
				<Bot size={15} />
				{hasLiveAgent && (
					<span
						aria-hidden="true"
						className="absolute top-0 right-0 size-2 rounded-full bg-(--omp-status-subagents)"
						data-activity-live-indicator="agents"
					/>
				)}
				<span className="absolute right-0 bottom-0 text-[9px] tabular-nums">{agentCount}</span>
			</button>
		</aside>
	);
}

export function ActivitySidebar({ compact, activeTabId }: { compact: boolean; activeTabId: string }) {
	const t = useT();
	const routeReady = useActiveTabRouteReady();
	const readOnly = useAgentViewStore(state => state.target.kind === "subagent") || !routeReady;
	const splitRatio = useActivitySidebarStore(state => state.splitRatio);
	const treeCollapsed = useActivitySidebarStore(state => state.treeCollapsed);
	const setSplitRatio = useActivitySidebarStore(state => state.setSplitRatio);
	const resetSplitRatio = useActivitySidebarStore(state => state.resetSplitRatio);
	const setManualCollapsed = useActivitySidebarStore(state => state.setManualCollapsed);
	const [railRef, railHeight] = useObservedHeight<HTMLElement>();
	const [treeAreaRef, treeAreaHeight] = useObservedHeight<HTMLDivElement>();
	const [previewRatio, setPreviewRatio] = useState<number | null>(null);
	const previewRatioRef = useRef<number | null>(null);
	const dragCleanupRef = useRef<(() => void) | null>(null);

	const metadataBudget = Math.max(
		0,
		railHeight -
			ACTIVITY_RAIL_HEADER_HEIGHT -
			RESERVED_SECTION_HEADERS * ACTIVITY_SECTION_HEADER_HEIGHT -
			ACTIVITY_TREE_SEPARATOR_HEIGHT -
			2 * ACTIVITY_TREE_MIN_BODY_HEIGHT,
	);
	const ratio = previewRatio ?? splitRatio;
	const geometry = useMemo(
		() => treeGeometry(treeAreaHeight, ratio, treeCollapsed.todo, treeCollapsed.agents),
		[ratio, treeAreaHeight, treeCollapsed.agents, treeCollapsed.todo],
	);
	const allocatedBodiesHeight = geometry.todoBody + geometry.agentsBody;
	const effectiveRatio = allocatedBodiesHeight > 0 ? geometry.todoBody / allocatedBodiesHeight : 0.5;
	const separatorVisible = !treeCollapsed.todo && !treeCollapsed.agents;

	useEffect(() => () => dragCleanupRef.current?.(), []);

	const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
		if (geometry.separatorDisabled || event.button !== 0) return;
		event.preventDefault();
		dragCleanupRef.current?.();
		const startY = event.clientY;
		const startRatio = effectiveRatio;
		previewRatioRef.current = startRatio;
		setPreviewRatio(startRatio);
		const bodiesHeight = geometry.todoBody + geometry.agentsBody;
		let finished = false;
		const onMove = (moveEvent: PointerEvent) => {
			if (finished) return;
			const next = clamp(
				startRatio + (moveEvent.clientY - startY) / bodiesHeight,
				geometry.minimumRatio,
				geometry.maximumRatio,
			);
			previewRatioRef.current = next;
			setPreviewRatio(next);
		};
		const cleanup = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onFinish);
			document.removeEventListener("pointercancel", onFinish);
			if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
		};
		const onFinish = () => {
			if (finished) return;
			finished = true;
			cleanup();
			const committed = previewRatioRef.current;
			previewRatioRef.current = null;
			setPreviewRatio(null);
			if (committed != null) useActivitySidebarStore.getState().setSplitRatio(committed);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onFinish);
		document.addEventListener("pointercancel", onFinish);
		dragCleanupRef.current = cleanup;
	};

	const updateRatioFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (geometry.separatorDisabled || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
		event.preventDefault();
		const amount = event.shiftKey ? 0.1 : 0.02;
		const direction = event.key === "ArrowDown" ? 1 : -1;
		setSplitRatio(clamp(effectiveRatio + amount * direction, geometry.minimumRatio, geometry.maximumRatio));
	};

	if (compact) return <CompactActivityLauncher activeTabId={activeTabId} />;

	return (
		<aside
			aria-label={t("activitySidebar.title")}
			className="grid h-full min-h-0 grid-rows-[40px_auto_minmax(0,1fr)] border-l border-(--omp-border) bg-(--omp-bg-primary)"
			data-activity-rail
			ref={railRef}
		>
			<header className="flex h-10 items-center gap-2 px-3">
				<span className="min-w-0 flex-1 truncate text-omp-lg font-semibold">{t("activitySidebar.title")}</span>
				<button
					aria-label={t("activitySidebar.collapse")}
					className="omp-pressable flex size-7 items-center justify-center rounded-md"
					onClick={() => setManualCollapsed(true)}
					type="button"
				>
					<PanelRightClose size={15} />
				</button>
			</header>
			<ActivityMetaRows maxDetailHeight={metadataBudget} readOnly={readOnly} />
			<div
				className="grid min-h-0"
				data-activity-tree-area
				ref={treeAreaRef}
				style={{
					gridTemplateRows: separatorVisible
						? `${ACTIVITY_SECTION_HEADER_HEIGHT + geometry.todoBody}px ${ACTIVITY_TREE_SEPARATOR_HEIGHT}px ${ACTIVITY_SECTION_HEADER_HEIGHT + geometry.agentsBody}px`
						: `${ACTIVITY_SECTION_HEADER_HEIGHT + geometry.todoBody}px ${ACTIVITY_SECTION_HEADER_HEIGHT + geometry.agentsBody}px`,
				}}
			>
				<div className="min-h-0" data-activity-section="todo">
					<PanelErrorBoundary>
						<ActivitySection
							bodyClassName="min-h-0 flex-1"
							className="flex h-full min-h-0 flex-col rounded-none"
							icon={ListTodo}
							id="todo"
							title={t("activitySidebar.todo.label")}
						>
							<div
								className="min-h-0 overflow-y-auto"
								data-activity-tree-scroll
								style={{ height: `${geometry.todoBody}px` }}
							>
								<TodoTree readOnly={readOnly} />
							</div>
						</ActivitySection>
					</PanelErrorBoundary>
				</div>
				{separatorVisible && (
					<div
						aria-disabled={geometry.separatorDisabled}
						aria-label={t("activitySidebar.resizeTrees")}
						aria-orientation="horizontal"
						aria-valuemax={Math.round(geometry.maximumRatio * 100)}
						aria-valuemin={Math.round(geometry.minimumRatio * 100)}
						aria-valuenow={Math.round(effectiveRatio * 100)}
						className="omp-pressable cursor-row-resize border-y border-(--omp-border-muted)"
						onDoubleClick={() => {
							if (!geometry.separatorDisabled) resetSplitRatio();
						}}
						onKeyDown={updateRatioFromKeyboard}
						onPointerDown={startDrag}
						role="separator"
						tabIndex={geometry.separatorDisabled ? -1 : 0}
					/>
				)}
				<div className="min-h-0" data-activity-section="agents">
					<PanelErrorBoundary>
						<ActivitySection
							bodyClassName="min-h-0 flex-1"
							className="flex h-full min-h-0 flex-col rounded-none"
							icon={Bot}
							id="agents"
							title={t("dock.agents")}
						>
							<div
								className="min-h-0 overflow-y-auto"
								data-activity-tree-scroll
								style={{ height: `${geometry.agentsBody}px` }}
							>
								<AgentTree />
							</div>
						</ActivitySection>
					</PanelErrorBoundary>
				</div>
			</div>
		</aside>
	);
}
