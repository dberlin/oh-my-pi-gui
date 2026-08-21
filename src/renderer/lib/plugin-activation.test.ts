import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { usePluginActivationStore } from "../stores/plugin-activation";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { handlePluginActivation, restartForActivation, watchPluginActivation } from "./plugin-activation";

const FAST = { verifyAttempts: 2, verifyIntervalMs: 1 };

afterEach(() => {
	usePluginActivationStore.getState().clearActivation();
	useSessionStore.setState({ isStreaming: false, isCompacting: false, sessionFile: null });
	vi.restoreAllMocks();
});

function stubOmp(overrides: { restart?: Mock; getPlugins?: Mock } = {}): void {
	(globalThis as unknown as Record<string, unknown>).window = {
		omp: {
			sidecar: { restart: overrides.restart ?? vi.fn(async () => {}) },
			rpc: { getPlugins: overrides.getPlugins ?? vi.fn(async () => ({ success: false })) },
		},
	};
}

function okPlugins(plugins: unknown): { success: true; data: unknown } {
	return { success: true, data: { plugins } };
}

describe("handlePluginActivation", () => {
	it("restarts immediately when idle, resuming the current session", async () => {
		const restart = vi.fn(async () => {});
		stubOmp({
			restart,
			getPlugins: vi.fn(async () => okPlugins([{ id: "demo@official", name: "demo", enabled: true }])),
		});
		useSessionStore.setState({ isStreaming: false, isCompacting: false, sessionFile: "/s.json" });
		handlePluginActivation("restart-required", "demo@official", FAST);
		await vi.waitFor(() => expect(restart).toHaveBeenCalledWith("/s.json"));
		await vi.waitFor(() => expect(usePluginActivationStore.getState().pendingId).toBeNull());
	});

	it("queues while streaming without restarting", () => {
		const restart = vi.fn(async () => {});
		stubOmp({ restart });
		useSessionStore.setState({ isStreaming: true, isCompacting: false });
		handlePluginActivation("restart-required", "demo@official", FAST);
		expect(usePluginActivationStore.getState().pendingId).toBe("demo@official");
		expect(restart).not.toHaveBeenCalled();
	});

	it("ignores live activations", () => {
		const restart = vi.fn(async () => {});
		stubOmp({ restart });
		handlePluginActivation("live", "demo@official", FAST);
		expect(usePluginActivationStore.getState().pendingId).toBeNull();
		expect(restart).not.toHaveBeenCalled();
	});

	it("fires the queued restart once the run settles in the requesting tab", async () => {
		const restart = vi.fn(async () => {});
		stubOmp({
			restart,
			getPlugins: vi.fn(async () => okPlugins([{ id: "demo@official", name: "demo", enabled: true }])),
		});
		useTabsStore.setState({
			tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
			activeTabId: "t1",
			bundles: new Map(),
		});
		useSessionStore.setState({ isStreaming: true, isCompacting: false, sessionFile: null });
		handlePluginActivation("restart-required", "demo@official", FAST);
		const unwatch = watchPluginActivation();
		useSessionStore.setState({ isStreaming: false, sessionFile: "/s.json" });
		await vi.waitFor(() => expect(restart).toHaveBeenCalledWith("/s.json"));
		expect(usePluginActivationStore.getState().pendingId).toBeNull();
		unwatch();
	});

	it("does not fire the queued restart after switching to another tab", async () => {
		const restart = vi.fn(async () => {});
		stubOmp({ restart, getPlugins: vi.fn(async () => okPlugins([])) });
		useTabsStore.setState({
			tabs: [
				{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false },
				{ id: "t2", cwd: "/w2", status: "ready", kind: "agent", unreadDone: false },
			],
			activeTabId: "t1",
			bundles: new Map(),
		});
		useSessionStore.setState({ isStreaming: true, isCompacting: false, sessionFile: null });
		handlePluginActivation("restart-required", "demo@official", FAST);
		const unwatch = watchPluginActivation();
		// Foreground switches to tab 2 and goes idle there: the origin tab's
		// queued restart must NOT hijack tab 2's sidecar.
		useTabsStore.setState({ activeTabId: "t2" });
		useSessionStore.setState({ isStreaming: false, sessionFile: "/s2.json" });
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(restart).not.toHaveBeenCalled();
		expect(usePluginActivationStore.getState().pendingId).toBe("demo@official");
		unwatch();
	});
});

describe("restartForActivation verification", () => {
	it("verifies the plugin is listed and enabled after restart", async () => {
		const restart = vi.fn(async () => {});
		const getPlugins = vi.fn(async () => okPlugins([{ id: "demo@official", name: "demo", enabled: true }]));
		stubOmp({ restart, getPlugins });
		useSessionStore.setState({ sessionFile: "/s.json" });
		const outcome = await restartForActivation("demo@official", FAST);
		expect(restart).toHaveBeenCalledWith("/s.json");
		expect(outcome).toBe("restarted");
	});

	it("reports missing when the plugin never appears", async () => {
		const restart = vi.fn(async () => {});
		const getPlugins = vi.fn(async () => okPlugins([]));
		stubOmp({ restart, getPlugins });
		const outcome = await restartForActivation("demo@official", FAST);
		expect(outcome).toBe("missing");
	});

	it("treats a disabled listing as not loaded", async () => {
		const restart = vi.fn(async () => {});
		const getPlugins = vi.fn(async () => okPlugins([{ id: "demo@official", name: "demo", enabled: false }]));
		stubOmp({ restart, getPlugins });
		const outcome = await restartForActivation("demo@official", FAST);
		expect(outcome).toBe("missing");
	});

	it("skips verification when there is no plugin id", async () => {
		const restart = vi.fn(async () => {});
		const getPlugins = vi.fn(async () => okPlugins([]));
		stubOmp({ restart, getPlugins });
		const outcome = await restartForActivation(null, FAST);
		expect(outcome).toBeUndefined();
		expect(getPlugins).not.toHaveBeenCalled();
	});
});
