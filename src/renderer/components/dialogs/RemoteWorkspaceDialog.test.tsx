/**
 * Linkedom interaction coverage for the controlled remote workspace picker.
 * The preload bridge is replaced at the remote IPC boundary; Modal, Zustand,
 * i18n, focus handling, and component state remain real.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	RemoteCatalogResult,
	RemoteDirectoryListResult,
	RemoteDirectoryValidationResult,
	RemoteHostCatalogEntry,
	RemotePreflightResult,
	SshSessionTarget,
} from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useUiStore } from "../../stores/ui";
import { RemoteWorkspaceDialog } from "./RemoteWorkspaceDialog";

const { document, window, Event, CustomEvent, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

interface TestElement {
	textContent: string | null;
	className: string;
	disabled: boolean;
	checked: boolean;
	value: string;
	remove(): void;
	dispatchEvent(event: object): boolean;
	getAttribute(name: string): string | null;
}

interface MockRemote {
	catalog: Mock<() => Promise<RemoteCatalogResult>>;
	setExecutableOverride: Mock<(hostAlias: string, value: string | null) => Promise<RemoteCatalogResult>>;
	cancel: Mock<(requestId: string) => Promise<boolean>>;
	preflight: Mock<(target: SshSessionTarget, tabId?: string, requestId?: string) => Promise<RemotePreflightResult>>;
	listDirectories: Mock<
		(
			target: SshSessionTarget,
			path: string,
			showHidden: boolean,
			tabId?: string,
			requestId?: string,
		) => Promise<RemoteDirectoryListResult>
	>;
	validateDirectory: Mock<
		(
			target: SshSessionTarget,
			path: string,
			tabId?: string,
			requestId?: string,
		) => Promise<RemoteDirectoryValidationResult>
	>;
}

interface MockOmp {
	remote: MockRemote;
}

const BUILD_HOST: RemoteHostCatalogEntry = {
	alias: "build",
	host: {
		host: "build.example.com",
		username: "danny",
		port: 2222,
		keyPath: "/Users/danny/.ssh/build",
		compat: false,
		os: "linux",
		shell: "bash",
		transferShell: "bash",
		sourceId: "project:build",
		sourceLevel: "project",
	},
	recentWorkspaces: ["/srv/new", "/srv/old"],
};

const PROD_HOST: RemoteHostCatalogEntry = {
	alias: "prod",
	host: {
		host: "prod.example.com",
		username: "deploy",
		port: 22,
		compat: true,
		os: "windows",
		shell: "powershell",
		sourceId: "user:prod",
		sourceLevel: "user",
	},
	recentWorkspaces: ["C:\\work\\current"],
};

function targetFor(host: RemoteHostCatalogEntry, cwd: string): SshSessionTarget {
	return {
		type: "ssh",
		hostAlias: host.alias,
		host: { ...host.host },
		originCwd: cwd,
		cwd,
		...(host.executableOverride ? { executableOverride: host.executableOverride } : {}),
	};
}

function seedHosts(...hosts: RemoteHostCatalogEntry[]): void {
	useRemoteStore.setState({
		hosts: Object.fromEntries(
			hosts.map(host => [
				host.alias,
				{
					host,
					history: [],
					historyStatus: "idle" as const,
					historyError: null,
					generation: 0,
				},
			]),
		),
		catalogStatus: "ready",
		catalogError: null,
	});
}

function directoryResult(path: string): RemoteDirectoryListResult {
	return {
		ok: true,
		path,
		parent: path === "/" ? null : "/",
		entries: [
			{ name: "apps", path: `${path === "/" ? "" : path}/apps`, kind: "directory", hidden: false },
			{ name: ".cache", path: `${path === "/" ? "" : path}/.cache`, kind: "symlink-directory", hidden: true },
		],
	};
}

function installRemote(overrides: Partial<MockRemote> = {}): MockRemote {
	const remote: MockRemote = {
		catalog: vi.fn(async () => ({ ok: true, catalog: { hosts: [BUILD_HOST], updatedAt: null } })),
		setExecutableOverride: vi.fn(async (hostAlias, value) => ({
			ok: true,
			catalog: {
				hosts: [{ ...BUILD_HOST, alias: hostAlias, ...(value ? { executableOverride: value } : {}) }],
				updatedAt: "2026-08-12T12:00:00.000Z",
			},
		})),
		cancel: vi.fn(async () => true),
		preflight: vi.fn(async target => ({
			ok: true,
			target: { ...target, host: { ...target.host } },
			home: target.hostAlias === "prod" ? "C:\\Users\\deploy" : "/home/danny",
			platform: target.hostAlias === "prod" ? "windows" : "linux",
			executable: target.executableOverride ?? "/home/danny/.local/bin/omp",
		})),
		listDirectories: vi.fn(async (_target, path) => directoryResult(path)),
		validateDirectory: vi.fn(async (_target, path) => ({ ok: true, path })),
		...overrides,
	};
	(window as unknown as { omp: MockOmp }).omp = { remote };
	return remote;
}

let container: TestElement;
let root: Root;

async function flush(turns = 3): Promise<void> {
	await act(async () => {
		for (let index = 0; index < turns; index += 1) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		}
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
	await flush();
}

async function rerender(element: ReactElement): Promise<void> {
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
	await flush();
}

function queryAll(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

function findButton(text: string): TestElement {
	const button = queryAll("button").find(candidate => candidate.textContent?.includes(text));
	if (!button) throw new Error(`button not found: ${text}`);
	return button;
}

function findButtonByAttribute(name: string, value: string): TestElement {
	const button = queryAll("button").find(candidate => candidate.getAttribute(name) === value);
	if (!button) throw new Error(`button not found: ${name}=${value}`);
	return button;
}

function inputWithLabel(label: string): TestElement {
	const labelElement = queryAll("label").find(candidate => candidate.textContent?.includes(label));
	if (!labelElement) throw new Error(`label not found: ${label}`);
	// linkedom's structural node is a real Element; its public types are intentionally not imported.
	const domLabel = labelElement as unknown as Element;
	const input = Array.from(domLabel.querySelectorAll("input"))[0];
	if (!input) throw new Error(`input not found: ${label}`);
	return input as unknown as TestElement;
}

function reactProps(element: TestElement): { onChange?: (event: object) => void } | undefined {
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	return key ? (record[key] as { onChange?: (event: object) => void } | undefined) : undefined;
}

async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => target.dispatchEvent(event));
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
	await flush();
}

async function typeInto(element: TestElement, value: string): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else element.value = value;
	const props = reactProps(element);
	if (props?.onChange) await act(async () => props.onChange?.({ target: element, currentTarget: element }));
	else await dispatch(element, new Event("input", { bubbles: true, cancelable: true }));
	await flush();
}

async function setChecked(element: TestElement, checked: boolean): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "checked");
	if (descriptor?.set) descriptor.set.call(element, checked);
	else element.checked = checked;
	const props = reactProps(element);
	if (props?.onChange) await act(async () => props.onChange?.({ target: element, currentTarget: element }));
	else await dispatch(element, new Event("change", { bubbles: true, cancelable: true }));
	await flush();
}

function picker(
	props: {
		hostAlias?: string;
		initialPath?: string;
		target?: SshSessionTarget;
		tabId?: string;
		onConfirm?: (target: SshSessionTarget) => void;
		onClose?: () => void;
	} = {},
): ReactElement {
	return (
		<RemoteWorkspaceDialog
			hostAlias={props.hostAlias ?? "build"}
			initialPath={props.initialPath}
			target={props.target}
			tabId={props.tabId}
			onClose={props.onClose ?? vi.fn()}
			onConfirm={props.onConfirm ?? vi.fn()}
		/>
	);
}

beforeEach(() => {
	seedHosts(BUILD_HOST, PROD_HOST);
	useUiStore.setState({ settingsOpen: false, settingsTab: "capabilities" });
});

afterEach(async () => {
	if (root) await act(async () => root.unmount());
	container?.remove();
	useRemoteStore.getState().reset();
	useUiStore.setState({ settingsOpen: false, settingsTab: "capabilities" });
});

describe("RemoteWorkspaceDialog", () => {
	it("shows preflight loading, then chooses the newest recent workspace", async () => {
		const preflight = Promise.withResolvers<RemotePreflightResult>();
		const remote = installRemote({ preflight: vi.fn(() => preflight.promise) });
		await mount(picker());
		expect(document.body.textContent).toContain("Connecting to build");
		expect(remote.listDirectories).not.toHaveBeenCalled();

		preflight.resolve({
			ok: true,
			target: targetFor(BUILD_HOST, "/srv/new"),
			home: "/home/danny",
			platform: "linux",
			executable: "/usr/local/bin/omp",
		});
		await flush();
		expect(inputWithLabel("Remote path").value).toBe("/srv/new");
		expect(remote.listDirectories).toHaveBeenCalledWith(
			expect.objectContaining({ hostAlias: "build" }),
			"/srv/new",
			false,
			undefined,
			expect.any(String),
		);
		expect(findButton("Open workspace").disabled).toBe(false);
	});

	it("treats an empty initial path as absent and chooses the newest recent", async () => {
		const remote = installRemote();
		await mount(picker({ initialPath: "" }));
		expect(inputWithLabel("Remote path").value).toBe("/srv/new");
		expect(remote.listDirectories).toHaveBeenLastCalledWith(
			expect.any(Object),
			"/srv/new",
			false,
			undefined,
			expect.any(String),
		);
	});

	it.each([
		{
			name: "known POSIX host",
			host: { ...BUILD_HOST, recentWorkspaces: [] },
			bootstrapPath: "/",
			home: "/home/danny",
			platform: "linux" as const,
		},
		{
			name: "unknown-platform host",
			host: {
				...BUILD_HOST,
				alias: "unknown",
				host: { ...BUILD_HOST.host, os: "unknown" as const, sourceId: "project:unknown" },
				recentWorkspaces: [],
			},
			bootstrapPath: "/",
			home: "/home/unknown",
			platform: "linux" as const,
		},
		{
			name: "known Windows host",
			host: { ...PROD_HOST, recentWorkspaces: [] },
			bootstrapPath: "C:\\",
			home: "C:\\Users\\deploy",
			platform: "windows" as const,
		},
	])(
		"bootstraps a catalog $name before browsing its discovered home",
		async ({ host, bootstrapPath, home, platform }) => {
			seedHosts(host);
			const remote = installRemote({
				preflight: vi.fn(async target => ({
					ok: true,
					target: { ...target, host: { ...target.host } },
					home,
					platform,
					executable: platform === "windows" ? "C:\\Tools\\omp.exe" : "/usr/local/bin/omp",
				})),
			});

			await mount(picker({ hostAlias: host.alias }));

			expect(remote.preflight).toHaveBeenCalledWith(targetFor(host, bootstrapPath), undefined, expect.any(String));
			expect(remote.listDirectories).toHaveBeenCalledWith(
				targetFor(host, home),
				home,
				false,
				undefined,
				expect.any(String),
			);
			expect(inputWithLabel("Remote path").value).toBe(home);
			expect(document.body.textContent).toContain("apps");
		},
	);

	it("navigates with platform-aware breadcrumbs and parent while rendering directory rows only", async () => {
		const remote = installRemote({
			listDirectories: vi.fn(async (_target, path) => {
				const untrustedResult = {
					ok: true,
					path,
					parent: "/",
					entries: [
						{ name: "deploy", path: `${path}/deploy`, kind: "directory", hidden: false },
						{ name: "linked", path: `${path}/linked`, kind: "symlink-directory", hidden: false },
						{ name: "notes.txt", path: `${path}/notes.txt`, kind: "file", hidden: false },
					],
				};
				// The renderer still filters an IPC payload if a compromised boundary returns a file row.
				return untrustedResult as unknown as RemoteDirectoryListResult;
			}),
		});
		await mount(picker({ initialPath: "/srv/work" }));
		expect(document.body.textContent).toContain("deploy");
		expect(document.body.textContent).toContain("linked");
		expect(document.body.textContent).not.toContain("notes.txt");

		await click(findButtonByAttribute("title", "/srv"));
		expect(remote.validateDirectory).toHaveBeenLastCalledWith(
			expect.any(Object),
			"/srv",
			undefined,
			expect.any(String),
		);
		await click(findButtonByAttribute("aria-label", "Parent directory"));
		expect(remote.validateDirectory).toHaveBeenLastCalledWith(expect.any(Object), "/", undefined, expect.any(String));
	});

	it("uses Windows drive breadcrumbs and parent paths", async () => {
		const remote = installRemote();
		await mount(picker({ hostAlias: "prod", initialPath: "C:\\work\\current" }));
		await click(findButtonByAttribute("title", "C:\\work"));
		expect(remote.validateDirectory).toHaveBeenLastCalledWith(
			expect.any(Object),
			"C:\\work",
			undefined,
			expect.any(String),
		);
		await click(findButtonByAttribute("aria-label", "Parent directory"));
		expect(remote.validateDirectory).toHaveBeenLastCalledWith(
			expect.any(Object),
			"C:\\",
			undefined,
			expect.any(String),
		);
	});

	it("reloads the current path for hidden-toggle and refresh actions", async () => {
		const remote = installRemote();
		await mount(picker());
		const checkbox = queryAll('input[type="checkbox"]')[0];
		if (!checkbox) throw new Error("hidden checkbox not found");
		await setChecked(checkbox, true);
		expect(remote.listDirectories).toHaveBeenLastCalledWith(
			expect.any(Object),
			"/srv/new",
			true,
			undefined,
			expect.any(String),
		);
		const callsAfterToggle = remote.listDirectories.mock.calls.length;
		await click(findButtonByAttribute("aria-label", "Refresh"));
		expect(remote.listDirectories.mock.calls).toHaveLength(callsAfterToggle + 1);
		expect(remote.listDirectories).toHaveBeenLastCalledWith(
			expect.any(Object),
			"/srv/new",
			true,
			undefined,
			expect.any(String),
		);
	});

	it("requires an absolute manual path and keeps confirm disabled until validation succeeds", async () => {
		const validation = Promise.withResolvers<RemoteDirectoryValidationResult>();
		const remote = installRemote();
		await mount(picker());
		const pathInput = inputWithLabel("Remote path");
		await typeInto(pathInput, "relative/path");
		expect(findButton("Open workspace").disabled).toBe(true);
		const validationCalls = remote.validateDirectory.mock.calls.length;
		await click(findButton("Go"));
		expect(document.body.textContent).toContain("Enter an absolute path");
		expect(remote.validateDirectory.mock.calls).toHaveLength(validationCalls);

		remote.validateDirectory.mockImplementationOnce(() => validation.promise);
		await typeInto(pathInput, "/opt/project");
		await click(findButton("Go"));
		expect(findButton("Open workspace").disabled).toBe(true);
		validation.resolve({ ok: true, path: "/opt/project" });
		await flush();
		expect(findButton("Open workspace").disabled).toBe(false);
	});

	it("shows validation failures and retries the same path", async () => {
		const remote = installRemote({
			validateDirectory: vi
				.fn<(target: SshSessionTarget, path: string) => Promise<RemoteDirectoryValidationResult>>()
				.mockResolvedValueOnce({ ok: false, error: "permission denied <script>" })
				.mockResolvedValueOnce({ ok: true, path: "/srv/new" }),
		});
		await mount(picker());
		expect(document.body.textContent).toContain("permission denied <script>");
		expect(document.body.innerHTML).not.toContain("<script>");
		expect(findButton("Open workspace").disabled).toBe(true);
		await click(findButton("Retry"));
		expect(remote.validateDirectory).toHaveBeenCalledTimes(2);
		expect(findButton("Open workspace").disabled).toBe(false);
	});

	it("keeps connection failures in-dialog with retry and SSH Settings actions", async () => {
		const remote = installRemote({
			preflight: vi
				.fn<(target: SshSessionTarget) => Promise<RemotePreflightResult>>()
				.mockResolvedValueOnce({ ok: false, error: "OMP executable not found" })
				.mockResolvedValueOnce({
					ok: true,
					target: targetFor(BUILD_HOST, "/srv/new"),
					home: "/home/danny",
					platform: "linux",
					executable: "/opt/omp",
				}),
		});
		await mount(picker());
		expect(document.body.textContent).toContain("OMP executable not found");
		await click(findButton("Open SSH Settings"));
		expect(useUiStore.getState()).toMatchObject({ settingsOpen: true, settingsTab: "ssh" });
		await click(findButton("Retry"));
		expect(remote.preflight).toHaveBeenCalledTimes(2);
		expect(inputWithLabel("Remote path").value).toBe("/srv/new");
	});

	it("saves an executable override through the remote API and canonical store", async () => {
		const canonical = { ...BUILD_HOST, executableOverride: "/opt/omp" };
		const remote = installRemote({
			setExecutableOverride: vi.fn(async () => ({
				ok: true,
				catalog: { hosts: [canonical, PROD_HOST], updatedAt: "2026-08-12T12:00:00.000Z" },
			})),
		});
		await mount(picker());
		const checkbox = queryAll('input[type="checkbox"]')[0];
		if (!checkbox) throw new Error("hidden checkbox not found");
		await setChecked(checkbox, true);
		await click(findButton("Executable override"));
		await typeInto(inputWithLabel("Executable override"), "/opt/omp");
		await click(findButton("Save override"));
		expect(remote.setExecutableOverride).toHaveBeenCalledWith("build", "/opt/omp");
		expect(useRemoteStore.getState().hosts.build?.host.executableOverride).toBe("/opt/omp");
		expect(remote.preflight).toHaveBeenLastCalledWith(
			expect.objectContaining({ executableOverride: "/opt/omp" }),
			undefined,
			expect.any(String),
		);
		expect(queryAll('input[type="checkbox"]')[0]?.checked).toBe(true);
		expect(remote.listDirectories).toHaveBeenLastCalledWith(
			expect.any(Object),
			"/srv/new",
			true,
			undefined,
			expect.any(String),
		);
	});

	it("ignores an override completion after the controlled host changes", async () => {
		const override = Promise.withResolvers<RemoteCatalogResult>();
		installRemote({ setExecutableOverride: vi.fn(() => override.promise) });
		await mount(picker());
		await click(findButton("Executable override"));
		await typeInto(inputWithLabel("Executable override"), "/opt/build-omp");
		await click(findButton("Save override"));
		await rerender(picker({ hostAlias: "prod" }));

		override.resolve({
			ok: true,
			catalog: {
				hosts: [{ ...BUILD_HOST, executableOverride: "/opt/build-omp" }, PROD_HOST],
				updatedAt: "2026-08-12T12:00:00.000Z",
			},
		});
		await flush();
		expect(useRemoteStore.getState().hosts.build?.host.executableOverride).toBeUndefined();
		expect(inputWithLabel("Remote path").value).toBe("C:\\work\\current");
	});

	it("keeps hidden state and listing arguments consistent after changing hosts", async () => {
		const remote = installRemote();
		await mount(picker());
		const checkbox = queryAll('input[type="checkbox"]')[0];
		if (!checkbox) throw new Error("hidden checkbox not found");
		await setChecked(checkbox, true);
		await rerender(picker({ hostAlias: "prod" }));
		expect(queryAll('input[type="checkbox"]')[0]?.checked).toBe(true);
		expect(remote.listDirectories).toHaveBeenLastCalledWith(
			expect.objectContaining({ hostAlias: "prod" }),
			"C:\\work\\current",
			true,
			undefined,
			expect.any(String),
		);
	});

	it("reissues the current listing when hidden changes during validation", async () => {
		const validation = Promise.withResolvers<RemoteDirectoryValidationResult>();
		const firstListing = Promise.withResolvers<RemoteDirectoryListResult>();
		const remote = installRemote();
		await mount(picker());
		remote.validateDirectory.mockImplementationOnce(() => validation.promise);
		remote.listDirectories.mockImplementationOnce(() => firstListing.promise);
		const pathInput = inputWithLabel("Remote path");
		await typeInto(pathInput, "/srv/pending");
		await click(findButton("Go"));
		const checkbox = queryAll('input[type="checkbox"]')[0];
		if (!checkbox) throw new Error("hidden checkbox not found");
		await setChecked(checkbox, true);
		expect(remote.listDirectories).toHaveBeenLastCalledWith(
			expect.any(Object),
			"/srv/pending",
			true,
			undefined,
			expect.any(String),
		);
		validation.resolve({ ok: true, path: "/srv/pending" });
		firstListing.resolve({ ok: true, path: "/srv/pending", parent: "/srv", entries: [] });
		await flush();
		expect(findButton("Open workspace").disabled).toBe(false);
	});

	it("reloads a missing host catalog before retrying preflight", async () => {
		seedHosts(BUILD_HOST);
		const remote = installRemote({
			catalog: vi.fn(async () => ({
				ok: true,
				catalog: { hosts: [BUILD_HOST, PROD_HOST], updatedAt: "2026-08-12T12:00:00.000Z" },
			})),
		});
		await mount(picker({ hostAlias: "prod" }));
		expect(document.body.textContent).toContain("no longer in the host catalog");
		await click(findButton("Retry"));
		await flush();
		expect(remote.catalog).toHaveBeenCalledOnce();
		expect(remote.preflight).toHaveBeenCalledWith(
			expect.objectContaining({ hostAlias: "prod" }),
			undefined,
			expect.any(String),
		);
		expect(inputWithLabel("Remote path").value).toBe("C:\\work\\current");
	});

	it("ignores stale preflight and path completions", async () => {
		const buildPreflight = Promise.withResolvers<RemotePreflightResult>();
		const prodPreflight = Promise.withResolvers<RemotePreflightResult>();
		const oldValidation = Promise.withResolvers<RemoteDirectoryValidationResult>();
		const oldList = Promise.withResolvers<RemoteDirectoryListResult>();
		const remote = installRemote({
			preflight: vi.fn(target => (target.hostAlias === "build" ? buildPreflight.promise : prodPreflight.promise)),
		});
		await mount(picker());
		const buildRequestId = remote.preflight.mock.calls[0]?.[2];
		expect(buildRequestId).toEqual(expect.any(String));
		await rerender(picker({ hostAlias: "prod" }));
		const prodRequestId = remote.preflight.mock.calls[1]?.[2];
		expect(prodRequestId).toEqual(expect.any(String));
		expect(prodRequestId).not.toBe(buildRequestId);
		expect(remote.cancel).toHaveBeenCalledWith(buildRequestId);
		prodPreflight.resolve({
			ok: true,
			target: targetFor(PROD_HOST, "C:\\work\\current"),
			home: "C:\\Users\\deploy",
			platform: "windows",
			executable: "C:\\Tools\\omp.exe",
		});
		await flush();
		buildPreflight.resolve({
			ok: true,
			target: targetFor(BUILD_HOST, "/srv/new"),
			home: "/home/danny",
			platform: "linux",
			executable: "/usr/bin/omp",
		});
		await flush();
		expect(inputWithLabel("Remote path").value).toBe("C:\\work\\current");

		remote.validateDirectory.mockImplementationOnce(() => oldValidation.promise);
		remote.listDirectories.mockImplementationOnce(() => oldList.promise);
		const input = inputWithLabel("Remote path");
		await typeInto(input, "C:\\old");
		await click(findButton("Go"));
		await typeInto(input, "C:\\new");
		await click(findButton("Go"));
		expect(inputWithLabel("Remote path").value).toBe("C:\\new");
		oldValidation.resolve({ ok: true, path: "C:\\old" });
		oldList.resolve({ ok: true, path: "C:\\old", parent: "C:\\", entries: [] });
		await flush();
		expect(inputWithLabel("Remote path").value).toBe("C:\\new");
	});

	it("cancels an outstanding preflight on close and ignores its late result", async () => {
		const onClose = vi.fn();
		const preflight = Promise.withResolvers<RemotePreflightResult>();
		const remote = installRemote({ preflight: vi.fn(() => preflight.promise) });
		await mount(picker({ onClose }));
		const requestId = remote.preflight.mock.calls[0]?.[2];
		expect(requestId).toEqual(expect.any(String));

		await click(findButton("Cancel"));
		expect(onClose).toHaveBeenCalledOnce();
		expect(remote.cancel).toHaveBeenCalledWith(requestId);
		preflight.resolve({
			ok: true,
			target: targetFor(BUILD_HOST, "/srv/new"),
			home: "/home/danny",
			platform: "linux",
			executable: "/usr/bin/omp",
		});
		await flush();
		expect(remote.listDirectories).not.toHaveBeenCalled();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("cancels outstanding directory work on close and ignores late results", async () => {
		const validation = Promise.withResolvers<RemoteDirectoryValidationResult>();
		const listing = Promise.withResolvers<RemoteDirectoryListResult>();
		const remote = installRemote({
			validateDirectory: vi.fn(() => validation.promise),
			listDirectories: vi.fn(() => listing.promise),
		});
		await mount(picker());
		const validationRequestId = remote.validateDirectory.mock.calls[0]?.[3];
		const listingRequestId = remote.listDirectories.mock.calls[0]?.[4];
		expect(validationRequestId).toEqual(expect.any(String));
		expect(listingRequestId).toEqual(expect.any(String));

		await click(findButton("Cancel"));
		expect(remote.cancel).toHaveBeenCalledWith(validationRequestId);
		expect(remote.cancel).toHaveBeenCalledWith(listingRequestId);
		validation.resolve({ ok: true, path: "/srv/late" });
		listing.resolve(directoryResult("/srv/late"));
		await flush();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("confirms only a copied validated target", async () => {
		let confirmed: SshSessionTarget | undefined;
		installRemote();
		await mount(
			picker({
				onConfirm: target => {
					confirmed = target;
				},
			}),
		);
		await click(findButton("Open workspace"));
		expect(confirmed).toMatchObject({ hostAlias: "build", cwd: "/srv/new", originCwd: "/srv/new" });
		expect(confirmed).not.toBe(useRemoteStore.getState().hosts.build?.host);
		expect(confirmed?.host).not.toBe(useRemoteStore.getState().hosts.build?.host.host);
	});
	it("browses an existing tab through its immutable target after the catalog host changes", async () => {
		const original = targetFor(BUILD_HOST, "/srv/original");
		const remote = installRemote();
		const onConfirm = vi.fn();
		seedHosts();

		await mount(picker({ target: original, tabId: "remote-1", onConfirm }));

		expect(remote.preflight).toHaveBeenCalledWith(original, "remote-1", expect.any(String));
		expect(remote.listDirectories).toHaveBeenCalledWith(
			original,
			"/srv/original",
			false,
			"remote-1",
			expect.any(String),
		);
		expect(remote.validateDirectory).toHaveBeenCalledWith(original, "/srv/original", "remote-1", expect.any(String));
		expect(document.body.textContent).not.toContain("Executable override");
		await click(findButton("Open workspace"));
		expect(onConfirm).toHaveBeenCalledWith(original);
	});

	it("invalidates stale existing-tab work when the owning target changes", async () => {
		const original = targetFor(BUILD_HOST, "/srv/original");
		const changed = targetFor(PROD_HOST, "C:\\work\\current");
		const preflight = Promise.withResolvers<RemotePreflightResult>();
		const remote = installRemote({ preflight: vi.fn(() => preflight.promise) });
		const onConfirm = vi.fn();
		await mount(picker({ target: original, tabId: "remote-1", onConfirm }));

		await rerender(picker({ hostAlias: "prod", target: changed, tabId: "remote-1", onConfirm }));
		preflight.resolve({
			ok: true,
			target: original,
			home: "/home/danny",
			platform: "linux",
			executable: "/usr/bin/omp",
		});
		await flush();

		expect(remote.listDirectories).not.toHaveBeenCalledWith(original, "/srv/original", false, "remote-1");
		expect(onConfirm).not.toHaveBeenCalled();
	});
});
