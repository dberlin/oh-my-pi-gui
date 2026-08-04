/**
 * Model Roles window: configure per-role model assignments.
 * Each role (default, smol, slow, vision, plan, designer, commit, tiny, task, advisor)
 * can be assigned a specific model via a dropdown picker.
 */

import { RefreshCw, Tag } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ModelInfo, ModelRoleEntry, ModelRoleMetadata, ModelRolesResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Button, Modal, Spinner } from "../common";
import { toast } from "../../stores/toast";
import { useModelStore } from "../../stores/model";

const COLOR_MAP: Record<string, string> = {
	success: "var(--omp-success)",
	warning: "var(--omp-warning)",
	accent: "var(--omp-accent)",
	error: "var(--omp-error)",
	info: "var(--omp-link)",
	default: "var(--omp-muted)",
};

function RoleRow({
	role,
	metadata,
	availableModels,
	onChange,
	busy,
	t,
}: {
	role: ModelRoleEntry;
	metadata?: ModelRoleMetadata;
	availableModels: Array<{ provider: string; id: string }>;
	onChange: (role: string, modelId: string | null) => void;
	busy: boolean;
	t: (k: string, p?: Record<string, string | number>) => string;
}) {
	const color = COLOR_MAP[role.color] ?? COLOR_MAP.default;
	const displayName = metadata?.name ?? role.name;
	const displayTag = metadata?.tag ?? role.tag;

	return (
		<div className="flex items-center gap-3 rounded-lg border border-[var(--omp-border-muted)] bg-[var(--omp-bg-secondary)] px-3 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex items-center gap-2">
					<Tag size={12} style={{ color }} />
					<span className="text-[13px] font-medium text-[var(--omp-text)]">{displayName}</span>
					<span
						className="rounded px-1.5 py-px text-[9px] font-bold tracking-wider"
						style={{ backgroundColor: `${color}20`, color }}
					>
						{displayTag}
					</span>
				</div>
				<span className="text-[10px] text-[var(--omp-dim)]">
					{t("modelRoles.source", { source: role.source })}
					{role.model && <span className="ml-2">→ {role.model}</span>}
				</span>
			</div>
			<select
				className="h-7 min-w-[180px] rounded-md border border-[var(--omp-border-muted)] bg-[var(--omp-bg-tertiary)] px-2 text-[11px] text-[var(--omp-text)] focus:border-[var(--omp-border-accent)] focus:outline-none"
				value={role.model ?? ""}
				disabled={busy}
				onChange={e => {
					const val = e.target.value;
					onChange(role.id, val || null);
				}}
			>
				<option value="">{t("modelRoles.default")}</option>
				{availableModels.map(m => (
					<option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
						{m.provider}/{m.id}
					</option>
				))}
			</select>
		</div>
	);
}

export function ModelRolesWindow() {
	const open = useUiStore(s => s.modelRolesOpen);
	const close = useUiStore(s => s.closeModelRoles);
	const t = useT();
	const sidecarReady = useSessionStore(s => s.status) === "ready";
	const availableModels = useModelStore(s => s.availableModels);
	const setAvailableModels = useModelStore(s => s.setAvailableModels);

	const [roles, setRoles] = useState<ModelRoleEntry[]>([]);
	const [metadata, setMetadata] = useState<ModelRoleMetadata[]>([]);
	const [loading, setLoading] = useState(false);
	const [busyRole, setBusyRole] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		if (!sidecarReady) {
			setLoading(false);
			return;
		}
		try {
			// Fetch available models too: the role dropdowns read them from the
			// model store, which is otherwise populated only when the ModelPicker
			// opens — leaving every dropdown empty on a fresh launch.
			const [rolesRes, metaRes, modelsRes] = await Promise.all([
				window.omp.rpc.getModelRoles(),
				window.omp.rpc.getModelRoleMetadata(),
				window.omp.rpc.getAvailableModels(),
			]);
			if (rolesRes.success) setRoles((rolesRes.data as ModelRolesResult).roles);
			if (metaRes.success) setMetadata((metaRes.data as { roles: ModelRoleMetadata[] }).roles);
			if (modelsRes.success) {
				// get_available_models payload: { models?: ModelInfo[] }.
				const modelsData = modelsRes.data as { models?: ModelInfo[] } | undefined;
				setAvailableModels(modelsData?.models ?? []);
			}
		} catch (cause) {
			toast({ variant: "error", title: t("modelRoles.failed"), message: String(cause) });
		} finally {
			setLoading(false);
		}
	}, [sidecarReady, setAvailableModels, t]);

	useEffect(() => {
		if (open) void load();
	}, [open, load]);

	const metaById = useMemo(() => {
		const map = new Map<string, ModelRoleMetadata>();
		for (const m of metadata) map.set(m.id, m);
		return map;
	}, [metadata]);

	const modelOptions = useMemo(
		() => availableModels.map(m => ({ provider: m.provider, id: m.id })),
		[availableModels],
	);

	const handleChange = async (role: string, modelId: string | null) => {
		setBusyRole(role);
		try {
			const res = await window.omp.rpc.setModelRole(role, modelId);
			if (res.success) {
				toast({
					variant: "success",
					message: modelId
						? t("modelRoles.set", { role, model: modelId })
						: t("modelRoles.cleared", { role }),
				});
				await load();
			} else {
				toast({ variant: "error", title: t("modelRoles.failed"), message: res.error });
			}
		} catch (cause) {
			toast({ variant: "error", title: t("modelRoles.failed"), message: String(cause) });
		} finally {
			setBusyRole(null);
		}
	};

	return (
		<Modal open={open} onClose={close} title={t("modelRoles.title")} size="lg">
			<div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
				<div className="flex items-center justify-between">
					<span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--omp-muted)]">
						{t("modelRoles.header")}
					</span>
					<Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => void load()} loading={loading}>
						{t("modelRoles.refresh")}
					</Button>
				</div>

				{loading && roles.length === 0 && (
					<div className="flex items-center justify-center py-8"><Spinner /></div>
				)}

				{roles.length > 0 && (
					<div className="flex flex-col gap-2">
						{roles.map(role => (
							<RoleRow
								key={role.id}
								role={role}
								metadata={metaById.get(role.id)}
								availableModels={modelOptions}
								onChange={handleChange}
								busy={busyRole === role.id}
								t={t}
							/>
						))}
					</div>
				)}

				{!loading && roles.length === 0 && (
					<div className="rounded-md border border-[var(--omp-border-muted)] px-3 py-4 text-center text-[12px] text-[var(--omp-dim)]">
						{t("modelRoles.empty")}
					</div>
				)}
			</div>
		</Modal>
	);
}
