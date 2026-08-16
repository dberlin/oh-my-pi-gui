import { useT } from "../../lib/i18n";
import { resultBodyText } from "./result";
import type { ToolRendererProps } from "./ToolCard";

export function ThinkRenderer({ result, isError, isPartial, partialResult, view }: ToolRendererProps) {
	const t = useT();
	if (view !== "expanded") return null;

	const body = resultBodyText(isPartial ? partialResult : result).trim();

	return (
		<div className="flex flex-col gap-1.5">
			<div
				className={
					isError
						? "text-omp-xs font-semibold text-[var(--omp-error)]"
						: "text-omp-xs font-semibold text-[var(--omp-muted)]"
				}
			>
				{t(isPartial ? "tools.think.thinking" : "tools.think.result")}
			</div>
			{body && (
				<pre
					className={
						isError
							? "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--omp-tool-error-bg)] px-2.5 py-2 font-mono text-omp-sm leading-[1.5] text-[var(--omp-error)]"
							: "max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--omp-bg-tertiary)] px-2.5 py-2 font-mono text-omp-sm leading-[1.5] text-[var(--omp-tool-output)]"
					}
				>
					{body}
				</pre>
			)}
		</div>
	);
}
