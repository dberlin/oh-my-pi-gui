import { afterEach, expect, it, vi } from "vitest";
import { WindowManager } from "./window";

const native = vi.hoisted(() => ({ nextId: 1, sent: [] as Array<{ id: number; channel: string }> }));
vi.mock("node:original-fs", () => ({ statSync: vi.fn() }));
vi.mock("electron", () => ({
	app: { isPackaged: false, getLocale: () => "en" },
	BrowserWindow: class {
		destroyed = false;
		webContents = {
			id: native.nextId++,
			on: vi.fn(),
			isDestroyed: () => this.destroyed,
			setWindowOpenHandler: vi.fn(),
			send: (channel: string) => native.sent.push({ id: this.webContents.id, channel }),
		};
		on = vi.fn();
		once = vi.fn();
		loadFile = vi.fn();
		loadURL = vi.fn();
		isDestroyed = () => this.destroyed;
		destroy = () => { this.destroyed = true; };
	},
	Menu: {}, dialog: {}, screen: {}, shell: {},
}));
vi.mock("electron-store", () => ({
	default: class {
		get(_key: string, fallback: unknown): unknown { return fallback; }
	},
}));

afterEach(() => {
	vi.unstubAllGlobals();
	native.sent.length = 0;
});

it("retains an entry locator until its destination window pulls it and signals only that renderer", () => {
	vi.stubGlobal("__dirname", process.cwd());
	const manager = new WindowManager();
	const owner = manager.createWindow({ cwd: "/project" });
	const caller = manager.createWindow({ cwd: "/other" });
	const request = { sessionPath: "/sessions/a.jsonl", entryId: "entry-7" };
	expect(manager.queueConversationFocus(owner.webContents.id, request)).toBe(true);
	expect(native.sent).toEqual([{ id: owner.webContents.id, channel: "conversation:focus" }]);
	expect(manager.consumePendingConversationFocus(caller)).toBeNull();
	expect(manager.consumePendingConversationFocus(owner)).toEqual(request);
	expect(manager.consumePendingConversationFocus(owner)).toBeNull();
	owner.destroy();
	expect(manager.queueConversationFocus(owner.webContents.id, request)).toBe(false);
	expect(manager.queueConversationFocus(99999, request)).toBe(false);
});
