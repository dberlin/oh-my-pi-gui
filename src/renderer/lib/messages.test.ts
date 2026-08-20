import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../stores/session";
import { abortActiveTurn, restoreQueuedMessages } from "./messages";

interface FillComposerDetail {
	text?: string;
	images?: unknown[];
	prepend?: boolean;
}

function installWindow(messages: Array<{ text: string; mode: "steer" | "followUp" }>) {
	const deliveryOrder: string[] = [];
	let fillDetail: FillComposerDetail | undefined;
	const rpc = {
		abort: vi.fn(async () => ({ success: true as const })),
		abortRetry: vi.fn(async () => ({ success: true as const })),
		dequeue: vi.fn(async () => ({ success: true as const, data: { messages } })),
		steer: vi.fn(async (text: string) => {
			deliveryOrder.push(`steer:${text}`);
			return { success: true as const };
		}),
		followUp: vi.fn(async (text: string) => {
			deliveryOrder.push(`followUp:${text}`);
			return { success: true as const };
		}),
	};
	(globalThis as Record<string, unknown>).window = {
		omp: { rpc },
		dispatchEvent: (event: CustomEvent<FillComposerDetail>) => {
			fillDetail = event.detail;
			return true;
		},
	};
	return { rpc, deliveryOrder, fillDetail: () => fillDetail };
}

afterEach(() => {
	delete (globalThis as Record<string, unknown>).window;
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("abortActiveTurn", () => {
	it("clears a retry immediately and cancels it before aborting the turn", async () => {
		const harness = installWindow([]);
		const retryAbort = Promise.withResolvers<{ success: true }>();
		harness.rpc.abortRetry.mockReturnValue(retryAbort.promise);
		useSessionStore.setState({
			isStreaming: true,
			awaitingModelSince: Date.now(),
			retryInfo: { attempt: 1, maxAttempts: 10, delayMs: 5_000, errorMessage: "timeout", startedAt: Date.now() },
		});

		const aborting = abortActiveTurn();

		expect(useSessionStore.getState().retryInfo).toBeNull();
		expect(useSessionStore.getState().awaitingModelSince).toBeNull();
		expect(harness.rpc.abortRetry).toHaveBeenCalledTimes(1);
		expect(harness.rpc.abort).not.toHaveBeenCalled();

		retryAbort.resolve({ success: true });
		await aborting;

		expect(harness.rpc.abort).toHaveBeenCalledTimes(1);
		expect(harness.rpc.abortRetry.mock.invocationCallOrder[0]).toBeLessThan(
			harness.rpc.abort.mock.invocationCallOrder[0],
		);
	});
});

describe("restoreQueuedMessages", () => {
	it("restores the newest item and preserves each earlier delivery lane and order", async () => {
		const harness = installWindow([
			{ text: "older follow-up", mode: "followUp" },
			{ text: "newer steer", mode: "steer" },
			{ text: "newest follow-up", mode: "followUp" },
		]);

		await restoreQueuedMessages(() => {
			throw new Error("queue unexpectedly empty");
		});

		expect(harness.fillDetail()).toMatchObject({ text: "newest follow-up", prepend: true });
		expect(harness.deliveryOrder).toEqual(["followUp:older follow-up", "steer:newer steer"]);
		expect(harness.rpc.followUp).toHaveBeenCalledTimes(1);
		expect(harness.rpc.steer).toHaveBeenCalledTimes(1);
	});

	it("reports an empty queue without dispatching or re-queuing", async () => {
		const harness = installWindow([]);
		const onEmpty = vi.fn();

		await restoreQueuedMessages(onEmpty);

		expect(onEmpty).toHaveBeenCalledTimes(1);
		expect(harness.fillDetail()).toBeUndefined();
		expect(harness.deliveryOrder).toEqual([]);
	});
});
