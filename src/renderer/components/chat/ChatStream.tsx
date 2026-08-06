import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Bug, ChevronRight, Code2, Loader2, SearchCode, Sparkles, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentMessage, MessageContent, RpcQueuedMessage } from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isRenderableMessageText } from "../../lib/messages";
import { collapsibleReadTarget, groupReadRows, type ReadGroupEntry, type ReadGroupUsage } from "../../lib/read-group";
import { useMessagesStore } from "../../stores/messages";
import { type QueueLane, useQueuedMessages } from "../../stores/queue";
import { useSessionStore } from "../../stores/session";
import { useSettingsStore } from "../../stores/settings";
import { toast } from "../../stores/toast";
import { type ToolEntry, toolEntryKey, useToolsStore } from "../../stores/tools";
import { type TranscriptDetail, useUiStore } from "../../stores/ui";
import { PiLogo } from "../common";
import { ReadGroupCard } from "../tools/ReadGroupCard";
import { ToolCard } from "../tools/ToolCard";
import { MessageBubble } from "./MessageBubble";
import { StreamingText } from "./StreamingText";
import { ThinkingBlock } from "./ThinkingBlock";

interface ProcessMeta {
	stepCount: number;
	toolCallIds: string[];
	toolNames: string[];
}

export type HistoryRow =
	| { kind: "message"; message: AgentMessage }
	| { kind: "readGroup"; entries: ReadGroupEntry[]; usage?: ReadGroupUsage[] }
	| ({ kind: "process"; messages: AgentMessage[] } & ProcessMeta);

/** Virtualized row: finalized history or one of the live streaming rows. */
type Row =
	| HistoryRow
	| { kind: "streaming" }
	| { kind: "pending" }
	| { kind: "expander"; count: number }
	| { kind: "queued"; item: RpcQueuedMessage; lane: QueueLane };

function messageContent(message: AgentMessage): MessageContent[] {
	if (Array.isArray(message.content)) return message.content;
	if (typeof message.content === "string") return [{ type: "text", text: message.content }];
	return [];
}

/**
 * Keep zero-height/non-display messages out of the virtualizer. Estimating an
 * invisible toolResult row at 128px was the remaining source of blank bands
 * between cards; its content already lives in the matching ToolCard.
 */
function isVisibleTranscriptMessage(message: AgentMessage): boolean {
	if (message.role === "toolResult") return false;
	if ((message.role === "custom" || message.role === "hookMessage") && message.display === false) return false;
	if (
		message.role === "user" ||
		message.role === "bashExecution" ||
		message.role === "pythonExecution" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary" ||
		message.role === "fileMention" ||
		message.role === "custom" ||
		message.role === "hookMessage"
	) {
		return true;
	}
	if (message.errorMessage || message.steering) return true;
	return messageContent(message).some(block => {
		switch (block.type) {
			case "text":
				return isRenderableMessageText(block.text);
			case "thinking":
				return isRenderableMessageText(block.thinking);
			case "toolCall":
			case "image":
				return true;
		}
		return false;
	});
}

function summarizeProcess(messages: AgentMessage[]): ProcessMeta {
	let thinkingCount = 0;
	const toolCallIds: string[] = [];
	const toolNames: string[] = [];
	for (const message of messages) {
		for (const block of messageContent(message)) {
			if (block.type === "thinking" && isRenderableMessageText(block.thinking)) thinkingCount++;
			if (block.type !== "toolCall") continue;
			toolCallIds.push(toolEntryKey(block));
			toolNames.push(block.name);
		}
	}
	return { stepCount: thinkingCount + toolCallIds.length, toolCallIds, toolNames };
}

/**
 * Build finalized transcript rows. Compact mode folds a run's reasoning and
 * tool-call messages into one disclosure while preserving the final answer.
 * A final assistant message containing both thinking and text is split: only
 * the thinking fragment joins the process row.
 */
export function buildHistoryRows(messages: AgentMessage[], detail: TranscriptDetail): HistoryRow[] {
	const rows: HistoryRow[] = [];
	let processMessages: AgentMessage[] = [];
	const flushProcess = () => {
		if (processMessages.length === 0) return;
		rows.push({ kind: "process", messages: processMessages, ...summarizeProcess(processMessages) });
		processMessages = [];
	};

	for (const message of messages) {
		// toolResult/display:false/empty-filler messages must not split a process
		// run — they are invisible transport records, not transcript boundaries.
		if (!isVisibleTranscriptMessage(message)) continue;
		if (
			detail !== "compact" ||
			message.role !== "assistant" ||
			message.errorMessage ||
			message.steering ||
			!Array.isArray(message.content)
		) {
			flushProcess();
			rows.push({ kind: "message", message });
			continue;
		}

		const hasToolCall = message.content.some(block => block.type === "toolCall");
		const hasImage = message.content.some(block => block.type === "image");
		if (hasToolCall && !hasImage) {
			// Text accompanying a tool call is intermediate narration; the API
			// delivers the final answer in a later assistant message.
			processMessages.push(message);
			continue;
		}

		const thinking = message.content.filter(
			block => block.type === "thinking" && isRenderableMessageText(block.thinking),
		);
		if (thinking.length > 0) {
			processMessages.push({ ...message, content: thinking });
			const coreMessage: AgentMessage = {
				...message,
				content: message.content.filter(block => block.type !== "thinking"),
			};
			if (isVisibleTranscriptMessage(coreMessage)) {
				flushProcess();
				rows.push({ kind: "message", message: coreMessage });
			}
			continue;
		}

		flushProcess();
		rows.push({ kind: "message", message });
	}
	flushProcess();
	return rows;
}

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
	const streamingTextLen = useMessagesStore(s => s.streamingText.length);
	const streamingThinkingLen = useMessagesStore(s => s.streamingThinking.length);
	const isStreaming = useSessionStore(s => s.isStreaming);
	const awaitingModelSince = useSessionStore(s => s.awaitingModelSince);
	const retryInfo = useSessionStore(s => s.retryInfo);
	const compactionInfo = useSessionStore(s => s.compactionInfo);
	const status = useSessionStore(s => s.status);
	const sessionId = useSessionStore(s => s.sessionId);
	// Shared agent compaction preference and GUI-local transcript detail.
	const collapseCompacted = useSettingsStore(s => s.collapseCompacted);
	const transcriptDetail = useUiStore(s => s.transcriptDetail);
	const [preCompactionOpen, setPreCompactionOpen] = useState(false);
	useEffect(() => {
		// Session identity is the reset signal; process/history rows below are
		// rebuilt from the new transcript in the same render cycle.
		void sessionId;
		setPreCompactionOpen(false);
	}, [sessionId]);

	const lastCompactionIndex = messages.findLastIndex(message => message.role === "compactionSummary");
	const hiddenCount = collapseCompacted && !preCompactionOpen && lastCompactionIndex > 0 ? lastCompactionIndex : 0;
	const historyRows = useMemo(() => {
		const built = buildHistoryRows(hiddenCount > 0 ? messages.slice(hiddenCount) : messages, transcriptDetail);
		// Read-tool grouping (TUI parity) folds consecutive collapsible reads into
		// one card — only in full mode; compact mode's ProcessGroup already folds
		// ALL consecutive tool work, so a second fold would nest redundantly.
		return transcriptDetail === "compact" ? built : groupReadRows(built);
	}, [messages, hiddenCount, transcriptDetail]);

	// The assistant message exists as an empty shell from message_start until
	// the first delta — only real content swaps the status row for the
	// streaming rows, so the shell window never reads as dead air.
	const streamingContent = streamingMessage?.content;
	const hasStreamedContent =
		streamingMessage != null &&
		(streamingTextLen > 0 ||
			streamingThinkingLen > 0 ||
			(Array.isArray(streamingContent) && streamingContent.length > 0));

	// One status row for every "agent busy but nothing visible" window,
	// mirroring the TUI's loader line: auto-retry delay/attempt (warning),
	// auto-compaction maintenance, or waiting on the model's first event.
	// Priority matches the TUI, whose transient loaders replace the working
	// loader; tool-execution windows show running tool cards instead.
	const showStatusRow =
		retryInfo != null || compactionInfo != null || (isStreaming && awaitingModelSince != null && !hasStreamedContent);

	// Pending queue bubbles tail the stream in delivery order (steering
	// interrupts first, follow-ups after) — the future user turns, deletable
	// in place via queue_remove.
	const queued = useQueuedMessages();

	const rows: Row[] = [];
	if (hiddenCount > 0) rows.push({ kind: "expander", count: hiddenCount });
	rows.push(...historyRows);
	if (hasStreamedContent) rows.push({ kind: "streaming" });
	if (showStatusRow) rows.push({ kind: "pending" });
	for (const item of queued.steering) rows.push({ kind: "queued", item, lane: "steering" });
	for (const item of queued.followUp) rows.push({ kind: "queued", item, lane: "followUp" });

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
		estimateSize: i =>
			rows[i]?.kind === "streaming"
				? 96
				: rows[i]?.kind === "pending" || rows[i]?.kind === "queued"
					? 56
					: rows[i]?.kind === "expander" || rows[i]?.kind === "process"
						? 44
						: 128,
		overscan: 8,
		measureElement: el => el.getBoundingClientRect().height,
	});

	// Pin to bottom whenever new content arrives and the user hasn't scrolled away.
	// `rows.length` alone misses the growth the virtualizer renders inside a
	// constant row count: the streaming row's text/thinking accumulate, and the
	// final `message_end` swap keeps the count at one while its content lands.
	// The delta-length selectors re-fire the effect so those also snap back to
	// the bottom while pinned.
	useEffect(() => {
		if (!pinned) return;
		// Read the delta lengths so biome sees them used; they are the trigger
		// signal that re-fires this effect as the streaming row grows.
		void streamingTextLen;
		void streamingThinkingLen;
		virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
	}, [virtualizer, rows.length, pinned, streamingTextLen, streamingThinkingLen]);

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
			<div ref={parentRef} onScroll={handleScroll} className="h-full overflow-y-auto overscroll-contain">
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
								key={
									row.kind === "queued"
										? `queued-${row.item.id}`
										: row.kind === "message"
											? `msg-${item.index}`
											: `${row.kind}-${item.index}`
								}
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
									{row.kind === "message" ? (
										<MessageBubble message={row.message} />
									) : row.kind === "readGroup" ? (
										<ReadGroupCard entries={row.entries} usage={row.usage} />
									) : row.kind === "process" ? (
										<ProcessGroup row={row} />
									) : row.kind === "streaming" ? (
										<StreamingRows />
									) : row.kind === "queued" ? (
										<QueuedMessageBubble item={row.item} lane={row.lane} />
									) : row.kind === "expander" ? (
										<button
											type="button"
											onClick={() => setPreCompactionOpen(true)}
											className="omp-pressable mx-6 my-2 flex items-center gap-2 rounded-lg border border-[var(--omp-border)] bg-[var(--omp-bg-secondary)] px-3 py-1.5 text-[11.5px] font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
										>
											{t("chat.compaction.showEarlier", { count: row.count })}
										</button>
									) : (
										<TurnStatusRow />
									)}
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

function ProcessDisclosure({
	meta,
	live = false,
	inset = true,
	children,
}: {
	meta: ProcessMeta;
	live?: boolean;
	inset?: boolean;
	children: ReactNode;
}) {
	const t = useT();
	const activeTools = useToolsStore(s => s.activeTools);
	const [open, setOpen] = useState(false);
	const toolCounts = new Map<string, number>();
	for (const name of meta.toolNames) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
	const toolEntries = [...toolCounts.entries()];
	const visibleTools = toolEntries
		.slice(0, 4)
		.map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
		.join(" · ");
	const hiddenToolCount = Math.max(0, toolEntries.length - 4);
	const toolSummary =
		visibleTools.length > 0
			? `${visibleTools}${hiddenToolCount > 0 ? ` · +${hiddenToolCount}` : ""}`
			: t("chat.process.reasoning");
	let failedCount = 0;
	for (const id of meta.toolCallIds) {
		const entry = activeTools.get(id);
		if (entry?.isError || entry?.status === "error") failedCount++;
	}
	const label = t(live ? "chat.process.running" : "chat.process.summary", {
		count: meta.stepCount,
		plural: meta.stepCount === 1 ? "" : "s",
	});

	return (
		<div className="py-1.5">
			<div className={inset ? "px-6" : undefined}>
				<button
					aria-expanded={open}
					className="omp-pressable flex w-full items-center gap-2 rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] px-3 py-2 text-left text-[12px] text-[var(--omp-muted)] hover:border-[var(--omp-border)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
					onClick={() => setOpen(value => !value)}
					type="button"
				>
					<ChevronRight
						aria-hidden
						className={cx("shrink-0 transition-transform", open && "rotate-90")}
						size={14}
					/>
					{live ? (
						<Loader2 aria-hidden className="shrink-0 animate-spin text-[var(--omp-accent)]" size={13} />
					) : (
						<Sparkles aria-hidden className="shrink-0 text-[var(--omp-accent)]" size={13} />
					)}
					<span className="shrink-0 font-medium text-[var(--omp-text)]">{label}</span>
					<span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[var(--omp-dim)]">
						{toolSummary}
					</span>
					{failedCount > 0 && (
						<span className="shrink-0 text-[11px] font-medium text-[var(--omp-error)]">
							{t("chat.process.failed", { count: failedCount })}
						</span>
					)}
				</button>
			</div>
			{open ? <div className="mt-1">{children}</div> : null}
		</div>
	);
}

function ProcessGroup({ row }: { row: Extract<HistoryRow, { kind: "process" }> }) {
	return (
		<ProcessDisclosure meta={row}>
			{row.messages.map((message, index) => (
				<MessageBubble
					compact
					key={typeof message.id === "string" ? message.id : `${String(message.timestamp ?? "process")}-${index}`}
					message={message}
				/>
			))}
		</ProcessDisclosure>
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
	const transcriptDetail = useUiStore(s => s.transcriptDetail);
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
	const contentIds = new Set(toolCalls.map(block => toolEntryKey(block)));
	const liveTools: Array<{ id: string; entry: ToolEntry }> = [];
	for (const [id, entry] of activeTools) {
		if (contentIds.has(id)) continue;
		if (entry.status !== "pending" && entry.status !== "running") continue;
		if (entry.startTime < streamStart) continue;
		liveTools.push({ id, entry });
	}

	const hasThinking = isRenderableMessageText(streamingThinking);
	const hasProcess = hasThinking || toolCalls.length > 0 || liveTools.length > 0;
	const processMeta: ProcessMeta = {
		stepCount: (hasThinking ? 1 : 0) + toolCalls.length + liveTools.length,
		toolCallIds: [...toolCalls.map(block => toolEntryKey(block)), ...liveTools.map(({ id }) => id)],
		toolNames: [...toolCalls.map(block => block.name), ...liveTools.map(({ entry }) => entry.toolName)],
	};

	// Live read grouping (same predicate as the finalized path): consecutive
	// collapsible reads fold into one ReadGroupCard even mid-turn. Compact
	// detail keeps plain cards — ProcessDisclosure already folds them.
	const allCards: Array<{ id: string; name: string; args: Record<string, unknown> }> = [
		...toolCalls.map(block => ({
			id: toolEntryKey(block),
			name: block.name,
			args: block.arguments as Record<string, unknown>,
		})),
		...liveTools.map(({ id, entry }) => ({ id, name: entry.toolName, args: entry.args as Record<string, unknown> })),
	];
	const groupedLiveCards = (() => {
		if (transcriptDetail === "compact") return null;
		const segments: Array<
			{ type: "group"; entries: ReadGroupEntry[] } | { type: "card"; card: (typeof allCards)[number] }
		> = [];
		let run: ReadGroupEntry[] = [];
		const flush = () => {
			if (run.length > 0) {
				segments.push({ type: "group", entries: run });
				run = [];
			}
		};
		for (const card of allCards) {
			const read = card.name === "read" ? collapsibleReadTarget(card.args) : null;
			if (read) {
				run.push({ callId: card.id, toolKey: card.id, ...read, args: card.args });
				continue;
			}
			flush();
			segments.push({ type: "card", card });
		}
		flush();
		// Grouping only pays when at least one group holds 2+ reads.
		if (!segments.some(segment => segment.type === "group" && segment.entries.length > 1)) return null;
		return segments.map((segment, index) =>
			segment.type === "group" ? (
				<ReadGroupCard inset key={`rg-${segment.entries[0]?.callId ?? index}`} entries={segment.entries} />
			) : (
				<ToolCard
					key={segment.card.id}
					toolCallId={segment.card.id}
					toolName={segment.card.name}
					args={segment.card.args}
				/>
			),
		);
	})();

	const toolCards = groupedLiveCards ?? (
		<>
			{toolCalls.map(block => (
				<ToolCard key={block.id} toolCallId={block.id} toolName={block.name} args={block.arguments} />
			))}
			{liveTools.map(({ id, entry }) => (
				<ToolCard key={id} toolCallId={id} toolName={entry.toolName} args={entry.args} />
			))}
		</>
	);

	if (transcriptDetail === "full") {
		return (
			<div className="flex flex-col px-6 py-4">
				{/* streamingMessage.content only fills at message_end; mid-stream the
				    thinking deltas accumulate in the streamingThinking buffer, which
				    ThinkingBlock reads itself when live. */}
				{hasThinking ? <ThinkingBlock live /> : null}
				<div className="space-y-2">
					{toolCards}
					<StreamingText />
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col px-6 py-2">
			{hasProcess ? (
				<ProcessDisclosure inset={false} live meta={processMeta}>
					{hasThinking ? <ThinkingBlock live /> : null}
					{toolCalls.length + liveTools.length > 0 ? <div className="space-y-2">{toolCards}</div> : null}
				</ProcessDisclosure>
			) : null}
			<div className={hasProcess ? "mt-1" : undefined}>
				<StreamingText />
			</div>
		</div>
	);
}

/** Seconds past which the waiting row escalates to the slow-response hint. */
const SLOW_RESPONSE_HINT_SECONDS = 30;
/**
 * Seconds past which the row escalates again to the stalled-connection hint.
 * The provider first-event watchdog fires at ~300s (and auto-retry may
 * follow); telling the user that up front turns a silent 5-minute wait into
 * an informed one — they know it's still alive, why, and that Esc aborts now.
 */
const STALLED_RESPONSE_HINT_SECONDS = 90;

/**
 * Live status row for the windows where the agent is busy but the transcript
 * has nothing to show yet — the GUI counterpart of the TUI's loader line:
 *
 * - retry: `Retrying (a/b) in Ns…` warning spinner for the auto-retry
 *   delay/attempt window, plus the failure detail. Enhancement over the TUI:
 *   N counts down live instead of freezing at the initial delay.
 * - compaction: `{reason}{action}…` accent spinner for auto-maintenance,
 *   same reason/action vocabulary as the TUI loader.
 * - waiting: between turn_start and the first streamed event, with live
 *   elapsed seconds; past 30s a slow-response hint appears so a stalled
 *   provider reads as "slow but alive" rather than dead air.
 *
 * All variants carry the Esc interrupt hint (App routes Esc → rpc.abort),
 * matching the TUI's `[esc]` / `(esc to cancel)` suffixes.
 */
export function TurnStatusRow() {
	const t = useT();
	const retryInfo = useSessionStore(s => s.retryInfo);
	const compactionInfo = useSessionStore(s => s.compactionInfo);
	const awaitingModelSince = useSessionStore(s => s.awaitingModelSince);
	const now = Date.now();
	// 1s ticking clock shared by the countdown/elapsed variants.
	const [, setNowTick] = useState(0);
	useEffect(() => {
		const interval = setInterval(() => setNowTick(tick => tick + 1), 1000);
		return () => clearInterval(interval);
	}, []);

	let iconClass = "";
	let text: string;
	let detail: string | null = null;
	let slow = false;
	let stalled = false;

	if (retryInfo) {
		const remainingSeconds = Math.max(0, Math.ceil((retryInfo.startedAt + retryInfo.delayMs - now) / 1000));
		iconClass = "text-[var(--omp-warning)]";
		text =
			remainingSeconds > 0
				? t("chat.retry.pending", {
						attempt: retryInfo.attempt,
						maxAttempts: retryInfo.maxAttempts,
						seconds: remainingSeconds,
					})
				: t("chat.retry.inflight", { attempt: retryInfo.attempt, maxAttempts: retryInfo.maxAttempts });
		detail = retryInfo.errorMessage || null;
	} else if (compactionInfo) {
		const reason = compactionInfo.reason === "threshold" ? "" : t(`chat.compaction.reason.${compactionInfo.reason}`);
		const actionKey =
			compactionInfo.action === "handoff"
				? "chat.compaction.action.handoff"
				: compactionInfo.action === "shake"
					? "chat.compaction.action.shake"
					: compactionInfo.action === "snapcompact"
						? "chat.compaction.action.snapcompact"
						: "chat.compaction.action.default";
		iconClass = "text-[var(--omp-accent)]";
		text = `${reason}${t(actionKey)}…`;
	} else if (awaitingModelSince != null) {
		const elapsedSeconds = Math.max(0, Math.floor((now - awaitingModelSince) / 1000));
		slow = elapsedSeconds >= SLOW_RESPONSE_HINT_SECONDS;
		stalled = elapsedSeconds >= STALLED_RESPONSE_HINT_SECONDS;
		text = t("chat.awaitingModel", { seconds: elapsedSeconds });
	} else {
		return null;
	}

	return (
		<div className="omp-fade-in flex flex-col gap-1 px-6 py-4 text-[13px] text-[var(--omp-muted)]">
			<div className="flex items-center gap-2.5">
				<Loader2 size={14} className={cx("animate-spin shrink-0", iconClass)} />
				<span>{text}</span>
				{stalled ? (
					// The stalled hint already names Esc — drop the generic interrupt
					// hint so the line stays readable.
					<span className="text-[var(--omp-warning)]">{t("chat.awaitingModel.stalled")}</span>
				) : (
					<>
						<span className="text-[var(--omp-dim)]">{t("chat.interruptHint")}</span>
						{slow ? <span className="text-[var(--omp-warning)]">{t("chat.awaitingModel.slow")}</span> : null}
					</>
				)}
			</div>
			{detail ? (
				<div className="max-w-full truncate pl-[26px] text-[11.5px] text-[var(--omp-dim)]" title={detail}>
					{detail}
				</div>
			) : null}
		</div>
	);
}

/**
 * Grey pending bubble for one queued steer/follow-up message (queue_update
 * data source), rendered at the message-stream tail in delivery order —
 * steering (mid-run interrupt) first, then follow-ups. The × deletes the
 * entry via queue_remove; the queue_update frame the removal emits confirms
 * it (failure toasts and keeps the bubble).
 */
function QueuedMessageBubble({ item, lane }: { item: RpcQueuedMessage; lane: QueueLane }) {
	const t = useT();
	const [removing, setRemoving] = useState(false);

	const remove = async () => {
		setRemoving(true);
		const response = await window.omp.rpc.queueRemove(item.id);
		if (!response.success) {
			setRemoving(false);
			toast({ variant: "error", title: t("pendingBubble.removeFailed"), message: response.error });
		}
	};

	return (
		<div className="group flex justify-end px-6 py-1.5">
			<div className="flex max-w-[75%] items-start gap-2 rounded-xl border border-dashed border-[var(--omp-border)] bg-[var(--omp-bg-secondary)] px-3.5 py-2.5">
				<div className="min-w-0 flex-1">
					<div className="mb-0.5 text-[10px] font-semibold tracking-wide text-[var(--omp-dim)] uppercase">
						{t(lane === "steering" ? "pendingBubble.steering" : "pendingBubble.followUp")}
					</div>
					<div className="whitespace-pre-wrap break-words text-[13px] leading-snug text-[var(--omp-muted)]">
						{item.text || "…"}
					</div>
				</div>
				<button
					type="button"
					onClick={() => void remove()}
					disabled={removing}
					title={t("pendingBubble.remove")}
					className="omp-pressable -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-error)] disabled:opacity-50"
				>
					<X size={13} />
				</button>
			</div>
		</div>
	);
}
