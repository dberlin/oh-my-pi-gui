/**
 * Files panel: workspace file tree sourced via the dedicated `fs:list` /
 * `fs:read` main-process IPC (node:fs — cross-platform, works with no live
 * agent session), preview modal, and @mention insertion via the
 * "omp:insert-mention" window event.
 */

import { AtSign, File, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FsTreeEntry } from "../../../shared/ipc-types";
import { useT } from "../../lib/i18n";
import { acceptsActiveTabEvents, onActiveTabRouteSettled } from "../../lib/tab-routing";
import { Button, Modal, Spinner } from "../common";
import { type TreeNode, TreeView } from "../common/TreeView";

const MAX_FILES = 2000;
const MAX_DEPTH = 8;
const PREVIEW_MAX_BYTES = 200_000;

interface PreviewState {
	path: string;
	content: string | null;
	loading: boolean;
	truncated: boolean;
}

function countFiles(entries: FsTreeEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.kind === "file") count += 1;
		else if (entry.children) count += countFiles(entry.children);
	}
	return count;
}

export function FilesPanel() {
	const t = useT();
	const [tree, setTree] = useState<FsTreeEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [truncated, setTruncated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [preview, setPreview] = useState<PreviewState | null>(null);

	const load = useCallback(async () => {
		if (!acceptsActiveTabEvents()) return;
		setLoading(true);
		setError(null);
		try {
			const result = await window.omp.fs.list(undefined, MAX_DEPTH, MAX_FILES);
			if (!result.ok) {
				setError(result.error ?? t("filesPanel.unavailable"));
				setTree([]);
				setTruncated(false);
				return;
			}
			setTree(result.entries);
			setTruncated(result.truncated);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setTree([]);
			setTruncated(false);
		} finally {
			setLoading(false);
		}
	}, [t]);

	useEffect(() => {
		const run = () => void load();
		const unsubscribeRoute = onActiveTabRouteSettled(run);
		run();
		return unsubscribeRoute;
	}, [load]);

	const openPreview = useCallback(
		async (path: string) => {
			setPreview({ path, content: null, loading: true, truncated: false });
			try {
				const result = await window.omp.fs.read(path, PREVIEW_MAX_BYTES);
				if (!result.ok) {
					setPreview({
						path,
						content: t("filesPanel.readFailed", { error: result.error ?? "unknown" }),
						loading: false,
						truncated: false,
					});
					return;
				}
				if (result.binary) {
					setPreview({ path, content: t("filesPanel.binary"), loading: false, truncated: false });
					return;
				}
				setPreview({ path, content: result.content, loading: false, truncated: result.truncated });
			} catch (error) {
				setPreview({
					path,
					content: t("filesPanel.readFailed", { error: error instanceof Error ? error.message : String(error) }),
					loading: false,
					truncated: false,
				});
			}
		},
		[t],
	);

	const insertMention = useCallback((path: string) => {
		window.dispatchEvent(new CustomEvent("omp:insert-mention", { detail: { path } }));
	}, []);

	// Wire file activation: clicking a file previews it, clicking a dir toggles.
	const onNodeClick = useCallback(
		(id: string) => {
			if (id.startsWith("file:")) void openPreview(id.slice(5));
			else if (id.startsWith("dir:")) {
				setExpanded(prev => {
					const next = new Set(prev);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
			}
		},
		[openPreview],
	);

	const nodes = useMemo<TreeNode[]>(() => {
		const toNode = (entry: FsTreeEntry): TreeNode => {
			const id = `${entry.kind}:${entry.path}`;
			const isDir = entry.kind === "dir";
			return {
				id,
				label: entry.name,
				icon: isDir ? expanded.has(id) ? <FolderOpen size={12} /> : <Folder size={12} /> : <File size={12} />,
				onClick: () => onNodeClick(id),
				children: entry.children && entry.children.length > 0 ? entry.children.map(toNode) : undefined,
			};
		};
		return tree.map(toNode);
	}, [tree, expanded, onNodeClick]);

	const fileCount = useMemo(() => countFiles(tree), [tree]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between px-3 pt-2.5 pb-1.5">
				<span className="text-[10px] font-medium tracking-widest text-(--omp-dim) uppercase">
					{t("filesPanel.title")}
				</span>
				<div className="flex items-center gap-1.5">
					<span className="text-[10px] tabular-nums text-(--omp-dim)">
						{fileCount}
						{truncated ? "+" : ""}
					</span>
					<button
						aria-label={t("filesPanel.refresh")}
						className="rounded p-0.5 text-(--omp-dim) transition-colors hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
						disabled={loading}
						onClick={() => void load()}
						type="button"
					>
						<RefreshCw className={loading ? "animate-spin" : undefined} size={11} />
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
				{loading && tree.length === 0 ? (
					<div className="flex items-center justify-center gap-2 py-8">
						<Spinner size="sm" />
						<span className="text-[11px] text-(--omp-dim)">{t("filesPanel.scanning")}</span>
					</div>
				) : error !== null ? (
					<div className="px-4 py-8 text-center text-[11px] leading-relaxed text-(--omp-dim)">
						{t("filesPanel.unavailable")}
						<br />
						<span className="break-words">{error}</span>
						<div className="mt-2">
							<Button onClick={() => void load()} size="sm" variant="ghost">
								{t("filesPanel.retry")}
							</Button>
						</div>
					</div>
				) : (
					<TreeView
						emptyMessage={t("filesPanel.empty")}
						expanded={expanded}
						nodes={nodes}
						onExpandedChange={setExpanded}
					/>
				)}
			</div>

			<Modal
				bodyClassName="p-0"
				onClose={() => setPreview(null)}
				open={preview !== null}
				panelClassName="w-[680px]"
				title={
					preview && (
						<span className="flex items-center gap-2 font-mono text-xs">
							<File className="shrink-0 text-(--omp-dim)" size={12} />
							<span className="truncate">{preview.path}</span>
						</span>
					)
				}
			>
				{preview && (
					<div className="flex h-[60vh] flex-col">
						<div className="flex items-center justify-end gap-2 border-b border-(--omp-border-muted) px-3 py-2">
							<Button
								icon={<AtSign size={12} />}
								onClick={() => {
									insertMention(preview.path);
									setPreview(null);
								}}
								size="sm"
								variant="secondary"
							>
								{t("filesPanel.insertMention")}
							</Button>
						</div>
						<div className="min-h-0 flex-1 overflow-auto bg-(--omp-code-bg) p-3">
							{preview.loading ? (
								<div className="flex items-center gap-2 py-8">
									<Spinner size="sm" />
									<span className="text-[11px] text-(--omp-dim)">{t("filesPanel.reading")}</span>
								</div>
							) : (
								<pre className="font-mono text-[11px] leading-[1.5] break-words whitespace-pre-wrap text-(--omp-text)">
									{preview.content}
									{preview.truncated && (
										<span className="text-(--omp-dim)">
											{"\n"}
											{t("filesPanel.truncated", { kb: PREVIEW_MAX_BYTES / 1000 })}
										</span>
									)}
								</pre>
							)}
						</div>
					</div>
				)}
			</Modal>
		</div>
	);
}
