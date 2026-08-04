/**
 * Main process entry point for the omp GUI.
 * App lifecycle: ready → window, sidecar, session index, IPC, tray, menu, deep links, updater.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, globalShortcut, nativeImage } from "electron";
import Store from "electron-store";
import { setupDeepLinks } from "./deep-link";
import { registerIpcHandlers } from "./ipc";
import { LogWatcher } from "./log-watcher";
import { createMenu } from "./menu";
import { SessionIndex } from "./session-index";
import { SidecarManager } from "./sidecar";
import { SidecarPool } from "./sidecar-pool";
import { StatsClient } from "./stats-client";
import { StatsServerManager } from "./stats-server";
import { createTray, destroyTray } from "./tray";
import { setupUpdater } from "./updater";
import { WindowManager } from "./window";

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
}

// App identity: the dev run shows "Electron" + the default atom icon in the
// dock otherwise. Packaged builds get both from the bundle via electron-builder.
app.setName("omp");
{
	const dockIcon = join(app.getAppPath(), "resources", "icon.png");
	if (process.platform === "darwin" && existsSync(dockIcon)) {
		app.dock?.setIcon(nativeImage.createFromPath(dockIcon));
	}
}

/**
 * Locate the GUI's built-in omp binary — the ONLY sidecar the GUI runs in the
 * closed loop. Packaged apps ship it at `process.resourcesPath/omp`; in dev it
 * lives at `packages/gui/resources/omp` (built by `bun --cwd=packages/gui run
 * build:omp`). No system-installed omp is consulted and there is no external
 * fallback: when it is missing the GUI surfaces an error telling the user to
 * build it. The workspace source sidecar is available only as an explicit dev
 * override (`OMP_SIDECAR=source`), never automatically.
 */
function resolveBundledOmp(): string | null {
	const override = process.env.OMP_BUNDLED_OMP;
	if (override && existsSync(override)) return override;
	if (process.resourcesPath) {
		const packaged = join(process.resourcesPath, "omp");
		if (existsSync(packaged)) return packaged;
	}
	for (const start of [app.getAppPath(), process.cwd()]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			const direct = join(dir, "resources", "omp");
			if (existsSync(direct)) return direct;
			const nested = join(dir, "packages", "gui", "resources", "omp");
			if (existsSync(nested)) return nested;
			const parent = join(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

/**
 * Dev-only explicit override (`OMP_SIDECAR=source`): run the workspace
 * coding-agent source CLI instead of the bundled binary. Used to exercise
 * in-repo changes without rebuilding the binary. Returns null otherwise.
 */
function resolveSourceCli(): string | null {
	if (process.env.OMP_SIDECAR !== "source") return null;
	const explicit = process.env.OMP_SIDECAR_CLI;
	if (explicit && existsSync(explicit)) return explicit;
	for (const start of [app.getAppPath(), process.cwd()]) {
		let dir = start;
		for (let i = 0; i < 8; i++) {
			const cli = join(dir, "packages", "coding-agent", "src", "cli.ts");
			if (existsSync(cli)) return cli;
			const parent = join(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

interface MainPrefs {
	lastProject?: string;
	[key: string]: unknown;
}

function resolveInitialCwd(): string {
	const explicitCwd = process.argv[2];
	if (explicitCwd && existsSync(explicitCwd)) return explicitCwd;

	const lastProject = new Store<MainPrefs>({ name: "prefs" }).get("lastProject");
	if (lastProject && existsSync(lastProject)) return lastProject;

	const launchCwd = process.cwd();
	return launchCwd !== "/" && existsSync(launchCwd) ? launchCwd : homedir();
}

// Module-level instances (alive for app lifetime)
let windowManager: WindowManager;
let sidecarPool: SidecarPool;
let statsServer: StatsServerManager | null = null;
let sessionIndex: SessionIndex;
let statsClient: StatsClient;
let logWatcher: LogWatcher;

/** Spawn a window with its own sidecar (the pool's 1:1 owner). Null at cap.
 *  Empty `cwd` falls back to resolveInitialCwd() (lastProject → launch cwd),
 *  never a bare process.cwd() which is "/" for Finder-launched apps. */
function spawnWindow(cwd?: string, pendingSessionPath?: string): BrowserWindow | null {
	const dir = cwd && cwd.length > 0 ? cwd : resolveInitialCwd();
	const win = windowManager.createWindow({ cwd: dir, pendingSessionPath });
	const sidecar = sidecarPool.acquire(dir, win);
	if (!sidecar) {
		win.close();
		return null;
	}
	return win;
}

app.whenReady().then(() => {
	windowManager = new WindowManager();

	const initialCwd = resolveInitialCwd();
	const bundledOmp = resolveBundledOmp();
	const sourceCli = resolveSourceCli();
	sidecarPool = new SidecarPool(cwd => {
		const sc = new SidecarManager({
			binaryPath: bundledOmp ?? "",
			sourceCli: sourceCli ?? undefined,
			cwd,
		});
		// Ready-health-check applies to every pooled sidecar, not just the first.
		sc.on("status", ({ status }) => {
			if (status !== "ready") return;
			const client = sc.rpcClient;
			if (!client) return;
			client
				.command({ type: "get_state" })
				.then(res => {
					if (!res.success) sc.markUnhealthy(`Health check failed: ${res.error ?? "unknown"}`);
				})
				.catch(err => {
					sc.markUnhealthy(`Health check timed out: ${err instanceof Error ? err.message : String(err)}`);
				});
		});
		return sc;
	}, 10);
	sessionIndex = new SessionIndex(undefined, initialCwd);
	statsClient = new StatsClient();
	// Built-in stats dashboard: spawned from the SAME bundled binary. No
	// external `omp stats` process is required (closed loop).
	if (bundledOmp) {
		statsServer = new StatsServerManager(bundledOmp);
		statsServer.on("ready", (port: number) => {
			statsClient.port = port;
		});
		statsServer.start();
	}
	logWatcher = new LogWatcher();

	// Register all handlers and sidecar listeners before loading the renderer.
	registerIpcHandlers({
		sidecarPool,
		sessionIndex,
		statsClient,
		logWatcher,
		windowManager,
		spawnWindow,
	});

	// Global shortcut: Cmd+Shift+O — toggle focused window, else show the most
	// recent, else spawn one (multi-window decision tree).
	globalShortcut.register("CommandOrControl+Shift+O", () => {
		const focused = BrowserWindow.getFocusedWindow();
		if (focused && !focused.isDestroyed() && windowManager.recordFor(focused)) {
			if (focused.isVisible()) focused.hide();
			else {
				focused.show();
				focused.focus();
			}
			return;
		}
		const win = windowManager.getMainWindow();
		if (win) {
			win.show();
			win.focus();
			return;
		}
		spawnWindow(initialCwd);
	});
	sessionIndex.start();
	logWatcher.start();
	spawnWindow(initialCwd);

	// Tray, menu, deep links, updater
	createTray(windowManager, spawnWindow);
	createMenu(windowManager, spawnWindow);
	setupDeepLinks(windowManager, spawnWindow);
	setupUpdater();

	// Probe stats server (non-blocking)
	statsClient.probe().catch(() => {});
});

// macOS: re-create window on dock click
app.on("activate", () => {
	if (windowManager && windowManager.getAllWindows().length === 0) {
		spawnWindow(resolveInitialCwd());
	}
});

// Quit on all windows closed (except macOS)
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") {
		app.quit();
	}
});

// Cleanup on quit
app.on("before-quit", () => {
	statsServer?.kill();
	sidecarPool?.disposeAll();
	sessionIndex?.stop();
	logWatcher?.stop();
	destroyTray();
});
