import type { ReactNode } from "react";
import { isSshSessionTarget } from "../../../shared/session-target";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";

/**
 * A file path rendered as an editor-open link. Reads as plain monospace text
 * inside tool-card headers; hover reveals the affordance. Events stop at the
 * link so a surrounding disclosure row does not toggle when the user meant to
 * open the file.
 *
 * Opening is workspace-aware, because a tool card's path belongs to the tab
 * that produced it, not to whichever tab happens to be focused:
 *
 *  - Local tabs go through `system:open-path` with the owning tab id, so a
 *    relative path resolves against that tab's cwd even in a split pane.
 *  - Remote (ssh) tabs never reach the local filesystem — a remote absolute
 *    path like `/home/user/...` does not exist on the machine running the GUI,
 *    and handing it to the OS produced a bare "File not found". They open the
 *    in-app file preview instead, which reads over the same remote-aware
 *    `fs:read` bridge the Files panel uses.
 */
export function PathLink({ path, children, className }: { path: string; children?: ReactNode; className?: string }) {
	const t = useT();
	const runtimeTabId = useRuntimeTabId();
	const tabId = useTabsStore(state => {
		const tab = state.tabs.find(candidate => candidate.id === (runtimeTabId ?? state.activeTabId));
		return tab?.id ?? null;
	});
	const isRemote = useTabsStore(state => {
		const tab = state.tabs.find(candidate => candidate.id === (runtimeTabId ?? state.activeTabId));
		return tab ? isSshSessionTarget(tab.target) : false;
	});
	if (!path) return <span className={className}>{children}</span>;

	const open = async () => {
		// A remote path is only meaningful on its host. Preview it in-app rather
		// than asking the local OS to open a path it cannot have.
		if (isRemote) {
			useUiStore.getState().openFilePreview(path);
			return;
		}
		try {
			const result = await window.omp.system.openPath(path, tabId ?? undefined);
			if (!result?.ok) {
				toast({ variant: "error", title: t("tools.path.openFailed"), message: result?.error || path });
			}
		} catch (cause) {
			toast({
				variant: "error",
				title: t("tools.path.openFailed"),
				message: cause instanceof Error ? cause.message : String(cause),
			});
		}
	};

	return (
		<button
			type="button"
			title={path}
			onClick={event => {
				event.stopPropagation();
				void open();
			}}
			className={cx(
				"min-w-0 cursor-pointer rounded-sm text-left transition-colors hover:text-[var(--omp-accent)] hover:underline hover:decoration-[var(--omp-accent)]/50 hover:underline-offset-2",
				className,
			)}
		>
			{children ?? path}
		</button>
	);
}
