import { Bot } from "lucide-react";
import type { SidecarStatus } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useAgentViewStore } from "../../stores/agent-view";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { Badge, type BadgeVariant } from "../common";
import { statusMeta, subagentPrimaryLabel } from "./activity/agent-tree-model";

interface SessionStatusPresentation {
	labelKey: string;
	variant: BadgeVariant;
	live: boolean;
}

const SESSION_STATUS: Record<SidecarStatus, SessionStatusPresentation> = {
	starting: { labelKey: "titlebar.status.connecting", variant: "info", live: true },
	ready: { labelKey: "titlebar.status.ready", variant: "success", live: false },
	exited: { labelKey: "agentView.status.disconnected", variant: "muted", live: false },
	error: { labelKey: "agentView.status.error", variant: "error", live: false },
	restarting: { labelKey: "agentView.status.restarting", variant: "warning", live: true },
};

const WORKING_STATUS: SessionStatusPresentation = {
	labelKey: "titlebar.status.working",
	variant: "info",
	live: true,
};

/** Persistent identity and lifecycle chrome for the transcript currently occupying the canvas. */
export function AgentViewContextBar() {
	const t = useT();
	const target = useAgentViewStore(state => state.target);
	const snapshot = useSubagentsStore(state =>
		target.kind === "subagent" ? state.subagents.get(target.id) : undefined,
	);
	const sessionStatus = useSessionStore(state => state.status);
	const isStreaming = useSessionStore(state => state.isStreaming);
	const mainSelected = target.kind === "main";
	const meta = mainSelected
		? isStreaming
			? WORKING_STATUS
			: SESSION_STATUS[sessionStatus]
		: statusMeta(snapshot?.status ?? "unknown");
	const label = mainSelected ? t("agentView.main") : snapshot ? subagentPrimaryLabel(snapshot) : target.id;
	const agentType = mainSelected ? t("agentView.mainSession") : (snapshot?.agent ?? t("agentView.subagent"));
	const status = mainSelected ? (isStreaming ? "working" : sessionStatus) : (snapshot?.status ?? "unknown");

	return (
		<header
			aria-label={t("agentView.ariaLabel")}
			className="omp-agent-view-context-bar flex h-9 shrink-0 items-center gap-2 border-b border-(--omp-border-muted) bg-(--omp-bg-secondary) px-4"
			data-agent-view={target.kind}
			role="group"
		>
			<Bot
				aria-hidden
				className={mainSelected ? "shrink-0 text-(--omp-accent)" : "shrink-0 text-(--omp-status-subagents)"}
				size={14}
			/>
			<span
				className="min-w-0 truncate text-omp-sm font-semibold text-(--omp-text)"
				data-agent-label
				title={mainSelected ? undefined : label}
			>
				{label}
			</span>
			<span className="shrink-0 text-omp-xs text-(--omp-dim)" data-agent-type>
				{agentType}
			</span>
			<span aria-live="polite" className="ml-auto" data-agent-live={meta.live ? "true" : undefined} role="status">
				<Badge dot={meta.live} pulse={meta.live} variant={meta.variant}>
					<span data-agent-status={status}>{t(meta.labelKey)}</span>
				</Badge>
			</span>
		</header>
	);
}
