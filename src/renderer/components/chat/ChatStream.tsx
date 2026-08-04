import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Bug, Code2, Loader2, SearchCode, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PiLogo } from "../common";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { type ToolEntry, useToolsStore } from "../../stores/tools";
import { ToolCard } from "../tools/ToolCard";
import { MessageBubble } from "./MessageBubble";
import { StreamingText } from "./StreamingText";
import { ThinkingBlock } from "./ThinkingBlock";

/** Virtualized row: a finalized message, or one of the live streaming rows. */
type Row = { kind: "message"; message: AgentMessage } | { kind: "streaming" };

/**
 * Virtual-scroll message list. Stays pinned to the bottom while streaming
 * unless the user scrolls up; a floating "jump to latest" button appears when
 * unpinned. The in-flight assistant turn renders as live rows (thinking,
 * tool cards, streaming text) that unmount once message_end finalizes.
 */
export function ChatStream() {
	const t = useT();
	const messages = useMessagesStore(s => s.messages);
	const streamingMessage = useMessagesStore(s => s.streamingMessage);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const status = useSessionStore(s => s.status);

	const hasStreaming = streamingMessage != null;

	const rows: Row[] = [];
	for (const message of messages) rows.push({ kind: "message", message });
	if (hasStreaming) rows.push({ kind: "streaming" });

	const parentRef = useRef<HTMLDivElement>(null);
	const [pinned, setPinned] = useState(true);

	const STARTERS = [
		{ icon: Code2, title: t("chat.starter.understand.title"), prompt: t("chat.starter.understand.prompt") },
		{ icon: Bug, title: t("chat.starter.fix.title"), prompt: t("chat.starter.fix.prompt") },
		{ icon: Sparkles, title: t("chat.starter.build.title"), prompt: t("chat.starter.build.prompt") },
		{ icon: SearchCode, title: t("chat.starter.review.title"), prompt: t("chat.starter.review.prompt") },
	] as const;

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => parentRef.current,
		estimateSize: i => (rows[i]?.kind === "streaming" ? 96 : 128),
		overscan: 8,
		measureElement: el => el.getBoundingClientRect().height,
	});

	// Pin to bottom whenever new content arrives and the user hasn't scrolled away.
	useEffect(() => {
		if (!pinned) return;
		virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
	}, [virtualizer, rows.length, pinned]);

	const handleScroll = useCallback(() => {
		const el = parentRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		setPinned(distanceFromBottom < 80);
	}, []);

	const jumpToLatest = useCallback(() => {
		setPinned(true);
		virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
	}, [virtualizer, rows.length]);

	// Messages hydrate via hydrateSession (use-rpc-events) on sidecar ready —
	// no separate fetch here (that would double-download the transcript).

	return (
		<div className="relative min-h-0 flex-1 bg-[var(--omp-bg-primary)]">
			<div
				ref={parentRef}
				onScroll={handleScroll}
				className="h-full overflow-y-auto overscroll-contain"
			>
				{status === "starting" && (
					<div className="flex justify-center py-3">
						<Loader2 size={16} className="animate-spin text-[var(--omp-muted)]" />
					</div>
				)}
				{rows.length === 0 && !isStreaming && (
					<div className="omp-empty-canvas mx-auto flex min-h-full w-full max-w-[900px] flex-col justify-center px-6 pb-20">
						<div className="omp-empty-logo mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--omp-btn-primary-bg)] text-[var(--omp-btn-primary-text)]">
							<PiLogo size={22} />
						</div>
						<h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-0.025em] text-[var(--omp-text)]">
							{t("chat.empty.title")}
						</h1>
						<p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-[var(--omp-muted)]">
							{t("chat.empty.subtitle")}
						</p>
						<div className="omp-starter-grid mt-8 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
							{STARTERS.map(({ icon: Icon, title, prompt }) => (
								<button
									key={title}
									type="button"
									onClick={() =>
										window.dispatchEvent(new CustomEvent("omp:fill-composer", { detail: { text: prompt } }))
									}
									className="omp-starter-card omp-lift group flex min-h-20 items-start gap-3 rounded-2xl border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] p-4 text-left shadow-[var(--omp-shadow-sm)] hover:border-[var(--omp-border-accent)] hover:bg-[var(--omp-bg-secondary)]"
								>
									<span className="omp-starter-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--omp-selected-bg)] text-[var(--omp-accent)]">
										<Icon size={17} />
									</span>
									<span>
										<span className="block text-[14px] font-semibold text-[var(--omp-text)]">{title}</span>
										<span className="mt-1 block text-[13px] leading-snug text-[var(--omp-muted)]">
											{prompt}
										</span>
									</span>
								</button>
							))}
						</div>
					</div>
				)}
				<div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
					{virtualizer.getVirtualItems().map(item => {
						const row = rows[item.index];
						if (!row) return null;
						return (
							<div
								key={row.kind === "message" ? `msg-${item.index}` : "streaming"}
								data-index={item.index}
								ref={virtualizer.measureElement}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${item.start}px)`,
								}}
							>
								<div className="mx-auto w-full max-w-[900px]">
									{row.kind === "message" ? <MessageBubble message={row.message} /> : <StreamingRows />}
								</div>
							</div>
						);
					})}
				</div>
			</div>
			<button
				type="button"
				onClick={jumpToLatest}
				aria-label={t("chat.jumpToLatest")}
				className={cx(
					"absolute bottom-5 left-1/2 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-4 text-[12px] font-medium text-[var(--omp-text)] shadow-[var(--omp-shadow-md)] transition-all hover:bg-[var(--omp-selected-bg)]",
					pinned ? "pointer-events-none translate-y-12 opacity-0" : "translate-y-0 opacity-100",
				)}
			>
				<ArrowDown size={14} />
				{t("chat.jumpToLatest")}
			</button>
		</div>
	);
}

/**
 * The in-flight assistant turn: thinking block, any tool calls already
 * emitted, and the live text tail. Replaces itself with a finalized
 * MessageBubble on message_end.
 */
function StreamingRows() {
	const streamingMessage = useMessagesStore(s => s.streamingMessage);
	const streamingThinking = useMessagesStore(s => s.streamingThinking);
	const activeTools = useToolsStore(s => s.activeTools);
	if (!streamingMessage) return null;
	const content = Array.isArray(streamingMessage.content) ? streamingMessage.content : [];
	const toolCalls = content.filter(block => block.type === "toolCall");

	// streamingMessage.content only fills at message_end; mid-stream the live
	// tool calls accumulate in the tools store (toolcall_delta → pending while
	// args stream, tool_execution_start → running). Render those store entries
	// as live cards; on message_end this row unmounts and MessageBubble takes
	// over with the same toolCallIds. Entries from before this stream started
	// (hydrated history that never finished) are excluded by start time.
	const ts = streamingMessage.timestamp;
	const parsed = typeof ts === "number" ? ts : typeof ts === "string" ? Date.parse(ts) : Number.NaN;
	const streamStart = Number.isFinite(parsed) ? parsed : 0;
	const contentIds = new Set(toolCalls.map(block => (block.type === "toolCall" ? block.id : "")));
	const liveTools: Array<{ id: string; entry: ToolEntry }> = [];
	for (const [id, entry] of activeTools) {
		if (contentIds.has(id)) continue;
		if (entry.status !== "pending" && entry.status !== "running") continue;
		if (entry.startTime < streamStart) continue;
		liveTools.push({ id, entry });
	}

	return (
		<div className="flex flex-col px-6 py-4">
			{/* streamingMessage.content only fills at message_end; mid-stream the
			    thinking deltas accumulate in the streamingThinking buffer, which
			    ThinkingBlock reads itself when live. */}
			{streamingThinking ? <ThinkingBlock live /> : null}
			<div className="space-y-2">
				{toolCalls.map(block =>
					block.type === "toolCall" ? (
						<ToolCard key={block.id} toolCallId={block.id} toolName={block.name} args={block.arguments} />
					) : null,
				)}
				{liveTools.map(({ id, entry }) => (
					<ToolCard key={id} toolCallId={id} toolName={entry.toolName} args={entry.args} />
				))}
				<StreamingText />
			</div>
		</div>
	);
}
