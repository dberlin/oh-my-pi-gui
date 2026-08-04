/**
 * Native application menu for the omp GUI.
 */
import { app, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { IPC_EVENTS, type MenuAction } from "../shared/ipc-types";
import type { SpawnWindow, WindowManager } from "./window";

function sendMenuAction(windowManager: WindowManager, spawnWindow: SpawnWindow, action: MenuAction): void {
	const win = windowManager.getTargetWindow();
	if (win) {
		win.webContents.send(IPC_EVENTS.MENU_ACTION, { action });
		return;
	}
	// No windows open (macOS keep-running): spawn one and deliver once its
	// renderer is up, instead of dropping the action silently.
	const created = spawnWindow();
	created?.once("ready-to-show", () => {
		if (!created.isDestroyed()) created.webContents.send(IPC_EVENTS.MENU_ACTION, { action });
	});
}

export function createMenu(windowManager: WindowManager, spawnWindow: SpawnWindow): void {
	const template: MenuItemConstructorOptions[] = [
		...(process.platform === "darwin"
			? [
					{
						label: app.name,
						submenu: [
							{ role: "about" as const },
							{
								label: "Settings…",
								accelerator: "CmdOrCtrl+,",
								click: () => sendMenuAction(windowManager, spawnWindow, "open-settings"),
							},
							{ type: "separator" as const },
							{ role: "services" as const },
							{ type: "separator" as const },
							{ role: "hide" as const },
							{ role: "hideOthers" as const },
							{ role: "unhide" as const },
							{ type: "separator" as const },
							{ role: "quit" as const },
						],
					},
				]
			: []),
		{
			label: "File",
			submenu: [
				{
					label: "Open Project…",
					// No accelerator: ⌘⇧O is owned by the globalShortcut window
					// toggle (index.ts). Registering it here too makes macOS fire
					// both (dialog + hide) and Windows swallow the menu shortcut
					// entirely. The menu item stays clickable.
					click: () => sendMenuAction(windowManager, spawnWindow, "open-project"),
				},
				{ type: "separator" },
				{
					label: "New Session",
					accelerator: "CmdOrCtrl+N",
					click: () => sendMenuAction(windowManager, spawnWindow, "new-session"),
				},
				{
					label: "New Window",
					accelerator: "CmdOrCtrl+Shift+N",
					click: () => {
						// Open a parallel window in the target window's project (its
						// sidecar keeps running untouched in the current window).
						const cwd = windowManager.getTargetWindow()
							? (windowManager.recordFor(windowManager.getTargetWindow()!)?.cwd ?? process.cwd())
							: process.cwd();
						spawnWindow(cwd);
					},
				},
				...(process.platform === "darwin"
					? []
					: [
							{ type: "separator" as const },
							{
								label: "Settings…",
								accelerator: "CmdOrCtrl+,",
								click: () => sendMenuAction(windowManager, spawnWindow, "open-settings"),
							},
						]),
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "View",
			submenu: [
				{
					label: "Toggle Sidebar",
					accelerator: "CmdOrCtrl+B",
					click: () => sendMenuAction(windowManager, spawnWindow, "toggle-sidebar"),
				},
				{
					label: "Toggle Panel",
					accelerator: "CmdOrCtrl+J",
					click: () => sendMenuAction(windowManager, spawnWindow, "toggle-panel"),
				},
				{ type: "separator" },
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "Session",
			submenu: [
				{
					label: "Export HTML",
					accelerator: "CmdOrCtrl+E",
					click: () => sendMenuAction(windowManager, spawnWindow, "export-html"),
				},
				{
					label: "Handoff",
					click: () => sendMenuAction(windowManager, spawnWindow, "handoff"),
				},
			],
		},
		{
			label: "Help",
			submenu: [
				{
					label: "About omp",
					click: () => app.showAboutPanel(),
				},
				{
					label: "Documentation",
					click: () => void shell.openExternal("https://github.com/can1357/oh-my-pi"),
				},
			],
		},
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
