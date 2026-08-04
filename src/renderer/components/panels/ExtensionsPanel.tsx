/**
 * Extensions window: interactive management of the session's skills, hooks,
 * MCP servers, and custom slash commands, backed by the domain RPCs
 * (get_skills / get_hooks / get_mcp_servers / get_available_commands).
 *
 * Each tab lazy-loads on first view, caches for the lifetime of the mounted
 * panel, and offers a manual Refresh. Search filters rows client-side.
 *
 * Rows are interactive where a mutation RPC exists: skills/hooks toggle via
 * set_skill_enabled / set_hook_enabled and MCP servers carry an action menu
 * (enable / disable / reconnect / remove via mcp_action). The commands tab is
 * read-only — the sidecar exposes no slash-command management RPC. Toggles
 * are optimistic — the row reverts and an error toast fires on failure, and
 * a successful mutation re-fetches the tab. Hook toggles persist but only
 * bind at startup, so the footer flags them as next-session.
 *
 * Parent wiring (parent-owned files): mount once beside the other windows and
 * drive it from a ui-store flag + command-registry entry:
 *   <ExtensionsPanel open={extensionsOpen} onClose={closeExtensions} />
 */

import { Lock, MoreVertical, Power, RefreshCw, Search, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	AvailableCommand,
	RpcHookInfo,
	RpcHooksResult,
	RpcMcpServerInfo,
	RpcMcpServersResult,
	RpcResponse,
	RpcSkillInfo,
	RpcSkillsResult,
} from "../../../shared/rpc-types";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { toast } from "../../stores/toast";
import { Badge, type BadgeVariant, Button, Modal, Spinner, type TabItem, Tabs } from "../common";

export interface ExtensionsPanelProps {
	open: boolean;
	onClose: () => void;
	/** Deep-link a specific tab on open (defaults to "skills"). */
	initialTab?: TabId;
}

export type TabId = "skills" | "hooks" | "mcp" | "commands";

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface TabRpc<T> {
	data: T | null;
	error: string | null;
	loading: boolean;
	/** Re-fetch; awaited by row mutations so fresh state replaces optimistic overlays. */
	refresh: () => Promise<void>;
}

const fetchSkills = (): Promise<RpcResponse> => window.omp.rpc.getSkills();
const pickSkills = (data: unknown): RpcSkillInfo[] => (data as RpcSkillsResult | undefined)?.skills ?? [];
const fetchHooks = (): Promise<RpcResponse> => window.omp.rpc.getHooks();
const pickHooks = (data: unknown): RpcHookInfo[] => (data as RpcHooksResult | undefined)?.hooks ?? [];
const fetchMcpServers = (): Promise<RpcResponse> => window.omp.rpc.getMcpServers();
const pickMcpServers = (data: unknown): RpcMcpServerInfo[] => (data as RpcMcpServersResult | undefined)?.servers ?? [];
const fetchCommands = (): Promise<RpcResponse> => window.omp.rpc.getAvailableCommands();
const pickCommands = (data: unknown): AvailableCommand[] =>
	((data as { commands?: AvailableCommand[] } | undefined)?.commands ?? []).filter(isCustomCommand);

/**
 * Lazy per-tab RPC loader: fires on the tab's first activation, then caches.
 * Errors surface inline with a Retry button; `refresh` re-fetches on demand.
 */
function useTabRpc<T>(
	open: boolean,
	active: boolean,
	fetcher: () => Promise<RpcResponse>,
	pick: (data: unknown) => T,
): TabRpc<T> {
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const attemptedRef = useRef(false);

	const load = useCallback(async () => {
		if (!sidecarReady) {
			setError(t("extPanel.notConnected"));
			return;
		}
		setLoading(true);
		setError(null);
		try {
			const res = await fetcher();
			if (res.success) setData(pick(res.data));
			else setError(res.error);
		} catch (cause) {
			setError(String(cause));
		} finally {
			setLoading(false);
		}
	}, [sidecarReady, fetcher, pick, t]);

	useEffect(() => {
		if (!open || !active || attemptedRef.current) return;
		attemptedRef.current = true;
		void load();
	}, [open, active, load]);

	const refresh = useCallback(async (): Promise<void> => {
		await load();
	}, [load]);

	return { data, error, loading, refresh };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Case-insensitive substring filter over a row's searchable fields. */
export function filterList<T>(items: T[] | null, query: string, fields: (item: T) => string[]): T[] {
	if (!items) return [];
	const q = query.trim().toLowerCase();
	if (!q) return items;
	return items.filter(item => fields(item).some(field => field.toLowerCase().includes(q)));
}

/** Collapse a home-dir prefix to "~" and middle-truncate long paths. */
export function shortenPath(path: string): string {
	const home = /^\/(Users|home)\/[^/]+/.exec(path);
	let display = home ? `~${path.slice(home[0].length)}` : path;
	const MAX = 56;
	if (display.length > MAX) {
		const keep = Math.floor((MAX - 1) / 2);
		display = `${display.slice(0, keep)}…${display.slice(-keep)}`;
	}
	return display;
}

export function hookPhase(event: string): string {
	const sep = event.indexOf(":");
	return sep === -1 ? event : event.slice(0, sep);
}

export function hookTool(event: string): string {
	const sep = event.indexOf(":");
	return sep === -1 ? "" : event.slice(sep + 1);
}

/** Bucket hooks by event tool, groups sorted A–Z, row order preserved within a group. */
export function groupHooksByTool(hooks: RpcHookInfo[]): Array<[string, RpcHookInfo[]]> {
	const byTool = new Map<string, RpcHookInfo[]>();
	for (const hook of hooks) {
		const tool = hookTool(hook.event) || "*";
		const bucket = byTool.get(tool);
		if (bucket) bucket.push(hook);
		else byTool.set(tool, [hook]);
	}
	return [...byTool.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Sidecar-advertised commands that did not ship with the binary (any source but "builtin"). */
export function isCustomCommand(command: AvailableCommand): boolean {
	return command.source !== "builtin";
}

/** Sources with a localized label; anything else falls back to the raw source string. */
const KNOWN_COMMAND_SOURCES: Record<string, true> = {
	custom: true,
	extension: true,
	file: true,
	mcp_prompt: true,
	other: true,
	skill: true,
};

/** Bucket commands by their origin source, groups sorted A–Z, row order preserved within a group. */
export function groupCommandsBySource(commands: AvailableCommand[]): Array<[string, AvailableCommand[]]> {
	const bySource = new Map<string, AvailableCommand[]>();
	for (const command of commands) {
		const source = command.source ?? "other";
		const bucket = bySource.get(source);
		if (bucket) bucket.push(command);
		else bySource.set(source, [command]);
	}
	return [...bySource.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** MCP connection status → badge color (connected / connecting pulse / dim). */
export const MCP_STATUS_VARIANT: Record<RpcMcpServerInfo["status"], BadgeVariant> = {
	connected: "success",
	connecting: "info",
	disconnected: "muted",
};

/** MCP enabled-state display; mutations go through the row's action menu. */
function EnabledBadge({ enabled }: { enabled: boolean }) {
	const t = useT();
	return enabled ? (
		<Badge dot variant="success">
			{t("extPanel.enabled")}
		</Badge>
	) : (
		<Badge dot variant="muted">
			{t("extPanel.disabled")}
		</Badge>
	);
}

/** Row-sized enable/disable switch (Settings-window styling); spinner while its mutation is in flight. */
function EnableToggle({
	enabled,
	busy,
	disabled,
	onToggle,
}: {
	enabled: boolean;
	/** This row's mutation is in flight. */
	busy: boolean;
	/** Another row's mutation is in flight (one at a time). */
	disabled: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	const label = enabled ? t("extPanel.enabled") : t("extPanel.disabled");
	if (busy) {
		return (
			<span className="flex h-4 w-7 items-center justify-center" title={label}>
				<Spinner size="sm" />
			</span>
		);
	}
	return (
		<button
			aria-checked={enabled}
			aria-label={label}
			className={cx(
				"relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
				enabled ? "bg-(--omp-accent)" : "border border-(--omp-border-muted) bg-(--omp-bg-tertiary)",
			)}
			disabled={disabled}
			onClick={onToggle}
			role="switch"
			title={label}
			type="button"
		>
			<span
				className={cx(
					"absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-white shadow transition-all duration-150",
					enabled ? "left-3.5" : "left-0.5",
				)}
			/>
		</button>
	);
}

// ---------------------------------------------------------------------------
// Row mutations: optimistic enable overlay + one-at-a-time busy key
// ---------------------------------------------------------------------------

interface RowMutation {
	/** Key of the row whose mutation is in flight (null = idle). */
	busyKey: string | null;
	/** Row enable state with the optimistic overlay applied. */
	effective: (key: string, base: boolean) => boolean;
	/**
	 * Run one row mutation: apply the optimistic enable state (`next`, null =
	 * no overlay), call the RPC, re-fetch on success, revert + toast on error.
	 * Controls stay disabled while `busyKey` is set — one mutation at a time.
	 */
	run: (key: string, next: boolean | null, action: () => Promise<RpcResponse>, errorTitle: string) => Promise<void>;
}

function useRowMutation(refresh: () => Promise<void>): RowMutation {
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [overrides, setOverrides] = useState<Readonly<Record<string, boolean>>>({});

	const effective = useCallback((key: string, base: boolean): boolean => overrides[key] ?? base, [overrides]);

	const run = useCallback(
		async (key: string, next: boolean | null, action: () => Promise<RpcResponse>, errorTitle: string) => {
			setBusyKey(key);
			if (next !== null) setOverrides(prev => ({ ...prev, [key]: next }));
			const clearOverride = (): void =>
				setOverrides(prev => {
					if (!(key in prev)) return prev;
					const rest = { ...prev };
					delete rest[key];
					return rest;
				});
			try {
				const res = await action();
				if (!res.success) {
					clearOverride();
					toast({ variant: "error", title: errorTitle, message: res.error });
					return;
				}
				// Fresh server state replaces the optimistic overlay.
				await refresh();
				clearOverride();
			} catch (cause) {
				clearOverride();
				toast({ variant: "error", title: errorTitle, message: String(cause) });
			} finally {
				setBusyKey(null);
			}
		},
		[refresh],
	);

	return { busyKey, effective, run };
}

// ---------------------------------------------------------------------------
// Shared tab frame: toolbar (search / count / refresh) + state handling
// ---------------------------------------------------------------------------

interface TabFrameProps {
	tabId: TabId;
	loading: boolean;
	loaded: boolean;
	error: string | null;
	onRefresh: () => void;
	query: string;
	onQueryChange: (query: string) => void;
	total: number;
	visible: number;
	children: ReactNode;
}

function TabFrame({
	tabId,
	loading,
	loaded,
	error,
	onRefresh,
	query,
	onQueryChange,
	total,
	visible,
	children,
}: TabFrameProps) {
	const t = useT();
	const trimmed = query.trim();
	const countKey = trimmed ? `extPanel.countFiltered.${tabId}` : `extPanel.count.${tabId}`;
	const countText = loaded ? t(countKey, trimmed ? { shown: visible, total } : { count: total }) : null;

	let body: ReactNode = null;
	if (!loaded) {
		if (loading) {
			body = (
				<div className="m-auto">
					<Spinner label={t("common.loading")} />
				</div>
			);
		} else if (error) {
			body = (
				<div className="m-auto flex max-w-md flex-col items-center gap-2 rounded-lg border border-(--omp-border-muted) px-4 py-6 text-center">
					<span className="text-[12px] font-medium text-(--omp-error)">{t("extPanel.loadFailed")}</span>
					<span className="text-[11px] break-all text-(--omp-dim)">{error}</span>
					<Button icon={<RefreshCw size={12} />} onClick={onRefresh} size="sm" variant="secondary">
						{t("extPanel.retry")}
					</Button>
				</div>
			);
		}
	} else if (total === 0) {
		body = (
			<div className="m-auto w-full rounded-md border border-(--omp-border-muted) px-3 py-4 text-center text-[12px] text-(--omp-dim)">
				{t(`extPanel.empty.${tabId}`)}
			</div>
		);
	} else if (visible === 0) {
		body = (
			<div className="m-auto w-full rounded-md border border-(--omp-border-muted) px-3 py-4 text-center text-[12px] text-(--omp-dim)">
				{t("extPanel.noMatch", { query: trimmed })}
			</div>
		);
	} else {
		body = children;
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
			<div className="flex shrink-0 items-center gap-2">
				<div className="flex min-w-[160px] flex-1 items-center gap-2 rounded-md border border-(--omp-border-muted) bg-(--omp-bg-primary) px-2.5 py-1.5">
					<Search className="shrink-0 text-(--omp-dim)" size={13} />
					<input
						aria-label={t(`extPanel.search.${tabId}`)}
						className="min-w-0 flex-1 bg-transparent text-xs text-(--omp-text) placeholder:text-(--omp-dim) focus:outline-none"
						onChange={event => onQueryChange(event.target.value)}
						placeholder={t(`extPanel.search.${tabId}`)}
						value={query}
					/>
				</div>
				{countText && <span className="shrink-0 text-[11px] tabular-nums text-(--omp-dim)">{countText}</span>}
				<Button icon={<RefreshCw size={12} />} loading={loading} onClick={onRefresh} size="sm" variant="ghost">
					{t("extPanel.refresh")}
				</Button>
			</div>
			{loaded && error && (
				<div className="shrink-0 rounded-md bg-(--omp-tool-error-bg) px-3 py-2 text-[12px] text-(--omp-error)">
					{error}
				</div>
			)}
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{body}</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Skills tab
// ---------------------------------------------------------------------------

function SkillRow({
	skill,
	enabled,
	busy,
	disabled,
	onToggle,
}: {
	skill: RpcSkillInfo;
	/** Enable state with the optimistic overlay applied. */
	enabled: boolean;
	busy: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-(--omp-border-muted) bg-(--omp-bg-secondary) px-3 py-2.5">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-[12px] font-medium text-(--omp-text)">{skill.name}</span>
				<Badge variant="info">{skill.source}</Badge>
				<span className="ml-auto">
					<EnableToggle busy={busy} disabled={disabled} enabled={enabled} onToggle={onToggle} />
				</span>
			</div>
			{skill.description && (
				<p className="line-clamp-2 text-[11px] leading-snug text-(--omp-muted)">{skill.description}</p>
			)}
			<span className="block truncate font-mono text-[10px] text-(--omp-dim)" title={skill.location}>
				{shortenPath(skill.location)}
			</span>
		</div>
	);
}

function SkillsTab({
	rpc,
	query,
	onQueryChange,
}: {
	rpc: TabRpc<RpcSkillInfo[]>;
	query: string;
	onQueryChange: (q: string) => void;
}) {
	const t = useT();
	const mutation = useRowMutation(rpc.refresh);
	const visible = useMemo(
		() => filterList(rpc.data, query, skill => [skill.name, skill.description, skill.source]),
		[rpc.data, query],
	);
	return (
		<TabFrame
			error={rpc.error}
			loaded={rpc.data !== null}
			loading={rpc.loading}
			onQueryChange={onQueryChange}
			onRefresh={rpc.refresh}
			query={query}
			tabId="skills"
			total={rpc.data?.length ?? 0}
			visible={visible.length}
		>
			<div className="flex flex-col gap-2">
				{visible.map(skill => {
					const key = `${skill.source}:${skill.name}`;
					const enabled = mutation.effective(key, skill.enabled);
					return (
						<SkillRow
							busy={mutation.busyKey === key}
							disabled={mutation.busyKey !== null}
							enabled={enabled}
							key={key}
							onToggle={() =>
								void mutation.run(
									key,
									!enabled,
									() => window.omp.rpc.setSkillEnabled(skill.name, !enabled),
									t("extPanel.skillToggleFailed"),
								)
							}
							skill={skill}
						/>
					);
				})}
			</div>
		</TabFrame>
	);
}

// ---------------------------------------------------------------------------
// Hooks tab
// ---------------------------------------------------------------------------

function HookRow({
	hook,
	enabled,
	busy,
	disabled,
	onToggle,
}: {
	hook: RpcHookInfo;
	/** Enable state with the optimistic overlay applied. */
	enabled: boolean;
	busy: boolean;
	disabled: boolean;
	onToggle: () => void;
}) {
	const phase = hookPhase(hook.event);
	const eventVariant: BadgeVariant = phase === "pre" ? "info" : phase === "post" ? "warning" : "default";
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-(--omp-border-muted) bg-(--omp-bg-secondary) px-3 py-2">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-[12px] font-medium text-(--omp-text)">{hook.name}</span>
				<Badge variant={eventVariant}>{hook.event}</Badge>
				<Badge variant="default">{hook.source}</Badge>
				<span className="ml-auto">
					<EnableToggle busy={busy} disabled={disabled} enabled={enabled} onToggle={onToggle} />
				</span>
			</div>
			<span className="block truncate font-mono text-[10px] text-(--omp-dim)" title={hook.path}>
				{shortenPath(hook.path)}
			</span>
		</div>
	);
}

function HooksTab({
	rpc,
	query,
	onQueryChange,
}: {
	rpc: TabRpc<RpcHookInfo[]>;
	query: string;
	onQueryChange: (q: string) => void;
}) {
	const t = useT();
	const mutation = useRowMutation(rpc.refresh);
	const { groups, visibleCount } = useMemo(() => {
		const visible = filterList(rpc.data, query, hook => [hook.name, hook.event, hook.source]);
		return { groups: groupHooksByTool(visible), visibleCount: visible.length };
	}, [rpc.data, query]);
	return (
		<TabFrame
			error={rpc.error}
			loaded={rpc.data !== null}
			loading={rpc.loading}
			onQueryChange={onQueryChange}
			onRefresh={rpc.refresh}
			query={query}
			tabId="hooks"
			total={rpc.data?.length ?? 0}
			visible={visibleCount}
		>
			<div className="flex flex-col gap-3">
				{groups.map(([tool, hooks]) => (
					<section className="flex flex-col gap-1.5" key={tool}>
						<header className="flex items-center gap-2 px-1">
							<span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-(--omp-muted)">
								{tool}
							</span>
							<span className="text-[10px] tabular-nums text-(--omp-dim)">{hooks.length}</span>
						</header>
						{hooks.map(hook => {
							const enabled = mutation.effective(hook.id, hook.enabled);
							return (
								<HookRow
									busy={mutation.busyKey === hook.id}
									disabled={mutation.busyKey !== null}
									enabled={enabled}
									hook={hook}
									key={hook.id}
									onToggle={() =>
										void mutation.run(
											hook.id,
											!enabled,
											() => window.omp.rpc.setHookEnabled(hook.id, !enabled),
											t("extPanel.hookToggleFailed"),
										)
									}
								/>
							);
						})}
					</section>
				))}
			</div>
		</TabFrame>
	);
}

// ---------------------------------------------------------------------------
// MCP tab
// ---------------------------------------------------------------------------

type McpActionName = "enable" | "disable" | "reconnect" | "remove";

const MCP_MENU_ITEM_CLASS =
	"flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] text-(--omp-text) transition-colors hover:bg-(--omp-bg-tertiary) disabled:cursor-not-allowed disabled:opacity-50";

function McpRow({
	server,
	enabled,
	busy,
	disabled,
	menuOpen,
	onMenuToggle,
	onMenuClose,
	onMenuAction,
	confirmingRemove,
	onConfirmRemove,
	onCancelRemove,
}: {
	server: RpcMcpServerInfo;
	/** Enable state with the optimistic overlay applied. */
	enabled: boolean;
	busy: boolean;
	/** Another row's mutation is in flight (one at a time). */
	disabled: boolean;
	menuOpen: boolean;
	onMenuToggle: () => void;
	/** Stable closer for the outside-click / Escape effect. */
	onMenuClose: () => void;
	onMenuAction: (action: McpActionName) => void;
	confirmingRemove: boolean;
	onConfirmRemove: () => void;
	onCancelRemove: () => void;
}) {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);

	// Close the action menu on outside pointer-down or Escape.
	useEffect(() => {
		if (!menuOpen) return;
		const onPointerDown = (event: PointerEvent): void => {
			if (menuRef.current && !menuRef.current.contains(event.target as Node)) onMenuClose();
		};
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") onMenuClose();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [menuOpen, onMenuClose]);

	return (
		<div className="flex flex-col rounded-lg border border-(--omp-border-muted) bg-(--omp-bg-secondary) px-3 py-2.5">
			<div className="flex items-center gap-3">
				<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
					<span className="font-mono text-[12px] font-medium text-(--omp-text)">{server.name}</span>
					<Badge variant="default">{server.transport}</Badge>
					<EnabledBadge enabled={enabled} />
					{server.authed && (
						<span className="inline-flex shrink-0 text-(--omp-dim)" title={t("extPanel.authed")}>
							<Lock aria-hidden="true" size={11} />
						</span>
					)}
				</div>
				<span className="shrink-0 text-[11px] tabular-nums text-(--omp-dim)">
					{t("extPanel.tools", { count: server.toolCount })}
				</span>
				<Badge dot pulse={server.status === "connecting"} variant={MCP_STATUS_VARIANT[server.status]}>
					{t(`extPanel.status.${server.status}`)}
				</Badge>
				<div className="relative flex shrink-0 items-center" ref={menuRef}>
					<button
						aria-expanded={menuOpen}
						aria-haspopup="menu"
						aria-label={t("extPanel.mcp.menu")}
						className="flex h-6 w-6 items-center justify-center rounded-md text-(--omp-muted) transition-colors hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text) disabled:cursor-not-allowed disabled:opacity-50"
						disabled={disabled}
						onClick={onMenuToggle}
						title={t("extPanel.mcp.menu")}
						type="button"
					>
						{busy ? <Spinner size="sm" /> : <MoreVertical size={14} />}
					</button>
					{menuOpen && !busy && (
						<div
							className="absolute right-0 top-full z-20 mt-1 flex w-36 flex-col rounded-md border border-(--omp-border-muted) bg-(--omp-bg-primary) py-1 shadow-lg"
							role="menu"
						>
							<button
								className={MCP_MENU_ITEM_CLASS}
								onClick={() => onMenuAction(enabled ? "disable" : "enable")}
								role="menuitem"
								type="button"
							>
								<Power size={11} />
								{enabled ? t("extPanel.action.disable") : t("extPanel.action.enable")}
							</button>
							<button
								className={MCP_MENU_ITEM_CLASS}
								disabled={!enabled || server.status === "connecting"}
								onClick={() => onMenuAction("reconnect")}
								role="menuitem"
								type="button"
							>
								<RefreshCw size={11} />
								{t("extPanel.action.reconnect")}
							</button>
							<button
								className={cx(MCP_MENU_ITEM_CLASS, "text-(--omp-error)")}
								onClick={() => onMenuAction("remove")}
								role="menuitem"
								type="button"
							>
								<Trash2 size={11} />
								{t("extPanel.action.remove")}
							</button>
						</div>
					)}
				</div>
			</div>
			{confirmingRemove && (
				<div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-(--omp-tool-error-bg) px-2.5 py-1.5">
					<span className="min-w-0 flex-1 text-[11px] text-(--omp-error)">
						{t("extPanel.mcp.removeConfirm", { name: server.name })}
					</span>
					<Button disabled={busy} onClick={onConfirmRemove} size="sm" variant="danger">
						{t("extPanel.action.remove")}
					</Button>
					<Button disabled={busy} onClick={onCancelRemove} size="sm" variant="ghost">
						{t("common.cancel")}
					</Button>
				</div>
			)}
		</div>
	);
}

function McpTab({
	rpc,
	query,
	onQueryChange,
}: {
	rpc: TabRpc<RpcMcpServerInfo[]>;
	query: string;
	onQueryChange: (q: string) => void;
}) {
	const t = useT();
	const mutation = useRowMutation(rpc.refresh);
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [confirmRemoveFor, setConfirmRemoveFor] = useState<string | null>(null);
	const closeMenu = useCallback(() => setMenuFor(null), []);
	const visible = useMemo(
		() => filterList(rpc.data, query, server => [server.name, server.transport, server.status]),
		[rpc.data, query],
	);

	const handleMenuAction = (server: RpcMcpServerInfo, action: McpActionName): void => {
		setMenuFor(null);
		if (action === "remove") {
			// Destructive: confirm inline inside the row before dispatching.
			setConfirmRemoveFor(server.name);
			return;
		}
		const next = action === "reconnect" ? null : action === "enable";
		void mutation.run(
			server.name,
			next,
			() => window.omp.rpc.mcpAction(server.name, action),
			t("extPanel.mcpActionFailed"),
		);
	};

	const handleConfirmRemove = (server: RpcMcpServerInfo): void => {
		setConfirmRemoveFor(null);
		void mutation.run(
			server.name,
			null,
			() => window.omp.rpc.mcpAction(server.name, "remove"),
			t("extPanel.mcpActionFailed"),
		);
	};

	return (
		<TabFrame
			error={rpc.error}
			loaded={rpc.data !== null}
			loading={rpc.loading}
			onQueryChange={onQueryChange}
			onRefresh={rpc.refresh}
			query={query}
			tabId="mcp"
			total={rpc.data?.length ?? 0}
			visible={visible.length}
		>
			<div className="flex flex-col gap-2">
				{visible.map(server => (
					<McpRow
						busy={mutation.busyKey === server.name}
						confirmingRemove={confirmRemoveFor === server.name}
						disabled={mutation.busyKey !== null}
						enabled={mutation.effective(server.name, server.enabled)}
						key={server.name}
						menuOpen={menuFor === server.name}
						onCancelRemove={() => setConfirmRemoveFor(null)}
						onConfirmRemove={() => handleConfirmRemove(server)}
						onMenuAction={action => handleMenuAction(server, action)}
						onMenuClose={closeMenu}
						onMenuToggle={() => setMenuFor(prev => (prev === server.name ? null : server.name))}
						server={server}
					/>
				))}
			</div>
		</TabFrame>
	);
}

// ---------------------------------------------------------------------------
// Commands tab (read-only: no slash-command management RPC exists)
// ---------------------------------------------------------------------------

function CommandRow({ command }: { command: AvailableCommand }) {
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-(--omp-border-muted) bg-(--omp-bg-secondary) px-3 py-2">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-mono text-[12px] font-medium text-(--omp-text)">/{command.name}</span>
				{command.aliases && command.aliases.length > 0 && (
					<span className="text-[10px] text-(--omp-dim)">
						{command.aliases.map(alias => `/${alias}`).join(", ")}
					</span>
				)}
				{command.input?.hint && (
					<code className="rounded bg-(--omp-bg-tertiary) px-1.5 py-px font-mono text-[10px] text-(--omp-muted)">
						{command.input.hint}
					</code>
				)}
			</div>
			{command.description && (
				<p className="line-clamp-2 text-[11px] leading-snug text-(--omp-muted)">{command.description}</p>
			)}
		</div>
	);
}

function CommandsTab({
	rpc,
	query,
	onQueryChange,
}: {
	rpc: TabRpc<AvailableCommand[]>;
	query: string;
	onQueryChange: (q: string) => void;
}) {
	const t = useT();
	const { groups, visibleCount } = useMemo(() => {
		const visible = filterList(rpc.data, query, command => [
			command.name,
			command.description,
			command.source ?? "",
			...(command.aliases ?? []),
		]);
		return { groups: groupCommandsBySource(visible), visibleCount: visible.length };
	}, [rpc.data, query]);
	return (
		<TabFrame
			error={rpc.error}
			loaded={rpc.data !== null}
			loading={rpc.loading}
			onQueryChange={onQueryChange}
			onRefresh={rpc.refresh}
			query={query}
			tabId="commands"
			total={rpc.data?.length ?? 0}
			visible={visibleCount}
		>
			<div className="flex flex-col gap-3">
				{groups.map(([source, commands]) => (
					<section className="flex flex-col gap-1.5" key={source}>
						<header className="flex items-center gap-2 px-1">
							<span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-(--omp-muted)">
								{KNOWN_COMMAND_SOURCES[source] ? t(`extPanel.commands.source.${source}`) : source}
							</span>
							<span className="text-[10px] tabular-nums text-(--omp-dim)">{commands.length}</span>
						</header>
						{commands.map(command => (
							<CommandRow command={command} key={`${source}:${command.name}`} />
						))}
					</section>
				))}
			</div>
		</TabFrame>
	);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export function ExtensionsPanel({ open, onClose, initialTab = "skills" }: ExtensionsPanelProps) {
	const t = useT();
	const [tab, setTab] = useState<TabId>(initialTab);
	const [query, setQuery] = useState("");

	const skills = useTabRpc(open, tab === "skills", fetchSkills, pickSkills);
	const hooks = useTabRpc(open, tab === "hooks", fetchHooks, pickHooks);
	const mcp = useTabRpc(open, tab === "mcp", fetchMcpServers, pickMcpServers);
	const commands = useTabRpc(open, tab === "commands", fetchCommands, pickCommands);

	// Reopening starts fresh on the requested tab with no stale filter.
	useEffect(() => {
		if (open) {
			setTab(initialTab);
			setQuery("");
		}
	}, [open, initialTab]);

	const tabs: TabItem[] = useMemo(
		() => [
			{ id: "skills", label: t("extPanel.tabs.skills"), badge: skills.data?.length },
			{ id: "hooks", label: t("extPanel.tabs.hooks"), badge: hooks.data?.length },
			{ id: "mcp", label: t("extPanel.tabs.mcp"), badge: mcp.data?.length },
			{ id: "commands", label: t("extPanel.tabs.commands"), badge: commands.data?.length },
		],
		[t, skills.data, hooks.data, mcp.data, commands.data],
	);

	const handleTabChange = useCallback((id: string) => {
		setTab(id as TabId);
		setQuery("");
	}, []);

	return (
		<Modal bodyClassName="p-0" onClose={onClose} open={open} size="lg" title={t("extPanel.title")}>
			<div className="flex h-[70vh] min-h-0 flex-col">
				<Tabs
					activeId={tab}
					ariaLabel={t("extPanel.title")}
					className="shrink-0 px-4"
					onChange={handleTabChange}
					tabs={tabs}
				/>
				{tab === "skills" && <SkillsTab onQueryChange={setQuery} query={query} rpc={skills} />}
				{tab === "hooks" && <HooksTab onQueryChange={setQuery} query={query} rpc={hooks} />}
				{tab === "mcp" && <McpTab onQueryChange={setQuery} query={query} rpc={mcp} />}
				{tab === "commands" && <CommandsTab onQueryChange={setQuery} query={query} rpc={commands} />}
				<div className="shrink-0 border-t border-(--omp-border-muted) px-4 py-2 text-[10.5px] text-(--omp-dim)">
					{t(`extPanel.footer.${tab}`)}
				</div>
			</div>
		</Modal>
	);
}
