/**
 * Contract test for the tool-result unwrapper (TUI-parity P0.1/P0.2). The same
 * tool result reaches renderers as a live `AgentToolResult` envelope
 * `{content:[{type:"text",text}], details:{…}}` or as hydrated history (same
 * envelope, details now preserved). Renderers must see body text + structured
 * details — never the raw JSON of the envelope itself.
 */

import { describe, expect, it } from "vitest";
import { resultDetails, resultText } from "./format";

const liveEnvelope = {
	content: [
		{ type: "text", text: "hello output" },
		{ type: "image", data: "base64…", mimeType: "image/png" },
	],
	details: { exitCode: 0, diff: "@@ -1 +1 @@", phases: [{ name: "p" }] },
};

describe("resultText envelope unwrap", () => {
	it("unwraps the live {content,details} envelope to body text, not JSON", () => {
		expect(resultText(liveEnvelope)).toBe("hello output");
		expect(resultText(liveEnvelope)).not.toContain('"details"');
	});

	it("skips non-text content blocks (image) instead of JSON-stringifying them", () => {
		expect(
			resultText({
				content: [
					{ type: "image", data: "x" },
					{ type: "text", text: "cap" },
				],
			}),
		).toBe("cap");
	});

	it("handles a bare hydrated content array", () => {
		expect(
			resultText([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
	});

	it("still handles plain strings / stdout envelopes", () => {
		expect(resultText("plain")).toBe("plain");
		expect(resultText({ stdout: "out", stderr: "err" })).toBe("out\nerr");
	});
});

describe("resultDetails", () => {
	it("returns the details object from a live envelope", () => {
		expect(resultDetails(liveEnvelope)).toEqual({ exitCode: 0, diff: "@@ -1 +1 @@", phases: [{ name: "p" }] });
	});

	it("returns undefined for a bare content array or non-object", () => {
		expect(resultDetails([{ type: "text", text: "a" }])).toBeUndefined();
		expect(resultDetails("str")).toBeUndefined();
		expect(resultDetails(null)).toBeUndefined();
	});
});
