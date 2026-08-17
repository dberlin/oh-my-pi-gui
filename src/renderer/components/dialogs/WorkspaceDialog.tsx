/**
 * Workspace manager (Codex-style): lists every known workspace (the cwds of
 * all sessions + the current project) with the current one highlighted, lets
 * the user jump to any of them (`setProject` → sidecar restarts there) or add
 * a new directory (native picker). Far richer than the bare breadcrumb picker.
 */

import { Check, Folder, FolderPlus, Server } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SshSessionTarget } from "../../../shared/ipc-types";
import { useSessionList } from "../../hooks/use-session-list";
import { basename, cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { moveSessionTo, pickWorkspaceDirectory } from "../../lib/workspace-dirs";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Modal, Spinner } from "../common";
import { RemoteWorkspaceDialog } from "./RemoteWorkspaceDialog";

interface WorkspaceRow {
	cwd: string;
	name: string;
	lastModified: number;
	sessionCount: number;
}

export function WorkspaceDialog({
	open,
	onClose,
	intent = "switch",
	location = "all",
}: {
	open: boolean;
	onClose: () => void;
	/** "switch" = jump between workspaces (breadcrumb); "new-session" = the "+"
	 * button — picking a workspace starts a NEW session there. */
	intent?: "switch" | "new-session";
	/** Restricts the new-session chooser when its caller already selected local or remote. */
	location?: "all" | "local" | "remote";
}) {
	const t = useT();
	const { sessions } = useSessionList("global");
	const cwd = useSessionStore(s => s.cwd);
	const workspaceLastUsed = useSidebarPrefs(s => s.workspaceLastUsed);
	const remoteHosts = useRemoteStore(state => state.hosts);
	const catalogStatus = useRemoteStore(state => state.catalogStatus);
	const loadCatalog = useRemoteStore(state => state.loadCatalog);
	const openSettings = useUiStore(state => state.openSettings);
	const activeTab = useTabsStore(state => state.tabs.find(tab => tab.id === state.activeTabId));
	const currentLocalCwd = activeTab?.target.type === "ssh" ? undefined : cwd;
	const activeRemoteTarget = intent === "switch" && activeTab?.target.type === "ssh" ? activeTab.target : undefined;
	const [remoteHostAlias, setRemoteHostAlias] = useState<string>();
	const remoteStartGeneration = useRef(0);
	const openRef = useRef(open);
	openRef.current = open;

	useEffect(() => {
		if (!open) {
			remoteStartGeneration.current += 1;
			setRemoteHostAlias(undefined);
			return;
		}
		if (intent === "new-session" && location !== "local") void loadCatalog();
	}, [intent, loadCatalog, location, open]);

	const workspaces = useMemo<WorkspaceRow[]>(() => {
		const byCwd = new Map<string, WorkspaceRow>();
		for (const session of sessions) {
			const modified = Date.parse(session.modified) || 0;
			const existing = byCwd.get(session.cwd);
			if (existing) {
				existing.sessionCount += 1;
				if (modified > existing.lastModified) existing.lastModified = modified;
			} else {
				byCwd.set(session.cwd, {
					cwd: session.cwd,
					name: basename(session.cwd) || session.cwd,
					lastModified: modified,
					sessionCount: 1,
				});
			}
		}
		// Ensure the current project appears even when it has no sessions yet.
		if (currentLocalCwd && !byCwd.has(currentLocalCwd)) {
			byCwd.set(currentLocalCwd, {
				cwd: currentLocalCwd,
				name: basename(currentLocalCwd) || currentLocalCwd,
				lastModified: 0,
				sessionCount: 0,
			});
		}
		for (const workspace of byCwd.values()) {
			workspace.lastModified = Math.max(workspace.lastModified, workspaceLastUsed[workspace.cwd] ?? 0);
		}
		return [...byCwd.values()].sort((a, b) => b.lastModified - a.lastModified);
	}, [sessions, currentLocalCwd, workspaceLastUsed]);

	const sortedRemoteHosts = useMemo(
		() => Object.values(remoteHosts).sort((a, b) => a.host.alias.localeCompare(b.host.alias)),
		[remoteHosts],
	);

	/**
	 * Session-replacing actions (new session here, workspace jump, open
	 * project) abort the in-flight run server-side — refuse to kill it
	 * silently, same busy guard as the menu/deep-link paths.
	 */
	const guardBusy = (): boolean => {
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (!isStreaming && !isCompacting) return false;
		toast({ variant: "warning", message: t("sessionSwitch.busyBlocked") });
		return true;
	};

	const startLocalSession = async (target: string): Promise<void> => {
		try {
			const tabId = await useTabsStore.getState().openTab({ cwd: target, target: { type: "local" } });
			if (tabId) onClose();
		} catch (error) {
			toast({ variant: "error", title: t("sidebar.newFailed"), message: String(error) });
		}
	};

	const pick = async (target: string) => {
		if (intent === "new-session") {
			await startLocalSession(target);
			return;
		}
		if (target === cwd) {
			onClose();
			return;
		}
		if (guardBusy()) return;
		// Switching workspace restarts the sidecar there, which boots a fresh
		// session — that IS the new session for the "+" flow.
		try {
			const ok = await window.omp.sidecar.setProject(target);
			if (!ok) {
				toast({ variant: "error", title: t("workspaces.switchFailed"), message: target });
				return;
			}
			onClose();
		} catch (error) {
			toast({ variant: "error", title: t("workspaces.switchFailed"), message: String(error) });
		}
	};

	const addWorkspace = async () => {
		if (intent === "new-session") {
			const picked = await pickWorkspaceDirectory().catch(() => undefined);
			if (picked) await startLocalSession(picked);
			return;
		}
		if (guardBusy()) return;
		try {
			const picked = await window.omp.sidecar.selectProject();
			if (picked) onClose();
		} catch (error) {
			toast({ variant: "error", title: t("titlebar.openProjectFailed"), message: String(error) });
		}
	};

	const closeDialog = (): void => {
		remoteStartGeneration.current += 1;
		setRemoteHostAlias(undefined);
		onClose();
	};

	const startRemoteSession = async (target: SshSessionTarget): Promise<void> => {
		const generation = ++remoteStartGeneration.current;
		setRemoteHostAlias(undefined);
		const tabId = await useTabsStore.getState().openTab({ cwd: target.cwd, target });
		if (!tabId) return;
		await useRemoteStore.getState().noteWorkspace(target.hostAlias, target.cwd);
		if (generation === remoteStartGeneration.current && openRef.current) closeDialog();
	};

	const moveRemoteSession = async (target: SshSessionTarget): Promise<void> => {
		if (!activeRemoteTarget || guardBusy()) return;
		try {
			if (!(await moveSessionTo(target.cwd))) return;
			await useRemoteStore.getState().noteWorkspace(activeRemoteTarget.hostAlias, target.cwd);
			closeDialog();
		} catch (error) {
			toast({ variant: "error", title: t("workspaceDirs.move"), message: String(error) });
		}
	};

	if (activeRemoteTarget && activeTab) {
		return open ? (
			<RemoteWorkspaceDialog
				hostAlias={activeRemoteTarget.hostAlias}
				initialPath={activeRemoteTarget.cwd}
				onClose={closeDialog}
				onConfirm={target => void moveRemoteSession(target)}
				tabId={activeTab.id}
				target={activeRemoteTarget}
			/>
		) : null;
	}

	return (
		<>
			<Modal
				open={open}
				title={
					intent !== "new-session"
						? t("workspaces.title")
						: location === "local"
							? t("workspaces.newLocalSessionTitle")
							: location === "remote"
								? t("workspaces.newRemoteSessionTitle")
								: t("workspaces.newSessionTitle")
				}
				onClose={closeDialog}
				size="md"
			>
				<div className="flex flex-col gap-2">
					{location !== "remote" ? (
						<>
							<button
								type="button"
								onClick={() => void addWorkspace()}
								className="omp-pressable flex items-center gap-2.5 rounded-xl border border-dashed border-[var(--omp-border)] px-3 py-2.5 text-omp-lg font-medium text-[var(--omp-accent)] transition-colors hover:border-[var(--omp-accent)] hover:bg-[var(--omp-selected-bg)]"
							>
								<FolderPlus size={16} />
								{t("workspaces.add")}
							</button>

							<div className="max-h-[46vh] overflow-y-auto">
								{workspaces.length === 0 ? (
									<div className="px-2 py-8 text-center text-omp-md text-[var(--omp-muted)]">
										{t("workspaces.empty")}
									</div>
								) : (
									workspaces.map(ws => {
										const isCurrent = ws.cwd === currentLocalCwd;
										return (
											<button
												key={ws.cwd}
												type="button"
												onClick={() => void pick(ws.cwd)}
												className={cx(
													"omp-pressable group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
													isCurrent ? "bg-[var(--omp-selected-bg)]" : "hover:bg-[var(--omp-selected-bg)]",
												)}
											>
												<Folder
													size={16}
													className={cx(
														"shrink-0",
														isCurrent ? "text-[var(--omp-accent)]" : "text-[var(--omp-dim)]",
													)}
												/>
												<span className="min-w-0 flex-1">
													<span className="flex items-baseline gap-2">
														<span
															className={cx(
																"truncate text-omp-lg font-medium",
																isCurrent ? "text-[var(--omp-text)]" : "text-[var(--omp-muted)]",
															)}
														>
															{ws.name}
														</span>
														{ws.sessionCount > 0 && (
															<span className="shrink-0 text-omp-sm text-[var(--omp-dim)]">
																{t("workspaces.sessionCount", { count: ws.sessionCount })}
															</span>
														)}
													</span>
													<span className="block truncate text-omp-sm text-[var(--omp-dim)]">
														{ws.cwd}
													</span>
												</span>
												{isCurrent ? (
													<span className="flex shrink-0 items-center gap-1 text-omp-sm font-medium text-[var(--omp-accent)]">
														<Check size={13} />
														{t("workspaces.current")}
													</span>
												) : null}
											</button>
										);
									})
								)}
							</div>
						</>
					) : null}

					{intent === "new-session" && location !== "local" ? (
						<section
							className="border-t border-(--omp-border-muted) pt-3"
							aria-labelledby="remote-workspaces-title"
						>
							<h3
								className="mb-2 text-omp-xs font-semibold uppercase tracking-wider text-(--omp-dim)"
								id="remote-workspaces-title"
							>
								{t("workspaces.remoteHosts")}
							</h3>
							{catalogStatus === "loading" || catalogStatus === "idle" ? (
								<div className="flex items-center gap-2 px-2 py-4 text-omp-md text-(--omp-muted)" role="status">
									<Spinner size="sm" />
									{t("remote.history.loadingHosts")}
								</div>
							) : catalogStatus === "error" ? (
								<div className="flex items-center justify-between gap-3 px-2 py-3">
									<span className="text-omp-md text-(--omp-error)">{t("remote.history.catalogError")}</span>
									<Button onClick={() => void loadCatalog()} size="sm">
										{t("remote.history.retry")}
									</Button>
								</div>
							) : sortedRemoteHosts.length === 0 ? (
								<div className="px-2 py-3">
									<div className="text-omp-md font-medium text-(--omp-text)">{t("ssh.empty.title")}</div>
									<div className="mt-1 text-omp-sm text-(--omp-dim)">{t("ssh.empty.description")}</div>
									<Button className="mt-2" onClick={() => openSettings("ssh")} size="sm" variant="ghost">
										{t("remote.connection.openSettings")}
									</Button>
								</div>
							) : (
								<div className="flex flex-col">
									{sortedRemoteHosts.map(({ host }) => (
										<button
											className="omp-pressable flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--omp-selected-bg)]"
											key={host.alias}
											onClick={() => setRemoteHostAlias(host.alias)}
											type="button"
										>
											<Server className="shrink-0 text-(--omp-accent)" size={16} />
											<span className="min-w-0 flex-1">
												<span className="block truncate text-omp-lg font-medium text-(--omp-text)">
													{host.alias}
												</span>
												<span className="block truncate font-mono text-omp-sm text-(--omp-dim)">
													{host.recentWorkspaces[0] ?? host.host.host}
												</span>
											</span>
										</button>
									))}
								</div>
							)}
						</section>
					) : null}
				</div>
			</Modal>
			{remoteHostAlias ? (
				<RemoteWorkspaceDialog
					hostAlias={remoteHostAlias}
					onClose={() => setRemoteHostAlias(undefined)}
					onConfirm={target => void startRemoteSession(target)}
				/>
			) : null}
		</>
	);
}
