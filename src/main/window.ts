/**
 * Multi-window management for the omp GUI.
 * Creates sandboxed BrowserWindows with persisted state via electron-store.
 */

import { join } from "node:path";
import { app, BrowserWindow, shell } from "electron";
import Store from "electron-store";
import type { RunProgressState } from "../shared/ipc-types";

interface WindowState {
	x?: number;
	y?: number;
	width: number;
	height: number;
	isMaximized?: boolean;
}

interface StoreSchema {
	windowState: WindowState;
	[key: string]: unknown;
}

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

export class WindowManager {
	#windows = new Set<BrowserWindow>();
	#store: Store<StoreSchema>;

	constructor() {
		this.#store = new Store<StoreSchema>({ name: "window-state" });
	}

	createWindow(_cwd?: string): BrowserWindow {
		const saved = this.#store.get("windowState", {
			width: DEFAULT_WIDTH,
			height: DEFAULT_HEIGHT,
		});

		const win = new BrowserWindow({
			x: saved.x,
			y: saved.y,
			width: saved.width,
			height: saved.height,
			minWidth: MIN_WIDTH,
			minHeight: MIN_HEIGHT,
			show: false,
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				preload: join(__dirname, "../preload/index.cjs"),
			},
		});

		if (saved.isMaximized) {
			win.maximize();
		}

		// Load renderer
		if (process.env.ELECTRON_RENDERER_URL) {
			win.loadURL(process.env.ELECTRON_RENDERER_URL);
		} else {
			win.loadFile(join(__dirname, "../renderer/index.html"));
		}

		win.once("ready-to-show", () => {
			win.show();
		});

		// Open external links in browser
		win.webContents.setWindowOpenHandler(({ url }) => {
			shell.openExternal(url);
			return { action: "deny" };
		});

		// Persist state on close
		win.on("close", () => {
			this.#persistState(win);
		});

		win.on("closed", () => {
			this.#windows.delete(win);
		});

		this.#windows.add(win);
		return win;
	}

	getMainWindow(): BrowserWindow | null {
		for (const win of this.#windows) {
			if (!win.isDestroyed()) return win;
		}
		return null;
	}

	/**
	 * Window that should receive user-initiated actions (menu/tray): the
	 * focused window when it's one of ours, else the first live window.
	 */
	getTargetWindow(): BrowserWindow | null {
		const focused = BrowserWindow.getFocusedWindow();
		if (focused && !focused.isDestroyed() && this.#windows.has(focused)) return focused;
		return this.getMainWindow();
	}

	getAllWindows(): BrowserWindow[] {
		return [...this.#windows].filter(w => !w.isDestroyed());
	}

	/**
	 * Run-progress indicator (agent `terminal.showProgress` setting): dock
	 * badge (● working, ! waiting — macOS only) plus a progress bar on every
	 * window. macOS has no true indeterminate progress mode, so fixed
	 * fractions act as state markers; "idle" clears both (-1 / empty badge).
	 */
	setRunProgress(state: RunProgressState): void {
		app.dock?.setBadge(state === "working" ? "●" : state === "waiting" ? "!" : "");
		const progress = state === "working" ? 0.5 : state === "waiting" ? 0.75 : -1;
		for (const win of this.getAllWindows()) {
			win.setProgressBar(progress);
		}
	}

	#persistState(win: BrowserWindow): void {
		if (win.isDestroyed()) return;
		const bounds = win.getBounds();
		this.#store.set("windowState", {
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			isMaximized: win.isMaximized(),
		});
	}
}
