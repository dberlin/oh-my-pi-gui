import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RpcActiveTool, RpcActiveToolsResult, RpcToolSource } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { Badge, Input, Modal, Spinner } from "../common";

const SOURCE_ORDER: RpcToolSource[] = ["builtin", "mcp", "extension", "plugin"];

/**
 * Native /tools: every tool currently visible to the agent, grouped by
 * provenance (built-in factories, `mcp__` servers, the extension/custom-tool
 * path, plugins) with a search filter over names and descriptions.
 */
export function ActiveToolsDialog() {
	const t = useT();
	const open = useUiStore(state => state.activeToolsOpen);
	const close = useUiStore(state => state.closeActiveTools);
	const [tools, setTools] = useState<RpcActiveTool[]>([]);
	const [query, setQuery] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setTools([]);
		setQuery("");
		setError(null);
		setLoading(true);
		void window.omp.rpc
			.getActiveTools()
			.then(response => {
				if (cancelled) return;
				if (response.success) setTools((response.data as RpcActiveToolsResult).tools);
				else setError(response.error);
			})
			.catch(cause => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matches = (tool: RpcActiveTool): boolean =>
			!q || tool.name.toLowerCase().includes(q) || (tool.description ?? "").toLowerCase().includes(q);
		return SOURCE_ORDER.map(source => ({
			source,
			tools: tools.filter(tool => tool.source === source && matches(tool)),
		})).filter(group => group.tools.length > 0);
	}, [tools, query]);

	return (
		<Modal onClose={close} open={open} size="lg" title={t("activeTools.title")}>
			<div className="space-y-3">
				<div className="relative">
					<Search
						className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-(--omp-dim)"
						size={14}
					/>
					<Input
						className="pl-9"
						onChange={event => setQuery(event.target.value)}
						placeholder={t("activeTools.search")}
						value={query}
					/>
				</div>
				{loading ? (
					<div className="flex items-center justify-center gap-2 py-8 text-sm text-(--omp-dim)">
						<Spinner size="sm" /> {t("activeTools.loading")}
					</div>
				) : error ? (
					<div className="py-4 text-sm text-(--omp-error)">
						{t("activeTools.error")}: {error}
					</div>
				) : tools.length === 0 ? (
					<div className="py-4 text-sm text-(--omp-dim)">{t("activeTools.empty")}</div>
				) : groups.length === 0 ? (
					<div className="py-4 text-sm text-(--omp-dim)">{t("activeTools.noMatch")}</div>
				) : (
					<div className="space-y-4">
						{groups.map(group => (
							<section key={group.source}>
								<div className="mb-1.5 flex items-center gap-2">
									<span className="text-xs font-semibold text-(--omp-text)">
										{t(`activeTools.source.${group.source}`)}
									</span>
									<Badge variant="muted">{group.tools.length}</Badge>
								</div>
								<div className="divide-y divide-(--omp-border-muted) rounded-lg border border-(--omp-border-muted)">
									{group.tools.map(tool => (
										<div className="px-3 py-2" key={`${group.source}:${tool.name}`}>
											<div className="font-mono text-xs font-medium text-(--omp-text)">{tool.name}</div>
											{tool.description ? (
												<div className="mt-0.5 line-clamp-2 text-xs text-(--omp-dim)">
													{tool.description}
												</div>
											) : null}
										</div>
									))}
								</div>
							</section>
						))}
					</div>
				)}
			</div>
		</Modal>
	);
}
