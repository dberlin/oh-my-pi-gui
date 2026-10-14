/**
 * Composer effort picker. Levels come from get_available_thinking_levels;
 * get_state supplies the effective selection after the sidecar clamps it.
 * The portal follows the existing ApprovalControl pattern.
 */

import { Brain, Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { THINKING_LEVEL_VALUES, type RpcSessionState, type ThinkingLevel } from "../../../shared/rpc-types";
import { useOverlayPresence } from "../../hooks/use-overlay-presence";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useTabRpc } from "../../lib/tab-rpc";
import { type ModelStore, useModelStore } from "../../stores/model";
import { type SessionStore, useSessionStore } from "../../stores/session";
import { sessionRuntime, sessionRuntimeStore, useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";

export function ThinkingControl() {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const modelStore = sessionRuntimeStore<ModelStore>(tabId, "model");
	const thinkingLevel = useModelStore(s => s.thinkingLevel);
	const available = useModelStore(s => s.availableThinkingLevels);
	const [open, setOpen] = useState(false);
	const { mounted, closing } = useOverlayPresence(open);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

	const current = thinkingLevel ?? "off";
	const supportsThinking = available.length > 0;

	// Position the portal menu above the trigger whenever it opens.
	useLayoutEffect(() => {
		if (!open || !triggerRef.current) return;
		const rect = triggerRef.current.getBoundingClientRect();
		setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
	}, [open]);

	// Close on outside pointer press, and consume Escape: an open dropdown must
	// swallow the key (with focus restored to the trigger) instead of letting
	// the global handler abort a running turn.
	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKey = (event: KeyboardEvent) => {
			if (isImeKeyEvent(event)) return;
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		requestAnimationFrame(() => {
			menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')?.focus();
		});
	}, [open]);

	const moveMenuFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
		const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
		if (items.length === 0) return;
		event.preventDefault();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			event.key === "Home"
				? 0
				: event.key === "End"
					? items.length - 1
					: (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
		items[next]?.focus();
	};

	const select = (level: ThinkingLevel) => {
		setOpen(false);
		const originRuntime = sessionRuntime(tabId);
		const generation = originRuntime?.commandGeneration;
		const sessionStore = sessionRuntimeStore<SessionStore>(tabId, "session") ?? useSessionStore;
		const sessionId = sessionStore.getState().sessionId;
		const fallbackTabId = useTabsStore.getState().activeTabId;
		const isCurrent = () =>
			sessionStore.getState().sessionId === sessionId &&
			(originRuntime
				? sessionRuntime(tabId) === originRuntime && originRuntime.commandGeneration === generation
				: useTabsStore.getState().activeTabId === fallbackTabId);
		void (async () => {
			const receipt = await rpc.setThinkingLevel(level);
			if (!isCurrent()) return;
			if (!receipt.success) {
				toast({ variant: "error", title: t("input.thinking.failed"), message: receipt.error });
				return;
			}
			// Vanilla acknowledges without data. Read back the effective/clamped
			// level through the same tab channel; never infer it from the request.
			const response = await rpc.getState();
			if (!isCurrent()) return;
			if (!response.success) {
				toast({ variant: "error", title: t("input.thinking.failed"), message: response.error });
				return;
			}
			if (response.data == null) return;
			const state = response.data as RpcSessionState;
			if (state.sessionId && sessionId && state.sessionId !== sessionId) return;
			(modelStore ?? useModelStore).setState({ thinkingLevel: state.thinkingLevel });
		})().catch(error => {
			if (isCurrent()) {
				toast({ variant: "error", title: t("input.thinking.failed"), message: String(error) });
			}
		});
	};

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen(value => !value)}
				title={t("input.thinking", { level: t(`input.thinking.name.${current}`) })}
				className="omp-pressable flex h-8 items-center gap-1.5 rounded-lg px-2 text-omp-md font-medium hover:bg-[var(--omp-selected-bg)]"
				style={{ color: `var(--omp-thinking-${thinkingLevel ?? "off"})` }}
			>
				<Brain size={14} />
				<span className="omp-composer-control-label hidden sm:inline">{t(`input.thinking.name.${current}`)}</span>
				<ChevronDown size={12} className="shrink-0 text-[var(--omp-dim)]" />
			</button>

			{mounted && pos
				? createPortal(
						<div
							ref={menuRef}
							style={{ left: pos.left, bottom: pos.bottom }}
							aria-hidden={closing || undefined}
							role="menu"
							onKeyDown={moveMenuFocus}
							inert={closing}
							className={cx(
								"fixed z-[100] w-64 overflow-hidden rounded-xl border border-[var(--omp-border)] bg-[var(--omp-panel-bg)] p-1 shadow-[var(--omp-shadow-md)]",
								closing ? "omp-scale-out pointer-events-none" : "omp-pop-in",
							)}
						>
							{supportsThinking ? (
								THINKING_LEVEL_VALUES.filter(level => available.includes(level)).map(option => {
									const active = option === current;
									return (
										<button
											key={option}
											type="button"
											role="menuitemradio"
											aria-checked={active}
											onClick={() => select(option)}
											className="omp-pressable flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--omp-selected-bg)]"
										>
											<span className="mt-0.5 w-4 shrink-0 text-[var(--omp-accent)]">
												{active ? <Check size={14} /> : null}
											</span>
											<span className="min-w-0 flex-1">
												<span
													className={cx(
														"block font-mono text-omp-md font-medium",
														!active && "text-[var(--omp-muted)]",
													)}
													style={{ color: `var(--omp-thinking-${option})` }}
												>
													{t(`input.thinking.name.${option}`)}
												</span>
												<span className="block text-omp-sm leading-snug text-[var(--omp-dim)]">
													{t(`input.thinking.level.${option}`)}
												</span>
											</span>
										</button>
									);
								})
							) : (
								<div className="px-2.5 py-2 text-omp-md text-[var(--omp-muted)]">
									{t("input.thinking.unsupported")}
								</div>
							)}
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
