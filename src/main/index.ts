/**
 * Main process entry point for the omp GUI.
 * App lifecycle: ready → window, sidecar, session index, IPC, tray, menu, deep links, updater.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, globalShortcut, nativeImage } from "electron";
import Store from "electron-store";
import { setupDeepLinks } from "./deep-link";
import { registerIpcHandlers } from "./ipc";
import { LogWatcher } from "./log-watcher";
import { createMenu } from "./menu";
import { SessionIndex } from "./session-index";
import { SidecarManager } from "./sidecar";
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
let sidecar: SidecarManager;
let statsServer: StatsServerManager | null = null;
let sessionIndex: SessionIndex;
let statsClient: StatsClient;
let logWatcher: LogWatcher;

app.whenReady().then(() => {
	windowManager = new WindowManager();

	const initialCwd = resolveInitialCwd();
	const bundledOmp = resolveBundledOmp();
	const sourceCli = resolveSourceCli();
	sidecar = new SidecarManager({
		binaryPath: bundledOmp ?? "",
		sourceCli: sourceCli ?? undefined,
		cwd: initialCwd,
	});
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
		sidecar,
		sessionIndex,
		statsClient,
		logWatcher,
		windowManager,
	});

	// Register GUI host tools and health-check after the sidecar reports ready.
	sidecar.on("status", ({ status, message }) => {
		if (status === "ready") {
			const client = sidecar.rpcClient;
			if (!client) return;

			// Register host tools (fire-and-forget)
			void client
				.command({
					type: "set_host_tools",
					tools: [
						{
							name: "gui_open_url",
							description: "Open a URL in the system default browser",
							parameters: {
								type: "object",
								properties: { url: { type: "string", description: "URL to open" } },
								required: ["url"],
								additionalProperties: false,
							},
						},
						{
							name: "gui_notify",
							description: "Show a native OS notification",
							parameters: {
								type: "object",
								properties: {
									title: { type: "string" },
									body: { type: "string" },
								},
								required: ["title"],
								additionalProperties: false,
							},
						},
						{
							name: "gui_clipboard_read",
							description: "Read the current clipboard text content",
							parameters: {
								type: "object",
								properties: {},
								additionalProperties: false,
							},
						},
					],
				})
				.catch(() => {});

			// Health check: verify the command loop is actually running.
			// If extension init hung, the sidecar sent ready but never
			// entered the stdin reader loop, so get_state will time out.
			client
				.command({ type: "get_state" })
				.then(res => {
					if (!res.success) {
						sidecar.markUnhealthy(`Health check failed: ${res.error ?? "unknown"}`);
					}
				})
				.catch(err => {
					sidecar.markUnhealthy(`Health check timed out: ${err instanceof Error ? err.message : String(err)}`);
				});
		}
	});

	// Global shortcut: Cmd+Shift+O toggle window
	globalShortcut.register("CommandOrControl+Shift+O", () => {
		const win = windowManager.getMainWindow();
		if (!win) {
			windowManager.createWindow();
			return;
		}
		if (win.isVisible() && win.isFocused()) {
			win.hide();
		} else {
			win.show();
			win.focus();
		}
	});
	sessionIndex.start();
	logWatcher.start();
	windowManager.createWindow(initialCwd);
	sidecar.start();

	// Tray, menu, deep links, updater
	createTray(windowManager);
	createMenu(windowManager);
	setupDeepLinks(windowManager);
	setupUpdater();

	// Probe stats server (non-blocking)
	statsClient.probe().catch(() => {});
});

// macOS: re-create window on dock click
app.on("activate", () => {
	if (windowManager && windowManager.getAllWindows().length === 0) {
		windowManager.createWindow();
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
	sidecar?.dispose();
	sessionIndex?.stop();
	logWatcher?.stop();
	destroyTray();
});
