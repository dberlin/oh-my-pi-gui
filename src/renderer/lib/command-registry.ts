/**
 * Declarative command registry: maps every known slash command to a typed
 * UI affordance so the GUI can present them as first-class menu actions
 * instead of injecting "/command" text into the composer.
 *
 * Affordance kinds:
 * - `action`      — fire an RPC command or store action immediately
 * - `toggle`      — boolean state toggle with live on/off status
 * - `picker`      — open a picker dialog (model, thinking level)
 * - `window`      — open a dedicated window (usage, providers, settings)
 * - `submenu`     — expand into subcommands (mcp, marketplace, security…)
 * - `prompt`      — send the command text as a prompt (text-mode fallback)
 * - `unavailable` — TUI-only, rendered disabled with a reason
 */

import type { AvailableCommand, RpcResponse } from "../../shared/rpc-types";
import { useModelStore } from "../stores/model";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { toast } from "../stores/toast";
import { exportSessionHtml } from "./export-session";

export type CommandAffordance =
	| { kind: "action"; run: () => unknown; status?: string }
	| { kind: "toggle"; get: () => boolean; set: (enabled: boolean) => unknown }
	| { kind: "picker"; open: () => void }
	| { kind: "window"; open: () => void }
	| { kind: "submenu"; items: CommandMenuItem[] }
	| { kind: "prompt"; text: string; hint?: string }
	| { kind: "unavailable"; reason: string };

export interface CommandMenuItem {
	name: string;
	label: string;
	description?: string;
	category: CommandCategory;
	affordance: CommandAffordance;
	shortcut?: string;
	aliases?: string[];
}

export type CommandCategory =
	| "session"
	| "model"
	| "context"
	| "tools"
	| "providers"
	| "extensions"
	| "modes"
	| "view"
	| "workspace"
	| "other";

export interface CommandRegistryContext {
	isStreaming: boolean;
	fastModeEnabled: boolean;
	autoCompaction: boolean;
	autoRetry: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	planModeEnabled: boolean;
	availableCommands: AvailableCommand[];
	openModelPicker: () => void;
	openSettings: () => void;
	openUsage: () => void;
	openProviders: () => void;
	openCommandPalette: () => void;
	openModelRoles: () => void;
	openStatsDashboard: () => void;
	openRenameDialog: () => void;
	openSessionPicker: () => void;
	openBranchPicker: () => void;
	openSessionTree: () => void;
	openSessionInfo: () => void;
	openModelCompare: () => void;
	openHandoffDialog: () => void;
	openExtensions: (tab?: "skills" | "hooks" | "mcp" | "commands") => void;
	openInventory: (tab?: "plugins" | "marketplaces" | "templates" | "memory") => void;
	openThemePicker: () => void;
	openModes: (tab?: "vibe" | "goal" | "loop") => void;
	openAgentHub: (tab?: "definitions" | "hub") => void;
	openProviderConfig: () => void;
	/** Open the workspace drawer to a specific tab. */
	openWorkspaceTab: (tab: "todo" | "plan" | "agents" | "diff" | "files" | "logs") => void;
	/** Re-send the most recent user message (abortAndPrompt while streaming). */
	retryLastTurn: () => Promise<unknown>;
	/** Clone the whole session at head (true /fork) into a new session. */
	forkSession: () => Promise<unknown>;
	rpc: {
		setFastMode: (enabled: boolean) => Promise<RpcResponse>;
		setAutoCompaction: (enabled: boolean) => Promise<RpcResponse>;
		setAutoRetry: (enabled: boolean) => Promise<RpcResponse>;
		setSteeringMode: (mode: "all" | "one-at-a-time") => Promise<unknown>;
		setFollowUpMode: (mode: "all" | "one-at-a-time") => Promise<unknown>;
		setInterruptMode: (mode: "immediate" | "wait") => Promise<unknown>;
		compact: (instructions?: string) => Promise<unknown>;
		newSession: () => Promise<unknown>;
		handoff: () => Promise<unknown>;
		prompt: (message: string) => Promise<unknown>;
		setPlanMode: (enabled: boolean) => Promise<RpcResponse>;
		exportHtml: (path?: string) => Promise<unknown>;
		setSessionName: (name: string) => Promise<unknown>;
		cycleModel: () => Promise<unknown>;
		cycleThinkingLevel: () => Promise<unknown>;
	};
}

/** TUI-only commands with no RPC transport at all. */
const TUI_ONLY: Record<string, true> = {
	"guided-goal": true,
	switch: true,
	collab: true,
	join: true,
	leave: true,
	copy: true,
	hotkeys: true,
	drop: true,
	btw: true,
	tan: true,
	omfg: true,
	debug: true,
	live: true,
	pause: true,
	quit: true,
	exit: true,
};

/**
 * Commands left as kind:"prompt" forward `/cmd` text to the agent, which
 * runs the logic agent-side and replies with TUI-rendered text. Nativizing
 * them needs a dedicated RPC per command (structured result instead of text)
 * — tracked as P1: advisor, shake, computer, vision, browser, force, todo,
 * mcp, marketplace, plugins, reload-plugins, memory, security, ssh, move,
 * add-dir, remove-dir, dirs, jobs, changelog, prewalk, fresh, context,
 * tools, dump, share, session delete, session pin.
 */

/** Helper to build a prompt affordance. */
const p = (text: string, hint?: string): CommandAffordance => ({ kind: "prompt", text, hint });

/** Helper to build a submenu item. */
const sub = (name: string, label: string, text: string, hint?: string): CommandMenuItem => ({
	name,
	label,
	category: "extensions",
	affordance: p(text, hint),
});

/**
 * Runtime toggle applier (mirrors SettingsWindow's apply* pattern): toast on
 * RPC failure, otherwise apply the returned state to the owning store so the
 * UI reflects the server truth immediately instead of waiting for a push.
 */
async function applyToggle(
	promise: Promise<RpcResponse>,
	title: string,
	apply: (data: unknown) => void,
): Promise<void> {
	const res = await promise;
	if (res.success) apply(res.data);
	else toast({ variant: "error", title, message: res.error });
}

export function buildCommandMenu(ctx: CommandRegistryContext): CommandMenuItem[] {
	const items: CommandMenuItem[] = [];
	const seen = new Set<string>();

	const add = (item: CommandMenuItem) => {
		if (seen.has(item.name)) return;
		seen.add(item.name);
		items.push(item);
	};

	// ═══════════════════════════════════════════════════════════════════
	// SESSION
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "new",
		label: "New Session",
		description: "Start a fresh session",
		category: "session",
		shortcut: "⌘N",
		affordance: { kind: "action", run: () => ctx.rpc.newSession() },
	});
	add({
		name: "clear",
		label: "Clear / New Session",
		description: "Alias for /new",
		category: "session",
		aliases: ["clear"],
		affordance: { kind: "action", run: () => ctx.rpc.newSession() },
	});
	add({
		name: "resume",
		label: "Resume Session",
		description: "Switch to a different session",
		category: "session",
		affordance: { kind: "picker", open: ctx.openSessionPicker },
	});
	add({
		name: "session",
		label: "Session Info",
		description: "Show session info and stats",
		category: "session",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "session info",
					label: "Session Info",
					category: "extensions",
					affordance: { kind: "window", open: ctx.openSessionInfo },
				},
				// /session delete + /session pin stay forwarded — need dedicated RPC (P1).
				sub("session delete", "Delete Session", "/session delete"),
				sub("session pin", "Pin Provider", "/session pin ", "[account]"),
			],
		},
	});
	add({
		name: "rename",
		label: "Rename Session",
		description: "Rename the current session",
		category: "session",
		affordance: { kind: "picker", open: ctx.openRenameDialog },
	});
	add({
		name: "handoff",
		label: "Handoff",
		description: "Hand off context to a new session",
		category: "session",
		affordance: { kind: "picker", open: ctx.openHandoffDialog },
	});
	add({
		name: "export",
		label: "Export HTML",
		description: "Export session to HTML file",
		category: "session",
		affordance: { kind: "action", run: () => exportSessionHtml() },
	});
	add({
		name: "share",
		label: "Share Session",
		description: "Share via encrypted link",
		category: "session",
		affordance: p("/share"),
	});
	add({
		name: "dump",
		label: "Dump Transcript",
		description: "Copy transcript to clipboard",
		category: "session",
		affordance: p("/dump"),
	});
	add({
		name: "branch",
		label: "Branch",
		description: "Branch from a previous message",
		category: "session",
		affordance: { kind: "picker", open: ctx.openBranchPicker },
	});
	add({
		name: "fork",
		label: "Fork Session",
		description: "Clone the whole session into a new one",
		category: "session",
		affordance: { kind: "action", run: () => ctx.forkSession() },
	});
	add({
		name: "tree",
		label: "Session Tree",
		description: "Navigate session branches",
		category: "session",
		affordance: { kind: "window", open: ctx.openSessionTree },
	});
	add({
		name: "drop",
		label: "Drop Session",
		description: "Delete session and start new",
		category: "session",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "retry",
		label: "Retry Last Turn",
		description: "Retry the last failed turn",
		category: "session",
		shortcut: "⌥R",
		affordance: { kind: "action", run: () => ctx.retryLastTurn() },
	});
	// /queue runs over RPC: the agent enqueues the message as a follow-up while
	// streaming (or compacting / backed up) and starts it immediately when idle.
	add({
		name: "queue",
		label: "Queue Message",
		description: "Queue a follow-up for when the agent yields; sends immediately when idle",
		category: "session",
		affordance: p("/queue ", "<message>"),
	});

	// ═══════════════════════════════════════════════════════════════════
	// MODEL
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "model",
		label: "Switch Model",
		description: "Pick a model for this session",
		category: "model",
		aliases: ["models"],
		affordance: { kind: "picker", open: ctx.openModelPicker },
	});
	add({
		name: "switch",
		label: "Quick Switch Model",
		description: "Temporary model switch (alt+p)",
		category: "model",
		affordance: { kind: "picker", open: ctx.openModelPicker },
	});
	add({
		name: "model cycle",
		label: "Cycle Model",
		description: "Switch to the next recent model",
		category: "model",
		shortcut: "⌃P",
		affordance: { kind: "action", run: () => ctx.rpc.cycleModel() },
	});
	add({
		name: "thinking cycle",
		label: "Cycle Thinking Level",
		description: "Cycle reasoning effort level",
		category: "model",
		shortcut: "⇧Tab",
		affordance: { kind: "action", run: () => ctx.rpc.cycleThinkingLevel() },
	});
	add({
		name: "fast",
		label: "Fast Mode",
		description: "Toggle priority service tier",
		category: "model",
		affordance: {
			kind: "toggle",
			get: () => ctx.fastModeEnabled,
			set: e =>
				applyToggle(ctx.rpc.setFastMode(e), "Fast mode", data => {
					const d = data as { enabled?: boolean; active?: boolean } | undefined;
					useModelStore.setState({ fastModeEnabled: d?.enabled ?? e, fastModeActive: d?.active ?? false });
				}),
		},
	});
	add({
		name: "prewalk",
		label: "Prewalk",
		description: "Switch to fast model at next edit/write",
		category: "model",
		affordance: p("/prewalk"),
	});
	add({
		name: "advisor",
		label: "Advisor",
		description: "Toggle second-model review",
		category: "model",
		affordance: {
			kind: "submenu",
			items: [
				sub("advisor on", "Enable Advisor", "/advisor on"),
				sub("advisor off", "Disable Advisor", "/advisor off"),
				sub("advisor status", "Advisor Status", "/advisor status"),
				sub("advisor dump", "Dump Advisor Transcript", "/advisor dump"),
			],
		},
	});
	add({
		name: "model-roles",
		label: "Model Roles",
		description: "Configure per-role model assignments",
		category: "model",
		affordance: { kind: "window", open: ctx.openModelRoles },
	});
	add({
		name: "model-compare",
		label: "Compare Models",
		description: "Provider × model comparison matrix",
		category: "model",
		aliases: ["compare"],
		affordance: { kind: "window", open: ctx.openModelCompare },
	});

	// ═══════════════════════════════════════════════════════════════════
	// CONTEXT
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "compact",
		label: "Compact Context",
		description: "Manually compact the conversation",
		category: "context",
		affordance: { kind: "action", run: () => ctx.rpc.compact() },
	});
	add({
		name: "shake",
		label: "Shake Context",
		description: "Drop heavy content from context",
		category: "context",
		affordance: {
			kind: "submenu",
			items: [
				sub("shake elide", "Shake (elide)", "/shake elide"),
				sub("shake images", "Shake (images)", "/shake images"),
			],
		},
	});
	add({
		name: "context",
		label: "Context Report",
		description: "Show context usage breakdown",
		category: "context",
		affordance: p("/context"),
	});
	add({
		name: "auto-compact",
		label: "Auto-Compaction",
		description: "Toggle automatic compaction",
		category: "context",
		affordance: {
			kind: "toggle",
			get: () => ctx.autoCompaction,
			set: e =>
				applyToggle(ctx.rpc.setAutoCompaction(e), "Auto-compaction", () =>
					useSettingsStore.getState().update({ autoCompaction: e }),
				),
		},
	});
	add({
		name: "auto-retry",
		label: "Auto-Retry",
		description: "Toggle automatic retry on failure",
		category: "context",
		affordance: {
			kind: "toggle",
			get: () => ctx.autoRetry,
			set: e =>
				applyToggle(ctx.rpc.setAutoRetry(e), "Auto-retry", () =>
					useSettingsStore.getState().update({ autoRetry: e }),
				),
		},
	});
	add({
		name: "fresh",
		label: "Fresh",
		description: "Reset provider stream state",
		category: "context",
		affordance: p("/fresh"),
	});

	// ═══════════════════════════════════════════════════════════════════
	// TOOLS
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "tools",
		label: "Active Tools",
		description: "Show tools visible to the agent",
		category: "tools",
		affordance: p("/tools"),
	});
	add({
		name: "computer",
		label: "Computer Use",
		description: "Toggle computer-use tool",
		category: "tools",
		affordance: {
			kind: "submenu",
			items: [
				sub("computer on", "Enable", "/computer on"),
				sub("computer off", "Disable", "/computer off"),
				sub("computer status", "Status", "/computer status"),
			],
		},
	});
	add({
		name: "vision",
		label: "Vision Delegation",
		description: "Control inspect_image tool",
		category: "tools",
		affordance: {
			kind: "submenu",
			items: [
				sub("vision on", "Always On", "/vision on"),
				sub("vision off", "Always Off", "/vision off"),
				sub("vision auto", "Auto", "/vision auto"),
				sub("vision status", "Status", "/vision status"),
			],
		},
	});
	add({
		name: "browser",
		label: "Browser Mode",
		description: "Toggle headless vs visible",
		category: "tools",
		affordance: {
			kind: "submenu",
			items: [
				sub("browser headless", "Headless", "/browser headless"),
				sub("browser visible", "Visible", "/browser visible"),
			],
		},
	});
	add({
		name: "force",
		label: "Force Tool",
		description: "Force next turn to use a specific tool",
		category: "tools",
		affordance: p("/force ", "<tool-name> [prompt]"),
	});
	add({
		name: "todo",
		label: "Todo List",
		description: "View or modify the agent's todo list",
		category: "tools",
		affordance: {
			kind: "submenu",
			items: [
				sub("todo edit", "Edit Todos", "/todo edit"),
				sub("todo copy", "Copy Todos", "/todo copy"),
				sub("todo export", "Export Todos", "/todo export"),
				sub("todo import", "Import Todos", "/todo import"),
			],
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// PROVIDERS
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "providers",
		label: "Providers & Login",
		description: "Manage provider auth",
		category: "providers",
		affordance: { kind: "window", open: ctx.openProviders },
	});
	add({
		name: "add-provider",
		label: "Add Provider",
		description: "Configure a third-party provider (custom endpoint)",
		category: "providers",
		aliases: ["provider-config", "custom-provider"],
		affordance: { kind: "window", open: ctx.openProviderConfig },
	});
	add({
		name: "usage",
		label: "Usage & Quotas",
		description: "Provider usage limits",
		category: "providers",
		affordance: { kind: "window", open: ctx.openUsage },
	});
	add({
		name: "login",
		label: "Login",
		description: "Login with OAuth provider",
		category: "providers",
		affordance: { kind: "window", open: ctx.openProviders },
	});
	add({
		name: "logout",
		label: "Logout",
		description: "Logout from OAuth provider",
		category: "providers",
		affordance: { kind: "window", open: ctx.openProviders },
	});

	// ═══════════════════════════════════════════════════════════════════
	// EXTENSIONS
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "skills",
		label: "Skills",
		description: "View discovered skills",
		category: "extensions",
		affordance: { kind: "window", open: () => ctx.openExtensions("skills") },
	});
	add({
		name: "hooks",
		label: "Hooks",
		description: "View pre/post tool hooks",
		category: "extensions",
		affordance: { kind: "window", open: () => ctx.openExtensions("hooks") },
	});
	add({
		name: "commands",
		label: "Custom Commands",
		description: "View custom slash commands",
		category: "extensions",
		affordance: { kind: "window", open: () => ctx.openExtensions("commands") },
	});
	add({
		name: "mcp",
		label: "MCP Servers",
		description: "Manage MCP server connections",
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "mcp panel",
					label: "Open MCP Panel",
					description: "Native MCP server view",
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openExtensions("mcp") },
				},
				{
					name: "mcp list",
					label: "List Servers",
					description: "Native MCP server list",
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openExtensions("mcp") },
				},
				sub("mcp add", "Add Server", "/mcp add ", "<name> --url <url>"),
				sub("mcp remove", "Remove Server", "/mcp remove ", "<name>"),
				sub("mcp test", "Test Connection", "/mcp test ", "<name>"),
				sub("mcp enable", "Enable Server", "/mcp enable ", "<name>"),
				sub("mcp disable", "Disable Server", "/mcp disable ", "<name>"),
				sub("mcp reauth", "Reauthorize", "/mcp reauth ", "<name>"),
				sub("mcp unauth", "Remove Auth", "/mcp unauth ", "<name>"),
				sub("mcp reconnect", "Reconnect", "/mcp reconnect ", "<name>"),
				sub("mcp reload", "Reload Tools", "/mcp reload"),
				sub("mcp resources", "List Resources", "/mcp resources"),
				sub("mcp prompts", "List Prompts", "/mcp prompts"),
				sub("mcp notifications", "Notifications", "/mcp notifications"),
				sub("mcp smithery-search", "Search Smithery", "/mcp smithery-search ", "<keyword>"),
				sub("mcp smithery-login", "Smithery Login", "/mcp smithery-login"),
				sub("mcp smithery-logout", "Smithery Logout", "/mcp smithery-logout"),
				sub("mcp help", "Help", "/mcp help"),
			],
		},
	});
	add({
		name: "marketplace",
		label: "Plugin Marketplace",
		description: "Browse and install plugins",
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "marketplace panel",
					label: "Open Marketplaces",
					description: "Native marketplaces view",
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openInventory("marketplaces") },
				},
				{
					name: "marketplace list",
					label: "List Marketplaces",
					description: "Native marketplaces list",
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openInventory("marketplaces") },
				},
				sub("marketplace add", "Add Marketplace", "/marketplace add ", "<source>"),
				sub("marketplace remove", "Remove Marketplace", "/marketplace remove ", "<name>"),
				sub("marketplace update", "Update Catalogs", "/marketplace update"),
				sub("marketplace discover", "Browse Plugins", "/marketplace discover"),
				sub("marketplace install", "Install Plugin", "/marketplace install ", "<name@marketplace>"),
				sub("marketplace uninstall", "Uninstall Plugin", "/marketplace uninstall ", "<name@marketplace>"),
				{
					name: "marketplace installed",
					label: "Installed Plugins",
					description: "Native installed-plugins view",
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openInventory("plugins") },
				},
				sub("marketplace upgrade", "Upgrade All", "/marketplace upgrade"),
				sub("marketplace help", "Help", "/marketplace help"),
			],
		},
	});
	add({
		name: "plugins",
		label: "Plugins",
		description: "View and manage plugins",
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "plugins panel",
					label: "Open Plugins",
					description: "Native installed-plugins view",
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openInventory("plugins") },
				},
				sub("plugins list", "List Plugins", "/plugins list"),
				sub("plugins enable", "Enable Plugin", "/plugins enable ", "<name@marketplace>"),
				sub("plugins disable", "Disable Plugin", "/plugins disable ", "<name@marketplace>"),
			],
		},
	});
	add({
		name: "reload-plugins",
		label: "Reload Plugins",
		description: "Reload all plugins",
		category: "extensions",
		affordance: p("/reload-plugins"),
	});
	add({
		name: "memory",
		label: "Memory",
		description: "Inspect and manage memory",
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				{
					name: "memory panel",
					label: "Open Memory",
					description: "Native memory-backend view",
					category: "extensions",
					affordance: { kind: "window", open: () => ctx.openInventory("memory") },
				},
				sub("memory view", "View Memory", "/memory view"),
				sub("memory stats", "Memory Stats", "/memory stats"),
				sub("memory diagnose", "Diagnose", "/memory diagnose"),
				sub("memory clear", "Clear Memory", "/memory clear"),
				sub("memory enqueue", "Enqueue Consolidation", "/memory enqueue"),
			],
		},
	});
	add({
		name: "security",
		label: "Security Scans",
		description: "Plan, run, inspect scans",
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				sub("security plan", "New Scan Plan", "/security plan"),
				sub("security scan", "Start Scan", "/security scan"),
				sub("security status", "Scan Status", "/security status"),
				sub("security cancel", "Cancel Scan", "/security cancel"),
				sub("security scans", "List Scans", "/security scans"),
				sub("security show", "Show Scan", "/security show ", "<id>"),
				sub("security import", "Import SARIF", "/security import ", "<path>"),
				sub("security export", "Export", "/security export"),
				sub("security validate", "Validate Finding", "/security validate ", "<id>"),
				sub("security compare", "Compare Scans", "/security compare"),
				sub("security disposition", "Set Disposition", "/security disposition"),
			],
		},
	});
	add({
		name: "templates",
		label: "Prompt Templates",
		description: "View prompt templates",
		category: "extensions",
		aliases: ["prompt-templates"],
		affordance: { kind: "window", open: () => ctx.openInventory("templates") },
	});
	add({
		name: "ssh",
		label: "SSH Hosts",
		description: "Manage SSH connections",
		category: "extensions",
		affordance: {
			kind: "submenu",
			items: [
				sub("ssh list", "List Hosts", "/ssh list"),
				sub("ssh add", "Add Host", "/ssh add ", "<name> --host <host>"),
				sub("ssh remove", "Remove Host", "/ssh remove ", "<name>"),
				sub("ssh help", "Help", "/ssh help"),
			],
		},
	});

	// ═══════════════════════════════════════════════════════════════════
	// MODES
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "plan",
		label: "Plan Mode",
		description: "Agent plans before executing",
		category: "modes",
		shortcut: "⌥⇧P",
		affordance: {
			kind: "toggle",
			get: () => ctx.planModeEnabled,
			set: e =>
				applyToggle(ctx.rpc.setPlanMode(e), "Plan mode", data => {
					const d = data as { enabled?: boolean } | undefined;
					useSessionStore.setState({ planModeEnabled: d?.enabled ?? e });
				}),
		},
	});
	add({
		name: "vibe",
		label: "Vibe Mode",
		description: "Direct persistent fast worker sessions",
		category: "modes",
		affordance: { kind: "window", open: () => ctx.openModes("vibe") },
	});
	add({
		name: "goal",
		label: "Goal Mode",
		description: "Persistent autonomous objective",
		category: "modes",
		affordance: { kind: "window", open: () => ctx.openModes("goal") },
	});
	add({
		name: "loop",
		label: "Loop Mode",
		description: "Re-submit prompt after every yield",
		category: "modes",
		affordance: { kind: "window", open: () => ctx.openModes("loop") },
	});

	// ═══════════════════════════════════════════════════════════════════
	// WORKSPACE
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "move",
		label: "Move Session",
		description: "Move session to a different directory",
		category: "workspace",
		affordance: p("/move ", "<path>"),
	});
	add({
		name: "add-dir",
		label: "Add Directory",
		description: "Add workspace directory (multi-root)",
		category: "workspace",
		affordance: p("/add-dir ", "<path>"),
	});
	add({
		name: "remove-dir",
		label: "Remove Directory",
		description: "Remove workspace directory",
		category: "workspace",
		affordance: p("/remove-dir ", "<path>"),
	});
	add({
		name: "dirs",
		label: "List Directories",
		description: "List workspace directories",
		category: "workspace",
		affordance: p("/dirs"),
	});

	// ═══════════════════════════════════════════════════════════════════
	// VIEW
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "theme",
		label: "Theme",
		description: "Choose a GUI theme",
		category: "view",
		affordance: { kind: "picker", open: ctx.openThemePicker },
	});
	add({
		name: "settings",
		label: "Settings",
		description: "Open settings",
		category: "view",
		shortcut: "⌘,",
		affordance: { kind: "window", open: ctx.openSettings },
	});
	add({
		name: "stats",
		label: "Stats Dashboard",
		description: "Launch local stats dashboard",
		category: "view",
		affordance: { kind: "window", open: ctx.openStatsDashboard },
	});
	add({
		name: "jobs",
		label: "Background Jobs",
		description: "Show async background jobs",
		category: "view",
		affordance: p("/jobs"),
	});
	add({
		name: "changelog",
		label: "Changelog",
		description: "Show recent changelog entries",
		category: "view",
		affordance: p("/changelog"),
	});
	add({
		name: "copy",
		label: "Copy from Chat",
		description: "Pick text or code to copy",
		category: "view",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "hotkeys",
		label: "Keyboard Shortcuts",
		description: "Show all shortcuts",
		category: "view",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "extensions",
		label: "Extensions",
		description: "Skills, hooks, MCP servers, and custom commands",
		category: "view",
		aliases: ["status"],
		affordance: { kind: "window", open: () => ctx.openExtensions("skills") },
	});
	add({
		name: "agents",
		label: "Agents",
		description: "Subagent definitions and activity hub",
		category: "view",
		affordance: { kind: "window", open: () => ctx.openAgentHub() },
	});

	// ═══════════════════════════════════════════════════════════════════
	// COLLAB (TUI-only)
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "collab",
		label: "Collab Session",
		description: "Share session live via relay",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "join",
		label: "Join Collab",
		description: "Join a shared collab session",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "leave",
		label: "Leave Collab",
		description: "Leave the collab session",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});

	// ═══════════════════════════════════════════════════════════════════
	// MISC TUI-ONLY
	// ═══════════════════════════════════════════════════════════════════
	add({
		name: "btw",
		label: "Side Question",
		description: "Ask an ephemeral side question",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "tan",
		label: "Tangential Agent",
		description: "Run background agent on tangential work",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "omfg",
		label: "Forge TTSR Rule",
		description: "Stop a recurring behavior",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "debug",
		label: "Debug Tools",
		description: "Open debug tools selector",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "live",
		label: "Voice Mode",
		description: "Start realtime voice mode",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "pause",
		label: "Pause All Agents",
		description: "Freeze all agents until resumed",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});
	add({
		name: "plan-review",
		label: "Plan Review",
		description: "Review and approve the agent's plan",
		category: "other",
		affordance: { kind: "action", run: () => ctx.openWorkspaceTab("plan") },
	});
	add({
		name: "guided-goal",
		label: "Guided Goal",
		description: "Agent interviews you for goal setup",
		category: "other",
		affordance: { kind: "unavailable", reason: "TUI-only" },
	});

	// ═══════════════════════════════════════════════════════════════════
	// Merge sidecar-advertised commands not already covered
	// ═══════════════════════════════════════════════════════════════════
	for (const cmd of ctx.availableCommands) {
		if (seen.has(cmd.name)) continue;
		if (TUI_ONLY[cmd.name]) {
			add({
				name: cmd.name,
				label: `/${cmd.name}`,
				description: cmd.description,
				category: "other",
				affordance: { kind: "unavailable", reason: "TUI-only command" },
			});
			continue;
		}
		add({
			name: cmd.name,
			label: `/${cmd.name}`,
			description: cmd.description,
			category: "other",
			affordance: p(`/${cmd.name}${cmd.input?.hint ? " " : ""}`, cmd.input?.hint),
		});
	}

	return items;
}

export function groupByCategory(items: CommandMenuItem[]): Map<CommandCategory, CommandMenuItem[]> {
	const groups = new Map<CommandCategory, CommandMenuItem[]>();
	for (const item of items) {
		const list = groups.get(item.category) ?? [];
		list.push(item);
		groups.set(item.category, list);
	}
	return groups;
}

export const CATEGORY_LABELS: Record<CommandCategory, string> = {
	session: "Session",
	model: "Model",
	context: "Context",
	tools: "Tools",
	providers: "Providers",
	extensions: "Extensions",
	modes: "Modes",
	view: "View",
	workspace: "Workspace",
	other: "Other",
};
