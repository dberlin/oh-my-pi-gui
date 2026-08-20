import type { AgentMessage, ImageContent, RpcResponse } from "../../shared/rpc-types";
import { hydrateSession, resetRetryPending } from "../hooks/use-rpc-events";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { toast } from "../stores/toast";
import { translate } from "./i18n";

/**
 * Message-level actions shared between the command palette and the global
 * keyboard shortcuts (App.tsx), so both ride the same retry semantics.
 */

/**
 * Display-worthy model text. Punctuation/whitespace-only fragments (".",
 * "…", "---") are provider/model filler between tool calls, while letters,
 * numbers, and emoji are user-visible content in any script.
 */
const MESSAGE_TEXT_CONTENT_CHAR = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;
export function isRenderableMessageText(text: string): boolean {
	return MESSAGE_TEXT_CONTENT_CHAR.test(text);
}
/** Plain-text content of a message (user text lives in text blocks). */
export function messageText(message: AgentMessage): string {
	if (typeof message.content === "string") return message.content.trim();
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter(part => part.type === "text")
		.map(part => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
}

/**
 * Retry the last turn: re-send the most recent user message, interrupting the
 * active turn when streaming (TUI app.retry parity). `onEmpty` fires when the
 * session has no user message to retry; RPC failures throw for the caller to
 * surface.
 */
export async function retryLastTurn(onEmpty: () => void): Promise<void> {
	const { messages } = useMessagesStore.getState();
	const lastUser = [...messages].reverse().find(message => message.role === "user");
	const text = lastUser ? messageText(lastUser) : "";
	if (!text) {
		onEmpty();
		return;
	}
	const streaming = useSessionStore.getState().isStreaming;
	const response = streaming ? await window.omp.rpc.abortAndPrompt(text) : await window.omp.rpc.prompt(text);
	if (!response.success) throw new Error(response.error);
}

/** Abort the active turn and synchronously retire any live retry UI. */
export async function abortActiveTurn(): Promise<RpcResponse> {
	const retrying = useSessionStore.getState().retryInfo !== null;
	if (retrying) {
		resetRetryPending();
		useSessionStore.setState({ retryInfo: null, awaitingModelSince: null });
		try {
			await window.omp.rpc.abortRetry();
		} catch {
			// Generic abort below also cancels retry server-side.
		}
	}
	return window.omp.rpc.abort();
}

/** Branch from a user entry, restoring its draft and refreshing the session. */
export async function branchSessionFromEntry(entryId: string): Promise<"branched" | "cancelled"> {
	const response = await window.omp.rpc.branch(entryId);
	if (!response.success) throw new Error(response.error);
	const data = response.data as { cancelled?: boolean; text?: string } | undefined;
	if (data?.cancelled) return "cancelled";
	if (data?.text !== undefined) {
		window.dispatchEvent(new CustomEvent("omp:fill-composer", { detail: { text: data.text } }));
	}
	await hydrateSession();
	return "branched";
}

/** One queued steer/follow-up message pulled back by the dequeue RPC. */
interface DequeuedMessage {
	text: string;
	images?: ImageContent[];
	mode: "steer" | "followUp";
}

/**
 * Restore queued messages into the composer (TUI app.message.dequeue / Alt+Up
 * parity): the RPC drains every user-authored queued steer/follow-up in their
 * cross-lane enqueue order (oldest first); the last (newest) goes back into
 * the composer for editing — text prepended ahead of any draft, images
 * appended to the image strip — and earlier messages are re-queued through
 * their original delivery lane, in order. `onEmpty` fires when nothing was
 * queued; RPC failures throw for the caller to surface.
 */
export async function restoreQueuedMessages(onEmpty: () => void): Promise<void> {
	const response = await window.omp.rpc.dequeue();
	if (!response.success) throw new Error(response.error);
	const data = response.data as { messages?: DequeuedMessage[] } | undefined;
	const messages = data?.messages ?? [];
	if (messages.length === 0) {
		onEmpty();
		return;
	}
	const restored = messages[messages.length - 1];
	// Fill the composer first so the message being edited is safe even if a
	// re-queue below fails; InputArea owns the "omp:fill-composer" listener.
	window.dispatchEvent(
		new CustomEvent("omp:fill-composer", {
			detail: { text: restored.text, images: restored.images, prepend: true },
		}),
	);
	// Re-queue sequentially through each message's original delivery lane.
	for (const queued of messages.slice(0, -1)) {
		const requeue =
			queued.mode === "steer"
				? await window.omp.rpc.steer(queued.text, queued.images)
				: await window.omp.rpc.followUp(queued.text, queued.images);
		if (!requeue.success) throw new Error(requeue.error);
	}
}

/**
 * Clear the conversation context in place (TUI /clear parity via the
 * clear_context RPC): drops the context, keeps the session id and transcript
 * file. Refused with a warning while streaming / a foreground execution runs
 * (server code "busy"); on success rehydrates the transcript + context bar
 * and reports the dropped count. Returns whether the context was cleared.
 */
export async function clearSessionContext(): Promise<boolean> {
	const response = await window.omp.rpc.clearContext();
	if (!response.success) {
		toast({ variant: "warning", message: response.error });
		return false;
	}
	const data = response.data as { droppedCount?: number } | undefined;
	toast({ variant: "success", message: translate("input.clear.done", { count: data?.droppedCount ?? 0 }) });
	await hydrateSession();
	return true;
}
