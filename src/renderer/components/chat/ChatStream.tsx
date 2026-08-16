import { resolveMainToolCall } from "../../lib/read-group";
import { useAgentViewStore } from "../../stores/agent-view";
import { useMessagesStore } from "../../stores/messages";
import { useQueuedMessages } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { useActiveTabKind, useTabsStore } from "../../stores/tabs";
import { useTodoStore } from "../../stores/todo";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { SubagentTranscript } from "../panels/SubagentTranscript";
import { TranscriptViewport } from "./TranscriptViewport";

/** Selected-target canvas adapter. Main and projected transcripts share the same workspace slot. */
export function ChatCanvas() {
	const mainSelected = useAgentViewStore(state => state.target.kind === "main");
	return mainSelected ? <ChatStream /> : <SubagentTranscript />;
}

export function ChatStream() {
	const messages = useMessagesStore(state => state.messages);
	const streamingMessage = useMessagesStore(state => state.streamingMessage);
	const streamingText = useMessagesStore(state => state.streamingText);
	const streamingThinking = useMessagesStore(state => state.streamingThinking);
	const activeTools = useToolsStore(state => state.activeTools);
	const streamGeneration = useToolsStore(state => state.streamGeneration);
	const isStreaming = useSessionStore(state => state.isStreaming);
	const awaitingModelSince = useSessionStore(state => state.awaitingModelSince);
	const retryInfo = useSessionStore(state => state.retryInfo);
	const compactionInfo = useSessionStore(state => state.compactionInfo);
	const status = useSessionStore(state => state.status);
	const sessionId = useSessionStore(state => state.sessionId) ?? "main";
	const activeTab = useTabsStore(state => state.tabs.find(tab => tab.id === state.activeTabId));
	const transcriptId = `${activeTab?.id ?? "main"}:${sessionId}`;
	const remoteStartingTarget =
		status === "starting" && activeTab?.target.type === "ssh" ? activeTab.target : undefined;
	const collapseCompacted = useSettingsStore(state => state.collapseCompacted);
	const transcriptDetail = useUiStore(state => state.transcriptDetail);
	const switchPending = useUiStore(state => state.switchPending);
	const todoHistory = useTodoStore(state => state.history);
	const queued = useQueuedMessages();
	const isChat = useActiveTabKind() === "chat";

	return (
		<TranscriptViewport
			key={transcriptId}
			mode="main"
			projection={{
				transcriptId,
				messages,
				streamingMessage,
				streamingText,
				streamingThinking,
				activeTools,
				streamGeneration,
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
				switchPending: Boolean(switchPending),
				todoHistory,
				queued,
				isChat,
			}}
		/>
	);
}
