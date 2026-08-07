import type { RenderProcessGoneDetails } from "electron";

export const RENDERER_RECOVERY_COOLDOWN_MS = 30_000;

/** Reload real crashes, but never turn a boot crash into a tight reload loop. */
export function shouldReloadRenderer(
	reason: RenderProcessGoneDetails["reason"],
	lastRecoveryAt: number,
	now: number,
): boolean {
	return reason !== "clean-exit" && now - lastRecoveryAt >= RENDERER_RECOVERY_COOLDOWN_MS;
}
