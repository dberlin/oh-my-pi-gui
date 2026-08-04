/**
 * Providers window: lists all configured providers with auth status,
 * login/logout for OAuth providers, model counts, and base URL overrides.
 * Login triggers the existing extension_ui open_url flow via rpc.login().
 */

import { ExternalLink, Globe, LogIn, LogOut, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProviderInfo, ProvidersResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
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

function ProviderRow({
	provider,
	onLogin,
	onLogout,
	busy,
	t,
}: {
	provider: ProviderInfo;
	onLogin: (id: string) => void;
	onLogout: (id: string) => void;
	busy: boolean;
	t: (k: string, p?: Record<string, string | number>) => string;
}) {
	return (
		<div className="flex items-center gap-3 rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] px-3 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-2">
					<span className="text-[13px] font-medium text-[var(--omp-text)]">{provider.name}</span>
					<AuthBadge provider={provider} t={t} />
					{provider.disabled && <Badge variant="warning">{t("providers.badge.disabled")}</Badge>}
				</div>
				<div className="flex items-center gap-3 text-[11px] text-[var(--omp-dim)]">
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
				{provider.oauth && !provider.authenticated && (
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
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const [result, setResult] = useState<ProvidersResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [busyProvider, setBusyProvider] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		if (!sidecarReady) {
			setError(t("providers.notConnected"));
			setLoading(false);
			return;
		}
		try {
			const res = await window.omp.rpc.getProviders();
			if (res.success) setResult(res.data as ProvidersResult);
			else setError(res.error);
		} catch (cause) {
			setError(String(cause));
		} finally {
			setLoading(false);
		}
	}, [sidecarReady, t]);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

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

	const authenticated = result?.providers.filter(p => p.authenticated) ?? [];
	const unauthenticated = result?.providers.filter(p => !p.authenticated) ?? [];

	return (
		<Modal open={open} onClose={close} title={t("providers.title")} size="lg">
			<div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
				<div className="flex items-center justify-between">
					<span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--omp-muted)]">
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
							onClick={() => void load()}
							loading={loading}
						>
							{t("providers.refresh")}
						</Button>
					</div>
				</div>

				{error && (
					<div className="rounded-md bg-[var(--omp-tool-error-bg)] px-3 py-2 text-[12px] text-[var(--omp-error)]">
						{error}
					</div>
				)}
				{loading && !result && (
					<div className="flex items-center justify-center py-8">
						<Spinner />
					</div>
				)}

				{result && authenticated.length === 0 && (
					<div className="rounded-md border border-[var(--omp-border-muted)] px-3 py-4 text-center text-[12px] text-[var(--omp-dim)]">
						{t("providers.noAuth")}
					</div>
				)}

				{authenticated.length > 0 && (
					<div className="flex flex-col gap-2">
						{authenticated.map(p => (
							<ProviderRow
								key={p.id}
								provider={p}
								onLogin={handleLogin}
								onLogout={handleLogout}
								busy={busyProvider === p.id}
								t={t}
							/>
						))}
					</div>
				)}

				{unauthenticated.length > 0 && (
					<>
						<span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--omp-muted)]">
							{t("providers.available")}
						</span>
						<div className="flex flex-col gap-2">
							{unauthenticated.map(p => (
								<ProviderRow
									key={p.id}
									provider={p}
									onLogin={handleLogin}
									onLogout={handleLogout}
									busy={busyProvider === p.id}
									t={t}
								/>
							))}
						</div>
					</>
				)}

				<div className="rounded-md border border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] px-3 py-2.5">
					<div className="mb-1 text-[11px] font-semibold text-[var(--omp-text)]">{t("providers.customTitle")}</div>
					<div className="text-[10.5px] leading-[1.5] text-[var(--omp-muted)]">
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
