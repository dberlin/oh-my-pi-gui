/**
 * Conversation search (⇧⌘F) outside the dialog: reading match markers out of
 * snippets, the keyboard order of hits, opening a session at a message, and the
 * remembered recent searches.
 */
import type {
	ConversationFocusRequest,
	ConversationHit,
	ConversationSearchResult,
	SessionInfo,
} from "../../shared/ipc-types";
import { requestSessionSwitch, switchSessionNow } from "../hooks/use-session-switch";
import { type AgentViewStore, useAgentViewStore } from "../stores/agent-view";
import { useModelRestoreStore } from "../stores/model-restore";
import { useSessionStore } from "../stores/session";
import { focusedRuntimeTabId, sessionRuntimeStore } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { toast } from "../stores/toast";
import { useTranscriptFocusStore } from "../stores/transcript-focus";
import { translate } from "./i18n";

/** Snippet match delimiters written by the main-process index. */
const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";
const RECENT_KEY = "omp.conversationSearch.recent";
const RECENT_LIMIT = 6;

export interface SnippetPart {
	text: string;
	match: boolean;
}

/** A snippet split into plain and matching runs; stray markers never reach the screen. */
export function snippetParts(snippet: string): SnippetPart[] {
	const parts: SnippetPart[] = [];
	let match = false;
	let text = "";
	const flush = () => {
		if (text) parts.push({ text, match });
		text = "";
	};
	for (const char of snippet) {
		if (char === MARK_OPEN || char === MARK_CLOSE) {
			flush();
			match = char === MARK_OPEN;
			continue;
		}
		text += char;
	}
	flush();
	return parts;
}

export interface FlatHit {
	result: ConversationSearchResult;
	hit: ConversationHit;
}

/** Hits in on-screen order, which is the arrow-key order. */
export function flattenHits(results: readonly ConversationSearchResult[]): FlatHit[] {
	return results.flatMap(result => result.hits.map(hit => ({ result, hit })));
}

/** Enough of a session for the switch flow, which reads path, id, kind, cwd and title. */
function sessionInfoFor(result: ConversationSearchResult): SessionInfo {
	const modified = new Date(result.modified).toISOString();
	return {
		path: result.path,
		id: result.sessionId,
		title: result.title,
		cwd: result.cwd,
		created: modified,
		modified,
		messageCount: 0,
		size: 0,
		status: "unknown",
		kind: result.kind,
		firstMessage: "",
	};
}

/** A refused cold restore must not change the owner's selected transcript. */
function revealMainInTab(tabId: string): void {
	const tabs = useTabsStore.getState();
	const tab = tabs.tabs.find(tab => tab.id === tabId);
	if (tabs.activeTabId !== tabId || !tab || ["asleep", "error", "exited"].includes(tab.status)) return;
	const view = sessionRuntimeStore<AgentViewStore>(tabId, "agentView");
	if (view) view.getState().selectMain();
	else useAgentViewStore.getState().selectMain();
}

/** Receive a native focus request only in the tab that locally owns its file. */
export async function openConversationFocus(request: ConversationFocusRequest): Promise<boolean> {
	const tabs = useTabsStore.getState();
	const owner = tabs.tabs.find(tab => tab.target.type === "local" && tab.sessionPath === request.sessionPath);
	if (!owner || owner.restoringSession) return false;
	const focus = useTranscriptFocusStore.getState();
	const nonce = focus.focus(request.sessionPath, request.entryId);
	try {
		await tabs.switchTab(owner.id);
		revealMainInTab(owner.id);
		const current = useTabsStore.getState();
		const liveOwner = current.tabs.find(tab => tab.id === owner.id);
		if (
			(current.activeTabId !== owner.id || !liveOwner || ["asleep", "error", "exited"].includes(liveOwner.status)) &&
			useModelRestoreStore.getState().prompt?.session.path !== request.sessionPath
		) focus.settle(nonce);
	} catch (error) {
		focus.settle(nonce);
		throw error;
	}
	return true;
}

/**
 * Search indexes local files only. Never switch an SSH sidecar in place, even
 * when its remote cwd happens to have the same spelling as this local project.
 * The normal tab/switch flows retain owner reuse, busy-session and model consent.
 */
export async function openConversationHit(
	{ result, hit }: FlatHit,
	options: { newTab: boolean; currentCwd: string | null },
): Promise<void> {
	const tabs = useTabsStore.getState();
	const currentTabId = focusedRuntimeTabId() ?? tabs.activeTabId;
	const currentTab = tabs.tabs.find(tab => tab.id === currentTabId);
	const focus = useTranscriptFocusStore.getState();
	const nonce = focus.focus(result.path, hit.entryId);
	try {
		const nativeOwner = await window.omp.tabs.getSessionOwner(result.path);
		if (useTranscriptFocusStore.getState().target?.nonce !== nonce) return;
		const latestTabs = useTabsStore.getState();
		if (nativeOwner && !latestTabs.tabs.some(tab => tab.id === nativeOwner.tabId)) {
			try {
				const opened = await window.omp.sessions.openInNewWindow({
					sessionPath: result.path, cwd: result.cwd, entryId: hit.entryId,
				});
				if (!opened) toast({ variant: "warning", message: translate("sidebar.parallelCap") });
			} finally {
				// The owner window receives a fresh request; this window must not
				// retain a locator that could fire on a later ordinary visit.
				focus.settle(nonce);
			}
			return;
		}
		const owner = latestTabs.tabs.find(
			tab => tab.target.type === "local" &&
				(nativeOwner ? tab.id === nativeOwner.tabId : tab.sessionPath === result.path),
		);
		if (owner) {
			await openConversationFocus({ sessionPath: result.path, entryId: hit.entryId });
			return;
		}
		if (
			options.newTab ||
			currentTab?.target.type === "ssh" ||
			!options.currentCwd ||
			options.currentCwd !== result.cwd
		) {
			const tabId = await tabs.openTab({
				cwd: result.cwd || undefined,
				sessionPath: result.path,
				kind: result.kind ?? "agent",
				target: { type: "local" },
			});
			if (tabId === null) {
				if (useModelRestoreStore.getState().prompt?.session.path !== result.path) focus.settle(nonce);
			} else {
				revealMainInTab(tabId);
			}
			return;
		}
		const session = useSessionStore.getState();
		if (session.sessionFile === result.path) useAgentViewStore.getState().selectMain();
		if (session.sessionId === result.sessionId) return;
		if (session.isStreaming || session.isCompacting) {
			requestSessionSwitch(sessionInfoFor(result));
			return;
		}
		const switched = await switchSessionNow(sessionInfoFor(result));
		if (!switched && useModelRestoreStore.getState().prompt?.session.path !== result.path) focus.settle(nonce);
	} catch (error) {
		focus.settle(nonce);
		toast({ variant: "error", message: String(error) });
	}
}

export function loadRecentSearches(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

/** Most recent first, case-insensitively de-duplicated. */
export function rememberSearch(recent: readonly string[], query: string): string[] {
	const trimmed = query.trim();
	if (!trimmed) return [...recent];
	const next = [trimmed, ...recent.filter(item => item.toLowerCase() !== trimmed.toLowerCase())].slice(
		0,
		RECENT_LIMIT,
	);
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(next));
	} catch {
		// Storage unavailable — recents are a convenience.
	}
	return next;
}
