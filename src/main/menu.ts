/**
 * Native application menu for the omp GUI.
 */
import { app, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { IPC_EVENTS, type MenuAction } from "../shared/ipc-types";
import { getMainLanguage, mainT } from "./i18n";
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
	const language = getMainLanguage();
	const template: MenuItemConstructorOptions[] = [
		...(process.platform === "darwin"
			? [
					{
						label: app.name,
						submenu: [
							{ role: "about" as const },
							{
								label: mainT("menu.settings", language),
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
			label: mainT("menu.file", language),
			submenu: [
				{
					label: mainT("menu.openProject", language),
					// No accelerator: ⌘⇧O is owned by the globalShortcut window
					// toggle (index.ts). Registering it here too makes macOS fire
					// both (dialog + hide) and Windows swallow the menu shortcut
					// entirely. The menu item stays clickable.
					click: () => sendMenuAction(windowManager, spawnWindow, "open-project"),
				},
				{ type: "separator" },
				{
					label: mainT("menu.newSession", language),
					accelerator: "CmdOrCtrl+N",
					click: () => sendMenuAction(windowManager, spawnWindow, "new-session"),
				},
				{
					// No accelerator: ⌘T/⇧⌘T live in the renderer keymap so users can
					// remap them. A menu accelerator would fire first and make the
					// remappable chords dead (precedent: ⌘⇧O above).
					label: mainT("menu.newTab", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "new-tab"),
				},
				{
					label: mainT("menu.newChatTab", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "new-chat-tab"),
				},
				{
					label: mainT("menu.newWindow", language),
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
								label: mainT("menu.settings", language),
								accelerator: "CmdOrCtrl+,",
								click: () => sendMenuAction(windowManager, spawnWindow, "open-settings"),
							},
						]),
				{ type: "separator" },
				{
					label: mainT("menu.closeTab", language),
					accelerator: "CmdOrCtrl+W",
					click: () => sendMenuAction(windowManager, spawnWindow, "close-tab"),
				},
			],
		},
		{
			label: mainT("menu.edit", language),
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
			label: mainT("menu.view", language),
			submenu: [
				{
					label: mainT("menu.toggleSidebar", language),
					accelerator: "CmdOrCtrl+B",
					click: () => sendMenuAction(windowManager, spawnWindow, "toggle-sidebar"),
				},
				{
					label: mainT("menu.togglePanel", language),
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
			label: mainT("menu.session", language),
			submenu: [
				{
					label: mainT("menu.exportHtml", language),
					accelerator: "CmdOrCtrl+E",
					click: () => sendMenuAction(windowManager, spawnWindow, "export-html"),
				},
				{
					label: mainT("menu.handoff", language),
					click: () => sendMenuAction(windowManager, spawnWindow, "handoff"),
				},
			],
		},
		{
			label: mainT("menu.help", language),
			submenu: [
				{
					label: mainT("menu.about", language),
					click: () => app.showAboutPanel(),
				},
				{
					label: mainT("menu.documentation", language),
					click: () => void shell.openExternal("https://github.com/nornzach/oh-my-pi-gui"),
				},
			],
		},
	];

	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
