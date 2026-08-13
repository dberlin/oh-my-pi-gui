/**
 * Contract tests for markdown image rendering: remote URLs and inline data:
 * URLs must survive sanitization and render as <img>, local paths route to
 * the fs:read-image IPC (SSR shows the path placeholder — resolution is an
 * effect), and hostile protocols stay stripped.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SshSessionTarget } from "../../shared/ipc-types";
import { useTabsStore } from "../stores/tabs";
import { I18nProvider } from "./i18n";
import { classifyImageSrc, MarkdownRenderer } from "./markdown";
import { resetTabRoute } from "./tab-routing";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});

// React DOM computes DOM support at evaluation time, so the test harness must install linkedom first.
const { createRoot } = await import("react-dom/client");

interface TestElement {
	remove(): void;
	textContent: string | null;
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

const readImage: Mock = vi.fn();
const ompWindow = window as unknown as { omp: { fs: { readImage: Mock } } };
ompWindow.omp = { fs: { readImage } };

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
		root?.render(element);
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
	readImage.mockReset();
	useTabsStore.getState().reset();
	resetTabRoute();
});

function render(content: string): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<MarkdownRenderer content={content} />
		</I18nProvider>,
	);
}

const TINY_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("classifyImageSrc", () => {
	it("passes data:, blob:, and http(s): URLs through directly", () => {
		expect(classifyImageSrc(TINY_PNG)).toEqual({ kind: "direct", src: TINY_PNG });
		expect(classifyImageSrc("blob:https://app/uuid")).toEqual({ kind: "direct", src: "blob:https://app/uuid" });
		expect(classifyImageSrc("https://example.com/x.png")).toEqual({
			kind: "direct",
			src: "https://example.com/x.png",
		});
		expect(classifyImageSrc("http://localhost:8080/x.png")).toEqual({
			kind: "direct",
			src: "http://localhost:8080/x.png",
		});
	});

	it("upgrades protocol-relative URLs to https", () => {
		expect(classifyImageSrc("//cdn.example.com/x.png")).toEqual({
			kind: "direct",
			src: "https://cdn.example.com/x.png",
		});
	});

	it("routes bare absolute, relative, and plain paths to the local read", () => {
		expect(classifyImageSrc("/Users/x/shot.png")).toEqual({ kind: "local", path: "/Users/x/shot.png" });
		expect(classifyImageSrc("./shots/x.png")).toEqual({ kind: "local", path: "./shots/x.png" });
		expect(classifyImageSrc("../out/x.png")).toEqual({ kind: "local", path: "../out/x.png" });
		expect(classifyImageSrc("x.png")).toEqual({ kind: "local", path: "x.png" });
	});

	it("strips file:// and decodes escapes for the local read", () => {
		expect(classifyImageSrc("file:///tmp/my%20shot.png")).toEqual({ kind: "local", path: "/tmp/my shot.png" });
	});

	it("rejects empty src", () => {
		expect(classifyImageSrc(undefined)).toEqual({ kind: "none" });
		expect(classifyImageSrc("")).toEqual({ kind: "none" });
	});
});

describe("markdown images", () => {
	it("renders inline data: URLs — sanitize must not strip the src", () => {
		const html = render(`![pixel](${TINY_PNG})`);
		expect(html).toContain("<img");
		expect(html).toContain(encodeURI(TINY_PNG).replace(/&/g, "&amp;"));
		expect(html).toContain('alt="pixel"');
	});

	it("renders remote https images with themed sizing", () => {
		const html = render("![shot](https://example.com/shot.png)");
		expect(html).toContain('src="https://example.com/shot.png"');
		expect(html).toContain("max-h-72");
	});

	it("renders local paths as a resolving placeholder carrying the path", () => {
		const html = render("![screen](./captures/screen.png)");
		expect(html).toContain("screen");
		expect(html).toContain("./captures/screen.png");
		expect(html).not.toContain('src="./captures/screen.png"');
	});

	it("strips javascript: URLs from raw HTML images", () => {
		const html = render('<img src="javascript:alert(1)" alt="x">');
		expect(html).not.toContain("javascript:");
	});

	it("keeps file: URLs for local resolution instead of dropping the src", () => {
		const html = render("![snap](file:///tmp/snap.png)");
		expect(html).toContain("/tmp/snap.png");
	});

	it("keeps an SSH markdown image payload target-free and renders the data returned by main", async () => {
		readImage.mockResolvedValue({
			ok: true,
			dataUrl: TINY_PNG,
			mime: "image/png",
			size: 68,
		});
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

		await mount(
			<I18nProvider>
				<MarkdownRenderer content="![remote only](same-name.png)" />
			</I18nProvider>,
		);

		expect(readImage).toHaveBeenCalledWith("same-name.png");
		const image = document.querySelector('img[alt="remote only"]');
		expect(image?.getAttribute("src")).toBe(TINY_PNG);
	});
});
