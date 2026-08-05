/**
 * Composer message submission policy. Typed slash commands ("/compact",
 * "/model", …) execute server-side via the prompt RPC's builtin-command
 * parse — even while streaming, where steer/followUp would inject the text
 * as a user steer instead. Session-replacing commands (/new, /clear) are
 * blocked while a turn runs so they cannot silently kill it (same busy
 * guard as the menu/deep-link/WorkspaceDialog paths). Local-only slash
 * commands resolve with agentInvoked:false and emit no agent events, so
 * settling rehydrates — hydration is the only way the transcript
 * (compaction summary, model change) and the context bar learn about the
 * mutation, same as the TUI re-render.
 */

import type { ImageContent, RpcResponse } from "../../shared/rpc-types";
import { hydrateSession } from "../hooks/use-rpc-events";
import { toast } from "../stores/toast";
import { translate } from "./i18n";

export type ComposerSendMode = "prompt" | "steer" | "followUp";

/** Builtin slash commands that replace the session server-side. */
const SESSION_REPLACING_COMMANDS: Record<string, true> = { new: true, clear: true };

export type ComposerSubmit =
	/** Session-replacing command while busy — draft stays, warning toasted. */
	| { kind: "blocked" }
	/** Dispatch this request; on success call {@link settleComposerResponse}. */
	| { kind: "send"; request: Promise<RpcResponse> };

export function planComposerSubmit(input: {
	message: string;
	images: ImageContent[];
	isStreaming: boolean;
	mode: ComposerSendMode;
}): ComposerSubmit {
	const { message, images, isStreaming, mode } = input;
	const isSlashCommand = message.startsWith("/");
	if (isSlashCommand && isStreaming) {
		const commandName = /^\/([a-z-]+)/i.exec(message)?.[1]?.toLowerCase();
		if (commandName !== undefined && SESSION_REPLACING_COMMANDS[commandName]) {
			toast({ variant: "warning", message: translate("sessionSwitch.busyBlocked") });
			return { kind: "blocked" };
		}
	}
	if (!isSlashCommand && isStreaming) {
		return {
			kind: "send",
			request:
				mode === "followUp" ? window.omp.rpc.followUp(message, images) : window.omp.rpc.steer(message, images),
		};
	}
	return { kind: "send", request: window.omp.rpc.prompt(message, images) };
}

/** Post-success settle: rehydrate after local-only slash commands. */
export async function settleComposerResponse(response: RpcResponse): Promise<void> {
	if (!response.success) return;
	const data: unknown = response.data;
	if (data !== null && typeof data === "object" && "agentInvoked" in data && data.agentInvoked === false) {
		await hydrateSession();
	}
}
