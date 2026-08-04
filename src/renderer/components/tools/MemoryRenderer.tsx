import { Brain } from "lucide-react";
import { resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

/**
 * Memory tools wire shape (retain / recall / reflect — see
 * packages/coding-agent/src/tools/memory-render.ts):
 * - retain:  args { items: [{ content }] }, details { count },
 *            text "N memories stored." / "N memories queued."
 * - recall:  args { query }, text "Found N relevant memories (as of …):\n\n…"
 *            or "No relevant memories found."
 * - reflect: args { query }, text = synthesized answer.
 * There is no `operation` arg — the op is inferred from the arg/result shape.
 */

const MAX_BULLETS = 12;

function retainContents(args: Record<string, unknown>): string[] {
	const items = args.items;
	if (!Array.isArray(items)) return [];
	const out: string[] = [];
	for (const item of items) {
		if (item && typeof item === "object" && "content" in item && typeof item.content === "string") {
			const content = item.content.trim();
			if (content) out.push(content);
		}
	}
	return out;
}

/** Memory: operation header + retain bullets / recall matches / reflect answer. */
export function MemoryRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const effective = isPartial ? partialResult : result;
	const details = resultDetails(effective);
	const text = resultText(effective).trim();
	const query = typeof args.query === "string" ? args.query : "";
	const bullets = retainContents(args);

	const foundMatch = text.match(/^Found (\d+) relevant/);
	const isRetain = bullets.length > 0;
	const isRecall = !isRetain && (foundMatch != null || text.startsWith("No relevant memories"));
	const operation = isRetain ? "retain" : isRecall ? "recall" : query ? "reflect" : "memory";
	const count = typeof details?.count === "number" ? details.count : undefined;
	// Recall body drops the "Found N relevant memories (…)" header line.
	const recallBody = isRecall && foundMatch ? text.replace(/^[^\n]*\n+/, "").trim() : "";

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-[11px]">
				<Brain size={12} className="shrink-0 text-[var(--omp-custom-msg-label)]" />
				<span className="shrink-0 text-[var(--omp-text)]">{operation}</span>
				{query && <span className="min-w-0 flex-1 truncate text-[var(--omp-dim)]">{query}</span>}
				{isRecall && (
					<span className="ml-auto shrink-0 text-[10px] text-[var(--omp-dim)]">
						{foundMatch ? `${foundMatch[1]} found` : "no matches"}
					</span>
				)}
				{isRetain && count != null && (
					<span className="ml-auto shrink-0 text-[10px] text-[var(--omp-dim)]">
						{count} {count === 1 ? "memory" : "memories"}
					</span>
				)}
			</div>

			{isRetain && (
				<div className="rounded bg-[var(--omp-code-bg)] px-2 py-1 text-[11px] leading-[1.6]">
					{bullets.slice(0, MAX_BULLETS).map((content, i) => (
						<div key={i} className="flex gap-1.5">
							<span className="shrink-0 text-[var(--omp-dim)]">•</span>
							<span className="min-w-0 flex-1 truncate text-[var(--omp-tool-output)]" title={content}>
								{content}
							</span>
						</div>
					))}
					{bullets.length > MAX_BULLETS && (
						<div className="text-[10px] text-[var(--omp-dim)]">… {bullets.length - MAX_BULLETS} more</div>
					)}
					{text && <div className="mt-0.5 text-[10px] text-[var(--omp-dim)]">{text.replace(/\.$/, "")}</div>}
				</div>
			)}

			{!isRetain && (recallBody || text) ? (
				<pre
					className={
						isError
							? "max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-tool-error-bg)] px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-[var(--omp-error)]"
							: "max-h-48 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-[var(--omp-tool-output)]"
					}
				>
					{recallBody || text}
				</pre>
			) : null}

			{!isRetain && !recallBody && !text && (
				<div className="text-[11px] italic text-[var(--omp-dim)]">
					{isPartial ? t("tools.memory.processing") : t("tools.memory.done")}
				</div>
			)}
		</div>
	);
}
