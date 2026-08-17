import { describe, expect, it, vi } from "vitest";
import { createQuitSequence } from "./quit-sequence";

interface Harness {
	request: (cancelQuit: () => void) => void;
	cancelQuit: () => void;
	quit: () => void;
	onError: () => void;
	finishCleanup: (error?: unknown) => Promise<void>;
	/** Run the callbacks handed to `schedule`, mimicking a later macrotask. */
	runScheduled: () => void;
	scheduled: () => number;
}

function harness(): Harness {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const quit = vi.fn();
	const onError = vi.fn();
	const cancelQuit = vi.fn();
	const pending: Array<() => void> = [];
	const request = createQuitSequence({
		cleanup: () => promise,
		quit,
		schedule: run => pending.push(run),
		onError,
	});
	return {
		request,
		cancelQuit,
		quit,
		onError,
		finishCleanup: async (error?: unknown) => {
			if (error === undefined) resolve();
			else reject(error);
			// Let the cleanup chain's catch/finally handlers settle.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		},
		runScheduled: () => {
			for (const run of pending.splice(0)) run();
		},
		scheduled: () => pending.length,
	};
}

describe("createQuitSequence", () => {
	it("cancels the first quit so async cleanup can run", () => {
		const h = harness();
		h.request(h.cancelQuit);
		expect(h.cancelQuit).toHaveBeenCalledTimes(1);
		expect(h.quit).not.toHaveBeenCalled();
	});

	it("defers the re-quit to a later macrotask instead of quitting inline", async () => {
		// Regression guard: quitting from the cleanup continuation runs inside the
		// quit sequence we just cancelled, and Electron ignores it — that is the
		// bug that made ⌘Q require two presses.
		const h = harness();
		h.request(h.cancelQuit);
		await h.finishCleanup();

		expect(h.quit).not.toHaveBeenCalled();
		expect(h.scheduled()).toBe(1);

		h.runScheduled();
		expect(h.quit).toHaveBeenCalledTimes(1);
	});

	it("stops cancelling once draining finished so the next request quits", async () => {
		const h = harness();
		h.request(h.cancelQuit);
		await h.finishCleanup();
		h.runScheduled();

		const secondCancel = vi.fn();
		h.request(secondCancel);
		expect(secondCancel).not.toHaveBeenCalled();
	});

	it("cancels repeat requests while draining without restarting cleanup", () => {
		const cleanup = vi.fn(() => new Promise<void>(() => {}));
		const quit = vi.fn();
		const request = createQuitSequence({ cleanup, quit, schedule: () => {}, onError: () => {} });

		const first = vi.fn();
		const second = vi.fn();
		request(first);
		request(second);

		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(first).toHaveBeenCalledTimes(1);
		expect(second).toHaveBeenCalledTimes(1);
		expect(quit).not.toHaveBeenCalled();
	});

	it("still quits when cleanup rejects, reporting the failure", async () => {
		const h = harness();
		h.request(h.cancelQuit);
		await h.finishCleanup(new Error("sidecar refused to stop"));
		h.runScheduled();

		expect(h.onError).toHaveBeenCalledTimes(1);
		expect(h.quit).toHaveBeenCalledTimes(1);
	});
});
