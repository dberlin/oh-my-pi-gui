import { lazy, Suspense, useEffect, useState } from "react";
import type { MenuAction, MenuActionPayload, RunProgressState } from "../shared/ipc-types";
import { ChatStream } from "./components/chat/ChatStream";
import { ToastStack } from "./components/common";
import { BranchPickerDialog } from "./components/dialogs/BranchPickerDialog";
import { CommandPalette } from "./components/dialogs/CommandPalette";
import { ExtensionDialog } from "./components/dialogs/ExtensionDialog";
import { HandoffDialog } from "./components/dialogs/HandoffDialog";
import { ModelPicker } from "./components/dialogs/ModelPicker";
import { PlanApprovalDialog } from "./components/dialogs/PlanApprovalDialog";
import { RenameSessionDialog } from "./components/dialogs/RenameSessionDialog";
import { SessionInfoDialog } from "./components/dialogs/SessionInfoDialog";
import { SessionPickerDialog } from "./components/dialogs/SessionPickerDialog";
import { SessionTreeDialog } from "./components/dialogs/SessionTreeDialog";
import { ThemePickerDialog } from "./components/dialogs/ThemePickerDialog";
import { InputArea } from "./components/layout/InputArea";
import { PanelContainer } from "./components/layout/PanelContainer";
import { Sidebar } from "./components/layout/Sidebar";
import { SidecarBanner } from "./components/layout/SidecarBanner";
import { StatusFooter } from "./components/layout/StatusFooter";
import { TitleBar } from "./components/layout/TitleBar";
import { useAwaitingConfirmation } from "./hooks/use-awaiting-confirmation";
import { useExtensionUi } from "./hooks/use-extension-ui";
import { hydrateSession, useRpcEvents } from "./hooks/use-rpc-events";
import { useTraySync } from "./hooks/use-tray-sync";
import { exportSessionHtml } from "./lib/export-session";
import { useLang, useT } from "./lib/i18n";
import { restoreQueuedMessages, retryLastTurn } from "./lib/messages";
import { applyFontSize, applyTheme, watchSystemTheme } from "./lib/theme";
import { applyThemeByName, getPersistedThemeSelection, initAgentThemeSync } from "./lib/themes";
import { startVoiceAutoSpeak } from "./lib/voice";
import { useModelStore } from "./stores/model";
import { useSessionStore } from "./stores/session";
import { useSettingsStore } from "./stores/settings";
import { toast } from "./stores/toast";
import { type PanelTab, useUiStore } from "./stores/ui";

// Heavy overlays code-split: they render null while closed, so they download
// only on first open instead of bloating the eager bundle.
const SettingsWindow = lazy(() =>
	import("./components/settings/SettingsWindow").then(m => ({ default: m.SettingsWindow })),
);
const StatsDashboard = lazy(() =>
	import("./components/stats/StatsDashboard").then(m => ({ default: m.StatsDashboard })),
);
const ModelCompare = lazy(() => import("./components/settings/ModelCompare").then(m => ({ default: m.ModelCompare })));
const ExtensionsPanel = lazy(() =>
	import("./components/panels/ExtensionsPanel").then(m => ({ default: m.ExtensionsPanel })),
);
const InventoryPanel = lazy(() =>
	import("./components/panels/InventoryPanel").then(m => ({ default: m.InventoryPanel })),
);
const ModesPanel = lazy(() => import("./components/panels/ModesPanel").then(m => ({ default: m.ModesPanel })));
const AgentHubWindow = lazy(() =>
	import("./components/panels/AgentHubWindow").then(m => ({ default: m.AgentHubWindow })),
);
const ProviderConfigDialog = lazy(() =>
	import("./components/settings/ProviderConfigDialog").then(m => ({ default: m.ProviderConfigDialog })),
);
const UsageWindow = lazy(() => import("./components/settings/UsageWindow").then(m => ({ default: m.UsageWindow })));
const ModelRolesWindow = lazy(() =>
	import("./components/settings/ModelRolesWindow").then(m => ({ default: m.ModelRolesWindow })),
);
const ProvidersWindow = lazy(() =>
	import("./components/settings/ProvidersWindow").then(m => ({ default: m.ProvidersWindow })),
);

/**
 * Shell: Sidebar | (TitleBar / ChatStream / InputArea) | PanelContainer,
 * with command palette, extension dialogs, and the model picker overlaid.
 * useRpcEvents() wires the IPC event stream into the stores exactly once.
 */
export function App() {
	useRpcEvents();
	useExtensionUi();
	const sidebarVisible = useUiStore(s => s.sidebarVisible);
	const panelVisible = useUiStore(s => s.panelVisible);
	const theme = useUiStore(s => s.theme);
	const fontSize = useUiStore(s => s.fontSize);
	const statsDashboardOpen = useUiStore(s => s.statsDashboardOpen);
	const closeStatsDashboard = useUiStore(s => s.closeStatsDashboard);
	const modelCompareOpen = useUiStore(s => s.modelCompareOpen);
	const closeModelCompare = useUiStore(s => s.closeModelCompare);
	const extensionsOpen = useUiStore(s => s.extensionsOpen);
	const extensionsTab = useUiStore(s => s.extensionsTab);
	const closeExtensions = useUiStore(s => s.closeExtensions);
	const inventoryOpen = useUiStore(s => s.inventoryOpen);
	const inventoryTab = useUiStore(s => s.inventoryTab);
	const closeInventory = useUiStore(s => s.closeInventory);
	const modesOpen = useUiStore(s => s.modesOpen);
	const modesTab = useUiStore(s => s.modesTab);
	const closeModes = useUiStore(s => s.closeModes);
	const agentHubOpen = useUiStore(s => s.agentHubOpen);
	const agentHubTab = useUiStore(s => s.agentHubTab);
	const closeAgentHub = useUiStore(s => s.closeAgentHub);
	const providerConfigOpen = useUiStore(s => s.providerConfigOpen);
	const providerConfigEdit = useUiStore(s => s.providerConfigEdit);
	const closeProviderConfig = useUiStore(s => s.closeProviderConfig);
	const { setLang } = useLang();
	const t = useT();

	// Keep the system-tray menu synced with live app state.
	useTraySync();

	// Shared `tui.titleState` setting: run-state marker in the window title —
	// ● working, ! waiting on you, › your turn (TUI terminal-title parity).
	const titleRunState = useSettingsStore(s => s.titleState);
	const titleStreaming = useSessionStore(s => s.isStreaming);
	const titleSessionName = useSessionStore(s => s.sessionName);
	const titleAwaiting = useAwaitingConfirmation();
	useEffect(() => {
		const name = titleSessionName ?? "omp";
		document.title = !titleRunState ? name : titleAwaiting ? `! ${name}` : titleStreaming ? `● ${name}` : `› ${name}`;
	}, [titleRunState, titleAwaiting, titleStreaming, titleSessionName]);

	// Shared `speech.enabled` setting: auto-speak finalized assistant output per
	// `speech.mode` (TUI vocalizer parity). The watcher reads `speech.mode` at
	// decision time, so mode changes apply to the next message.
	useEffect(() => startVoiceAutoSpeak(), []);

	// Shared `terminal.showProgress` setting: run-state indicator in the dock
	// badge + window progress bar — ● working, ! waiting on you (TUI terminal
	// progress parity). Setting off pins "idle" so nothing lingers.
	const progressEnabled = useSettingsStore(s => s.showProgress);
	const progressStreaming = useSessionStore(s => s.isStreaming);
	const progressAwaiting = useAwaitingConfirmation();
	useEffect(() => {
		const state: RunProgressState = !progressEnabled
			? "idle"
			: progressAwaiting
				? "waiting"
				: progressStreaming
					? "working"
					: "idle";
		// Coalesce flapping (stream end ↔ approval prompt ↔ retry) into one push.
		const timer = setTimeout(() => window.omp.progress.set(state), 200);
		return () => clearTimeout(timer);
	}, [progressEnabled, progressAwaiting, progressStreaming]);

	// Shared `tui.tight` (compact density) and `colorBlindMode` settings: both
	// are data-attrs on <html>; the stylesheets do the rest (zoom + Okabe-Ito).
	const tuiTight = useSettingsStore(s => s.tuiTight);
	const colorBlindMode = useSettingsStore(s => s.colorBlindMode);
	useEffect(() => {
		document.documentElement.dataset.density = tuiTight ? "tight" : "comfortable";
		document.documentElement.dataset.colorblind = colorBlindMode ? "true" : "false";
	}, [tuiTight, colorBlindMode]);

	// Seed theme/fontSize from persisted prefs once at boot.
	useEffect(() => {
		let cancelled = false;
		void window.omp.prefs
			.get()
			.then(raw => {
				if (cancelled) return;
				const prefs = (raw ?? {}) as Partial<Record<string, unknown>>;
				if (typeof prefs.theme === "string") {
					useUiStore.setState({ theme: prefs.theme as Parameters<typeof applyTheme>[0] });
				}
				if (typeof prefs.fontSize === "number") {
					useUiStore.setState({ fontSize: prefs.fontSize });
				}
				if (typeof prefs.notifications === "boolean") {
					useUiStore.setState({ notifications: prefs.notifications });
				}
				if (typeof prefs.thinkingExpanded === "boolean") {
					useUiStore.setState({ thinkingExpanded: prefs.thinkingExpanded });
				}
				// Restore the default workspace panel tab (written by Settings → GUI).
				if (
					typeof prefs.defaultPanelTab === "string" &&
					["todo", "agents", "diff", "files", "logs", "plan"].includes(prefs.defaultPanelTab)
				) {
					useUiStore.setState({ panelTab: prefs.defaultPanelTab as PanelTab });
				}
			})
			.catch(() => {});
		// Apply the persisted (possibly named) theme on boot so custom themes
		// survive restarts; the App effect's same-mode refire guard keeps the
		// inline tokens instead of clearing them.
		void getPersistedThemeSelection().then(sel => {
			if (!cancelled) applyThemeByName(sel);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Layer the agent's theme.dark/theme.light TUI themes over the active GUI
	// theme; re-syncs live on config_update frames and GUI theme switches.
	useEffect(() => initAgentThemeSync(), []);

	// Apply theme + font size to the DOM whenever they change.
	useEffect(() => {
		applyTheme(theme);
		applyFontSize(fontSize);
		return watchSystemTheme(theme, () => applyTheme(theme));
	}, [theme, fontSize]);

	// Keep the conversation usable at the minimum window size. The inspector
	// becomes an on-demand overlay instead of permanently squeezing the chat.
	useEffect(() => {
		const compact = window.matchMedia("(max-width: 1000px)");
		const hideInspector = () => {
			const ui = useUiStore.getState();
			if (compact.matches && ui.panelVisible) ui.togglePanel();
		};
		hideInspector();
		compact.addEventListener("change", hideInspector);
		return () => compact.removeEventListener("change", hideInspector);
	}, []);

	// Handle omp:// deep links (omp://new → new session; omp://session/<id> → switch).
	useEffect(() => {
		const handle = async (link: { action: "new-session" } | { action: "switch-session"; sessionId: string }) => {
			if (useSessionStore.getState().isStreaming) {
				toast({ variant: "warning", title: t("deepLink.streaming"), message: t("deepLink.streamingDesc") });
				return;
			}
			try {
				if (link.action === "new-session") {
					const res = await window.omp.rpc.newSession();
					if (!res.success) throw new Error(res.error);
					if (!(res.data as { cancelled?: boolean } | undefined)?.cancelled) await hydrateSession();
					return;
				}
				const sessions = await window.omp.sessions.list("global");
				const target = sessions.find(s => s.id === link.sessionId);
				if (!target) {
					toast({ variant: "error", title: t("deepLink.notFound"), message: link.sessionId });
					return;
				}
				const res = await window.omp.rpc.switchSession(target.path);
				if (!res.success) throw new Error(res.error);
				if (!(res.data as { cancelled?: boolean } | undefined)?.cancelled)
					await hydrateSession(target.title ?? target.firstMessage);
				else
					toast({
						variant: "info",
						title: t("sidebar.openCancelled"),
						message: target.title ?? target.firstMessage ?? "",
					});
			} catch (error) {
				toast({ variant: "error", title: t("sidebar.openFailed"), message: String(error) });
			}
		};
		return window.omp.events.onDeepLink(link => void handle(link));
	}, [t]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			const ui = useUiStore.getState();
			const overlayOpen =
				ui.commandPaletteOpen ||
				ui.modelPickerOpen ||
				ui.settingsOpen ||
				ui.statsDashboardOpen ||
				ui.sessionPickerOpen ||
				ui.branchPickerOpen;
			if (event.key === "Escape") {
				// Don't abort when an overlay/dropdown already consumed this Escape to
				// dismiss itself (its handler ran first + preventDefault).
				if (!event.defaultPrevented && !overlayOpen && !document.querySelector('[role="dialog"]'))
					void window.omp.rpc.abort();
				return;
			}

			// TUI-parity chords the ⌘/⌃ gate below would exclude. All are suppressed
			// while an overlay/dialog owns the keyboard, and when a focused control
			// (e.g. the composer's autocomplete menu) already consumed the key.
			if (!overlayOpen && !event.defaultPrevented && !document.querySelector('[role="dialog"]')) {
				// ⇧Tab — cycle thinking level (TUI app.thinking.cycle). In the TUI the
				// binding lives in the editor, so hijack it only while a textarea (the
				// composer) owns focus; elsewhere Shift+Tab keeps its focus-traversal role.
				if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
					if (document.activeElement instanceof HTMLTextAreaElement) {
						event.preventDefault();
						void window.omp.rpc.cycleThinkingLevel();
					}
					return;
				}
				// ⇧⌃P — cycle model backward (TUI app.model.cycleBackward).
				// TODO(rpc-gap): the cycle_model wire command has no direction arg
				// (rpc-mode.ts calls session.cycleModel() forward-only), so this rides
				// the forward cycle until the RPC grows a direction field.
				if (event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "p") {
					event.preventDefault();
					void window.omp.rpc.cycleModel();
					return;
				}
				// ⌥R — retry last turn (TUI app.retry).
				if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "KeyR") {
					event.preventDefault();
					void retryLastTurn(() =>
						toast({
							variant: "warning",
							title: t("palette.retryNothing"),
							message: t("palette.retryNothingDesc"),
						}),
					).catch(error => toast({ variant: "error", title: t("palette.failed"), message: String(error) }));
					return;
				}
				// ⌥↑ — restore queued messages to the composer (TUI app.message.dequeue):
				// newest queued steer/follow-up back into the composer, rest re-queued.
				if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === "ArrowUp") {
					event.preventDefault();
					void restoreQueuedMessages(() => toast({ variant: "info", message: t("input.dequeueEmpty") })).catch(
						error => toast({ variant: "error", title: t("palette.failed"), message: String(error) }),
					);
					return;
				}
				// ⌥⇧P — toggle plan mode (TUI app.plan.toggle).
				if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === "KeyP") {
					event.preventDefault();
					const enabled = !useSessionStore.getState().planModeEnabled;
					void window.omp.rpc.setPlanMode(enabled).then(response => {
						if (response.success) {
							const data = response.data as { enabled?: boolean } | undefined;
							useSessionStore.setState({ planModeEnabled: data?.enabled ?? enabled });
						} else {
							toast({ variant: "error", title: t("settings.runtime.planMode"), message: response.error });
						}
					});
					return;
				}
				// ⌃O — expand/collapse all tool cards (TUI app.tools.expand).
				if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key === "o") {
					event.preventDefault();
					ui.toggleToolsExpandAll();
					return;
				}
			}

			if (!(event.metaKey || event.ctrlKey)) return;
			if (event.key === "k") {
				event.preventDefault();
				if (ui.commandPaletteOpen) ui.closeCommandPalette();
				else ui.openCommandPalette();
			} else if (event.key === ",") {
				event.preventDefault();
				ui.openSettings();
			} else if (event.key === "b") {
				event.preventDefault();
				ui.toggleSidebar();
			} else if (event.key === "p" && event.ctrlKey && !event.metaKey) {
				// ⌃P — cycle to the next model (TUI parity).
				event.preventDefault();
				void window.omp.rpc.cycleModel();
			} else if (event.key === "j") {
				event.preventDefault();
				ui.togglePanel();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [t]);

	useEffect(() => {
		const run = async (action: MenuAction, payload?: MenuActionPayload) => {
			const ui = useUiStore.getState();
			if (action === "toggle-sidebar") {
				ui.toggleSidebar();
				return;
			}
			if (action === "toggle-panel") {
				ui.togglePanel();
				return;
			}
			if (action === "open-settings") {
				ui.openSettings();
				return;
			}
			if (action === "open-usage") {
				ui.openUsage();
				return;
			}
			if (action === "toggle-fast") {
				void useModelStore.getState().toggleFastMode();
				return;
			}
			if (action === "cycle-thinking") {
				void window.omp.rpc.cycleThinkingLevel();
				return;
			}
			if (action === "set-approval") {
				if (payload?.approvalMode) useSettingsStore.getState().setApprovalMode(payload.approvalMode);
				return;
			}
			if (action === "toggle-language") {
				const current = typeof localStorage !== "undefined" ? localStorage.getItem("omp.lang") : null;
				setLang(current === "zh" ? "en" : "zh");
				return;
			}
			if (
				useSessionStore.getState().isStreaming &&
				(action === "new-session" ||
					action === "open-project" ||
					action === "handoff" ||
					action === "switch-project")
			) {
				toast({ variant: "warning", message: "Abort the active turn before changing sessions or projects." });
				return;
			}

			try {
				if (action === "open-project") {
					await window.omp.sidecar.selectProject();
				} else if (action === "switch-project") {
					if (payload?.cwd) await window.omp.sidecar.setProject(payload.cwd);
				} else if (action === "new-session") {
					const response = await window.omp.rpc.newSession();
					if (!response.success) throw new Error(response.error);
					await hydrateSession();
				} else if (action === "export-html") {
					await exportSessionHtml();
				} else if (action === "handoff") {
					const response = await window.omp.rpc.handoff();
					if (!response.success) throw new Error(response.error);
					await hydrateSession();
					toast({ variant: "success", message: "Handoff created in a new session." });
				}
			} catch (error) {
				toast({ variant: "error", title: "Action failed", message: String(error) });
			}
		};
		return window.omp.events.onMenuAction((action, payload) => void run(action, payload));
	}, [setLang]);

	return (
		<div className="omp-surface-depth flex h-screen w-screen overflow-hidden text-[var(--omp-text)]">
			{sidebarVisible && <Sidebar onToggleStats={() => useUiStore.getState().openStatsDashboard()} />}

			<main className="relative flex min-w-0 flex-1 flex-col">
				<TitleBar onToggleStats={() => useUiStore.getState().openStatsDashboard()} />
				<SidecarBanner />
				<ChatStream />
				<InputArea />
				<StatusFooter />
			</main>

			{panelVisible && <PanelContainer />}

			<CommandPalette />
			<ExtensionDialog />
			<ModelPicker />
			<RenameSessionDialog />
			<SessionPickerDialog />
			<BranchPickerDialog />
			<SessionTreeDialog />
			<SessionInfoDialog />
			<HandoffDialog />
			<Suspense fallback={null}>
				<SettingsWindow />
				<UsageWindow />
				<ProvidersWindow />
				<ModelRolesWindow />
				<ModelCompare open={modelCompareOpen} onClose={closeModelCompare} />
				<ExtensionsPanel open={extensionsOpen} onClose={closeExtensions} initialTab={extensionsTab} />
				<InventoryPanel open={inventoryOpen} onClose={closeInventory} initialTab={inventoryTab} />
				<ModesPanel open={modesOpen} onClose={closeModes} initialTab={modesTab} />
				<AgentHubWindow open={agentHubOpen} onClose={closeAgentHub} initialTab={agentHubTab} />
				<ProviderConfigDialog
					open={providerConfigOpen}
					editProvider={providerConfigEdit}
					onClose={closeProviderConfig}
				/>
			</Suspense>
			<ThemePickerDialog />
			<PlanApprovalDialog />
			<Suspense fallback={null}>
				<StatsDashboard open={statsDashboardOpen} onClose={closeStatsDashboard} />
			</Suspense>
			<ToastStack />
		</div>
	);
}
