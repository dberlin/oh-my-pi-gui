import { Check, MessageCircleQuestion } from "lucide-react";
import { resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ToolRendererProps } from "./ToolCard";

function extractOptions(args: Record<string, unknown>, result: unknown): string[] {
	const fromArgs = Array.isArray(args.options) ? args.options.filter((o): o is string => typeof o === "string") : [];
	if (fromArgs.length > 0) return fromArgs;
	if (result && typeof result === "object") {
		const r = result as Record<string, unknown>;
		if (Array.isArray(r.options)) return r.options.filter((o): o is string => typeof o === "string");
	}
	return [];
}

/**
 * Ask: the question and its options. The response was already sent back to
 * the agent, so this renders as an informational card with the chosen answer
 * (from the result) marked.
 */
export function AskRenderer({ args, result, isPartial }: ToolRendererProps) {
	const t = useT();
	const question =
		typeof args.question === "string" ? args.question : typeof args.message === "string" ? args.message : "";
	const options = extractOptions(args, result);
	const answer = resultText(result).trim();

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-start gap-1.5 text-[11.5px]">
				<MessageCircleQuestion size={13} className="mt-0.5 shrink-0 text-[var(--omp-md-link)]" />
				<span className="min-w-0 flex-1 leading-[1.45] text-[var(--omp-text)]">
					{question || t("tools.ask.questionFallback")}
				</span>
			</div>
			{options.length > 0 && (
				<div className="flex flex-col gap-0.5 pl-5">
					{options.map(option => {
						const chosen = answer.length > 0 && answer.toLowerCase().includes(option.toLowerCase());
						return (
							<div
								key={option}
								className={
									"flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] " +
									(chosen
										? "bg-[var(--omp-success)]/10 text-[var(--omp-text)]"
										: "bg-[var(--omp-code-bg)] text-[var(--omp-muted)]")
								}
							>
								{chosen ? (
									<Check size={11} className="shrink-0 text-[var(--omp-success)]" />
								) : (
									<span className="h-2.5 w-2.5 shrink-0 rounded-full border border-[var(--omp-border-muted)]" />
								)}
								{option}
							</div>
						);
					})}
				</div>
			)}
			{answer && (
				<div className="pl-5 text-[10.5px] text-[var(--omp-dim)]">
					{isPartial ? t("tools.ask.waiting") : t("tools.ask.answered", { answer })}
				</div>
			)}
		</div>
	);
}
