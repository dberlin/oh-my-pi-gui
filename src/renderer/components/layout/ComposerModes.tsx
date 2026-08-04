/**
 * Composer quick-access cluster: surfaces the most coding-relevant toggles
 * that were previously buried in Settings — Plan mode, Goal, model Roles, and
 * a "more" dropdown for auto-compact / auto-retry / steering / interrupt. Each
 * mirrors the exact RPC + store sync used elsewhere (Settings, palette) so the
 * state stays consistent.
 */

import { ChevronDown, Flag, ListChecks, Repeat, Users } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";

const chip = (active: boolean) =>
	cx(
		"omp-pressable flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium hover:bg-[var(--omp-selected-bg)]",
		active ? "text-[var(--omp-accent)]" : "text-[var(--omp-muted)]",
	);

export function ComposerModes() {
	const t = useT();
	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const goalActive = useSessionStore(s => s.goalState?.status === "active" || !!s.goal);
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

	const toggle = (
		get: boolean,
		set: (enabled: boolean) => Promise<unknown>,
		apply: (enabled: boolean) => void,
	) => {
		const next = !get;
		apply(next);
		void set(next);
	};

	return (
		<>
			<button type="button" onClick={togglePlan} title={t("input.plan.title")} className={chip(planModeEnabled)}>
				<ListChecks size={14} />
			</button>

			<button
				type="button"
				onClick={() => openModes("goal")}
				title={t("input.goal.title")}
				className={chip(goalActive)}
			>
				<Flag size={14} />
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
						autoCompaction === false || autoRetry === false || steeringMode !== "all" || interruptMode !== "immediate",
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
								toggle(autoCompaction, e => window.omp.rpc.setAutoCompaction(e), e => useSettingsStore.setState({ autoCompaction: e }))
							}
						/>
						<MoreRow
							label={t("input.more.autoRetry")}
							checked={autoRetry}
							onToggle={() =>
								toggle(autoRetry, e => window.omp.rpc.setAutoRetry(e), e => useSettingsStore.setState({ autoRetry: e }))
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
