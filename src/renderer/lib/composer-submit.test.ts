/**
 * Contract tests for composer submission policy (lib/composer-submit):
 * ordinary text always routes through prompt with its intended queue lane so
 * the sidecar decides atomically whether to start or queue at a turn boundary;
 * typed slash commands always route through prompt without becoming literal
 * steers/follow-ups; session-replacing commands are blocked while a turn runs;
 * and local-only mutations rehydrate without erasing live-only command output.
 */

import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AvailableCommand, RpcResponse } from "../../shared/rpc-types";
import { useSessionStore } from "../stores/session";
import { useToastStore } from "../stores/toast";
import { useUiStore } from "../stores/ui";
import { planComposerSubmit, settleComposerResponse } from "./composer-submit";

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

interface MockOmp {
	rpc: {
		prompt: Mock<
			(message: string, images?: unknown[], streamingBehavior?: "steer" | "followUp") => Promise<RpcResponse>
		>;
		compact: Mock<() => Promise<RpcResponse>>;
		steer: Mock<(message: string, images?: unknown[]) => Promise<RpcResponse>>;
		followUp: Mock<(message: string, images?: unknown[]) => Promise<RpcResponse>>;
		dropSession: Mock<() => Promise<RpcResponse>>;
		guidedGoal: Mock<(initial?: string) => Promise<RpcResponse>>;
		setAgentsPaused: Mock<(enabled: boolean) => Promise<RpcResponse>>;
		tan: Mock<(work: string) => Promise<RpcResponse>>;
		omfg: Mock<(complaint: string) => Promise<RpcResponse>>;
		collabStart: Mock<(relay?: string, view?: boolean) => Promise<RpcResponse>>;
		getState: Mock<() => Promise<RpcResponse>>;
		getMessages: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
		setSubagentSubscription: Mock<(level: string) => Promise<RpcResponse>>;
	};
	sessions: { consumePendingOpen: Mock<() => Promise<unknown>> };
}

function installMockOmp(): MockOmp {
	const omp: MockOmp = {
		rpc: {
			prompt: vi.fn(async () => success({})),
			compact: vi.fn(async () => ({ ...success({}), command: "compact" })),
			steer: vi.fn(async () => success({})),
			followUp: vi.fn(async () => success({})),
			dropSession: vi.fn(async () => success({ cancelled: false })),
			guidedGoal: vi.fn(async () => success({ started: true })),
			setAgentsPaused: vi.fn(async enabled => success({ paused: enabled, pausedAt: enabled ? 123 : undefined })),
			tan: vi.fn(async () => success({ jobId: "job-1" })),
			omfg: vi.fn(async () => success({ state: "saved", savedPath: "/tmp/rule.md" })),
			collabStart: vi.fn(async () => success({ role: "host", readOnly: false, participants: [] })),
			getState: vi.fn(async () =>
				success({
					sessionId: "s1",
					sessionName: null,
					sessionFile: null,
					cwd: "/tmp",
					isStreaming: false,
					isCompacting: false,
					contextUsage: null,
					messageCount: 0,
					queuedMessageCount: 0,
					planModeEnabled: false,
					todoPhases: [],
				}),
			),
			getMessages: vi.fn(async () => success({ messages: [] })),
			getSubagents: vi.fn(async () => success({ subagents: [] })),
			setSubagentSubscription: vi.fn(async () => success({})),
		},
		sessions: { consumePendingOpen: vi.fn(async () => null) },
	};
	(globalThis as Record<string, unknown>).window = { omp, confirm: vi.fn(() => true), close: vi.fn() };
	return omp;
}

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).window;
	useToastStore.setState({ toasts: [] });
	useUiStore.setState({ settingsOpen: false, copySelectorOpen: false, btwRequest: null, collabOpen: false });
	useSessionStore.setState({ agentsPaused: false, agentsPausedAt: null });
});

const guiOnly = (name: string): AvailableCommand => ({
	name,
	description: name,
	source: "builtin",
	textModeExecutable: false,
});
describe("planComposerSubmit", () => {
	it("routes typed /compact through its long-running RPC instead of the 8s prompt path", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/compact",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [],
		});
		expect(submit.kind).toBe("send");
		if (submit.kind !== "send") return;
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
		await submit.request();
		expect(omp.rpc.compact).toHaveBeenCalledOnce();
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("routes typed /usage through the sidecar text report with its actual advertised shape", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/usage",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [{ name: "usage", description: "Show provider usage", source: "builtin" }],
		});
		if (submit.kind !== "send") throw new Error("expected send");

		await submit.request();

		expect(omp.rpc.prompt).toHaveBeenCalledWith("/usage", []);
	});

	it("routes /compact through its dedicated RPC even while streaming — never steer/followUp", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/compact",
			images: [],
			isStreaming: true,
			mode: "steer",
			commands: [],
		});
		expect(submit.kind).toBe("send");
		if (submit.kind !== "send") return;
		await submit.request();
		expect(omp.rpc.compact).toHaveBeenCalledOnce();
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
		expect(omp.rpc.steer).not.toHaveBeenCalled();
		expect(omp.rpc.followUp).not.toHaveBeenCalled();
	});

	it("lets the sidecar decide whether plain text starts now or queues at the turn boundary", async () => {
		const omp = installMockOmp();
		const steerSubmit = planComposerSubmit({
			message: "hello",
			images: [],
			isStreaming: true,
			mode: "steer",
			commands: [],
		});
		if (steerSubmit.kind !== "send") throw new Error("expected send");
		await steerSubmit.request();
		expect(omp.rpc.prompt).toHaveBeenCalledWith("hello", [], "steer");
		expect(omp.rpc.steer).not.toHaveBeenCalled();

		const followUpSubmit = planComposerSubmit({
			message: "again",
			images: [],
			isStreaming: true,
			mode: "followUp",
			commands: [],
		});
		if (followUpSubmit.kind !== "send") throw new Error("expected send");
		await followUpSubmit.request();
		expect(omp.rpc.prompt).toHaveBeenCalledWith("again", [], "followUp");
		expect(omp.rpc.followUp).not.toHaveBeenCalled();
	});

	it("routes exact /clear to the native clear path when idle — never to the model", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/clear",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [],
		});
		expect(submit.kind).toBe("clear");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("still routes /clear with args through prompt (no native interception)", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/clear extra",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [],
		});
		expect(submit.kind).toBe("send");
		if (submit.kind !== "send") return;
		await submit.request();
		expect(omp.rpc.prompt).toHaveBeenCalledWith("/clear extra", []);
	});

	it.each(["/new", "/clear", "/new extra args"])(
		"blocks %s while a turn is running instead of silently killing it",
		async message => {
			const omp = installMockOmp();
			const submit = planComposerSubmit({ message, images: [], isStreaming: true, mode: "prompt", commands: [] });
			expect(submit.kind).toBe("blocked");
			expect(omp.rpc.prompt).not.toHaveBeenCalled();
			expect(omp.rpc.steer).not.toHaveBeenCalled();
			expect(useToastStore.getState().toasts.some(toast => toast.variant === "warning")).toBe(true);
		},
	);

	it("allows /new when idle", () => {
		installMockOmp();
		const submit = planComposerSubmit({
			message: "/new",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [],
		});
		expect(submit.kind).toBe("send");
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});
});

describe("planComposerSubmit GUI-only routing", () => {
	it("routes typed TUI-only commands through a matching native GUI affordance", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/settings",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("settings")],
		});
		expect(submit.kind).toBe("handled");
		expect(useUiStore.getState().settingsOpen).toBe(true);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("maps typed /exit to closing only the current GUI window", () => {
		const omp = installMockOmp();
		const close = vi.fn();
		((globalThis as Record<string, unknown>).window as Record<string, unknown>).close = close;
		const submit = planComposerSubmit({
			message: "/exit",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("exit")],
		});

		expect(submit.kind).toBe("handled");
		expect(close).toHaveBeenCalledTimes(1);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("passes typed /guided-goal arguments to the native guided interview RPC", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/guided-goal ship reliable sync",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("guided-goal")],
		});

		expect(submit.kind).toBe("handled");
		expect(omp.rpc.guidedGoal).toHaveBeenCalledWith("ship reliable sync");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("toggles the process-wide pause gate from typed /pause", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/pause",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("pause")],
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(submit.kind).toBe("handled");
		expect(omp.rpc.setAgentsPaused).toHaveBeenCalledWith(true);
		expect(useSessionStore.getState().agentsPaused).toBe(true);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("opens the native copy selector for typed /copy", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/copy",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("copy")],
		});

		expect(submit.kind).toBe("handled");
		expect(useUiStore.getState().copySelectorOpen).toBe(true);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("opens the native ephemeral side-question flow for typed /btw", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/btw why did this fail?",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("btw")],
		});

		expect(submit.kind).toBe("handled");
		expect(useUiStore.getState().btwRequest).toBe("why did this fail?");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("dispatches typed /tan work through the background-agent RPC", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/tan investigate the flaky test",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("tan")],
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(submit.kind).toBe("handled");
		expect(omp.rpc.tan).toHaveBeenCalledWith("investigate the flaky test");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("runs typed /omfg through the RPC-hosted confirmation workflow", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/omfg stop repeating stale advice",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("omfg")],
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(submit.kind).toBe("handled");
		expect(omp.rpc.omfg).toHaveBeenCalledWith("stop repeating stale advice");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("routes typed /drop through confirmation and the destructive session RPC", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/drop",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("drop")],
		});

		expect(submit.kind).toBe("handled");
		expect(omp.rpc.dropSession).toHaveBeenCalledTimes(1);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("opens native live collaboration for typed /collab without leaking it to the model", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/collab",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("collab")],
		});
		expect(submit.kind).toBe("handled");
		expect(useUiStore.getState().collabOpen).toBe(true);
		expect(omp.rpc.collabStart).not.toHaveBeenCalled();
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
	});

	it("blocks an advertised non-text command until it has a native GUI affordance", () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({
			message: "/future-native",
			images: [],
			isStreaming: false,
			mode: "prompt",
			commands: [guiOnly("future-native")],
		});
		expect(submit.kind).toBe("blocked");
		expect(omp.rpc.prompt).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts.some(toast => toast.variant === "warning")).toBe(true);
	});
});

describe("settleComposerResponse", () => {
	it("rehydrates on agentInvoked:false (local-only slash command)", async () => {
		const omp = installMockOmp();
		await settleComposerResponse(success({ agentInvoked: false }));
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(omp.rpc.getMessages).toHaveBeenCalled();
	});

	it("rehydrates after dedicated compaction completes", async () => {
		const omp = installMockOmp();
		await settleComposerResponse({ ...success({}), command: "compact" });
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(omp.rpc.getMessages).toHaveBeenCalled();
	});

	it("does not rehydrate usage subcommands because their command output is live-only", async () => {
		const omp = installMockOmp();
		await settleComposerResponse(success({ agentInvoked: false }), "/usage reset active");
		expect(omp.rpc.getState).not.toHaveBeenCalled();
		expect(omp.rpc.getMessages).not.toHaveBeenCalled();
	});

	it("does not rehydrate when the agent was invoked (events stream normally)", async () => {
		const omp = installMockOmp();
		await settleComposerResponse(success({ agentInvoked: true }));
		expect(omp.rpc.getState).not.toHaveBeenCalled();
	});

	it("does not rehydrate on failure responses or missing data", async () => {
		const omp = installMockOmp();
		await settleComposerResponse({ type: "response", command: "prompt", success: false, error: "boom" });
		await settleComposerResponse(success({}));
		expect(omp.rpc.getState).not.toHaveBeenCalled();
	});
});
