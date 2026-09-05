import { promises as fsp } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { IPC_COMMANDS, type SessionTarget } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import {
	type IpcDeps,
	parsePersistedSubagentMessages,
	readRendererPreference,
	registerIpcHandlers,
	writeRendererPreference,
} from "./ipc";

const ipcTestState = vi.hoisted(() => ({
	handlers: new Map<string, (...args: unknown[]) => unknown>(),
	fromWebContents: vi.fn(),
	showOpenDialog: vi.fn(),
	storeSet: vi.fn(),
}));

vi.mock("electron", () => ({
	app: {
		getLocale: vi.fn(() => "en"),
		getVersion: vi.fn(() => "0.7.2"),
		isPackaged: true,
		name: "OMP",
		showAboutPanel: vi.fn(),
	},
	BrowserWindow: {
		fromWebContents: ipcTestState.fromWebContents,
		getAllWindows: vi.fn(() => []),
	},
	clipboard: { readText: vi.fn() },
	dialog: {
		showOpenDialog: ipcTestState.showOpenDialog,
		showSaveDialog: vi.fn(),
	},
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
			ipcTestState.handlers.set(channel, handler);
		}),
		on: vi.fn(),
	},
	Notification: class {
		show(): void {}
	},
	shell: {
		openExternal: vi.fn(),
		openPath: vi.fn(),
	},
}));

vi.mock("electron-store", () => ({
	default: class {
		store: Record<string, unknown> = {};

		get(): undefined {
			return undefined;
		}

		set(key: string, value: unknown): void {
			ipcTestState.storeSet(key, value);
		}
	},
}));

// electron-updater constructs its native Electron adapter when autoUpdater is
// read. Keep that external runtime out of these IPC tests; appVersion stays real.
vi.mock("electron-updater", () => ({ default: { autoUpdater: {} } }));

const MAIN_OWNED_KEYS = ["remoteHosts", "remoteExecutableOverrides", "remoteRecentWorkspaces"] as const;

function preferenceStore() {
	const store: Record<string, unknown> = {
		remoteHosts: [{ alias: "build" }],
		remoteExecutableOverrides: { build: "/opt/omp" },
		remoteRecentWorkspaces: { build: ["/srv/app"] },
		themeName: "dark",
	};
	return {
		store,
		get: vi.fn((key: string) => store[key]),
		set: vi.fn((key: string, value: unknown) => {
			store[key] = value;
		}),
	};
}

interface ProjectHandlerFixture {
	event: { sender: object };
	restart: Mock;
	setRecordCwd: Mock;
}

const SSH_TARGET: SessionTarget = {
	type: "ssh",
	hostAlias: "build",
	host: {
		host: "build.example.com",
		sourceId: "ssh-config:build",
		sourceLevel: "user",
	},
	originCwd: "/srv/app",
	cwd: "/srv/app",
};

function registerProjectHandlerFixture(target: SessionTarget): ProjectHandlerFixture {
	const sender = {};
	const win = { webContents: { id: 71 } };
	const restart = vi.fn();
	const sidecar = { cwd: "/Users/test/project", restart };
	const setRecordCwd = vi.fn();
	const sidecarPool = {
		entryForWindow: vi.fn(() => ({ sidecar, target })),
		sidecarForWindow: vi.fn(() => sidecar),
		tabsForWindow: vi.fn(() => []),
	};
	const deps = {
		sidecarPool,
		sessionIndex: {},
		statsClient: {},
		logWatcher: {},
		windowManager: { setRecordCwd, subscribeWindowClosed: vi.fn(() => () => {}) },
		spawnWindow: vi.fn(),
		remoteSsh: {},
		remoteHostCatalog: {},
		remoteAcp: {},
	} as unknown as IpcDeps;
	ipcTestState.fromWebContents.mockReturnValue(win);
	registerIpcHandlers(deps);
	return { event: { sender }, restart, setRecordCwd };
}

async function invokeProjectHandler(command: string, event: { sender: object }, payload?: unknown): Promise<unknown> {
	const handler = ipcTestState.handlers.get(command);
	if (!handler) throw new Error(`Missing handler for ${command}`);
	return await handler(event, payload);
}

function registerTranscriptHandlerFixture(target: SessionTarget, remoteSsh: object = {}): { sender: object } {
	const sender = {};
	const win = { webContents: { id: 71 } };
	const deps = {
		sidecarPool: {
			activeTabForWindow: vi.fn(() => "tab-1"),
			tabsForWindow: vi.fn(() => [{ tabId: "tab-1", target }]),
		},
		sessionIndex: {},
		statsClient: {},
		logWatcher: {},
		windowManager: { subscribeWindowClosed: vi.fn(() => () => {}) },
		spawnWindow: vi.fn(),
		remoteSsh,
		remoteHostCatalog: {},
		remoteAcp: {},
	} as unknown as IpcDeps;
	ipcTestState.fromWebContents.mockReturnValue(win);
	registerIpcHandlers(deps);
	return { sender };
}

interface LocalSshHandlerFixture {
	event: { sender: object };
	activeCommand: Mock;
	executeLocal: Mock;
	runCli: Mock;
}

function registerLocalSshHandlerFixture(
	active: { target: SessionTarget; cwd: string } = { target: SSH_TARGET, cwd: "/srv/app" },
): LocalSshHandlerFixture {
	const sender = {};
	const win = { webContents: { id: 71 } };
	const activeCommand = vi.fn(async () => ({
		type: "response",
		command: "get_ssh_hosts",
		success: false,
		error: "RPC timeout (30000ms): get_ssh_hosts",
	}));
	const executeLocal = vi.fn(async () => ({
		type: "response",
		command: "get_ssh_hosts",
		success: true,
		data: {
			openSshAvailable: true,
			hosts: [
				{
					name: "grill",
					host: "grill.controls.dberlin.org",
					scope: "project",
					editable: true,
					source: "/Users/test/project/.omp/ssh.json",
				},
			],
			warnings: [],
		},
	}));
	const runCli = vi.fn(async () =>
		JSON.stringify({
			modelRoles: { value: { plan: "openai/gpt-5" }, type: "record", description: "" },
		}),
	);
	const activeSidecar = { cwd: active.cwd, status: "ready", rpcClient: { command: activeCommand }, runCli };
	const sidecarPool = {
		activeTabForWindow: vi.fn(() => "active-tab"),
		entryForWindow: vi.fn(() => ({ sidecar: activeSidecar, target: active.target })),
		foreignSessionOwner: vi.fn(() => null),
		sidecarForWindow: vi.fn(() => activeSidecar),
		sidecarForTab: vi.fn(() => activeSidecar),
		tabsForWindow: vi.fn(() => [
			{ kind: "agent", tabId: "active-tab", cwd: active.cwd, target: active.target, status: "ready" },
			{ kind: "agent", tabId: "local-tab", cwd: "/Users/test/project", target: { type: "local" }, status: "ready" },
			{ kind: "agent", tabId: "remote-tab", cwd: "/srv/app", target: SSH_TARGET, status: "ready" },
		]),
	};
	const deps = {
		sidecarPool,
		sessionIndex: {},
		statsClient: {},
		logWatcher: {},
		windowManager: {
			recordFor: vi.fn(() => ({ cwd: "/Users/test/project" })),
			subscribeWindowClosed: vi.fn(() => () => {}),
		},
		spawnWindow: vi.fn(),
		remoteSsh: {},
		remoteHostCatalog: { replaceFromRpc: vi.fn() },
		remoteAcp: {},
		localSshSettings: { execute: executeLocal },
	} as unknown as IpcDeps;
	ipcTestState.fromWebContents.mockReturnValue(win);
	registerIpcHandlers(deps);
	return { event: { sender }, activeCommand, executeLocal, runCli };
}

beforeEach(() => {
	ipcTestState.handlers.clear();
	vi.clearAllMocks();
});

afterEach(() => {
	ipcTestState.handlers.clear();
	vi.clearAllMocks();
});

describe("IPC startup", () => {
	it("exposes the packaged app version through the system info handler", async () => {
		const fixture = registerProjectHandlerFixture({ type: "local" });

		expect(await invokeProjectHandler(IPC_COMMANDS.SYSTEM_INFO, fixture.event)).toMatchObject({
			appVersion: "0.7.2",
		});
	});
});

describe("renderer preference catalog ownership", () => {
	it("hides main-owned catalog keys from keyed and whole-store reads", () => {
		const prefs = preferenceStore();

		for (const key of MAIN_OWNED_KEYS) expect(readRendererPreference(prefs, key)).toBeUndefined();
		expect(readRendererPreference(prefs)).toEqual({ themeName: "dark" });
		expect(readRendererPreference(prefs, "themeName")).toBe("dark");
	});

	it("rejects renderer writes to main-owned catalog keys while preserving ordinary preferences", () => {
		const prefs = preferenceStore();

		for (const key of MAIN_OWNED_KEYS) {
			expect(() => writeRendererPreference(prefs, key, "attacker-controlled")).toThrow(
				"Preference key is main-owned",
			);
		}
		expect(prefs.set).not.toHaveBeenCalled();

		writeRendererPreference(prefs, "themeName", "light");
		expect(prefs.set).toHaveBeenCalledWith("themeName", "light");
	});
});

describe("local-only project handlers", () => {
	it("rejects select-project for an SSH-owned active sidecar before local effects", async () => {
		const stat = vi.spyOn(fsp, "stat");
		const fixture = registerProjectHandlerFixture(SSH_TARGET);

		const result = await invokeProjectHandler(IPC_COMMANDS.SIDECAR_SELECT_PROJECT, fixture.event);

		expect(result).toBeNull();
		expect(ipcTestState.showOpenDialog).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
		expect(ipcTestState.storeSet).not.toHaveBeenCalled();
		expect(fixture.setRecordCwd).not.toHaveBeenCalled();
		expect(fixture.restart).not.toHaveBeenCalled();
		stat.mockRestore();
	});

	it("rejects set-project for an SSH-owned active sidecar before local effects", async () => {
		const stat = vi.spyOn(fsp, "stat");
		const fixture = registerProjectHandlerFixture(SSH_TARGET);

		const result = await invokeProjectHandler(IPC_COMMANDS.SIDECAR_SET_PROJECT, fixture.event, {
			cwd: "/tmp/remote-project",
		});

		expect(result).toBe(false);
		expect(ipcTestState.showOpenDialog).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
		expect(ipcTestState.storeSet).not.toHaveBeenCalled();
		expect(fixture.setRecordCwd).not.toHaveBeenCalled();
		expect(fixture.restart).not.toHaveBeenCalled();
		stat.mockRestore();
	});

	it("preserves select-project success for a local active sidecar", async () => {
		const fixture = registerProjectHandlerFixture({ type: "local" });
		ipcTestState.showOpenDialog.mockResolvedValue({
			canceled: false,
			filePaths: ["/Users/test/selected"],
		});

		const result = await invokeProjectHandler(IPC_COMMANDS.SIDECAR_SELECT_PROJECT, fixture.event);

		expect(result).toBe("/Users/test/selected");
		expect(ipcTestState.showOpenDialog).toHaveBeenCalledOnce();
		expect(ipcTestState.storeSet).toHaveBeenCalledWith("lastProject", "/Users/test/selected");
		expect(fixture.setRecordCwd).toHaveBeenCalledWith(expect.anything(), "/Users/test/selected");
		expect(fixture.restart).toHaveBeenCalledWith("/Users/test/selected");
	});

	it("preserves set-project success for a local active sidecar", async () => {
		const fixture = registerProjectHandlerFixture({ type: "local" });

		const result = await invokeProjectHandler(IPC_COMMANDS.SIDECAR_SET_PROJECT, fixture.event, {
			cwd: process.cwd(),
		});

		expect(result).toBe(true);
		expect(ipcTestState.storeSet).toHaveBeenCalledWith("lastProject", process.cwd());
		expect(fixture.setRecordCwd).toHaveBeenCalledWith(expect.anything(), process.cwd());
		expect(fixture.restart).toHaveBeenCalledWith(process.cwd());
	});
});

describe("local SSH settings handlers", () => {
	it("loads SSH hosts locally when the active tab is remote", async () => {
		const fixture = registerLocalSshHandlerFixture();

		const result = await invokeProjectHandler(IPC_COMMANDS.RPC_COMMAND, fixture.event, {
			command: { type: "get_ssh_hosts" },
			timeoutMs: 30_000,
		});

		expect(result).toEqual(
			expect.objectContaining({
				command: "get_ssh_hosts",
				success: true,
				data: expect.objectContaining({
					hosts: [expect.objectContaining({ name: "grill", scope: "project" })],
				}),
			}),
		);
		expect(fixture.executeLocal).toHaveBeenCalledWith("/Users/test/project", { type: "get_ssh_hosts" });
		expect(fixture.activeCommand).not.toHaveBeenCalled();
	});

	it("rejects malformed SSH management commands before local dispatch", async () => {
		const fixture = registerLocalSshHandlerFixture();

		const result = await invokeProjectHandler(IPC_COMMANDS.RPC_COMMAND, fixture.event, {
			command: {
				type: "ssh_manage",
				action: "bogus",
				scope: "project",
				name: "renamed",
				previousName: "victim",
				host: { host: "example.com" },
			},
			timeoutMs: 30_000,
		});

		expect(result).toEqual(
			expect.objectContaining({
				command: "ssh_manage",
				success: false,
				error: "Invalid local SSH settings command",
			}),
		);
		expect(fixture.executeLocal).not.toHaveBeenCalled();
		expect(fixture.activeCommand).not.toHaveBeenCalled();
	});
	it("uses the active local tab's project for SSH settings", async () => {
		const fixture = registerLocalSshHandlerFixture({
			target: { type: "local" },
			cwd: "/Users/test/second-project",
		});

		await invokeProjectHandler(IPC_COMMANDS.RPC_COMMAND, fixture.event, {
			command: { type: "get_ssh_hosts" },
			timeoutMs: 30_000,
		});

		expect(fixture.executeLocal).toHaveBeenCalledWith("/Users/test/second-project", { type: "get_ssh_hosts" });
	});

	it("uses the active SSH sidecar CLI for remote settings", async () => {
		const fixture = registerLocalSshHandlerFixture();

		const result = await invokeProjectHandler(IPC_COMMANDS.RPC_COMMAND, fixture.event, {
			command: { id: "settings-1", type: "get_settings", paths: ["modelRoles"] },
		});

		expect(result).toEqual({
			id: "settings-1",
			type: "response",
			command: "get_settings",
			success: true,
			data: { values: { modelRoles: { plan: "openai/gpt-5" } } },
		});
		expect(fixture.runCli).toHaveBeenCalledWith(["config", "list", "--json"]);
		expect(fixture.activeCommand).not.toHaveBeenCalled();
	});

	it("preserves local setting provenance and applies writes to the running session", async () => {
		const fixture = registerLocalSshHandlerFixture({ target: { type: "local" }, cwd: "/Users/test/project" });
		const live = { "compaction.enabled": true };
		const provenance = { source: "project", sourcePath: "/Users/test/project/.omp/config.yml", shadowed: false };
		const schema = {
			entries: [
				{
					path: "compaction.enabled",
					type: "boolean",
					value: true,
					default: true,
					description: "Automatic context compaction",
					advanced: false,
					tab: "session",
					provenance,
				},
			],
			tabs: [{ id: "session", label: "Session" }],
		};
		const updates: unknown[] = [];
		fixture.activeCommand.mockImplementation(async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "get_settings_schema") {
				return { type: "response", command: command.type, success: true, data: schema };
			}
			if (command.type === "get_settings") {
				return {
					type: "response",
					command: command.type,
					success: true,
					data: {
						values: { ...live },
						provenance: { "compaction.enabled": provenance },
						advisorEnabled: false,
						advisorActive: false,
					},
				};
			}
			if (
				command.type === "set_setting" &&
				command.path === "compaction.enabled" &&
				typeof command.value === "boolean"
			) {
				live["compaction.enabled"] = command.value;
				updates.push({ type: "config_update", compactionEnabled: live["compaction.enabled"] });
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { path: command.path, value: live["compaction.enabled"], savedValue: command.value, provenance },
				};
			}
			throw new Error(`Unexpected native command: ${command.type}`);
		});
		const settingsSchema = await invokeProjectHandler(IPC_COMMANDS.RPC_COMMAND, fixture.event, {
			command: { type: "get_settings_schema" },
		});
		expect(settingsSchema).toMatchObject({ success: true, data: schema });
		const saved = await invokeProjectHandler(IPC_COMMANDS.RPC_COMMAND, fixture.event, {
			command: { type: "set_setting", path: "compaction.enabled", value: false },
		});
		expect(saved).toMatchObject({
			success: true,
			data: { path: "compaction.enabled", value: false, savedValue: false, provenance },
		});
		const settings = await invokeProjectHandler(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, fixture.event, {
			tabId: "active-tab",
			command: { type: "get_settings", paths: ["compaction.enabled"] },
		});
		expect(settings).toMatchObject({
			success: true,
			data: {
				values: { "compaction.enabled": false },
				provenance: { "compaction.enabled": provenance },
				advisorEnabled: false,
				advisorActive: false,
			},
		});
		expect(updates).toEqual([{ type: "config_update", compactionEnabled: false }]);
		expect(fixture.runCli).not.toHaveBeenCalled();
	});

	it("selects SSH config transport from the addressed tab rather than the focused local tab", async () => {
		const fixture = registerLocalSshHandlerFixture({ target: { type: "local" }, cwd: "/Users/test/project" });
		const settings = await invokeProjectHandler(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, fixture.event, {
			tabId: "remote-tab",
			command: { type: "get_settings", paths: ["modelRoles"] },
		});
		expect(settings).toMatchObject({ success: true, data: { values: { modelRoles: { plan: "openai/gpt-5" } } } });
		expect(fixture.activeCommand).not.toHaveBeenCalled();
	});

	it("updates the addressed local session when saving a role while an SSH tab is focused", async () => {
		const fixture = registerLocalSshHandlerFixture();
		const persisted = { modelRoles: { task: "other/task" } as Record<string, string> };
		const runtime = { modelRoles: { smol: "runtime/A" } as Record<string, string> };
		const live = { modelRoles: { ...persisted.modelRoles, ...runtime.modelRoles } };
		const updates: unknown[] = [];
		fixture.runCli.mockImplementation(async () => {
			throw new Error("Unexpected local CLI access");
		});
		fixture.activeCommand.mockImplementation(async (command: RpcCommand): Promise<RpcResponse> => {
			if (command.type === "get_settings") {
				return {
					type: "response",
					command: command.type,
					success: true,
					data: { values: { modelRoles: live.modelRoles } },
				};
			}
			if (command.type !== "set_model_role") throw new Error("Unexpected native command");
			if (command.modelId === null) {
				delete persisted.modelRoles[command.role];
				delete runtime.modelRoles[command.role];
			} else {
				persisted.modelRoles[command.role] = command.modelId;
				if (Object.hasOwn(runtime.modelRoles, command.role)) runtime.modelRoles[command.role] = command.modelId;
			}
			live.modelRoles = { ...persisted.modelRoles, ...runtime.modelRoles };
			updates.push({ type: "config_update", assignments: { ...live.modelRoles } });
			return {
				type: "response",
				command: command.type,
				success: true,
				data: { role: command.role, modelId: command.modelId },
			};
		});
		const saved = await invokeProjectHandler(IPC_COMMANDS.RPC_COMMAND_FOR_TAB, fixture.event, {
			tabId: "local-tab",
			command: { id: "local-role", type: "set_model_role", role: "smol", modelId: "selected/B" },
		});
		const assignments = { task: "other/task", smol: "selected/B" };
		expect(saved).toMatchObject({
			id: "local-role",
			command: "set_model_role",
			success: true,
			data: { assignments },
		});
		expect(live.modelRoles).toEqual(assignments);
		expect(persisted.modelRoles).toEqual(assignments);
		expect(updates).toEqual([{ type: "config_update", assignments }]);
	});
});

interface SideChannelHandlerFixture {
	event: { sender: object };
	win: object;
	sendSideChannel: Mock;
	sidecarForWindow: Mock;
	routeSideChannel: Mock;
}

function registerSideChannelHandlerFixture(routeState: "routed" | "foreign" | "unknown"): SideChannelHandlerFixture {
	const sender = {};
	const win = { webContents: { id: 71 } };
	const sendSideChannel = vi.fn();
	const sidecarForWindow = vi.fn(() => ({ sendSideChannel }));
	const routeSideChannel = vi.fn(() => routeState);
	const sidecarPool = {
		entryForWindow: vi.fn(),
		sidecarForWindow,
		sidecarForTab: vi.fn(),
		tabsForWindow: vi.fn(() => []),
		routeSideChannel,
	};
	const deps = {
		sidecarPool,
		sessionIndex: {},
		statsClient: {},
		logWatcher: {},
		windowManager: { subscribeWindowClosed: vi.fn(() => () => {}) },
		spawnWindow: vi.fn(),
		remoteSsh: {},
		remoteHostCatalog: {},
		remoteAcp: {},
	} as unknown as IpcDeps;
	ipcTestState.fromWebContents.mockReturnValue(win);
	registerIpcHandlers(deps);
	return { event: { sender }, win, sendSideChannel, sidecarForWindow, routeSideChannel };
}

const SIDE_CHANNEL_RESPONSES = [
	{
		name: "extension UI response",
		command: IPC_COMMANDS.EXTENSION_UI_RESPOND,
		payload: { response: { type: "extension_ui_response", id: "request-id", confirmed: true } },
		frame: { type: "extension_ui_response", id: "request-id", confirmed: true },
		final: true,
		malformedPayload: { response: { type: "host_tool_result", id: "request-id", result: "wrong channel" } },
	},
	{
		name: "host tool result",
		command: IPC_COMMANDS.HOST_TOOL_RESULT,
		payload: { result: { type: "host_tool_result", id: "request-id", result: "done" } },
		frame: { type: "host_tool_result", id: "request-id", result: "done" },
		final: true,
		malformedPayload: { result: { type: "extension_ui_response", id: "request-id", confirmed: true } },
	},
	{
		name: "host tool update",
		command: IPC_COMMANDS.HOST_TOOL_UPDATE,
		payload: { update: { type: "host_tool_update", id: "request-id", update: "working" } },
		frame: { type: "host_tool_update", id: "request-id", update: "working" },
		final: false,
		malformedPayload: { update: { type: "host_tool_result", id: "request-id", result: "not an update" } },
	},
	{
		name: "host URI result",
		command: IPC_COMMANDS.HOST_URI_RESULT,
		payload: { result: { type: "host_uri_result", id: "request-id", content: "data" } },
		frame: { type: "host_uri_result", id: "request-id", content: "data" },
		final: true,
		malformedPayload: { result: { type: "host_tool_result", id: "request-id", result: "wrong channel" } },
	},
] as const;

describe("renderer side-channel response ownership", () => {
	it.each(SIDE_CHANNEL_RESPONSES)("rejects a foreign $name without active-tab fallback", async testCase => {
		const fixture = registerSideChannelHandlerFixture("foreign");

		await invokeProjectHandler(testCase.command, fixture.event, testCase.payload);

		expect(fixture.routeSideChannel).toHaveBeenCalledWith(fixture.win, "request-id", testCase.frame, testCase.final);
		expect(fixture.sidecarForWindow).not.toHaveBeenCalled();
		expect(fixture.sendSideChannel).not.toHaveBeenCalled();
	});

	it.each(SIDE_CHANNEL_RESPONSES)("preserves same-window fallback for an unknown $name id", async testCase => {
		const fixture = registerSideChannelHandlerFixture("unknown");

		await invokeProjectHandler(testCase.command, fixture.event, testCase.payload);

		expect(fixture.sidecarForWindow).toHaveBeenCalledWith(fixture.win);
		expect(fixture.sendSideChannel).toHaveBeenCalledWith(testCase.frame);
	});

	it.each(SIDE_CHANNEL_RESPONSES)("rejects a malformed $name before routing or fallback", async testCase => {
		const fixture = registerSideChannelHandlerFixture("unknown");

		await invokeProjectHandler(testCase.command, fixture.event, testCase.malformedPayload);

		expect(fixture.routeSideChannel).not.toHaveBeenCalled();
		expect(fixture.sidecarForWindow).not.toHaveBeenCalled();
		expect(fixture.sendSideChannel).not.toHaveBeenCalled();
	});
});

describe("persisted subagent transcripts", () => {
	it("reconstructs only the canonical active branch", () => {
		const root = { role: "user", content: [{ type: "text", text: "root" }], timestamp: 1 };
		const abandoned = { role: "assistant", content: [{ type: "text", text: "abandoned" }], timestamp: 2 };
		const active = { role: "assistant", content: [{ type: "text", text: "active" }], timestamp: 3 };
		const content = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "child-session",
				timestamp: "2026-08-14T00:00:00.000Z",
				cwd: "/repo",
			}),
			JSON.stringify({
				type: "message",
				id: "root",
				parentId: null,
				timestamp: "2026-08-14T00:00:01.000Z",
				message: root,
			}),
			JSON.stringify({
				type: "message",
				id: "old-leaf",
				parentId: "root",
				timestamp: "2026-08-14T00:00:02.000Z",
				message: abandoned,
			}),
			JSON.stringify({
				type: "message",
				id: "active-leaf",
				parentId: "root",
				timestamp: "2026-08-14T00:00:03.000Z",
				message: active,
			}),
		].join("\n");

		expect(parsePersistedSubagentMessages(content)).toEqual([root, active]);
	});

	it("reconstructs supported custom-message transcript entries", () => {
		const content = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "child-session",
				timestamp: "2026-08-14T00:00:00.000Z",
				cwd: "/repo",
			}),
			JSON.stringify({
				type: "custom_message",
				id: "custom",
				parentId: null,
				timestamp: "2026-08-14T00:00:01.000Z",
				customType: "notice",
				content: "retained custom entry",
				display: true,
			}),
		].join("\n");

		expect(parsePersistedSubagentMessages(content)).toMatchObject([
			{ role: "custom", customType: "notice", content: "retained custom entry", display: true },
		]);
	});

	it("uses Win32 semantics to authorize a local Windows session path", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		const homedir = vi.spyOn(os, "homedir").mockReturnValue("C:\\Users\\me");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		try {
			const event = registerTranscriptHandlerFixture({ type: "local" });
			const result = await invokeProjectHandler(IPC_COMMANDS.SESSION_READ_SUBAGENT_TRANSCRIPT, event, {
				sessionFile: "C:\\Users\\me\\.omp\\agent\\sessions\\project\\parent\\Scout.jsonl",
			});

			expect(result).toMatchObject({ ok: false });
			if (!result || typeof result !== "object" || !("error" in result) || typeof result.error !== "string") {
				throw new Error("Expected transcript failure");
			}
			expect(result.error).toContain("ENOENT");
		} finally {
			homedir.mockRestore();
			if (platform) Object.defineProperty(process, "platform", platform);
		}
	});

	it("rejects invalid UTF-8 in a local persisted transcript", async () => {
		const home = await fsp.mkdtemp(path.join(tmpdir(), "omp-gui-transcript-"));
		const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
		const sessionFile = path.join(home, ".omp", "agent", "sessions", "project", "parent", "Scout.jsonl");
		await fsp.mkdir(path.dirname(sessionFile), { recursive: true });
		const prefix = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "child-session",
				timestamp: "2026-08-14T00:00:00.000Z",
				cwd: "/repo",
			}),
			'{"type":"message","id":"m1","parentId":null,"timestamp":"2026-08-14T00:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"',
		].join("\n");
		await fsp.writeFile(sessionFile, Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from('"}]}}')]));
		try {
			const event = registerTranscriptHandlerFixture({ type: "local" });
			const result = await invokeProjectHandler(IPC_COMMANDS.SESSION_READ_SUBAGENT_TRANSCRIPT, event, {
				sessionFile,
			});

			expect(result).toEqual({ ok: false, error: "Subagent transcript is not valid UTF-8" });
		} finally {
			homedir.mockRestore();
			await fsp.rm(home, { recursive: true, force: true });
		}
	});

	it("reads a child transcript from the active SSH host's session store", async () => {
		const sender = {};
		const win = { webContents: { id: 71 } };
		const sessionFile = "/home/build/.omp/agent/sessions/project/parent/Scout.jsonl";
		const message = { role: "assistant", content: [{ type: "text", text: "remote result" }], timestamp: 8 };
		const data = new TextEncoder().encode(
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "child-session",
					timestamp: "2026-08-14T00:00:00.000Z",
					cwd: "/srv/app",
				}),
				JSON.stringify({
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: "2026-08-14T00:00:01.000Z",
					message,
				}),
			].join("\n"),
		);
		const resolveRuntime = vi.fn(async () => ({
			ok: true as const,
			target: SSH_TARGET,
			runtime: {
				home: "/home/build",
				platform: "linux" as const,
				shell: "/bin/sh",
				executable: "/usr/bin/omp",
				runtimePath: ["/usr/bin"],
			},
		}));
		const readFile = vi.fn(async () => ({ ok: true as const, data, size: data.byteLength, truncated: false }));
		const deps = {
			sidecarPool: {
				activeTabForWindow: vi.fn(() => "tab-1"),
				tabsForWindow: vi.fn(() => [{ tabId: "tab-1", target: SSH_TARGET }]),
			},
			sessionIndex: {},
			statsClient: {},
			logWatcher: {},
			windowManager: { subscribeWindowClosed: vi.fn(() => () => {}) },
			spawnWindow: vi.fn(),
			remoteSsh: { resolveRuntime, readFile },
			remoteHostCatalog: {},
			remoteAcp: {},
		} as unknown as IpcDeps;
		ipcTestState.fromWebContents.mockReturnValue(win);
		registerIpcHandlers(deps);

		const result = await invokeProjectHandler(
			IPC_COMMANDS.SESSION_READ_SUBAGENT_TRANSCRIPT,
			{ sender },
			{
				sessionFile,
			},
		);

		expect(result).toEqual({ ok: true, messages: [message] });
		expect(readFile).toHaveBeenCalledWith(SSH_TARGET, sessionFile, ["/home/build/.omp/agent/sessions"], 25_000_001);
	});
});
