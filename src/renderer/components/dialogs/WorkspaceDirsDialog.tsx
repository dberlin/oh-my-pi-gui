/**
 * Workspace-directories dialog (TUI /dirs /add-dir /remove-dir /move parity):
 * lists the session's roots with the primary (cwd) badge, adds roots via the
 * native directory picker, removes non-primary roots behind an inline
 * confirm, and moves the session file's cwd association to a picked directory
 * (move_session → toast + session rehydrate). Mutations are blocked while
 * streaming — the server also refuses with the "busy" code.
 */
import { FolderGit2, FolderPlus, PackageOpen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SshSessionTarget } from "../../../shared/ipc-types";
import type { RpcWorkspaceDirectoriesResult } from "../../../shared/rpc-types";
import { isSshSessionTarget } from "../../../shared/session-target";
import { useT } from "../../lib/i18n";
import {
	addWorkspaceDirectory,
	moveSessionTo,
	pickWorkspaceDirectory,
	type RpcWorkspaceDirectory,
	removeWorkspaceDirectory,
} from "../../lib/workspace-dirs";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, Modal, Spinner } from "../common";
import { RemoteWorkspaceDialog } from "./RemoteWorkspaceDialog";

interface RemoteDirectoryAction {
	kind: "add" | "move";
	tabId: string;
	hostAlias: string;
	initialPath: string;
	target: SshSessionTarget;
}

export function WorkspaceDirsDialog() {
	const t = useT();
	const open = useUiStore(state => state.workspaceDirsOpen);
	const close = useUiStore(state => state.closeWorkspaceDirs);
	const activeTab = useTabsStore(state => state.tabs.find(tab => tab.id === state.activeTabId));
	const busy = useSessionStore(state => state.isStreaming || state.isCompacting);
	const [directories, setDirectories] = useState<RpcWorkspaceDirectory[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [mutating, setMutating] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
	const [remoteAction, setRemoteAction] = useState<RemoteDirectoryAction | null>(null);

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const response = await window.omp.rpc.getDirectories();
			if (response.success) {
				setDirectories((response.data as RpcWorkspaceDirectoriesResult | undefined)?.directories ?? []);
			} else {
				setError(response.error);
			}
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!open) {
			setConfirmRemove(null);
			setRemoteAction(null);
			return;
		}
		void reload();
	}, [open, reload]);

	useEffect(() => {
		if (!remoteAction) return;
		if (
			activeTab?.id !== remoteAction.tabId ||
			!isSshSessionTarget(activeTab.target) ||
			activeTab.target !== remoteAction.target
		) {
			setRemoteAction(null);
		}
	}, [activeTab, remoteAction]);

	const onAdd = async (): Promise<void> => {
		if (activeTab && isSshSessionTarget(activeTab.target)) {
			setRemoteAction({
				kind: "add",
				tabId: activeTab.id,
				hostAlias: activeTab.target.hostAlias,
				target: activeTab.target,
				initialPath: activeTab.target.cwd,
			});
			return;
		}
		const path = await pickWorkspaceDirectory();
		if (!path) return;
		setMutating(true);
		try {
			const result = await addWorkspaceDirectory(path);
			if (result) setDirectories(result);
		} finally {
			setMutating(false);
		}
	};

	const onRemove = async (path: string): Promise<void> => {
		setMutating(true);
		setConfirmRemove(null);
		try {
			const result = await removeWorkspaceDirectory(path);
			if (result) setDirectories(result);
		} finally {
			setMutating(false);
		}
	};

	const onMove = async (): Promise<void> => {
		if (activeTab && isSshSessionTarget(activeTab.target)) {
			setRemoteAction({
				kind: "move",
				tabId: activeTab.id,
				hostAlias: activeTab.target.hostAlias,
				initialPath: activeTab.target.cwd,
				target: activeTab.target,
			});
			return;
		}
		const path = await pickWorkspaceDirectory();
		if (!path) return;
		setMutating(true);
		try {
			const moved = await moveSessionTo(path);
			// move_session returns only the new cwd — refetch for the post-move list.
			if (moved) await reload();
		} finally {
			setMutating(false);
		}
	};

	const onRemoteConfirm = async (target: SshSessionTarget): Promise<void> => {
		const request = remoteAction;
		const tabs = useTabsStore.getState();
		const active = tabs.tabs.find(tab => tab.id === tabs.activeTabId);
		setRemoteAction(null);
		if (!request || active?.id !== request.tabId || active.target !== request.target) return;
		setMutating(true);
		try {
			if (request.kind === "add") {
				const result = await addWorkspaceDirectory(target.cwd);
				if (result && useTabsStore.getState().activeTabId === request.tabId) setDirectories(result);
				return;
			}
			const moved = await moveSessionTo(target.cwd);
			if (moved && useTabsStore.getState().activeTabId === request.tabId) await reload();
		} finally {
			setMutating(false);
		}
	};

	return (
		<>
			<Modal onClose={close} open={open} size="md" title={t("workspaceDirs.title")}>
				<div className="flex flex-col gap-3">
					<div className="text-xs text-(--omp-dim)">{t("workspaceDirs.subtitle")}</div>
					<div className="max-h-[38vh] min-h-16 overflow-y-auto rounded-md border border-(--omp-border-muted)">
						{error ? (
							<div className="p-4 text-xs text-[var(--omp-error)]">{error}</div>
						) : loading ? (
							<div className="flex items-center justify-center gap-2 p-6 text-xs text-(--omp-dim)">
								<Spinner size="sm" /> {t("workspaceDirs.loading")}
							</div>
						) : directories.length === 0 ? (
							<div className="p-6 text-center text-xs text-(--omp-dim)">{t("workspaceDirs.empty")}</div>
						) : (
							directories.map(directory => (
								<div
									className="flex items-center gap-2 border-b border-(--omp-border-muted) px-3 py-2 last:border-b-0"
									key={directory.path}
								>
									<FolderGit2 className="shrink-0 text-(--omp-dim)" size={14} />
									<span
										className="min-w-0 flex-1 truncate font-mono text-xs text-(--omp-text)"
										title={directory.path}
									>
										{directory.path}
									</span>
									{directory.primary ? (
										<Badge variant="info">{t("workspaceDirs.primary")}</Badge>
									) : confirmRemove === directory.path ? (
										<span className="flex shrink-0 items-center gap-1">
											<Button
												disabled={mutating}
												onClick={() => void onRemove(directory.path)}
												size="sm"
												variant="danger"
											>
												{t("common.confirm")}
											</Button>
											<Button
												disabled={mutating}
												onClick={() => setConfirmRemove(null)}
												size="sm"
												variant="ghost"
											>
												{t("common.cancel")}
											</Button>
										</span>
									) : (
										<Button
											disabled={mutating || busy}
											icon={<Trash2 size={13} />}
											onClick={() => setConfirmRemove(directory.path)}
											size="sm"
											title={busy ? t("workspaceDirs.busy") : t("workspaceDirs.remove")}
											variant="ghost"
										/>
									)}
								</div>
							))
						)}
					</div>
					<div className="flex items-center justify-between gap-2">
						<Button
							disabled={mutating || busy || loading}
							icon={<FolderPlus size={14} />}
							onClick={() => void onAdd()}
							size="sm"
							title={busy ? t("workspaceDirs.busy") : undefined}
						>
							{t("workspaceDirs.add")}
						</Button>
					</div>
					<div className="rounded-md border border-(--omp-border-muted) p-3">
						<div className="mb-1 text-xs font-medium text-(--omp-text)">{t("workspaceDirs.moveTitle")}</div>
						<div className="mb-2 text-xs text-(--omp-dim)">{t("workspaceDirs.moveDesc")}</div>
						<Button
							disabled={mutating || busy || loading}
							icon={<PackageOpen size={14} />}
							onClick={() => void onMove()}
							size="sm"
							title={busy ? t("workspaceDirs.busy") : undefined}
						>
							{t("workspaceDirs.move")}
						</Button>
					</div>
				</div>
			</Modal>
			{remoteAction ? (
				<RemoteWorkspaceDialog
					hostAlias={remoteAction.hostAlias}
					initialPath={remoteAction.initialPath}
					tabId={remoteAction.tabId}
					target={remoteAction.target}
					onClose={() => setRemoteAction(null)}
					onConfirm={target => void onRemoteConfirm(target)}
				/>
			) : null}
		</>
	);
}
