import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../../../shared/rpc-types";
import type { IpcSpawnTabPayload, IpcSpawnTabResult, IpcExtensionUiContext } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { type ExtensionUiStore, useExtensionUiStore } from "../../stores/extension-ui";
import { confirmModelRestore } from "../../hooks/use-session-switch";
import { useModelRestoreStore } from "../../stores/model-restore";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import {
	type SessionRuntime,
	SessionRuntimeProvider,
	sessionRuntimeStore,
	setFocusedSessionRuntime,
} from "../../stores/session-runtime-context";
import { createTabRuntime } from "../../stores/tab-runtime";
import { pushTabExtensionUiRequest, useTabsStore } from "../../stores/tabs";
import { ModelRestoreDialog } from "./ModelRestoreDialog";
import { ExtensionAskPanel, ExtensionDialog } from "./ExtensionDialog";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

interface TestElement {
	textContent: string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
	getAttribute(name: string): string | null;
}

let container: TestElement;
let root: Root;
let respondExtensionUi: Mock<(response: ExtensionUIResponse) => void>;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(runtime?: SessionRuntime, recovery = false): Promise<void> {
	respondExtensionUi = vi.fn();
	const ompWindow = window as unknown as { omp: { ui: { respondExtensionUi: typeof respondExtensionUi } } };
	ompWindow.omp = { ui: { respondExtensionUi } };
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		const surface = (
			<I18nProvider>
				<ExtensionAskPanel />
				<ExtensionDialog />
				{recovery && <ModelRestoreDialog />}
			</I18nProvider>
		);
		root.render(runtime ? <SessionRuntimeProvider runtime={runtime}>{surface}</SessionRuntimeProvider> : surface);
	});
}

function buttonWithText(text: string): TestElement | undefined {
	const buttons = Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
	return buttons.find(button => button.textContent?.includes(text));
}

async function click(element: TestElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

async function changeTextarea(element: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	if (descriptor?.set) descriptor.set.call(element, value);
	else element.value = value;
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
	await act(async () => {
		if (props?.onChange) props.onChange({ target: element, currentTarget: element });
		else element.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
	});
	await flush();
}

function showAskDialog(): void {
	useExtensionUiStore.getState().pushRequest({
		type: "extension_ui_request",
		id: "ask-1",
		method: "askDialog",
		questions: [
			{
				id: "deploy",
				question: "Where should this deploy?",
				options: [
					{ label: "Staging", description: "Safe environment" },
					{ label: "Production", preview: "Deploys to **all users**." },
				],
				recommended: 0,
			},
		],
	});
}

function showLegacyAskSelect(): void {
	useExtensionUiStore.getState().pushRequest({
		type: "extension_ui_request",
		id: "ask-select-1",
		method: "select",
		title: "Where should this deploy?",
		options: ["Staging", "Production (Recommended)", "Other (type your own)"],
		optionDetails: [{ description: "Safe environment" }, { description: "All users" }, {}],
	});
}

function showLegacyAskEditor(): void {
	useExtensionUiStore.getState().pushRequest({
		type: "extension_ui_request",
		id: "ask-editor-1",
		method: "editor",
		title: "Where should this deploy? › Other",
		prefill: "",
		promptStyle: true,
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useExtensionUiStore.getState().clearAll();
	useModelRestoreStore.getState().close();
	useTabsStore.getState().reset();
	vi.restoreAllMocks();
	document.title = "";
});

describe("ExtensionDialog select", () => {
	it("shows positional descriptions without including them in the returned choice", async () => {
		await mount();
		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "select-details",
				method: "select",
				title: "Choose a connection",
				options: ["API key", "Subscription"],
				optionDetails: [{}, { description: "Sign in with your existing subscription" }],
			});
		});
		const apiKey = buttonWithText("API key");
		const subscription = buttonWithText("Subscription");
		if (!apiKey || !subscription) throw new Error("missing connection choices");
		expect(apiKey.textContent).not.toContain("existing subscription");
		expect(subscription.textContent).toContain("Sign in with your existing subscription");
		await click(subscription);
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "select-details",
			value: "Subscription",
		});
	});

	it("offers only the requested session grant and returns its exact permission scope", async () => {
		await mount();
		const sessionGrant = "Approve curl for this session";
		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "approve-session",
				method: "select",
				title: "Allow tool: bash\ncurl https://example.com",
				options: ["Approve", sessionGrant, "Deny"],
			});
		});
		expect(respondExtensionUi).not.toHaveBeenCalled();
		const grant = document.querySelector(`button[title="${sessionGrant}"]`) as unknown as TestElement | null;
		expect(grant).not.toBeNull();
		await click(grant!);
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "approve-session",
			value: sessionGrant,
		});
	});
});

describe("ExtensionDialog askDialog", () => {
	it("returns the wire submit discriminator and renders the selected option preview", async () => {
		await mount();
		await act(async () => showAskDialog());
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.querySelector("[data-extension-ask-inline]")).not.toBeNull();

		const production = buttonWithText("Production");
		if (!production) throw new Error("missing Production option");
		await click(production);
		expect(document.body.textContent).toContain("Deploys to all users.");

		const form = document.querySelector("form") as unknown as TestElement | null;
		if (!form) throw new Error("missing ask form");
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-1",
			askDialog: {
				kind: "submit",
				results: [
					{
						id: "deploy",
						question: "Where should this deploy?",
						options: ["Staging", "Production"],
						multi: false,
						selectedOptions: ["Production"],
					},
				],
			},
		});
	});

	it("preserves notes separately from a single custom answer", async () => {
		await mount();
		await act(async () => showAskDialog());
		const staging = buttonWithText("Staging");
		if (!staging) throw new Error("missing Staging option");
		await click(staging);
		const inputs = document.querySelectorAll("input");
		const custom = inputs[0];
		const note = inputs[1];
		if (!custom || !note) throw new Error("missing custom answer or note input");
		await changeTextarea(custom, "Canary");
		await changeTextarea(note, "Keep rollback available");
		const form = document.querySelector("form");
		if (!form) throw new Error("missing ask form");
		await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-1",
			askDialog: {
				kind: "submit",
				results: [
					{
						id: "deploy",
						question: "Where should this deploy?",
						options: ["Staging", "Production"],
						multi: false,
						selectedOptions: [],
						customInput: "Canary",
						note: "Keep rollback available",
					},
				],
			},
		});
	});

	it("preserves multiple selections alongside custom input and a note", async () => {
		await mount();
		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "ask-multi",
				method: "askDialog",
				questions: [
					{ id: "targets", question: "Targets?", multi: true, options: [{ label: "A" }, { label: "B" }] },
				],
			});
		});
		const a = buttonWithText("A");
		const b = buttonWithText("B");
		if (!a || !b) throw new Error("missing target options");
		await click(a);
		await click(b);
		const inputs = document.querySelectorAll("input");
		if (!inputs[0] || !inputs[1]) throw new Error("missing custom answer or note input");
		await changeTextarea(inputs[0], "C");
		await changeTextarea(inputs[1], "In order");
		const form = document.querySelector("form");
		if (!form) throw new Error("missing ask form");
		await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-multi",
			askDialog: {
				kind: "submit",
				results: [
					{
						id: "targets",
						question: "Targets?",
						options: ["A", "B"],
						multi: true,
						selectedOptions: ["A", "B"],
						customInput: "C",
						note: "In order",
					},
				],
			},
		});
	});

	it("returns the chat redirect discriminator", async () => {
		await mount();
		await act(async () => showAskDialog());

		const chat = buttonWithText("Chat about this");
		if (!chat) throw new Error("missing Chat about this button");
		await click(chat);

		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-1",
			askDialog: { kind: "chat" },
		});
	});

	it("cancels an inline question without converting it into a chat answer", async () => {
		await mount();
		await act(async () => showAskDialog());
		const cancel = buttonWithText("Cancel");
		if (!cancel) throw new Error("missing cancel button");
		await click(cancel);
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-1",
			cancelled: true,
		});
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
	});

	it("times out an inline question with the cancellation wire envelope", async () => {
		await mount();
		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "ask-timeout",
				method: "askDialog",
				timeout: 0,
				questions: [{ id: "target", question: "Target?", options: [{ label: "Staging" }] }],
			});
		});
		await flush();
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-timeout",
			cancelled: true,
			timedOut: true,
		});
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
	});
});

describe("ExtensionDialog legacy ask fallback", () => {
	it("renders select questions inline and returns the selected label", async () => {
		await mount();
		await act(async () => showLegacyAskSelect());

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.querySelector("[data-extension-ask-inline]")).not.toBeNull();
		const staging = buttonWithText("Staging");
		if (!staging) throw new Error("missing Staging option");
		await click(staging);

		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-select-1",
			value: "Staging",
		});
	});

	it("renders prompt-style custom answers inline and returns the entered text", async () => {
		await mount();
		await act(async () => showLegacyAskEditor());

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.querySelector("[data-extension-ask-inline]")).not.toBeNull();
		const textarea = document.querySelector("textarea");
		if (!textarea) throw new Error("missing inline custom-answer editor");
		await changeTextarea(textarea, "Canary");
		const form = document.querySelector("form");
		if (!form) throw new Error("missing inline custom-answer form");
		await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
		await flush();

		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-editor-1",
			value: "Canary",
		});
	});
});

describe("ExtensionDialog non-dialog mutations", () => {
	it("hides transient extension status and renders widget ANSI without control codes", async () => {
		await mount();
		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "status-ansi",
				method: "setStatus",
				statusKey: "mode",
				statusText: "\x1b[38;5;39m●\x1b[39m ponytail: \x1b[1mFULL\x1b[0m",
			});
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "widget-ansi",
				method: "setWidget",
				widgetKey: "progress",
				widgetLines: ["\x1b[32mPASS\x1b[0m"],
			});
		});

		expect(document.body.textContent).not.toContain("ponytail");
		expect(document.body.textContent).toContain("PASS");
		expect(document.body.textContent).not.toContain("[32m");
	});

	it("fills the composer for set_editor_text and applies extension window titles", async () => {
		await mount();
		let editorDetail: { text?: string; images?: unknown[]; prepend?: boolean } | undefined;
		window.addEventListener(
			"omp:fill-composer",
			(event: Event) => {
				editorDetail = (event as CustomEvent<{ text?: string; images?: unknown[]; prepend?: boolean }>).detail;
			},
			{ once: true },
		);

		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "editor-1",
				method: "set_editor_text",
				text: "restored draft",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
				prepend: true,
			});
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "title-1",
				method: "setTitle",
				title: "Extension task",
			});
		});
		await flush();

		expect(editorDetail).toEqual({
			text: "restored draft",
			images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			prepend: true,
		});
		expect(document.title).toBe("Extension task");
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
	});
});

describe("saved-restore extension interactions", () => {
	async function stage(request: ExtensionUIRequest) {
		const runtime = createTabRuntime("working");
		setFocusedSessionRuntime("working");
		useTabsStore.setState({
			activeTabId: "working",
			tabs: [
				{
					id: "working",
					cwd: "/working",
					kind: "agent",
					status: "ready",
					target: { type: "local" },
					unreadDone: false,
				},
			],
		});
		useSessionStore.setState({ sessionId: "working-session" });
		useModelStore.setState({ model: { provider: "openai", id: "current" } });
		useMessagesStore.setState({
			messages: [{ role: "user", content: "working history", timestamp: 1 }],
			totalMessages: 1,
		});
		await mount(runtime, true);
		const result = Promise.withResolvers<IpcSpawnTabResult>();
		const requested = Promise.withResolvers<void>();
		let context: IpcExtensionUiContext = {};
		let calls = 0;
		Object.assign(window.omp, {
			tabs: {
				spawn: async (payload: IpcSpawnTabPayload) => {
					if (++calls === 1) return { tabId: null, refusal: "model-restore", missingModel: "removed/old" };
					context = {
						restoringSession: true,
						restoreRequestId: payload.restoreRequestId,
						modelOrigin: payload.modelOrigin,
					};
					pushTabExtensionUiRequest("hidden-restore", request, context);
					requested.resolve();
					return result.promise;
				},
				close: async () => true,
				cancelRestore: async ({ restoreRequestId }: { restoreRequestId: string }) => {
					if (context.restoreRequestId !== restoreRequestId) return false;
					result.resolve({ tabId: null, refusal: "restore-failed", error: "Restore was cancelled" });
					return true;
				},
			},
		});
		await act(async () => {
			await useTabsStore.getState().openTab({ cwd: "/saved", sessionPath: "/sessions/saved.jsonl" });
		});
		let confirming!: Promise<boolean>;
		await act(async () => {
			confirming = confirmModelRestore();
			await requested.promise;
		});
		return {
			runtime,
			confirming,
			context: () => context,
			finish: async () => {
				result.resolve({
					tabId: null,
					refusal: "restore-failed",
					failedTabId: "hidden-restore",
					error: "Native restore cancelled",
				});
				await act(async () => {
					await confirming;
				});
			},
		};
	}

	it("answers a hidden restore input through its request owner without changing working focus or transcript", async () => {
		const h = await stage({
			type: "extension_ui_request",
			method: "input",
			id: "restore-input",
			title: "Restore question",
			placeholder: "Restore value",
		});
		try {
			const input = document.querySelector('input[placeholder="Restore value"]') as HTMLInputElement | null;
			expect(input).not.toBeNull();
			expect(useTabsStore.getState().activeTabId).toBe("working");
			expect(useSessionStore.getState().sessionId).toBe("working-session");
			expect(useMessagesStore.getState().messages).toMatchObject([{ content: "working history" }]);
			if (!input) throw new Error("missing restore input");
			await changeTextarea(input, "approved value");
			const submit = buttonWithText("Submit");
			if (!submit) throw new Error("missing input submit");
			// linkedom does not perform a submit button's browser default action.
			expect(submit.getAttribute("type")).toBe("submit");
			const form = input.closest("form");
			if (!form) throw new Error("missing restore input form");
			await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
			expect(respondExtensionUi).toHaveBeenCalledWith({
				type: "extension_ui_response",
				id: "restore-input",
				value: "approved value",
			});
			expect(
				sessionRuntimeStore<ExtensionUiStore>("hidden-restore", "extensionUi")?.getState().pendingRequests,
			).toEqual([]);
		} finally {
			await h.finish();
		}
	});

	it("keeps real legacy ask interaction INLINE while the current-model recovery is busy", async () => {
		const h = await stage({
			type: "extension_ui_request",
			method: "select",
			id: "restore-ask",
			title: "Restore choice",
			options: ["Proceed", "Other (type your own)"],
		});
		try {
			expect(document.querySelector("[data-extension-ask-inline]")).not.toBeNull();
			expect(useModelRestoreStore.getState().busy).toBe(true);
			expect(useTabsStore.getState().activeTabId).toBe("working");
			const option = buttonWithText("Proceed");
			if (!option) throw new Error("missing inline restore choice");
			await click(option);
			expect(respondExtensionUi).toHaveBeenCalledWith({
				type: "extension_ui_response",
				id: "restore-ask",
				value: "Proceed",
			});
		} finally {
			await h.finish();
		}
	});

	it("cancels a retired working origin and rejects late frames from its completed restore nonce", async () => {
		const h = await stage({
			type: "extension_ui_request",
			method: "input",
			id: "retired-input",
			title: "Retired question",
			placeholder: "Retired value",
		});
		try {
			await act(async () => {
				createTabRuntime("other");
				useTabsStore.setState({ activeTabId: "other" });
				setFocusedSessionRuntime("other");
			});
			expect(respondExtensionUi).toHaveBeenCalledWith({
				type: "extension_ui_response",
				id: "retired-input",
				cancelled: true,
			});
		} finally {
			await h.finish();
		}
		await act(async () => {
			useTabsStore.getState().reset();
			pushTabExtensionUiRequest(
				"late-restorer",
				{
					type: "extension_ui_request",
					method: "input",
					id: "late-input",
					title: "Late question",
					placeholder: "Late value",
				},
				h.context(),
			);
		});
		expect(document.querySelector('input[placeholder="Late value"]')).toBeNull();
	});
});

it("initial cold restore's inline native question cannot clear the working model before the missing-model choice", async () => {
	const runtime = createTabRuntime("working");
	setFocusedSessionRuntime("working");
	useTabsStore.setState({
		activeTabId: "working",
		tabs: [
			{
				id: "working",
				cwd: "/working",
				kind: "agent",
				status: "ready",
				target: { type: "local" },
				unreadDone: false,
			},
			{
				id: "cold-inline",
				cwd: "/saved",
				kind: "agent",
				status: "asleep",
				target: { type: "local" },
				sessionPath: "/sessions/saved.jsonl",
				unreadDone: false,
			},
		],
	});
	useSessionStore.setState({ sessionId: "working-session" });
	useModelStore.setState({ model: { provider: "openai", id: "current" }, thinkingLevel: "high" });
	useMessagesStore.setState({
		messages: [{ role: "user", content: "working history", timestamp: 1 }],
		totalMessages: 1,
	});
	await mount(runtime, true);
	const result = Promise.withResolvers<IpcSpawnTabResult>();
	const requested = Promise.withResolvers<void>();
	Object.assign(window.omp, {
		tabs: {
			spawn: async (payload: IpcSpawnTabPayload) => {
				pushTabExtensionUiRequest(
					"cold-inline",
					{
						type: "extension_ui_request",
						id: "initial-cold-choice",
						method: "select",
						title: "Restore inline proof",
						options: ["Continue restore", "Other (type your own)"],
					},
					{ restoringSession: true, restoreRequestId: payload.restoreRequestId, modelOrigin: payload.modelOrigin },
				);
				requested.resolve();
				return result.promise;
			},
			cancelRestore: async () => {
				result.resolve({ tabId: null, refusal: "restore-failed", error: "Restore cancelled" });
				return true;
			},
		},
	});
	respondExtensionUi.mockImplementation(response => {
		if (response.id === "initial-cold-choice" && "value" in response && response.value === "Continue restore") {
			result.resolve({ tabId: null, refusal: "model-restore", missingModel: "removed/old" });
		}
	});
	let opening!: Promise<string | null>;
	try {
		await act(async () => {
			opening = useTabsStore.getState().openTab({
				existingTabId: "cold-inline",
				cwd: "/saved",
				sessionPath: "/sessions/saved.jsonl",
			});
			await requested.promise;
		});
		expect(document.querySelector("[data-extension-ask-inline]")).not.toBeNull();
		expect(useModelStore.getState().model).toMatchObject({ provider: "openai", id: "current" });
		const option = buttonWithText("Continue restore");
		if (!option) throw new Error("missing initial native inline choice");
		await click(option);
		await act(async () => {
			await opening;
		});
		expect(useModelStore.getState().model).toMatchObject({ provider: "openai", id: "current" });
		expect(useModelStore.getState().thinkingLevel).toBe("high");
		expect(useModelRestoreStore.getState().prompt?.currentModel).toEqual({ provider: "openai", modelId: "current" });
		expect(document.body.textContent).toContain("Open with openai/current");
		expect(useSessionStore.getState().sessionId).toBe("working-session");
		expect(useTabsStore.getState().activeTabId).toBe("working");
		expect(useMessagesStore.getState().messages).toMatchObject([{ content: "working history" }]);
	} finally {
		result.resolve({ tabId: null, refusal: "restore-failed", error: "Test cleanup" });
		await act(async () => {
			await opening;
		});
	}
});
