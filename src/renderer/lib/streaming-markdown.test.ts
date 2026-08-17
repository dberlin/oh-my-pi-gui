import { describe, expect, it } from "vitest";
import { segmentStreamingMarkdown } from "./streaming-markdown";

describe("streaming Markdown segmentation", () => {
	it("promotes complete paragraphs while leaving the unfinished tail mutable", () => {
		const source = "First **complete** paragraph.\n\nSecond paragraph is still growing";
		const result = segmentStreamingMarkdown(source);

		expect(result.blocks).toEqual([{ end: 31, content: "First **complete** paragraph.\n\n" }]);
		expect(result.tailStart).toBe(31);
		expect(result.tail).toBe("Second paragraph is still growing");
	});

	it("does not split blank lines inside an unfinished fenced code block", () => {
		const source = "```ts\nconst first = 1;\n\nconst second = 2;";
		const result = segmentStreamingMarkdown(source);

		expect(result.blocks).toEqual([]);
		expect(result.tail).toBe(source);
	});

	it("promotes a fenced code block as soon as its closing line is complete", () => {
		const code = "```ts\nconst first = 1;\n\nconst second = 2;\n```\n";
		const result = segmentStreamingMarkdown(`${code}Next`);

		expect(result.blocks).toEqual([{ end: code.length, content: code }]);
		expect(result.tail).toBe("Next");
	});

	it("keeps display-math blank lines together until the closing fence", () => {
		const math = "$$\na + b\n\nc + d\n$$\n";
		const result = segmentStreamingMarkdown(`${math}Explanation`);

		expect(result.blocks).toEqual([{ end: math.length, content: math }]);
		expect(result.tail).toBe("Explanation");
	});
});
