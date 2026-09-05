import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemInfo } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { FeedbackDialog } from "./FeedbackDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

const info: SystemInfo = {
	appVersion: "0.9.13",
	platform: "darwin",
	arch: "arm64",
	osRelease: "25.0.0",
	electron: "36.9.5",
	chrome: "134.0",
	node: "22.0.0",
};

const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
const logTail = vi.fn<(lines: number) => Promise<string[]>>(() =>
	Promise.resolve(['{"report":{"source":"renderer-console","message":"toast exploded"}}']),
);
const sysInfo = vi.fn<() => Promise<SystemInfo>>(() => Promise.resolve(info));

(window as unknown as { omp: unknown }).omp = {
	system: { info: sysInfo, openExternal },
	runtime: { logTail },
};

let container: InstanceType<typeof HTMLElement>;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as never);
	await act(async () => {
		root.render(
			<I18nProvider>
				<FeedbackDialog />
			</I18nProvider>,
		);
	});
}

/** The Modal portals to document.body — query there, not in the mount container. */
function field(selector: string): InstanceType<typeof HTMLElement> {
	const el = document.querySelector(selector) as InstanceType<typeof HTMLElement> | null;
	if (!el) throw new Error(`field ${selector} not found`);
	return el;
}

async function submit(): Promise<void> {
	const buttons = [...document.querySelectorAll("button")];
	const target = buttons.find(b => (b.textContent ?? "").includes("GitHub"));
	if (!target) throw new Error("submit button not found");
	await act(async () => {
		target.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
}

/** linkedom does not implement native checkbox activation; dispatch the rendered change handler. */
async function optIn(index: number): Promise<void> {
	// linkedom's input node has the standard checked property, despite its public element type.
	const checkbox = document.querySelectorAll('input[type="checkbox"]')[index] as unknown as HTMLInputElement;
	if (!checkbox) throw new Error(`checkbox ${index} not found`);
	checkbox.checked = true;
	const record = checkbox as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	const props = key ? record[key] : undefined;
	if (!props || typeof props !== "object" || !("onChange" in props) || typeof props.onChange !== "function") {
		throw new Error(`checkbox ${index} has no change handler`);
	}
	const onChange = props.onChange;
	await act(async () => onChange({ target: checkbox, currentTarget: checkbox }));
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useUiStore.getState().closeFeedback();
	openExternal.mockClear();
	sysInfo.mockClear();
	logTail.mockClear();
});

describe("FeedbackDialog", () => {
	it("opens the draft on GitHub without environment or runtime diagnostics unless opted in", async () => {
		useUiStore.setState({
			feedbackOpen: true,
			feedbackPrefill: { description: "Sync button threw 405" },
		});
		await mount();
		await submit();
		expect(openExternal).toHaveBeenCalledTimes(1);
		const url = new URL(openExternal.mock.calls[0][0]);
		expect(`${url.origin}${url.pathname}`).toBe("https://github.com/nornzach/oh-my-pi-gui/issues/new");
		expect(url.searchParams.get("labels")).toBe("gui,bug");
		const body = url.searchParams.get("body") ?? "";
		expect(body).toContain("Sync button threw 405");
		expect(body).not.toContain("Environment");
		expect(body).not.toContain("v0.9.13");
		expect(body).not.toContain("toast exploded");
		expect(body).not.toContain("Error details");
	});

	it("builds a prefilled GitHub issue URL from the draft and explicitly opted-in diagnostics", async () => {
		useUiStore.setState({
			feedbackOpen: true,
			feedbackPrefill: { description: "Sync button threw 405" },
		});
		await mount();
		// linkedom's textarea exposes the same draft value as a browser textarea.
		const description = field("textarea") as unknown as HTMLTextAreaElement;
		expect(description.value).toBe("Sync button threw 405");
		await optIn(0);
		await optIn(1);
		await submit();
		expect(openExternal).toHaveBeenCalledTimes(1);
		const url = new URL(openExternal.mock.calls[0][0]);
		expect(`${url.origin}${url.pathname}`).toBe("https://github.com/nornzach/oh-my-pi-gui/issues/new");
		expect(url.searchParams.get("labels")).toBe("gui,bug");
		const body = url.searchParams.get("body") ?? "";
		expect(body).toContain("Sync button threw 405");
		expect(body).toContain("v0.9.13");
		expect(body).toContain("toast exploded");
	});

	it("does not carry diagnostic consent into a reopened report", async () => {
		useUiStore.setState({
			feedbackOpen: true,
			feedbackPrefill: { description: "First report" },
		});
		await mount();
		await optIn(0);
		await optIn(1);
		await submit();
		const optedInBody = new URL(openExternal.mock.calls[0][0]).searchParams.get("body") ?? "";
		expect(optedInBody).toContain("v0.9.13");
		expect(optedInBody).toContain("toast exploded");
		await act(async () => useUiStore.getState().openFeedback({ description: "Second report" }));
		await submit();
		expect(openExternal).toHaveBeenCalledTimes(2);
		const reopenedBody = new URL(openExternal.mock.calls[1][0]).searchParams.get("body") ?? "";
		expect(reopenedBody).toContain("Second report");
		expect(reopenedBody).not.toContain("First report");
		expect(reopenedBody).not.toContain("Environment");
		expect(reopenedBody).not.toContain("v0.9.13");
		expect(reopenedBody).not.toContain("toast exploded");
		expect(reopenedBody).not.toContain("Error details");
	});

	it("embeds a store-carried error under error details in the issue body", async () => {
		useUiStore.setState({
			feedbackOpen: true,
			feedbackPrefill: { error: "TypeError: boundary crashed", description: "界面崩了" },
		});
		await mount();
		expect(field("pre").textContent).toContain("TypeError: boundary crashed");
		await submit();
		const body = new URL(openExternal.mock.calls[0][0]).searchParams.get("body") ?? "";
		expect(body).toContain("界面崩了");
		expect(body).toContain("TypeError: boundary crashed");
		expect(body).toContain("Error details");
		expect(body).not.toContain("Environment");
		expect(body).not.toContain("v0.9.13");
		expect(body).not.toContain("toast exploded");
	});
});
