import type { AgentMessage, ImageContent } from "../../shared/rpc-types";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";

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

/** One queued steer/follow-up message pulled back by the dequeue RPC. */
interface DequeuedMessage {
	text: string;
	images?: ImageContent[];
}

/**
 * Restore queued messages into the composer (TUI app.message.dequeue / Alt+Up
 * parity): the RPC drains every user-authored queued steer/follow-up in queue
 * order (oldest first); the last (newest) goes back into the composer for
 * editing — text prepended ahead of any draft, images appended to the image
 * strip — and the earlier ones are re-queued as follow-ups in their original
 * order so nothing is lost. `onEmpty` fires when nothing was queued; RPC
 * failures throw for the caller to surface.
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
	// Re-queue sequentially: follow_up appends, so await each to keep order.
	for (const queued of messages.slice(0, -1)) {
		const requeue = await window.omp.rpc.followUp(queued.text, queued.images);
		if (!requeue.success) throw new Error(requeue.error);
	}
}
