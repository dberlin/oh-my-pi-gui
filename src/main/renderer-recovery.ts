import type { RenderProcessGoneDetails } from "electron";

export const RENDERER_RECOVERY_COOLDOWN_MS = 30_000;

export interface ApplicationResourceIdentity {
	device: number;
	inode: number;
	size: number;
	modifiedAt: number;
}

/**
 * A packaged app must never reload renderer files through an archive that was
 * replaced after launch. Electron can otherwise combine the old ASAR index
 * with bytes from the new archive and serve an asset chunk as index.html.
 */
export function applicationResourcesChanged(
	launchIdentity: ApplicationResourceIdentity | null,
	currentIdentity: ApplicationResourceIdentity | null,
): boolean {
	if (launchIdentity === null) return false;
	if (currentIdentity === null) return true;
	return (
		launchIdentity.device !== currentIdentity.device ||
		launchIdentity.inode !== currentIdentity.inode ||
		launchIdentity.size !== currentIdentity.size ||
		launchIdentity.modifiedAt !== currentIdentity.modifiedAt
	);
}

/** Reload real crashes, but never turn a boot crash into a tight reload loop. */
export function shouldReloadRenderer(
	reason: RenderProcessGoneDetails["reason"],
	lastRecoveryAt: number,
	now: number,
): boolean {
	return reason !== "clean-exit" && now - lastRecoveryAt >= RENDERER_RECOVERY_COOLDOWN_MS;
}
