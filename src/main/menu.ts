/**
 * Native application menu for the omp GUI.
 */
import { app, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { IPC_EVENTS, type MenuAction } from "../shared/ipc-types";
import type { WindowManager } from "./window";

function sendMenuAction(windowManager: WindowManager, action: MenuAction): void {
	windowManager.getTargetWindow()?.webContents.send(IPC_EVENTS.MENU_ACTION, { action });
}

export function createMenu(windowManager: WindowManager): void {
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
								click: () => sendMenuAction(windowManager, "open-settings"),
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
					// Shift-modified so the renderer's ⌃O (expand/collapse all tool
					// cards) stays reachable on Win/Linux, where the native menu
					// accelerator shadows the in-app shortcut.
					accelerator: "CmdOrCtrl+Shift+O",
					click: () => sendMenuAction(windowManager, "open-project"),
				},
				{ type: "separator" },
				{
					label: "New Session",
					accelerator: "CmdOrCtrl+N",
					click: () => sendMenuAction(windowManager, "new-session"),
				},
				{
					label: "New Window",
					accelerator: "CmdOrCtrl+Shift+N",
					click: () => windowManager.createWindow(),
				},
				...(process.platform === "darwin"
					? []
					: [
							{ type: "separator" as const },
							{
								label: "Settings…",
								accelerator: "CmdOrCtrl+,",
								click: () => sendMenuAction(windowManager, "open-settings"),
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
					click: () => sendMenuAction(windowManager, "toggle-sidebar"),
				},
				{
					label: "Toggle Panel",
					accelerator: "CmdOrCtrl+J",
					click: () => sendMenuAction(windowManager, "toggle-panel"),
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
					click: () => sendMenuAction(windowManager, "export-html"),
				},
				{
					label: "Handoff",
					click: () => sendMenuAction(windowManager, "handoff"),
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
