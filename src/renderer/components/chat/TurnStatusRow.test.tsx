import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import {
	deleteSessionRuntime,
	SessionRuntimeProvider,
	setFocusedSessionRuntime,
	withSessionRuntime,
} from "../../stores/session-runtime-context";
import { createTabRuntime } from "../../stores/tab-runtime";
import { TurnStatusRow } from "./TranscriptViewport";

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

let container: HTMLElement;
let root: Root;

async function mount(awaitingModelSince: number): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TurnStatusRow awaitingModelSince={awaitingModelSince} compactionInfo={null} retryInfo={null} />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setFocusedSessionRuntime(null);
	deleteSessionRuntime("waiting-origin");
	deleteSessionRuntime("waiting-other");
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("TurnStatusRow", () => {
	it("announces a stable waiting state without repeating the elapsed clock", async () => {
		await mount(Date.now() - 5_000);

		const status = container.querySelector('[role="status"]');
		expect(status?.textContent).not.toMatch(/\d+s/);
		expect(container.textContent).toMatch(/\d+s/);
	});

	it("stops the rendered retrying tab without cancelling or clearing the focused pane", async () => {
		const commandForTab = vi.fn(async (_tabId: string, command: RpcCommand) => ({
			type: "response" as const,
			command: command.type,
			success: true as const,
		}));
		window.omp = { rpc: { commandForTab } } as unknown as typeof window.omp;
		const origin = createTabRuntime("waiting-origin");
		createTabRuntime("waiting-other");
		const retryInfo = {
			attempt: 2,
			maxAttempts: 5,
			delayMs: 5_000,
			errorMessage: "overloaded",
			startedAt: Date.now(),
		};
		withSessionRuntime("waiting-origin", () =>
			useSessionStore.setState({ status: "ready", isStreaming: true, retryInfo }),
		);
		withSessionRuntime("waiting-other", () =>
			useSessionStore.setState({ status: "ready", isStreaming: true, retryInfo: { ...retryInfo, attempt: 3 } }),
		);
		setFocusedSessionRuntime("waiting-other");
		await mount(Date.now() - 5_000);
		await act(async () => {
			root.render(
				<I18nProvider>
					<SessionRuntimeProvider runtime={origin}>
						<TurnStatusRow awaitingModelSince={null} compactionInfo={null} retryInfo={retryInfo} />
					</SessionRuntimeProvider>
				</I18nProvider>,
			);
		});
		const stop = container.querySelector("button");
		expect(stop).not.toBeNull();
		if (!stop) throw new Error("Inline Stop is unavailable");
		await act(async () => stop.dispatchEvent(new Event("click", { bubbles: true })));
		expect(commandForTab.mock.calls.map(([tabId, command]) => [tabId, command.type])).toEqual([
			["waiting-origin", "abort_retry"],
			["waiting-origin", "abort"],
		]);
		expect(withSessionRuntime("waiting-origin", () => useSessionStore.getState().retryInfo)).toBeNull();
		expect(withSessionRuntime("waiting-other", () => useSessionStore.getState().retryInfo?.attempt)).toBe(3);
	});

	it("does not expose Stop in a read-only collaboration session", async () => {
		useSessionStore.setState({ collab: { role: "guest", readOnly: true, participants: [] } });
		await mount(Date.now() - 5_000);
		expect(container.querySelector("button")).toBeNull();
	});

	it("cannot clear a replacement tab runtime from a retired Stop control", async () => {
		const commandForTab = vi.fn(async (_tabId: string, command: RpcCommand) => ({
			type: "response" as const,
			command: command.type,
			success: true as const,
		}));
		window.omp = { rpc: { commandForTab } } as unknown as typeof window.omp;
		const origin = createTabRuntime("waiting-origin");
		const retryInfo = {
			attempt: 1,
			maxAttempts: 3,
			delayMs: 5_000,
			errorMessage: "overloaded",
			startedAt: Date.now(),
		};
		withSessionRuntime("waiting-origin", () => useSessionStore.setState({ status: "ready", retryInfo }));
		await mount(Date.now() - 5_000);
		await act(async () => {
			root.render(
				<I18nProvider>
					<SessionRuntimeProvider runtime={origin}>
						<TurnStatusRow awaitingModelSince={null} compactionInfo={null} retryInfo={retryInfo} />
					</SessionRuntimeProvider>
				</I18nProvider>,
			);
		});
		const stop = container.querySelector("button");
		if (!stop) throw new Error("Inline Stop is unavailable");
		createTabRuntime("waiting-origin");
		withSessionRuntime("waiting-origin", () =>
			useSessionStore.setState({ status: "ready", retryInfo: { ...retryInfo, attempt: 2 } }),
		);
		await act(async () => stop.dispatchEvent(new Event("click", { bubbles: true })));
		expect(withSessionRuntime("waiting-origin", () => useSessionStore.getState().retryInfo?.attempt)).toBe(2);
		expect(commandForTab).not.toHaveBeenCalled();
	});
});
