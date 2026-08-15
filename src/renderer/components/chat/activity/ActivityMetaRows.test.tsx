import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useActivitySidebarStore } from "../../../stores/activity-sidebar";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";
import { ActivityMetaRows } from "./ActivityMetaRows";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
const setPlanMode = vi.fn(async (enabled: boolean) => ({
	type: "response",
	command: "set_plan_mode",
	success: true,
	data: { enabled },
}));
Object.assign(window, {
	omp: {
		fs: { readPlan: vi.fn(async () => ({ ok: true, path: null, content: null })) },
		rpc: {
			getPlanMode: vi.fn(async () => ({
				type: "response",
				command: "get_plan_mode",
				success: true,
				data: { enabled: false, planFilePath: null },
			})),
			setPlanMode,
			setGoal: vi.fn(),
			prompt: vi.fn(),
			steer: vi.fn(),
		},
	},
});

// React DOM snapshots browser support during module evaluation, after linkedom globals exist.
const { createRoot } = await import("react-dom/client");

let container: HTMLElement;
let root: Root;

async function mount(readOnly = false, maxDetailHeight = 176): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ActivityMetaRows maxDetailHeight={maxDetailHeight} readOnly={readOnly} />
			</I18nProvider>,
		);
	});
}

function button(label: string): HTMLButtonElement {
	const target = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
		candidate => candidate.getAttribute("aria-label") === label,
	);
	if (!target) throw new Error(`Missing button ${label}`);
	return target;
}

beforeEach(() => {
	useActivitySidebarStore.getState().reset();
	useSessionStore.getState().reset();
	useUiStore.setState({ modesOpen: false, modesTab: "vibe" });
	setPlanMode.mockClear();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

describe("ActivityMetaRows", () => {
	it("keeps off Plan and empty Goal headers mounted", async () => {
		await mount();
		expect(container.querySelector('section[aria-label="Plan"]')).not.toBeNull();
		expect(container.querySelector('section[aria-label="Goal"]')).not.toBeNull();
		expect(container.textContent).toContain("Off");
		expect(container.textContent).toContain("No active goal");
	});

	it("allows only one independently scrolling details body", async () => {
		await mount(false, 137);
		await act(async () => button("Expand Plan").click());
		let detail = container.querySelector<HTMLElement>("[data-activity-meta-detail='plan']")!;
		expect(detail.style.maxHeight).toBe("137px");
		expect(detail.className).toContain("overflow-y-auto");
		await act(async () => button("Expand Goal").click());
		expect(container.querySelector("[data-activity-meta-detail='plan']")).toBeNull();
		detail = container.querySelector<HTMLElement>("[data-activity-meta-detail='goal']")!;
		expect(detail.style.maxHeight).toBe("137px");
	});

	it("keeps Main controls available and omits all mutation controls in read-only mode", async () => {
		useSessionStore.setState({ goal: { objective: "Ship" }, goalState: { status: "active" } });
		await mount(false);
		await act(async () => button("Expand Goal").click());
		expect(button("Pause")).not.toBeNull();
		expect(button("Edit goal")).not.toBeNull();
		await act(async () => root.unmount());
		container.remove();
		useActivitySidebarStore.getState().reset();
		useActivitySidebarStore.setState({ expandedMeta: "goal" });
		await mount(true);
		expect(container.querySelector('[aria-label="Pause"]')).toBeNull();
		expect(container.querySelector('[aria-label="Edit goal"]')).toBeNull();
	});

	it("lets Main enable Plan mode from its expanded details", async () => {
		useActivitySidebarStore.setState({ expandedMeta: "plan" });
		await mount(false);
		await act(async () => button("Toggle plan mode").click());
		expect(setPlanMode).toHaveBeenCalledWith(true);
		expect(useSessionStore.getState().planModeEnabled).toBe(true);
	});
});
