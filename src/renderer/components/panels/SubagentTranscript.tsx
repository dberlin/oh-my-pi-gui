import { useTabRpc } from "../../lib/tab-rpc";
import { useRuntimeTabId, withSessionRuntime } from "../../stores/session-runtime-context";
/**
 * Lazily loaded subagent transcript (byte pagination), shared by the list
 * rows and the DAG detail pane. Loaded pages also feed the graph's tool-call
 * ownership registry so nested spawn edges resolve progressively.
 */

import { RefreshCw } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, SubagentSnapshot, ToolCallContent } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { buildTranscriptToolEntries } from "../../stores/tools";
import { MessageBubble } from "../chat/MessageBubble";
import { Button, Spinner } from "../common";
import { registerTranscriptToolCalls } from "./subagent-graph";

interface TranscriptState {
	loading: boolean;
	messages: AgentMessage[];
	nextByte: number;
	hasMore: boolean;
}

export const SubagentTranscript = memo(function SubagentTranscript({ agent }: { agent: SubagentSnapshot }) {
	const t = useT();
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const generation = useRef(0);
	const [error, setError] = useState<string | null>(null);
	const [state, setState] = useState<TranscriptState>({
		loading: true,
		messages: [],
		nextByte: 0,
		hasMore: true,
	});
	const loadingRef = useRef(false);
	// `agent.status` changes arrive via prop updates after `load` has memoized —
	// track it in a ref so a running agent keeps a refresh affordance without
	// recreating `load` (which would re-run load(0) and duplicate messages).
	const statusRef = useRef(agent.status);
	useEffect(() => {
		statusRef.current = agent.status;
	}, [agent.status]);
	const toolEntries = useMemo(
		() => buildTranscriptToolEntries(state.messages, { turnIsLive: agent.status === "started" }),
		[state.messages, agent.status],
	);
	const resolveToolEntry = useCallback((call: ToolCallContent) => toolEntries.get(call), [toolEntries]);

	const load = useCallback(
		async (fromByte: number) => {
			if (loadingRef.current) return;
			loadingRef.current = true;
			const version = generation.current;
			setError(null);
			setState(prev => ({ ...prev, loading: true }));
			try {
				const response = await rpc.getSubagentMessages(agent.id, agent.sessionFile, fromByte);
				if (version !== generation.current) return;
				if (!response.success) {
					setError(response.error);
					toast({ variant: "error", title: t("subagent.transcriptFailed"), message: response.error });
					setState(prev => ({ ...prev, loading: false, hasMore: false }));
					return;
				}
				const data = response.data as {
					messages?: AgentMessage[];
					nextByte?: number;
					reset?: boolean;
				};
				const incoming = data.messages ?? [];
				if (tabId) withSessionRuntime(tabId, () => registerTranscriptToolCalls(agent.id, incoming));
				else registerTranscriptToolCalls(agent.id, incoming);
				setState(prev => ({
					loading: false,
					messages: data.reset || fromByte === 0 ? incoming : [...prev.messages, ...incoming],
					nextByte: data.nextByte ?? fromByte,
					// A still-running agent keeps its load-more affordance even when
					// caught up (0 new messages) — it doubles as the refresh button.
					hasMore: incoming.length > 0 || statusRef.current === "started",
				}));
			} catch (cause) {
				if (version === generation.current) {
					setError(String(cause));
					setState(previous => ({ ...previous, loading: false }));
				}
			} finally {
				if (version === generation.current) loadingRef.current = false;
			}
		},
		[agent.id, agent.sessionFile, t, rpc.getSubagentMessages, tabId],
	);

	useEffect(() => {
		generation.current++;
		loadingRef.current = false;
		setState({ loading: true, messages: [], nextByte: 0, hasMore: true });
		void load(0);
		return () => {
			generation.current++;
		};
	}, [load]);

	if (state.loading && state.messages.length === 0) {
		return (
			<div className="flex items-center gap-2 px-2 py-3">
				<Spinner size="sm" />
				<span className="text-omp-sm text-(--omp-dim)">{t("subagent.loadingTranscript")}</span>
			</div>
		);
	}

	return (
		<div className="omp-transcript-editorial bg-transparent py-2">
			<div className="omp-transcript-canvas">
				{error &&
					(state.messages.length === 0 ? (
						<div className="flex flex-col items-start gap-2 px-6 py-2">
							<p role="alert" className="text-omp-sm text-(--omp-error)">
								{error}
							</p>
							<Button icon={<RefreshCw size={12} />} onClick={() => void load(0)} size="sm" variant="secondary">
								{t("common.retry")}
							</Button>
						</div>
					) : (
						<p role="alert" className="px-6 py-2 text-omp-sm text-(--omp-error)">
							{error}
						</p>
					))}
				{!error && state.messages.length === 0 && (
					<div className="px-6 py-2 text-omp-sm text-(--omp-dim) italic">{t("subagent.noEntries")}</div>
				)}
				{state.messages.map((message, index) => (
					<div
						className="omp-transcript-row"
						data-transcript-kind="message"
						key={
							typeof message.id === "string" ? message.id : `${String(message.timestamp ?? "subagent")}-${index}`
						}
					>
						<MessageBubble message={message} readOnly resolveToolEntry={resolveToolEntry} />
					</div>
				))}
			</div>
			{state.hasMore && (
				<div className="px-6 py-2">
					<button
						className="flex items-center gap-1.5 text-omp-sm text-(--omp-link) transition-colors hover:brightness-125 disabled:opacity-50"
						disabled={state.loading}
						onClick={() => void load(state.nextByte)}
						type="button"
					>
						{state.loading ? <Spinner size="sm" /> : <RefreshCw size={10} />}
						{t("subagent.loadMore")}
					</button>
				</div>
			)}
		</div>
	);
});
