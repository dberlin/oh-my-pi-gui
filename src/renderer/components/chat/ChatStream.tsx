import { useCallback, useMemo } from "react";
import type { ToolCallContent } from "../../../shared/rpc-types";
import { useDisplayPreference } from "../../lib/display-preferences";
import { useAgentViewStore } from "../../stores/agent-view";
import { useMessagesStore } from "../../stores/messages";
import { useQueuedMessages } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";
import { toolEntryKey, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { SubagentTranscript } from "../panels/SubagentTranscript";
import { hasStreamingTranscriptContent } from "./chat-stream-utils";
import type { ConversationNavigationModel } from "./ConversationNavigator";
import { TranscriptViewport } from "./TranscriptViewport";

/** Selected-target canvas adapter. Main and projected transcripts share the same workspace slot. */
export function ChatCanvas({
	onConversationNavigationChange,
}: {
	onConversationNavigationChange?: (navigation: ConversationNavigationModel | null) => void;
}) {
	const mainSelected = useAgentViewStore(state => state.target.kind === "main");
	return mainSelected ? (
		<ChatStream onConversationNavigationChange={onConversationNavigationChange} />
	) : (
		<SubagentTranscript />
	);
}

/** Main-session store adapter for the shared transcript surface. */
export function ChatStream({
	onConversationNavigationChange,
}: {
	onConversationNavigationChange?: (navigation: ConversationNavigationModel | null) => void;
}) {
	const tabId = useRuntimeTabId();
	const sessionId = useSessionStore(state => state.sessionId);
	return (
		<MainTranscript
			key={`${tabId ?? ""}:${sessionId}`}
			onConversationNavigationChange={onConversationNavigationChange}
		/>
	);
}

function MainTranscript({
	onConversationNavigationChange,
}: {
	onConversationNavigationChange?: (navigation: ConversationNavigationModel | null) => void;
}) {
	const tabId = useRuntimeTabId();
	const messages = useMessagesStore(state => state.messages);
	// Uncommitted local echo tails the committed transcript so a typed prompt
	// paints immediately; `reconcileFetched`/`message_end` replace it in place.
	const liveMessages = useMessagesStore(state => state.liveMessages);
	const displayMessages = useMemo(() => [...messages, ...liveMessages], [messages, liveMessages]);
	const streamingMessage = useMessagesStore(state => state.streamingMessage);
	const streamingText = useMessagesStore(state => state.streamingText);
	const streamingThinking = useMessagesStore(state => state.streamingThinking);
	const lastAppended = useMessagesStore(state => state.lastAppended);
	const activeTools = useToolsStore(state => state.activeTools);
	const streamGeneration = useToolsStore(state => state.streamGeneration);
	const resolveToolCall = useCallback(
		(call: ToolCallContent) => {
			const key = toolEntryKey(call);
			return { key, entry: activeTools.get(key) };
		},
		[activeTools],
	);
	const hasLiveToolsForStream = hasStreamingTranscriptContent(streamingMessage, "", "", activeTools, streamGeneration);
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
	const remoteStartingTarget = status === "starting" && activeTab?.target.type === "ssh" ? activeTab.target : undefined;
	const collapseCompacted = useDisplayPreference("collapseCompacted");
	const transcriptDetail = useUiStore(state => state.transcriptDetail);
	const todoHistory = useTodoStore(state => state.history);
	const queued = useQueuedMessages();
	const isChat = activeTab?.kind === "chat";

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
				streamGeneration,
				resolveToolCall,
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
				tabId: tabId ?? undefined,
				hasLiveToolsForStream,
				lastAppended,
				transcriptPinNonce,
				transcriptView,
				saveTranscriptView,
			}}
			onConversationNavigationChange={onConversationNavigationChange}
		/>
	);
}
