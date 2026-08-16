import { cx, extractImageDataUrl, resultDetails, resultText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { PREVIEW_SCROLL_SM } from "../../lib/preview";
import { StructuredDataView } from "./StructuredDataView";
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

function parseJson(value: string): { value: unknown } | null {
	if (!value.trim()) return null;
	try {
		return { value: JSON.parse(value) as unknown };
	} catch {
		return null;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function artifactUri(value: unknown): string | undefined {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const id = String(value);
	return id.startsWith("artifact://") ? id : `artifact://${id}`;
}

function detailsForDisplay(details: Record<string, unknown>): Record<string, unknown> {
	const meta = asRecord(details.meta);
	const nestedTruncation = asRecord(meta?.truncation);
	if (meta && nestedTruncation) {
		const artifact = artifactUri(nestedTruncation.artifactId);
		if (artifact) {
			return {
				...details,
				meta: {
					...meta,
					truncation: { ...nestedTruncation, artifact },
				},
			};
		}
	}
	const truncation = asRecord(details.truncation);
	const artifact = artifactUri(truncation?.artifactId);
	return artifact && truncation ? { ...details, truncation: { ...truncation, artifact } } : details;
}

export function GenericRenderer({ args, result, isError, isPartial, partialResult, view }: ToolRendererProps) {
	const t = useT();
	const expanded = view === "expanded";
	const effective = isPartial && partialResult != null ? partialResult : result;
	const body = resultText(effective);
	const parsedBody = parseJson(body);
	const details = expanded ? resultDetails(effective) : undefined;
	const visibleDetails = details && Object.keys(details).length > 0 ? detailsForDisplay(details) : undefined;
	const extractedImageUrl = extractImageDataUrl(effective);
	const imageUrl = extractedImageUrl?.startsWith("data:image/") ? extractedImageUrl : null;
	return (
		<div className="flex flex-col gap-1.5">
			{expanded && (
				<div>
					<div className="mb-0.5 text-omp-xxs font-semibold uppercase tracking-wider text-[var(--omp-dim)]">
						{t("tools.generic.args")}
					</div>
					<div className={cx("rounded bg-[var(--omp-code-bg)] px-2 py-1.5", PREVIEW_SCROLL_SM)}>
						<StructuredDataView defaultExpandedDepth={3} value={args} />
					</div>
				</div>
			)}
			<div>
				<div
					className={cx(
						"mb-0.5 text-omp-xxs font-semibold uppercase tracking-wider",
						isError ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]",
					)}
				>
					{isPartial ? t("tools.generic.partialResult") : t("tools.generic.result")}
				</div>
				{parsedBody ? (
					<div
						className={cx(
							"rounded px-2 py-1.5",
							PREVIEW_SCROLL_SM,
							isError
								? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
								: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]",
						)}
					>
						<StructuredDataView
							defaultExpandedDepth={expanded ? 3 : 1}
							maxChildren={expanded ? 100 : 20}
							value={parsedBody.value}
						/>
					</div>
				) : (
					<pre
						className={cx(
							"whitespace-pre-wrap rounded px-2 py-1.5 font-mono text-omp-sm leading-[1.45]",
							PREVIEW_SCROLL_SM,
							isError
								? "bg-[var(--omp-tool-error-bg)] text-[var(--omp-error)]"
								: "bg-[var(--omp-code-bg)] text-[var(--omp-tool-output)]",
						)}
					>
						{body || (expanded ? toJson(effective) : "—")}
					</pre>
				)}
			</div>
			{imageUrl && (
				<img
					alt={t("tools.generic.result")}
					className={cx(
						"max-w-full rounded border border-[var(--omp-border-muted)] object-contain",
						expanded ? "max-h-80" : "max-h-40",
					)}
					src={imageUrl}
				/>
			)}
			{expanded && visibleDetails && (
				<div>
					<div className="mb-0.5 text-omp-xxs font-semibold uppercase tracking-wider text-[var(--omp-dim)]">
						{t("tools.generic.details")}
					</div>
					<div className={cx("rounded bg-[var(--omp-code-bg)] px-2 py-1.5", PREVIEW_SCROLL_SM)}>
						<StructuredDataView defaultExpandedDepth={3} value={visibleDetails} />
					</div>
				</div>
			)}
		</div>
	);
}
