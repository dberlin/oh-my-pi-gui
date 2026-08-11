/**
 * Chip/tag editor for `string[]` settings (e.g. disabledProviders,
 * enabledModels, cycleOrder). Replaces the raw-JSON textarea for the common
 * array-of-strings shape: existing items as removable chips, an input that
 * appends on Enter/comma/blur, Backspace-on-empty removes the last chip.
 * Commits the whole array on every change (the parent writes via setSetting).
 * Ordered settings (webSearchOrder, imageOrder — TUI MultiSelectSubmenu
 * ordered parity) additionally render each chip's position and move up/down
 * controls, since their array order carries priority semantics.
 */

import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useRef, useState } from "react";
import { useT } from "../../../lib/i18n";

export interface ArrayChipEditorProps {
	values: string[];
	onCommit: (values: string[]) => void;
	disabled?: boolean;
	placeholder?: string;
	/** When true, render positions and move up/down controls (order is meaningful). */
	ordered?: boolean;
}

export function ArrayChipEditor({ values, onCommit, disabled, placeholder, ordered }: ArrayChipEditorProps) {
	const t = useT();
	const [draft, setDraft] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	const add = (raw: string) => {
		const items = raw
			.split(",")
			.map(s => s.trim())
			.filter(s => s.length > 0 && !values.includes(s));
		if (items.length === 0) return;
		onCommit([...values, ...items]);
		setDraft("");
	};

	const removeAt = (index: number) => {
		onCommit(values.filter((_, i) => i !== index));
	};

	const move = (index: number, delta: -1 | 1) => {
		const to = index + delta;
		if (to < 0 || to >= values.length) return;
		const next = [...values];
		next[index] = next[to];
		next[to] = values[index];
		onCommit(next);
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter" || event.key === ",") {
			event.preventDefault();
			add(draft);
		} else if (event.key === "Backspace" && draft === "" && values.length > 0) {
			removeAt(values.length - 1);
		}
	};

	return (
		<div
			className="flex min-h-[38px] w-full flex-wrap items-center gap-1 rounded-md border border-(--omp-input-border) bg-(--omp-input-bg) px-2 py-1.5 transition-colors focus-within:border-(--omp-input-focus-border)"
			onClick={() => inputRef.current?.focus()}
		>
			{values.map((value, index) => (
				<span
					className="inline-flex items-center gap-1 rounded bg-(--omp-badge-bg) px-1.5 py-0.5 font-mono text-omp-sm text-(--omp-badge-text)"
					key={`${value}-${index}`}
				>
					{ordered && <span className="text-(--omp-dim)">{index + 1}.</span>}
					{value}
					{ordered && !disabled && (
						<span className="inline-flex flex-col">
							<button
								aria-label={t("settings.editors.chipMoveUp", { value })}
								className="text-(--omp-dim) hover:text-(--omp-text) disabled:opacity-30"
								disabled={index === 0}
								onClick={e => {
									e.stopPropagation();
									move(index, -1);
								}}
								type="button"
							>
								<ChevronUp size={9} />
							</button>
							<button
								aria-label={t("settings.editors.chipMoveDown", { value })}
								className="text-(--omp-dim) hover:text-(--omp-text) disabled:opacity-30"
								disabled={index === values.length - 1}
								onClick={e => {
									e.stopPropagation();
									move(index, 1);
								}}
								type="button"
							>
								<ChevronDown size={9} />
							</button>
						</span>
					)}
					{!disabled && (
						<button
							aria-label={t("settings.editors.chipRemove", { value })}
							className="text-(--omp-dim) hover:text-(--omp-error)"
							onClick={e => {
								e.stopPropagation();
								removeAt(index);
							}}
							type="button"
						>
							<X size={11} />
						</button>
					)}
				</span>
			))}
			{!disabled && (
				<input
					className="min-w-[70px] flex-1 bg-transparent font-mono text-omp-sm text-(--omp-text) outline-none placeholder:text-(--omp-dim)"
					disabled={disabled}
					onBlur={() => add(draft)}
					onChange={e => setDraft(e.target.value)}
					onKeyDown={onKeyDown}
					placeholder={values.length === 0 ? (placeholder ?? t("settings.editors.chipPlaceholder")) : ""}
					ref={inputRef}
					spellCheck={false}
					value={draft}
				/>
			)}
		</div>
	);
}
