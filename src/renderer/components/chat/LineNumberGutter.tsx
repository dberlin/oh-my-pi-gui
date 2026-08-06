import { cx } from "../../lib/format";

export interface LineNumberGutterProps {
	lineCount: number;
	/**
	 * Typography metrics (font size, line-height, block padding) — they MUST
	 * match the code pane beside the gutter or numbers drift off their lines.
	 */
	className?: string;
}

/**
 * Shared sticky line-number gutter for code blocks: the tool-renderers'
 * CodeBlock (always on) and markdown code blocks (codeLineNumbers pref).
 * Extracted so both render the same gutter instead of forking it.
 */
export function LineNumberGutter({ lineCount, className }: LineNumberGutterProps) {
	return (
		<div
			aria-hidden
			className={cx(
				"sticky left-0 shrink-0 select-none border-r border-[var(--omp-border-muted)]/50 bg-[var(--omp-code-bg)] text-right font-mono text-[var(--omp-dim)]",
				className,
			)}
		>
			{Array.from({ length: lineCount }, (_, i) => (
				<div key={i}>{i + 1}</div>
			))}
		</div>
	);
}
