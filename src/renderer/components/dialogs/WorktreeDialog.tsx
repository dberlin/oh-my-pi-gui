/**
 * Worktree-create dialog (plan/20 — tab × worktree binding): names a new
 * branch omp/gui/<slug> checked out at ~/.omp/wt/gui-<slug>-<hash7>, then
 * opens a tab bound to it. The create RPC rides the ACTIVE tab's sidecar
 * (baseCwd defaults to its session cwd; a Sidebar group pins it via
 * ui.worktreeDialog.baseCwd). The hash-suffixed path is computed agent-side —
 * the preview shows the branch only.
 */

import { useEffect, useRef, useState } from "react";
import type { RpcWorktreeCreateResult } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Input, Modal } from "../common";

/** Renderer-side mirror of the agent's slugify (rpc-worktree.ts). */
function slugify(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function WorktreeDialog() {
	const t = useT();
	const dialog = useUiStore(state => state.worktreeDialog);
	const close = useUiStore(state => state.closeWorktreeDialog);
	const sessionCwd = useSessionStore(state => state.cwd);

	const [name, setName] = useState("");
	const [baseRef, setBaseRef] = useState<"HEAD" | "default">("HEAD");
	const [creating, setCreating] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!dialog) return;
		setName("");
		setBaseRef("HEAD");
		setCreating(false);
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [dialog]);

	const slug = slugify(name);
	const submit = async () => {
		if (!slug || creating) return;
		setCreating(true);
		try {
			const response = await window.omp.rpc.worktreeCreate(slug, {
				baseCwd: dialog?.baseCwd ?? sessionCwd,
				baseRef,
			});
			if (!response.success) {
				const key =
					response.code === "not_a_repo"
						? "worktree.notARepo"
						: response.code === "invalid_name"
							? "worktree.invalidName"
							: "worktree.failed";
				toast({ variant: "error", title: t(key), message: response.error });
				return;
			}
			const result = response.data as RpcWorktreeCreateResult;
			const tabId = await useTabsStore.getState().openTab({
				cwd: result.path,
				worktree: { name: slug, branch: result.branch, baseCwd: result.baseCwd },
			});
			if (tabId) close();
		} catch (error) {
			toast({ variant: "error", title: t("worktree.failed"), message: String(error) });
		} finally {
			setCreating(false);
		}
	};

	return (
		<Modal open={dialog !== null} onClose={close} title={t("worktree.title")} size="sm">
			<form
				className="flex flex-col gap-3"
				onSubmit={event => {
					event.preventDefault();
					void submit();
				}}
			>
				<Input
					ref={inputRef}
					label={t("worktree.nameLabel")}
					placeholder={t("worktree.namePlaceholder")}
					value={name}
					onChange={event => setName(event.target.value)}
					maxLength={41}
					autoFocus
				/>
				{slug && (
					<p className="text-[11px] text-(--omp-dim)">
						{t("worktree.branchPreview", { branch: `omp/gui/${slug}` })}
					</p>
				)}
				<fieldset className="flex flex-col gap-1.5">
					<legend className="text-[11px] font-medium text-(--omp-muted)">{t("worktree.baseLabel")}</legend>
					{(["HEAD", "default"] as const).map(value => (
						<label key={value} className="flex cursor-pointer items-center gap-2 text-[12.5px] text-(--omp-text)">
							<input
								type="radio"
								name="worktree-base"
								checked={baseRef === value}
								onChange={() => setBaseRef(value)}
								className="accent-(--omp-accent)"
							/>
							{value === "HEAD" ? t("worktree.baseHead") : t("worktree.baseDefault")}
						</label>
					))}
				</fieldset>
				<div className="flex justify-end gap-2">
					<Button type="button" variant="ghost" onClick={close}>
						{t("common.cancel")}
					</Button>
					<Button type="submit" variant="primary" loading={creating} disabled={slug.length === 0}>
						{t("worktree.submit")}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
