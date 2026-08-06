import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { DiffView } from "./diff";
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
