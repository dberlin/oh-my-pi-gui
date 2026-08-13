import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SshSessionTarget } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { resetTabRoute } from "../../lib/tab-routing";
import { useTabsStore } from "../../stores/tabs";

const { document, window, Event, CustomEvent, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	document,
	window,
	Event,
	CustomEvent,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

// React DOM computes DOM support at evaluation time, so the test harness must install linkedom first.
const { createRoot } = await import("react-dom/client");
const { FilesPanel } = await import("./FilesPanel");

interface TestElement {
	remove(): void;
	dispatchEvent(event: object): boolean;
	textContent: string | null;
}

interface MockFs {
	list: Mock;
	read: Mock;
}

const REMOTE_TARGET: SshSessionTarget = {
	type: "ssh",
	hostAlias: "build",
	host: {
		host: "build.example.test",
		username: "deploy",
		sourceId: "test",
		sourceLevel: "project",
		os: "linux",
	},
	originCwd: "/srv/app",
	cwd: "/srv/app",
};

const ompWindow = window as unknown as { omp: { fs: MockFs } };

let container: TestElement | undefined;
let root: Root | undefined;

function installFs(): MockFs {
	const fs: MockFs = {
		list: vi.fn(async () => ({
			ok: true,
			entries: [{ name: "same-name.txt", path: "same-name.txt", kind: "file" }],
			truncated: false,
		})),
		read: vi.fn(async () => ({
			ok: true,
			content: "remote-only preview",
			truncated: false,
			binary: false,
			size: 19,
		})),
	};
	ompWindow.omp = { fs };
	return fs;
}

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

async function click(element: TestElement): Promise<void> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		element.dispatchEvent(event);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
	}
	container?.remove();
	container = undefined;
	root = undefined;
	useTabsStore.getState().reset();
	resetTabRoute();
	vi.restoreAllMocks();
});

describe("FilesPanel remote preview", () => {
	it("keeps the SSH preview payload target-free so main routes and bounds the remote read", async () => {
		const fs = installFs();
		useTabsStore.setState({
			tabs: [
				{
					id: "remote-1",
					cwd: REMOTE_TARGET.cwd,
					target: REMOTE_TARGET,
					status: "ready",
					kind: "agent",
					unreadDone: false,
				},
			],
			activeTabId: "remote-1",
		});

		await mount(<FilesPanel />);
		expect(fs.list).toHaveBeenCalledWith(undefined, 8, 2000);

		const row = document.querySelector('[data-tree-id="file:same-name.txt"]') as unknown as TestElement | null;
		if (!row) throw new Error("remote file row missing");
		await click(row);

		expect(fs.read).toHaveBeenCalledWith("same-name.txt", 200_000);
		expect(document.body.textContent).toContain("remote-only preview");
	});
});
