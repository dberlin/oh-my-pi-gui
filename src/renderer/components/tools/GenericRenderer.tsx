import { cx, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ToolRendererProps } from "./ToolCard";

function toJson(value: unknown): string {
	if (value == null) return "—";
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** Fallback renderer: arguments + result body text with a structured details summary. */
export function GenericRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const effective = isPartial && partialResult != null ? partialResult : result;
	// Unwrap the live `{content, details}` envelope: body text + structured
	// details, never the raw envelope JSON. Non-envelope payloads fall through
	// resultText's JSON.stringify path, matching the old toJson dump.
	const body = resultText(effective);
	const details = resultDetails(effective);
	const detailsJson = details && Object.keys(details).length > 0 ? toJson(details) : "";
	return (
		<div className="flex flex-col gap-1.5">
			<div>
				<div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-[var(--omp-dim)]">
					{t("tools.generic.args")}
				</div>
				<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-[var(--omp-muted)]">
					{toJson(args)}
				</pre>
			</div>
			<div>
				<div
					className={cx(
						"mb-0.5 text-[9.5px] font-semibold uppercase tracking-wider",
						isError ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]",
					)}
				>
					{isPartial ? t("tools.generic.partialResult") : t("tools.generic.result")}
				</div>
				<pre
					className={cx(
						"max-h-40 overflow-auto whitespace-pre-wrap rounded px-2 py-1.5 font-mono text-[11px] leading-[1.45]",
						isError
							? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
							: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]",
					)}
				>
					{body || toJson(effective)}
				</pre>
			</div>
			{detailsJson && (
				<div>
					<div className="mb-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-[var(--omp-dim)]">
						{t("tools.generic.details")}
					</div>
					<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--omp-code-bg)] px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-[var(--omp-muted)]">
						{detailsJson}
					</pre>
				</div>
			)}
		</div>
	);
}
