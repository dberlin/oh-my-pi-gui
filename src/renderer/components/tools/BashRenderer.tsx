import { Terminal } from "lucide-react";
import { cx, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

/**
 * Bash wire shape: `{ content: [{ type: "text", text }], details }` where
 * `details` is `BashToolDetails` (packages/coding-agent/src/tools/bash.ts):
 *   { meta?: { truncation? }, timeoutSeconds?, requestedTimeoutSeconds?,
 *     timeoutDisabled?, wallTimeMs?, exitCode?, timedOut?, terminalId?,
 *     async?: { state, jobId } }
 * The text body carries the combined stdout/stderr stream plus LLM-facing
 * trailer notices (background / truncation / exit code / wall time / raw
 * artifact). Like the TUI, strip those notices and re-state them from
 * `details` as a stats line instead.
 */

interface BashParsed {
	output: string;
	exitCode: number | null;
	stats: string[];
	truncation: string | null;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Mirror of stripTrailingNotice in bash.ts. */
function stripTrailingNotice(text: string, notice: string): string {
	const idx = text.lastIndexOf(notice);
	if (idx === -1) return text;
	let start = idx;
	let end = idx + notice.length;
	if (text[start - 1] === "\n") start -= 1;
	if (text[end] === "\n") end += 1;
	return (text.slice(0, start) + text.slice(end)).trimEnd();
}

const RAW_ARTIFACT_RE = /\n?\[raw output: artifact:\/\/(\d+)\]\s*$/;
/** Trailing `[Showing …]` / limits notice line appended by wrappedExecute. */
const GENERATED_NOTICE_RE =
	/^\[(?:Showing .+|\d+ (?:matches|results) limit reached\. .+|Some lines truncated to .+)\]$/;

function stripGeneratedOutputNotice(text: string): string {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidate = trimmed.slice(lineStart === -1 ? 0 : lineStart + 1);
	if (!GENERATED_NOTICE_RE.test(candidate)) return text;
	return trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd();
}

function formatTruncation(truncation: Record<string, unknown>): string | null {
	const totalLines = asNumber(truncation.totalLines);
	const outputLines = asNumber(truncation.outputLines);
	const shownRange = truncation.shownRange as { start?: number; end?: number } | undefined;
	if (truncation.direction === "middle") {
		return totalLines != null && outputLines != null
			? `Showing ${outputLines} of ${totalLines} lines; middle elided`
			: "Middle of output elided";
	}
	if (shownRange && asNumber(shownRange.start) != null && asNumber(shownRange.end) != null && totalLines != null) {
		return `Showing lines ${shownRange.start}-${shownRange.end} of ${totalLines}`;
	}
	if (outputLines != null && totalLines != null) return `Showing ${outputLines} of ${totalLines} lines`;
	return null;
}

function parseBashResult(result: unknown, isError: boolean | undefined): BashParsed {
	const details = resultDetails(result);
	let text = resultText(result);

	const wallTimeMs = asNumber(details?.wallTimeMs);
	const exitCode = asNumber(details?.exitCode) ?? null;
	const timeoutSeconds = asNumber(details?.timeoutSeconds);
	const requestedTimeoutSeconds = asNumber(details?.requestedTimeoutSeconds);
	const timeoutDisabled = details?.timeoutDisabled === true;
	const asyncInfo =
		details?.async != null && typeof details.async === "object"
			? (details.async as { state?: unknown; jobId?: unknown })
			: undefined;
	const backgroundJobId = typeof asyncInfo?.jobId === "string" ? asyncInfo.jobId : undefined;
	const meta =
		details?.meta != null && typeof details.meta === "object" ? (details.meta as Record<string, unknown>) : undefined;
	const truncation =
		meta?.truncation != null && typeof meta.truncation === "object"
			? (meta.truncation as Record<string, unknown>)
			: undefined;

	// Strip trailer notices in the same order as the TUI renderer.
	if (asyncInfo?.state === "running" && backgroundJobId) {
		text = stripTrailingNotice(
			text,
			`Backgrounded as job ${backgroundJobId}; result will be delivered automatically.`,
		);
	}
	if (meta) text = stripGeneratedOutputNotice(text);
	if (exitCode != null) text = stripTrailingNotice(text, `Command exited with code ${exitCode}`);
	if (wallTimeMs != null) text = stripTrailingNotice(text, `Wall time: ${(wallTimeMs / 1000).toFixed(2)} seconds`);

	let artifactId = typeof truncation?.artifactId === "string" ? truncation.artifactId : undefined;
	const artifactMatch = text.match(RAW_ARTIFACT_RE);
	if (artifactMatch) {
		artifactId = artifactMatch[1];
		text = text.slice(0, artifactMatch.index).trimEnd();
	}

	const stats: string[] = [];
	if (asyncInfo?.state === "running" && backgroundJobId) stats.push(`Backgrounded: ${backgroundJobId}`);
	if (wallTimeMs != null) stats.push(`Wall: ${(wallTimeMs / 1000).toFixed(2)}s`);
	if (timeoutDisabled) stats.push("Timeout: disabled");
	if (timeoutSeconds != null) {
		stats.push(
			requestedTimeoutSeconds != null && requestedTimeoutSeconds !== timeoutSeconds
				? `Timeout: ${timeoutSeconds}s (requested ${requestedTimeoutSeconds}s clamped)`
				: `Timeout: ${timeoutSeconds}s`,
		);
	}
	if (artifactId) stats.push(`Artifact: ${artifactId}`);
	if (isError && exitCode != null) stats.push(`Exit: ${exitCode}`);

	return {
		output: text.trimEnd(),
		exitCode,
		stats,
		truncation: truncation ? formatTruncation(truncation) : null,
	};
}

/** Bash: command line, terminal-style output, exit-code badge, stats footer. */
export function BashRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const command = typeof args.command === "string" ? args.command : "";
	const parsed = parseBashResult(isPartial ? partialResult : result, isError);
	const hasOutput = parsed.output.length > 0;

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-start gap-1.5 rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45]">
				<Terminal size={12} className="mt-0.5 shrink-0 text-[var(--omp-success)]" />
				<span className="min-w-0 flex-1 whitespace-pre-wrap break-all text-[var(--omp-text)]">$ {command}</span>
				{parsed.exitCode != null && (
					<span
						className={cx(
							"ml-1 shrink-0 rounded px-1 py-px text-omp-xxs font-semibold tabular-nums",
							parsed.exitCode === 0 && !isError
								? "bg-[var(--omp-success)]/15 text-[var(--omp-success)]"
								: "bg-[var(--omp-error)]/15 text-[var(--omp-error)]",
						)}
					>
						{t("tools.bash.exit", { code: parsed.exitCode })}
					</span>
				)}
				{isPartial && parsed.exitCode == null && (
					<span className="ml-1 shrink-0 text-omp-xs text-[var(--omp-accent)]">{t("tools.bash.running")}</span>
				)}
			</div>
			{hasOutput && (
				<div className="max-h-64 overflow-auto rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.5]">
					<div className="whitespace-pre-wrap text-[var(--omp-tool-output)]">{parsed.output}</div>
				</div>
			)}
			{parsed.stats.length > 0 && (
				<div className="font-mono text-omp-xs text-[var(--omp-dim)]">[{parsed.stats.join(" | ")}]</div>
			)}
			{parsed.truncation && (
				<div className="font-mono text-omp-xs text-[var(--omp-warning)]">[{parsed.truncation}]</div>
			)}
			{isError && !hasOutput && <div className="text-omp-sm text-[var(--omp-error)]">{t("tools.bash.failed")}</div>}
		</div>
	);
}
