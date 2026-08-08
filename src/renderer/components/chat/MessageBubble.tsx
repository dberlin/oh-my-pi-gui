import { Archive, Check, Copy, FileText, GitBranch, Terminal } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useState } from "react";
import type { AgentMessage, ImageContent, MessageContent, ToolCallContent } from "../../../shared/rpc-types";
import { copyText, cx, formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { branchSessionFromEntry, isRenderableMessageText } from "../../lib/messages";
import { toast } from "../../stores/toast";
import { toolEntryKey } from "../../stores/tools";
import { ToolCard } from "../tools/ToolCard";
import { CustomMessageCard, isCustomMessageCardType } from "./CustomMessageCard";
import { ThinkingBlock } from "./ThinkingBlock";
import { UsageRow } from "./UsageRow";

export interface MessageBubbleProps {
	message: AgentMessage;
	/** Suppress per-message footer/padding inside an expanded Process group. */
	compact?: boolean;
}

function messageEntryId(message: AgentMessage): string | undefined {
	for (const key of ["id", "entryId", "uuid"]) {
		const v = message[key];
		if (typeof v === "string" && v) return v;
	}
	return undefined;
}

function toolSummary(toolName: string, input: Record<string, unknown>): string {
	const pick = (...keys: string[]): string | undefined => {
		for (const k of keys) {
			const v = input[k];
			if (typeof v === "string" && v) return v;
		}
		return undefined;
	};
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return pick("path", "file") ?? "";
		case "bash":
			return pick("command", "cmd") ?? "";
		case "grep":
			return pick("pattern") ?? "";
		case "glob":
			return pick("path", "pattern") ?? "";
		case "task":
			return pick("i", "name", "description") ?? "";
		case "eval":
			return pick("title", "language") ?? "";
		case "goal":
			return pick("objective", "op") ?? "";
		case "resolve":
		case "reject":
			return pick("reason") ?? "";
		case "web_search":
			return pick("query", "i") ?? "";
		default:
			return pick("path", "name", "i") ?? "";
	}
}

function InlineImage({ image }: { image: ImageContent }) {
	const t = useT();
	const src = `data:${image.mimeType};base64,${image.data}`;
	return (
		<img
			src={src}
			alt={t("chat.attachedImage")}
			className="my-1 max-h-48 max-w-64 rounded-md border border-[var(--omp-border-muted)] object-contain"
		/>
	);
}

/** ToolCard subscribes to the tools store itself, so the tool result lands inline. */
function ToolCardWithResult({ call }: { call: ToolCallContent }) {
	return (
		<ToolCard
			toolCallId={toolEntryKey(call)}
			toolName={call.name}
			args={call.arguments}
			summary={toolSummary(call.name, call.arguments)}
		/>
	);
}

const FILE_PREVIEW_CHARS = 12_000;

function ExecutionBubble({ message }: { message: AgentMessage }) {
	const t = useT();
	// Local placeholder appended by the composer while an `$` eval is in flight
	// (InputArea): offers abortEval; the hydrated transcript record replaces it
	// on completion, mirroring the bash flow.
	const running = message.running === true;
	const [abortSent, setAbortSent] = useState(false);
	const python = message.role === "pythonExecution";
	const input = python ? message.code : message.command;
	const status = running
		? t("chat.exec.running")
		: message.cancelled
			? t("chat.exec.cancelled")
			: message.exitCode == null
				? t("chat.exec.finished")
				: t("chat.exec.exit", { code: message.exitCode });
	const failed = !running && (message.cancelled || (message.exitCode != null && message.exitCode !== 0));

	return (
		<div className="omp-fade-up px-6 py-4">
			<div className="overflow-hidden rounded-[10px] border border-[var(--omp-border-muted)] bg-[var(--omp-code-bg)] shadow-[var(--omp-shadow-sm)]">
				<div className="flex items-center gap-2 border-b border-[var(--omp-border-muted)] px-3.5 py-2">
					<Terminal className="text-[var(--omp-status-path)]" size={13} />
					<span className="text-[11.5px] font-semibold text-[var(--omp-text)]">
						{python ? t("chat.exec.python") : t("chat.exec.shell")}
					</span>
					<span
						className={cx(
							"ml-auto rounded-full px-2 py-0.5 font-mono text-[9.5px] font-medium tracking-wide",
							running && "animate-pulse",
						)}
						style={{
							background: running
								? "var(--omp-info-dim)"
								: failed
									? "var(--omp-error-dim)"
									: "var(--omp-success-dim)",
							color: running ? "var(--omp-info)" : failed ? "var(--omp-error)" : "var(--omp-success)",
						}}
					>
						{status}
					</span>
					{running && (
						<button
							type="button"
							disabled={abortSent}
							title={t("common.cancel")}
							onClick={() => {
								setAbortSent(true);
								void window.omp.rpc.abortEval();
							}}
							className="omp-pressable flex items-center rounded-full px-2 py-0.5 text-[9.5px] font-medium tracking-wide text-[var(--omp-error)] hover:bg-[var(--omp-error-dim)] disabled:opacity-50"
						>
							{t("common.cancel")}
						</button>
					)}
				</div>
				{input && (
					<pre className="border-b border-[var(--omp-border-muted)] px-3.5 py-2.5 font-mono text-[11.5px] leading-[1.6] break-words whitespace-pre-wrap text-[var(--omp-status-path)]">
						{python ? input : `$ ${input}`}
					</pre>
				)}
				{!running && (
					<pre className="max-h-80 overflow-auto px-3.5 py-2.5 font-mono text-[11.5px] leading-[1.6] break-words whitespace-pre-wrap text-[var(--omp-tool-output)]">
						{message.output || t("chat.exec.noOutput")}
						{message.truncated ? `\n${t("chat.exec.truncated")}` : ""}
					</pre>
				)}
			</div>
		</div>
	);
}

function ContextBubble({ message }: { message: AgentMessage }) {
	const t = useT();
	const isFiles = message.role === "fileMention";
	const label =
		message.role === "compactionSummary"
			? message.tokensBefore
				? t("chat.context.compactedFrom", { tokens: message.tokensBefore.toLocaleString() })
				: t("chat.context.compacted")
			: message.role === "branchSummary"
				? t("chat.context.branchSummary")
				: t("chat.context.referencedFiles");

	return (
		<div className="omp-fade-up px-6 py-3">
			<div className="rounded-[10px] border border-[var(--omp-border-muted)] bg-[var(--omp-bg-tertiary)] px-3.5 py-3">
				<div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold tracking-[0.12em] text-[var(--omp-status-context)] uppercase">
					{isFiles ? <FileText size={12} /> : <Archive size={12} />}
					{label}
				</div>
				{isFiles ? (
					<div className="space-y-1.5">
						{(message.files ?? []).map(file => (
							<details
								className="overflow-hidden rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-code-bg)]"
								key={file.path}
							>
								<summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-[var(--omp-status-path)]">
									{file.path}
									{file.skippedReason ? ` — ${file.skippedReason}` : ""}
								</summary>
								<pre className="max-h-72 overflow-auto border-t border-[var(--omp-border-muted)] px-3 py-2.5 font-mono text-[10.5px] leading-[1.6] break-words whitespace-pre-wrap text-[var(--omp-tool-output)]">
									{file.content.slice(0, FILE_PREVIEW_CHARS)}
									{file.content.length > FILE_PREVIEW_CHARS ? `\n${t("chat.context.previewTruncated")}` : ""}
								</pre>
							</details>
						))}
					</div>
				) : (
					<MarkdownRenderer content={message.summary ?? ""} />
				)}
			</div>
		</div>
	);
}

/**
 * One finalized message. User messages sit right-aligned; assistant messages
 * render text, thinking, images, and tool cards. Standalone toolResult messages
 * are folded into their matching card through the tools store.
 */
export const MessageBubble = memo(function MessageBubble({ message, compact = false }: MessageBubbleProps) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const [branching, setBranching] = useState(false);
	if (message.role === "bashExecution" || message.role === "pythonExecution") {
		return <ExecutionBubble message={message} />;
	}
	if (message.role === "branchSummary" || message.role === "compactionSummary" || message.role === "fileMention") {
		return <ContextBubble message={message} />;
	}
	if (message.role === "custom" || message.role === "hookMessage") {
		if (message.display === false) return null;
		// Dedicated cards for the TUI customType set; unknown types fall through
		// to the generic label + content bubble below.
		if (isCustomMessageCardType(message.customType)) {
			return <CustomMessageCard message={message} />;
		}
	}
	if (message.role === "toolResult") return null;

	const content: MessageContent[] = Array.isArray(message.content)
		? message.content
		: typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: [];
	const isUser = message.role === "user";
	const isSteering = Boolean(message.steering);
	const entryId = messageEntryId(message);
	const timestamp = formatClock(message.timestamp);
	const customLabel =
		message.role === "custom" || message.role === "hookMessage"
			? (message.customType ?? t("chat.extensionMessage"))
			: null;

	const handleCopy = () => {
		const text = content
			.filter((block): block is Extract<MessageContent, { type: "text" }> => block.type === "text")
			.map(block => block.text)
			.join("\n\n");
		void copyText(text).then(ok => {
			if (!ok) return;
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1400);
		});
	};

	const handleBranch = async () => {
		if (!entryId || branching) return;
		setBranching(true);
		try {
			const result = await branchSessionFromEntry(entryId);
			if (result === "cancelled") {
				toast({ variant: "info", message: t("branchPicker.cancelled") });
			}
		} catch (cause) {
			toast({ variant: "error", title: t("branchPicker.failed"), message: String(cause) });
		} finally {
			setBranching(false);
		}
	};

	if (isUser) {
		return (
			<div className="omp-user-turn group flex justify-end px-6 py-2.5">
				<div
					className="omp-user-bubble omp-fade-up relative max-w-[75%] rounded-xl border border-[var(--omp-user-msg-border)] bg-[var(--omp-user-msg-bg)] px-3.5 py-3"
					style={{ boxShadow: "var(--omp-shadow-sm)" }}
				>
					<div className="omp-user-bubble-layout">
						<span className="omp-user-bubble-author">{t("live.you")}</span>
						<div className="omp-user-bubble-content">
							{isSteering && (
								<div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--omp-custom-msg-label)]">
									<span className="h-1 w-1 rounded-full bg-current" />
									{t("chat.steering")}
								</div>
							)}
							{content.map((block, i) => {
								if (block.type === "text") {
									return (
										<div key={i} className="text-[14.5px] leading-[1.6] text-[var(--omp-text)]">
											<MarkdownRenderer content={block.text} />
										</div>
									);
								}
								if (block.type === "image") {
									return <InlineImage key={i} image={block} />;
								}
								return null;
							})}
						</div>
					</div>
					<div className="omp-user-bubble-actions flex items-center gap-1.5 text-[10.5px] tabular-nums text-[var(--omp-dim)]">
						{timestamp && <span className="font-mono">{timestamp}</span>}
						<button
							type="button"
							onClick={handleCopy}
							title={t("chat.copyMessage")}
							className="omp-pressable flex h-7 w-7 items-center justify-center rounded-md text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
						>
							{copied ? <Check size={13} className="text-[var(--omp-success)]" /> : <Copy size={13} />}
						</button>
						{entryId && (
							<button
								type="button"
								onClick={() => void handleBranch()}
								disabled={branching}
								title={t("chat.branchFromHere")}
								className="omp-pressable flex h-7 w-7 items-center justify-center rounded-md text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)] disabled:cursor-wait disabled:opacity-50"
							>
								<GitBranch size={13} />
							</button>
						)}
					</div>
				</div>
			</div>
		);
	}

	// Assistant / system: render block by block.
	const blocks: ReactNode[] = [];
	let sawNonToolBlock = false;
	for (const block of content) {
		switch (block.type) {
			case "text": {
				if (isRenderableMessageText(block.text)) {
					blocks.push(<MarkdownRenderer key={blocks.length} content={block.text} />);
					sawNonToolBlock = true;
				}
				break;
			}
			case "thinking": {
				if (isRenderableMessageText(block.thinking)) {
					blocks.push(<ThinkingBlock key={blocks.length} text={block.thinking} />);
					sawNonToolBlock = true;
				}
				break;
			}
			case "toolCall": {
				blocks.push(<ToolCardWithResult key={toolEntryKey(block)} call={block} />);
				break;
			}
			case "image": {
				blocks.push(<InlineImage key={blocks.length} image={block} />);
				sawNonToolBlock = true;
				break;
			}
		}
	}

	if (blocks.length === 0 && !message.errorMessage && !customLabel && !isSteering) return null;

	// Tool-only messages and messages nested inside an expanded Process group
	// don't need the 28px hover footer plus py-3 padding. Tool-only copy would
	// be empty; the Process disclosure owns the grouped chrome and branch point.
	const compactChrome = compact || (!sawNonToolBlock && !message.errorMessage && !customLabel && !isSteering);

	return (
		<div
			className={cx(
				"group flex px-6",
				!compact && "omp-fade-up",
				!compactChrome && "omp-assistant-turn",
				compactChrome && "omp-assistant-turn--compact",
				compactChrome ? "py-1.5" : "py-3",
			)}
		>
			<div className="min-w-0 flex-1">
				{customLabel && (
					<div className="mb-2 text-[11px] font-bold tracking-[0.1em] text-[var(--omp-status-context)] uppercase">
						{customLabel}
					</div>
				)}
				{isSteering && (
					<div className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-[var(--omp-custom-msg-label)]">
						<span className="h-1.5 w-1.5 rounded-full bg-current" />
						{t("chat.steeringResponse")}
					</div>
				)}
				{blocks}
				{message.errorMessage && (
					<div className="omp-message-error mt-2 rounded-lg border border-[var(--omp-error)]/35 bg-[var(--omp-error-dim)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--omp-error)]">
						{message.errorMessage}
					</div>
				)}
				<UsageRow message={message} />
				{!compactChrome && (
					<div className="mt-2 flex items-center gap-1.5 text-[10.5px] tabular-nums text-[var(--omp-dim)] opacity-0 transition-opacity duration-150 group-hover:opacity-100">
						{timestamp && <span className="font-mono">{timestamp}</span>}
						<button
							type="button"
							onClick={handleCopy}
							title={t("chat.copyMessage")}
							className="omp-pressable flex h-7 w-7 items-center justify-center rounded-md text-[var(--omp-dim)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
						>
							{copied ? <Check size={13} className="text-[var(--omp-success)]" /> : <Copy size={13} />}
						</button>
					</div>
				)}
			</div>
		</div>
	);
});
