import { useMemo } from "react";
import { useDisplayPreference } from "../../lib/display-preferences";
import { resolveMainToolCall } from "../../lib/read-group";
import { useAgentViewStore } from "../../stores/agent-view";
import { useMessagesStore } from "../../stores/messages";
import { useQueuedMessages } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useActiveTabKind, useTabsStore } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { SubagentTranscript } from "../panels/SubagentTranscript";
import { TranscriptViewport } from "./TranscriptViewport";
import { messageTimestampMs } from "./chat-stream-utils";

/** Selected-target canvas adapter. Main and projected transcripts share the same workspace slot. */
export function ChatCanvas() {
	const mainSelected = useAgentViewStore(state => state.target.kind === "main");
	return mainSelected ? <ChatStream /> : <SubagentTranscript />;
}

/** Main-session store adapter for the shared transcript surface. */
export function ChatStream() {
	const tabId = useRuntimeTabId();
	const sessionId = useSessionStore(state => state.sessionId);
	return <MainTranscript key={`${tabId ?? ""}:${sessionId}`} />;
}

function MainTranscript() {
	const tabId = useRuntimeTabId();
	const messages = useMessagesStore(state => state.messages);
	const liveMessages = useMessagesStore(state => state.liveMessages);
	const displayMessages = useMemo(() => [...messages, ...liveMessages], [messages, liveMessages]);
	const streamingMessage = useMessagesStore(state => state.streamingMessage);
	const streamingText = useMessagesStore(state => state.streamingText);
	const streamingThinking = useMessagesStore(state => state.streamingThinking);
	const lastAppended = useMessagesStore(state => state.lastAppended);
	const hasLiveToolsForStream = useToolsStore(state => {
		if (!streamingMessage) return false;
		const streamStart = messageTimestampMs(streamingMessage);
		for (const entry of state.activeTools.values()) {
			if ((entry.status === "pending" || entry.status === "running") && entry.startTime >= streamStart) {
				return true;
			}
		}
		return false;
	});
	const activeTools = useToolsStore.getState().activeTools;
	const isStreaming = useSessionStore(state => state.isStreaming);
	const awaitingModelSince = useSessionStore(state => state.awaitingModelSince);
	const retryInfo = useSessionStore(state => state.retryInfo);
	const compactionInfo = useSessionStore(state => state.compactionInfo);
	const status = useSessionStore(state => state.status);
	const sessionId = useSessionStore(state => state.sessionId);
	const switchPending = useSessionStore(state => state.switchPending);
	const transcriptView = useSessionStore(state => state.transcriptView);
	const saveTranscriptView = useSessionStore(state => state.saveTranscriptView);
	const transcriptPinNonce = useSessionStore(state => state.transcriptPinNonce);
	const activeTab = useTabsStore(state => state.tabs.find(tab => tab.id === tabId));
	const remoteStartingTarget =
		status === "starting" && activeTab?.target.type === "ssh" ? activeTab.target : undefined;
	const collapseCompacted = useDisplayPreference("collapseCompacted");
	const transcriptDetail = useUiStore(state => state.transcriptDetail);
	const todoHistory = useTodoStore(state => state.history);
	const queued = useQueuedMessages();
	const isChat = useActiveTabKind() === "chat";

	return (
		<TranscriptViewport
			mode="main"
			projection={{
				transcriptId: `${tabId ?? ""}:${sessionId}`,
				messages: displayMessages,
				streamingMessage,
				streamingText,
				streamingThinking,
				activeTools,
				resolveToolCall: resolveMainToolCall,
				transcriptDetail,
			}}
			main={{
				isStreaming,
				awaitingModelSince,
				retryInfo,
				compactionInfo,
				status,
				remoteStartingTarget,
				collapseCompacted,
				switchPending: switchPending !== null,
				todoHistory,
				queued,
				isChat,
				tabId,
				hasLiveToolsForStream,
				lastAppended,
				transcriptPinNonce,
				transcriptView,
				saveTranscriptView,
			}}
		/>
	);
}


export type { HistoryRow, Row } from "./chat-stream-utils";
// Re-export transcript helpers for consumers/tests that import them from ChatStream.
export {
	buildConversationAnchors,
	buildHistoryRowKeys,
	buildHistoryRows,
	buildTranscriptRowKeys,
	claimRowEntrances,
	createRowEntranceState,
	findConversationAnchorIndex,
	hasStreamingTranscriptContent,
	isTranscriptAtLiveEdge,
	LIVE_EDGE_SLACK_PX,
	mergeTodoSnapshots,
	ROW_ENTRANCE_TAIL_ROWS,
	shouldRePinTranscript,
} from "./chat-stream-utils";
