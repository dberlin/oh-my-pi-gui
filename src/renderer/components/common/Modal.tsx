/**
 * Overlay + centered panel. Backdrop click and Escape close; focus is trapped
 * while open and restored to the previously focused element on close.
 */

import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";

export type ModalSize = "sm" | "md" | "lg" | "full" | "picker";

/** Overlay alignment: centered (default) or top-anchored (command-palette style). */
export type ModalPlacement = "center" | "top";

const SIZE_CLASSES: Record<ModalSize, string> = {
	sm: "max-h-[85vh] w-[360px] max-w-[90vw]",
	md: "max-h-[85vh] w-[520px] max-w-[92vw]",
	lg: "max-h-[85vh] w-[760px] max-w-[95vw]",
	full: "h-[92vh] w-[94vw]",
	picker: "max-h-[68vh] w-[560px] max-w-[92vw]",
};

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
	open: boolean;
	onClose: () => void;
	title?: ReactNode;
	size?: ModalSize;
	/** Hide the title bar entirely (chromeless dialogs like the command palette). */
	chromeless?: boolean;
	/** Overlay alignment: centered (default) or top-anchored palette style. */
	placement?: ModalPlacement;
	/** Accessible name for the dialog (required when chromeless — no visible title). */
	ariaLabel?: string;
	/** Extra classes for the panel. */
	panelClassName?: string;
	/**
	 * Body container classes. Defaults to `px-5 py-4` so the body aligns with the
	 * title bar (also px-5). Pass "p-0" for dialogs that manage their own inner
	 * layout (Settings, chromeless pickers, tree/hub windows).
	 */
	bodyClassName?: string;
	children: ReactNode;
}

export function Modal({
	open,
	onClose,
	title,
	size = "md",
	chromeless,
	placement = "center",
	ariaLabel,
	panelClassName,
	bodyClassName = "px-5 py-4",
	children,
}: ModalProps) {
	const t = useT();
	const panelRef = useRef<HTMLDivElement>(null);
	const restoreRef = useRef<HTMLElement | null>(null);

	// Focus capture runs once per open transition. Depending on `onClose` here
	// would re-focus the panel on every re-render (callers pass non-memoized
	// closures), yanking focus out of inputs on every keystroke.
	useEffect(() => {
		if (!open) return;
		restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		// Focus only when nothing else is — an already-focused element (e.g. the
		// caller autofocused an input) must not be yanked back to the first item.
		const active = document.activeElement;
		const panel = panelRef.current;
		if (!active || active === document.body || active === document.documentElement) {
			const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
			(first ?? panel)?.focus();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const panel = panelRef.current;

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
				return;
			}
			if (event.key !== "Tab" || !panel) return;
			const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
			if (items.length === 0) {
				event.preventDefault();
				panel.focus();
				return;
			}
			const firstEl = items[0];
			const lastEl = items[items.length - 1];
			if (event.shiftKey && document.activeElement === firstEl) {
				event.preventDefault();
				lastEl.focus();
			} else if (!event.shiftKey && document.activeElement === lastEl) {
				event.preventDefault();
				firstEl.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			// Restore focus only when it is currently outside this panel —
			// otherwise a freshly-opened dialog would be blurred back to the
			// element that was focused before this modal opened.
			const active = document.activeElement;
			if (!(active instanceof HTMLElement && panel?.contains(active))) {
				restoreRef.current?.focus();
			}
		};
	}, [open, onClose]);

	if (!open) return null;

	return createPortal(
		<div
			className={`fixed inset-0 z-50 flex justify-center bg-(--omp-overlay-bg) p-4 backdrop-blur-[3px] ${placement === "top" ? "items-start pt-[12vh]" : "items-center"}`}
			onMouseDown={event => {
				if (event.target === event.currentTarget) onClose();
			}}
			role="presentation"
		>
			<div
				aria-label={ariaLabel}
				aria-modal="true"
				className={`omp-scale-in flex flex-col overflow-hidden rounded-[14px] border border-(--omp-modal-border) bg-(--omp-modal-bg) shadow-(--omp-shadow-lg) ${SIZE_CLASSES[size]} ${panelClassName ?? ""}`.trim()}
				onKeyDown={event => {
					if (event.key === "Escape") event.stopPropagation();
				}}
				ref={panelRef}
				role="dialog"
				tabIndex={-1}
			>
				{!chromeless && (
					<div className="flex shrink-0 items-center justify-between gap-3 border-b border-(--omp-border-muted) px-5 py-3.5">
						<div className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-(--omp-text)">
							{title}
						</div>
						<button
							aria-label={t("common.close")}
							className="rounded-lg p-1.5 text-(--omp-muted) transition-colors hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text) focus-visible:outline-2 focus-visible:outline-(--omp-accent)"
							onClick={onClose}
							type="button"
						>
							<X size={15} />
						</button>
					</div>
				)}
				<div className={`min-h-0 flex-1 overflow-y-auto ${bodyClassName}`.trim()}>{children}</div>
			</div>
		</div>,
		document.body,
	);
}
