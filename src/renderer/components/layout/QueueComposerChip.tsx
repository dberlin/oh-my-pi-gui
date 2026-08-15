/** Compact queue count control for the Main composer toolbar. */

import { ListOrdered } from "lucide-react";
import { useT } from "../../lib/i18n";

export function QueueComposerChip({ count, onOpen }: { count: number; onOpen: () => void }) {
	const t = useT();

	return (
		<button
			aria-label={`${t("dock.queue.manage")}: ${count}`}
			className="omp-pressable flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--omp-border)] px-2.5 text-omp-sm font-medium text-[var(--omp-muted)] hover:border-[var(--omp-border-strong)] hover:text-[var(--omp-text)]"
			onClick={onOpen}
			title={t("dock.queue.manage")}
			type="button"
		>
			<ListOrdered aria-hidden="true" size={13} />
			<span className="tabular-nums text-[var(--omp-text)]">{count}</span>
		</button>
	);
}
