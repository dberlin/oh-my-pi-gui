/**
 * Contract tests for markdown code line numbers (plan B3): the
 * `codeLineNumbers` GUI pref gates a line-number gutter on markdown-rendered
 * code blocks only (the tool-renderers' CodeBlock has its own always-on
 * gutter). SSR drives the pref via the MarkdownRenderer `codeLineNumbers`
 * prop — the pref store's server snapshot is off, and subscriptions never
 * run under renderToStaticMarkup.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "./i18n";
import { MarkdownRenderer } from "./markdown";

function render(content: string, codeLineNumbers?: boolean): string {
	return renderToStaticMarkup(
		<I18nProvider>
			<MarkdownRenderer content={content} codeLineNumbers={codeLineNumbers} />
		</I18nProvider>,
	);
}

const FENCE = "```ts\nalpha\nbeta\ngamma\n```";
/** The gutter rows for a three-line fence, rendered by LineNumberGutter. */
const GUTTER_ROWS = "<div>1</div><div>2</div><div>3</div>";
/** Metrics class combo unique to the markdown Pre gutter — the tool-renderers'
 * CodeBlock gutter (mermaid fallback) uses different metrics. */
const MARKDOWN_GUTTER = "pl-3 pr-2 text-[0.9em] leading-[1.3]";

describe("markdown code line numbers", () => {
	it("renders the gutter beside block code when the pref is on", () => {
		const html = render(FENCE, true);
		expect(html).toContain(GUTTER_ROWS);
		expect(html).toContain(MARKDOWN_GUTTER);
		expect(html).toContain('aria-hidden="true"');
		// The code itself still renders, still inside a <pre>.
		expect(html).toContain("alpha");
		expect(html).toContain("<pre");
	});

	it("omits the gutter when the pref is off", () => {
		const html = render(FENCE, false);
		expect(html).not.toContain(GUTTER_ROWS);
		expect(html).not.toContain(MARKDOWN_GUTTER);
		expect(html).not.toContain('aria-hidden="true"');
		expect(html).toContain("alpha");
	});

	it("defaults to off without a prop (pref store server snapshot)", () => {
		const html = render(FENCE);
		expect(html).not.toContain(GUTTER_ROWS);
		expect(html).toContain("alpha");
	});

	it("does not number inline code", () => {
		const html = render("use `npm test` here", true);
		expect(html).not.toContain('aria-hidden="true"');
		expect(html).toContain("npm test");
	});

	it("does not add a markdown gutter to mermaid fences", () => {
		// MermaidBlock's SSR fallback shows the source in the tool-renderers'
		// CodeBlock (its own pre-existing gutter) — the markdown Pre path must
		// not add a second one.
		const html = render("```mermaid\ngraph TD\nA-->B\n```", true);
		expect(html).not.toContain(MARKDOWN_GUTTER);
	});

	it("strips the fence's trailing newline when counting lines", () => {
		// textOf yields "alpha\nbeta\ngamma\n" — a fourth gutter row would mean
		// the trailing newline was counted as a visible line.
		const html = render(FENCE, true);
		expect(html).toContain(GUTTER_ROWS);
		expect(html).not.toContain("<div>4</div>");
	});
});
