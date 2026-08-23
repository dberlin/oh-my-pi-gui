import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { loadDismissal, subscribeUpdaterStatus, useUpdaterStore } from "../../stores/updater";
import { UpdateBanner } from "./UpdateBanner";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	click: () => void;
	remove: () => void;
	querySelectorAll: (selector: string) => TestElement[];
}

const check = vi.fn<() => Promise<UpdateStatus>>();
const download = vi.fn<() => Promise<UpdateStatus>>();
const apply = vi.fn<() => Promise<void>>();
const getStatus = vi.fn<() => Promise<UpdateStatus>>();
Object.assign(window, {
	omp: {
		updater: { check, download, apply, getStatus },
		events: { onUpdaterStatus: () => () => {} },
	},
});

let container: TestElement;
let root: Root | undefined;
let storage: Record<string, string>;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
}

beforeEach(() => {
	storage = {};
	globals.localStorage = {
		getItem: (key: string) => storage[key] ?? null,
		setItem: (key: string, value: string) => {
			storage[key] = value;
		},
	};
	useUpdaterStore.setState({ status: { state: "idle" }, dismissed: {} });
	check.mockReset().mockResolvedValue({ state: "checking" });
	download.mockReset().mockResolvedValue({ state: "idle" });
	apply.mockReset().mockResolvedValue(undefined);
	getStatus.mockReset().mockResolvedValue({ state: "idle" });
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = undefined;
	container?.remove();
	delete globals.localStorage;
	useUpdaterStore.setState({ status: { state: "idle" }, dismissed: {} });
});

describe("UpdateBanner", () => {
	it.each(["manual", "automatic"] as const)("starts the %s download from the available notice", async mode => {
		useUpdaterStore.getState().setStatus({ state: "available", version: "0.8.5", mode });
		download.mockImplementation(async () => {
			const status: UpdateStatus = {
				state: "downloading",
				version: "0.8.5",
				mode,
				percent: 42,
				bytesPerSecond: 1,
				transferred: 42,
				total: 100,
			};
			useUpdaterStore.getState().setStatus(status);
			return status;
		});
		await mount(<UpdateBanner />);

		await act(async () => {
			container.querySelectorAll("button")[0]?.click();
		});
		expect(container.textContent).toContain("42%");
		expect(container.querySelectorAll("button")).toHaveLength(0);
	});

	it.each(["manual", "automatic"] as const)("applies the downloaded %s update", async mode => {
		useUpdaterStore.getState().setStatus({ state: "downloaded", version: "0.8.5", mode });
		await mount(<UpdateBanner />);

		await act(async () => {
			container.querySelectorAll("button")[0]?.click();
		});
		expect(apply).toHaveBeenCalledOnce();
		// Manual installation keeps the action available to reopen Finder.
		expect(container.querySelectorAll("button")).toHaveLength(1);
	});

	it("keeps a declined release hidden after restart without hiding a newer release", async () => {
		useUpdaterStore.getState().setStatus({ state: "available", version: "0.8.5", mode: "manual" });
		await mount(<UpdateBanner />);
		const [dismissButton] = container.querySelectorAll('[data-update-action="dismiss"]');
		expect(dismissButton).toBeDefined();
		await act(async () => {
			dismissButton?.click();
		});
		expect(container.textContent).toBe("");

		await act(async () => {
			useUpdaterStore.setState({ status: { state: "idle" }, dismissed: {} });
			useUpdaterStore.setState({ dismissed: loadDismissal() });
			useUpdaterStore.getState().setStatus({ state: "available", version: "0.8.5", mode: "manual" });
		});
		expect(container.textContent).toBe("");
		await act(async () => {
			useUpdaterStore.getState().setStatus({ state: "available", version: "0.8.6", mode: "manual" });
		});
		expect(container.textContent).toContain("0.8.6");
	});

	it.each([
		{ phase: "check", initial: { state: "checking" } },
		{
			phase: "download",
			initial: {
				state: "downloading",
				version: "0.8.5",
				mode: "manual",
				percent: 42,
				bytesPerSecond: 1,
				transferred: 42,
				total: 100,
			},
		},
		{ phase: "install", initial: { state: "downloaded", version: "0.8.5", mode: "manual" } },
	] satisfies { phase: string; initial: UpdateStatus }[])(
		"shows a $phase failure and lets retry rediscover the available update",
		async ({ phase, initial }) => {
			useUpdaterStore.getState().setStatus(initial);
			await mount(<UpdateBanner />);
			const message = `${phase} failed`;
			await act(async () => {
				useUpdaterStore.getState().setStatus({ state: "error", message, showInBanner: true });
			});
			expect(container.textContent).toContain(message);
			check.mockImplementation(async () => {
				useUpdaterStore.getState().setStatus({ state: "checking" });
				const status: UpdateStatus = { state: "available", version: "0.8.6", mode: "manual" };
				useUpdaterStore.getState().setStatus(status);
				return status;
			});
			await act(async () => {
				container.querySelectorAll("button")[0]?.click();
			});
			expect(container.textContent).not.toContain(message);
			expect(container.textContent).toContain("0.8.6");
		},
	);

	it("keeps dismissed failures hidden across restart and failed checks, then re-arms after recovery", async () => {
		const failure: UpdateStatus = {
			state: "error",
			message: "This release has no installer for this Mac.",
			showInBanner: true,
			version: "0.9.1",
		};
		useUpdaterStore.getState().setStatus(failure);
		await mount(<UpdateBanner />);
		const [dismissButton] = container.querySelectorAll('[data-update-action="dismiss"]');
		expect(dismissButton).toBeDefined();
		await act(async () => {
			dismissButton?.click();
		});
		expect(container.textContent).toBe("");

		getStatus.mockResolvedValue(failure);
		let unsubscribe: (() => void) | undefined;
		await act(async () => {
			useUpdaterStore.setState({ status: { state: "idle" }, dismissed: {} });
			useUpdaterStore.setState({ dismissed: loadDismissal() });
			unsubscribe = subscribeUpdaterStatus();
		});
		unsubscribe?.();
		expect(container.textContent).toBe("");
		await act(async () => {
			useUpdaterStore.getState().setStatus({ state: "checking" });
		});
		expect(container.textContent).toBe("");
		await act(async () => {
			useUpdaterStore.getState().setStatus({ state: "error", message: "A different poll failure" });
		});
		expect(container.textContent).toBe("");

		await act(async () => {
			useUpdaterStore.getState().setStatus({ state: "not-available", version: "0.9.1" });
			useUpdaterStore.getState().setStatus(failure);
		});
		expect(container.textContent).toContain("This release has no installer for this Mac.");
		await act(async () => {
			useUpdaterStore.setState({ status: { state: "idle" }, dismissed: loadDismissal() });
			useUpdaterStore.getState().setStatus(failure);
		});
		expect(container.textContent).toContain("This release has no installer for this Mac.");
	});

	it("keeps passive polling failures out of the banner", async () => {
		useUpdaterStore.getState().setStatus({ state: "error", message: "Offline", showInBanner: false });
		await mount(<UpdateBanner />);
		expect(container.querySelectorAll("button")).toHaveLength(0);
		expect(container.textContent).toBe("");
	});
});
