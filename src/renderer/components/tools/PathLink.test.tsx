import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshSessionTarget } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const openPath = vi.fn(async (_path: string, _tabId?: string) => ({ ok: true, resolvedPath: "/resolved" }));
const ompWindow = window as unknown as { omp: { system: { openPath: typeof openPath } } };
ompWindow.omp = { system: { openPath } };

const { createRoot } = await import("react-dom/client");
const { PathLink } = await import("./PathLink");
const { useTabsStore } = await import("../../stores/tabs");
const { useUiStore } = await import("../../stores/ui");

const REMOTE_TARGET: SshSessionTarget = {
	type: "ssh",
	hostAlias: "pi",
	host: {
		host: "pi.example.test",
		username: "dannyb",
		sourceId: "test",
		sourceLevel: "project",
		os: "linux",
	},
	originCwd: "/home/dannyb/sources/PiFire",
	cwd: "/home/dannyb/sources/PiFire",
};

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

function seedTab(target: SshSessionTarget | { type: "local" }): void {
	useTabsStore.setState({
		tabs: [{ id: "tab-1", cwd: "/local/workspace", target, status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "tab-1",
	});
}

async function clickLink(): Promise<void> {
	const link = container.querySelector("button");
	if (!link) throw new Error("Missing path link");
	await act(async () => {
		link.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	openPath.mockClear();
	useUiStore.setState({ filePreviewPath: null });
});

describe("PathLink", () => {
	it("opens a local workspace file through the owning tab so split panes resolve against the right cwd", async () => {
		seedTab({ type: "local" });
		await mount(<PathLink path="docs/plan.md" />);

		await clickLink();

		expect(openPath).toHaveBeenCalledWith("docs/plan.md", "tab-1");
	});

	it("previews a remote file in-app instead of trying to open it on the local machine", async () => {
		seedTab(REMOTE_TARGET);
		await mount(<PathLink path="/home/dannyb/sources/PiFire/task-1-tests-brief.md" />);

		await clickLink();

		expect(openPath).not.toHaveBeenCalled();
		expect(useUiStore.getState().filePreviewPath).toBe("/home/dannyb/sources/PiFire/task-1-tests-brief.md");
	});

	it("reveals the file panel when previewing a remote file", async () => {
		seedTab(REMOTE_TARGET);
		await mount(<PathLink path="notes.md" />);

		await clickLink();

		expect(useUiStore.getState().panelTab).toBe("files");
		expect(useUiStore.getState().panelVisible).toBe(true);
	});
});
