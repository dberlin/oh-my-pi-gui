import { describe, expect, it } from "vitest";
import { translate } from "./i18n";

describe("translation parameter interpolation", () => {
	it("fills every occurrence of a parameter without interpreting replacement metacharacters", () => {
		expect(translate("{model} opens this history with {model}", { model: "provider/$&" })).toBe(
			"provider/$& opens this history with provider/$&",
		);
	});
});
