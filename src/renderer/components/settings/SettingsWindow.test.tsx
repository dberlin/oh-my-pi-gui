/**
 * Tests for the schema-driven settings window: closed-state rendering and the
 * pure tab/group bucketing contract that drives schema-tab rendering order.
 * (Open-state SSR assertions are not viable: react-dom/server renders
 * createPortal children as empty in this repo's test environment.)
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	IpcSpawnTabPayload,
	IpcSpawnTabResult,
	RemoteCatalogResult,
	RemoteDirectoryListResult,
	RemoteDirectoryValidationResult,
	RemoteHostCatalogSnapshot,
	RemotePreflightResult,
	SshSessionTarget,
} from "../../../shared/ipc-types";
import type { RpcResponse, RpcSshHostInput, RpcSshHostsResult, SettingEntry } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { Toggle } from "./editors/Toggle";
import { CapabilitiesHome } from "./pages/CapabilitiesHome";
import {
	groupSchemaEntries,
	isSettingVisibleInGui,
	resolveSettingsTarget,
	SchemaTabContent,
	SettingsWindow,
} from "./SettingsWindow";
import { SshSettingsPage } from "./SshSettingsPage";

function entry(partial: Partial<SettingEntry> & { path: string }): SettingEntry {
	return { type: "boolean", value: false, default: false, ...partial };
}

const {
	document,
	window: testWindow,
	Event,
	CustomEvent,
	HTMLElement,
	Element,
	Node,
} = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
	document,
	window: testWindow,
	Event,
	CustomEvent,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

interface TestElement {
	textContent: string | null;
	disabled: boolean;
	value: string;
	remove(): void;
	dispatchEvent(event: object): boolean;
	getAttribute(name: string): string | null;
}

const SSH_HOSTS: RpcSshHostsResult = {
	openSshAvailable: true,
	hosts: [
		{
			name: "build",
			host: "build.example.com",
			username: "deploy",
			port: 2202,
			scope: "user",
			editable: true,
			source: "ssh-config",
			os: "linux",
			shell: "bash",
		},
	],
	warnings: [],
};

const REMOTE_CATALOG: RemoteHostCatalogSnapshot = {
	hosts: [
		{
			alias: "build",
			host: {
				host: "build.example.com",
				username: "deploy",
				port: 2202,
				sourceId: "ssh-config",
				sourceLevel: "user",
				os: "linux",
				shell: "bash",
			},
			recentWorkspaces: ["/srv/app"],
		},
	],
	updatedAt: "2026-08-13T00:00:00.000Z",
};

function rpcSuccess(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

interface SettingsMockOmp {
	rpc: {
		getSshHosts: Mock<() => Promise<RpcResponse>>;
		sshTest: Mock<(host: RpcSshHostInput & { name: string }) => Promise<RpcResponse>>;
		sshManage: Mock<(request: unknown) => Promise<RpcResponse>>;
	};
	remote: {
		catalog: Mock<() => Promise<RemoteCatalogResult>>;
		preflight: Mock<(target: SshSessionTarget) => Promise<RemotePreflightResult>>;
		listDirectories: Mock<
			(target: SshSessionTarget, path: string, showHidden: boolean) => Promise<RemoteDirectoryListResult>
		>;
		validateDirectory: Mock<(target: SshSessionTarget, path: string) => Promise<RemoteDirectoryValidationResult>>;
		noteWorkspace: Mock<
			(hostAlias: string, cwd: string) => Promise<{ ok: true; catalog: RemoteHostCatalogSnapshot }>
		>;
	};
	tabs: {
		spawn: Mock<(payload: IpcSpawnTabPayload) => Promise<IpcSpawnTabResult | null>>;
		setActive: Mock<(tabId: string) => Promise<boolean>>;
	};
}

function installSettingsMock(): SettingsMockOmp {
	const omp: SettingsMockOmp = {
		rpc: {
			getSshHosts: vi.fn(async () => rpcSuccess(SSH_HOSTS)),
			sshTest: vi.fn(async host =>
				rpcSuccess({
					name: host.name,
					ok: true,
					checkedAt: "2026-08-13T00:00:00.000Z",
					os: "linux",
					shell: "bash",
				}),
			),
			sshManage: vi.fn(async () => rpcSuccess({})),
		},
		remote: {
			catalog: vi.fn(async () => ({ ok: true, catalog: REMOTE_CATALOG })),
			preflight: vi.fn(async target => ({
				ok: true,
				target,
				home: "/home/deploy",
				platform: "linux",
				executable: "/usr/local/bin/omp",
			})),
			listDirectories: vi.fn(async (_target, path) => ({ ok: true, path, parent: "/srv", entries: [] })),
			validateDirectory: vi.fn(async (_target, path) => ({ ok: true, path })),
			noteWorkspace: vi.fn(async () => ({ ok: true, catalog: REMOTE_CATALOG })),
		},
		tabs: {
			spawn: vi.fn(async () => ({ tabId: "remote-1" })),
			setActive: vi.fn(async () => true),
		},
	};
	const ompWindow = testWindow as unknown as { omp: SettingsMockOmp };
	ompWindow.omp = omp;
	return omp;
}

let container: TestElement | undefined;
let root: Root | undefined;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

function buttons(): TestElement[] {
	return Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
}

function findButton(text: string): TestElement {
	const button = buttons().find(candidate => candidate.textContent?.includes(text));
	if (!button) throw new Error(`button not found: ${text}`);
	return button;
}

function findButtonByAttribute(name: string, value: string): TestElement {
	const button = buttons().find(candidate => candidate.getAttribute(name) === value);
	if (!button) throw new Error(`button not found: ${name}=${value}`);
	return button;
}

async function click(element: TestElement): Promise<void> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		element.dispatchEvent(event);
	});
}

async function typeInto(element: TestElement, value: string): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else element.value = value;
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? record[propsKey] : undefined;
	if (props && typeof props === "object" && "onChange" in props && typeof props.onChange === "function") {
		const onChange = props.onChange;
		await act(async () => onChange({ target: element, currentTarget: element }));
		return;
	}
	const event = new Event("input", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		element.dispatchEvent(event);
	});
}

afterEach(() => {
	useUiStore.setState({ settingsOpen: false, settingsTab: "capabilities" });
});

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
		root = undefined;
	}
	container?.remove();
	container = undefined;
	useRemoteStore.getState().reset();
	useTabsStore.getState().reset();
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("Toggle", () => {
	it("uses the entire row as one switch without overlaying save text", () => {
		const html = renderToStaticMarkup(
			<Toggle
				checked={false}
				description="Applies immediately."
				label="Advisor for Subagents"
				onChange={() => {}}
			/>,
		);

		expect(html.startsWith("<button")).toBe(true);
		expect(html.match(/<button/g)).toHaveLength(1);
		expect(html).toContain('role="switch"');
		expect(html).toContain('aria-checked="false"');
		expect(html).not.toContain("Saved");
	});
});

describe("CapabilitiesHome", () => {
	it("leads with OMP-specific workflows and exposes a direct action for each", () => {
		const noop = () => {};
		const html = renderToStaticMarkup(
			<I18nProvider>
				<CapabilitiesHome
					advisorActive={false}
					advisorEnabled
					memoryBackend="local"
					onConfigureAdvisor={noop}
					onConfigureTtsr={noop}
					onOpenAgents={noop}
					onOpenGoal={noop}
					onOpenLoop={noop}
					onOpenMemory={noop}
					onOpenModelRoles={noop}
					onOpenTools={noop}
					ready
					ttsrEnabled
				/>
			</I18nProvider>,
		);

		expect(html).toContain("Start with what makes OMP different");
		expect(html.indexOf("Mid-stream correction · TTSR")).toBeLessThan(html.indexOf("Parallel subagents"));
		expect(html).toContain("Configure rules");
		expect(html).toContain("Open Agent Hub");
		expect(html).toContain("Configure model roles");
		expect(html).toContain("Advisor settings");
		expect(html).toContain("Goal mode");
		expect(html).toContain("Loop mode");
		expect(html).toContain("Configure memory");
		expect(html).toContain("Configure tool access");
		expect(html).toContain("Backend: local");
		expect(html).toContain("Enabled, not running");
	});

	// (The pending-toggle lock test was removed with the toggle buttons —
	// capability cards are now discovery + navigation only; the values live in
	// their schema tabs.)
});

describe("groupSchemaEntries", () => {
	const entries: SettingEntry[] = [
		entry({ path: "a.loose", tab: "appearance" }),
		entry({ path: "a.theme", tab: "appearance", group: "Theme" }),
		entry({ path: "a.display", tab: "appearance", group: "Display" }),
		entry({ path: "a.status", tab: "appearance", group: "Status Line" }),
		entry({ path: "a.mystery", tab: "appearance", group: "Undeclared" }),
		entry({ path: "m.other", tab: "model", group: "Thinking" }),
	];

	it("filters to the requested tab only", () => {
		const { tabEntries } = groupSchemaEntries(entries, "appearance", []);
		expect(tabEntries.map(e => e.path)).not.toContain("m.other");
		expect(tabEntries).toHaveLength(5);
	});

	it("orders groups by the declared TAB_GROUPS order and appends undeclared groups", () => {
		const { orderedGroups } = groupSchemaEntries(entries, "appearance", [
			"Theme",
			"Status Line",
			"Display",
			"Images",
		]);
		expect(orderedGroups.map(group => group.name)).toEqual(["Theme", "Status Line", "Display", "Undeclared"]);
	});

	it("separates ungrouped entries and omits empty declared groups", () => {
		const { ungrouped, orderedGroups } = groupSchemaEntries(entries, "appearance", ["Images", "Theme"]);
		expect(ungrouped.map(e => e.path)).toEqual(["a.loose"]);
		expect(orderedGroups.map(group => group.name)).not.toContain("Images");
	});
});

describe("GUI settings visibility", () => {
	const sharedEntry = entry({
		path: "colorBlindMode",
		tab: "appearance",
		group: "Theme",
		label: "Color Blind Mode",
	});
	const terminalEntry = entry({
		path: "statusLine.separator",
		tab: "appearance",
		group: "Status Line",
		label: "Status Line Separator",
		tuiOnly: true,
	});

	it("rejects settings whose only consumer is TUI chrome", () => {
		expect(isSettingVisibleInGui(sharedEntry, {})).toBe(true);
		expect(isSettingVisibleInGui(terminalEntry, {})).toBe(false);
	});

	it("omits TUI-only rows and groups from a schema tab", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<SchemaTabContent
					entries={[sharedEntry, terminalEntry]}
					groups={["Theme", "Status Line"]}
					onCommitted={() => {}}
					tabId="appearance"
					values={{}}
				/>
			</I18nProvider>,
		);
		expect(html).toContain("Color Blind Mode");
		expect(html).not.toContain("Status Line Separator");
		expect(html).not.toContain(">Status Line</h3>");
	});

	it("renders fixed ordered arrays as choices instead of an arbitrary text field", () => {
		const methodOrder = entry({
			path: "compaction.methodOrder",
			type: "array",
			value: ["remote", "soft"],
			default: ["remote", "soft"],
			tab: "context",
			group: "Compaction",
			ordered: true,
			options: [
				{ value: "remote", label: "OpenAI server compaction" },
				{ value: "soft", label: "Soft compaction" },
				{ value: "shake", label: "Shake" },
			],
		});
		const html = renderToStaticMarkup(
			<I18nProvider>
				<SchemaTabContent
					entries={[methodOrder]}
					groups={["Compaction"]}
					onCommitted={() => {}}
					tabId="context"
					values={{ "compaction.methodOrder": ["remote", "soft"] }}
				/>
			</I18nProvider>,
		);

		expect(html).toContain("<select");
		expect(html).toContain('value="shake"');
		expect(html).toContain(">OpenAI server compaction<");
		expect(html).toContain(">Soft compaction<");
		expect(html).not.toContain('value="remote"');
		expect(html).not.toContain('value="soft"');
		expect(html).not.toContain("<input");
	});
});

describe("SchemaTabContent zh translations", () => {
	const zhEntries: SettingEntry[] = [
		entry({
			path: "theme.dark",
			tab: "appearance",
			group: "Theme",
			label: "Dark Theme",
			description: "Theme palette used for dark appearance in both the TUI and GUI",
		}),
		entry({
			path: "zz.mystery",
			tab: "appearance",
			group: "Undeclared",
			label: "Mystery Setting",
			description: "An English-only setting",
		}),
	];

	function renderTab(): string {
		return renderToStaticMarkup(
			<I18nProvider>
				<SchemaTabContent
					entries={zhEntries}
					groups={["Theme"]}
					onCommitted={() => {}}
					tabId="appearance"
					values={{}}
				/>
			</I18nProvider>,
		);
	}

	it("renders group titles and setting text in Chinese when lang is zh, with English fallback", () => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "zh-CN" } });
		try {
			const html = renderTab();
			expect(html).toContain(">主题</h3>"); // translated group title
			expect(html).toContain("深色主题"); // translated label
			expect(html).toContain("TUI 与 GUI 使用深色外观时的主题配色"); // translated description
			expect(html).toContain(">Undeclared</h3>"); // group without a translation stays English
			expect(html).toContain("Mystery Setting"); // setting without a translation stays English
			expect(html).toContain("An English-only setting");
			expect(html).not.toContain("Dark Theme");
		} finally {
			if (original) Object.defineProperty(globalThis, "navigator", original);
		}
	});

	it("renders the schema's English text when lang is en", () => {
		const html = renderTab();
		expect(html).toContain(">Theme</h3>");
		expect(html).toContain("Dark Theme");
		expect(html).toContain("Theme palette used for dark appearance in both the TUI and GUI");
	});
});

describe("SshSettingsPage", () => {
	it("reloads the read-only app catalog after get_ssh_hosts succeeds", async () => {
		const omp = installSettingsMock();
		await mount(<SshSettingsPage />);

		expect(omp.rpc.getSshHosts).toHaveBeenCalledTimes(1);
		expect(omp.remote.catalog).toHaveBeenCalledTimes(1);
		expect(useRemoteStore.getState().hosts.build?.host.alias).toBe("build");
	});

	it("starts the canonical catalog refresh without waiting for active-sidecar settings data", async () => {
		const omp = installSettingsMock();
		const activeSidecar = Promise.withResolvers<RpcResponse>();
		omp.rpc.getSshHosts.mockReturnValueOnce(activeSidecar.promise);

		await mount(<SshSettingsPage />);

		expect(omp.remote.catalog).toHaveBeenCalledOnce();
		activeSidecar.resolve(rpcSuccess(SSH_HOSTS));
		await flush();
	});

	it("refreshes canonical server truth after a successful draft connection test without cataloging the draft", async () => {
		const omp = installSettingsMock();
		await mount(<SshSettingsPage />);
		const aliasInput = document.querySelector("input") as unknown as TestElement | null;
		if (!aliasInput) throw new Error("alias input not found");
		await typeInto(aliasInput, "draft-build");

		await click(findButton("Test connection"));
		await flush();

		expect(omp.rpc.sshTest).toHaveBeenCalledWith(expect.objectContaining({ name: "draft-build" }));
		expect(omp.rpc.getSshHosts).toHaveBeenCalledTimes(1);
		expect(omp.remote.catalog).toHaveBeenCalledTimes(2);
		expect(useRemoteStore.getState().hosts.build?.host.alias).toBe("build");
		expect(useRemoteStore.getState().hosts["draft-build"]).toBeUndefined();
		expect(aliasInput.value).toBe("draft-build");
	});

	it("disables Start and retains the catalog error when a test refresh fails", async () => {
		const omp = installSettingsMock();
		await mount(<SshSettingsPage />);
		omp.remote.catalog.mockResolvedValue({ ok: false, error: "catalog unavailable" });

		await click(findButton("Test connection"));
		await flush();

		const start = findButton("Start session");
		expect(start.disabled).toBe(true);
		expect(start.getAttribute("title")).toContain("catalog unavailable");
		expect(document.body.textContent ?? "").toContain("catalog unavailable");
		expect(useRemoteStore.getState().hosts.build).toBeDefined();
	});

	it("disables Start and retains the catalog error when an update refresh fails", async () => {
		const omp = installSettingsMock();
		await mount(<SshSettingsPage />);
		omp.remote.catalog.mockResolvedValue({ ok: false, error: "update refresh failed" });

		await click(findButton("Save changes"));
		await flush();

		expect(omp.rpc.sshManage).toHaveBeenCalledWith(expect.objectContaining({ action: "update", name: "build" }));
		expect(findButton("Start session").disabled).toBe(true);
		expect(document.body.textContent ?? "").toContain("update refresh failed");
		expect(useRemoteStore.getState().hosts.build).toBeDefined();
	});

	it("retains the prior catalog and error when a delete refresh fails", async () => {
		const omp = installSettingsMock();
		await mount(<SshSettingsPage />);
		omp.remote.catalog.mockResolvedValue({ ok: false, error: "delete refresh failed" });

		await click(findButtonByAttribute("aria-label", "Delete host"));
		await flush();

		expect(omp.rpc.sshManage).toHaveBeenCalledWith(expect.objectContaining({ action: "delete", name: "build" }));
		expect(document.body.textContent ?? "").toContain("delete refresh failed");
		expect(useRemoteStore.getState().hosts.build).toBeDefined();
		expect(findButton("Start session").disabled).toBe(true);
	});

	it("starts a configured host through the controlled picker and canonical tab store", async () => {
		const omp = installSettingsMock();
		await mount(<SshSettingsPage />);

		await click(findButton("Start session"));
		await flush();
		expect(document.body.textContent ?? "").toContain("Choose remote workspace");

		await click(findButton("Open workspace"));
		await flush();

		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: "build",
			host: { ...REMOTE_CATALOG.hosts[0].host },
			originCwd: "/srv/app",
			cwd: "/srv/app",
		};
		expect(omp.tabs.spawn).toHaveBeenCalledWith({
			cwd: "/srv/app",
			sessionPath: undefined,
			kind: "agent",
			target,
		});
		expect(omp.tabs.setActive).toHaveBeenCalledWith("remote-1");
		expect(useTabsStore.getState()).toMatchObject({ activeTabId: "remote-1" });
		expect(omp.remote.noteWorkspace).toHaveBeenCalledWith("build", "/srv/app");
	});
});

describe("SettingsWindow", () => {
	it("normalizes resource deep links to one stable left-nav destination", () => {
		expect(resolveSettingsTarget("resources:marketplaces")).toEqual({
			tab: "resources",
			resourceTab: "marketplaces",
		});
		expect(resolveSettingsTarget("resources:unknown")).toEqual({ tab: "resources", resourceTab: "plugins" });
	});

	it("supports deep-linking the first-class Skills page from commands", () => {
		useUiStore.getState().openSettings("skills");
		expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: "skills" });
	});

	it("preserves resource subroutes for the Settings inventory page", () => {
		useUiStore.getState().openSettings("resources:marketplaces");
		expect(useUiStore.getState()).toMatchObject({
			settingsOpen: true,
			settingsTab: "resources:marketplaces",
		});
	});

	it("renders nothing when closed", () => {
		expect(
			renderToStaticMarkup(
				<I18nProvider>
					<SettingsWindow />
				</I18nProvider>,
			),
		).toBe("");
	});
});
