import { AnsiText, hasAnsi } from "../../lib/ansi";
import { resultText } from "../../lib/format";
import { PREVIEW_SCROLL_LG } from "../../lib/preview";
import type { ToolRendererProps } from "./ToolCard";

const PREVIEW_DOCUMENTATION_LIMIT = 2_400;
const EXPANDED_DOCUMENTATION_LIMIT = 64 * 1_024;

function boundedDocumentation(documentation: string, limit: number): string {
	if (documentation.length <= limit) return documentation;
	return `${documentation.slice(0, limit).trimEnd()}\n…`;
}

export function HelpRenderer({ isPartial, partialResult, result, view }: ToolRendererProps) {
	const effectiveResult = isPartial && partialResult != null ? partialResult : result;
	const documentation = resultText(effectiveResult);
	const limit = view === "expanded" ? EXPANDED_DOCUMENTATION_LIMIT : PREVIEW_DOCUMENTATION_LIMIT;
	const bounded = boundedDocumentation(documentation, limit);

	return (
		<pre
			className={`${PREVIEW_SCROLL_LG} whitespace-pre-wrap break-words rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-omp-sm leading-[1.45] text-[var(--omp-tool-output)]`}
			data-tool-help-documentation
		>
			{bounded ? hasAnsi(bounded) ? <AnsiText text={bounded} /> : bounded : "—"}
		</pre>
	);
}
