import { useCallback, useEffect, useState } from "react";
import type { SessionInfo } from "../../shared/ipc-types";

interface SessionListResult {
	sessions: SessionInfo[];
	isLoading: boolean;
	refresh: () => void;
	deleteSession: (path: string) => Promise<void>;
}

/**
 * Fetches and subscribes to session list changes.
 */
export function useSessionList(scope: "local" | "global" = "local"): SessionListResult {
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [isLoading, setIsLoading] = useState(true);

	const refresh = useCallback(() => {
		setIsLoading(true);
		window.omp.sessions
			.list(scope)
			.then(list => {
				setSessions(list);
				setIsLoading(false);
			})
			.catch(() => {
				setIsLoading(false);
			});
	}, [scope]);

	useEffect(() => {
		refresh();
		const unsubscribe = window.omp.events.onSessionsChanged(() => {
			refresh();
		});
		return unsubscribe;
	}, [refresh]);

	const deleteSession = useCallback(
		async (path: string) => {
			await window.omp.sessions.delete(path);
			refresh();
		},
		[refresh],
	);

	return { sessions, isLoading, refresh, deleteSession };
}
