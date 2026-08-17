/**
 * useComposerSubmit: the composer submit controller extracted from InputArea.
 * Owns the entire send pipeline: bash/python mode dispatch, yield-queue
 * shorthand, slash-command routing, and the prompt/steer/followUp dispatch.
 */

import { useCallback } from "react";
import type { AgentMessage, AvailableCommand } from "../../../shared/rpc-types";
import { hydrateSession } from "../../hooks/use-rpc-events";
import { isGuiOnlyBuiltinCommand, planComposerSubmit, settleComposerResponse } from "../../lib/composer-submit";
import { expandEmoticons } from "../../lib/emoji";
import { useT } from "../../lib/i18n";
import { parseComposerMode } from "../../lib/input-modes";
import { clearSessionContext } from "../../lib/messages";
import { dropReferencedPastes, expandPasteMarkers } from "../../lib/paste-blobs";
import { parseQueueShorthand, splitQueuedMessages } from "../../lib/queue-input";
import { acceptsActiveTabEvents } from "../../lib/tab-routing";
import type { ComposerImage } from "../../stores/composer";
import { useInputHistoryStore } from "../../stores/input-history";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { restoreTabComposer, useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";

type SendMode = "prompt" | "steer" | "followUp";

export function useComposerSubmit({
	text,
	images,
	sending,
	status,
	isStreaming,
	mode,
	queuedMessageCount,
	commands,
	emojiAutocomplete,
	routeReady,
	setText,
	setImages,
	setMenu,
	setSending,
}: {
	text: string;
	images: ComposerImage[];
	sending: boolean;
	status: string;
	isStreaming: boolean;
	mode: SendMode;
	queuedMessageCount: number;
	commands: AvailableCommand[];
	emojiAutocomplete: boolean;
	routeReady: boolean;
	setText: (next: string | ((current: string) => string)) => void;
	setImages: (next: ComposerImage[] | ((current: ComposerImage[]) => ComposerImage[])) => void;
	setMenu: (menu: null) => void;
	setSending: (value: boolean) => void;
}) {
	const t = useT();
	const send = useCallback(
		// `overrideText` sends a freshly computed value (voice dictation submit
		// trigger) instead of the rendered `text` state, which lags a setText.
		// `forceMode` overrides the steer/followUp toggle for one send (⌃Enter).
		(overrideText?: string, forceMode?: SendMode) => {
			const message = (overrideText ?? text).trim();
			if ((!message && images.length === 0) || sending) return;
			if (!routeReady || !acceptsActiveTabEvents()) return;
			if (status !== "ready") {
				toast({ variant: "warning", message: t("input.agentConnecting") });
				return;
			}
			const originTabId = useTabsStore.getState().activeTabId;
			const originSessionId = useSessionStore.getState().sessionId;
			const originStillActive = () =>
				useTabsStore.getState().activeTabId === originTabId &&
				useSessionStore.getState().sessionId === originSessionId &&
				acceptsActiveTabEvents();

			// Paste markers expand to full blob content BEFORE mode/queue parsing and
			// every dispatch path (bash, python, prompt, queue items) — the wire only
			// ever sees expanded text (TUI getExpandedText parity, regression #3737).
			// History records the raw typed text (markers included), matching the TUI.
			// Emoticon expansion also runs at submit time over the whole message
			// (input-controller.ts:617 — Enter without a trailing space after `:)`).
			const expandedMessage = emojiAutocomplete
				? expandEmoticons(expandPasteMarkers(message))
				: expandPasteMarkers(message);

			const parsed = parseComposerMode(expandedMessage);
			if (parsed?.mode === "bash" && parsed.body) {
				useInputHistoryStore.getState().record(message);
				const previousImages = images;
				setText("");
				setImages([]);
				setMenu(null);
				setSending(true);
				const pending: AgentMessage = {
					role: "bashExecution",
					command: parsed.body,
					excludeFromContext: parsed.excluded,
					timestamp: Date.now(),
					running: true,
				};
				useMessagesStore.getState().appendMessage(pending);
				void window.omp.rpc
					.bash(parsed.body, parsed.excluded)
					.then(async response => {
						if (originStillActive()) useMessagesStore.getState().removeMessage(pending);
						if (!response.success) {
							restoreTabComposer(originTabId, originSessionId, message, previousImages);
							toast({ variant: "error", title: t("input.bashFailed"), message: response.error });
							return;
						}
						if (!originStillActive()) return;
						dropReferencedPastes(message);
						await hydrateSession();
					})
					.catch(error => {
						if (originStillActive()) useMessagesStore.getState().removeMessage(pending);
						restoreTabComposer(originTabId, originSessionId, message, previousImages);
						toast({ variant: "error", title: t("input.bashFailed"), message: String(error) });
					})
					.finally(() => setSending(false));
				return;
			}

			// `$ code` → python mode (TUI parity): run through the eval RPC, showing a
			// running ExecutionBubble (cancel → abortEval) until the transcript record
			// lands. Language is left to the sidecar — interactive eval is python-only
			// today and the GUI tracks no kernel state to source it from.
			if (parsed?.mode === "python" && parsed.body) {
				useInputHistoryStore.getState().record(message);
				const previousImages = images;
				setText("");
				setImages([]);
				setMenu(null);
				setSending(true);
				const pending: AgentMessage = {
					role: "pythonExecution",
					code: parsed.body,
					timestamp: Date.now(),
					running: true,
				};
				useMessagesStore.getState().appendMessage(pending);
				void window.omp.rpc
					.eval(parsed.body, undefined, parsed.excluded)
					.then(async response => {
						if (originStillActive()) useMessagesStore.getState().removeMessage(pending);
						if (!response.success) {
							restoreTabComposer(originTabId, originSessionId, message, previousImages);
							toast({ variant: "error", title: t("input.evalFailed"), message: response.error });
							return;
						}
						if (!originStillActive()) return;
						dropReferencedPastes(message);
						await hydrateSession();
					})
					.catch(error => {
						if (originStillActive()) useMessagesStore.getState().removeMessage(pending);
						restoreTabComposer(originTabId, originSessionId, message, previousImages);
						toast({ variant: "error", title: t("input.evalFailed"), message: String(error) });
					})
					.finally(() => setSending(false));
				return;
			}

			// `->` / `=>` yield-queue shorthand (TUI #queueForYield parity): split an
			// enumerated list into one queue entry per item; first item prompts with
			// streamingBehavior:"followUp" when idle, everything else followUps;
			// images ride on the first item only.
			const queueBody = parseQueueShorthand(expandedMessage);
			if (queueBody !== undefined) {
				const payload = images.map(image => image.content);
				const items = splitQueuedMessages(queueBody);
				// Bare prefix + no images hits the usage warning, it does NOT enqueue
				// (input-controller.ts:1186-1190). Images alone queue a single empty item.
				if (items.length === 0 && payload.length === 0) {
					toast({ variant: "warning", message: t("input.queue.usage") });
					return;
				}
				useInputHistoryStore.getState().record(message);
				const previousImages = images;
				setText("");
				setImages([]);
				setMenu(null);
				const dispatchItems = items.length > 0 ? items : [""];
				if (dispatchItems.some(item => isGuiOnlyBuiltinCommand(item, commands))) {
					setText(message);
					setImages(previousImages);
					toast({ variant: "warning", message: t("input.queue.guiCommand") });
					return;
				}
				const startImmediately = !isStreaming && queuedMessageCount === 0;
				// session.followUp throws on extension-command text (agent-session.ts:5508-5510),
				// so those items go through prompt, whose slash chain executes them.
				const extensionCommandNames = new Set(
					commands.filter(command => command.source === "extension").map(command => command.name),
				);
				void (async () => {
					let sent = 0;
					try {
						for (let index = 0; index < dispatchItems.length; index++) {
							if (!originStillActive()) throw new Error("Tab changed during queue dispatch");
							const item = dispatchItems[index] ?? "";
							const itemImages = index === 0 ? payload : undefined;
							const isExtensionCommand =
								item.startsWith("/") && extensionCommandNames.has(/^\/([a-z0-9-]+)/i.exec(item)?.[1] ?? "");
							const response =
								startImmediately && index === 0
									? await window.omp.rpc.prompt(item, itemImages, "followUp")
									: isExtensionCommand
										? await window.omp.rpc.prompt(item, itemImages)
										: await window.omp.rpc.followUp(item, itemImages);
							if (!response.success) throw new Error(response.error ?? "queue dispatch failed");
							sent += 1;
						}
						if (originStillActive()) dropReferencedPastes(message);
					} catch (error) {
						if (sent === 0) {
							// Zero items sent: restore the original draft (markers) and images.
							restoreTabComposer(originTabId, originSessionId, message, previousImages);
						} else {
							// Partial failure: restore the remainder in the exact shorthand
							// shape the parser can consume again. Continuation indentation
							// prevents marker-looking lines inside one item from splitting.
							const remaining = dispatchItems.slice(sent);
							const remainingDraft =
								remaining.length === 1
									? `=> ${remaining[0]}`
									: `=>\n${remaining
											.map((item, index) => `${index + 1}. ${item.replaceAll("\n", "\n   ")}`)
											.join("\n")}`;
							restoreTabComposer(originTabId, originSessionId, remainingDraft, []);
							if (originStillActive()) dropReferencedPastes(message);
						}
						toast({
							variant: "error",
							title: t("input.sendFailed"),
							message:
								sent > 0 ? t("input.queue.partial", { sent, total: dispatchItems.length }) : String(error),
						});
					}
				})();
				return;
			}

			useInputHistoryStore.getState().record(message);

			// Routing/guarding/hydration policy lives in lib/composer-submit:
			// slash commands always go through prompt (server parses them even
			// while streaming), session-replacing commands are blocked while
			// busy, and local-only resolutions rehydrate the transcript.
			const payload = images.map(image => image.content);
			const submit = planComposerSubmit({
				message: expandedMessage,
				images: payload,
				isStreaming,
				mode: forceMode ?? mode,
				commands,
			});
			if (submit.kind === "blocked") return;
			if (submit.kind === "handled") {
				setText("");
				setImages([]);
				setMenu(null);
				dropReferencedPastes(message);
				return;
			}
			// Native /clear: drop context in place via clear_context RPC; the draft
			// is restored when the server refuses (busy).
			if (submit.kind === "clear") {
				const previousImages = images;
				setText("");
				setImages([]);
				setMenu(null);
				void clearSessionContext().then(cleared => {
					if (cleared) {
						if (originStillActive()) dropReferencedPastes(message);
						return;
					}
					restoreTabComposer(originTabId, originSessionId, message, previousImages);
				});
				return;
			}
			const previousImages = images;
			setText("");
			setImages([]);
			setMenu(null);
			// Let React commit the cleared draft before contextBridge serializes the
			// request payload. On large sessions/attachments that synchronous bridge
			// work used to make Enter look ignored for a noticeable beat.
			setTimeout(() => {
				if (!originStillActive()) {
					restoreTabComposer(originTabId, originSessionId, message, previousImages);
					return;
				}
				void submit
					.request()
					.then(async response => {
						if (!response.success) {
							restoreTabComposer(originTabId, originSessionId, message, previousImages);
							toast({ variant: "error", title: t("input.sendFailed"), message: response.error });
							return;
						}
						if (!originStillActive()) return;
						dropReferencedPastes(message);
						await settleComposerResponse(response, expandedMessage);
					})
					.catch(error => {
						restoreTabComposer(originTabId, originSessionId, message, previousImages);
						toast({ variant: "error", title: t("input.sendFailed"), message: String(error) });
					});
			}, 0);
		},
		[
			text,
			images,
			sending,
			status,
			isStreaming,
			mode,
			queuedMessageCount,
			commands,
			emojiAutocomplete,
			routeReady,
			t,
			setText,
			setImages,
			setSending,
			setMenu,
		],
	);

	return send;
}
