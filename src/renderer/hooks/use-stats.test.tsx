import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { useProviderStats, useStats, useStatsList } from "./use-stats";

test("late ranges cannot replace the selected range, failed refresh retains only its own data, and requests do not overlap", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const slow = Promise.withResolvers<unknown>();
	const fast = Promise.withResolvers<unknown>();
	const fetch = vi
		.fn()
		.mockReturnValueOnce(slow.promise)
		.mockReturnValueOnce(fast.promise)
		.mockRejectedValueOnce(new Error("offline"));
	vi.stubGlobal("document", document);
	vi.stubGlobal("window", Object.assign(window, { omp: { stats: { fetch } } }));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const node = document.getElementById("root")!;
	const root = createRoot(node);
	let refresh = () => {};
	function Probe({ range }: { range: string }) {
		const result = useStats<{ count: number }>("/api/stats/overview", { range });
		refresh = result.refetch;
		return <p>{JSON.stringify(result)}</p>;
	}
	try {
		await act(async () => root.render(<Probe range="all" />));
		await act(async () => {
			refresh();
			refresh();
		});
		expect(fetch).toHaveBeenCalledTimes(1);
		await act(async () => root.render(<Probe range="24h" />));
		expect(node.textContent).toContain('"data":null');
		await act(async () => fast.resolve({ count: 2 }));
		await act(async () => slow.resolve({ count: 900 }));
		expect(node.textContent).toContain('"count":2');
		// The discarded payload, not the digits: `updatedAt` is an epoch in
		// milliseconds and can contain "900" on its own.
		expect(node.textContent).not.toContain('"count":900');
		await act(async () => refresh());
		expect(node.textContent).toContain("offline");
		expect(node.textContent).toContain('"count":2');
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});

test("an unavailable stats server keeps the route loading and self-heals once the server is ready", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	let ready = false;
	const fetch = vi.fn(async () =>
		ready
			? { count: 7 }
			: { error: "The bundled stats server is not ready. Please retry shortly.", unavailable: true },
	);
	vi.stubGlobal("document", document);
	vi.stubGlobal("window", Object.assign(window, { omp: { stats: { fetch } } }));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const node = document.getElementById("root")!;
	const root = createRoot(node);
	function Probe() {
		const result = useStats<{ count: number }>("/api/stats/overview", {});
		return <p>{JSON.stringify(result)}</p>;
	}
	try {
		await act(async () => root.render(<Probe />));
		// Not ready yet: still loading, never a dead-end error.
		expect(node.textContent).toContain('"isLoading":true');
		expect(node.textContent).toContain('"error":null');
		expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(1);

		// Server comes up; the fast retry must recover without a manual refetch.
		ready = true;
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 2600));
		});
		expect(node.textContent).toContain('"count":7');
		expect(node.textContent).toContain('"error":null');
		expect(node.textContent).toContain('"isLoading":false');
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});

test("a list endpoint that replies with a non-array becomes an error state, never rows", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const fetch = vi.fn(async () => ({}));
	vi.stubGlobal("document", document);
	vi.stubGlobal("window", Object.assign(window, { omp: { stats: { fetch } } }));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const node = document.getElementById("root")!;
	const root = createRoot(node);
	function Probe() {
		const result = useStatsList<{ timestamp: number }>("/api/stats/errors", { range: "24h" });
		return <p>{JSON.stringify(result)}</p>;
	}
	try {
		await act(async () => root.render(<Probe />));
		// Storing `{}` as data makes every row expression in the route throw and the
		// whole renderer falls back to the crash screen.
		expect(node.textContent).toContain('"data":null');
		expect(node.textContent).toContain('"isLoading":false');
		expect(node.textContent).toContain("/api/stats/errors");
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});

test("provider usage and windows commit together, including refresh failures and range changes", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const requests: { path: string; range: string; resolve: (value: unknown) => void }[] = [];
	const fetch = async (path: string, params: Record<string, string>) => {
		const pending = Promise.withResolvers<unknown>();
		requests.push({ path, range: params.range, resolve: pending.resolve });
		return pending.promise;
	};
	vi.stubGlobal("document", document);
	vi.stubGlobal("window", Object.assign(window, { omp: { stats: { fetch } } }));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const node = document.getElementById("root")!;
	const root = createRoot(node);
	let refresh = () => {};
	function Probe({ range }: { range: string }) {
		const result = useProviderStats({ range });
		refresh = result.refetch;
		return <p>{JSON.stringify(result)}</p>;
	}
	const usage = { providers: [], hourly: [], series: [] };
	const windows = { windowInsights: [] };
	try {
		await act(async () => root.render(<Probe range="24h" />));
		expect(requests.map(({ path, range }) => [path, range])).toEqual([
			["/api/stats/providers", "24h"],
			["/api/stats/provider-windows", "24h"],
		]);
		await act(async () => requests[0].resolve(usage));
		expect(node.textContent).toContain('"data":null');
		expect(node.textContent).toContain('"isLoading":true');
		await act(async () => {
			refresh();
			refresh();
		});
		expect(requests).toHaveLength(2);
		await act(async () => requests[1].resolve(windows));
		expect(node.textContent).toContain('"providers":[]');
		expect(node.textContent).toContain('"windowInsights":[]');
		expect(node.textContent).toContain('"isLoading":false');

		await act(async () => refresh());
		await act(async () => requests[2].resolve({ ...usage, series: ["partial-refresh"] }));
		expect(node.textContent).not.toContain("partial-refresh");
		await act(async () => requests[3].resolve({ error: "quota snapshots failed", unavailable: false }));
		expect(node.textContent).toContain("quota snapshots failed");
		expect(node.textContent).not.toContain("partial-refresh");
		// The retained data is the previous complete snapshot, under the existing error UI.
		expect(node.textContent).toContain('"windowInsights":[]');

		await act(async () => refresh());
		await act(async () => root.render(<Probe range="7d" />));
		expect(node.textContent).toContain('"data":null');
		await act(async () => requests[6].resolve(usage));
		await act(async () => requests[7].resolve(windows));
		await act(async () => requests[4].resolve({ ...usage, series: ["late-range"] }));
		await act(async () => requests[5].resolve(windows));
		expect(node.textContent).not.toContain("late-range");
		expect(node.textContent).toContain('"error":null');
		expect(node.textContent).toContain('"windowInsights":[]');
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});

test("provider usage failures do not publish independently successful windows", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const fetch = async (path: string) =>
		path === "/api/stats/providers" ? { error: "usage failed", unavailable: false } : { windowInsights: [] };
	vi.stubGlobal("document", document);
	vi.stubGlobal("window", Object.assign(window, { omp: { stats: { fetch } } }));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const node = document.getElementById("root")!;
	const root = createRoot(node);
	function Probe() {
		const result = useProviderStats({ range: "24h" });
		return <p>{JSON.stringify(result)}</p>;
	}
	try {
		await act(async () => root.render(<Probe />));
		expect(node.textContent).toContain("usage failed");
		expect(node.textContent).toContain('"data":null');
		expect(node.textContent).toContain('"isLoading":false');
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});

test("a rejected provider request waits for its paired windows before retrying the whole snapshot", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	const windows = Promise.withResolvers<unknown>();
	let usageCalls = 0;
	let windowCalls = 0;
	let ready = false;
	const fetch = async (path: string) => {
		if (path === "/api/stats/providers") {
			usageCalls++;
			if (!ready) throw new Error("provider network failed");
			return { providers: [], hourly: [], series: [] };
		}
		windowCalls++;
		return ready ? { windowInsights: [] } : windows.promise;
	};
	vi.stubGlobal("document", document);
	vi.stubGlobal("window", Object.assign(window, { omp: { stats: { fetch } } }));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const node = document.getElementById("root")!;
	const root = createRoot(node);
	let refresh = () => {};
	function Probe() {
		const result = useProviderStats({ range: "24h" });
		refresh = result.refetch;
		return <p>{JSON.stringify(result)}</p>;
	}
	try {
		await act(async () => root.render(<Probe />));
		await act(async () => refresh());
		expect(usageCalls).toBe(1);
		expect(windowCalls).toBe(1);
		expect(node.textContent).toContain('"isLoading":true');
		await act(async () => windows.resolve({ windowInsights: [] }));
		expect(node.textContent).toContain("provider network failed");
		expect(node.textContent).toContain('"data":null');
		ready = true;
		await act(async () => refresh());
		expect(usageCalls).toBe(2);
		expect(windowCalls).toBe(2);
		expect(node.textContent).toContain('"providers":[]');
		expect(node.textContent).toContain('"windowInsights":[]');
		expect(node.textContent).toContain('"error":null');
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});

test("an unavailable provider window keeps the whole snapshot loading until both endpoints recover", async () => {
	const { document, window } = parseHTML("<html><body><div id='root'></div></body></html>");
	let ready = false;
	const fetch = async (path: string) =>
		path === "/api/stats/providers"
			? { providers: [], hourly: [], series: [] }
			: ready
				? { windowInsights: [] }
				: { error: "not ready", unavailable: true };
	vi.stubGlobal("document", document);
	vi.stubGlobal("window", Object.assign(window, { omp: { stats: { fetch } } }));
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const node = document.getElementById("root")!;
	const root = createRoot(node);
	let refresh = () => {};
	function Probe() {
		const result = useProviderStats({ range: "24h" });
		refresh = result.refetch;
		return <p>{JSON.stringify(result)}</p>;
	}
	try {
		await act(async () => root.render(<Probe />));
		expect(node.textContent).toContain('"data":null');
		expect(node.textContent).toContain('"isLoading":true');
		expect(node.textContent).toContain('"error":null');
		ready = true;
		await act(async () => refresh());
		expect(node.textContent).toContain('"providers":[]');
		expect(node.textContent).toContain('"windowInsights":[]');
		expect(node.textContent).toContain('"isLoading":false');
	} finally {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	}
});
