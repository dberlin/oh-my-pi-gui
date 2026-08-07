import { describe, expect, it } from "vitest";
import { RENDERER_RECOVERY_COOLDOWN_MS, shouldReloadRenderer } from "./renderer-recovery";

describe("renderer crash recovery", () => {
	it("reloads an abnormal renderer exit after a stable interval", () => {
		expect(shouldReloadRenderer("crashed", 1_000, 1_000 + RENDERER_RECOVERY_COOLDOWN_MS)).toBe(true);
		expect(shouldReloadRenderer("oom", 0, RENDERER_RECOVERY_COOLDOWN_MS)).toBe(true);
	});

	it("does not reload clean exits or repeat a crash loop inside the cooldown", () => {
		expect(shouldReloadRenderer("clean-exit", 0, RENDERER_RECOVERY_COOLDOWN_MS)).toBe(false);
		expect(shouldReloadRenderer("crashed", 10_000, 10_001)).toBe(false);
	});
});
