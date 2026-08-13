import {
	ChevronRight,
	Folder,
	FolderSymlink,
	House,
	RefreshCw,
	Server,
	Settings2,
	TerminalSquare,
	Undo2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteDirectoryEntry, RemoteHostCatalogEntry, SshSessionTarget } from "../../../shared/ipc-types";
import { headLines, resultText, shortenPath } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useRemoteStore } from "../../stores/remote";
import { useUiStore } from "../../stores/ui";
import { Button, Input, Modal, Spinner } from "../common";
import { SSH_TAB_ID } from "../settings/settings-window-model";

type RemotePlatform = "windows" | "linux" | "macos";
type ValidationState = "idle" | "loading" | "valid" | "error";
type ListingState = "idle" | "loading" | "ready" | "error";
type PreflightState = "loading" | "ready" | "error";

interface RemoteBreadcrumb {
	label: string;
	path: string;
}

interface RemotePathModel {
	absolute: boolean;
	breadcrumbs: RemoteBreadcrumb[];
	parent: string | null;
}

interface RemoteRequestSlot {
	current: string | null;
}

function newRemoteRequestId(): string {
	return globalThis.crypto.randomUUID();
}

/** Renderer-only remote path parsing. It preserves the remote separator and never touches the local filesystem. */
function remotePathModel(path: string, platform: RemotePlatform): RemotePathModel {
	if (platform !== "windows") {
		if (!path.startsWith("/")) return { absolute: false, breadcrumbs: [], parent: null };
		const segments = path.split("/").filter(Boolean);
		const breadcrumbs: RemoteBreadcrumb[] = [{ label: "/", path: "/" }];
		let current = "";
		for (const segment of segments) {
			current += `/${segment}`;
			breadcrumbs.push({ label: segment, path: current });
		}
		const parent = segments.length === 0 ? null : segments.length === 1 ? "/" : `/${segments.slice(0, -1).join("/")}`;
		return { absolute: true, breadcrumbs, parent };
	}

	const drive = /^([a-zA-Z]:)([\\/])(.*)$/.exec(path);
	if (drive) {
		const separator = drive[2];
		const root = `${drive[1]}${separator}`;
		const segments = drive[3].split(/[\\/]/).filter(Boolean);
		const breadcrumbs: RemoteBreadcrumb[] = [{ label: root, path: root }];
		let current = root;
		for (const segment of segments) {
			current = current.endsWith(separator) ? `${current}${segment}` : `${current}${separator}${segment}`;
			breadcrumbs.push({ label: segment, path: current });
		}
		const parent =
			segments.length === 0
				? null
				: segments.length === 1
					? root
					: `${root}${segments.slice(0, -1).join(separator)}`;
		return { absolute: true, breadcrumbs, parent };
	}

	const unc = /^(\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/](.*))?$/.exec(path);
	if (!unc) return { absolute: false, breadcrumbs: [], parent: null };
	const separator = unc[1] === "//" ? "/" : "\\";
	const root = `${unc[1]}${unc[2]}${separator}${unc[3]}${separator}`;
	const segments = (unc[4] ?? "").split(/[\\/]/).filter(Boolean);
	const breadcrumbs: RemoteBreadcrumb[] = [{ label: root, path: root }];
	let current = root;
	for (const segment of segments) {
		current = current.endsWith(separator) ? `${current}${segment}` : `${current}${separator}${segment}`;
		breadcrumbs.push({ label: segment, path: current });
	}
	const parent =
		segments.length === 0 ? null : segments.length === 1 ? root : `${root}${segments.slice(0, -1).join(separator)}`;
	return { absolute: true, breadcrumbs, parent };
}

function copiedTarget(host: RemoteHostCatalogEntry, cwd: string): SshSessionTarget {
	return {
		type: "ssh",
		hostAlias: host.alias,
		host: { ...host.host },
		originCwd: cwd,
		cwd,
		...(host.executableOverride ? { executableOverride: host.executableOverride } : {}),
	};
}

function remoteErrorText(error: unknown): string {
	return headLines(resultText(error), 3).head;
}

export interface RemoteWorkspaceDialogProps {
	hostAlias: string;
	initialPath?: string;
	/** Existing-tab mode: browse against this immutable pool-owned snapshot. */
	target?: SshSessionTarget;
	/** Owning tab required with `target`; main verifies caller ownership and exact identity. */
	tabId?: string;
	onConfirm(target: SshSessionTarget): void;
	onClose(): void;
}

export function RemoteWorkspaceDialog({
	hostAlias,
	initialPath,
	target: immutableTarget,
	tabId,
	onConfirm,
	onClose,
}: RemoteWorkspaceDialogProps) {
	const t = useT();
	const tabTarget = immutableTarget && tabId ? immutableTarget : undefined;
	const catalogHost = useRemoteStore(state => state.hosts[hostAlias]?.host);
	const immutableHost = useMemo<RemoteHostCatalogEntry | undefined>(
		() =>
			tabTarget
				? {
						alias: tabTarget.hostAlias,
						host: { ...tabTarget.host },
						recentWorkspaces: [tabTarget.cwd],
						...(tabTarget.executableOverride ? { executableOverride: tabTarget.executableOverride } : {}),
					}
				: undefined,
		[tabTarget],
	);
	const host = immutableHost ?? catalogHost;
	const existingTabMode = tabTarget !== undefined;
	const effectiveHostAlias = tabTarget?.hostAlias ?? hostAlias;
	const catalogStatus = useRemoteStore(state => state.catalogStatus);
	const loadCatalog = useRemoteStore(state => state.loadCatalog);
	const setCatalog = useRemoteStore(state => state.setCatalog);
	const openSettings = useUiStore(state => state.openSettings);

	const [open, setOpen] = useState(true);
	const [preflightState, setPreflightState] = useState<PreflightState>("loading");
	const [preflightError, setPreflightError] = useState<string | null>(null);
	const [runtimeTarget, setRuntimeTarget] = useState<SshSessionTarget | null>(null);
	const [platform, setPlatform] = useState<RemotePlatform>("linux");
	const [home, setHome] = useState("");
	const [executable, setExecutable] = useState("");
	const [pathInput, setPathInput] = useState("");
	const [selectedPath, setSelectedPath] = useState("");
	const [validatedTarget, setValidatedTarget] = useState<SshSessionTarget | null>(null);
	const [validationState, setValidationState] = useState<ValidationState>("idle");
	const [validationError, setValidationError] = useState<string | null>(null);
	const [entries, setEntries] = useState<RemoteDirectoryEntry[]>([]);
	const [listingState, setListingState] = useState<ListingState>("idle");
	const [listingError, setListingError] = useState<string | null>(null);
	const [showHidden, setShowHidden] = useState(false);
	const [overrideOpen, setOverrideOpen] = useState(false);
	const [overrideDraft, setOverrideDraft] = useState("");
	const [overrideSaving, setOverrideSaving] = useState(false);
	const [overrideError, setOverrideError] = useState<string | null>(null);

	const openRef = useRef(true);
	const preflightRequest = useRef<string | null>(null);
	const validationRequest = useRef<string | null>(null);
	const listingRequest = useRef<string | null>(null);
	const preflightGeneration = useRef(0);
	const pathGeneration = useRef(0);
	const listingGeneration = useRef(0);
	const overrideGeneration = useRef(0);
	const showHiddenRef = useRef(false);
	const hostAliasRef = useRef(hostAlias);
	hostAliasRef.current = hostAlias;

	const cancelRequest = useCallback((slot: RemoteRequestSlot): void => {
		const requestId = slot.current;
		if (!requestId) return;
		slot.current = null;
		void window.omp.remote.cancel(requestId).catch(() => undefined);
	}, []);
	const replaceRequest = useCallback(
		(slot: RemoteRequestSlot): string => {
			cancelRequest(slot);
			const requestId = newRemoteRequestId();
			slot.current = requestId;
			return requestId;
		},
		[cancelRequest],
	);
	const cancelOutstandingRequests = useCallback((): void => {
		cancelRequest(preflightRequest);
		cancelRequest(validationRequest);
		cancelRequest(listingRequest);
	}, [cancelRequest]);

	const requestListing = useCallback(
		(target: SshSessionTarget, path: string, hidden: boolean, pathRequest?: number): void => {
			const generation = ++listingGeneration.current;
			const requestId = replaceRequest(listingRequest);
			setListingState("loading");
			const listing = window.omp.remote.listDirectories(
				target,
				path,
				hidden,
				existingTabMode ? tabId : undefined,
				requestId,
			);
			void listing
				.then(result => {
					if (!openRef.current || generation !== listingGeneration.current) return;
					if (pathRequest !== undefined && pathRequest !== pathGeneration.current) return;
					if (!result.ok) {
						setEntries([]);
						setListingState("error");
						setListingError(remoteErrorText(result.error));
						return;
					}
					setEntries(
						result.entries.filter(entry => entry.kind === "directory" || entry.kind === "symlink-directory"),
					);
					setListingState("ready");
				})
				.catch(error => {
					if (!openRef.current || generation !== listingGeneration.current) return;
					if (pathRequest !== undefined && pathRequest !== pathGeneration.current) return;
					setEntries([]);
					setListingState("error");
					setListingError(remoteErrorText(error));
				})
				.finally(() => {
					if (listingRequest.current === requestId) listingRequest.current = null;
				});
		},
		[existingTabMode, replaceRequest, tabId],
	);

	const requestPath = useCallback(
		(target: SshSessionTarget, remotePlatform: RemotePlatform, path: string, hidden: boolean): void => {
			const generation = ++pathGeneration.current;
			listingGeneration.current += 1;
			cancelRequest(validationRequest);
			cancelRequest(listingRequest);
			setPathInput(path);
			setSelectedPath(path);
			setValidatedTarget(null);
			setValidationError(null);
			setListingError(null);
			setEntries([]);
			if (!remotePathModel(path, remotePlatform).absolute) {
				setValidationState("error");
				setValidationError(t("remote.picker.absoluteRequired"));
				setListingState("idle");
				return;
			}

			setValidationState("loading");
			requestListing(target, path, hidden, generation);
			const requestId = replaceRequest(validationRequest);
			const validation = window.omp.remote.validateDirectory(
				target,
				path,
				existingTabMode ? tabId : undefined,
				requestId,
			);
			void validation
				.then(result => {
					if (!openRef.current || generation !== pathGeneration.current) return;
					if (!result.ok) {
						setValidationState("error");
						setValidationError(remoteErrorText(result.error));
						return;
					}
					const nextTarget: SshSessionTarget = {
						...target,
						host: { ...target.host },
						originCwd: result.path,
						cwd: result.path,
					};
					setPathInput(result.path);
					setSelectedPath(result.path);
					setValidatedTarget(nextTarget);
					setValidationState("valid");
				})
				.catch(error => {
					if (!openRef.current || generation !== pathGeneration.current) return;
					setValidationState("error");
					setValidationError(remoteErrorText(error));
				})
				.finally(() => {
					if (validationRequest.current === requestId) validationRequest.current = null;
				});
		},
		[cancelRequest, existingTabMode, replaceRequest, requestListing, t, tabId],
	);

	useEffect(() => {
		if (!open) return;
		openRef.current = true;
		cancelOutstandingRequests();
		const generation = ++preflightGeneration.current;
		pathGeneration.current += 1;
		listingGeneration.current += 1;
		overrideGeneration.current += 1;
		setOverrideSaving(false);
		setPreflightState("loading");
		setPreflightError(null);
		setRuntimeTarget(null);
		setValidatedTarget(null);
		setValidationState("idle");
		setValidationError(null);
		setListingState("idle");
		setListingError(null);
		setEntries([]);

		if (!host) {
			if (!existingTabMode && catalogStatus === "idle") void loadCatalog();
			if (catalogStatus === "ready" || catalogStatus === "error" || existingTabMode) {
				setPreflightState("error");
				setPreflightError(t("remote.connection.hostUnavailable", { host: effectiveHostAlias }));
			}
			return cancelOutstandingRequests;
		}

		setOverrideDraft(host.executableOverride ?? "");
		overrideGeneration.current += 1;
		setOverrideSaving(false);
		setOverrideError(null);
		const seedPath = tabTarget ? tabTarget.cwd : initialPath || host.recentWorkspaces[0] || "";
		const target = tabTarget
			? { ...tabTarget, host: { ...tabTarget.host } }
			: copiedTarget(host, seedPath || (host.host.os === "windows" ? "C:\\" : "/"));
		const requestId = replaceRequest(preflightRequest);
		const preflight = window.omp.remote.preflight(target, existingTabMode ? tabId : undefined, requestId);
		void preflight
			.then(result => {
				if (!openRef.current || generation !== preflightGeneration.current) return;
				if (!result.ok) {
					setPreflightState("error");
					setPreflightError(remoteErrorText(result.error));
					return;
				}
				const canonicalTarget = existingTabMode
					? { ...result.target, host: { ...result.target.host } }
					: copiedTarget(host, seedPath || result.home);
				setRuntimeTarget(canonicalTarget);
				setPlatform(result.platform);
				setHome(result.home);
				setExecutable(result.executable);
				setPreflightState("ready");
				requestPath(canonicalTarget, result.platform, seedPath || result.home, showHiddenRef.current);
			})
			.catch(error => {
				if (!openRef.current || generation !== preflightGeneration.current) return;
				setPreflightState("error");
				setPreflightError(remoteErrorText(error));
			})
			.finally(() => {
				if (preflightRequest.current === requestId) preflightRequest.current = null;
			});
		return cancelOutstandingRequests;
	}, [
		cancelOutstandingRequests,
		catalogStatus,
		effectiveHostAlias,
		existingTabMode,
		host,
		initialPath,
		loadCatalog,
		open,
		replaceRequest,
		requestPath,
		t,
		tabId,
		tabTarget,
	]);

	const pathModel = useMemo(() => remotePathModel(pathInput, platform), [pathInput, platform]);

	const closeDialog = (): void => {
		openRef.current = false;
		preflightGeneration.current += 1;
		pathGeneration.current += 1;
		listingGeneration.current += 1;
		overrideGeneration.current += 1;
		cancelOutstandingRequests();
		setOpen(false);
		onClose();
	};

	const changePathInput = (value: string): void => {
		pathGeneration.current += 1;
		listingGeneration.current += 1;
		cancelRequest(validationRequest);
		cancelRequest(listingRequest);
		setPathInput(value);
		setSelectedPath("");
		setValidatedTarget(null);
		setValidationState("idle");
		setValidationError(null);
		setListingState("idle");
		setListingError(null);
		setEntries([]);
	};

	const retryPreflight = (): void => {
		if (!host) {
			setPreflightState("loading");
			setPreflightError(null);
			void loadCatalog();
			return;
		}
		cancelOutstandingRequests();
		const generation = ++preflightGeneration.current;
		pathGeneration.current += 1;
		listingGeneration.current += 1;
		setPreflightState("loading");
		setPreflightError(null);
		const seedPath = tabTarget ? tabTarget.cwd : initialPath || host.recentWorkspaces[0] || "";
		const target = tabTarget
			? { ...tabTarget, host: { ...tabTarget.host } }
			: copiedTarget(host, seedPath || (host.host.os === "windows" ? "C:\\" : "/"));
		const requestId = replaceRequest(preflightRequest);
		const preflight = window.omp.remote.preflight(target, existingTabMode ? tabId : undefined, requestId);
		void preflight
			.then(result => {
				if (!openRef.current || generation !== preflightGeneration.current) return;
				if (!result.ok) {
					setPreflightState("error");
					setPreflightError(remoteErrorText(result.error));
					return;
				}
				const canonicalTarget = existingTabMode
					? { ...result.target, host: { ...result.target.host } }
					: copiedTarget(host, seedPath || result.home);
				setRuntimeTarget(canonicalTarget);
				setPlatform(result.platform);
				setHome(result.home);
				setExecutable(result.executable);
				setPreflightState("ready");
				requestPath(canonicalTarget, result.platform, seedPath || result.home, showHiddenRef.current);
			})
			.catch(error => {
				if (!openRef.current || generation !== preflightGeneration.current) return;
				setPreflightState("error");
				setPreflightError(remoteErrorText(error));
			})
			.finally(() => {
				if (preflightRequest.current === requestId) preflightRequest.current = null;
			});
	};

	const saveOverride = (): void => {
		if (existingTabMode) return;
		const generation = ++overrideGeneration.current;
		const requestHostAlias = effectiveHostAlias;
		setOverrideSaving(true);
		setOverrideError(null);
		const value = overrideDraft.length > 0 ? overrideDraft : null;
		void window.omp.remote
			.setExecutableOverride(requestHostAlias, value)
			.then(result => {
				if (
					!openRef.current ||
					generation !== overrideGeneration.current ||
					requestHostAlias !== hostAliasRef.current
				)
					return;
				if (!result.ok) {
					setOverrideError(remoteErrorText(result.error));
					return;
				}
				setCatalog(result.catalog);
				setOverrideOpen(false);
			})
			.catch(error => {
				if (
					!openRef.current ||
					generation !== overrideGeneration.current ||
					requestHostAlias !== hostAliasRef.current
				)
					return;
				setOverrideError(remoteErrorText(error));
			})
			.finally(() => {
				if (
					!openRef.current ||
					generation !== overrideGeneration.current ||
					requestHostAlias !== hostAliasRef.current
				)
					return;
				setOverrideSaving(false);
			});
	};
	const confirm = (): void => {
		if (!validatedTarget || validationState !== "valid") return;
		openRef.current = false;
		preflightGeneration.current += 1;
		pathGeneration.current += 1;
		listingGeneration.current += 1;
		overrideGeneration.current += 1;
		cancelOutstandingRequests();
		setOpen(false);
		onConfirm({ ...validatedTarget, host: { ...validatedTarget.host } });
	};

	const canRetryPath = runtimeTarget !== null && pathInput.length > 0;
	const confirmExplanation =
		validationState === "loading"
			? t("remote.picker.confirmValidating")
			: validationState !== "valid"
				? t("remote.picker.confirmNeedsValidation")
				: undefined;

	return (
		<Modal
			bodyClassName="p-0"
			onClose={closeDialog}
			open={open}
			panelClassName="min-h-0"
			size="picker"
			title={t("remote.picker.title")}
		>
			<div className="flex min-h-0 flex-col">
				<div className="flex flex-wrap items-center gap-2 border-b border-(--omp-border-muted) px-5 py-3">
					<span className="flex min-w-0 items-center gap-2 text-omp-md font-medium text-(--omp-text)">
						<Server aria-hidden="true" className="shrink-0 text-(--omp-accent)" size={14} />
						<span className="truncate" title={effectiveHostAlias}>
							{shortenPath(effectiveHostAlias)}
						</span>
					</span>
					{preflightState === "ready" && executable ? (
						<span
							className="ml-auto flex min-w-0 items-center gap-1.5 font-mono text-omp-xs text-(--omp-dim)"
							title={executable}
						>
							<TerminalSquare aria-hidden="true" className="shrink-0" size={13} />
							<span className="truncate">{shortenPath(executable)}</span>
						</span>
					) : null}
					{!existingTabMode ? (
						<Button
							aria-expanded={overrideOpen}
							icon={<Settings2 aria-hidden="true" size={13} />}
							onClick={() => setOverrideOpen(current => !current)}
							size="sm"
							variant="ghost"
						>
							{t("remote.picker.overrideToggle")}
						</Button>
					) : null}
				</div>

				{!existingTabMode && overrideOpen ? (
					<div className="border-b border-(--omp-border-muted) px-5 py-3">
						<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
							<div className="min-w-0 flex-1">
								<Input
									error={overrideError ?? undefined}
									hint={t("remote.picker.overrideHint")}
									label={t("remote.picker.overrideLabel")}
									mono
									onChange={event => setOverrideDraft(event.target.value)}
									value={overrideDraft}
								/>
							</div>
							<Button loading={overrideSaving} onClick={saveOverride} size="sm" variant="primary">
								{t("remote.picker.overrideSave")}
							</Button>
						</div>
					</div>
				) : null}

				{preflightState === "loading" ? (
					<div
						className="flex min-h-64 flex-col items-center justify-center gap-3 px-5 py-10 text-omp-md text-(--omp-muted)"
						role="status"
					>
						<Spinner />
						<span>{t("remote.connection.connecting", { host: effectiveHostAlias })}</span>
					</div>
				) : preflightState === "error" ? (
					<div className="flex min-h-64 flex-col items-start justify-center gap-3 px-5 py-8">
						<div className="text-omp-lg font-semibold text-(--omp-text)">{t("remote.connection.failed")}</div>
						<div className="max-w-full break-words text-omp-md text-(--omp-error)" role="alert">
							{preflightError}
						</div>
						<div className="flex flex-wrap gap-2">
							<Button onClick={retryPreflight} variant="primary">
								{t("remote.connection.retry")}
							</Button>
							<Button onClick={() => openSettings(SSH_TAB_ID)}>{t("remote.connection.openSettings")}</Button>
						</div>
					</div>
				) : (
					<>
						<div className="flex flex-col gap-3 border-b border-(--omp-border-muted) px-5 py-3">
							{host && (host.recentWorkspaces.length > 0 || home) ? (
								<div className="flex flex-wrap items-center gap-1.5">
									<span className="mr-1 text-omp-xs font-medium text-(--omp-dim)">
										{t("remote.picker.quickPaths")}
									</span>
									{home ? (
										<Button
											icon={<House aria-hidden="true" size={13} />}
											onClick={() => runtimeTarget && requestPath(runtimeTarget, platform, home, showHidden)}
											size="sm"
											variant="ghost"
										>
											{t("remote.picker.home")}
										</Button>
									) : null}
									{host.recentWorkspaces.map(recent => (
										<Button
											className="max-w-48"
											key={recent}
											onClick={() =>
												runtimeTarget && requestPath(runtimeTarget, platform, recent, showHidden)
											}
											size="sm"
											title={recent}
											variant="ghost"
										>
											<span className="truncate">{shortenPath(recent)}</span>
										</Button>
									))}
								</div>
							) : null}

							<div className="flex flex-col gap-2 sm:flex-row sm:items-end">
								<div className="min-w-0 flex-1">
									<Input
										error={validationError ?? undefined}
										label={t("remote.picker.pathLabel")}
										mono
										onChange={event => changePathInput(event.target.value)}
										onKeyDown={event => {
											if (event.key === "Enter" && runtimeTarget) {
												event.preventDefault();
												requestPath(runtimeTarget, platform, pathInput, showHidden);
											}
										}}
										placeholder={platform === "windows" ? "C:\\Users\\name\\project" : "/home/name/project"}
										value={pathInput}
									/>
								</div>
								<Button
									disabled={!runtimeTarget || pathInput.length === 0}
									loading={validationState === "loading"}
									onClick={() => runtimeTarget && requestPath(runtimeTarget, platform, pathInput, showHidden)}
									variant="primary"
								>
									{t("remote.picker.go")}
								</Button>
							</div>
						</div>

						<div className="flex min-h-0 flex-1 flex-col px-5 py-3">
							<div className="mb-2 flex flex-wrap items-center gap-1.5">
								<Button
									aria-label={t("remote.picker.parent")}
									disabled={!runtimeTarget || !pathModel.parent}
									icon={<Undo2 aria-hidden="true" size={13} />}
									onClick={() =>
										runtimeTarget &&
										pathModel.parent &&
										requestPath(runtimeTarget, platform, pathModel.parent, showHidden)
									}
									size="sm"
									variant="ghost"
								/>
								<nav
									aria-label={t("remote.picker.breadcrumbs")}
									className="flex min-w-0 flex-1 items-center overflow-x-auto"
								>
									{pathModel.breadcrumbs.map((breadcrumb, index) => (
										<span className="flex min-w-0 items-center" key={breadcrumb.path}>
											{index > 0 ? (
												<ChevronRight aria-hidden="true" className="shrink-0 text-(--omp-dim)" size={13} />
											) : null}
											<Button
												className="max-w-40"
												disabled={!runtimeTarget || breadcrumb.path === selectedPath}
												onClick={() =>
													runtimeTarget &&
													requestPath(runtimeTarget, platform, breadcrumb.path, showHidden)
												}
												size="sm"
												title={breadcrumb.path}
												variant="ghost"
											>
												<span className="truncate font-mono">{shortenPath(breadcrumb.label)}</span>
											</Button>
										</span>
									))}
								</nav>
								<label className="flex shrink-0 items-center gap-1.5 text-omp-xs text-(--omp-muted)">
									<input
										checked={showHidden}
										className="accent-(--omp-accent)"
										onChange={event => {
											const hidden = event.target.checked;
											showHiddenRef.current = hidden;
											setShowHidden(hidden);
											if (
												runtimeTarget &&
												pathInput.length > 0 &&
												(validationState === "loading" || validationState === "valid")
											) {
												requestListing(runtimeTarget, pathInput, hidden, pathGeneration.current);
											}
										}}
										type="checkbox"
									/>
									{t("remote.picker.showHidden")}
								</label>
								<Button
									aria-label={t("remote.picker.refresh")}
									disabled={!runtimeTarget || validationState !== "valid"}
									icon={<RefreshCw aria-hidden="true" size={13} />}
									loading={listingState === "loading"}
									onClick={() => runtimeTarget && requestListing(runtimeTarget, selectedPath, showHidden)}
									size="sm"
									variant="ghost"
								/>
							</div>

							<div
								aria-label={t("remote.picker.directories")}
								className="min-h-40 flex-1 overflow-y-auto rounded-lg border border-(--omp-border-muted)"
							>
								{listingState === "loading" ? (
									<div
										className="flex min-h-40 items-center justify-center gap-2 text-omp-md text-(--omp-dim)"
										role="status"
									>
										<Spinner size="sm" /> {t("remote.picker.loadingDirectories")}
									</div>
								) : listingState === "error" ? (
									<div className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 py-6 text-center">
										<div className="max-w-full break-words text-omp-md text-(--omp-error)" role="alert">
											{listingError}
										</div>
										<Button
											disabled={!canRetryPath}
											onClick={() =>
												runtimeTarget && requestPath(runtimeTarget, platform, pathInput, showHidden)
											}
											size="sm"
										>
											{t("remote.picker.retry")}
										</Button>
									</div>
								) : entries.length === 0 ? (
									<div className="flex min-h-40 items-center justify-center px-4 text-center text-omp-md text-(--omp-dim)">
										{t("remote.picker.empty")}
									</div>
								) : (
									<div className="divide-y divide-(--omp-border-muted)">
										{entries.map(entry => (
											<button
												className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-omp-md text-(--omp-text) transition-colors hover:bg-(--omp-bg-tertiary) focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-(--omp-accent)"
												key={entry.path}
												onClick={() =>
													runtimeTarget && requestPath(runtimeTarget, platform, entry.path, showHidden)
												}
												title={entry.path}
												type="button"
											>
												{entry.kind === "symlink-directory" ? (
													<FolderSymlink
														aria-hidden="true"
														className="shrink-0 text-(--omp-accent)"
														size={15}
													/>
												) : (
													<Folder aria-hidden="true" className="shrink-0 text-(--omp-accent)" size={15} />
												)}
												<span className="min-w-0 flex-1 truncate">{shortenPath(entry.name)}</span>
											</button>
										))}
									</div>
								)}
							</div>

							{validationState === "error" ? (
								<div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-(--omp-error) px-3 py-2">
									<span className="min-w-0 break-words text-omp-sm text-(--omp-error)" role="alert">
										{validationError}
									</span>
									<Button
										disabled={!canRetryPath}
										onClick={() =>
											runtimeTarget && requestPath(runtimeTarget, platform, pathInput, showHidden)
										}
										size="sm"
									>
										{t("remote.picker.retry")}
									</Button>
								</div>
							) : null}
						</div>
					</>
				)}
				<div className="flex items-center justify-end gap-2 border-t border-(--omp-border-muted) px-5 py-3">
					<Button onClick={closeDialog}>{t("remote.picker.cancel")}</Button>
					<Button
						disabled={!validatedTarget || validationState !== "valid"}
						onClick={confirm}
						title={confirmExplanation}
						variant="primary"
					>
						{t("remote.picker.confirm")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
