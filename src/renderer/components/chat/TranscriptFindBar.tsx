/**
 * Presentational find bar and match-tick strip for ⌘F transcript search.
 * Owns no find state, does no scrolling, and never touches the virtualizer
 * or the ui store — Task 6's hook drives it and Task 7 wires it in. There is
 * no existing transcript scroll rail to hang ticks on (`--omp-transcript-rail`
 * is only a dashed border colour), so `TranscriptFindTicks` is its own thin
 * overlay strip, rendered only while find is open.
 */

import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { KeyboardEvent, ReactElement, RefObject } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { FindTick } from "./transcript-find";

export interface TranscriptFindBarProps {
	query: string;
	onQueryChange: (query: string) => void;
	/** Total matches in document order. */
	total: number;
	/** 0-based current ordinal, or null when nothing is selected. */
	current: number | null;
	/** True for one navigation step after a wrap. */
	wrapped: boolean;
	onOlder: () => void;
	onNewer: () => void;
	onClose: () => void;
	inputRef: RefObject<HTMLInputElement | null>;
}

export function TranscriptFindBar(props: TranscriptFindBarProps): ReactElement {
	const { query, onQueryChange, total, current, wrapped, onOlder, onNewer, onClose, inputRef } = props;
	const t = useT();
	const hasQuery = query.length > 0;
	const noMatches = hasQuery && total === 0;

	const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault();
			if (event.shiftKey) onNewer();
			else onOlder();
		} else if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		}
	};

	let statusText: string;
	if (total === 0 || current == null) {
		statusText = t("chat.find.statusNone");
	} else if (wrapped) {
		statusText = t("chat.find.statusWrapped", { current: current + 1, total });
	} else {
		statusText = t("chat.find.status", { current: current + 1, total });
	}

	return (
		<div
			role="search"
			aria-label={t("chat.find.label")}
			data-transcript-find
			className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-xl border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] px-2 py-1.5 shadow-[var(--omp-shadow-md)]"
		>
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={event => onQueryChange(event.target.value)}
				onKeyDown={handleKeyDown}
				aria-label={t("chat.find.placeholder")}
				aria-invalid={noMatches ? "true" : undefined}
				data-find-input
				className={cx(
					"w-40 rounded-md border bg-transparent px-2 py-1 text-omp-md text-[var(--omp-text)] outline-none",
					noMatches ? "border-[var(--omp-error)]" : "border-transparent",
				)}
			/>
			{hasQuery && (
				<span data-find-counter className="whitespace-nowrap text-omp-sm tabular-nums text-[var(--omp-text-muted)]">
					{current != null ? current + 1 : 0} / {total}
				</span>
			)}
			{wrapped && (
				<span className="whitespace-nowrap text-omp-sm text-[var(--omp-text-muted)]">
					{t("chat.find.wrapIndicator")}
				</span>
			)}
			<span aria-hidden className="h-4 w-px bg-[var(--omp-border)]" />
			<button
				type="button"
				onClick={onOlder}
				disabled={total === 0}
				aria-label={t("chat.find.older")}
				className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--omp-text-muted)] hover:bg-[var(--omp-selected-bg)] disabled:opacity-40"
			>
				<ChevronUp size={15} />
			</button>
			<button
				type="button"
				onClick={onNewer}
				disabled={total === 0}
				aria-label={t("chat.find.newer")}
				className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--omp-text-muted)] hover:bg-[var(--omp-selected-bg)] disabled:opacity-40"
			>
				<ChevronDown size={15} />
			</button>
			<button
				type="button"
				onClick={onClose}
				aria-label={t("chat.find.close")}
				className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--omp-text-muted)] hover:bg-[var(--omp-selected-bg)]"
			>
				<X size={15} />
			</button>
			<span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
				{statusText}
			</span>
		</div>
	);
}

export interface TranscriptFindTicksProps {
	ticks: readonly FindTick[];
	currentOrdinal: number | null;
}

export function TranscriptFindTicks(props: TranscriptFindTicksProps): ReactElement | null {
	const { ticks, currentOrdinal } = props;
	if (ticks.length === 0) return null;
	return (
		<div aria-hidden className="pointer-events-none absolute inset-y-0 right-1 z-10 w-1">
			{ticks.map(tick => {
				const isCurrent = tick.ordinal === currentOrdinal;
				return (
					<span
						key={tick.ordinal}
						data-find-tick
						data-find-tick-current={isCurrent ? "true" : undefined}
						style={{ top: `${tick.fraction * 100}%` }}
						className={cx(
							"absolute h-0.5 rounded-full bg-[var(--omp-find-match)]",
							isCurrent ? "left-0 w-full bg-[var(--omp-find-current)]" : "left-0 w-1/2",
						)}
					/>
				);
			})}
		</div>
	);
}
