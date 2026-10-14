/**
 * The tab strip's single status glyph, shared by the chip, the sidebar, and the
 * close rules. What a tab looks like while it is NOT running matters as much as
 * while it is: a restored session shows several of these at once, before any of
 * them has a process.
 */

import { describe, expect, it } from "vitest";
import type { SessionTab } from "../stores/tabs";
import { tabSignalPresentation } from "./tab-signal";

function tab(overrides: Partial<SessionTab>): SessionTab {
	return {
		kind: "agent",
		id: "a",
		cwd: "/work/a",
		target: { type: "local" },
		status: "ready",
		unreadDone: false,
		...overrides,
	};
}

describe("tabSignalPresentation", () => {
	it("pulses only for work that is actually in flight", () => {
		expect(tabSignalPresentation(tab({ status: "running" })).running).toBe(true);
		expect(tabSignalPresentation(tab({ status: "ready", compacting: true })).active).toBe(true);
		expect(tabSignalPresentation(tab({ status: "ready" })).active).toBe(false);
	});

	it("marks a never-spawned restored tab inert instead of booting", () => {
		// "starting" pulses a warning dot; a deferred tab has nothing coming up
		// until it is shown, so a strip full of warning dots would be a lie.
		expect(tabSignalPresentation(tab({ status: "asleep" }))).toEqual({
			active: false,
			color: "var(--omp-dim)",
			labelKey: "titlebar.status.asleep",
			running: false,
		});
		expect(tabSignalPresentation(tab({ status: "starting" })).active).toBe(true);
	});

	it("keeps a finished background run readable over the idle state", () => {
		expect(tabSignalPresentation(tab({ status: "ready", unreadDone: true })).labelKey).toBe("tabs.done");
	});

	it("shows retry amber without losing the live-close guard", () => {
		expect(tabSignalPresentation(tab({ status: "running", runState: "retrying" }))).toMatchObject({
			color: "var(--omp-warning)",
			running: true,
		});
	});

	it("keeps a failed turn red and a completed turn green after the connection is ready", () => {
		expect(tabSignalPresentation(tab({ runState: "failed", unreadDone: true }))).toMatchObject({
			color: "var(--omp-error)",
			running: false,
		});
		expect(tabSignalPresentation(tab({ runState: "completed" }))).toMatchObject({
			color: "var(--omp-success)",
			running: false,
		});
		expect(tabSignalPresentation(tab({ status: "exited", runState: "completed" })).color).toBe("var(--omp-error)");
	});
});
