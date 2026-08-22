import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { useToolsStore } from "../../stores/tools";
import { TitleBar } from "./TitleBar";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

interface TestButton {
	title: string;
	click: () => void;
}

interface TestElement {
	textContent: string | null;
	remove: () => void;
	querySelectorAll: (selector: string) => TestButton[];
}

const sessions = {
	list: vi.fn(async () => []),
	delete: vi.fn(async () => {}),
	rename: vi.fn(async () => {}),
};
const events = {
	onSessionsChanged: vi.fn(() => () => {}),
};
const getSessionStats = vi.fn(async () => ({
	type: "response" as const,
	command: "get_session_stats",
	success: true as const,
	data: {
		sessionId: "session-1",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 1,
		toolResults: 1,
		totalMessages: 3,
		tokens: { input: 100, output: 1_100, reasoning: 0, cacheRead: 200, cacheWrite: 100, total: 1_500 },
		premiumRequests: 0,
		cost: 0.1234,
	},
}));
(
	window as unknown as {
		omp: { sessions: typeof sessions; events: typeof events; rpc: { getSessionStats: typeof getSessionStats } };
	}
).omp = { sessions, events, rpc: { getSessionStats } };

let container: TestElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TitleBar />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useToolsStore.getState().reset();
	vi.clearAllMocks();
});

describe("TitleBar", () => {
	it("shows authoritative session usage and merged execution wall time", async () => {
		useSessionStore.setState({ status: "ready", sessionId: "session-1", cwd: "/tmp/project" });
		useMessagesStore.setState({
			messages: [{ role: "assistant", timestamp: 1_000, duration: 2_000 }],
		});
		useToolsStore.setState({
			activeTools: new Map([
				[
					"tool-1",
					{
						toolName: "read",
						args: {},
						status: "done",
						partialResult: null,
						streamingArgs: "",
						result: null,
						isError: false,
						startTime: 3_000,
						endTime: 6_000,
					},
				],
			]),
		});
		await mount();
		await act(async () => Promise.resolve());

		expect(container.textContent).toContain("1.5k");
		expect(container.textContent).toContain("$0.1234");
		expect(container.textContent).toContain("50%");
		expect(container.textContent).toContain("5.0s");
		expect(container.querySelectorAll(".omp-signal-light")).toHaveLength(1);
		expect(container.querySelectorAll(".omp-signal-light--active")).toHaveLength(0);
		expect(getSessionStats).toHaveBeenCalledTimes(1);
	});
});
