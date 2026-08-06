/**
 * Foreign-session import wizard (Claude/Codex → OMP copy): list sessions from
 * a source, multi-select, import each as a fresh OMP session (the source data
 * is never modified). A single import opens the new session via the normal
 * switch flow; multiple imports land in the sidebar list with a count toast.
 * Backs the `list_foreign_sessions` / `import_foreign_session` RPCs.
 */

import { Download, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcForeignSessionInfo } from "../../../shared/rpc-types";
import { requestSessionSwitch } from "../../hooks/use-session-switch";
import { cx, formatTimeAgo } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Input, Modal, Spinner } from "../common";

type Source = "claude" | "codex";

const SOURCES: Source[] = ["claude", "codex"];

interface SourceState {
	loading: boolean;
	error: string | null;
	sessions: RpcForeignSessionInfo[];
}

export function ImportForeignDialog() {
	const t = useT();
	const close = useUiStore(s => s.closeImportDialog);
	const [source, setSource] = useState<Source>("claude");
	const [states, setStates] = useState<Partial<Record<Source, SourceState>>>({});
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [importing, setImporting] = useState(false);

	const load = useCallback(
		async (target: Source, force = false) => {
			const existing = states[target];
			if (!force && existing && (existing.sessions.length > 0 || existing.error !== null || existing.loading)) {
				return;
			}
			setStates(current => ({ ...current, [target]: { loading: true, error: null, sessions: [] } }));
			const response = await window.omp.rpc.listForeignSessions(target);
			if (!response.success) {
				setStates(current => ({
					...current,
					[target]: { loading: false, error: response.error, sessions: [] },
				}));
				return;
			}
			const data = response.data as { sessions?: RpcForeignSessionInfo[] } | undefined;
			setStates(current => ({
				...current,
				[target]: { loading: false, error: null, sessions: data?.sessions ?? [] },
			}));
		},
		[states],
	);

	// Reload only when the source tab changes (load() closes over cached states).
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed reload by design
	useEffect(() => {
		void load(source);
	}, [source]);

	const state = states[source];
	const filtered = useMemo(() => {
		const sessions = state?.sessions ?? [];
		const q = query.trim().toLowerCase();
		if (!q) return sessions;
		return sessions.filter(
			session =>
				(session.title ?? "").toLowerCase().includes(q) ||
				(session.firstMessage ?? "").toLowerCase().includes(q) ||
				session.cwd.toLowerCase().includes(q),
		);
	}, [state, query]);

	const toggle = (id: string) => {
		setSelected(current => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const doImport = async () => {
		const sessions = (state?.sessions ?? []).filter(session => selected.has(session.id));
		if (sessions.length === 0 || importing) return;
		setImporting(true);
		try {
			let firstImported: { sessionPath: string; sessionId: string; cwd: string } | null = null;
			let importedCount = 0;
			for (const session of sessions) {
				const response = await window.omp.rpc.importForeignSession(source, session.id);
				if (!response.success) {
					toast({ variant: "error", title: t("import.failed"), message: response.error });
					continue;
				}
				const data = response.data as { sessionPath?: string; sessionId?: string } | undefined;
				if (data?.sessionPath && data.sessionId) {
					importedCount += 1;
					firstImported ??= { sessionPath: data.sessionPath, sessionId: data.sessionId, cwd: session.cwd };
				}
			}
			if (importedCount === 0) return;
			if (sessions.length === 1 && firstImported) {
				close();
				requestSessionSwitch({
					path: firstImported.sessionPath,
					id: firstImported.sessionId,
					title: null,
					cwd: firstImported.cwd,
					created: "",
					modified: "",
					messageCount: 0,
					size: 0,
					status: "unknown",
					firstMessage: "",
				});
				return;
			}
			toast({ variant: "success", message: t("import.imported", { count: importedCount }) });
			setSelected(new Set());
			// Refresh the list: imported sessions were copies, the sources are unchanged.
		} finally {
			setImporting(false);
		}
	};

	return (
		<Modal open onClose={close} title={t("import.title")} size="lg">
			<div className="mb-3 flex items-center gap-2">
				{SOURCES.map(candidate => (
					<button
						key={candidate}
						type="button"
						onClick={() => setSource(candidate)}
						className={cx(
							"rounded-lg px-3 py-1.5 text-[12px] font-medium capitalize",
							source === candidate
								? "bg-(--omp-btn-primary-bg) text-(--omp-btn-primary-text)"
								: "border border-(--omp-border) text-(--omp-muted) hover:bg-(--omp-selected-bg)",
						)}
					>
						{candidate === "claude" ? "Claude" : "Codex"}
					</button>
				))}
				<span className="ml-auto">
					<Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("import.search")} />
				</span>
			</div>

			<div className="max-h-[46vh] min-h-[200px] overflow-y-auto rounded-lg border border-(--omp-border-muted)">
				{state?.loading && (
					<div className="flex h-32 items-center justify-center text-(--omp-dim)">
						<Loader2 size={16} className="animate-spin" />
					</div>
				)}
				{state?.error && (
					<div className="px-4 py-6 text-center text-[12px] text-(--omp-muted)">
						{t("import.sourceUnavailable", { source })}
						<div className="mt-1 text-[11px] text-(--omp-dim)">{state.error}</div>
					</div>
				)}
				{!state?.loading && !state?.error && filtered.length === 0 && (
					<div className="px-4 py-6 text-center text-[12px] text-(--omp-dim)">{t("import.empty")}</div>
				)}
				{!state?.loading &&
					!state?.error &&
					filtered.map(session => (
						<label
							key={session.id}
							className="flex cursor-pointer items-start gap-3 border-b border-(--omp-border-muted) px-3 py-2.5 last:border-0 hover:bg-(--omp-selected-bg)"
						>
							<input
								type="checkbox"
								checked={selected.has(session.id)}
								onChange={() => toggle(session.id)}
								className="mt-1"
							/>
							<span className="min-w-0 flex-1">
								<span className="block truncate text-[12.5px] font-medium text-(--omp-text)">
									{session.title ?? session.firstMessage ?? t("import.untitled")}
								</span>
								<span className="mt-0.5 block truncate font-mono text-[10.5px] text-(--omp-dim)">
									{session.cwd}
								</span>
							</span>
							<span className="shrink-0 text-right text-[10.5px] text-(--omp-dim)">
								{formatTimeAgo(session.modified)}
								{session.messageCount !== undefined && (
									<span className="block">{t("import.messages", { count: session.messageCount })}</span>
								)}
							</span>
						</label>
					))}
			</div>

			<div className="mt-3 flex items-center gap-3">
				<span className="text-[11px] text-(--omp-dim)">{t("import.copyNote")}</span>
				<span className="ml-auto">
					<Button
						disabled={selected.size === 0 || importing}
						icon={importing ? <Spinner size="sm" /> : <Download size={13} />}
						onClick={() => void doImport()}
						size="sm"
					>
						{selected.size > 0 ? t("import.importN", { count: selected.size }) : t("import.import")}
					</Button>
				</span>
			</div>
		</Modal>
	);
}
