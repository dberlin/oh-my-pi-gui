import type { UpdateStatus } from "../shared/ipc-types";

export interface MacInstallerAsset {
	name: string;
	sha512: string;
	size?: number;
}

interface ReleaseFile {
	url: string;
	sha512: string;
	size?: number;
}

export type MacInstallerArchitecture = "arm64" | "x64";

/** Select only the exact DMG produced for the running Mac architecture. */
export function selectMacInstaller(
	files: readonly ReleaseFile[],
	version: string,
	architecture: MacInstallerArchitecture,
): MacInstallerAsset | undefined {
	const expectedName = architecture === "arm64" ? `omp-${version}-arm64.dmg` : `omp-${version}.dmg`;
	for (const file of files) {
		let name = file.url;
		try {
			const pathname = new URL(file.url, "https://updates.invalid").pathname;
			name = decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
		} catch {}
		if (name === expectedName) return { name: expectedName, sha512: file.sha512, size: file.size };
	}
	return undefined;
}

/**
 * A certificate-backed signature has both an authority chain and a team.
 * Ad-hoc signatures explicitly report `Signature=adhoc` and no team.
 */
export function hasStableMacSigningIdentity(codesignDetails: string): boolean {
	if (/^\s*Signature=adhoc\s*$/m.test(codesignDetails)) return false;
	if (/^\s*TeamIdentifier=not set\s*$/m.test(codesignDetails)) return false;
	return /^\s*Authority=.+$/m.test(codesignDetails) && /^\s*TeamIdentifier=(?!not set$).+$/m.test(codesignDetails);
}

/**
 * electron-updater may resolve without emitting an available/not-available
 * event (notably in unpackaged builds). Never leave the public state machine
 * stuck in `checking` after the request itself has finished.
 */
export function settleIncompleteUpdateCheck(
	status: UpdateStatus,
	manual: boolean,
	noResultMessage = "Update check completed without a result.",
): UpdateStatus {
	if (status.state !== "checking") return status;
	return manual ? { state: "error", message: noResultMessage } : { state: "idle" };
}
