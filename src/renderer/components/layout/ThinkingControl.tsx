/**
 * Composer thinking-level control (Codex/Claude Code-style effort picker):
 * an explicit menu of every selector the ACTIVE MODEL supports — off, auto,
 * and the model's own effort ladder from get_state — with the current
 * selector checked. Replaces the blind click-to-cycle chip, which jumped to
 * an unspecified next value and offered no way to pick `auto` or go back.
 *
 * Data comes from the model store (`thinkingConfigured`, `availableThinkingLevels`,
 * hydrated from get_state and thinking_level_changed events); selection goes
 * through `set_thinking_level`, which the agent resolves/clamps per model.
 * The dropdown renders in a portal so the composer's overflow-hidden never
 * clips it (same pattern as ApprovalControl).
 */

import { Brain, Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { THINKING_LEVEL_VALUES, type ThinkingLevel } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { toast } from "../../stores/toast";

type ThinkingSelector = ThinkingLevel | "auto";

/** Menu order: off, auto, then the model's ladder (already ascending). */
function menuOptions(available: ThinkingLevel[]): ThinkingSelector[] {
	// Defensive: keep only known levels, never offer a value the model rejected.
	const ladder = THINKING_LEVEL_VALUES.filter(level => level !== "off" && available.includes(level));
	return ["off", "auto", ...ladder];
}

export function ThinkingControl() {
	const t = useT();
	const thinkingLevel = useModelStore(s => s.thinkingLevel);
	const configured = useModelStore(s => s.thinkingConfigured);
	const available = useModelStore(s => s.availableThinkingLevels);
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

	const current: ThinkingSelector = configured ?? thinkingLevel ?? "off";
	const supportsThinking = available.length > 0;

	// Position the portal menu above the trigger whenever it opens.
	useLayoutEffect(() => {
		if (!open || !triggerRef.current) return;
		const rect = triggerRef.current.getBoundingClientRect();
		setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
	}, [open]);

	// Close on any outside pointer press.
	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
			setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open]);

	const select = (level: ThinkingSelector) => {
		setOpen(false);
		void window.omp.rpc.setThinkingLevel(level).then(res => {
			if (res.success) {
				// thinking_level_changed follows on the wire; apply the receipt now
				// so the chip reflects the pick within the same frame.
				useModelStore.setState({ thinkingConfigured: level });
			} else {
				toast({ variant: "error", title: t("input.thinking.failed"), message: res.error });
			}
		});
	};

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				onClick={() => setOpen(value => !value)}
				title={t("input.thinking", { level: current })}
				className="omp-pressable flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium hover:bg-[var(--omp-selected-bg)]"
				style={{ color: `var(--omp-thinking-${thinkingLevel ?? "off"})` }}
			>
				<Brain size={14} />
				<span className="hidden sm:inline">{current}</span>
				<ChevronDown size={12} className="shrink-0 text-[var(--omp-dim)]" />
			</button>

			{open && pos
				? createPortal(
						<div
							ref={menuRef}
							style={{ left: pos.left, bottom: pos.bottom }}
							className="fixed z-[100] w-64 overflow-hidden rounded-xl border border-[var(--omp-border)] bg-[var(--omp-panel-bg)] p-1 shadow-[var(--omp-shadow-md)]"
						>
							{supportsThinking ? (
								menuOptions(available).map(option => {
									const active = option === current;
									return (
										<button
											key={option}
											type="button"
											onClick={() => select(option)}
											className="omp-pressable flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--omp-selected-bg)]"
										>
											<span className="mt-0.5 w-4 shrink-0 text-[var(--omp-accent)]">
												{active ? <Check size={14} /> : null}
											</span>
											<span className="min-w-0 flex-1">
												<span
													className={cx("block font-mono text-[12px] font-medium", !active && "text-[var(--omp-muted)]")}
													style={
														option === "auto"
															? undefined
															: { color: `var(--omp-thinking-${option})` }
													}
												>
													{option}
												</span>
												<span className="block text-[11px] leading-snug text-[var(--omp-dim)]">
													{t(`input.thinking.level.${option}`)}
												</span>
											</span>
										</button>
									);
								})
							) : (
								<div className="px-2.5 py-2 text-[12px] text-[var(--omp-muted)]">{t("input.thinking.unsupported")}</div>
							)}
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
