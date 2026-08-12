/**
 * Auto-update via electron-updater (GitHub Releases at nornzach/oh-my-pi-gui).
 *
 * Flow: check (launch + every 4h + manual) → `available` with version/notes →
 * user starts the download (`autoDownload: false`, metered-connection safe) →
 * progress events → `downloaded` → user restarts → quitAndInstall swaps the
 * app. Differential downloads ride the release blockmaps; latest-mac.yml is
 * published with every release. A true no-restart hot swap is impossible on
 * macOS (the .app, sidecar binary, and native addon all change per release),
 * so the contract is: updates are discovered and staged in the background,
 * installed on a one-click restart.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import pkg from "electron-updater";
import type { UpdateStatus } from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../shared/ipc-types";
import { mainT } from "./i18n";
import { settleIncompleteUpdateCheck } from "./updater-state";

const { autoUpdater } = pkg;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * App version for the updates row. `app.getVersion()` reads the HOST
 * package.json — the Electron binary's own when unpacked (dev shows
 * "36.9.5"), so dev resolves the project's package.json from the bundle
 * location instead. Packaged builds keep app.getVersion().
 */
function appVersion(): string {
	if (app.isPackaged) return app.getVersion();
	try {
		// out/main/index.js → ../../package.json (dev bundle layout).
		const raw = fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") {
			return parsed.version;
		}
	} catch {}
	return app.getVersion();
}

/** Current status, replayed to any window that asks (renderer boot/refresh). */
let current: UpdateStatus = { state: "idle" };

function broadcast(status: UpdateStatus): void {
	current = status;
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send(IPC_EVENTS.UPDATER_STATUS, status);
	}
}

/** Release-notes excerpt for the banner; updater carries HTML/markdown-ish notes. */
function notesOf(info: { releaseNotes?: unknown }): string | undefined {
	const notes = info.releaseNotes;
	if (typeof notes === "string") return notes.slice(0, 500);
	if (Array.isArray(notes)) {
		const first = notes[0] as { note?: string } | undefined;
		return first?.note?.slice(0, 500);
	}
	return undefined;
}

export function setupUpdater(): void {
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;
	// Dev/preview verification gate: electron-updater skips unpackaged apps
	// unless forced. Set OMP_DEV_UPDATE_CHECK=1 to exercise the real feed
	// (check → banner → download) from `electron-vite preview`.
	if (process.env.OMP_DEV_UPDATE_CHECK === "1") autoUpdater.forceDevUpdateConfig = true;

	autoUpdater.on("checking-for-update", () => broadcast({ state: "checking" }));
	autoUpdater.on("update-available", info => {
		broadcast({ state: "available", version: info.version, notes: notesOf(info) });
	});
	autoUpdater.on("update-not-available", () => broadcast({ state: "not-available", version: app.getVersion() }));
	autoUpdater.on("download-progress", progress => {
		broadcast({
			state: "downloading",
			percent: Math.round(progress.percent),
			bytesPerSecond: progress.bytesPerSecond,
			transferred: progress.transferred,
			total: progress.total,
		});
	});
	autoUpdater.on("update-downloaded", info => broadcast({ state: "downloaded", version: info.version }));
	autoUpdater.on("error", error => {
		// Silent on the wire but visible when the user explicitly asked — the
		// banner only renders error state after a manual check/download.
		broadcast({ state: "error", message: error.message });
	});

	ipcMain.handle(IPC_COMMANDS.UPDATER_CHECK, async () => {
		broadcast({ state: "checking" });
		try {
			await autoUpdater.checkForUpdates();
			const settled = settleIncompleteUpdateCheck(current, true, mainT("updates.noResult"));
			if (settled !== current) broadcast(settled);
		} catch (error) {
			broadcast({ state: "error", message: error instanceof Error ? error.message : String(error) });
		}
		return current;
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_DOWNLOAD, async () => {
		try {
			await autoUpdater.downloadUpdate();
		} catch (error) {
			broadcast({ state: "error", message: error instanceof Error ? error.message : String(error) });
		}
		return current;
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_INSTALL, () => {
		autoUpdater.quitAndInstall();
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_GET_STATUS, () => current);
	ipcMain.handle(IPC_COMMANDS.UPDATER_VERSION, () => appVersion());

	// First check once the app settles; then every 4h.
	setTimeout(() => {
		autoUpdater
			.checkForUpdates()
			.then(() => {
				const settled = settleIncompleteUpdateCheck(current, false);
				if (settled !== current) broadcast(settled);
			})
			.catch(() => broadcast({ state: "idle" }));
	}, 3000);
	setInterval(() => {
		autoUpdater
			.checkForUpdates()
			.then(() => {
				const settled = settleIncompleteUpdateCheck(current, false);
				if (settled !== current) broadcast(settled);
			})
			.catch(() => {});
	}, CHECK_INTERVAL_MS);
}
