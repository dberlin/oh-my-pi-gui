import { Code2 } from "lucide-react";
import { resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { CodeBlock } from "../chat/CodeBlock";
import type { ToolRendererProps } from "./ToolCard";

/** Eval: code cell with language badge + output below. */
export function EvalRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const code = typeof args.code === "string" ? args.code : "";
	const language =
		typeof args.language === "string" ? (args.language === "py" ? "python" : args.language) : "javascript";
	const title = typeof args.title === "string" ? args.title : "";
	const output = resultText(isPartial ? partialResult : result);

	return (
		<div className="flex flex-col gap-1.5">
			{title && (
				<div className="flex items-center gap-1.5 text-omp-sm">
					<Code2 size={12} className="text-[var(--omp-dim)]" />
					<span className="font-medium text-[var(--omp-text)]">{title}</span>
				</div>
			)}
			{code && <CodeBlock code={code} language={language} showCopy={false} maxHeightClass="max-h-64" />}
			{output && (
				<div>
					<div
						className={
							"mb-0.5 text-omp-xxs font-semibold uppercase tracking-wider " +
							(isError ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]")
						}
					>
						{isError ? t("tools.eval.error") : t("tools.eval.output")}
					</div>
					<pre
						className={
							"max-h-48 overflow-auto whitespace-pre-wrap rounded px-2 py-1.5 font-mono text-omp-sm leading-[1.45] " +
							(isError
								? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
								: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]")
						}
					>
						{output}
					</pre>
				</div>
			)}
			{isPartial && !output && (
				<div className="text-omp-sm italic text-[var(--omp-accent)]">{t("tools.eval.evaluating")}</div>
			)}
		</div>
	);
}
