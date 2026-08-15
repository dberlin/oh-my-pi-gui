import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useT } from "../../lib/i18n";
import {
	ACTIVITY_SIDEBAR_COMPACT_WIDTH,
	ACTIVITY_SIDEBAR_DEFAULT_WIDTH,
	ACTIVITY_SIDEBAR_MAX_WIDTH,
	ACTIVITY_SIDEBAR_MIN_WIDTH,
	ACTIVITY_TRANSCRIPT_MIN_WIDTH,
	useActivitySidebarStore,
} from "../../stores/activity-sidebar";
import { useTabsStore } from "../../stores/tabs";
import { ActivitySidebar } from "../chat/activity/ActivitySidebar";

interface FocusIdentity {
	section: string;
	rowId: string | null;
	rowLabel: string | null;
	rowIdGenerated: boolean;
	rowSemanticOrdinal: number | null;
	rowSemanticScope: string | null;
	rowTodoProvenance: boolean;
	targetLabel: string | null;
	targetRole: string | null;
	targetTag: string;
}

type FocusTransition = { kind: "header" } | { kind: "launcher" } | { kind: "restore"; identity: FocusIdentity };

interface HorizontalDrag {
	finished: boolean;
	previewWidth: number;
	startWidth: number;
	startX: number;
	cleanup: () => void;
}

function clampWidth(width: number): number {
	return Math.min(ACTIVITY_SIDEBAR_MAX_WIDTH, Math.max(ACTIVITY_SIDEBAR_MIN_WIDTH, width));
}

function normalizedText(element: Element): string {
	return (element.textContent ?? "").replaceAll(/\s+/g, " ").trim();
}

function sectionIdentity(element: HTMLElement, rail: HTMLElement): string {
	const markedSection = element.closest<HTMLElement>("[data-activity-section]");
	if (markedSection?.dataset.activitySection) return `id:${markedSection.dataset.activitySection}`;
	const labelledSection = element.closest<HTMLElement>("section[aria-label]");
	if (labelledSection) return `label:${labelledSection.getAttribute("aria-label") ?? ""}`;
	if (element.closest("header")) return "header";
	return rail.contains(element) ? "rail" : "";
}

interface RowIdentity {
	rowId: string | null;
	rowLabel: string | null;
}

function rowIdentity(row: HTMLElement | null): RowIdentity {
	if (!row) return { rowId: null, rowLabel: null };
	const todoId = row.dataset.todoTreeId;
	const ariaLabel = row.getAttribute("aria-label");
	if (todoId) {
		return {
			rowId: `todo:${todoId}`,
			rowLabel: ariaLabel,
		};
	}
	if (ariaLabel) return { rowId: `aria:${ariaLabel}`, rowLabel: ariaLabel };
	const agentOrdinal = [...row.querySelectorAll("span.tabular-nums")].find(candidate =>
		/^#\d+$/.test(normalizedText(candidate)),
	);
	if (agentOrdinal) {
		const agentKind = agentOrdinal.previousElementSibling ? normalizedText(agentOrdinal.previousElementSibling) : "";
		return {
			rowId: `agent:${agentKind}:${normalizedText(agentOrdinal)}`,
			rowLabel: null,
		};
	}
	const titled = row.querySelector<HTMLElement>("[title]")?.getAttribute("title");
	return {
		rowId: titled ? `title:${titled}` : null,
		rowLabel: titled ? null : normalizedText(row),
	};
}
interface RowSemanticPosition {
	ordinal: number | null;
	scope: string | null;
}

function sameLabelOrdinal(row: HTMLElement, scope: HTMLElement | null): number | null {
	if (!scope) return null;
	const label = row.getAttribute("aria-label");
	const level = row.getAttribute("aria-level");
	const peers = [...scope.querySelectorAll<HTMLElement>('[role="treeitem"]')].filter(
		candidate => candidate.getAttribute("aria-label") === label && candidate.getAttribute("aria-level") === level,
	);
	const ordinal = peers.indexOf(row);
	return ordinal >= 0 ? ordinal : null;
}

function rowSemanticPosition(row: HTMLElement | null): RowSemanticPosition {
	if (!row?.dataset.todoTreeId) return { ordinal: null, scope: null };
	const level = row.getAttribute("aria-level");
	if (level === "1") {
		return {
			ordinal: sameLabelOrdinal(row, row.closest<HTMLElement>('[role="tree"]')),
			scope: "phases",
		};
	}
	if (level !== "2") return { ordinal: null, scope: null };
	const phaseSection = row.closest<HTMLElement>("section");
	const phaseRow = phaseSection?.querySelector<HTMLElement>('[role="treeitem"][aria-level="1"]') ?? null;
	const phaseLabel = phaseRow?.getAttribute("aria-label") ?? "";
	const phaseOrdinal = phaseRow ? sameLabelOrdinal(phaseRow, phaseRow.closest<HTMLElement>('[role="tree"]')) : null;
	const phaseScope =
		phaseRow?.dataset.todoIdGenerated === "false"
			? `phase-id:${phaseRow.dataset.todoTreeId ?? ""}`
			: `phase:${phaseLabel}:${phaseOrdinal ?? ""}`;
	return {
		ordinal: sameLabelOrdinal(row, row.closest<HTMLElement>('[role="group"]')),
		scope: phaseScope,
	};
}

function captureFocusIdentity(element: HTMLElement, rail: HTMLElement): FocusIdentity {
	const row = element.closest<HTMLElement>('[role="treeitem"]');
	const { rowId, rowLabel } = rowIdentity(row);
	const semanticPosition = rowSemanticPosition(row);
	return {
		section: sectionIdentity(element, rail),
		rowId,
		rowIdGenerated: row?.dataset.todoIdGenerated === "true",
		rowLabel,
		rowSemanticOrdinal: semanticPosition.ordinal,
		rowSemanticScope: semanticPosition.scope,
		rowTodoProvenance: row?.dataset.todoIdGenerated !== undefined,
		targetLabel: element.getAttribute("aria-label"),
		targetRole: element.getAttribute("role"),
		targetTag: element.tagName,
	};
}

function findSection(rail: HTMLElement, identity: FocusIdentity): HTMLElement | null {
	if (identity.section === "header") return rail.querySelector("header");
	if (identity.section === "rail") return rail;
	const [kind, value = ""] = identity.section.split(":", 2);
	const candidates =
		kind === "id"
			? rail.querySelectorAll<HTMLElement>("[data-activity-section]")
			: rail.querySelectorAll<HTMLElement>("section[aria-label]");
	return (
		[...candidates].find(candidate =>
			kind === "id" ? candidate.dataset.activitySection === value : candidate.getAttribute("aria-label") === value,
		) ?? null
	);
}

function findRow(section: HTMLElement, identity: FocusIdentity): HTMLElement | null {
	if (!identity.rowId && !identity.rowLabel) return null;
	const candidates = [...section.querySelectorAll<HTMLElement>('[role="treeitem"]')];
	const provenanceCandidates = identity.rowTodoProvenance
		? candidates.filter(candidate => candidate.dataset.todoIdGenerated === String(identity.rowIdGenerated))
		: candidates;
	const idMatch = provenanceCandidates.find(candidate => rowIdentity(candidate).rowId === identity.rowId);
	if (!identity.rowIdGenerated) return idMatch ?? null;
	if (idMatch) {
		const idPosition = rowSemanticPosition(idMatch);
		if (
			rowIdentity(idMatch).rowLabel === identity.rowLabel &&
			idPosition.ordinal === identity.rowSemanticOrdinal &&
			idPosition.scope === identity.rowSemanticScope
		) {
			return idMatch;
		}
	}
	if (identity.rowLabel === null) return null;
	return (
		provenanceCandidates.find(candidate => {
			const candidatePosition = rowSemanticPosition(candidate);
			return (
				rowIdentity(candidate).rowLabel === identity.rowLabel &&
				candidatePosition.ordinal === identity.rowSemanticOrdinal &&
				candidatePosition.scope === identity.rowSemanticScope
			);
		}) ?? null
	);
}

function findFocusTarget(rail: HTMLElement, identity: FocusIdentity): HTMLElement | null {
	const section = findSection(rail, identity);
	if (!section) return null;
	const row = findRow(section, identity);
	if (identity.rowId || identity.rowLabel) {
		if (!row) return null;
		if (identity.targetRole === "treeitem" || (identity.targetTag === row.tagName && !identity.targetLabel))
			return row;
	}
	const scope = row ?? section;
	return (
		[...scope.querySelectorAll<HTMLElement>(identity.targetTag.toLowerCase())].find(
			candidate =>
				candidate.getAttribute("aria-label") === identity.targetLabel &&
				candidate.getAttribute("role") === identity.targetRole,
		) ?? null
	);
}

export function WorkspaceCanvas({ children }: { children: ReactNode }) {
	const t = useT();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const hasActivityOwner = useTabsStore(
		state => state.tabs.find(tab => tab.id === state.activeTabId)?.kind === "agent",
	);
	const width = useActivitySidebarStore(state => state.width);
	const manualCollapsed = useActivitySidebarStore(state => state.manualCollapsed);
	const narrowOverrideTabId = useActivitySidebarStore(state => state.narrowOverrideTabId);
	const hydrate = useActivitySidebarStore(state => state.hydrate);
	const clearNarrowOverride = useActivitySidebarStore(state => state.clearNarrowOverride);
	const commitWidth = useActivitySidebarStore(state => state.commitWidth);
	const canvasRef = useRef<HTMLDivElement>(null);
	const railRegionRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<HorizontalDrag | null>(null);
	const frozenCompactRef = useRef(false);
	const restoreIdentityRef = useRef<FocusIdentity | null>(null);
	const focusTransitionRef = useRef<FocusTransition | null>(null);
	const focusTabIdRef = useRef(activeTabId);
	const [canvasWidth, setCanvasWidth] = useState<number | null>(null);
	const [dragging, setDragging] = useState(false);
	const [previewWidth, setPreviewWidth] = useState<number | null>(null);

	const autoCompact = canvasWidth !== null && canvasWidth - width < ACTIVITY_TRANSCRIPT_MIN_WIDTH;
	const hasCurrentOverride = activeTabId !== null && narrowOverrideTabId === activeTabId;
	const effectiveCompact = manualCollapsed || (autoCompact && !hasCurrentOverride);
	const compact = dragging ? frozenCompactRef.current : effectiveCompact;
	const previousCompactRef = useRef(compact);

	if (previousCompactRef.current !== compact) {
		const rail = railRegionRef.current;
		const activeElement = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
		if (!previousCompactRef.current && compact) {
			const automaticCollapse = !manualCollapsed && autoCompact && !hasCurrentOverride;
			if (rail && activeElement && rail.contains(activeElement)) {
				restoreIdentityRef.current = automaticCollapse ? captureFocusIdentity(activeElement, rail) : null;
				focusTransitionRef.current = { kind: "launcher" };
			} else if (!automaticCollapse) {
				restoreIdentityRef.current = null;
			}
		} else if (previousCompactRef.current && !compact) {
			if (!autoCompact && restoreIdentityRef.current) {
				focusTransitionRef.current = { kind: "restore", identity: restoreIdentityRef.current };
			} else if (rail && activeElement && rail.contains(activeElement)) {
				focusTransitionRef.current = { kind: "header" };
			}
			restoreIdentityRef.current = null;
		}
		previousCompactRef.current = compact;
	}

	useEffect(() => {
		void hydrate();
	}, [hydrate]);

	useEffect(() => {
		clearNarrowOverride(activeTabId);
	}, [activeTabId, clearNarrowOverride]);

	useEffect(() => {
		if (!hasActivityOwner) {
			setCanvasWidth(null);
			return;
		}
		const canvas = canvasRef.current;
		if (!canvas) return;
		const observer = new ResizeObserver(entries => {
			const measuredWidth = entries.at(-1)?.contentRect.width;
			if (measuredWidth != null && Number.isFinite(measuredWidth) && measuredWidth > 0) {
				setCanvasWidth(measuredWidth);
			}
		});
		observer.observe(canvas);
		return () => observer.disconnect();
	}, [hasActivityOwner]);

	useEffect(
		() => () => {
			dragRef.current?.cleanup();
			dragRef.current = null;
		},
		[],
	);

	useLayoutEffect(() => {
		if (focusTabIdRef.current === activeTabId) return;
		focusTabIdRef.current = activeTabId;
		restoreIdentityRef.current = null;
		focusTransitionRef.current = null;
	}, [activeTabId]);

	useLayoutEffect(() => {
		const transition = focusTransitionRef.current;
		if (!transition) return;
		if ((transition.kind === "launcher") !== compact) {
			focusTransitionRef.current = null;
			return;
		}
		focusTransitionRef.current = null;
		const rail = railRegionRef.current;
		if (!rail) return;
		if (transition.kind === "launcher") {
			rail.querySelector<HTMLElement>("aside button")?.focus();
			return;
		}
		if (transition.kind === "header") {
			rail.querySelector<HTMLElement>("[data-activity-rail] > header button")?.focus();
			return;
		}
		findFocusTarget(rail, transition.identity)?.focus();
	}, [compact]);

	const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		dragRef.current?.cleanup();
		const startWidth = clampWidth(width);
		frozenCompactRef.current = compact;
		setDragging(true);
		setPreviewWidth(startWidth);
		let drag: HorizontalDrag;
		const onMove = (moveEvent: PointerEvent) => {
			if (drag.finished) return;
			drag.previewWidth = clampWidth(drag.startWidth + drag.startX - moveEvent.clientX);
			setPreviewWidth(drag.previewWidth);
		};
		const cleanup = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onFinish);
			document.removeEventListener("pointercancel", onFinish);
			if (dragRef.current === drag) dragRef.current = null;
		};
		const onFinish = () => {
			if (drag.finished) return;
			drag.finished = true;
			cleanup();
			commitWidth(drag.previewWidth);
			setPreviewWidth(null);
			setDragging(false);
		};
		drag = {
			finished: false,
			previewWidth: startWidth,
			startWidth,
			startX: event.clientX,
			cleanup,
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onFinish);
		document.addEventListener("pointercancel", onFinish);
		dragRef.current = drag;
	};

	const updateWidthFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const amount = event.shiftKey ? 32 : 8;
		commitWidth(width + (event.key === "ArrowRight" ? amount : -amount));
	};

	if (!hasActivityOwner) return children;

	const displayedWidth = previewWidth ?? width;
	return (
		<div className="flex min-h-0 min-w-0 flex-1" data-workspace-canvas ref={canvasRef}>
			<div className="flex min-h-0 min-w-0 flex-1" data-workspace-transcript>
				{children}
			</div>
			{!compact && (
				<div
					aria-label={t("activitySidebar.resize")}
					aria-orientation="vertical"
					aria-valuemax={ACTIVITY_SIDEBAR_MAX_WIDTH}
					aria-valuemin={ACTIVITY_SIDEBAR_MIN_WIDTH}
					aria-valuenow={Math.round(displayedWidth)}
					className="omp-pressable w-1 shrink-0 cursor-col-resize border-x border-(--omp-border-muted)"
					onDoubleClick={() => commitWidth(ACTIVITY_SIDEBAR_DEFAULT_WIDTH)}
					onKeyDown={updateWidthFromKeyboard}
					onPointerDown={startDrag}
					role="separator"
					tabIndex={0}
				/>
			)}
			<div
				className="h-full min-h-0 shrink-0"
				data-activity-sidebar-region
				ref={railRegionRef}
				style={{ width: `${compact ? ACTIVITY_SIDEBAR_COMPACT_WIDTH : displayedWidth}px` }}
			>
				<ActivitySidebar activeTabId={activeTabId ?? ""} compact={compact} />
			</div>
		</div>
	);
}
