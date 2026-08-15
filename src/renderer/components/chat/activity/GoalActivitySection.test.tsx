import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { useActivitySidebarStore } from "../../../stores/activity-sidebar";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const setGoal: Mock<(args: { action?: "pause" | "resume" | "drop" }) => Promise<RpcResponse>> = vi.fn(async () => ({
	type: "response",
	command: "set_goal",
	success: true,
	data: {},
}));
(window as unknown as { omp: { rpc: { setGoal: typeof setGoal } } }).omp = { rpc: { setGoal } };

const { createRoot } = await import("react-dom/client");
const { GoalActivitySection } = await import("./GoalActivitySection");

let container: HTMLElement;
let root: Root;

async function mount(readOnly = false, maxDetailHeight = 180): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<GoalActivitySection maxDetailHeight={maxDetailHeight} readOnly={readOnly} />
			</I18nProvider>,
		);
	});
}

function button(label: string): HTMLButtonElement {
	return container.querySelector(`[aria-label="${label}"]`) as unknown as HTMLButtonElement;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setGoal.mockClear();
	useActivitySidebarStore.getState().reset();
	useSessionStore.getState().reset();
	useUiStore.setState({ modesOpen: false, modesTab: "vibe" });
});

describe("GoalActivitySection", () => {
	it("keeps the objective in expanded details and opens goal editing", async () => {
		useSessionStore.setState({ goal: { objective: "Ship the compact renderer" }, goalState: { status: "active" } });
		useActivitySidebarStore.setState({ expandedMeta: "goal" });
		await mount();

		expect(container.textContent).toContain("Active goal");
		expect(container.textContent).toContain("Ship the compact renderer");
		await act(async () => button("Edit goal").click());
		expect(useUiStore.getState()).toMatchObject({ modesOpen: true, modesTab: "goal" });
	});

	it("pauses the live goal in place and sends the native goal action", async () => {
		useSessionStore.setState({ goal: { objective: "Ship it" }, goalState: { status: "active" } });
		useActivitySidebarStore.setState({ expandedMeta: "goal" });
		await mount();

		await act(async () => button("Pause").click());
		expect(setGoal).toHaveBeenCalledWith({ action: "pause" });
		expect(useSessionStore.getState().goalState?.status).toBe("paused");
		expect(container.textContent).toContain("Paused goal");
	});

	it("rolls an optimistic action back when the RPC rejects it", async () => {
		setGoal.mockResolvedValueOnce({
			type: "response",
			command: "set_goal",
			success: false,
			error: "nope",
		});
		useSessionStore.setState({ goal: { objective: "Ship it" }, goalState: { status: "active" } });
		useActivitySidebarStore.setState({ expandedMeta: "goal" });
		await mount();

		await act(async () => button("Pause").click());
		expect(useSessionStore.getState().goalState?.status).toBe("active");
		expect(container.textContent).toContain("Active goal");
	});

	it("keeps an empty header and omits mutation controls when read-only", async () => {
		useActivitySidebarStore.setState({ expandedMeta: "goal" });
		await mount(true, 111);

		expect(container.textContent).toContain("No active goal");
		expect(container.querySelector('[aria-label="Edit goal"]')).toBeNull();
		const detail = container.querySelector<HTMLElement>("[data-activity-meta-detail='goal']");
		expect(detail?.style.maxHeight).toBe("111px");
		expect(detail?.className).toContain("overflow-y-auto");
	});
});
