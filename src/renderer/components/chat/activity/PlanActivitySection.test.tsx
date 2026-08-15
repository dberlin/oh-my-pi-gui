import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SshSessionTarget } from "../../../../shared/ipc-types";
import { I18nProvider } from "../../../lib/i18n";
import { resetTabRoute } from "../../../lib/tab-routing";
import { useActivitySidebarStore } from "../../../stores/activity-sidebar";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});

// React DOM computes DOM support at evaluation time, so the test harness must install linkedom first.
const { createRoot } = await import("react-dom/client");
const { PlanActivitySection } = await import("./PlanActivitySection");

interface TestElement {
	remove(): void;
	textContent: string | null;
}

interface MockOmp {
	fs: { readPlan: Mock };
	rpc: {
		getPlanMode: Mock;
		setPlanMode: Mock;
		prompt: Mock;
		steer: Mock;
	};
}

const REMOTE_TARGET: SshSessionTarget = {
	type: "ssh",
	hostAlias: "build",
	host: {
		host: "build.example.test",
		username: "deploy",
		sourceId: "test",
		sourceLevel: "project",
		os: "linux",
	},
	originCwd: "/srv/app",
	cwd: "/srv/app",
};

const ompWindow = window as unknown as { omp: MockOmp };
let container: TestElement | undefined;
let root: Root | undefined;

function installOmp(): MockOmp {
	const omp: MockOmp = {
		fs: {
			readPlan: vi.fn(async () => ({
				ok: true,
				path: "/srv/app/plan.md",
				content: "# Remote plan\n- [ ] Read the remote-only plan",
			})),
		},
		rpc: {
			getPlanMode: vi.fn(async () => ({
				type: "response",
				command: "get_plan_mode",
				success: true,
				data: { enabled: true, planFilePath: "plan.md" },
			})),
			setPlanMode: vi.fn(),
			prompt: vi.fn(),
			steer: vi.fn(),
		},
	};
	ompWindow.omp = omp;
	return omp;
}

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
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root?.unmount();
		});
	}
	container?.remove();
	container = undefined;
	root = undefined;
	useActivitySidebarStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	resetTabRoute();
	vi.restoreAllMocks();
});

describe("PlanActivitySection", () => {
	it("keeps the SSH plan payload target-free so main resolves and bounds the remote file", async () => {
		const omp = installOmp();
		useSessionStore.setState({
			planModeEnabled: true,
			cwd: REMOTE_TARGET.cwd,
			sessionFile: "/home/deploy/.omp/sessions/remote-session-7.jsonl",
			isStreaming: false,
		});
		useActivitySidebarStore.setState({ expandedMeta: "plan" });
		useTabsStore.setState({
			tabs: [
				{
					id: "remote-1",
					cwd: REMOTE_TARGET.cwd,
					target: REMOTE_TARGET,
					status: "ready",
					kind: "agent",
					unreadDone: false,
				},
			],
			activeTabId: "remote-1",
		});

		await mount(<PlanActivitySection maxDetailHeight={180} readOnly={false} />);

		expect(omp.fs.readPlan).toHaveBeenCalledWith({ fsPath: "/srv/app/plan.md", localRoot: null });
		expect(container?.textContent).toContain("Read the remote-only plan");
	});

	it("keeps an Off header mounted and omits Main controls when read-only", async () => {
		installOmp();
		await mount(<PlanActivitySection maxDetailHeight={180} readOnly />);

		expect(container?.textContent).toContain("Plan");
		expect(container?.textContent).toContain("Off");
		expect(document.querySelector('[aria-label="Toggle plan mode"]')).toBeNull();
	});

	it("bounds and independently scrolls expanded plan details", async () => {
		installOmp();
		useSessionStore.setState({ planModeEnabled: true, cwd: "/srv/app", sessionFile: "/tmp/session.jsonl" });
		useActivitySidebarStore.setState({ expandedMeta: "plan" });
		await mount(<PlanActivitySection maxDetailHeight={123} readOnly={false} />);

		const detail = document.querySelector<HTMLElement>("[data-activity-meta-detail='plan']");
		expect(detail?.style.maxHeight).toBe("123px");
		expect(detail?.className).toContain("overflow-y-auto");
	});

	it("clears an open Main step editor when the target becomes read-only", async () => {
		installOmp();
		useSessionStore.setState({ planModeEnabled: true, cwd: "/srv/app", sessionFile: "/tmp/session.jsonl" });
		useActivitySidebarStore.setState({ expandedMeta: "plan" });
		await mount(<PlanActivitySection maxDetailHeight={180} readOnly={false} />);
		const feedback = document.querySelector<HTMLButtonElement>('[aria-label="Give feedback on step 1"]');
		if (!feedback) throw new Error("Expected Main step feedback control");
		await act(async () => feedback.click());
		expect(document.querySelector("textarea")).not.toBeNull();

		await act(async () => {
			root?.render(
				<I18nProvider>
					<PlanActivitySection maxDetailHeight={180} readOnly />
				</I18nProvider>,
			);
		});
		expect(document.querySelector("textarea")).toBeNull();
		expect(document.querySelector('[aria-label="Give feedback on step 1"]')).toBeNull();
		expect(document.querySelector('[aria-label="Toggle plan mode"]')).toBeNull();
	});
});
