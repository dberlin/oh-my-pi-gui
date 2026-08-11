import { Image as ImageIcon } from "lucide-react";
import { extractImageDataUrl, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ToolRendererProps } from "./ToolCard";

/** Image tools (inspect_image, image_gen): preview + caption. */
export function ImageRenderer({ args, result, isError, isPartial, partialResult }: ToolRendererProps) {
	const t = useT();
	const path = typeof args.path === "string" ? args.path : "";
	const prompt = typeof args.prompt === "string" ? args.prompt : "";
	const effective = isPartial ? partialResult : result;
	// { content, details } envelopes keep images in content blocks; some tools
	// (image_gen) stash the payload under details instead — search both.
	const image =
		extractImageDataUrl(effective) ??
		(effective != null && typeof effective === "object" && !Array.isArray(effective)
			? extractImageDataUrl((effective as Record<string, unknown>).details)
			: null) ??
		(typeof args.path === "string" && args.path.startsWith("data:image/") ? args.path : null);
	const caption = resultText(effective);

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5 font-mono text-omp-sm">
				<ImageIcon size={12} className="shrink-0 text-[var(--omp-thinking-xhigh)]" />
				{path && <span className="min-w-0 flex-1 truncate text-[var(--omp-text)]">{path}</span>}
				{!path && prompt && <span className="min-w-0 flex-1 truncate text-[var(--omp-muted)]">{prompt}</span>}
			</div>
			{image ? (
				<img
					src={image}
					alt={path || prompt || t("tools.image.alt")}
					className="max-h-72 rounded-md border border-[var(--omp-border-muted)] object-contain"
				/>
			) : (
				caption && (
					<pre
						className={
							"max-h-40 overflow-auto whitespace-pre-wrap rounded px-2 py-1.5 font-mono text-omp-sm leading-[1.45] " +
							(isError
								? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
								: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]")
						}
					>
						{caption}
					</pre>
				)
			)}
			{isPartial && !image && !caption && (
				<div className="text-omp-sm italic text-[var(--omp-accent)]">{t("tools.image.generating")}</div>
			)}
		</div>
	);
}
