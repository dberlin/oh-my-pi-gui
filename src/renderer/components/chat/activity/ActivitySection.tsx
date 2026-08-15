import { ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import {
	type ActivitySectionId,
	type ActivitySidebarStore,
	type ActivityTreeId,
	useActivitySidebarStore,
} from "../../../stores/activity-sidebar";

export interface ActivitySectionProps {
	id: ActivitySectionId;
	title: string;
	icon: LucideIcon;
	badge?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
}

const FOCUS_FLASH_MS = 1200;

function isTreeSection(id: ActivitySectionId): id is ActivityTreeId {
	return id === "todo" || id === "agents";
}

function isSectionExpanded(state: ActivitySidebarStore, id: ActivitySectionId): boolean {
	return isTreeSection(id) ? !state.treeCollapsed[id] : state.expandedMeta === id;
}

export function ActivitySection({
	id,
	title,
	icon: Icon,
	badge,
	actions,
	children,
	className,
	bodyClassName,
}: ActivitySectionProps) {
	const t = useT();
	const expanded = useActivitySidebarStore(state => isSectionExpanded(state, id));
	const toggleMeta = useActivitySidebarStore(state => state.toggleMeta);
	const toggleTree = useActivitySidebarStore(state => state.toggleTree);
	const focusSeq = useActivitySidebarStore(state => (state.focusRequest?.id === id ? state.focusRequest.seq : 0));
	const disclosureRef = useRef<HTMLButtonElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const seenFocusSeq = useRef(0);
	const flashTimer = useRef<number | undefined>(undefined);
	const [focused, setFocused] = useState(false);

	useEffect(
		() =>
			useActivitySidebarStore.subscribe((state, previousState) => {
				if (
					isSectionExpanded(previousState, id) &&
					!isSectionExpanded(state, id) &&
					bodyRef.current?.contains(document.activeElement)
				) {
					disclosureRef.current?.focus();
				}
			}),
		[id],
	);

	useEffect(() => {
		if (focusSeq === 0 || focusSeq === seenFocusSeq.current) return;
		seenFocusSeq.current = focusSeq;
		disclosureRef.current?.focus();
		setFocused(true);
		window.clearTimeout(flashTimer.current);
		flashTimer.current = window.setTimeout(() => setFocused(false), FOCUS_FLASH_MS);
	}, [focusSeq]);

	useEffect(() => () => window.clearTimeout(flashTimer.current), []);

	const toggle = () => {
		if (isTreeSection(id)) toggleTree(id);
		else toggleMeta(id);
	};

	return (
		<section
			aria-label={title}
			className={cx(
				"overflow-hidden rounded-[18px] border bg-[color-mix(in_srgb,var(--omp-bg-secondary)_72%,transparent)] transition-shadow duration-300",
				focused
					? "border-[var(--omp-accent)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--omp-accent)_35%,transparent)]"
					: "border-[var(--omp-border)]",
				className,
			)}
			data-activity-focused={focused || undefined}
		>
			<div
				className="flex h-[23px] min-h-[23px] items-center gap-2 px-3 py-0.5"
				data-activity-section-header
				style={{ height: "23px" }}
			>
				<button
					aria-expanded={expanded}
					aria-label={t(expanded ? "activitySidebar.collapseSection" : "activitySidebar.expandSection", {
						section: title,
					})}
					className="omp-pressable flex min-w-0 flex-1 items-center gap-2 rounded-md text-left"
					onClick={toggle}
					ref={disclosureRef}
					type="button"
				>
					<Icon aria-hidden="true" className="shrink-0 text-[var(--omp-muted)]" size={15} />
					<span className="truncate text-omp-lg font-semibold text-[var(--omp-text)]">{title}</span>
					{badge}
					<span className="min-w-1 flex-1" />
					<ChevronRight
						aria-hidden="true"
						className="pointer-events-none shrink-0 text-[var(--omp-dim)] transition-transform duration-100"
						size={14}
						style={{ transform: expanded ? "rotate(90deg)" : undefined }}
					/>
				</button>
				{actions}
			</div>
			{expanded && (
				<div className={cx("shadow-[inset_0_1px_0_var(--omp-border-muted)]", bodyClassName)} ref={bodyRef}>
					{children}
				</div>
			)}
		</section>
	);
}
