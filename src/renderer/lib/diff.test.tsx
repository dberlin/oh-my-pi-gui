import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { DiffView, parseDiff } from "./diff";
import { loadHljs } from "./highlight";
import { I18nProvider } from "./i18n";

function render(element: ReactElement): Document {
	const html = renderToStaticMarkup(<I18nProvider>{element}</I18nProvider>);
	return parseHTML(`<html><body>${html}</body></html>`).document;
}

beforeAll(async () => {
	await loadHljs();
});

describe("DiffView syntax highlighting", () => {
	it("renders decoded source text through React nodes while preserving highlight scopes", () => {
		const document = render(<DiffView diff={'@@ -1,1 +1,1 @@\n const value = "<tag>&";'} filePath="sample.ts" />);

		expect(document.querySelector(".hljs-keyword")?.textContent).toBe("const");
		expect(document.body.textContent).toContain('const value = "<tag>&";');
	});
});

/** A plain unified diff of `count` context rows, each identifiable by number. */
function contextDiff(count: number): string {
	const rows: string[] = ["@@ -1,1 +1,1 @@"];
	for (let i = 1; i <= count; i++) rows.push(` line ${i}`);
	return rows.join("\n");
}

/** Painted diff rows — the DOM nodes a large patch must not build all at once. */
function paintedRows(document: Document): number {
	return document.querySelectorAll('[class*="whitespace-pre"]').length;
}

describe("DiffView render budget", () => {
	it("paints the head of a long patch and puts the tail behind one click", () => {
		const document = render(<DiffView diff={contextDiff(400)} />);
		const text = document.body.textContent ?? "";

		// A diff row is several DOM nodes plus a possible hljs pass, so painting
		// the first 150 and asking before the rest is what keeps a large patch
		// from freezing the UI on expand.
		expect(paintedRows(document)).toBe(150);
		expect(text).toContain("line 150");
		expect(text).toContain("Show 250 more lines");
	});

	it("reveals in chunks and reserves the ellipsis row for what no click reaches", () => {
		const document = render(<DiffView diff={contextDiff(3200)} />);
		const text = document.body.textContent ?? "";

		// 3200 rows: the next click can still reach 600 of them, so the footer
		// must promise those rather than declare the 3000-row ceiling reached.
		expect(paintedRows(document)).toBe(150);
		expect(text).toContain("Show 600 more lines");
		expect(text).not.toContain("200 more lines");
	});

	it("offers the raw patch on the clipboard and leaves a short diff alone", () => {
		const long = render(<DiffView diff={contextDiff(400)} />);
		expect(long.querySelector("button[aria-label='Copy diff']")).not.toBeNull();

		const short = render(<DiffView diff={contextDiff(3)} />);
		expect(paintedRows(short)).toBe(3);
		expect(short.querySelector("button[aria-label='Copy diff']")).not.toBeNull();
		expect(short.body.textContent ?? "").not.toContain("more lines");
	});
});

describe("git diff header parsing", () => {
	it.each([
		"index a4445d3..cf101ac 100644",
		"new file mode 100644",
		"deleted file mode 100644",
		"old mode 100644",
		"new mode 100755",
	])("omits the pre-hunk '%s' metadata without advancing source numbers", header => {
		const patch = [
			"diff --git a/demo.txt b/demo.txt",
			header,
			"--- a/demo.txt",
			"+++ b/demo.txt",
			"@@ -7,2 +9,2 @@",
			" shared",
			"-before",
			"+after",
		].join("\n");
		expect(parseDiff(patch)).toEqual([
			{ type: "context", content: "shared", oldLine: 7, newLine: 9 },
			{ type: "remove", content: "before", oldLine: 8, newLine: undefined },
			{ type: "add", content: "after", oldLine: undefined, newLine: 10 },
		]);
	});

	it.each([
		"index a4445d3..cf101ac 100644",
		"new file mode 100644",
		"deleted file mode 100644",
		"old mode 100644",
		"new mode 100755",
		"--- a/demo.txt",
		"+++ b/demo.txt",
	])("preserves '%s' as genuine hunk source", content => {
		const patch = `@@ -7,2 +9,2 @@\n ${content}\n-${content}\n+${content}`;
		expect(parseDiff(patch)).toEqual([
			{ type: "context", content, oldLine: 7, newLine: 9 },
			{ type: "remove", content, oldLine: 8, newLine: undefined },
			{ type: "add", content, oldLine: undefined, newLine: 10 },
		]);
	});

	it("preserves metadata-like numbered wire rows before the first hunk", () => {
		expect(parseDiff("-12|old mode 100644\n+14|new mode 100755\n 13|index 1a..2b 100644")).toEqual([
			{ type: "remove", content: "old mode 100644", oldLine: 12, newLine: undefined },
			{ type: "add", content: "new mode 100755", oldLine: undefined, newLine: 14 },
			{ type: "context", content: "index 1a..2b 100644", oldLine: 13, newLine: 15 },
		]);
	});

	it.each(["diff --git a/second.txt b/second.txt", "Index: second.txt"])(
		"starts a fresh header section at '%s' between files",
		boundary => {
			const patch = [
				"diff --git a/first.txt b/first.txt",
				"index 1a..2b 100644",
				"--- a/first.txt",
				"+++ b/first.txt",
				"@@ -3 +5 @@",
				"-first before",
				"+first after",
				boundary,
				"old mode 100644",
				"new mode 100755",
				"index 3c..4d",
				"--- a/second.txt",
				"+++ b/second.txt",
				"@@ -11 +13 @@",
				"-second before",
				"+second after",
			].join("\n");
			expect(parseDiff(patch)).toEqual([
				{ type: "remove", content: "first before", oldLine: 3, newLine: undefined },
				{ type: "add", content: "first after", oldLine: undefined, newLine: 5 },
				{ type: "remove", content: "second before", oldLine: 11, newLine: undefined },
				{ type: "add", content: "second after", oldLine: undefined, newLine: 13 },
			]);
		},
	);

	it("renders only source rows for a patch carrying blob and mode metadata", () => {
		const patch = [
			"diff --git a/demo.txt b/demo.txt",
			"old mode 100644",
			"new mode 100755",
			"index a4445d3..cf101ac 100755",
			"--- a/demo.txt",
			"+++ b/demo.txt",
			"@@ -7 +9 @@",
			"-before",
			"+after",
		].join("\n");
		const document = render(<DiffView diff={patch} />);
		expect(paintedRows(document)).toBe(2);
		expect(document.body.textContent).toContain("before");
		expect(document.body.textContent).toContain("after");
		expect(document.body.textContent).not.toContain("index a4445d3");
		expect(document.body.textContent).not.toContain("mode 100");
	});
});
