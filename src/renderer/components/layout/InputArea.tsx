import { ArrowUp, ChevronDown, Mic, Paperclip, Square, X, Zap } from "lucide-react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsTreeEntry } from "../../../shared/ipc-types";
import type { AgentMessage, AvailableCommand, ImageContent } from "../../../shared/rpc-types";
import { useActiveTabRouteReady } from "../../hooks/use-active-tab-route";
import { hydrateSession } from "../../hooks/use-rpc-events";
import { isGuiOnlyBuiltinCommand, planComposerSubmit, settleComposerResponse } from "../../lib/composer-submit";
import { expandEmoticons, getEmojiSuggestions, tryEmojiInlineReplace } from "../../lib/emoji";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { parseComposerMode } from "../../lib/input-modes";
import { clearSessionContext } from "../../lib/messages";
import {
	dropReferencedPastes,
	expandPasteMarkers,
	isMarkerSized,
	pasteMarkerText,
	shouldOfferPasteMenu,
	storePaste,
	wrapPasteInAttachmentBlock,
} from "../../lib/paste-blobs";
import { parseQueueShorthand, splitQueuedMessages } from "../../lib/queue-input";
import { acceptsActiveTabEvents, onActiveTabRouteSettled } from "../../lib/tab-routing";
import {
	cancelVoiceRecording,
	evaluateSttSubmitTrigger,
	readSttSubmitTrigger,
	recordAndTranscribe,
	stopVoiceRecording,
} from "../../lib/voice";
import { type ComposerImage, useComposerStore } from "../../stores/composer";
import { useInputHistoryStore } from "../../stores/input-history";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { restoreTabComposer, useActiveTabKind, useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { ActivityStrip } from "../chat/ActivityStrip";
import { ApprovalControl } from "./ApprovalControl";
import { ComposerModes } from "./ComposerModes";
import { HistorySearchOverlay } from "./HistorySearchOverlay";
import { ThinkingControl } from "./ThinkingControl";

interface CompletionItem {
	value: string;
	label: string;
	description?: string;
	hint?: string;
}

/** Completion menu state: the winning provider's items + replace range. */
interface CompletionMenu {
	source: "slash-arg" | "github-ref" | "command" | "mention" | "emoji";
	rangeStart: number;
	rangeEnd: number;
	items: CompletionItem[];
	index: number;
}

type SendMode = "prompt" | "steer" | "followUp";

const MAX_MENU_ITEMS = 8;
/** Cap on fuzzy file results shown above the scheme entries in the @ menu. */
const MAX_MENTION_FILE_ITEMS = 20;
const MENTION_FS_DEPTH = 8;
const MENTION_FS_MAX_ENTRIES = 2000;
const MENTION_FS_DEBOUNCE_MS = 150;

/** Internal URL schemes always offered in the @ menu, below file results. */
const MENTION_SCHEMES = ["skill://", "memory://", "artifact://", "issue://", "pr://", "local://plan.md"];

/**
 * Commands that are silent no-ops in a tool-free chat session: mode toggles
 * whose wiring is gated by restrictToolNames (plan/goal/loop/vibe/modes) and
 * tool-spawning commands (task/tan/security). They stay OFF the slash menu in
 * chat tabs — the menu must never offer a command that does nothing.
 * Session/transport commands (/compact, /clear, /model, /export…) still work
 * tool-free and stay.
 */
const CHAT_DEAD_COMMANDS: ReadonlySet<string> = new Set([
	"plan",
	"goal",
	"loop",
	"vibe",
	"modes",
	"task",
	"tan",
	"security",
]);

/** Subsequence fuzzy score; null = no match. Earlier + denser wins. */
function fuzzyScore(query: string, target: string): number | null {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	if (q.length === 0) return 0;
	let qi = 0;
	let score = 0;
	let last = -2;
	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			score += ti === last + 1 ? 2 : 1;
			last = ti;
			qi++;
		}
	}
	return qi === q.length ? score : null;
}

/** Collect workspace-relative file paths from an fs:list tree (files only). */
function flattenFilePaths(entries: FsTreeEntry[], out: string[]): void {
	for (const entry of entries) {
		if (entry.kind === "file") out.push(entry.path);
		else if (entry.children) flattenFilePaths(entry.children, out);
	}
}

/** @mention file lists, cached per session cwd; inflight dedupes concurrent walks. */
const mentionFileCache = new Map<string, string[]>();
const mentionFileInflight = new Map<string, Promise<string[]>>();

function listMentionFiles(cwd: string): Promise<string[]> {
	const cached = mentionFileCache.get(cwd);
	if (cached) return Promise.resolve(cached);
	const inflight = mentionFileInflight.get(cwd);
	if (inflight) return inflight;
	const task = window.omp.fs
		.list(undefined, MENTION_FS_DEPTH, MENTION_FS_MAX_ENTRIES)
		.then(result => {
			const paths: string[] = [];
			if (result.ok) flattenFilePaths(result.entries, paths);
			paths.sort();
			mentionFileCache.set(cwd, paths);
			return paths;
		})
		.catch(() => {
			// Best-effort: on IPC failure the @ menu falls back to scheme entries
			// only; nothing is cached so the next attempt retries the walk.
			return [] as string[];
		})
		.finally(() => {
			mentionFileInflight.delete(cwd);
		});
	mentionFileInflight.set(cwd, task);
	return task;
}

function fileToImage(file: File): Promise<ComposerImage> {
	const { promise, resolve, reject } = Promise.withResolvers<ComposerImage>();
	const reader = new FileReader();
	reader.onload = () => {
		const dataUrl = String(reader.result);
		const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
		resolve({
			content: { type: "image", data: base64, mimeType: file.type || "image/png" },
			preview: dataUrl,
		});
	};
	reader.onerror = () => reject(reader.error);
	reader.readAsDataURL(file);
	return promise;
}

/**
 * Composer: auto-growing textarea, Enter to send / Shift+Enter for newline,
 * image paste, @file mentions, /command completion, steering-mode selector,
 * and an abort button while the agent streams.
 */
export function InputArea() {
	const isStreaming = useSessionStore(s => s.isStreaming);
	const t = useT();
	const routeReady = useActiveTabRouteReady();
	/** Chat tabs are tool-free: approval/mode chrome is meaningless there. */
	const isChat = useActiveTabKind() === "chat";
	const status = useSessionStore(s => s.status);
	const sessionId = useSessionStore(s => s.sessionId);
	const queuedMessageCount = useSessionStore(s => s.queuedMessageCount);
	const contextUsage = useSessionStore(s => s.contextUsage);
	const cwd = useSessionStore(s => s.cwd);
	const steeringMode = useSettingsStore(s => s.steeringMode);
	const model = useModelStore(s => s.model);
	const fastModeEnabled = useModelStore(s => s.fastModeEnabled);
	const fastModeActive = useModelStore(s => s.fastModeActive);
	const openModelPicker = useUiStore(s => s.openModelPicker);
	/** Agent `stt.enabled` setting: microphone dictation button in the composer. */
	const sttEnabled = useSettingsStore(s => s.sttEnabled);
	/** Agent `paste.largeMenuThreshold` setting: line count that triggers the paste menu. */
	const pasteMenuThreshold = useSettingsStore(s => s.pasteMenuThreshold);
	/** Agent `emojiAutocomplete` setting: emoji popup/inline/submit expansion. */
	const emojiAutocomplete = useSettingsStore(s => s.emojiAutocomplete);

	// Draft lives in the composer store (not local state) so session-tab
	// switches snapshot/restore it per tab. Value + updater-form setter are
	// drop-in for the old useState pair.
	const text = useComposerStore(s => s.draft);
	const setText = useComposerStore(s => s.setDraft);
	const images = useComposerStore(s => s.images);
	const setImages = useComposerStore(s => s.setImages);
	const [mode, setMode] = useState<SendMode>("prompt");
	const [menu, setMenu] = useState<CompletionMenu | null>(null);
	const [commands, setCommands] = useState<AvailableCommand[]>([]);
	const [sending, setSending] = useState(false);
	const [filePaths, setFilePaths] = useState<string[]>([]);
	const [historySearchOpen, setHistorySearchOpen] = useState(false);
	const [recording, setRecording] = useState(false);
	/** Pending large-paste choice: the paste already happened, this picks the form. */
	const [pasteMenu, setPasteMenu] = useState<{ content: string; lineCount: number } | null>(null);

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const mountedRef = useRef(true);

	// An in-flight dictation is cancelled (never transcribed) if the composer unmounts.
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			cancelVoiceRecording();
		};
	}, []);

	// Load persisted prompt history once (prefs IPC).
	useEffect(() => {
		void useInputHistoryStore.getState().hydrate();
	}, []);

	// `!` → bash / `$` → python composer mode (TUI parity): drives the border badge
	// and reroutes sending. Detected from the prefix alone so the badge appears
	// while the user is still typing.
	const composerMode = useMemo(() => parseComposerMode(text), [text]);
	const modeColor =
		composerMode?.mode === "bash"
			? "var(--omp-info)"
			: composerMode?.mode === "python"
				? "var(--omp-warning)"
				: undefined;

	// `->` / `=>` yield-queue shorthand (TUI queue-input.ts parity). The badge
	// preview and the send-path dispatch share this one parser so the "splits
	// into N" promise always matches what actually gets queued.
	const queueBody = useMemo(() => parseQueueShorthand(text), [text]);
	const queueSplitCount = useMemo(() => {
		if (queueBody === undefined || queueBody.length === 0) return 0;
		const items = splitQueuedMessages(queueBody);
		return items.length > 1 ? items.length : 0;
	}, [queueBody]);

	// Contextual argument hint (TUI ghost-text parity): the command's usage
	// hint, or the unique-matching subcommand's remainder + usage. Rendered as
	// a dim row under the textarea — an inline-after-cursor ghost needs
	// pixel-aligned overlay metrics that break with auto-grow/IME (same
	// tradeoff as the queue highlight).
	const argHint = useMemo(() => {
		if (menu || !text.startsWith("/")) return "";
		const cursor = textareaRef.current?.selectionStart ?? text.length;
		if (cursor !== text.length) return "";
		const match = /^\/([a-z-]+)(?:\s(\S*))?$/i.exec(text);
		if (!match) return "";
		const name = (match[1] ?? "").toLowerCase();
		const command = commands.find(
			candidate =>
				candidate.name.toLowerCase() === name || candidate.aliases?.some(alias => alias.toLowerCase() === name),
		);
		if (!command) return "";
		const argPrefix = match[2] ?? "";
		if (argPrefix === "") return command.input?.hint ?? "";
		if (command.subcommands?.length) {
			const lower = argPrefix.toLowerCase();
			const sub = command.subcommands.find(candidate => candidate.name.startsWith(lower));
			if (sub) return [sub.name.slice(lower.length), sub.usage].filter(Boolean).join(" ");
		}
		return "";
	}, [text, menu, commands]);

	// Keep slash commands current across sidecar startup and extension reloads.
	useEffect(() => {
		let cancelled = false;
		const unsubscribe = window.omp.events.onCommandsUpdate(next => {
			if (!cancelled && acceptsActiveTabEvents()) setCommands(next);
		});
		const load = () => {
			if (status !== "ready" || !acceptsActiveTabEvents()) return;
			void window.omp.rpc.getAvailableCommands().then(res => {
				if (
					cancelled ||
					!acceptsActiveTabEvents() ||
					useSessionStore.getState().sessionId !== sessionId ||
					!res.success
				)
					return;
				const data = res.data as { commands?: AvailableCommand[] } | undefined;
				setCommands(data?.commands ?? []);
			});
		};
		const unsubscribeRoute = onActiveTabRouteSettled(load);
		load();
		return () => {
			cancelled = true;
			unsubscribe();
			unsubscribeRoute();
		};
	}, [status, sessionId]);

	// Auto-grow the textarea to fit its content (up to ~40% of the viewport).
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "0px";
		const maxHeight = text.length === 0 ? 24 : window.innerHeight * 0.4;
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	}, [text]);

	// Derive the completion menu from the draft around the caret. Provider
	// chain (TUI getSuggestions order): slash-arg → github-ref → slash names →
	// @mention → emoji. First provider with items wins; async providers (emoji
	// buckets, dynamic arg RPC) resolve through a cancel token + debounce.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			setMenu(null);
			return;
		}
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cursor = el.selectionStart ?? text.length;
		const before = text.slice(0, cursor);
		const apply = (result: Omit<CompletionMenu, "index" | "rangeEnd"> | null) => {
			if (cancelled) return;
			setMenu(result && result.items.length > 0 ? { ...result, rangeEnd: cursor, index: 0 } : null);
		};

		// 1. Slash-command ARGUMENTS: "/cmd <args>" with the slash at buffer start.
		const argMatch = /^\/([a-z-]+)\s(.+)$/i.exec(before);
		if (argMatch) {
			const name = (argMatch[1] ?? "").toLowerCase();
			const command = commands.find(
				candidate =>
					candidate.name.toLowerCase() === name || candidate.aliases?.some(alias => alias.toLowerCase() === name),
			);
			if (command && command.allowArgs === false) {
				apply(null); // args not accepted — hard close (TUI parity)
				return () => {
					cancelled = true;
				};
			}
			if (command) {
				const argPrefix = argMatch[2] ?? "";
				const rangeStart = cursor - argPrefix.length;
				if (!argPrefix.includes(" ")) {
					// Still typing the subcommand (or a one-word arg): static list first.
					if (command.subcommands?.length) {
						const lower = argPrefix.toLowerCase();
						const items = command.subcommands
							.filter(sub => sub.name.startsWith(lower))
							.map(sub => ({
								value: `${sub.name} `,
								label: sub.name,
								description: sub.description,
								hint: sub.usage,
							}));
						if (items.length > 0) {
							apply({ source: "slash-arg", rangeStart, items });
							return () => {
								cancelled = true;
							};
						}
					}
				}
				if (command.hasDynamicArgCompletion) {
					timer = setTimeout(() => {
						void window.omp.rpc.getCommandArgCompletions(command.name, argPrefix).then(response => {
							if (!response.success) {
								apply(null);
								return;
							}
							const data = response.data as { items?: CompletionItem[] } | undefined;
							apply(data?.items?.length ? { source: "slash-arg", rangeStart, items: data.items } : null);
						});
					}, 120);
					return () => {
						cancelled = true;
						clearTimeout(timer);
					};
				}
				apply(null);
				return () => {
					cancelled = true;
				};
			}
		}

		// 2. GitHub #ref: standalone #<positive-int> at a token boundary (no network).
		const refMatch = /(?:^|[\s"'`(<=])(?:(pr|pull|issue)(\s+))?#([1-9]\d*)$/i.exec(before);
		if (refMatch) {
			const qualifier = refMatch[1]?.toLowerCase();
			const number = refMatch[3] ?? "";
			const rangeStart = cursor - number.length - 1; // include the '#'
			const items =
				qualifier === "pr" || qualifier === "pull"
					? [{ value: `pr://${number} `, label: `pr://${number}` }]
					: qualifier === "issue"
						? [{ value: `issue://${number} `, label: `issue://${number}` }]
						: [
								{ value: `pr://${number} `, label: `pr://${number}`, description: "pull request" },
								{ value: `issue://${number} `, label: `issue://${number}`, description: "issue" },
							];
			apply({ source: "github-ref", rangeStart, items });
			return () => {
				cancelled = true;
			};
		}

		// 3. Slash command NAMES at a word boundary.
		const cmdMatch = /(^|\s)\/([a-z-]*)$/i.exec(before);
		if (cmdMatch) {
			const query = (cmdMatch[2] ?? "").toLowerCase();
			const items = commands
				.filter(
					command =>
						// Chat tabs: never offer commands that are silent no-ops there.
						(!isChat || !CHAT_DEAD_COMMANDS.has(command.name)) &&
						(!query ||
							command.name.toLowerCase().includes(query) ||
							command.aliases?.some(alias => alias.toLowerCase().includes(query))),
				)
				.slice(0, MAX_MENU_ITEMS)
				.map(command => ({
					value: `/${command.name} `,
					label: `/${command.name}`,
					description: command.description,
				}));
			apply({ source: "command", rangeStart: cursor - query.length - 1, items });
			return () => {
				cancelled = true;
			};
		}

		// 4. @ mention: workspace files (fuzzy) above internal URL schemes.
		const mentionMatch = /(^|\s)@([\w./-]*)$/.exec(before);
		if (mentionMatch) {
			const q = mentionMatch[2] ?? "";
			const items: CompletionItem[] = [];
			const scored: { path: string; score: number }[] = [];
			for (const path of filePaths) {
				const score = fuzzyScore(q, path);
				if (score !== null) scored.push({ path, score });
			}
			scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
			for (const { path } of scored.slice(0, MAX_MENTION_FILE_ITEMS)) {
				items.push({ value: `@${path} `, label: path });
			}
			const lowerQuery = q.toLowerCase();
			for (const scheme of MENTION_SCHEMES) {
				if (scheme.toLowerCase().includes(lowerQuery)) items.push({ value: scheme, label: scheme });
			}
			apply({ source: "mention", rangeStart: cursor - q.length - 1, items });
			return () => {
				cancelled = true;
			};
		}

		// 5. Emoji (async; the bucket JSON lazy-loads on first trigger).
		if (emojiAutocomplete) {
			void getEmojiSuggestions(before).then(result => {
				if (!result) {
					apply(null);
					return;
				}
				apply({ source: "emoji", rangeStart: cursor - result.prefix.length, items: result.items });
			});
			return () => {
				cancelled = true;
			};
		}

		apply(null);
		return () => {
			cancelled = true;
		};
	}, [text, filePaths, commands, emojiAutocomplete, isChat]);

	// Reset the mention file list when the session cwd changes (cache is per-cwd).
	useEffect(() => {
		setFilePaths(mentionFileCache.get(cwd) ?? []);
	}, [cwd]);

	// Lazy-load workspace files for @mention completion: debounced so a fleeting
	// "@" doesn't trigger the walk, then cached per cwd for instant filtering.
	useEffect(() => {
		if (!routeReady) return;
		if (mentionFileCache.has(cwd)) return;
		const el = textareaRef.current;
		const before = text.slice(0, el?.selectionStart ?? text.length);
		if (!/(^|\s)@[\w./-]*$/.test(before)) return;
		const key = cwd;
		const timer = setTimeout(() => {
			void listMentionFiles(key).then(paths => {
				if (useSessionStore.getState().cwd === key) setFilePaths(paths);
			});
		}, MENTION_FS_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [text, cwd, routeReady]);

	useEffect(() => {
		const onInsertMention = (event: Event) => {
			const path = (event as CustomEvent<{ path?: string }>).detail?.path;
			if (!path) return;
			setText(current => `${current}${current && !current.endsWith(" ") ? " " : ""}@${path} `);
			requestAnimationFrame(() => textareaRef.current?.focus());
		};
		window.addEventListener("omp:insert-mention", onInsertMention);
		return () => window.removeEventListener("omp:insert-mention", onInsertMention);
	}, [setText]);

	useEffect(() => {
		const fillComposer = (event: Event) => {
			const detail = (
				event as CustomEvent<{ text?: string; images?: ImageContent[]; prepend?: boolean; clearPastes?: boolean }>
			).detail;
			const next = detail?.text;
			const restoredImages = detail?.images ?? [];
			if (!next && restoredImages.length === 0) return;
			// The editor dialog writes back fully-inline text — consume the blobs.
			if (detail?.clearPastes) dropReferencedPastes(useComposerStore.getState().draft);
			// prepend (dequeue restore): queued text goes ahead of any draft, TUI-style;
			// otherwise replace (starter cards, history recall).
			setText(current => {
				if (!next) return current;
				return detail?.prepend && current.trim() ? `${next}\n\n${current}` : next;
			});
			if (restoredImages.length > 0) {
				setImages(current => [
					...current,
					...restoredImages.map(content => ({
						content,
						preview: `data:${content.mimeType};base64,${content.data}`,
					})),
				]);
			}
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (!el) return;
				el.focus();
				if (next) el.setSelectionRange(next.length, next.length);
			});
		};
		window.addEventListener("omp:fill-composer", fillComposer);
		return () => window.removeEventListener("omp:fill-composer", fillComposer);
	}, [
		// prepend (dequeue restore): queued text goes ahead of any draft, TUI-style;
		// otherwise replace (starter cards, history recall).
		setText,
		setImages,
	]);

	const insertCompletion = useCallback(
		(item: CompletionItem) => {
			const el = textareaRef.current;
			if (!el || !menu) return;
			const pos = el.selectionStart ?? text.length;
			if (pos !== menu.rangeEnd) {
				setMenu(null);
				return;
			}
			const replaced = `${text.slice(0, menu.rangeStart)}${item.value}${text.slice(pos)}`;
			setText(replaced);
			setMenu(null);
			requestAnimationFrame(() => {
				el.focus();
				const newPos = menu.rangeStart + item.value.length;
				el.setSelectionRange(newPos, newPos);
			});
		},
		[text, menu, setText],
	);

	// Collapse a large paste into a `[Paste #N]` marker with the blob held in
	// memory; the marker expands back to full content at submit time (TUI
	// editor.ts parity). Inserted at the caret, replacing any selection.
	const insertPasteBlob = useCallback(
		(content: string) => {
			const blob = storePaste(content);
			const marker = pasteMarkerText(blob.id, blob.content);
			const el = textareaRef.current;
			const start = el?.selectionStart ?? text.length;
			const end = el?.selectionEnd ?? start;
			setText(current => `${current.slice(0, start)}${marker}${current.slice(end)}`);
			requestAnimationFrame(() => {
				const target = textareaRef.current;
				if (!target) return;
				target.focus();
				const caret = start + marker.length;
				target.setSelectionRange(caret, caret);
			});
		},
		[text, setText],
	);

	// Paste menu actions — the paste always inserts something; the menu only
	// picks the form. Keep side effects outside state updaters: React may replay
	// updater functions, which must never duplicate a paste or an RPC write.
	const choosePasteInline = useCallback(() => {
		if (!pasteMenu) return;
		insertPasteBlob(pasteMenu.content);
		setPasteMenu(null);
	}, [insertPasteBlob, pasteMenu]);

	const choosePasteWrapped = useCallback(() => {
		if (!pasteMenu) return;
		insertPasteBlob(wrapPasteInAttachmentBlock(pasteMenu.content));
		setPasteMenu(null);
	}, [insertPasteBlob, pasteMenu]);

	// Save-as-file: the agent writes the blob into the session's local:// store
	// (counter allocated agent-side so two windows can never collide) and the
	// composer gets the returned literal reference. Any protocol or transport
	// failure falls back to the inline marker, so clipboard content is not lost.
	const choosePasteSaveFile = useCallback(() => {
		if (!pasteMenu) return;
		const pendingPaste = pasteMenu;
		setPasteMenu(null);
		void (async () => {
			try {
				const response = await window.omp.rpc.writeLocalPaste(pendingPaste.content);
				if (!response.success) throw new Error(response.error);
				const data = response.data as { url?: string } | undefined;
				if (!data?.url) throw new Error("write_local_paste returned no URL");
				const el = textareaRef.current;
				const start = el?.selectionStart ?? text.length;
				const end = el?.selectionEnd ?? start;
				const insert = `${data.url} `;
				setText(currentText => `${currentText.slice(0, start)}${insert}${currentText.slice(end)}`);
				requestAnimationFrame(() => {
					const target = textareaRef.current;
					if (!target) return;
					target.focus();
					const caret = start + insert.length;
					target.setSelectionRange(caret, caret);
				});
			} catch (cause) {
				toast({
					variant: "error",
					title: t("input.paste.saveFailed"),
					message: cause instanceof Error ? cause.message : String(cause),
				});
				insertPasteBlob(pendingPaste.content);
			}
		})();
	}, [insertPasteBlob, pasteMenu, text, t, setText]);

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
						await settleComposerResponse(response);
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
		],
	);

	// Mic dictation (stt.enabled): click starts capture, click again stops and
	// transcribes; the transcript inserts at the textarea caret. The
	// stt.submitTrigger setting can auto-submit the utterance (TUI parity).
	const handleMicClick = useCallback(() => {
		if (recording) {
			stopVoiceRecording();
			return;
		}
		setRecording(true);
		void recordAndTranscribe().then(async result => {
			if (!mountedRef.current) return;
			setRecording(false);
			if ("error" in result) {
				if (result.error) toast({ variant: "error", title: t("voice.mic.failed"), message: result.error });
				return;
			}
			const utterance = result.text.trim();
			if (!utterance) return;
			const trigger = await readSttSubmitTrigger();
			const evaluation = evaluateSttSubmitTrigger(utterance, trigger);
			const insert = (
				evaluation.trimTrailing > 0 ? utterance.slice(0, utterance.length - evaluation.trimTrailing) : utterance
			).trimEnd();
			if (!insert || !mountedRef.current) return;
			// Read the live DOM value/caret: the user may have typed mid-recording.
			const el = textareaRef.current;
			const current = el?.value ?? "";
			const start = el?.selectionStart ?? current.length;
			const end = el?.selectionEnd ?? start;
			const before = current.slice(0, start);
			const after = current.slice(end);
			const prefix = before.length > 0 && !before.endsWith(" ") ? " " : "";
			const suffix = after.length === 0 ? " " : "";
			const insertedText = `${prefix}${insert}${suffix}`;
			const next = `${before}${insertedText}${after}`;
			setText(next);
			requestAnimationFrame(() => {
				const target = textareaRef.current;
				if (!target) return;
				target.focus();
				const caret = start + insertedText.length;
				target.setSelectionRange(caret, caret);
			});
			if (evaluation.submit) send(next);
		});
	}, [recording, send, t, setText]);

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// IME composition (Chinese/Japanese/Korean input): while the candidate
		// window is open, Enter and friends belong to the IME — committing the
		// composition must never send the message. `isComposing` covers modern
		// browsers; keyCode 229 is the legacy fallback.
		if (e.nativeEvent.isComposing || e.keyCode === 229) return;
		// Pending paste choice: Esc takes the default (paste inline).
		if (pasteMenu) {
			if (e.key === "Escape") {
				e.preventDefault();
				choosePasteInline();
			}
			return;
		}
		if (menu && ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
			setMenu(null);
			return;
		}
		if (menu) {
			const count = menu.items.length;
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index + 1) % Math.max(1, count) });
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index - 1 + Math.max(1, count)) % Math.max(1, count) });
				return;
			}
			if (e.key === "Tab" || e.key === "Enter") {
				e.preventDefault();
				const item = menu.items[menu.index];
				if (item) insertCompletion(item);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMenu(null);
				return;
			}
		}
		// Ctrl+R: history search overlay (TUI `app.history.search`).
		if (e.key === "r" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			e.preventDefault();
			setHistorySearchOpen(open => !open);
			return;
		}
		// ⌃G: fullscreen editor dialog (TUI app.editor.external parity, GUI-native
		// form). Opens with the EXPANDED draft (paste markers resolved).
		if (e.key === "g" && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			e.preventDefault();
			useUiStore.getState().openComposerEditor(expandPasteMarkers(text));
			return;
		}
		// Up/Down prompt-history recall: Up from the first line cycles to older
		// entries, Down from the last line cycles back to the stashed draft.
		if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			const el = textareaRef.current;
			if (el) {
				const caretStart = el.selectionStart ?? 0;
				const caretEnd = el.selectionEnd ?? caretStart;
				const history = useInputHistoryStore.getState();
				let recalled: string | undefined;
				if (e.key === "ArrowUp" && !text.slice(0, caretStart).includes("\n")) {
					recalled = history.prev(text);
				} else if (e.key === "ArrowDown" && !text.slice(caretEnd).includes("\n")) {
					recalled = history.next();
				}
				if (recalled !== undefined) {
					e.preventDefault();
					const recalledText = recalled;
					setText(recalledText);
					requestAnimationFrame(() => {
						el.focus();
						el.setSelectionRange(recalledText.length, recalledText.length);
					});
					return;
				}
			}
		}
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			// ⌃Enter — send as follow-up, queueing behind the current yield (TUI
			// app.message.followUp). Idle sessions start immediately either way.
			send(undefined, e.ctrlKey && !e.metaKey && !e.altKey ? "followUp" : undefined);
		}
	};

	const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
		if (files.length > 0) {
			e.preventDefault();
			void Promise.all(files.map(fileToImage)).then(pasted => setImages(prev => [...prev, ...pasted]));
			return;
		}
		// Large TEXT paste (TUI editor.ts:1996-2044 parity): sanitize, then collapse
		// to a `[Paste #N]` marker past the marker threshold; past the (separate,
		// line-count-only) menu threshold, offer the inline/wrapped choice first.
		const pasted = e.clipboardData.getData("text/plain");
		if (!pasted) return;
		const content = pasted
			.replace(/\r\n?/g, "\n")
			.normalize("NFC")
			.replace(/\t/g, "   ")
			.replace(/[\x00-\x08\x0B-\x1F]/g, "");
		if (!isMarkerSized(content)) return; // small paste: default textarea behavior
		e.preventDefault();
		const lineCount = content.split("\n").length;
		if (shouldOfferPasteMenu(lineCount, pasteMenuThreshold)) {
			setPasteMenu({ content, lineCount });
			return;
		}
		insertPasteBlob(content);
	};

	const modeLabel = isStreaming
		? mode === "followUp"
			? t("input.followUp")
			: t("input.steer")
		: t("input.sendLabel");
	const modeTitle = isStreaming ? t("input.streamingTitle", { mode: steeringMode }) : t("input.sendPrompt");

	return (
		<div className="relative shrink-0 bg-[var(--omp-bg-primary)] px-6 pb-5 pt-3">
			<div className="omp-composer-shell relative w-full">
				{menu && (
					<div className="absolute bottom-full left-0 z-10 mb-2 max-h-[60vh] w-[420px] max-w-full overflow-y-auto rounded-xl border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] p-1 shadow-[var(--omp-shadow-lg)]">
						{menu.items.map((item, index) => (
							<button
								key={`${menu.source}:${item.label}`}
								type="button"
								onMouseDown={event => {
									event.preventDefault();
									insertCompletion(item);
								}}
								className={cx(
									"flex w-full items-baseline gap-3 rounded-lg px-3 py-2.5 text-left",
									index === menu.index ? "bg-[var(--omp-selected-bg)]" : "",
								)}
							>
								<span className="font-mono text-[13px] font-medium text-[var(--omp-accent)]">{item.label}</span>
								{item.description && (
									<span className="truncate text-[12px] text-[var(--omp-muted)]">{item.description}</span>
								)}
								{item.hint && (
									<span className="ml-auto shrink-0 font-mono text-[10.5px] text-[var(--omp-dim)]">
										{item.hint}
									</span>
								)}
							</button>
						))}
					</div>
				)}

				{historySearchOpen && (
					<HistorySearchOverlay
						onSelect={prompt => {
							setHistorySearchOpen(false);
							setText(prompt);
							requestAnimationFrame(() => {
								const el = textareaRef.current;
								if (!el) return;
								el.focus();
								el.setSelectionRange(prompt.length, prompt.length);
							});
						}}
						onClose={() => {
							setHistorySearchOpen(false);
							requestAnimationFrame(() => textareaRef.current?.focus());
						}}
					/>
				)}

				{queueBody !== undefined && (
					<div
						className="absolute -top-2 right-5 z-10 flex items-center gap-1.5 rounded-full border border-[var(--omp-warning)] px-2 py-0.5 text-[10px] font-semibold text-[var(--omp-warning)]"
						style={{ backgroundColor: "var(--omp-bg-primary)" }}
						title={t("input.queue.title")}
					>
						➤ {t("input.queue.badge")}
					</div>
				)}

				{pasteMenu && (
					<div className="absolute bottom-full left-0 right-0 z-20 mb-2 rounded-xl border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] p-3 shadow-[var(--omp-shadow-lg)]">
						<div className="flex items-baseline justify-between gap-3">
							<span className="text-[12.5px] font-medium text-[var(--omp-text)]">
								{t("input.paste.title", { lines: pasteMenu.lineCount, chars: pasteMenu.content.length })}
							</span>
							<span className="shrink-0 text-[11px] text-[var(--omp-dim)]">{t("input.paste.hint")}</span>
						</div>
						<pre className="mt-2 max-h-32 overflow-hidden rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] px-2.5 py-2 font-mono text-[11px] leading-[1.5] whitespace-pre-wrap break-all text-[var(--omp-muted)]">
							{(() => {
								const lines = pasteMenu.content.split("\n");
								if (lines.length <= 6) return pasteMenu.content;
								const head = lines.slice(0, 3).join("\n");
								const tail = lines.slice(-2).join("\n");
								return `${head}\n${t("input.paste.moreLines", { count: lines.length - 5 })}\n${tail}`;
							})()}
						</pre>
						<div className="mt-2.5 flex gap-2">
							<button
								type="button"
								onClick={choosePasteInline}
								className="omp-pressable rounded-lg bg-[var(--omp-btn-primary-bg)] px-3 py-1.5 text-[12px] font-medium text-[var(--omp-btn-primary-text)] hover:brightness-110"
							>
								{t("input.paste.inline")}
							</button>
							<button
								type="button"
								onClick={choosePasteWrapped}
								className="omp-pressable rounded-lg border border-[var(--omp-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
							>
								{t("input.paste.wrap")}
							</button>
							<button
								type="button"
								onClick={choosePasteSaveFile}
								className="omp-pressable rounded-lg border border-[var(--omp-border)] px-3 py-1.5 text-[12px] font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
							>
								{t("input.paste.saveFile")}
							</button>
						</div>
					</div>
				)}

				{composerMode && modeColor && (
					<div
						className="absolute -top-2 left-5 z-10 flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold"
						style={{ borderColor: modeColor, color: modeColor, backgroundColor: "var(--omp-bg-primary)" }}
						title={composerMode.mode === "bash" ? t("input.mode.bash.title") : t("input.mode.python.title")}
					>
						<span className="font-mono text-[11px] leading-none">{composerMode.mode === "bash" ? "!" : "$"}</span>
						{composerMode.mode}
					</div>
				)}

				<ActivityStrip />

				<div
					className="overflow-hidden rounded-lg border border-[var(--omp-input-border)] bg-[var(--omp-input-bg)] transition-[border-color] duration-150 focus-within:border-[var(--omp-input-focus-border)]"
					style={modeColor ? { borderColor: modeColor } : undefined}
				>
					<div className="px-3.5 pb-1.5 pt-2.5">
						{images.length > 0 && (
							<div className="mb-3 flex flex-wrap gap-2">
								{images.map((image, index) => (
									<div key={index} className="group relative">
										<img
											src={image.preview}
											alt={t("input.attachmentAlt", { index: index + 1 })}
											className="h-16 w-16 rounded-lg border border-[var(--omp-border-muted)] object-cover"
										/>
										<button
											type="button"
											title={t("input.removeAttachment")}
											onClick={() =>
												setImages(previous => previous.filter((_, itemIndex) => itemIndex !== index))
											}
											className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-[var(--omp-error)] text-[var(--omp-btn-danger-text)] shadow-sm group-hover:flex"
										>
											<X size={11} />
										</button>
									</div>
								))}
							</div>
						)}
						<textarea
							ref={textareaRef}
							value={text}
							onChange={event => {
								useInputHistoryStore.getState().resetNav();
								const value = event.target.value;
								// TUI parity (custom-editor.ts:1001-1007): the moment the buffer
								// becomes exactly the queue prefix, a newline starts the list body.
								if (value === "->" || value === "=>") {
									setText(`${value}\n`);
									return;
								}
								setText(value);
								// Emoji inline replace (TUI parity): `:name:` fires on the closing
								// colon, emoticons fire on a trailing space/tab/newline.
								if (emojiAutocomplete) {
									const caret = event.target.selectionStart ?? value.length;
									const before = value.slice(0, caret);
									void tryEmojiInlineReplace(before).then(hit => {
										if (!hit) return;
										const el = textareaRef.current;
										if (!el) return;
										// Stale-check: the user typed on meanwhile.
										const currentBefore = el.value.slice(0, el.selectionStart ?? el.value.length);
										if (currentBefore !== before) return;
										const nextText =
											before.slice(0, before.length - hit.replaceLen) +
											hit.insert +
											el.value.slice(before.length);
										setText(nextText);
										requestAnimationFrame(() => {
											const target = textareaRef.current;
											if (!target) return;
											const nextCaret = before.length - hit.replaceLen + hit.insert.length;
											target.setSelectionRange(nextCaret, nextCaret);
										});
									});
								}
							}}
							onKeyDown={handleKeyDown}
							onClick={() => setMenu(null)}
							onPaste={handlePaste}
							rows={2}
							placeholder={
								status !== "ready"
									? t("input.placeholder.connecting")
									: isStreaming
										? t("input.placeholder.streaming")
										: isChat
											? t("input.placeholder.chat")
											: t("input.placeholder.idle")
							}
							className="max-h-[40vh] min-h-[44px] w-full resize-none bg-transparent text-[14.5px] leading-[1.5] text-[var(--omp-text)] outline-none placeholder:text-[var(--omp-dim)]"
						/>
					</div>

					{argHint && <div className="px-3.5 pb-1 font-mono text-[11px] text-[var(--omp-dim)]">💡 {argHint}</div>}

					<div
						aria-busy={!routeReady}
						className="flex min-h-10 flex-wrap items-center gap-1 border-t border-[var(--omp-border-muted)] px-2 py-1.5"
						inert={!routeReady}
					>
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							title={t("input.attach")}
							className="omp-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
						>
							<Paperclip size={16} />
						</button>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/*"
							multiple
							className="hidden"
							onChange={event => {
								const files = Array.from(event.target.files ?? []);
								if (files.length > 0) {
									void Promise.all(files.map(fileToImage)).then(pasted =>
										setImages(previous => [...previous, ...pasted]),
									);
								}
								event.target.value = "";
							}}
						/>

						{sttEnabled && (
							<button
								type="button"
								onClick={handleMicClick}
								title={recording ? t("voice.mic.stop") : t("voice.mic.start")}
								className={cx(
									"omp-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
									recording
										? "bg-[var(--omp-error-dim)] text-[var(--omp-error)]"
										: "text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]",
								)}
							>
								{recording ? (
									<Square size={12} fill="currentColor" className="omp-pulse-dot" />
								) : (
									<Mic size={16} />
								)}
							</button>
						)}

						<button
							type="button"
							onClick={openModelPicker}
							title={t("input.model")}
							className="omp-pressable flex h-8 min-w-0 max-w-52 items-center gap-2 rounded-lg px-2.5 text-[12px] font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
						>
							<span className="h-2 w-2 shrink-0 rounded-full bg-[var(--omp-status-model)]" />
							<span className="truncate">{model?.id ?? t("input.chooseModel")}</span>
							<ChevronDown size={13} className="shrink-0 text-[var(--omp-dim)]" />
						</button>

						<ThinkingControl />

						<button
							type="button"
							onClick={() => void useModelStore.getState().toggleFastMode()}
							title={`${fastModeEnabled ? t("input.fast.on") : t("input.fast.off")}${fastModeActive ? t("input.fast.active") : ""}`}
							className={cx(
								"omp-pressable flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium hover:bg-[var(--omp-selected-bg)]",
								fastModeActive ? "text-[var(--omp-accent)]" : "text-[var(--omp-muted)]",
							)}
						>
							<Zap size={14} fill={fastModeActive ? "currentColor" : "none"} />
							<span className="hidden sm:inline">{t("input.fast.label")}</span>
						</button>

						{!isChat && <ApprovalControl />}
						{!isChat && <ComposerModes />}

						<div className="flex-1" />

						{contextUsage && (
							<div
								title={t("input.contextTooltip", { percent: Math.round(contextUsage.percent) })}
								className="hidden items-center gap-2 px-1 text-[11px] tabular-nums text-[var(--omp-dim)] sm:flex"
							>
								<span>{t("input.context")}</span>
								<div className="h-1.5 w-12 overflow-hidden rounded-full bg-[var(--omp-progress-bg)]">
									<div
										className="h-full rounded-full bg-[var(--omp-status-context)]"
										style={{ width: `${Math.min(100, contextUsage.percent)}%` }}
									/>
								</div>
								<span>{Math.round(contextUsage.percent)}%</span>
							</div>
						)}

						{queueSplitCount > 1 && (
							<span className="mr-1 shrink-0 rounded-md border border-[var(--omp-warning)] px-2 py-1 text-[11px] font-medium text-[var(--omp-warning)]">
								{t("input.queue.split", { count: queueSplitCount })}
							</span>
						)}

						{isStreaming ? (
							<div className="flex shrink-0 items-center gap-1.5">
								<button
									type="button"
									disabled={!routeReady}
									onClick={() => setMode(current => (current === "followUp" ? "steer" : "followUp"))}
									title={modeTitle}
									className="omp-pressable h-8 rounded-lg border border-[var(--omp-border)] bg-[var(--omp-bg-primary)] px-3 text-[12px] font-medium text-[var(--omp-muted)] hover:border-[var(--omp-border-strong)] hover:text-[var(--omp-text)]"
								>
									{modeLabel}
								</button>
								<button
									type="button"
									disabled={!routeReady}
									onClick={() => void window.omp.rpc.abort()}
									title={t("input.abort")}
									className="omp-pressable flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--omp-error-dim)] text-[var(--omp-error)] hover:bg-[var(--omp-error)] hover:text-[var(--omp-btn-danger-text)]"
								>
									<Square size={11} fill="currentColor" />
								</button>
							</div>
						) : (
							<button
								type="button"
								onClick={() => send()}
								disabled={!routeReady || status !== "ready" || sending || (!text.trim() && images.length === 0)}
								title={t("input.send")}
								className="omp-pressable flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--omp-btn-primary-bg)] text-[var(--omp-btn-primary-text)] shadow-[var(--omp-shadow-sm)] transition-[box-shadow,filter,transform,opacity] duration-150 hover:brightness-110 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:brightness-100 disabled:active:translate-y-0"
							>
								<ArrowUp size={16} strokeWidth={2.4} />
							</button>
						)}
					</div>
				</div>
				<div className="mt-2 text-center text-[11px] text-[var(--omp-dim)]">{t("input.hint")}</div>
			</div>
		</div>
	);
}
