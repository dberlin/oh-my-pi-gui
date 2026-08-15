import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ArrowDown,
	BookOpen,
	Bug,
	Check,
	ChevronRight,
	Code2,
	Languages,
	Lightbulb,
	ListTodo,
	Loader2,
	PenLine,
	Rocket,
	SearchCode,
	Sparkles,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SshSessionTarget } from "../../../shared/ipc-types";
import type { AgentMessage, RpcQueuedMessage, SidecarStatus, ToolCallContent } from "../../../shared/rpc-types";
import { cx, formatShortClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isRenderableMessageText } from "../../lib/messages";
import { collapsibleReadTarget, groupReadRows, type ReadGroupEntry, type ResolveToolCall } from "../../lib/read-group";
import { type QueueLane, useQueueStore } from "../../stores/queue";
import { toast } from "../../stores/toast";
import type { TodoSnapshot } from "../../stores/todo";
import { type ToolEntry, toolEntryKey } from "../../stores/tools";
import type { TranscriptDetail } from "../../stores/ui";
import { PiLogo } from "../common";
import { ReadGroupCard } from "../tools/ReadGroupCard";
import { ToolCard } from "../tools/ToolCard";
import { ConversationNavigator } from "./ConversationNavigator";
import {
	buildConversationAnchors,
	buildHistoryRows,
	buildTimelineMarkers,
	buildTranscriptRowKeys,
	findConversationAnchorIndex,
	type HistoryRow,
	hasStreamingTranscriptContent,
	mergeTodoSnapshots,
	messageTimestampMs,
	type Row,
	type TimelineMarkerSeed,
} from "./chat-stream-utils";
import { ExecutionGroup } from "./ExecutionGroup";
import { MessageBubble } from "./MessageBubble";
import { StreamingText } from "./StreamingText";
import { ThinkingBlock } from "./ThinkingBlock";

export interface TranscriptProjectionView {
	transcriptId: string;
	messages: AgentMessage[];
	streamingMessage: AgentMessage | null;
	streamingText: string;
	streamingThinking: string;
	activeTools: ReadonlyMap<string, ToolEntry>;
	resolveToolCall: ResolveToolCall;
	transcriptDetail: TranscriptDetail;
}

export interface MainTranscriptRetryInfo {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
	startedAt: number;
}

export interface MainTranscriptCompactionInfo {
	reason: "threshold" | "overflow" | "idle" | "incomplete";
	action: string;
}

export interface MainTranscriptAugments {
	isStreaming: boolean;
	awaitingModelSince: number | null;
	retryInfo: MainTranscriptRetryInfo | null;
	compactionInfo: MainTranscriptCompactionInfo | null;
	status: SidecarStatus;
	remoteStartingTarget?: SshSessionTarget;
	collapseCompacted: boolean;
	switchPending: boolean;
	todoHistory: readonly TodoSnapshot[];
	queued: {
		steering: readonly RpcQueuedMessage[];
		followUp: readonly RpcQueuedMessage[];
	};
	isChat: boolean;
}

export type TranscriptViewportProps =
	| { mode: "main"; projection: TranscriptProjectionView; main: MainTranscriptAugments }
	| { mode: "subagent"; projection: TranscriptProjectionView };

const EMPTY_QUEUED: MainTranscriptAugments["queued"] = { steering: [], followUp: [] };
const EMPTY_TODO_HISTORY: readonly TodoSnapshot[] = [];

/**
 * Shared virtual transcript surface. Main-only rows are admitted exclusively
 * through the discriminated `main` branch; projected subagent transcripts use
 * only their supplied messages, live buffers, tools, and resolver.
 */
export function TranscriptViewport(props: TranscriptViewportProps) {
	const t = useT();
	const { projection } = props;
	const isMain = props.mode === "main";
	const main = isMain ? props.main : null;
	const {
		activeTools,
		messages,
		resolveToolCall,
		streamingMessage,
		streamingText,
		streamingThinking,
		transcriptDetail,
		transcriptId,
	} = projection;
	const hasStreamingText = isRenderableMessageText(streamingText);
	const hasStreamingThinking = isRenderableMessageText(streamingThinking);
	const isStreaming = main?.isStreaming ?? streamingMessage !== null;
	const awaitingModelSince = main?.awaitingModelSince ?? null;
	const retryInfo = main?.retryInfo ?? null;
	const compactionInfo = main?.compactionInfo ?? null;
	const status = main?.status;
	const remoteStartingTarget = main?.remoteStartingTarget;
	const collapseCompacted = main?.collapseCompacted ?? false;
	const switchPending = main?.switchPending ?? false;
	const todoHistory = main?.todoHistory ?? EMPTY_TODO_HISTORY;
	const queued = main?.queued ?? EMPTY_QUEUED;
	const [preCompactionOpen, setPreCompactionOpen] = useState(false);
	const [pinned, setPinned] = useState(true);
	const [visibleRowIndex, setVisibleRowIndex] = useState(Number.MAX_SAFE_INTEGER);
	// Virtualizer measurements and programmatic scrollToIndex both emit scroll
	// events. Only an actual wheel/touch/scrollbar/keyboard gesture may unpin the
	// transcript; otherwise a session hydrate can mistake its own layout shift
	// for user intent and strand the view in arbitrary history.
	const userScrollIntentRef = useRef(false);
	useEffect(() => {
		void transcriptId;
		// Scroll intent belongs to one transcript. Carrying an unpinned offset
		// into another session made the virtualizer land in arbitrary history.
		setPreCompactionOpen(false);
		userScrollIntentRef.current = false;
		setPinned(true);
		setVisibleRowIndex(Number.MAX_SAFE_INTEGER);
	}, [transcriptId]);

	const lastCompactionIndex = isMain ? messages.findLastIndex(message => message.role === "compactionSummary") : -1;
	const hiddenCount = collapseCompacted && !preCompactionOpen && lastCompactionIndex > 0 ? lastCompactionIndex : 0;
	const historyRows = useMemo<HistoryRow[]>(() => {
		const built = buildHistoryRows(
			hiddenCount > 0 ? messages.slice(hiddenCount) : messages,
			transcriptDetail,
			resolveToolCall,
		);
		// Read-tool grouping (TUI parity) folds consecutive collapsible reads into
		// one card — only in full mode; compact mode's ProcessGroup already folds
		// ALL consecutive tool work, so a second fold would nest redundantly.
		const grouped = transcriptDetail === "compact" ? built : (groupReadRows(built, resolveToolCall) as HistoryRow[]);
		// Archived todo changes interleave by timestamp (Main transcript archive rows).
		return isMain ? mergeTodoSnapshots(grouped, todoHistory) : grouped;
	}, [messages, hiddenCount, transcriptDetail, todoHistory, resolveToolCall, isMain]);

	// The assistant message exists as an empty shell from message_start until
	// the first delta — only real content swaps the status row for the
	// streaming rows, so the shell window never reads as dead air.
	const hasStreamedContent = hasStreamingTranscriptContent(
		streamingMessage,
		hasStreamingText ? "x" : "",
		hasStreamingThinking ? "x" : "",
		activeTools,
	);

	// Main alone owns retry/compaction/model-wait status.
	const showStatusRow =
		main !== null &&
		(retryInfo != null ||
			compactionInfo != null ||
			(isStreaming && awaitingModelSince != null && !hasStreamedContent));

	// Streaming deltas rerender this component for the live row, but they do not
	// change finalized history. Keep the O(history) row/key/timeline projection
	// stable so a long transcript does not get rebuilt for every token.
	const historyMarkers = useMemo(
		() => buildTimelineMarkers(historyRows, resolveToolCall),
		[historyRows, resolveToolCall],
	);
	const { rows, timelineMarkers, rowKeys } = useMemo(() => {
		const nextRows: Row[] = [];
		const nextMarkers: Array<TimelineMarkerSeed | null> = [];
		if (hiddenCount > 0) {
			nextRows.push({ kind: "expander", count: hiddenCount });
			nextMarkers.push(null);
		}
		nextRows.push(...historyRows);
		nextMarkers.push(...historyMarkers);
		if (hasStreamedContent) {
			nextRows.push({ kind: "streaming" });
			nextMarkers.push({ state: "running", toolIds: [] });
		}
		if (showStatusRow) {
			nextRows.push({ kind: "pending" });
			nextMarkers.push({ state: "running", toolIds: [] });
		}
		for (const item of queued.steering) {
			nextRows.push({ kind: "queued", item, lane: "steering" });
			nextMarkers.push(null);
		}
		for (const item of queued.followUp) {
			nextRows.push({ kind: "queued", item, lane: "followUp" });
			nextMarkers.push(null);
		}
		return {
			rows: nextRows,
			timelineMarkers: nextMarkers,
			rowKeys: buildTranscriptRowKeys(nextRows, resolveToolCall),
		};
	}, [
		hiddenCount,
		historyRows,
		historyMarkers,
		hasStreamedContent,
		showStatusRow,
		queued.steering,
		queued.followUp,
		resolveToolCall,
	]);

	const parentRef = useRef<HTMLDivElement>(null);
	const sizeCacheRef = useRef(new Map<string | number, number>());
	useEffect(() => {
		void transcriptId;
		sizeCacheRef.current.clear();
	}, [transcriptId]);
	const conversationAnchors = useMemo(() => buildConversationAnchors(rows, rowKeys), [rows, rowKeys]);
	const activeConversationIndex = useMemo(
		() => findConversationAnchorIndex(conversationAnchors, visibleRowIndex),
		[conversationAnchors, visibleRowIndex],
	);
	const handleVirtualizerChange = useCallback((instance: { range: { startIndex: number } | null }) => {
		const next = instance.range?.startIndex;
		if (next == null) return;
		setVisibleRowIndex(current => (current === next ? current : next));
	}, []);

	const STARTERS = [
		{ icon: Code2, title: t("chat.starter.understand.title"), prompt: t("chat.starter.understand.prompt") },
		{ icon: Bug, title: t("chat.starter.fix.title"), prompt: t("chat.starter.fix.prompt") },
		{ icon: Sparkles, title: t("chat.starter.build.title"), prompt: t("chat.starter.build.prompt") },
		{ icon: SearchCode, title: t("chat.starter.review.title"), prompt: t("chat.starter.review.prompt") },
	] as const;
	const CHAT_STARTERS = [
		{ icon: BookOpen, title: t("chat.starter.explain.title"), prompt: t("chat.starter.explain.prompt") },
		{ icon: PenLine, title: t("chat.starter.draft.title"), prompt: t("chat.starter.draft.prompt") },
		{ icon: Lightbulb, title: t("chat.starter.brainstorm.title"), prompt: t("chat.starter.brainstorm.prompt") },
		{ icon: Languages, title: t("chat.starter.translate.title"), prompt: t("chat.starter.translate.prompt") },
	] as const;
	/** Main chat tabs get a conversation-oriented empty state (agent starters imply tools). */
	const isChat = main?.isChat ?? false;
	const starters = isChat ? CHAT_STARTERS : STARTERS;

	const virtualizer = useVirtualizer({
		count: rows.length,
		getItemKey: index => rowKeys[index] ?? index,
		// Chat is an end-anchored feed. Keep the live edge stable while measured
		// row heights replace estimates, and follow newly appended rows only while
		// the viewport is already at that edge.
		anchorTo: "end",
		followOnAppend: true,
		scrollEndThreshold: 80,
		// Row measurements can arrive while React is committing hydrated history.
		// Async rerenders avoid react-dom flushSync re-entry and the stale compositor
		// layers it produced on large transcripts.
		useFlushSync: false,
		getScrollElement: () => parentRef.current,
		estimateSize: i => {
			const key = rowKeys[i] ?? i;
			const cached = sizeCacheRef.current.get(key);
			if (cached != null) return cached;
			const kind = rows[i]?.kind;
			if (kind === "streaming") return 80;
			if (kind === "pending" || kind === "queued") return 56;
			if (kind === "expander" || kind === "process" || kind === "todoSnapshot") return 48;
			if (kind === "message") return 72;
			return 160;
		},
		overscan: 8,
		measureElement: el => {
			const height = el.getBoundingClientRect().height;
			const index = Number((el as HTMLElement).dataset.index);
			const key = Number.isFinite(index) ? (rowKeys[index] ?? index) : undefined;
			if (key != null) sizeCacheRef.current.set(key, height);
			return height;
		},
		onChange: handleVirtualizerChange,
	});

	// Follow newly appended rows while pinned. In-row growth (streaming text)
	// is handled by ResizeObserver below so token updates do not re-render
	// the virtualizer owner.
	useEffect(() => {
		if (!pinned || rows.length === 0) return;
		void transcriptId;
		const frame = requestAnimationFrame(() => virtualizer.scrollToEnd());
		return () => cancelAnimationFrame(frame);
	}, [virtualizer, rows.length, pinned, transcriptId]);

	useEffect(() => {
		if (!pinned) return;
		const el = parentRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (userScrollIntentRef.current) return;
			const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
			if (distance < 80) virtualizer.scrollToEnd();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [pinned, virtualizer]);

	const handleScroll = useCallback(() => {
		if (!userScrollIntentRef.current) return;
		const el = parentRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		const nextPinned = distanceFromBottom < 80;
		setPinned(nextPinned);
		// Once the user reaches the live edge, subsequent layout growth belongs to
		// the pinning system again until another explicit scroll gesture.
		if (nextPinned) userScrollIntentRef.current = false;
	}, []);

	const markUserScrollIntent = useCallback(() => {
		userScrollIntentRef.current = true;
	}, []);

	const handleScrollPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
		const right = event.currentTarget.getBoundingClientRect().right;
		if (event.clientX >= right - 20) userScrollIntentRef.current = true;
	}, []);

	const handleScrollKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
		if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
			userScrollIntentRef.current = true;
		}
	}, []);

	const jumpToLatest = useCallback(() => {
		userScrollIntentRef.current = false;
		setPinned(true);
		virtualizer.scrollToEnd();
	}, [virtualizer]);

	const jumpToConversation = useCallback(
		(rowIndex: number) => {
			userScrollIntentRef.current = false;
			setPinned(false);
			virtualizer.scrollToIndex(rowIndex, { align: "start" });
		},
		[virtualizer],
	);

	// Messages hydrate via hydrateSession (use-rpc-events) on sidecar ready —
	// no separate fetch here (that would double-download the transcript).

	return (
		<div className="omp-transcript-editorial relative min-h-0 flex-1 bg-transparent">
			<div
				ref={parentRef}
				onScroll={handleScroll}
				onWheel={markUserScrollIntent}
				onTouchMove={markUserScrollIntent}
				onPointerDown={handleScrollPointerDown}
				onKeyDown={handleScrollKeyDown}
				className="omp-transcript-scroll h-full overflow-y-auto overscroll-contain"
			>
				{switchPending && (
					<div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px overflow-hidden">
						<div className="h-full w-1/3 animate-pulse bg-[var(--omp-accent)]" />
					</div>
				)}
				{main && status === "starting" && rows.length === 0 && !switchPending && !remoteStartingTarget && (
					<div className="flex justify-center py-3">
						<Loader2 size={16} className="animate-spin text-[var(--omp-muted)]" />
					</div>
				)}
				{main && rows.length === 0 && !isStreaming && !switchPending && (
					<div className="omp-empty-canvas flex min-h-full flex-col justify-center pb-20">
						{remoteStartingTarget ? (
							<div aria-live="polite">
								<Loader2 size={28} className="mb-5 animate-spin text-[var(--omp-accent)]" />
								<h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-0.025em] text-[var(--omp-text)]">
									{t("remote.connection.connecting", { host: remoteStartingTarget.hostAlias })}
								</h1>
								<p className="mt-2 max-w-2xl font-mono text-omp-lg leading-relaxed text-[var(--omp-muted)]">
									{remoteStartingTarget.cwd}
								</p>
							</div>
						) : (
							<>
								<div className="omp-empty-logo mb-6 flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--omp-btn-primary-bg)] text-[var(--omp-btn-primary-text)]">
									<PiLogo size={22} />
								</div>
								<h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-0.025em] text-[var(--omp-text)]">
									{isChat ? t("chat.empty.title.chat") : t("chat.empty.title")}
								</h1>
								<p className="mt-2 max-w-2xl text-omp-xl leading-relaxed text-[var(--omp-muted)]">
									{isChat ? t("chat.empty.subtitle.chat") : t("chat.empty.subtitle")}
								</p>
								<div className="omp-starter-grid mt-8 grid grid-cols-2 gap-3 max-sm:grid-cols-1">
									{starters.map(({ icon: Icon, title, prompt }) => (
										<button
											key={title}
											type="button"
											onClick={() =>
												window.dispatchEvent(
													new CustomEvent("omp:fill-composer", { detail: { text: prompt } }),
												)
											}
											className="omp-starter-card omp-lift group flex min-h-20 items-start gap-3 rounded-2xl border border-[var(--omp-border)] p-4 text-left shadow-[var(--omp-shadow-sm)] hover:border-[var(--omp-border-accent)] hover:bg-[var(--omp-bg-secondary)]"
										>
											<span className="omp-starter-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--omp-selected-bg)] text-[var(--omp-accent)]">
												<Icon size={17} />
											</span>
											<span>
												<span className="block text-omp-lg font-semibold text-[var(--omp-text)]">
													{title}
												</span>
												<span className="mt-1 block text-omp-lg leading-snug text-[var(--omp-muted)]">
													{prompt}
												</span>
											</span>
										</button>
									))}
								</div>
							</>
						)}
					</div>
				)}
				<div
					className="omp-transcript-canvas"
					style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}
				>
					{virtualizer.getVirtualItems().map(item => {
						const row = rows[item.index];
						if (!row) return null;
						return (
							<div
								key={item.key}
								data-index={item.index}
								data-transcript-kind={row.kind}
								ref={virtualizer.measureElement}
								style={{
									position: "absolute",
									top: 0,
									left: 0,
									width: "100%",
									transform: `translateY(${item.start}px)`,
								}}
							>
								<div className="omp-transcript-row w-full">
									<TimelineMarker activeTools={activeTools} seed={timelineMarkers[item.index] ?? null} />
									{row.kind === "message" ? (
										<MessageBubble
											message={row.message}
											readOnly={!isMain}
											resolveToolCall={resolveToolCall}
										/>
									) : row.kind === "readGroup" ? (
										<ReadGroupCard
											activeTools={activeTools}
											entries={row.entries}
											resolveToolCall={resolveToolCall}
											usage={row.usage}
										/>
									) : row.kind === "process" ? (
										<ProcessGroup
											activeTools={activeTools}
											readOnly={!isMain}
											resolveToolCall={resolveToolCall}
											row={row}
										/>
									) : row.kind === "streaming" ? (
										<StreamingRows
											activeTools={activeTools}
											resolveToolCall={resolveToolCall}
											streamingMessage={streamingMessage}
											streamingText={streamingText}
											streamingThinking={streamingThinking}
											transcriptDetail={transcriptDetail}
										/>
									) : row.kind === "queued" ? (
										<QueuedMessageBubble item={row.item} lane={row.lane} />
									) : row.kind === "todoSnapshot" ? (
										<TodoSnapshotCard entry={row.entry} />
									) : row.kind === "expander" ? (
										<button
											type="button"
											onClick={() => setPreCompactionOpen(true)}
											className="omp-history-expander omp-pressable ml-(--omp-editorial-inset) mr-(--omp-editorial-edge) my-2 flex items-center gap-2 rounded-lg border border-[var(--omp-border)] px-3 py-1.5 text-omp-sm font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-bg-tertiary)] hover:text-[var(--omp-text)]"
										>
											{t("chat.compaction.showEarlier", { count: row.count })}
										</button>
									) : (
										<TurnStatusRow
											awaitingModelSince={awaitingModelSince}
											compactionInfo={compactionInfo}
											retryInfo={retryInfo}
										/>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>
			<ConversationNavigator
				activeIndex={activeConversationIndex}
				anchors={conversationAnchors}
				onNavigate={jumpToConversation}
			/>
			<button
				type="button"
				onClick={jumpToLatest}
				aria-label={t("chat.jumpToLatest")}
				className={cx(
					"absolute bottom-5 left-1/2 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-4 text-omp-md font-medium text-[var(--omp-text)] shadow-[var(--omp-shadow-md)] transition-all hover:bg-[var(--omp-selected-bg)]",
					pinned ? "pointer-events-none translate-y-12 opacity-0" : "translate-y-0 opacity-100",
				)}
			>
				<ArrowDown size={14} />
				{t("chat.jumpToLatest")}
			</button>
		</div>
	);
}

function TimelineMarker({
	activeTools,
	seed,
}: {
	activeTools: ReadonlyMap<string, ToolEntry>;
	seed: TimelineMarkerSeed | null;
}) {
	if (!seed) return null;
	let state = seed.state;

	if (seed.toolIds.some(id => activeTools.get(id)?.status === "error" || activeTools.get(id)?.isError)) {
		state = "error";
	} else if (
		seed.toolIds.some(id => {
			const status = activeTools.get(id)?.status;
			return status === "pending" || status === "running";
		})
	) {
		state = "running";
	}

	const time = formatShortClock(seed.timestamp);
	return (
		<div aria-hidden className={cx("omp-timeline-marker", `omp-timeline-marker--${state}`)}>
			<span className="omp-timeline-dot">
				{state === "running" ? (
					<Loader2 className="animate-spin" size={11} />
				) : state === "error" ? (
					<X size={11} />
				) : state === "launch" ? (
					<Rocket size={10} />
				) : (
					<Check size={11} />
				)}
			</span>
			{time ? <time>{time}</time> : null}
		</div>
	);
}
export function ProcessGroup({
	activeTools,
	readOnly = false,
	resolveToolCall,
	row,
}: {
	activeTools: ReadonlyMap<string, ToolEntry>;
	readOnly?: boolean;
	resolveToolCall?: ResolveToolCall;
	row: Extract<HistoryRow, { kind: "process" }>;
}) {
	return (
		<div className="ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-2">
			<ExecutionGroup activeTools={activeTools} stepCount={row.stepCount} toolCallIds={row.toolCallIds}>
				<div className="omp-process-group">
					{row.messages.map((message, index) => (
						<MessageBubble
							compact
							key={
								typeof message.id === "string"
									? message.id
									: `${String(message.timestamp ?? "process")}-${index}`
							}
							message={message}
							readOnly={readOnly}
							resolveToolCall={resolveToolCall}
						/>
					))}
				</div>
			</ExecutionGroup>
		</div>
	);
}

/**
 * The in-flight assistant turn: thinking block, any tool calls already
 * emitted, and the live text tail. Replaces itself with a finalized
 * MessageBubble on message_end.
 */
export function StreamingRows({
	activeTools,
	resolveToolCall,
	streamingMessage,
	streamingText,
	streamingThinking,
	transcriptDetail,
}: {
	activeTools: ReadonlyMap<string, ToolEntry>;
	resolveToolCall?: ResolveToolCall;
	streamingMessage: AgentMessage | null;
	streamingText: string;
	streamingThinking: string;
	transcriptDetail: TranscriptDetail;
}) {
	if (!streamingMessage) return null;
	const content = Array.isArray(streamingMessage.content) ? streamingMessage.content : [];
	const toolCalls = content.filter(block => block.type === "toolCall");

	// streamingMessage.content only fills at message_end; mid-stream the live
	// tool calls accumulate in the tools store (toolcall_delta → pending while
	// args stream, tool_execution_start → running). Render those store entries
	// as live cards; on message_end this row unmounts and MessageBubble takes
	// over with the same toolCallIds. Entries from before this stream started
	// (hydrated history that never finished) are excluded by start time.
	const streamStart = messageTimestampMs(streamingMessage);
	const resolvedToolCalls = toolCalls.map(call => {
		const resolved = resolveToolCall?.(call);
		return {
			id: resolved?.key ?? toolEntryKey(call),
			name: call.name,
			args: call.arguments as Record<string, unknown>,
			call,
			entry: resolved?.entry,
		};
	});
	const contentIds = new Set(resolvedToolCalls.map(card => card.id));
	const liveTools: Array<{ id: string; entry: ToolEntry }> = [];
	for (const [id, entry] of activeTools) {
		if (contentIds.has(id)) continue;
		if (entry.status !== "pending" && entry.status !== "running") continue;
		if (entry.startTime < streamStart) continue;
		liveTools.push({ id, entry });
	}

	const hasThinking = isRenderableMessageText(streamingThinking);
	const hasProcess = hasThinking || toolCalls.length > 0 || liveTools.length > 0;

	// Live read grouping (same predicate as the finalized path): consecutive
	// collapsible reads fold into one ReadGroupCard even mid-turn. Compact
	// detail keeps the same plain execution rows used by ProcessGroup.
	const allCards: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
		call?: ToolCallContent;
		entry?: ToolEntry;
	}> = [
		...resolvedToolCalls,
		...liveTools.map(({ id, entry }) => ({
			id,
			name: entry.toolName,
			args: entry.args as Record<string, unknown>,
			entry,
		})),
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
				run.push({ callId: card.id, toolKey: card.id, call: card.call, ...read, args: card.args });
				continue;
			}
			flush();
			segments.push({ type: "card", card });
		}
		flush();
		// Keep the live shape identical to finalized `groupReadRows`: even one
		// collapsible read uses ReadGroupCard, preventing a card-type swap at
		// message_end.
		if (!segments.some(segment => segment.type === "group")) return null;
		return segments.map((segment, index) =>
			segment.type === "group" ? (
				<ReadGroupCard
					activeTools={resolveToolCall ? activeTools : undefined}
					inset
					key={`rg-${segment.entries[0]?.toolKey ?? index}`}
					entries={segment.entries}
					resolveToolCall={resolveToolCall}
				/>
			) : (
				<ToolCard
					key={segment.card.id}
					toolCallId={segment.card.id}
					toolName={segment.card.name}
					args={segment.card.args}
					entry={resolveToolCall ? (segment.card.entry ?? activeTools.get(segment.card.id) ?? null) : undefined}
				/>
			),
		);
	})();

	const toolCards =
		groupedLiveCards ??
		allCards.map(card => (
			<ToolCard
				key={card.id}
				toolCallId={card.id}
				toolName={card.name}
				args={card.args}
				entry={resolveToolCall ? (card.entry ?? activeTools.get(card.id) ?? null) : undefined}
			/>
		));

	if (transcriptDetail === "full") {
		return (
			<div className="omp-streaming-turn flex flex-col ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-4">
				{hasThinking ? (
					<ThinkingBlock
						live
						streamingTextStarted={isRenderableMessageText(streamingText)}
						text={streamingThinking}
					/>
				) : null}
				<div className="space-y-2">
					{toolCards}
					<StreamingText text={streamingText} />
				</div>
			</div>
		);
	}

	return (
		<div className="omp-streaming-turn flex flex-col ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-2">
			{hasProcess ? (
				<ExecutionGroup
					activeTools={activeTools}
					live
					stepCount={toolCalls.length + liveTools.length + (hasThinking ? 1 : 0)}
					toolCallIds={allCards.map(card => card.id)}
				>
					<div className="omp-process-group omp-process-group--live">
						{hasThinking ? (
							<ThinkingBlock
								live
								streamingTextStarted={isRenderableMessageText(streamingText)}
								text={streamingThinking}
							/>
						) : null}
						{toolCalls.length + liveTools.length > 0 ? <div>{toolCards}</div> : null}
					</div>
				</ExecutionGroup>
			) : null}
			<div className={hasProcess ? "mt-1" : undefined}>
				<StreamingText text={streamingText} />
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
export function TurnStatusRow({
	awaitingModelSince,
	compactionInfo,
	retryInfo,
}: {
	awaitingModelSince: number | null;
	compactionInfo: MainTranscriptCompactionInfo | null;
	retryInfo: MainTranscriptRetryInfo | null;
}) {
	const t = useT();
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
		<div className="omp-status-turn omp-fade-in flex flex-col gap-1 ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-4 text-omp-lg text-[var(--omp-muted)]">
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
				<div className="max-w-full truncate pl-[26px] text-omp-sm text-[var(--omp-dim)]" title={detail}>
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
 * success. Failed responses and rejected transport calls re-enable the action,
 * toast the error, and attempt an authoritative refresh.
 */
function QueuedMessageBubble({ item, lane }: { item: RpcQueuedMessage; lane: QueueLane }) {
	const t = useT();
	const [removing, setRemoving] = useState(false);

	const remove = async () => {
		setRemoving(true);
		let failure: string | undefined;
		try {
			const response = await window.omp.rpc.queueRemove(item.id);
			if (response.success) return;
			failure = response.error;
		} catch (cause) {
			failure = cause instanceof Error ? cause.message : String(cause);
		}
		setRemoving(false);
		toast({ variant: "error", title: t("pendingBubble.removeFailed"), message: failure });
		await useQueueStore.getState().refresh();
	};

	return (
		<div className="omp-queued-turn group flex justify-end ps-(--omp-editorial-inset) pe-(--omp-editorial-edge) py-1.5">
			<div className="omp-transcript-content omp-queued-bubble flex items-start gap-2 rounded-xl border border-dashed border-[var(--omp-border)] px-3.5 py-2.5">
				<div className="min-w-0 flex-1">
					<div className="mb-0.5 text-omp-xs font-semibold tracking-wide text-[var(--omp-dim)] uppercase">
						{t(lane === "steering" ? "pendingBubble.steering" : "pendingBubble.followUp")}
					</div>
					<div className="whitespace-pre-wrap break-words text-omp-lg leading-snug text-[var(--omp-muted)]">
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

/**
 * Archived todo state rendered inline in the transcript where the change
 * happened (todo store history). Collapses to a one-line summary; expanding
 * shows the phase/task state at that time, read-only — the live dock card
 * above the composer carries the editable current list.
 */
function TodoSnapshotCard({ entry }: { entry: TodoSnapshot }) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const total = entry.phases.reduce((n, phase) => n + phase.tasks.length, 0);
	const done = entry.phases.reduce(
		(n, phase) => n + phase.tasks.filter(task => task.status === "completed").length,
		0,
	);
	const cleared = total === 0;

	return (
		<div className="ml-(--omp-editorial-inset) mr-(--omp-editorial-edge) my-1.5">
			<button
				aria-expanded={expanded}
				className="omp-pressable flex items-center gap-1.5 rounded-lg border border-[var(--omp-border-muted)] px-2.5 py-1 text-omp-sm text-[var(--omp-muted)] hover:text-[var(--omp-text)]"
				disabled={cleared}
				onClick={() => setExpanded(value => !value)}
				type="button"
			>
				<ChevronRight
					className="shrink-0 text-[var(--omp-dim)] transition-transform duration-100"
					size={11}
					style={{ transform: expanded ? "rotate(90deg)" : undefined }}
				/>
				<ListTodo className="shrink-0 text-[var(--omp-dim)]" size={12} />
				<span className="font-medium">{cleared ? t("todoSnapshot.cleared") : t("todoSnapshot.title")}</span>
				{!cleared && (
					<span className="tabular-nums text-[var(--omp-dim)]">{t("todoSnapshot.progress", { done, total })}</span>
				)}
			</button>
			{expanded && !cleared && (
				<div className="mt-1 ml-1 space-y-1 border-l border-[var(--omp-border-muted)] pl-3">
					{entry.phases.map((phase, phaseIndex) => (
						<div key={`${phase.name}-${phaseIndex}`}>
							{entry.phases.length > 1 && (
								<div className="py-0.5 text-omp-xs font-semibold tracking-wide text-[var(--omp-dim)] uppercase">
									{phase.name}
								</div>
							)}
							{phase.tasks.map((task, taskIndex) => (
								<div
									key={`${task.content}-${taskIndex}`}
									className="flex items-center gap-1.5 py-0.5 text-omp-sm"
								>
									<span
										aria-hidden
										className={cx(
											"h-1.5 w-1.5 shrink-0 rounded-full",
											task.status === "completed"
												? "bg-[var(--omp-success)]"
												: task.status === "in_progress"
													? "bg-[var(--omp-link)]"
													: task.status === "abandoned"
														? "bg-[var(--omp-error)]"
														: task.status === "blocked"
															? "bg-[var(--omp-warning)]"
															: "bg-[var(--omp-border)]",
										)}
									/>
									<span
										className={cx(
											"min-w-0 flex-1 truncate",
											task.status === "completed" || task.status === "abandoned"
												? "text-[var(--omp-dim)] line-through"
												: "text-[var(--omp-muted)]",
										)}
										title={task.content}
									>
										{task.content}
									</span>
								</div>
							))}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
