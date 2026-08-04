/**
 * Auto-update via electron-updater.
 * Checks on launch and every 4 hours.
 */
import { BrowserWindow } from "electron";
import pkg from "electron-updater";

const { autoUpdater } = pkg;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function setupUpdater(): void {
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = true;

	// Check on launch (slight delay to let the app settle)
	setTimeout(() => {
		autoUpdater.checkForUpdates().catch(() => {
			// Silent failure — updates are optional
		});
	}, 3000);

	// Periodic check
	setInterval(() => {
		autoUpdater.checkForUpdates().catch(() => {
			// Silent failure
		});
	}, CHECK_INTERVAL_MS);

	autoUpdater.on("update-available", info => {
		// Notify all windows
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("updater:available", { version: info.version });
		}
	});

	autoUpdater.on("update-downloaded", info => {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send("updater:downloaded", { version: info.version });
		}
	});
}
