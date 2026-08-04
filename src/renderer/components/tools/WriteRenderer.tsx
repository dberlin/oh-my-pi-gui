import { ChevronDown, ChevronRight, FilePlus2 } from "lucide-react";
import { useState } from "react";
import { basename, dirname, languageFromPath } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { CodeBlock } from "../chat/CodeBlock";
import type { ToolRendererProps } from "./ToolCard";

/** File write: path header + collapsible content preview. */
export function WriteRenderer({ args }: ToolRendererProps) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const path = typeof args.path === "string" ? args.path : "";
	const content = typeof args.content === "string" ? args.content : "";
	const lineCount = content ? content.split("\n").length : 0;

	return (
		<div className="flex flex-col gap-1.5">
			<button
				type="button"
				onClick={() => setOpen(v => !v)}
				className="flex items-center gap-1.5 font-mono text-[11px] transition-colors hover:text-[var(--omp-text)]"
			>
				{open ? (
					<ChevronDown size={12} className="shrink-0 text-[var(--omp-dim)]" />
				) : (
					<ChevronRight size={12} className="shrink-0 text-[var(--omp-dim)]" />
				)}
				<FilePlus2 size={12} className="shrink-0 text-[var(--omp-dim)]" />
				<span className="truncate text-[var(--omp-text)]">{basename(path)}</span>
				<span className="truncate text-[var(--omp-dim)]">{dirname(path)}</span>
				<span className="ml-auto shrink-0 text-[10px] text-[var(--omp-dim)]">
					{t("tools.write.lines", { count: lineCount, plural: lineCount === 1 ? "" : "s" })}
				</span>
			</button>
			{open && content && (
				<CodeBlock
					code={content}
					language={languageFromPath(path)}
					showLanguage={false}
					showCopy={false}
					maxHeightClass="max-h-72"
				/>
			)}
		</div>
	);
}
