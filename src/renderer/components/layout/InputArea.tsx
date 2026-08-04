import { ArrowUp, Brain, ChevronDown, Paperclip, Square, X, Zap } from "lucide-react";
import type { ClipboardEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FsTreeEntry } from "../../../shared/ipc-types";
import type { AgentMessage, AvailableCommand, ImageContent } from "../../../shared/rpc-types";
import { hydrateSession } from "../../hooks/use-rpc-events";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { parseComposerMode } from "../../lib/input-modes";
import { useInputHistoryStore } from "../../stores/input-history";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { HistorySearchOverlay } from "./HistorySearchOverlay";
import { ApprovalControl } from "./ApprovalControl";
import { ComposerModes } from "./ComposerModes";

type SendMode = "prompt" | "steer" | "followUp";

interface PastedImage {
	content: ImageContent;
	preview: string;
}

interface MentionEntry {
	/** Unique key + display source (file path or scheme). */
	path: string;
	label: string;
	/** Text inserted into the composer when the entry is chosen. */
	insert: string;
}

const MAX_MENU_ITEMS = 8;
/** Cap on fuzzy file results shown above the scheme entries in the @ menu. */
const MAX_MENTION_FILE_ITEMS = 20;
const MENTION_FS_DEPTH = 8;
const MENTION_FS_MAX_ENTRIES = 2000;
const MENTION_FS_DEBOUNCE_MS = 150;

/** Internal URL schemes always offered in the @ menu, below file results. */
const MENTION_SCHEMES = ["skill://", "memory://", "artifact://", "issue://", "pr://", "local://plan.md"];

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

function fileToImage(file: File): Promise<PastedImage> {
	const { promise, resolve, reject } = Promise.withResolvers<PastedImage>();
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
	const status = useSessionStore(s => s.status);
	const queuedMessageCount = useSessionStore(s => s.queuedMessageCount);
	const contextUsage = useSessionStore(s => s.contextUsage);
	const cwd = useSessionStore(s => s.cwd);
	const steeringMode = useSettingsStore(s => s.steeringMode);
	const model = useModelStore(s => s.model);
	const thinkingLevel = useModelStore(s => s.thinkingLevel);
	const fastModeEnabled = useModelStore(s => s.fastModeEnabled);
	const fastModeActive = useModelStore(s => s.fastModeActive);
	const openModelPicker = useUiStore(s => s.openModelPicker);

	const [text, setText] = useState("");
	const [images, setImages] = useState<PastedImage[]>([]);
	const [mode, setMode] = useState<SendMode>("prompt");
	const [menu, setMenu] = useState<{ kind: "command" | "mention"; index: number } | null>(null);
	const [commands, setCommands] = useState<AvailableCommand[]>([]);
	const [sending, setSending] = useState(false);
	const [mentions, setMentions] = useState<MentionEntry[]>([]);
	const [filePaths, setFilePaths] = useState<string[]>([]);
	const [historySearchOpen, setHistorySearchOpen] = useState(false);

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

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

	// Keep slash commands current across sidecar startup and extension reloads.
	useEffect(() => {
		let cancelled = false;
		const unsubscribe = window.omp.events.onCommandsUpdate(next => {
			if (!cancelled) setCommands(next);
		});
		if (status === "ready") {
			void window.omp.rpc.getAvailableCommands().then(res => {
				if (cancelled || !res.success) return;
				const data = res.data as { commands?: AvailableCommand[] } | undefined;
				setCommands(data?.commands ?? []);
			});
		}
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [status]);

	// Auto-grow the textarea to fit its content (up to ~40% of the viewport).
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "0px";
		const maxHeight = text.length === 0 ? 24 : window.innerHeight * 0.4;
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
	}, [text]);

	// Derive menu state from the draft text around the caret.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			setMenu(null);
			return;
		}
		const before = text.slice(0, el.selectionStart ?? text.length);
		if (/(^|\s)\/([a-z-]*)$/i.test(before)) {
			setMentions([]);
			setMenu({ kind: "command", index: 0 });
			return;
		}
		const mentionMatch = /(^|\s)@([\w./-]*)$/.exec(before);
		if (mentionMatch) {
			const q = mentionMatch[2];
			const entries: MentionEntry[] = [];
			// Workspace files first: subsequence fuzzy match, density-ranked, capped.
			const scored: { path: string; score: number }[] = [];
			for (const path of filePaths) {
				const score = fuzzyScore(q, path);
				if (score !== null) scored.push({ path, score });
			}
			scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
			for (const { path } of scored.slice(0, MAX_MENTION_FILE_ITEMS)) {
				entries.push({ path, label: path, insert: `@${path} ` });
			}
			// Internal URL schemes below the file results.
			const lowerQuery = q.toLowerCase();
			for (const scheme of MENTION_SCHEMES) {
				if (scheme.toLowerCase().includes(lowerQuery)) entries.push({ path: scheme, label: scheme, insert: scheme });
			}
			setMentions(entries);
			setMenu(entries.length > 0 ? { kind: "mention", index: 0 } : null);
			return;
		}
		setMenu(null);
	}, [text, filePaths]);

	// Reset the mention file list when the session cwd changes (cache is per-cwd).
	useEffect(() => {
		setFilePaths(mentionFileCache.get(cwd) ?? []);
	}, [cwd]);

	// Lazy-load workspace files for @mention completion: debounced so a fleeting
	// "@" doesn't trigger the walk, then cached per cwd for instant filtering.
	useEffect(() => {
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
	}, [text, cwd]);

	useEffect(() => {
		const onInsertMention = (event: Event) => {
			const path = (event as CustomEvent<{ path?: string }>).detail?.path;
			if (!path) return;
			setText(current => `${current}${current && !current.endsWith(" ") ? " " : ""}@${path} `);
			requestAnimationFrame(() => textareaRef.current?.focus());
		};
		window.addEventListener("omp:insert-mention", onInsertMention);
		return () => window.removeEventListener("omp:insert-mention", onInsertMention);
	}, []);

	useEffect(() => {
		const fillComposer = (event: Event) => {
			const detail = (event as CustomEvent<{ text?: string; images?: ImageContent[]; prepend?: boolean }>).detail;
			const next = detail?.text;
			const restoredImages = detail?.images ?? [];
			if (!next && restoredImages.length === 0) return;
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
	}, []);

	const filteredCommands = useMemo(() => {
		if (menu?.kind !== "command") return [];
		const match = /(?:^|\s)\/([a-z-]*)$/i.exec(text.slice(0, textareaRef.current?.selectionStart ?? text.length));
		const query = match?.[1]?.toLowerCase() ?? "";
		return commands
			.filter(command => {
				if (!query) return true;
				return (
					command.name.toLowerCase().includes(query) ||
					command.aliases?.some(alias => alias.toLowerCase().includes(query))
				);
			})
			.slice(0, MAX_MENU_ITEMS);
	}, [commands, menu?.kind, text]);

	const insertCompletion = useCallback(
		(insert: string) => {
			const el = textareaRef.current;
			if (!el) return;
			const pos = el.selectionStart ?? text.length;
			const before = text.slice(0, pos);
			const after = text.slice(pos);
			const replaced = before.replace(/(?:^|\s)[@/][\w./-]*$/, m => {
				const lead = m.startsWith(" ") ? " " : "";
				return `${lead}${insert}`;
			});
			setText(`${replaced}${after}`);
			setMenu(null);
			requestAnimationFrame(() => {
				el.focus();
				const newPos = replaced.length;
				el.setSelectionRange(newPos, newPos);
			});
		},
		[text],
	);

	const send = useCallback(() => {
		const message = text.trim();
		if ((!message && images.length === 0) || sending) return;
		if (status !== "ready") {
			toast({ variant: "warning", message: t("input.agentConnecting") });
			return;
		}

		const parsed = parseComposerMode(message);
		if (parsed?.mode === "bash" && parsed.body) {
			useInputHistoryStore.getState().record(message);
			setSending(true);
			void window.omp.rpc
				.bash(parsed.body)
				.then(async response => {
					if (!response.success) {
						toast({ variant: "error", title: t("input.bashFailed"), message: response.error });
						return;
					}
					setText("");
					setImages([]);
					setMenu(null);
					await hydrateSession();
				})
				.catch(error => {
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
					useMessagesStore.getState().removeMessage(pending);
					if (!response.success) {
						toast({ variant: "error", title: t("input.evalFailed"), message: response.error });
						return;
					}
					setText("");
					setImages([]);
					setMenu(null);
					await hydrateSession();
				})
				.catch(error => {
					useMessagesStore.getState().removeMessage(pending);
					toast({ variant: "error", title: t("input.evalFailed"), message: String(error) });
				})
				.finally(() => setSending(false));
			return;
		}

		useInputHistoryStore.getState().record(message);

		const payload = images.map(image => image.content);
		const request = isStreaming
			? mode === "followUp"
				? window.omp.rpc.followUp(message, payload)
				: window.omp.rpc.steer(message, payload)
			: window.omp.rpc.prompt(message, payload);
		const previousImages = images;
		setText("");
		setImages([]);
		setMenu(null);
		void request
			.then(response => {
				if (response.success) return;
				setText(current => (current ? `${message}\n${current}` : message));
				setImages(current => [...previousImages, ...current]);
				toast({ variant: "error", title: t("input.sendFailed"), message: response.error });
			})
			.catch(error => {
				setText(current => (current ? `${message}\n${current}` : message));
				setImages(current => [...previousImages, ...current]);
				toast({ variant: "error", title: t("input.sendFailed"), message: String(error) });
			});
	}, [text, images, sending, status, isStreaming, mode, t]);

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (menu) {
			const count = menu.kind === "command" ? filteredCommands.length : mentions.length;
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
				if (menu.kind === "command") {
					const cmd = filteredCommands[menu.index];
					if (cmd) insertCompletion(`/${cmd.name} `);
				} else {
					const entry = mentions[menu.index];
					if (entry) insertCompletion(entry.insert);
				}
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
			send();
		}
	};

	const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(e.clipboardData.files).filter(f => f.type.startsWith("image/"));
		if (files.length === 0) return;
		e.preventDefault();
		void Promise.all(files.map(fileToImage)).then(pasted => setImages(prev => [...prev, ...pasted]));
	};

	const modeLabel = isStreaming
		? mode === "followUp"
			? t("input.followUp")
			: t("input.steer")
		: t("input.sendLabel");
	const modeTitle = isStreaming ? t("input.streamingTitle", { mode: steeringMode }) : t("input.sendPrompt");

	return (
		<div className="relative shrink-0 bg-[var(--omp-bg-primary)] px-6 pb-5 pt-3">
			<div className="relative mx-auto w-full max-w-[900px]">
				{menu && (
					<div className="absolute bottom-full left-0 z-10 mb-2 max-h-[60vh] w-[420px] max-w-full overflow-y-auto rounded-xl border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] p-1 shadow-[var(--omp-shadow-lg)]">
						{menu.kind === "command"
							? filteredCommands.map((command, index) => (
									<button
										key={command.name}
										type="button"
										onMouseDown={event => {
											event.preventDefault();
											insertCompletion(`/${command.name} `);
										}}
										className={cx(
											"flex w-full items-baseline gap-3 rounded-lg px-3 py-2.5 text-left",
											index === menu.index ? "bg-[var(--omp-selected-bg)]" : "",
										)}
									>
										<span className="font-mono text-[13px] font-medium text-[var(--omp-accent)]">
											/{command.name}
										</span>
										<span className="truncate text-[12px] text-[var(--omp-muted)]">
											{command.description}
										</span>
									</button>
								))
							: mentions.map((entry, index) => (
									<button
										key={entry.path}
										type="button"
										onMouseDown={event => {
											event.preventDefault();
											insertCompletion(entry.insert);
										}}
										className={cx(
											"flex w-full items-center rounded-lg px-3 py-2.5 text-left font-mono text-[13px]",
											index === menu.index
												? "bg-[var(--omp-selected-bg)] text-[var(--omp-text)]"
												: "text-[var(--omp-muted)]",
										)}
									>
										<span className="truncate">{entry.label}</span>
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

				{queuedMessageCount > 0 && (
					<div className="mb-2 flex items-center gap-2 px-1 text-[12px] font-medium text-[var(--omp-warning)]">
						<span className="h-2 w-2 animate-pulse rounded-full bg-[var(--omp-warning)]" />
						{t("input.queued", { count: queuedMessageCount, plural: queuedMessageCount > 1 ? "s" : "" })}
					</div>
				)}

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
								setText(event.target.value);
							}}
							onKeyDown={handleKeyDown}
							onPaste={handlePaste}
							rows={2}
							placeholder={
								status !== "ready"
									? t("input.placeholder.connecting")
									: isStreaming
										? t("input.placeholder.streaming")
										: t("input.placeholder.idle")
							}
							className="max-h-[40vh] min-h-[44px] w-full resize-none bg-transparent text-[14.5px] leading-[1.5] text-[var(--omp-text)] outline-none placeholder:text-[var(--omp-dim)]"
						/>
					</div>

					<div className="flex min-h-10 flex-wrap items-center gap-1 border-t border-[var(--omp-border-muted)] px-2 py-1.5">
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

						<button
							type="button"
							onClick={() => void window.omp.rpc.cycleThinkingLevel()}
							title={t("input.thinking", { level: thinkingLevel ?? "off" })}
							className="omp-pressable flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium hover:bg-[var(--omp-selected-bg)]"
							style={{ color: `var(--omp-thinking-${thinkingLevel ?? "off"})` }}
						>
							<Brain size={14} />
							<span className="hidden sm:inline">{thinkingLevel ?? "off"}</span>
						</button>

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

						<ApprovalControl />
						<ComposerModes />

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

						{isStreaming ? (
							<div className="flex shrink-0 items-center gap-1.5">
								<button
									type="button"
									onClick={() => setMode(current => (current === "followUp" ? "steer" : "followUp"))}
									title={modeTitle}
									className="omp-pressable h-8 rounded-lg border border-[var(--omp-border)] bg-[var(--omp-bg-primary)] px-3 text-[12px] font-medium text-[var(--omp-muted)] hover:border-[var(--omp-border-strong)] hover:text-[var(--omp-text)]"
								>
									{modeLabel}
								</button>
								<button
									type="button"
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
								onClick={send}
								disabled={status !== "ready" || sending || (!text.trim() && images.length === 0)}
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
