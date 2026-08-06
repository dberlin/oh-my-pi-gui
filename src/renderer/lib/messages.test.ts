import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreQueuedMessages } from "./messages";

interface FillComposerDetail {
	text?: string;
	images?: unknown[];
	prepend?: boolean;
}

function installWindow(messages: Array<{ text: string; mode: "steer" | "followUp" }>) {
	const deliveryOrder: string[] = [];
	let fillDetail: FillComposerDetail | undefined;
	const rpc = {
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
	vi.restoreAllMocks();
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
