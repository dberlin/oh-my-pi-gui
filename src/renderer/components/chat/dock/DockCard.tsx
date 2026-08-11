/**
 * DockCard: shared chrome for the center-dock live cards (todo/plan/agents)
 * mounted between the transcript and the composer. Collapse state lives in
 * the ui store so it survives card unmounts (tab switches, content-driven
 * hide/show); `focusDockCard(id)` deep links expand the card and flash a
 * ring — that is how command-palette entries (todo edit, plan-review) land
 * here now that the workspace drawer no longer carries these surfaces.
 */

import { ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { type DockCardId, useUiStore } from "../../../stores/ui";

interface DockCardProps {
	id: DockCardId;
	icon: LucideIcon;
	title: string;
	/** Summary chip rendered after the title (counts, status). */
	badge?: ReactNode;
	/** Right-side header controls (view toggles, refresh buttons). */
	actions?: ReactNode;
	/** Body content; each card owns its internal scroll region (plan pins its review footer). */
	children: ReactNode;
}

/** How long the accent ring lingers after a focusDockCard deep link. */
const FOCUS_FLASH_MS = 1200;

export function DockCard({ id, icon: Icon, title, badge, actions, children }: DockCardProps) {
	const t = useT();
	const collapsed = useUiStore(s => s.dockCollapsed[id] ?? false);
	const toggleDockCard = useUiStore(s => s.toggleDockCard);
	const focusSeq = useUiStore(s => (s.dockFocus?.id === id ? s.dockFocus.seq : 0));
	const [flash, setFlash] = useState(false);
	const flashTimer = useRef<number | undefined>(undefined);
	const seenSeq = useRef(focusSeq);

	useEffect(() => {
		if (focusSeq === seenSeq.current) return;
		seenSeq.current = focusSeq;
		setFlash(true);
		clearTimeout(flashTimer.current);
		flashTimer.current = window.setTimeout(() => setFlash(false), FOCUS_FLASH_MS);
		return () => clearTimeout(flashTimer.current);
	}, [focusSeq]);

	return (
		<section
			aria-label={title}
			className={cx(
				"rounded-xl border transition-shadow duration-300",
				flash
					? "border-[var(--omp-accent)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--omp-accent)_35%,transparent)]"
					: "border-[var(--omp-border)]",
			)}
		>
			<div className="flex items-center gap-1.5 px-2.5 py-1.5">
				<button
					aria-expanded={!collapsed}
					aria-label={collapsed ? t("dock.expand") : t("dock.collapse")}
					className="omp-pressable flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left"
					onClick={() => toggleDockCard(id)}
					type="button"
				>
					<ChevronRight
						className="shrink-0 text-[var(--omp-dim)] transition-transform duration-100"
						size={13}
						style={{ transform: collapsed ? undefined : "rotate(90deg)" }}
					/>
					<Icon className="shrink-0 text-[var(--omp-muted)]" size={13} />
					<span className="truncate text-omp-sm font-semibold tracking-wide text-[var(--omp-muted)] uppercase">
						{title}
					</span>
					{badge}
				</button>
				{actions}
			</div>
			{!collapsed && <div className="border-t border-[var(--omp-border-muted)]">{children}</div>}
		</section>
	);
}
