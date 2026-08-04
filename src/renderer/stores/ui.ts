import { create } from "zustand";
import type { CustomProviderView } from "../../shared/ipc-types";
import type { ThemeMode } from "../lib/theme";

export type { ThemeMode };

export type PanelTab = "todo" | "agents" | "diff" | "files" | "logs" | "plan";

interface UiStore {
	sidebarVisible: boolean;
	panelVisible: boolean;
	panelTab: PanelTab;
	commandPaletteOpen: boolean;
	modelPickerOpen: boolean;
	settingsOpen: boolean;
	usageOpen: boolean;
	providersOpen: boolean;
	modelRolesOpen: boolean;
	statsDashboardOpen: boolean;
	modelCompareOpen: boolean;
	extensionsOpen: boolean;
	extensionsTab: "skills" | "hooks" | "mcp" | "commands";
	inventoryOpen: boolean;
	inventoryTab: "plugins" | "marketplaces" | "templates" | "memory";
	themePickerOpen: boolean;
	modesOpen: boolean;
	modesTab: "vibe" | "goal" | "loop";
	agentHubOpen: boolean;
	agentHubTab: "definitions" | "hub";
	providerConfigOpen: boolean;
	providerConfigEdit: CustomProviderView | null;
	renameDialogOpen: boolean;
	sessionPickerOpen: boolean;
	branchPickerOpen: boolean;
	sessionTreeOpen: boolean;
	sessionInfoOpen: boolean;
	sidecarError: string | null;
	theme: ThemeMode;
	fontSize: number;
	/** Master switch for desktop notifications (Settings → GUI, default on). */
	notifications: boolean;
	/** Expand/collapse-all signal for tool cards (⌃O); `seq` bumps per toggle so cards re-sync their local state. */
	toolsExpandAll: { expanded: boolean; seq: number };
	toggleSidebar: () => void;
	togglePanel: () => void;
	toggleToolsExpandAll: () => void;
	setPanelTab: (tab: PanelTab) => void;
	openCommandPalette: () => void;
	closeCommandPalette: () => void;
	openModelPicker: () => void;
	closeModelPicker: () => void;
	openSettings: () => void;
	closeSettings: () => void;
	openUsage: () => void;
	closeUsage: () => void;
	openProviders: () => void;
	closeProviders: () => void;
	openModelRoles: () => void;
	closeModelRoles: () => void;
	openStatsDashboard: () => void;
	closeStatsDashboard: () => void;
	openModelCompare: () => void;
	closeModelCompare: () => void;
	openExtensions: (tab?: "skills" | "hooks" | "mcp" | "commands") => void;
	closeExtensions: () => void;
	openInventory: (tab?: "plugins" | "marketplaces" | "templates" | "memory") => void;
	closeInventory: () => void;
	openThemePicker: () => void;
	closeThemePicker: () => void;
	openModes: (tab?: "vibe" | "goal" | "loop") => void;
	closeModes: () => void;
	openAgentHub: (tab?: "definitions" | "hub") => void;
	closeAgentHub: () => void;
	openProviderConfig: (editProvider?: CustomProviderView | null) => void;
	closeProviderConfig: () => void;
	openRenameDialog: () => void;
	closeRenameDialog: () => void;
	openSessionPicker: () => void;
	closeSessionPicker: () => void;
	openBranchPicker: () => void;
	closeBranchPicker: () => void;
	openSessionTree: () => void;
	closeSessionTree: () => void;
	openSessionInfo: () => void;
	closeSessionInfo: () => void;
	setSidecarError: (error: string | null) => void;
	clearSidecarError: () => void;
	setTheme: (theme: ThemeMode) => void;
	setFontSize: (size: number) => void;
	setNotifications: (enabled: boolean) => void;
}

export const useUiStore = create<UiStore>()((set, get) => ({
	sidebarVisible: true,
	panelVisible: false,
	panelTab: "todo",
	commandPaletteOpen: false,
	modelPickerOpen: false,
	settingsOpen: false,
	theme: "light",
	fontSize: 15,
	notifications: true,
	toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),
	togglePanel: () => set({ panelVisible: !get().panelVisible }),
	toolsExpandAll: { expanded: false, seq: 0 },
	toggleToolsExpandAll: () =>
		set({ toolsExpandAll: { expanded: !get().toolsExpandAll.expanded, seq: get().toolsExpandAll.seq + 1 } }),
	setPanelTab: tab => set({ panelTab: tab, panelVisible: true }),
	openCommandPalette: () => set({ commandPaletteOpen: true }),
	closeCommandPalette: () => set({ commandPaletteOpen: false }),
	openModelPicker: () => set({ modelPickerOpen: true }),
	closeModelPicker: () => set({ modelPickerOpen: false }),
	openSettings: () => set({ settingsOpen: true }),
	closeSettings: () => set({ settingsOpen: false }),
	usageOpen: false,
	providersOpen: false,
	openUsage: () => set({ usageOpen: true }),
	closeUsage: () => set({ usageOpen: false }),
	openProviders: () => set({ providersOpen: true }),
	closeProviders: () => set({ providersOpen: false }),
	modelRolesOpen: false,
	openModelRoles: () => set({ modelRolesOpen: true }),
	closeModelRoles: () => set({ modelRolesOpen: false }),
	statsDashboardOpen: false,
	openStatsDashboard: () => set({ statsDashboardOpen: true }),
	closeStatsDashboard: () => set({ statsDashboardOpen: false }),
	modelCompareOpen: false,
	openModelCompare: () => set({ modelCompareOpen: true }),
	closeModelCompare: () => set({ modelCompareOpen: false }),
	extensionsOpen: false,
	extensionsTab: "skills" as const,
	inventoryOpen: false,
	inventoryTab: "plugins" as const,
	openExtensions: tab => set({ extensionsOpen: true, extensionsTab: tab ?? "skills" }),
	closeExtensions: () => set({ extensionsOpen: false }),
	openInventory: tab => set({ inventoryOpen: true, inventoryTab: tab ?? "plugins" }),
	closeInventory: () => set({ inventoryOpen: false }),
	themePickerOpen: false,
	openThemePicker: () => set({ themePickerOpen: true }),
	closeThemePicker: () => set({ themePickerOpen: false }),
	modesOpen: false,
	modesTab: "vibe" as const,
	openModes: tab => set({ modesOpen: true, modesTab: tab ?? "vibe" }),
	closeModes: () => set({ modesOpen: false }),
	agentHubOpen: false,
	agentHubTab: "definitions" as const,
	openAgentHub: tab => set({ agentHubOpen: true, agentHubTab: tab ?? "definitions" }),
	closeAgentHub: () => set({ agentHubOpen: false }),
	providerConfigOpen: false,
	providerConfigEdit: null as CustomProviderView | null,
	openProviderConfig: editProvider => set({ providerConfigOpen: true, providerConfigEdit: editProvider ?? null }),
	closeProviderConfig: () => set({ providerConfigOpen: false, providerConfigEdit: null }),
	renameDialogOpen: false,
	openRenameDialog: () => set({ renameDialogOpen: true }),
	closeRenameDialog: () => set({ renameDialogOpen: false }),
	sessionPickerOpen: false,
	openSessionPicker: () => set({ sessionPickerOpen: true }),
	closeSessionPicker: () => set({ sessionPickerOpen: false }),
	branchPickerOpen: false,
	openBranchPicker: () => set({ branchPickerOpen: true }),
	closeBranchPicker: () => set({ branchPickerOpen: false }),
	sessionTreeOpen: false,
	openSessionTree: () => set({ sessionTreeOpen: true }),
	closeSessionTree: () => set({ sessionTreeOpen: false }),
	sessionInfoOpen: false,
	openSessionInfo: () => set({ sessionInfoOpen: true }),
	closeSessionInfo: () => set({ sessionInfoOpen: false }),
	sidecarError: null as string | null,
	setSidecarError: (error: string | null) => set({ sidecarError: error }),
	clearSidecarError: () => set({ sidecarError: null }),
	setTheme: theme => set({ theme }),
	setFontSize: size => set({ fontSize: size }),
	setNotifications: enabled => set({ notifications: enabled }),
}));
