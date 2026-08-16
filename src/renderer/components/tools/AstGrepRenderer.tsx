import { Braces } from "lucide-react";
import { AnsiText, hasAnsi } from "../../lib/ansi";
import { resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ToolRendererProps } from "./ToolCard";

const PREVIEW_MATCHES = 6;

interface AstPreview {
	text: string;
	matchCount: number;
}

function buildPreview(text: string, maxMatches: number): AstPreview {
	const rendered: string[] = [];
	const pendingHeaders: string[] = [];
	let matchCount = 0;
	let currentMatchVisible = false;
	let recognizedMatches = false;

	for (const line of text.split("\n")) {
		const isHeader = /^#+\s+/.test(line);
		const isMatch = /^\*\d+(?::|\|)/.test(line) || /^\s*\*\s*\d+│/.test(line) || /^.+?:\d+:\d+:\s/.test(line);
		if (isHeader) {
			pendingHeaders.push(line);
			currentMatchVisible = false;
			continue;
		}
		if (isMatch) {
			recognizedMatches = true;
			matchCount++;
			currentMatchVisible = matchCount <= maxMatches;
			if (currentMatchVisible) rendered.push(...pendingHeaders, line);
			pendingHeaders.length = 0;
			continue;
		}
		if (currentMatchVisible) {
			rendered.push(line);
		} else if (matchCount === 0) {
			pendingHeaders.push(line);
		}
	}

	if (recognizedMatches) return { text: rendered.join("\n"), matchCount };
	const lines = text.split("\n").filter(line => line.trim().length > 0);
	return { text: lines.slice(0, maxMatches).join("\n"), matchCount: lines.length };
}

/** AST grep: pattern header + match results. */
export function AstGrepRenderer({ args, result, isPartial, partialResult, view }: ToolRendererProps) {
	const t = useT();
	const pattern = typeof args.pattern === "string" ? args.pattern : typeof args.pat === "string" ? args.pat : "";
	const text = resultText(isPartial ? partialResult : result);
	const preview = view === "preview" ? buildPreview(text, PREVIEW_MATCHES) : undefined;
	const renderedText = preview?.text ?? text;
	const omitted = preview ? Math.max(preview.matchCount - PREVIEW_MATCHES, 0) : 0;

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<Braces size={12} className="shrink-0 text-[var(--omp-md-code)]" />
				<span className="truncate text-[var(--omp-text)]">{pattern || t("tools.astgrep.fallback")}</span>
			</div>
			{text ? (
				<>
					<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-tool-output)]">
						{hasAnsi(renderedText) ? <AnsiText text={renderedText} /> : renderedText}
					</pre>
					{omitted > 0 && (
						<div className="text-center font-mono text-omp-xs text-[var(--omp-dim)]">
							{t("tools.read.more", { count: omitted, plural: omitted === 1 ? "" : "s" })}
						</div>
					)}
				</>
			) : (
				<div className="text-omp-sm italic text-[var(--omp-dim)]">
					{isPartial ? t("tools.astgrep.matching") : t("tools.astgrep.noMatches")}
				</div>
			)}
		</div>
	);
}
