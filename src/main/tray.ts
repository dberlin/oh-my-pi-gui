/**
 * System tray with status icon and a rich quick-access menu: live config info
 * (model / thinking / fast / approval), usage + token consumption, workspace
 * jumping, quick-start and quick-config actions, and a language toggle. The
 * renderer pushes a TrayState snapshot on every relevant change, so the menu
 * is always fresh the moment it opens; actions route back to the renderer via
 * MENU_ACTION (it owns the RPC + i18n + UI stores).
 */

import { app, Menu, nativeImage, Tray } from "electron";
import { IPC_EVENTS, type MenuAction, type MenuActionPayload, type TrayState } from "../shared/ipc-types";
import type { WindowManager } from "./window";

type TrayStatus = "idle" | "streaming" | "error";
type TrayLang = "zh" | "en";

let tray: Tray | null = null;
let currentStatus: TrayStatus = "idle";
let windowManagerRef: WindowManager | null = null;
let trayState: TrayState | null = null;

/** Tray-label strings, translated in main (the renderer reports the language). */
const L: Record<string, { zh: string; en: string }> = {
	showHide: { zh: "显示 / 隐藏", en: "Show / Hide" },
	quit: { zh: "退出", en: "Quit" },
	newSession: { zh: "新建会话", en: "New Session" },
	openProject: { zh: "打开项目…", en: "Open Project…" },
	handoff: { zh: "交接(Handoff)", en: "Handoff" },
	usageStats: { zh: "Usage 统计…", en: "Usage Stats…" },
	workspaces: { zh: "工作区跳转", en: "Switch Workspace" },
	addWorkspace: { zh: "添加工作区…", en: "Add Workspace…" },
	quickStart: { zh: "快速开始", en: "Quick Start" },
	quickConfig: { zh: "快速配置", en: "Quick Config" },
	fastMode: { zh: "快速模式", en: "Fast Mode" },
	thinking: { zh: "思考强度", en: "Thinking" },
	approval: { zh: "工具审批", en: "Tool Approval" },
	language: { zh: "语言", en: "Language" },
	approvalYolo: { zh: "完全访问", en: "Full access" },
	approvalWrite: { zh: "自动编辑", en: "Auto-edit" },
	approvalAsk: { zh: "每次询问", en: "Ask every time" },
	context: { zh: "上下文", en: "Context" },
	tokens: { zh: "tokens", en: "tokens" },
	noModel: { zh: "未选模型", en: "No model" },
};

function t(lang: TrayLang, key: keyof typeof L): string {
	return L[key][lang];
}

function buildIcon(status: TrayStatus): Electron.NativeImage {
	const size = 16;
	const canvas = Buffer.alloc(size * size * 4, 0);
	const [r, g, b] = status === "streaming" ? [74, 222, 128] : status === "error" ? [248, 113, 113] : [148, 163, 184];
	const cx = size / 2;
	const cy = size / 2;
	const radius = 6;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = x - cx;
			const dy = y - cy;
			if (dx * dx + dy * dy <= radius * radius) {
				const idx = (y * size + x) * 4;
				canvas[idx] = r;
				canvas[idx + 1] = g;
				canvas[idx + 2] = b;
				canvas[idx + 3] = 255;
			}
		}
	}
	return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

function send(windowManager: WindowManager, action: MenuAction, payload?: MenuActionPayload): void {
	const win = windowManager.getTargetWindow();
	if (win) {
		win.show();
		win.focus();
		win.webContents.send(IPC_EVENTS.MENU_ACTION, { action, ...payload });
		return;
	}
	// All windows closed (macOS keep-running): create one and deliver the
	// action once the renderer is up instead of dropping it.
	const created = windowManager.createWindow();
	created.once("ready-to-show", () => {
		if (!created.isDestroyed()) {
			created.webContents.send(IPC_EVENTS.MENU_ACTION, { action, ...payload });
		}
	});
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function buildContextMenu(windowManager: WindowManager, state: TrayState | null): Electron.Menu {
	const lang: TrayLang = state?.language === "en" ? "en" : "zh";
	const template: Electron.MenuItemConstructorOptions[] = [];

	// Header: app + current project.
	const project = state?.projectName || "omp";
	template.push({ label: `● omp — ${project}`, enabled: false }, { type: "separator" });

	// Config info (read-only): model · thinking · fast · approval.
	if (state) {
		const model = state.modelId || t(lang, "noModel");
		template.push({ label: `${model} · ${t(lang, "thinking")} ${state.thinkingLevel}`, enabled: false });
		const approvalLabel =
			state.approvalMode === "yolo"
				? t(lang, "approvalYolo")
				: state.approvalMode === "write"
					? t(lang, "approvalWrite")
					: t(lang, "approvalAsk");
		const fastLabel = `${t(lang, "fastMode")}: ${state.fastMode ? "✓" : "—"}`;
		template.push({ label: `${fastLabel} · ${t(lang, "approval")}: ${approvalLabel}`, enabled: false });
		// Usage / token consumption (read-only).
		if (state.contextPercent !== null) {
			const tokens = state.contextTokens !== null ? ` · ${formatTokens(state.contextTokens)} ${t(lang, "tokens")}` : "";
			template.push({ label: `${t(lang, "context")}: ${Math.round(state.contextPercent)}%${tokens}`, enabled: false });
		}
		template.push({ type: "separator" });
	}

	// Usage stats window.
	template.push({ label: t(lang, "usageStats"), click: () => send(windowManager, "open-usage") }, { type: "separator" });

	// Workspace jumping.
	const workspaceItems: Electron.MenuItemConstructorOptions[] = (state?.workspaces ?? []).map(ws => ({
		label: `${ws.current ? "✓ " : ""}${ws.name}`,
		enabled: !ws.current,
		click: () => send(windowManager, "switch-project", { cwd: ws.cwd }),
	}));
	if (workspaceItems.length > 0) workspaceItems.push({ type: "separator" });
	workspaceItems.push({ label: t(lang, "addWorkspace"), click: () => send(windowManager, "open-project") });
	template.push({ label: t(lang, "workspaces"), submenu: workspaceItems });

	// Quick start.
	template.push({
		label: t(lang, "quickStart"),
		submenu: [
			{ label: t(lang, "newSession"), click: () => send(windowManager, "new-session") },
			{ label: t(lang, "openProject"), click: () => send(windowManager, "open-project") },
			{ label: t(lang, "handoff"), click: () => send(windowManager, "handoff") },
		],
	});

	// Quick config: fast toggle, thinking cycle, approval radios, language.
	template.push({
		label: t(lang, "quickConfig"),
		submenu: [
			{
				label: t(lang, "fastMode"),
				type: "checkbox",
				checked: state?.fastMode ?? false,
				click: () => send(windowManager, "toggle-fast"),
			},
			{ label: `${t(lang, "thinking")}: ${state?.thinkingLevel ?? "off"}`, click: () => send(windowManager, "cycle-thinking") },
			{
				label: t(lang, "approval"),
				submenu: (["yolo", "write", "always-ask"] as const).map(mode => ({
					label: mode === "yolo" ? t(lang, "approvalYolo") : mode === "write" ? t(lang, "approvalWrite") : t(lang, "approvalAsk"),
					type: "radio" as const,
					checked: state?.approvalMode === mode,
					click: () => send(windowManager, "set-approval", { approvalMode: mode }),
				})),
			},
			{
				label: `${t(lang, "language")}: ${lang === "zh" ? "中文" : "English"}`,
				click: () => send(windowManager, "toggle-language"),
			},
		],
	});

	template.push({ type: "separator" });

	// Show / Hide + Quit.
	template.push(
		{
			label: t(lang, "showHide"),
			click: () => {
				const win = windowManager.getMainWindow();
				if (win?.isVisible()) win.hide();
				else if (win) win.show();
				else windowManager.createWindow();
			},
		},
		{ type: "separator" },
		{ label: t(lang, "quit"), click: () => app.quit() },
	);

	return Menu.buildFromTemplate(template);
}

function rebuildMenu(): void {
	if (!tray || !windowManagerRef) return;
	tray.setContextMenu(buildContextMenu(windowManagerRef, trayState));
}

export function createTray(windowManager: WindowManager): Tray {
	windowManagerRef = windowManager;
	tray = new Tray(buildIcon("idle"));
	tray.setToolTip("omp");
	tray.setContextMenu(buildContextMenu(windowManager, null));

	tray.on("click", () => {
		const win = windowManager.getMainWindow();
		if (win) {
			win.show();
			win.focus();
		} else {
			windowManager.createWindow();
		}
	});

	return tray;
}

/** Renderer pushes a fresh snapshot; cache it and rebuild the menu + icon. */
export function setTrayState(state: TrayState): void {
	trayState = state;
	if (state.status !== currentStatus) {
		currentStatus = state.status;
		tray?.setImage(buildIcon(state.status));
	}
	rebuildMenu();
}

export function setTrayStatus(status: TrayStatus): void {
	if (!tray || currentStatus === status) return;
	currentStatus = status;
	tray.setImage(buildIcon(status));
}

export function destroyTray(): void {
	tray?.destroy();
	tray = null;
	windowManagerRef = null;
	trayState = null;
}
