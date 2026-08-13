import { describe, expect, expectTypeOf, it } from "vitest";
import type { RemoteHistorySession, SshSessionTarget } from "./ipc-types";
import { normalizeSessionTarget } from "./session-target";

describe("normalizeSessionTarget", () => {
	it("defaults a missing target to local", () => {
		expect(normalizeSessionTarget(undefined)).toEqual({ type: "local" });
	});

	it("rejects null and structurally invalid runtime targets", () => {
		expect(() => normalizeSessionTarget(null)).toThrow(TypeError);
		expect(() => normalizeSessionTarget({ type: "ssh" })).toThrow(TypeError);
	});

	it("preserves an SSH target's identity", () => {
		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: "build",
			host: {
				host: "build.example",
				username: "danny",
				port: 22,
				sourceId: "ssh-json",
				sourceLevel: "user",
			},
			originCwd: "/srv/app",
			cwd: "/srv/app",
		};

		expect(normalizeSessionTarget(target)).toBe(target);
	});
});

expectTypeOf<RemoteHistorySession["updatedAt"]>().toEqualTypeOf<string | null>();
