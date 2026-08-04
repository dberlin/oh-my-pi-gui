/**
 * Registers omp:// protocol and handles deep links.
 * Supports omp://session/<id> and omp://new.
 */
import { app } from "electron";
import { type DeepLinkPayload, IPC_EVENTS } from "../shared/ipc-types";
import type { WindowManager } from "./window";

const PROTOCOL = "omp";

export function setupDeepLinks(windowManager: WindowManager): void {
	// Register as default protocol handler (Windows/Linux)
	if (process.defaultApp && process.argv.length >= 2) {
		app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [process.argv[1]]);
	} else {
		app.setAsDefaultProtocolClient(PROTOCOL);
	}

	// macOS: open-url event
	app.on("open-url", (event, url) => {
		event.preventDefault();
		handleDeepLink(url, windowManager);
	});

	// Windows/Linux: second-instance with protocol URL in argv
	app.on("second-instance", (_event, argv) => {
		const url = argv.find(arg => arg.startsWith(`${PROTOCOL}://`));
		if (url) {
			handleDeepLink(url, windowManager);
		}
	});
}

function handleDeepLink(url: string, windowManager: WindowManager): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return;
	}

	const win = windowManager.getMainWindow() ?? windowManager.createWindow();
	win.show();
	win.focus();

	// new URL puts the first segment of a scheme:// URL into hostname, not
	// pathname: omp://new → host "new", omp://session/<id> → host "session" +
	// path "/<id>". (Hostname case is preserved for non-special schemes.)
	let payload: DeepLinkPayload | null = null;
	const host = parsed.hostname.toLowerCase();
	if (host === "new") {
		payload = { action: "new-session" };
	} else if (host === "session") {
		const sessionId = parsed.pathname.replace(/^\/+|\/+$/g, "");
		if (sessionId) {
			payload = { action: "switch-session", sessionId };
		}
	}
	if (!payload) return;

	// Cold start: the renderer only subscribes after load — hold the link until
	// then, otherwise it is silently dropped.
	const link = payload;
	if (win.webContents.isLoading()) {
		win.webContents.once("did-finish-load", () => {
			if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.DEEP_LINK, link);
		});
	} else {
		win.webContents.send(IPC_EVENTS.DEEP_LINK, link);
	}
}
