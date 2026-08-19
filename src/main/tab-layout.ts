import * as fs from "node:fs";
import type { IpcTabWorktree, SessionKind } from "../shared/ipc-types";

export const TAB_LAYOUT_VERSION = 1;
export const MAX_PERSISTED_TABS = 10;

export interface PersistedTabDescriptor {
	cwd: string;
	sessionPath?: string;
	kind: SessionKind;
	worktree?: IpcTabWorktree;
	/** Untargeted startup tab, disposable once another real tab exists. */
	placeholder?: boolean;
}

export interface PersistedTabLayout {
	version: typeof TAB_LAYOUT_VERSION;
	tabs: PersistedTabDescriptor[];
	activeIndex: number;
}

export interface TabLayoutPathChecks {
	directoryExists(path: string): boolean;
	fileExists(path: string): boolean;
	/** Conservative content probe used only to migrate pre-placeholder layouts. */
	sessionHasContent?(path: string): boolean;
}

const diskPathChecks: TabLayoutPathChecks = {
	directoryExists(path) {
		try {
			return fs.statSync(path).isDirectory();
		} catch {
			return false;
		}
	},
	fileExists(path) {
		try {
			return fs.statSync(path).isFile();
		} catch {
			return false;
		}
	},
	sessionHasContent(path) {
		try {
			const file = fs.statSync(path);
			// Empty sessions are small. Treat a large transcript as contentful
			// without loading it into the main process during startup.
			if (file.size > 128 * 1024) return true;
			for (const line of fs.readFileSync(path, "utf8").split("\n")) {
				if (!line.trim()) continue;
				try {
					if ((JSON.parse(line) as { type?: unknown }).type === "message") return true;
				} catch {
					// A malformed line is not evidence that the transcript is empty.
					return true;
				}
			}
			return false;
		} catch {
			return true;
		}
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseKind(value: unknown): SessionKind | null {
	return value === "agent" || value === "chat" ? value : null;
}

function parseWorktree(value: unknown): IpcTabWorktree | undefined {
	if (!isRecord(value)) return undefined;
	const name = nonEmptyString(value.name);
	const branch = nonEmptyString(value.branch);
	const baseCwd = nonEmptyString(value.baseCwd);
	return name && branch && baseCwd ? { name, branch, baseCwd } : undefined;
}

/**
 * Validate the tab snapshot loaded from electron-store before it reaches a
 * sidecar. Missing workspaces are dropped; a deleted transcript becomes a
 * fresh tab at the same cwd instead of making the whole startup fail.
 */
export function sanitizePersistedTabLayout(
	value: unknown,
	paths: TabLayoutPathChecks = diskPathChecks,
): PersistedTabLayout | null {
	if (!isRecord(value) || value.version !== TAB_LAYOUT_VERSION || !Array.isArray(value.tabs)) return null;
	const requestedActiveIndex =
		typeof value.activeIndex === "number" && Number.isInteger(value.activeIndex) && value.activeIndex >= 0
			? value.activeIndex
			: 0;
	const retained: Array<{ descriptor: PersistedTabDescriptor; sourceIndex: number }> = [];
	const sessionPaths = new Set<string>();

	for (const [sourceIndex, candidate] of value.tabs.entries()) {
		if (retained.length >= MAX_PERSISTED_TABS) break;
		if (!isRecord(candidate)) continue;
		const cwd = nonEmptyString(candidate.cwd);
		const kind = parseKind(candidate.kind);
		if (!cwd || !kind || !paths.directoryExists(cwd)) continue;

		const storedSessionPath = nonEmptyString(candidate.sessionPath);
		const sessionPath = storedSessionPath && paths.fileExists(storedSessionPath) ? storedSessionPath : undefined;
		if (sessionPath && sessionPaths.has(sessionPath)) continue;
		if (sessionPath) sessionPaths.add(sessionPath);

		const descriptor: PersistedTabDescriptor = { cwd, kind };
		if (sessionPath) descriptor.sessionPath = sessionPath;
		const worktree = parseWorktree(candidate.worktree);
		if (worktree) descriptor.worktree = worktree;
		const legacyEmptyStartupChat =
			candidate.placeholder === undefined &&
			sourceIndex === 0 &&
			kind === "chat" &&
			(!sessionPath || paths.sessionHasContent?.(sessionPath) === false);
		if (candidate.placeholder === true || legacyEmptyStartupChat) descriptor.placeholder = true;
		retained.push({ descriptor, sourceIndex });
	}

	// Startup placeholders are disposable. Never restore the legacy tool-free
	// chat after Work mode became the default full-agent surface.
	const effective = retained.filter(entry => entry.descriptor.placeholder !== true);
	if (effective.length === 0) return null;
	let activeIndex = effective.findIndex(entry => entry.sourceIndex === requestedActiveIndex);
	if (activeIndex < 0) activeIndex = effective.findIndex(entry => entry.sourceIndex > requestedActiveIndex);
	if (activeIndex < 0) activeIndex = effective.length - 1;

	return {
		version: TAB_LAYOUT_VERSION,
		tabs: effective.map(entry => entry.descriptor),
		activeIndex,
	};
}
