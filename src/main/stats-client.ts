/**
 * HTTP client for the omp stats dashboard API (localhost:3847).
 * Polls GET endpoints; discovers availability via x-omp-stats-dashboard header.
 */

const DEFAULT_PORT = 3847;
const REQUEST_TIMEOUT_MS = 5000;

const VALID_PATHS: Record<string, true> = {
	"/api/stats/overview": true,
	"/api/stats/model-dashboard": true,
	"/api/stats/costs": true,
	"/api/stats/behavior": true,
	"/api/stats/tools": true,
	"/api/stats/providers": true,
	"/api/stats/recent": true,
	"/api/stats/errors": true,
	"/api/stats/models": true,
	"/api/stats/folders": true,
	"/api/stats/timeseries": true,
	"/api/stats/gain": true,
	"/api/stats": true,
	"/api/sync": true,
};

export class StatsClient {
	#port: number;
	#available = false;

	constructor(port = DEFAULT_PORT) {
		this.#port = port;
	}

	get port(): number {
		return this.#port;
	}

	set port(value: number) {
		this.#port = value;
	}

	get available(): boolean {
		return this.#available;
	}

	/**
	 * Probe the stats server by hitting /api/stats/models
	 * and checking for the x-omp-stats-dashboard header.
	 */
	async probe(): Promise<boolean> {
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			const resp = await fetch(`http://127.0.0.1:${this.#port}/api/stats/models`, {
				signal: controller.signal,
			});
			clearTimeout(timer);
			this.#available = resp.headers.has("x-omp-stats-dashboard");
			return this.#available;
		} catch {
			this.#available = false;
			return false;
		}
	}

	/**
	 * Fetch a stats endpoint. Path must be one of the known endpoints.
	 * /api/request/:id is also allowed (dynamic path prefix).
	 */
	async fetch(path: string, params?: Record<string, string>): Promise<unknown> {
		// Validate path: allow known paths or /api/request/:id pattern
		const isRequestPath = path.startsWith("/api/request/");
		if (!isRequestPath && !VALID_PATHS[path]) {
			throw new Error(`Invalid stats path: ${path}`);
		}

		const url = new URL(`http://127.0.0.1:${this.#port}${path}`);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		try {
			const resp = await fetch(url.toString(), { signal: controller.signal });
			if (!resp.ok) {
				throw new Error(`Stats API error: ${resp.status} ${resp.statusText}`);
			}
			return await resp.json();
		} finally {
			clearTimeout(timer);
		}
	}
}
