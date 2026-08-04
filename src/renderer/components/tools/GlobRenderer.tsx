import { FolderOpen } from "lucide-react";
import { resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ToolRendererProps } from "./ToolCard";

const MAX_PATHS = 300;

/** Glob: matched-path count + the path list. */
export function GlobRenderer({ args, result, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const pattern = typeof args.path === "string" ? args.path : typeof args.pattern === "string" ? args.pattern : "";
	const text = resultText(isPartial ? partialResult : result);
	const paths = text
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean)
		.slice(0, MAX_PATHS);

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1.5 font-mono text-[11px]">
				<FolderOpen size={12} className="shrink-0 text-[var(--omp-dim)]" />
				<span className="truncate text-[var(--omp-text)]">{pattern}</span>
				<span className="ml-auto shrink-0 text-[10px] text-[var(--omp-dim)]">
					{isPartial ? t("tools.glob.matching") : t("tools.glob.paths", { count: paths.length, plural: paths.length === 1 ? "" : "s" })}
				</span>
			</div>
			{paths.length > 0 && (
				<div className="max-h-56 overflow-auto rounded bg-[var(--omp-code-bg)] px-2 py-1 font-mono text-[11px] leading-[1.5]">
					{paths.map((p, i) => (
						<div
							key={i}
							className="truncate whitespace-pre text-[var(--omp-muted)] transition-colors hover:bg-[var(--omp-selected-bg)]/50"
						>
							{p.endsWith("/") ? <span className="text-[var(--omp-status-path)]">{p}</span> : p}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
