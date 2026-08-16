/**
 * Providers window: lists all configured providers with auth status,
 * login/logout for OAuth providers, model counts, and base URL overrides.
 * Login triggers the existing extension_ui open_url flow via rpc.login().
 */

import { Edit, ExternalLink, Globe, LogIn, LogOut, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CustomProviderView } from "../../../shared/ipc-types";
import type { ProviderDiscoveryState, ProviderInfo, ProvidersResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, Button, Modal, Spinner } from "../common";

function AuthBadge({ provider, t }: { provider: ProviderInfo; t: (k: string) => string }) {
	if (!provider.authenticated) return <Badge variant="muted">{t("providers.badge.noAuth")}</Badge>;
	if (provider.authKind === "oauth")
		return (
			<Badge variant="success" dot>
				{t("providers.badge.oauth")}
			</Badge>
		);
	if (provider.authKind === "env") return <Badge variant="info">{t("providers.badge.env")}</Badge>;
	return (
		<Badge variant="success" dot>
			{t("providers.badge.apikey")}
		</Badge>
	);
}

type ProviderEditAction = { kind: "login" } | { kind: "config"; provider: CustomProviderView } | null;

/**
 * Resolve the provider's editable resource: registered credential flow first,
 * then a user-owned models.yml entry. Catalog-only providers are read-only.
 */
export function resolveProviderEditAction(
	provider: ProviderInfo,
	customConfigs: CustomProviderView[],
): ProviderEditAction {
	if (provider.loginAvailable) return { kind: "login" };
	const config = customConfigs.find(candidate => candidate.id === provider.id);
	return config && !config.builtin ? { kind: "config", provider: config } : null;
}

/** Only user-required discovery failures should become settings errors. */
export function providerDiscoveryErrors(states: readonly ProviderDiscoveryState[], fallbackMessage: string): string[] {
	return states
		.filter(state => state.status === "unavailable" && !state.optional)
		.map(state => `${state.provider}: ${state.error ?? fallbackMessage}`);
}
export function ProviderRow({
	provider,
	customConfigs,
	onLogin,
	onLogout,
	onEdit,
	busy,
	t,
}: {
	provider: ProviderInfo;
	customConfigs: CustomProviderView[];
	onLogin: (id: string) => void;
	onLogout: (id: string) => void;
	onEdit: (id: string) => void;
	busy: boolean;
	t: (k: string, p?: Record<string, string | number>) => string;
}) {
	const editAction = resolveProviderEditAction(provider, customConfigs);
	const showEdit = editAction?.kind === "config" || (editAction?.kind === "login" && provider.authenticated);
	return (
		<div className="flex items-center gap-3 rounded-lg border border-[var(--omp-border-muted)] px-3 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-2">
					<span className="text-omp-lg font-medium text-[var(--omp-text)]">{provider.name}</span>
					<AuthBadge provider={provider} t={t} />
					{provider.disabled && <Badge variant="warning">{t("providers.badge.disabled")}</Badge>}
				</div>
				<div className="flex items-center gap-3 text-omp-sm text-[var(--omp-dim)]">
					{provider.account && <span>{provider.account}</span>}
					{provider.modelCount > 0 && <span>{t("providers.models", { count: provider.modelCount })}</span>}
					{provider.baseUrl && (
						<span className="flex items-center gap-1">
							<Globe size={10} />
							{provider.baseUrl}
						</span>
					)}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{showEdit && editAction && (
					<Button
						size="sm"
						variant="ghost"
						icon={<Edit size={12} />}
						disabled={busy}
						onClick={() => onEdit(provider.id)}
						aria-label={
							editAction.kind === "login"
								? t("providers.updateCredentials", { provider: provider.name })
								: t("providers.edit")
						}
					/>
				)}
				{/* Login: any unauthenticated provider with a registered credential flow. */}
				{provider.loginAvailable && !provider.authenticated && (
					<Button
						size="sm"
						variant="primary"
						icon={<LogIn size={12} />}
						disabled={busy}
						onClick={() => onLogin(provider.id)}
					>
						{t("providers.login")}
					</Button>
				)}
				{provider.authenticated && (
					<Button
						size="sm"
						variant="ghost"
						icon={<LogOut size={12} />}
						disabled={busy}
						onClick={() => onLogout(provider.id)}
					>
						{t("providers.logout")}
					</Button>
				)}
			</div>
		</div>
	);
}

export function ProvidersWindow() {
	const open = useUiStore(s => s.providersOpen);
	const close = useUiStore(s => s.closeProviders);
	const openProviderConfig = useUiStore(s => s.openProviderConfig);
	const providerConfigOpen = useUiStore(s => s.providerConfigOpen);
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const applyCatalogUpdate = useModelStore(s => s.applyCatalogUpdate);
	const [result, setResult] = useState<ProvidersResult | null>(null);
	const [customConfigs, setCustomConfigs] = useState<CustomProviderView[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [busyProvider, setBusyProvider] = useState<string | null>(null);
	const load = useCallback(
		async (forceRefresh = false) => {
			setLoading(true);
			setError(null);
			if (!sidecarReady) {
				setError(t("providers.notConnected"));
				setLoading(false);
				return;
			}
			try {
				const [providerResult, configsResult] = await Promise.allSettled([
					window.omp.rpc.getProviders(forceRefresh),
					window.omp.models.listProviders(),
				]);
				if (providerResult.status === "rejected") throw providerResult.reason;
				if (providerResult.value.success) {
					const wire = providerResult.value.data as Partial<ProvidersResult>;
					const data: ProvidersResult = {
						providers: wire.providers ?? [],
						models: wire.models ?? [],
						discoveryStates: wire.discoveryStates ?? [],
						refreshPending: wire.refreshPending ?? false,
						generation: wire.generation ?? 0,
					};
					setResult(data);
					applyCatalogUpdate({ type: "model_catalog_update", ...data });
					const discoveryErrors = providerDiscoveryErrors(
						data.discoveryStates,
						t("providers.discoveryUnavailable"),
					);
					if (discoveryErrors.length > 0) {
						setError(t("providers.discoveryFailed", { details: discoveryErrors.join("; ") }));
					}
				} else setError(providerResult.value.error);
				setCustomConfigs(configsResult.status === "fulfilled" ? configsResult.value : []);
			} catch (cause) {
				setError(String(cause));
			} finally {
				setLoading(false);
			}
		},
		[applyCatalogUpdate, sidecarReady, t],
	);

	useEffect(() => {
		if (!open) return;
		return window.omp.events.onModelCatalogUpdate(frame => {
			setResult({
				providers: frame.providers,
				models: frame.models,
				discoveryStates: frame.discoveryStates,
				refreshPending: frame.refreshPending,
				generation: frame.generation,
			});
			const discoveryErrors = providerDiscoveryErrors(frame.discoveryStates, t("providers.discoveryUnavailable"));
			setError(
				discoveryErrors.length > 0 ? t("providers.discoveryFailed", { details: discoveryErrors.join("; ") }) : null,
			);
		});
	}, [open, t]);

	useEffect(() => {
		// ProviderConfigDialog is an independent overlay. Reload when it closes so
		// the still-open provider window reflects add/edit/delete immediately.
		if (open && !providerConfigOpen) void load();
	}, [open, providerConfigOpen, load]);

	const handleLogin = async (providerId: string) => {
		setBusyProvider(providerId);
		try {
			const res = await window.omp.rpc.login(providerId);
			if (res.success) {
				toast({ variant: "success", message: t("providers.loginSuccess", { provider: providerId }) });
				await load();
			} else {
				toast({ variant: "error", title: t("providers.loginFailed"), message: res.error });
			}
		} catch (cause) {
			toast({ variant: "error", title: t("providers.loginFailed"), message: String(cause) });
		} finally {
			setBusyProvider(null);
		}
	};

	const handleLogout = async (providerId: string) => {
		setBusyProvider(providerId);
		try {
			const res = await window.omp.rpc.logout(providerId);
			if (res.success) {
				toast({ variant: "success", message: t("providers.logoutSuccess", { provider: providerId }) });
				await load();
			} else {
				toast({ variant: "error", title: t("providers.logoutFailed"), message: res.error });
			}
		} catch (cause) {
			toast({ variant: "error", title: t("providers.logoutFailed"), message: String(cause) });
		} finally {
			setBusyProvider(null);
		}
	};

	const handleEdit = async (providerId: string) => {
		try {
			const provider = result?.providers.find(p => p.id === providerId);
			if (!provider) return;
			const views = await window.omp.models.listProviders();
			const action = resolveProviderEditAction(provider, views);
			if (!action) return;
			if (action.kind === "login") {
				await handleLogin(providerId);
			} else if (action.kind === "config") {
				openProviderConfig(action.provider);
			}
		} catch (cause) {
			toast({ variant: "error", title: t("providers.editFailed"), message: String(cause) });
		}
	};

	const authenticated = result?.providers.filter(p => p.authenticated) ?? [];
	const unauthenticated = result?.providers.filter(p => !p.authenticated) ?? [];

	return (
		<Modal open={open} onClose={close} title={t("providers.title")} size="lg">
			<div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
				<div className="flex items-center justify-between">
					<span className="text-omp-sm font-semibold uppercase tracking-wider text-[var(--omp-muted)]">
						{t("providers.authenticated")}
					</span>
					<div className="flex items-center gap-1.5">
						<Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => openProviderConfig()}>
							{t("providerCfg.list.add")}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							icon={<ExternalLink size={12} />}
							onClick={() => {
								void window.omp.models.openConfig().catch(cause => {
									toast({ variant: "error", title: t("providers.editConfig"), message: String(cause) });
								});
							}}
						>
							{t("providers.editConfig")}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							icon={<RefreshCw size={12} />}
							onClick={() => void load(true)}
							loading={loading}
						>
							{t("providers.refresh")}
						</Button>
					</div>
				</div>

				{error && (
					<div className="rounded-md bg-[var(--omp-tool-error-bg)] px-3 py-2 text-omp-md text-[var(--omp-error)]">
						{error}
					</div>
				)}
				{result?.refreshPending && !error && (
					<div
						className="rounded-md bg-[var(--omp-bg-tertiary)] px-3 py-2 text-omp-md text-[var(--omp-muted)]" // surface-ok: transient discovery status banner
					>
						{t("providers.refreshPending")}
					</div>
				)}
				{loading && !result && (
					<div className="flex items-center justify-center py-8">
						<Spinner />
					</div>
				)}

				{result && authenticated.length === 0 && (
					<div className="rounded-md border border-[var(--omp-border-muted)] px-3 py-4 text-center text-omp-md text-[var(--omp-dim)]">
						{t("providers.noAuth")}
					</div>
				)}

				{authenticated.length > 0 && (
					<div className="flex flex-col gap-2">
						{authenticated.map(p => (
							<ProviderRow
								key={p.id}
								provider={p}
								customConfigs={customConfigs}
								onLogin={handleLogin}
								onLogout={handleLogout}
								onEdit={handleEdit}
								busy={busyProvider === p.id}
								t={t}
							/>
						))}
					</div>
				)}

				{unauthenticated.length > 0 && (
					<>
						<span className="text-omp-sm font-semibold uppercase tracking-wider text-[var(--omp-muted)]">
							{t("providers.available")}
						</span>
						<div className="flex flex-col gap-2">
							{unauthenticated.map(p => (
								<ProviderRow
									key={p.id}
									provider={p}
									customConfigs={customConfigs}
									onLogin={handleLogin}
									onLogout={handleLogout}
									onEdit={handleEdit}
									busy={busyProvider === p.id}
									t={t}
								/>
							))}
						</div>
					</>
				)}

				<div className="rounded-md border border-[var(--omp-border-muted)] px-3 py-2.5">
					<div className="mb-1 text-omp-sm font-semibold text-[var(--omp-text)]">{t("providers.customTitle")}</div>
					<div className="text-omp-xs leading-[1.5] text-[var(--omp-muted)]">
						{t("providers.customHelp", {
							file: "~/.omp/models.yml",
							baseUrl: "baseUrl",
							apiKey: "apiKey",
							models: "models",
						})}
					</div>
				</div>
			</div>
		</Modal>
	);
}
