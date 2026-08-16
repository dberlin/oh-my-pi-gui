import { RefreshCw } from "lucide-react";
import { memo, type ReactNode, useCallback, useEffect } from "react";
import type { ToolCallContent } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { isRenderableMessageText } from "../../lib/messages";
import { useAgentViewStore } from "../../stores/agent-view";
import { resolveProjectionToolCall } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { registerTranscriptToolCalls } from "../chat/activity/agent-tree-model";
import { TranscriptViewport } from "../chat/TranscriptViewport";
import { Spinner } from "../common";

/**
 * Full-canvas adapter for the selected subagent projection.
 */
export const SubagentTranscript = memo(function SubagentTranscript() {
	const t = useT();
	const target = useAgentViewStore(state => state.target);
	const generation = useAgentViewStore(state => state.generation);
	const loadState = useAgentViewStore(state => state.loadState);
	const error = useAgentViewStore(state => state.error);
	const selectedMessages = useAgentViewStore(state => state.messages);
	const selectedTools = useAgentViewStore(state => state.tools);
	const reloadSelected = useAgentViewStore(state => state.reloadSelected);
	const transcriptDetail = useUiStore(state => state.transcriptDetail);

	const resolveToolCall = useCallback(
		(call: ToolCallContent) => resolveProjectionToolCall(selectedTools, call),
		[selectedTools],
	);

	const selectedAgentId = target.kind === "subagent" ? target.id : null;
	useEffect(() => {
		if (!selectedAgentId) return;
		const current = useAgentViewStore.getState();
		if (
			current.generation !== generation ||
			current.target.kind !== "subagent" ||
			current.target.id !== selectedAgentId
		) {
			return;
		}
		const transcriptMessages = selectedMessages.streamingMessage
			? [...selectedMessages.messages, selectedMessages.streamingMessage]
			: selectedMessages.messages;
		registerTranscriptToolCalls(selectedAgentId, transcriptMessages);
	}, [generation, selectedAgentId, selectedMessages.messages, selectedMessages.streamingMessage]);

	if (target.kind !== "subagent") return null;

	const agentId = target.id;
	const hasProjection =
		selectedMessages.messages.length > 0 ||
		isRenderableMessageText(selectedMessages.streamingText) ||
		isRenderableMessageText(selectedMessages.streamingThinking) ||
		selectedTools.activeTools.size > 0;

	if (loadState === "loading" && !hasProjection) {
		return (
			<TranscriptState agentId={agentId}>
				<Spinner size="sm" />
				<span>{t("subagent.loadingTranscript")}</span>
			</TranscriptState>
		);
	}

	if (loadState === "error") {
		return (
			<TranscriptState agentId={agentId}>
				<strong className="font-semibold text-[var(--omp-text)]">{t("subagent.transcriptFailed")}</strong>
				{error && <span className="max-w-lg text-center text-[var(--omp-dim)]">{error}</span>}
				<button
					type="button"
					onClick={() => void reloadSelected()}
					className="omp-pressable mt-1 flex items-center gap-1.5 rounded-lg border border-[var(--omp-border)] px-3 py-1.5 font-medium text-[var(--omp-link)] hover:bg-[var(--omp-selected-bg)]"
				>
					<RefreshCw size={12} />
					{t("common.retry")}
				</button>
			</TranscriptState>
		);
	}

	if (!hasProjection) {
		return (
			<TranscriptState agentId={agentId}>
				<span className="italic">{t("subagent.noEntries")}</span>
			</TranscriptState>
		);
	}

	return (
		<div className="relative flex min-h-0 flex-1 flex-col" data-agent-view-id={agentId}>
			<TranscriptViewport
				mode="subagent"
				projection={{
					transcriptId: agentId,
					messages: selectedMessages.messages,
					streamingMessage: selectedMessages.streamingMessage,
					streamingText: selectedMessages.streamingText,
					streamingThinking: selectedMessages.streamingThinking,
					activeTools: selectedTools.activeTools,
					streamGeneration: selectedTools.streamGeneration,
					resolveToolCall,
					transcriptDetail,
				}}
			/>
		</div>
	);
});

function TranscriptState({ agentId, children }: { agentId: string; children: ReactNode }) {
	return (
		<div
			aria-live="polite"
			className="omp-transcript-editorial relative flex min-h-0 flex-1 items-center justify-center bg-transparent"
			data-agent-view-id={agentId}
		>
			<div className="flex max-w-xl flex-col items-center gap-2 px-6 py-8 text-omp-sm text-[var(--omp-dim)]">
				{children}
			</div>
		</div>
	);
}
