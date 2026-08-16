import { FileText } from "lucide-react";
import { basename, dirname, extractImageDataUrl, headLines, languageFromPath, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { CodeBlock } from "../chat/CodeBlock";
import type { ToolRendererProps } from "./ToolCard";

const PREVIEW_LINES = 50;

/** File read: path header + syntax-highlighted preview of the first 50 lines. */
export function ReadRenderer({ args, result, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const path = typeof args.path === "string" ? args.path : "";
	const effective = isPartial ? partialResult : result;
	const text = resultText(effective);
	const image = extractImageDataUrl(effective);
	const { head, omitted } = headLines(text, PREVIEW_LINES);

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<FileText size={12} className="shrink-0 text-[var(--omp-dim)]" />
				<span className="truncate text-[var(--omp-text)]">{basename(path)}</span>
				<span className="truncate text-[var(--omp-dim)]">{dirname(path)}</span>
			</div>
			{image ? (
				<img
					src={image}
					alt={path || t("tools.image.alt")}
					className="max-h-72 rounded-md border border-[var(--omp-border-muted)] object-contain"
				/>
			) : text ? (
				<>
					<CodeBlock
						code={head}
						language={languageFromPath(path)}
						showLanguage={false}
						showCopy={false}
						maxHeightClass="max-h-72"
					/>
					{omitted > 0 && (
						<div className="text-center font-mono text-omp-xs text-[var(--omp-dim)]">
							{t("tools.read.more", { count: omitted, plural: omitted === 1 ? "" : "s" })}
						</div>
					)}
				</>
			) : (
				<div className="text-omp-sm italic text-[var(--omp-dim)]">
					{isPartial ? t("tools.read.reading") : t("tools.read.empty")}
				</div>
			)}
		</div>
	);
}
