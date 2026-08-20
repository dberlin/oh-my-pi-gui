/**
 * GitHub release updates with two macOS installation paths:
 *
 * - certificate-signed builds keep electron-updater/Squirrel's staged ZIP
 *   replacement flow;
 * - ad-hoc-signed builds download the architecture-matched DMG, verify its
 *   release-metadata SHA-512, and hand replacement to Finder.
 *
 * Downloads remain user-initiated and report progress through one shared
 * renderer state machine.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain, net, shell } from "electron";
import type { UpdateInfo } from "electron-updater";
import pkg from "electron-updater";
import type { UpdateInstallMode, UpdateStatus } from "../shared/ipc-types";
import { IPC_COMMANDS, IPC_EVENTS } from "../shared/ipc-types";
import { mainT } from "./i18n";
import {
	hasStableMacSigningIdentity,
	type MacInstallerArchitecture,
	type MacInstallerAsset,
	selectMacInstaller,
	settleIncompleteUpdateCheck,
} from "./updater-state";

const { autoUpdater } = pkg;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const RELEASE_DOWNLOAD_BASE = "https://github.com/nornzach/oh-my-pi-gui/releases/download/";
const PROGRESS_INTERVAL_MS = 100;

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
let installMode: UpdateInstallMode = "automatic";
let activeUpdate: UpdateInfo | undefined;
let manualInstaller: MacInstallerAsset | undefined;
let downloadedInstallerPath: string | undefined;

function detectInstallMode(): UpdateInstallMode {
	if (process.platform !== "darwin") return "automatic";

	// Test seam for unpackaged preview builds; never overrides a release bundle.
	if (!app.isPackaged) {
		const override = process.env.OMP_DEV_UPDATE_MODE;
		if (override === "automatic" || override === "manual") return override;
	}

	const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", process.execPath], {
		encoding: "utf8",
	});
	if (result.status !== 0) return "manual";
	return hasStableMacSigningIdentity(`${result.stdout}${result.stderr}`) ? "automatic" : "manual";
}

function availableDownloadPath(fileName: string): string {
	const downloadsDirectory = app.getPath("downloads");
	const extension = path.extname(fileName);
	const stem = path.basename(fileName, extension);
	let candidate = path.join(downloadsDirectory, fileName);
	for (let suffix = 2; fs.existsSync(candidate); suffix += 1) {
		candidate = path.join(downloadsDirectory, `${stem} (${suffix})${extension}`);
	}
	return candidate;
}

async function openManualInstaller(filePath: string): Promise<void> {
	shell.showItemInFolder(filePath);
	const openError = await shell.openPath(filePath);
	if (openError) throw new Error(mainT("updates.openInstallerFailed"));
}

async function downloadManualInstaller(version: string, asset: MacInstallerAsset): Promise<void> {
	const destinationPath = availableDownloadPath(asset.name);
	const partialPath = `${destinationPath}.download-${process.pid}`;
	const assetUrl = `${RELEASE_DOWNLOAD_BASE}v${encodeURIComponent(version)}/${encodeURIComponent(asset.name)}`;
	const response = await net.fetch(assetUrl);
	if (!response.ok || !response.body) {
		throw new Error(`${mainT("updates.downloadFailed")} (${response.status})`);
	}

	const contentLength = Number(response.headers.get("content-length"));
	const total = asset.size ?? (Number.isFinite(contentLength) ? contentLength : 0);
	const hash = createHash("sha512");
	const startedAt = performance.now();
	let transferred = 0;
	let lastProgressAt = 0;
	const file = await fs.promises.open(partialPath, "wx");

	try {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			hash.update(value);
			let offset = 0;
			while (offset < value.byteLength) {
				const { bytesWritten } = await file.write(value, offset, value.byteLength - offset);
				offset += bytesWritten;
			}
			transferred += value.byteLength;
			const now = performance.now();
			if (now - lastProgressAt >= PROGRESS_INTERVAL_MS || (total > 0 && transferred === total)) {
				const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
				broadcast({
					state: "downloading",
					version,
					mode: "manual",
					percent: total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0,
					bytesPerSecond: Math.round(transferred / elapsedSeconds),
					transferred,
					total,
				});
				lastProgressAt = now;
			}
		}
		await file.sync();
	} catch (error) {
		await fs.promises.rm(partialPath, { force: true });
		throw error;
	} finally {
		await file.close();
	}

	if (hash.digest("base64") !== asset.sha512) {
		await fs.promises.rm(partialPath, { force: true });
		throw new Error(mainT("updates.hashMismatch"));
	}

	await fs.promises.rename(partialPath, destinationPath);
	downloadedInstallerPath = destinationPath;
	await openManualInstaller(destinationPath);
	broadcast({ state: "downloaded", version, mode: "manual" });
}

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
	installMode = detectInstallMode();
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = installMode === "automatic";
	// Dev/preview verification gate: electron-updater skips unpackaged apps
	// unless forced. Pair with OMP_DEV_UPDATE_MODE=manual to exercise the DMG path.
	if (process.env.OMP_DEV_UPDATE_CHECK === "1") autoUpdater.forceDevUpdateConfig = true;

	autoUpdater.on("checking-for-update", () => broadcast({ state: "checking" }));
	autoUpdater.on("update-available", info => {
		activeUpdate = info;
		manualInstaller = undefined;
		downloadedInstallerPath = undefined;
		if (installMode === "manual") {
			const architecture: MacInstallerArchitecture | undefined =
				process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
			if (!architecture) {
				broadcast({ state: "error", message: mainT("updates.unsupportedArchitecture") });
				return;
			}
			manualInstaller = selectMacInstaller(info.files, info.version, architecture);
			if (!manualInstaller) {
				broadcast({ state: "error", message: mainT("updates.installerMissing") });
				return;
			}
		}
		broadcast({ state: "available", version: info.version, notes: notesOf(info), mode: installMode });
	});
	autoUpdater.on("update-not-available", () => broadcast({ state: "not-available", version: appVersion() }));
	autoUpdater.on("download-progress", progress => {
		if (installMode !== "automatic") return;
		broadcast({
			state: "downloading",
			version: activeUpdate?.version ?? appVersion(),
			mode: "automatic",
			percent: Math.round(progress.percent),
			bytesPerSecond: progress.bytesPerSecond,
			transferred: progress.transferred,
			total: progress.total,
		});
	});
	autoUpdater.on("update-downloaded", info =>
		broadcast({ state: "downloaded", version: info.version, mode: "automatic" }),
	);
	autoUpdater.on("error", error => {
		// Passive poll failures remain unobtrusive. Explicit IPC actions catch
		// and rebroadcast the same failure as user-visible.
		broadcast({ state: "error", message: error.message, showInBanner: false });
	});

	ipcMain.handle(IPC_COMMANDS.UPDATER_CHECK, async () => {
		broadcast({ state: "checking" });
		try {
			await autoUpdater.checkForUpdates();
			const settled = settleIncompleteUpdateCheck(current, true, mainT("updates.noResult"));
			if (settled !== current) broadcast(settled);
		} catch (error) {
			broadcast({
				state: "error",
				message: error instanceof Error ? error.message : String(error),
				showInBanner: true,
			});
		}
		return current;
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_DOWNLOAD, async () => {
		if (current.state !== "available") return current;
		try {
			if (current.mode === "manual") {
				if (!manualInstaller) throw new Error(mainT("updates.installerMissing"));
				broadcast({
					state: "downloading",
					version: current.version,
					mode: "manual",
					percent: 0,
					bytesPerSecond: 0,
					transferred: 0,
					total: manualInstaller.size ?? 0,
				});
				await downloadManualInstaller(activeUpdate?.version ?? current.version, manualInstaller);
			} else {
				await autoUpdater.downloadUpdate();
			}
		} catch (error) {
			broadcast({
				state: "error",
				message: error instanceof Error ? error.message : String(error),
				showInBanner: true,
			});
		}
		return current;
	});
	ipcMain.handle(IPC_COMMANDS.UPDATER_APPLY, async () => {
		if (current.state !== "downloaded") return;
		if (current.mode === "manual") {
			if (!downloadedInstallerPath) {
				broadcast({ state: "error", message: mainT("updates.installerMissing"), showInBanner: true });
				return;
			}
			try {
				await openManualInstaller(downloadedInstallerPath);
			} catch (error) {
				broadcast({
					state: "error",
					message: error instanceof Error ? error.message : String(error),
					showInBanner: true,
				});
			}
			return;
		}
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
