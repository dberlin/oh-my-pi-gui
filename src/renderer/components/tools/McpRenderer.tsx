import { AnsiText, hasAnsi } from "../../lib/ansi";
import { copyText, extractImageDataUrl } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { useSettingsStore } from "../../stores/settings";
import { resultBodyText, resultDetails } from "./result";
import { StructuredDataView } from "./StructuredDataView";
import type { ToolRendererProps } from "./ToolCard";

type ParsedJson = { parsed: true; value: unknown } | { parsed: false };
const PREVIEW_ARGUMENT_ENTRIES = 2;
const PREVIEW_ARGUMENT_VALUE_CHARS = 480;
const PREVIEW_RESULT_LINES = 4;
const PREVIEW_RESULT_CHARS = 960;

function boundedText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars - 1)}…`;
}

function compactValue(value: unknown, maxChars: number, depth = 0): string {
	if (typeof value === "string") {
		return boundedText(
			value
				.slice(0, maxChars + 1)
				.replace(/\s+/gu, " ")
				.trim(),
			maxChars,
		);
	}
	if (value == null || typeof value !== "object") return boundedText(String(value), maxChars);
	if (Array.isArray(value)) {
		if (depth > 0) return `[${value.length} items]`;
		const items = value.slice(0, 3).map(item => compactValue(item, 96, depth + 1));
		return boundedText(`[${items.join(", ")}${value.length > items.length ? ", …" : ""}]`, maxChars);
	}
	if (depth > 0) return "{…}";
	const record = value as Record<string, unknown>;
	const fields: string[] = [];
	let hasMore = false;
	for (const key in record) {
		if (!Object.hasOwn(record, key)) continue;
		if (fields.length === 3) {
			hasMore = true;
			break;
		}
		fields.push(`${boundedText(key, 96)}: ${compactValue(record[key], 96, depth + 1)}`);
	}
	return boundedText(`{${fields.join(", ")}${hasMore ? ", …" : ""}}`, maxChars);
}

function argumentExcerpt(args: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const key in args) {
		if (!Object.hasOwn(args, key)) continue;
		lines.push(`${boundedText(key, 96)}: ${compactValue(args[key], PREVIEW_ARGUMENT_VALUE_CHARS)}`);
		if (lines.length === PREVIEW_ARGUMENT_ENTRIES) break;
	}
	return lines.join("\n");
}

function resultExcerpt(body: string): string {
	let end = 0;
	let line = 1;
	while (end < body.length && end < PREVIEW_RESULT_CHARS) {
		const character = body.charCodeAt(end);
		if (character === 10 || character === 13) {
			if (line === PREVIEW_RESULT_LINES) break;
			line += 1;
			if (character === 13 && body.charCodeAt(end + 1) === 10) end += 1;
		}
		end += 1;
	}
	return boundedText(body.slice(0, end).replace(/\r\n?/gu, "\n"), PREVIEW_RESULT_CHARS);
}

function parseJson(text: string): ParsedJson {
	const trimmed = text.trim();
	if (!trimmed) return { parsed: false };
	try {
		const value: unknown = JSON.parse(trimmed);
		return { parsed: true, value };
	} catch {
		return { parsed: false };
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeImageDataUrl(value: unknown): string | null {
	const dataUrl = extractImageDataUrl(value);
	return dataUrl?.startsWith("data:image/") ? dataUrl : null;
}

function artifactUri(value: unknown): string | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const id = String(value).trim();
	if (!id || /[\s\u0000-\u001f\u007f]/u.test(id)) return null;
	return `artifact://${id}`;
}

function TruncationMetadata({ details }: { details: Record<string, unknown> | undefined }) {
	const t = useT();
	const truncation = asRecord(asRecord(details?.meta)?.truncation) ?? asRecord(asRecord(details?.mcpMeta)?.truncation);
	if (!truncation) return null;

	const outputLines =
		typeof truncation.outputLines === "number" && Number.isFinite(truncation.outputLines)
			? truncation.outputLines
			: "—";
	const totalLines =
		typeof truncation.totalLines === "number" && Number.isFinite(truncation.totalLines) ? truncation.totalLines : "—";
	const elidedLines =
		typeof truncation.elidedLines === "number" && Number.isFinite(truncation.elidedLines)
			? truncation.elidedLines
			: null;
	const artifact = artifactUri(truncation.artifactId);

	return (
		<div
			className="rounded bg-[var(--omp-code-bg)] px-2 py-1.5 text-omp-xs text-[var(--omp-muted)]"
			data-mcp-truncation="true"
		>
			<div className="font-medium text-[var(--omp-tool-output)]">
				{t("tools.mcp.truncation", { outputLines, totalLines })}
				{elidedLines != null && <span className="font-mono"> · {elidedLines}</span>}
			</div>
			{artifact && (
				<a
					className="font-mono text-[var(--omp-accent)] underline"
					data-mcp-artifact={artifact}
					href={artifact}
					onClick={event => {
						event.preventDefault();
						void copyText(artifact);
					}}
					role="button"
					title={artifact}
				>
					{t("tools.mcp.artifact", { artifact })}
				</a>
			)}
		</div>
	);
}

export function McpRenderer({ args, result, isError, isPartial, partialResult, view }: ToolRendererProps) {
	const t = useT();
	const renderMarkdown = useSettingsStore(state => state.mcpRenderMarkdownResults);
	const effective = isPartial && partialResult != null ? partialResult : result;
	const body = resultBodyText(effective);
	const details = resultDetails(effective) ?? resultDetails(result) ?? resultDetails(partialResult);
	const expanded = view === "expanded";
	const parsed: ParsedJson = expanded ? parseJson(body) : { parsed: false };
	const mcpMeta = asRecord(details?.mcpMeta);
	const rawContent = details?.rawContent;
	const mcpRawContent = mcpMeta?.rawContent;
	const image = expanded
		? (safeImageDataUrl(effective) ?? safeImageDataUrl(rawContent) ?? safeImageDataUrl(mcpRawContent))
		: null;
	const previewArgs = expanded ? "" : argumentExcerpt(args);
	const previewResult = expanded ? "" : resultExcerpt(body);
	const hasResult = body.length > 0 || image != null || Boolean(isError);
	return (
		<div className="flex flex-col gap-1.5">
			{(expanded || previewArgs) && (
				<div>
					<div className="mb-0.5 text-omp-xxs font-semibold uppercase tracking-wider text-[var(--omp-dim)]">
						{t("tools.generic.args")}
					</div>
					{expanded ? (
						<div className="max-h-48 overflow-auto rounded bg-[var(--omp-code-bg)] px-2 py-1.5">
							<StructuredDataView defaultExpandedDepth={2} value={args} />
						</div>
					) : (
						<pre className="whitespace-pre-wrap break-all rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-xs leading-[1.4] text-[var(--omp-tool-output)]">
							{previewArgs}
						</pre>
					)}
				</div>
			)}

			{hasResult && (
				<div>
					<div
						className={`mb-0.5 text-omp-xxs font-semibold uppercase tracking-wider ${
							isError ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]"
						}`}
					>
						{isError
							? t("tools.eval.error")
							: isPartial
								? t("tools.generic.partialResult")
								: t("tools.generic.result")}
					</div>
					{expanded ? (
						<>
							{parsed.parsed ? (
								<div
									className={`max-h-64 overflow-auto rounded px-2 py-1.5 ${
										isError ? "bg-[var(--omp-tool-error-bg)]" : "bg-[var(--omp-code-bg)]"
									}`}
								>
									<StructuredDataView defaultExpandedDepth={2} value={parsed.value} />
								</div>
							) : body ? (
								renderMarkdown ? (
									<div
										className={`max-h-64 overflow-auto rounded px-2 py-1.5 ${
											isError
												? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
												: "bg-[var(--omp-code-bg)]"
										}`}
									>
										<MarkdownRenderer content={body} />
									</div>
								) : (
									<pre
										className={`max-h-64 overflow-auto whitespace-pre-wrap rounded px-2 py-1.5 font-mono text-omp-sm leading-[1.45] ${
											isError
												? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
												: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]"
										}`}
									>
										{hasAnsi(body) ? <AnsiText text={body} /> : body}
									</pre>
								)
							) : null}
							{image && (
								<img
									alt={t("tools.mcp.imageAlt")}
									className="mt-1.5 max-h-72 rounded-md border border-[var(--omp-border-muted)] object-contain"
									src={image}
								/>
							)}
						</>
					) : previewResult ? (
						<pre
							className={`whitespace-pre-wrap break-all rounded px-2 py-1.5 font-mono text-omp-xs leading-[1.4] ${
								isError
									? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
									: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]"
							}`}
						>
							{previewResult}
						</pre>
					) : null}
				</div>
			)}

			<TruncationMetadata details={details} />
		</div>
	);
}
