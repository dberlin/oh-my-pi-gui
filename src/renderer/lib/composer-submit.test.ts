/**
 * Contract tests for composer submission policy (lib/composer-submit):
 * typed slash commands always route through the prompt RPC (the server
 * parses them even mid-stream; steer/followUp would inject the text as a
 * user steer), session-replacing commands (/new, /clear) are blocked while
 * a turn runs instead of silently killing it, and local-only resolutions
 * (agentInvoked:false, no agent events) trigger a rehydrate so the
 * transcript/context bar reflect the mutation.
 */

import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import { useToastStore } from "../stores/toast";
import { planComposerSubmit, settleComposerResponse } from "./composer-submit";

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

interface MockOmp {
	rpc: {
		prompt: Mock<(message: string, images?: unknown[]) => Promise<RpcResponse>>;
		steer: Mock<(message: string, images?: unknown[]) => Promise<RpcResponse>>;
		followUp: Mock<(message: string, images?: unknown[]) => Promise<RpcResponse>>;
		getState: Mock<() => Promise<RpcResponse>>;
		getTranscript: Mock<() => Promise<RpcResponse>>;
		getSubagents: Mock<() => Promise<RpcResponse>>;
	};
	sessions: { consumePendingOpen: Mock<() => Promise<unknown>> };
}

function installMockOmp(): MockOmp {
	const omp: MockOmp = {
		rpc: {
			prompt: vi.fn(async () => success({})),
			steer: vi.fn(async () => success({})),
			followUp: vi.fn(async () => success({})),
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
			getTranscript: vi.fn(async () => success({ messages: [] })),
			getSubagents: vi.fn(async () => success({ subagents: [] })),
		},
		sessions: { consumePendingOpen: vi.fn(async () => null) },
	};
	(globalThis as Record<string, unknown>).window = { omp };
	return omp;
}

afterEach(() => {
	vi.restoreAllMocks();
	delete (globalThis as Record<string, unknown>).window;
	useToastStore.setState({ toasts: [] });
});

describe("planComposerSubmit", () => {
	it("routes typed /compact through prompt", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({ message: "/compact", images: [], isStreaming: false, mode: "prompt" });
		expect(submit.kind).toBe("send");
		if (submit.kind !== "send") return;
		await submit.request;
		expect(omp.rpc.prompt).toHaveBeenCalledWith("/compact", []);
	});

	it("routes /compact through prompt even while streaming — never steer/followUp", async () => {
		const omp = installMockOmp();
		const submit = planComposerSubmit({ message: "/compact", images: [], isStreaming: true, mode: "steer" });
		expect(submit.kind).toBe("send");
		if (submit.kind !== "send") return;
		await submit.request;
		expect(omp.rpc.prompt).toHaveBeenCalledWith("/compact", []);
		expect(omp.rpc.steer).not.toHaveBeenCalled();
		expect(omp.rpc.followUp).not.toHaveBeenCalled();
	});

	it("routes plain text through steer (or followUp) while streaming", async () => {
		const omp = installMockOmp();
		const steerSubmit = planComposerSubmit({ message: "hello", images: [], isStreaming: true, mode: "steer" });
		if (steerSubmit.kind !== "send") throw new Error("expected send");
		await steerSubmit.request;
		expect(omp.rpc.steer).toHaveBeenCalledWith("hello", []);
		expect(omp.rpc.prompt).not.toHaveBeenCalled();

		const followUpSubmit = planComposerSubmit({
			message: "again",
			images: [],
			isStreaming: true,
			mode: "followUp",
		});
		if (followUpSubmit.kind !== "send") throw new Error("expected send");
		await followUpSubmit.request;
		expect(omp.rpc.followUp).toHaveBeenCalledWith("again", []);
	});

	it.each(["/new", "/clear", "/new extra args"])(
		"blocks %s while a turn is running instead of silently killing it",
		async message => {
			const omp = installMockOmp();
			const submit = planComposerSubmit({ message, images: [], isStreaming: true, mode: "prompt" });
			expect(submit.kind).toBe("blocked");
			expect(omp.rpc.prompt).not.toHaveBeenCalled();
			expect(omp.rpc.steer).not.toHaveBeenCalled();
			expect(useToastStore.getState().toasts.some(toast => toast.variant === "warning")).toBe(true);
		},
	);

	it("allows /new when idle", () => {
		installMockOmp();
		const submit = planComposerSubmit({ message: "/new", images: [], isStreaming: false, mode: "prompt" });
		expect(submit.kind).toBe("send");
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});
});

describe("settleComposerResponse", () => {
	it("rehydrates on agentInvoked:false (local-only slash command)", async () => {
		const omp = installMockOmp();
		await settleComposerResponse(success({ agentInvoked: false }));
		expect(omp.rpc.getState).toHaveBeenCalled();
		expect(omp.rpc.getTranscript).toHaveBeenCalled();
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
