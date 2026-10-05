import { parseHTML } from "linkedom";
import { act } from "react";
import { expect, test, vi } from "vitest";
import type { RequestRow } from "../../../shared/stats-types";
import { I18nProvider } from "../../lib/i18n";

const row: RequestRow = {
	id: 1,
	entryId: "entry",
	sessionFile: "/session",
	folder: "/project",
	model: "real-recent-model",
	provider: "openai",
	api: "responses",
	timestamp: 1_700_000_000_000,
	duration: 10,
	ttft: 2,
	stopReason: "stop",
	errorMessage: null,
	usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
};

test("requests reads the bounded canonical recent array without invented server cursors or range filters", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const fetch = vi.fn(async () => [row]);
	vi.stubGlobal("document", document);
	vi.stubGlobal("window", Object.assign(window, { omp: { stats: { fetch } } }));
	Object.assign(window, { setInterval, clearInterval, setTimeout, clearTimeout });
	vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// chart.ts resolves theme tokens on import; install the DOM before loading it.
	const { RequestsRoute } = await import("./RequestsRoute");
	const { createRoot } = await import("react-dom/client");
	const node = document.getElementById("root")!;
	const root = createRoot(node);
	try {
		await act(async () =>
			root.render(
				<I18nProvider>
					<RequestsRoute refreshKey={0} />
				</I18nProvider>,
			),
		);
		expect(fetch).toHaveBeenCalledWith("/api/stats/recent", { limit: "100" });
		expect(node.textContent).toContain("real-recent-model");
		expect(node.textContent).not.toContain("1 / 1");
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});

test("requests rejects an object page instead of silently displaying no rows", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const fetch = vi.fn(async () => ({ rows: [row], total: 1 }));
	vi.stubGlobal("document", document);
	vi.stubGlobal("window", Object.assign(window, { omp: { stats: { fetch } } }));
	Object.assign(window, { setInterval, clearInterval, setTimeout, clearTimeout });
	vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	// Static imports would initialize chart theme tokens before this test's DOM.
	const { RequestsRoute } = await import("./RequestsRoute");
	const { createRoot } = await import("react-dom/client");
	const node = document.getElementById("root")!;
	const root = createRoot(node);
	try {
		await act(async () =>
			root.render(
				<I18nProvider>
					<RequestsRoute refreshKey={0} />
				</I18nProvider>,
			),
		);
		expect(node.textContent).toContain("did not return a list");
		expect(node.textContent).not.toContain("real-recent-model");
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});
