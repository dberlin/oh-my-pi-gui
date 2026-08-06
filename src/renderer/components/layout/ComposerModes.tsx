/**
 * Composer quick-access cluster: surfaces the most coding-relevant toggles
 * that were previously buried in Settings — Plan mode, Goal, model Roles, and
 * a "more" dropdown for auto-compact / auto-retry / steering / interrupt. Each
 * mirrors the exact RPC + store sync used elsewhere (Settings, palette) so the
 * state stays consistent.
 */

import { Check, ChevronDown, Flag, Infinity as InfinityIcon, ListChecks, Repeat, Users } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { loopLimitText, parseLoopLimit } from "../panels/ModesPanel";

// ON state = accent background + a check beside the mode icon, so an active
// mode reads at a glance; the transparent border keeps the box stable across
// toggles (no 1px layout shift).
const chip = (active: boolean) =>
	cx(
		"omp-pressable flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium",
		active
			? "border-[var(--omp-border-accent)] bg-[var(--omp-accent-dim)] text-[var(--omp-accent)]"
			: "border-transparent text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)]",
	);

export function ComposerModes() {
	const t = useT();
	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const goalActive = useSessionStore(s => s.goalState?.status === "active" || !!s.goal);
	const goalObjective = useSessionStore(s => s.goal?.objective ?? null);
	const loopMode = useSessionStore(s => s.loopMode);
	const loopActive = loopMode?.enabled === true;
	// Shared `goal.statusInFooter` setting: off hides the composer's goal chip
	// (the goal panel stays reachable via Modes/command palette).
	const goalStatusInFooter = useSettingsStore(s => s.goalStatusInFooter);
	const autoCompaction = useSettingsStore(s => s.autoCompaction);
	const autoRetry = useSettingsStore(s => s.autoRetry);
	const steeringMode = useSettingsStore(s => s.steeringMode);
	const interruptMode = useSettingsStore(s => s.interruptMode);
	const openModelRoles = useUiStore(s => s.openModelRoles);
	const openModes = useUiStore(s => s.openModes);

	const [moreOpen, setMoreOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

	// Position the portal menu above the trigger whenever it opens.
	useLayoutEffect(() => {
		if (!moreOpen || !triggerRef.current) return;
		const rect = triggerRef.current.getBoundingClientRect();
		setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
	}, [moreOpen]);

	useEffect(() => {
		if (!moreOpen) return;
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
			setMoreOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [moreOpen]);

	const togglePlan = () => {
		const enabled = !planModeEnabled;
		void window.omp.rpc.setPlanMode(enabled).then(response => {
			if (response.success) {
				const data = response.data as { enabled?: boolean } | undefined;
				useSessionStore.setState({ planModeEnabled: data?.enabled ?? enabled });
			}
		});
	};

	const toggle = (get: boolean, set: (enabled: boolean) => Promise<unknown>, apply: (enabled: boolean) => void) => {
		const next = !get;
		apply(next);
		void set(next);
	};

	// Loop chip tooltip carries the live limit/args (e.g. "7 of 10 iterations
	// left", "Unbounded" when none) — same formatting as the Modes window's loop tab.
	const loopLimit = loopMode ? parseLoopLimit(loopMode.limit) : null;
	const loopArgs = loopLimit ? loopLimitText(t, loopLimit) : t("modesPanel.loop.noLimit");

	return (
		<>
			<button type="button" onClick={togglePlan} title={t("input.plan.title")} className={chip(planModeEnabled)}>
				<ListChecks size={14} />
				{planModeEnabled && <Check size={11} strokeWidth={3} />}
			</button>

			{goalStatusInFooter && (
				<button
					type="button"
					onClick={() => openModes("goal")}
					title={
						goalActive && goalObjective
							? t("input.goal.activeTitle", { objective: goalObjective })
							: t("input.goal.title")
					}
					className={chip(goalActive)}
				>
					<Flag size={14} />
					{goalActive && <Check size={11} strokeWidth={3} />}
				</button>
			)}

			<button
				type="button"
				onClick={() => openModes("loop")}
				title={loopActive ? t("input.loop.activeTitle", { args: loopArgs }) : t("input.loop.title")}
				className={chip(loopActive)}
			>
				<InfinityIcon size={14} />
				{loopActive && <Check size={11} strokeWidth={3} />}
			</button>

			<button type="button" onClick={openModelRoles} title={t("input.roles.title")} className={chip(false)}>
				<Users size={14} />
			</button>

			<div className="relative">
				<button
					ref={triggerRef}
					type="button"
					onClick={() => setMoreOpen(value => !value)}
					title={t("input.more.title")}
					// Highlight only when a non-default is active — auto-compaction
					// and auto-retry default ON, so OR-ing raw values highlights always.
					className={chip(
						autoCompaction === false ||
							autoRetry === false ||
							steeringMode !== "all" ||
							interruptMode !== "immediate",
					)}
				>
					<Repeat size={14} />
					<ChevronDown size={12} className="shrink-0 text-[var(--omp-dim)]" />
				</button>

				{moreOpen && pos
					? createPortal(
							<div
								ref={menuRef}
								style={{ left: pos.left, bottom: pos.bottom }}
								className="fixed z-[100] w-56 overflow-hidden rounded-xl border border-[var(--omp-border)] bg-[var(--omp-panel-bg)] p-1 shadow-[var(--omp-shadow-md)]"
							>
								<MoreRow
									label={t("input.more.autoCompact")}
									checked={autoCompaction}
									onToggle={() =>
										toggle(
											autoCompaction,
											e => window.omp.rpc.setAutoCompaction(e),
											e => useSettingsStore.setState({ autoCompaction: e }),
										)
									}
								/>
								<MoreRow
									label={t("input.more.autoRetry")}
									checked={autoRetry}
									onToggle={() =>
										toggle(
											autoRetry,
											e => window.omp.rpc.setAutoRetry(e),
											e => useSettingsStore.setState({ autoRetry: e }),
										)
									}
								/>
								<MoreRow
									label={t("input.more.steeringAll")}
									checked={steeringMode === "all"}
									onToggle={() => {
										const next = steeringMode === "all" ? "one-at-a-time" : "all";
										useSettingsStore.setState({ steeringMode: next });
										void window.omp.rpc.setSteeringMode(next);
									}}
								/>
								<MoreRow
									label={t("input.more.interruptImmediate")}
									checked={interruptMode === "immediate"}
									onToggle={() => {
										const next = interruptMode === "immediate" ? "wait" : "immediate";
										useSettingsStore.setState({ interruptMode: next });
										void window.omp.rpc.setInterruptMode(next);
									}}
								/>
							</div>,
							document.body,
						)
					: null}
			</div>
		</>
	);
}

function MoreRow({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			onClick={onToggle}
			className="omp-pressable flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
		>
			<span className="truncate">{label}</span>
			<span
				className={cx(
					"relative h-4 w-7 shrink-0 rounded-full transition-colors",
					checked ? "bg-[var(--omp-accent)]" : "bg-[var(--omp-border-strong)]",
				)}
			>
				<span
					className={cx(
						"absolute top-0.5 h-3 w-3 rounded-full bg-white transition-[left]",
						checked ? "left-3.5" : "left-0.5",
					)}
				/>
			</span>
		</button>
	);
}
