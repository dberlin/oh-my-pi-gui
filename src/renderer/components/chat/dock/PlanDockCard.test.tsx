import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SshSessionTarget } from "../../../../shared/ipc-types";
import { I18nProvider } from "../../../lib/i18n";
import { resetTabRoute } from "../../../lib/tab-routing";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";

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
const { PlanDockCard } = await import("./PlanDockCard");

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
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useUiStore.setState({ dockCollapsed: {}, dockFocus: null });
	resetTabRoute();
	vi.restoreAllMocks();
});

describe("PlanDockCard remote preview", () => {
	it("keeps the SSH plan payload target-free so main resolves and bounds the remote file", async () => {
		const omp = installOmp();
		useSessionStore.setState({
			planModeEnabled: true,
			cwd: REMOTE_TARGET.cwd,
			sessionFile: "/home/deploy/.omp/sessions/remote-session-7.jsonl",
			isStreaming: false,
		});
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

		await mount(<PlanDockCard />);

		expect(omp.fs.readPlan).toHaveBeenCalledWith({ fsPath: "/srv/app/plan.md", localRoot: null });
		expect(container?.textContent).toContain("Read the remote-only plan");
	});
});
