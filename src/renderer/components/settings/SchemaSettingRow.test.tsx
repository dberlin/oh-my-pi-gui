import { parseHTML } from "linkedom";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcCommand, RpcResponse, SettingEntry } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { SessionRuntimeProvider, type SessionRuntime } from "../../stores/session-runtime-context";
import { useToastStore } from "../../stores/toast";
import { SchemaSettingRow } from "./SchemaSettingRow";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});

let root: Root | undefined;
const entry: SettingEntry = { path: "computer.enabled", type: "boolean", value: false, default: false };

function Row({ setting = entry }: { setting?: SettingEntry }) {
	const [value, setValue] = useState<unknown>(false);
	const [commits, setCommits] = useState(0);
	return (
		<>
			<SchemaSettingRow
				entry={setting}
				value={value}
				onCommitted={(_path, next) => {
					setValue(next);
					setCommits(count => count + 1);
				}}
			/>
			<output>{commits}</output>
		</>
	);
}

async function save(response: RpcResponse, setting = entry): Promise<void> {
	const command = async (request: RpcCommand): Promise<RpcResponse> => {
		if (request.type === "set_setting") return response;
		if (request.type === "get_settings")
			return {
				type: "response",
				command: request.type,
				success: true,
				data: { values: { "computer.enabled": true } },
			};
		throw new Error(`Unexpected command ${request.type}`);
	};
	const runtime: SessionRuntime = { tabId: "settings-row", command, stores: new Map() };
	root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SessionRuntimeProvider runtime={runtime}>
					<Row setting={setting} />
				</SessionRuntimeProvider>
			</I18nProvider>,
		);
	});
	await act(async () => {
		document.body.querySelector('[role="switch"]')?.dispatchEvent(new Event("click", { bubbles: true }));
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = undefined;
	document.body.innerHTML = "";
	useToastStore.setState({ toasts: [] });
});

describe("settings write acknowledgement", () => {
	it("refreshes the effective value of a shadowed save without acknowledging active success", async () => {
		await save({
			type: "response",
			command: "set_setting",
			success: false,
			code: "setting_not_applied",
			error: "Saved globally, but project settings still override it.",
			data: {
				path: "computer.enabled",
				saved: true,
				savedValue: true,
				effectiveValue: false,
				overriddenBy: "project",
			},
		});
		expect(document.body.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
		expect(document.body.querySelector("output")?.textContent).toBe("1");
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("project settings");
		expect(useToastStore.getState().toasts.at(-1)?.title).toBe("Saved globally, but not applied");
		expect(useToastStore.getState().toasts.some(item => item.variant === "success")).toBe(false);
	});

	it("does not apply the submitted value when a persisted save cannot be verified", async () => {
		await save({
			type: "response",
			command: "set_setting",
			success: false,
			code: "setting_effect_unverified",
			error: "Saved globally, but effective readback failed.",
			data: { path: "computer.enabled", saved: true, savedValue: true },
		});
		expect(document.body.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
		expect(document.body.querySelector("output")?.textContent).toBe("0");
		expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("readback failed");
	});

	it("continues applying verified unshadowed writes", async () => {
		await save({
			type: "response",
			command: "set_setting",
			success: true,
			data: { path: "computer.enabled", value: true },
		});
		expect(document.body.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
		expect(document.body.querySelector("output")?.textContent).toBe("1");
		expect(document.body.querySelector('[role="alert"]')).toBeNull();
	});

	it("does not offer an unset reset when the vanilla schema provides no factory default", async () => {
		await save(
			{ type: "response", command: "set_setting", success: true, data: { path: "computer.enabled", value: true } },
			{ path: "computer.enabled", type: "boolean", value: false },
		);
		expect(document.body.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
		expect(
			[...document.body.querySelectorAll("button")].some(button =>
				button.textContent?.includes("Remove global override"),
			),
		).toBe(false);
	});
});
