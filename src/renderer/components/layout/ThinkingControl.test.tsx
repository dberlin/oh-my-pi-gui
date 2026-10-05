/**
 * The thinking picker offers only concrete levels reported by the sidecar.
 * Empty mutation receipts are reconciled from get_state, never guessed.
 * Rendered with react-dom/client into a linkedom document.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse, RpcSessionState, ThinkingLevel } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { type ModelStore, useModelStore } from "../../stores/model";
import { type SessionStore, useSessionStore } from "../../stores/session";
import {
	deleteSessionRuntime,
	SessionRuntimeProvider,
	sessionRuntimeStore,
	setFocusedSessionRuntime,
} from "../../stores/session-runtime-context";
import { createTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { ThinkingControl } from "./ThinkingControl";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
elementPrototype.getBoundingClientRect = () => ({
	bottom: 0,
	height: 0,
	left: 0,
	right: 0,
	top: 0,
	width: 0,
	x: 0,
	y: 0,
	toJSON: () => ({}),
});
Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });

interface TestElement {
	textContent: string | null;
	remove: () => void;
	appendChild: (child: TestElement) => void;
	dispatchEvent: (event: object) => boolean;
}

let setThinkingLevelMock: Mock<(level: ThinkingLevel) => Promise<RpcResponse>>;
let getStateMock: Mock<() => Promise<RpcResponse>>;

function stateReply(thinkingLevel: ThinkingLevel): RpcResponse {
	return {
		type: "response",
		command: "get_state",
		success: true,
		data: { thinkingLevel } as RpcSessionState,
	};
}

function installMockOmp(): void {
	setThinkingLevelMock = vi.fn(async (_level: ThinkingLevel): Promise<RpcResponse> => ({
		type: "response",
		command: "set_thinking_level",
		success: true,
	}));
	getStateMock = vi.fn(async () => stateReply("high"));
	const ompWindow = window as unknown as {
		omp: { rpc: { setThinkingLevel: typeof setThinkingLevelMock; getState: typeof getStateMock } };
	};
	ompWindow.omp = { rpc: { setThinkingLevel: setThinkingLevelMock, getState: getStateMock } };
}

let container: TestElement;
let root: Root;

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
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

function click(element: TestElement): void {
	element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
}

function buttonWithMono(text: string): TestElement | undefined {
	const buttons = Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
	return buttons.find(button => button.textContent?.includes(text));
}

/** The control renders localized level names, not the raw wire enum. */
function labelFor(level: string): string {
	return translate(`input.thinking.name.${level}`);
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	// The menu portals to document.body — sweep any leftovers between tests.
	document.body.innerHTML = "";
	setFocusedSessionRuntime(null);
	deleteSessionRuntime("thinking-one");
	deleteSessionRuntime("thinking-two");
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
});

describe("ThinkingControl", () => {
	it("lists exactly the reported concrete levels with the effective level checked", async () => {
		installMockOmp();
		useModelStore.setState({
			thinkingLevel: "medium",
			availableThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		});
		await mount(<ThinkingControl />);

		const trigger = buttonWithMono(labelFor("medium"));
		expect(trigger).toBeDefined();
		if (!trigger) return;
		await act(async () => {
			click(trigger);
		});

		const body = document.body.textContent ?? "";
		for (const option of ["low", "medium", "high", "xhigh", "max"]) {
			expect(body).toContain(labelFor(option));
		}
		// Unsupported levels must not be offered.
		expect(body).not.toContain(labelFor("minimal"));
		expect(body).not.toContain(labelFor("auto"));
		expect(body).not.toContain(labelFor("off"));
	});

	it("reconciles an empty successful receipt from authoritative state", async () => {
		installMockOmp();
		useModelStore.setState({
			thinkingLevel: "medium",
			availableThinkingLevels: ["low", "medium", "high"],
		});
		await mount(<ThinkingControl />);

		const trigger = buttonWithMono(labelFor("medium"));
		if (!trigger) throw new Error("trigger missing");
		await act(async () => {
			click(trigger);
		});
		const high = buttonWithMono(labelFor("high"));
		expect(high).toBeDefined();
		if (!high) return;
		await act(async () => {
			click(high);
		});
		await flush();

		expect(setThinkingLevelMock).toHaveBeenCalledWith("high");
		expect(getStateMock).toHaveBeenCalledOnce();
		expect(useModelStore.getState().thinkingLevel).toBe("high");
	});

	it("shows the effective clamped level returned by the sidecar", async () => {
		installMockOmp();
		getStateMock.mockResolvedValue(stateReply("high"));
		useModelStore.setState({
			thinkingLevel: "medium",
			availableThinkingLevels: ["low", "medium", "high", "xhigh", "max"],
		});
		await mount(<ThinkingControl />);

		const trigger = buttonWithMono(labelFor("medium"));
		if (!trigger) throw new Error("trigger missing");
		await act(async () => click(trigger));
		const max = buttonWithMono(labelFor("max"));
		if (!max) throw new Error("max option missing");
		await act(async () => click(max));
		await flush();

		expect(setThinkingLevelMock).toHaveBeenCalledWith("max");
		expect(useModelStore.getState().thinkingLevel).toBe("high");
	});

	it("does not apply a late receipt to a different tab", async () => {
		installMockOmp();
		const receipt = Promise.withResolvers<RpcResponse>();
		setThinkingLevelMock.mockReturnValue(receipt.promise);
		useTabsStore.setState({
			tabs: [
				{
					id: "t0",
					cwd: "/one",
					target: { type: "local" },
					status: "ready",
					kind: "agent",
					unreadDone: false,
				},
				{
					id: "t1",
					cwd: "/two",
					target: { type: "local" },
					status: "ready",
					kind: "agent",
					unreadDone: false,
				},
			],
			activeTabId: "t0",
			bundles: new Map(),
		});
		useSessionStore.setState({ sessionId: "session-one" });
		useModelStore.setState({
			thinkingLevel: "medium",
			availableThinkingLevels: ["medium", "high"],
		});
		await mount(<ThinkingControl />);

		const trigger = buttonWithMono(labelFor("medium"));
		if (!trigger) throw new Error("trigger missing");
		await act(async () => click(trigger));
		const high = buttonWithMono(labelFor("high"));
		if (!high) throw new Error("high option missing");
		await act(async () => click(high));

		await act(async () => {
			useTabsStore.setState({ activeTabId: "t1" });
			useSessionStore.setState({ sessionId: "session-two" });
			useModelStore.setState({ thinkingLevel: "low" });
			receipt.resolve({
				type: "response",
				command: "set_thinking_level",
				success: true,
			});
		});
		await flush();

		expect(getStateMock).not.toHaveBeenCalled();
		expect(useModelStore.getState().thinkingLevel).toBe("low");
	});

	it("reconciles into the owning pane after focus moves to another runtime", async () => {
		const receipt = Promise.withResolvers<RpcResponse>();
		const commandForTab = vi.fn(async (tabId: string, command: { type: string }): Promise<RpcResponse> => {
			if (tabId !== "thinking-one") throw new Error("wrong command owner");
			if (command.type === "set_thinking_level") return receipt.promise;
			if (command.type === "get_state") return stateReply("high");
			throw new Error(`unexpected ${command.type}`);
		});
		(window as unknown as Record<string, unknown>).omp = { rpc: { commandForTab } };
		const owner = createTabRuntime("thinking-one");
		createTabRuntime("thinking-two");
		const model = sessionRuntimeStore<ModelStore>("thinking-one", "model")!;
		const other = sessionRuntimeStore<ModelStore>("thinking-two", "model")!;
		sessionRuntimeStore<SessionStore>("thinking-one", "session")!.setState({ sessionId: "one" });
		sessionRuntimeStore<SessionStore>("thinking-two", "session")!.setState({ sessionId: "two" });
		model.setState({ thinkingLevel: "medium", availableThinkingLevels: ["medium", "high"] });
		other.setState({ thinkingLevel: "low" });
		setFocusedSessionRuntime("thinking-one");
		await mount(
			<SessionRuntimeProvider runtime={owner}>
				<ThinkingControl />
			</SessionRuntimeProvider>,
		);
		const trigger = buttonWithMono(labelFor("medium"));
		if (!trigger) throw new Error("trigger missing");
		await act(async () => click(trigger));
		const high = buttonWithMono(labelFor("high"));
		if (!high) throw new Error("high option missing");
		await act(async () => click(high));
		await act(async () => {
			setFocusedSessionRuntime("thinking-two");
			receipt.resolve({ type: "response", command: "set_thinking_level", success: true });
		});
		await flush();
		expect(model.getState().thinkingLevel).toBe("high");
		expect(other.getState().thinkingLevel).toBe("low");
		expect(commandForTab.mock.calls.map(([tabId]) => tabId)).toEqual(["thinking-one", "thinking-one"]);
	});

	it("does not apply state readback after the owning session changes", async () => {
		installMockOmp();
		const state = Promise.withResolvers<RpcResponse>();
		getStateMock.mockReturnValue(state.promise);
		useSessionStore.setState({ sessionId: "session-one" });
		useModelStore.setState({ thinkingLevel: "medium", availableThinkingLevels: ["medium", "high"] });
		await mount(<ThinkingControl />);
		const trigger = buttonWithMono(labelFor("medium"));
		if (!trigger) throw new Error("trigger missing");
		await act(async () => click(trigger));
		const high = buttonWithMono(labelFor("high"));
		if (!high) throw new Error("high option missing");
		await act(async () => click(high));
		await act(async () => {
			useSessionStore.setState({ sessionId: "session-two" });
			useModelStore.setState({ thinkingLevel: "low" });
			state.resolve(stateReply("high"));
		});
		await flush();
		expect(useModelStore.getState().thinkingLevel).toBe("low");
	});

	it("leaves the effective level unchanged when state reconciliation fails", async () => {
		installMockOmp();
		getStateMock.mockResolvedValue({
			type: "response",
			command: "get_state",
			success: false,
			error: "unavailable",
		});
		useModelStore.setState({ thinkingLevel: "medium", availableThinkingLevels: ["medium", "high"] });
		await mount(<ThinkingControl />);
		const trigger = buttonWithMono(labelFor("medium"));
		if (!trigger) throw new Error("trigger missing");
		await act(async () => click(trigger));
		const high = buttonWithMono(labelFor("high"));
		if (!high) throw new Error("high option missing");
		await act(async () => click(high));
		await flush();
		expect(useModelStore.getState().thinkingLevel).toBe("medium");
	});

	it("shows an honest unavailable note when no levels were reported", async () => {
		installMockOmp();
		useModelStore.setState({ thinkingLevel: undefined, availableThinkingLevels: [] });
		await mount(<ThinkingControl />);

		const trigger = buttonWithMono(labelFor("off"));
		if (!trigger) throw new Error("trigger missing");
		await act(async () => {
			click(trigger);
		});
		expect(document.body.textContent).toContain(translate("input.thinking.unsupported"));
	});
});
