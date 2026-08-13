import { describe, expect, it } from "vitest";
import { statsServerArgs, statsServerPort } from "./stats-server";

describe("statsServerArgs", () => {
	it("starts the bundled dashboard without opening an external browser", () => {
		expect(statsServerArgs(3847)).toEqual(["stats", "--port", "3847", "--no-open"]);
	});
});

describe("statsServerPort", () => {
	it("accepts the IPv4 loopback URL emitted by the bundled stats command", () => {
		expect(statsServerPort("Dashboard available at: http://127.0.0.1:3847")).toBe(3847);
	});
});
