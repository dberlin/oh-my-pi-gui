import { useCallback, useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 30_000;

interface StatsResult {
	data: unknown;
	isLoading: boolean;
	error: string | null;
	refetch: () => void;
}

/**
 * Polls the stats endpoint at 30s intervals for the given path.
 */
export function useStats(path: string, params?: Record<string, string>): StatsResult {
	const [data, setData] = useState<unknown>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const fetchStats = useCallback(() => {
		window.omp.stats
			.fetch(path, params)
			.then(result => {
				// IPC handler returns { error, unavailable } when stats server is down
				if (result && typeof result === "object" && "unavailable" in result) {
					const r = result as { error?: string; unavailable: boolean };
					setError(r.error ?? "Stats server not running. Run `omp stats` to start it.");
					setIsLoading(false);
					return;
				}
				setData(result);
				setError(null);
				setIsLoading(false);
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err));
				setIsLoading(false);
			});
	}, [path, params]);

	useEffect(() => {
		setIsLoading(true);
		fetchStats();

		timerRef.current = setInterval(fetchStats, POLL_INTERVAL_MS);
		return () => {
			if (timerRef.current !== null) {
				clearInterval(timerRef.current);
				timerRef.current = null;
			}
		};
	}, [fetchStats]);

	return { data, isLoading, error, refetch: fetchStats };
}
