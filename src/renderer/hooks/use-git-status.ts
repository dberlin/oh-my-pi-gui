import { useEffect, useRef, useState } from "react";
import type { RpcGitStatus } from "../../shared/rpc-types";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";

/**
 * Live git state for the status footer's git segment (plan/20): polls the
 * ACTIVE tab's sidecar `get_git_status` every 2.5s (porcelain is ~10-30ms),
 * resets on tab/cwd change (no stale cross-tab flash), and refetches on the
 * streaming true→false edge — a finished run likely touched files. Background
 * tabs are never polled: the footer only renders active context.
 */
export function useGitStatus(): { status: RpcGitStatus | null; refresh: () => void } {
	const activeTabId = useTabsStore(s => s.activeTabId);
	const cwd = useSessionStore(s => s.cwd);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const [status, setStatus] = useState<RpcGitStatus | null>(null);
	const refreshRef = useRef<() => void>(() => {});

	useEffect(() => {
		let cancelled = false;
		const refresh = async () => {
			try {
				const response = await window.omp.rpc.getGitStatus();
				if (!cancelled) setStatus(response.success ? (response.data as RpcGitStatus) : null);
			} catch {
				if (!cancelled) setStatus(null);
			}
		};
		refreshRef.current = () => void refresh();
		setStatus(null);
		void refresh();
		const timer = window.setInterval(() => void refresh(), 2500);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: activeTabId/cwd are invalidation SIGNALS — the effect re-arms (reset + refetch) when they change, though the body never reads them.
	}, [activeTabId, cwd]);

	const wasStreaming = useRef(false);
	useEffect(() => {
		if (wasStreaming.current && !isStreaming) refreshRef.current();
		wasStreaming.current = isStreaming;
	}, [isStreaming]);

	return { status, refresh: () => refreshRef.current() };
}
