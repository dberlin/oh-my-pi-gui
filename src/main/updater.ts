/**
 * This fork cannot install nornzach GUI releases. Keep version/status IPC
 * explicit, but never load the upstream release checker or schedule a poll.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { app, ipcMain } from "electron";
import type { UpdateStatus } from "../shared/ipc-types";
import { IPC_COMMANDS } from "../shared/ipc-types";
import { mainT } from "./i18n";

/**
 * App version for the updates row. `app.getVersion()` reads the HOST
 * package.json — the Electron binary's own when unpacked (dev shows
 * "36.9.5"), so dev resolves the project's package.json from the bundle
 * location instead. Packaged builds keep app.getVersion().
 */
export function appVersion(): string {
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

/** GUI update actions are unavailable; vanilla agent updates are independent. */
export function setupUpdater(): void {
	const disabledStatus = (): UpdateStatus => ({ state: "disabled", version: appVersion() });
	ipcMain.handle(IPC_COMMANDS.UPDATER_CHECK, disabledStatus);
	ipcMain.handle(IPC_COMMANDS.UPDATER_DOWNLOAD, disabledStatus);
	ipcMain.handle(IPC_COMMANDS.UPDATER_APPLY, () => {
		throw new Error(mainT("updates.disabled"));
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_GET_STATUS, disabledStatus);
	ipcMain.handle(IPC_COMMANDS.UPDATER_VERSION, () => appVersion());
}
