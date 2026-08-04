/**
 * Small status pill with semantic color variants and optional dot indicator.
 */

import type { ReactNode } from "react";

export type BadgeVariant = "default" | "success" | "warning" | "error" | "info" | "muted";

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
	default: "border-(--omp-border-muted) bg-(--omp-bg-tertiary) text-(--omp-text)",
	success:
		"border-[color-mix(in_srgb,var(--omp-success)_35%,transparent)] bg-[color-mix(in_srgb,var(--omp-success)_12%,transparent)] text-(--omp-success)",
	warning:
		"border-[color-mix(in_srgb,var(--omp-warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--omp-warning)_12%,transparent)] text-(--omp-warning)",
	error: "border-[color-mix(in_srgb,var(--omp-error)_35%,transparent)] bg-[color-mix(in_srgb,var(--omp-error)_12%,transparent)] text-(--omp-error)",
	info: "border-[color-mix(in_srgb,var(--omp-link)_35%,transparent)] bg-[color-mix(in_srgb,var(--omp-link)_12%,transparent)] text-(--omp-link)",
	muted: "border-transparent bg-transparent text-(--omp-dim)",
};

const DOT_CLASSES: Record<BadgeVariant, string> = {
	default: "bg-(--omp-muted)",
	success: "bg-(--omp-success)",
	warning: "bg-(--omp-warning)",
	error: "bg-(--omp-error)",
	info: "bg-(--omp-link)",
	muted: "bg-(--omp-dim)",
};

export interface BadgeProps {
	variant?: BadgeVariant;
	/** Show a small colored dot before the label. */
	dot?: boolean;
	/** Pulse the dot (e.g. live/running states). */
	pulse?: boolean;
	className?: string;
	children: ReactNode;
}

export function Badge({ variant = "default", dot, pulse, className, children }: BadgeProps) {
	return (
		<span
			className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-px text-[10px] font-medium leading-4 tracking-wide whitespace-nowrap ${VARIANT_CLASSES[variant]} ${className ?? ""}`.trim()}
		>
			{dot && (
				<span className="relative flex size-1.5">
					{pulse && (
						<span
							className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${DOT_CLASSES[variant]}`}
						/>
					)}
					<span className={`relative inline-flex size-1.5 rounded-full ${DOT_CLASSES[variant]}`} />
				</span>
			)}
			{children}
		</span>
	);
}
