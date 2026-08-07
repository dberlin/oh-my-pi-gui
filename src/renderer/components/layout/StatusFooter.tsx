import { Brain, Cpu, FolderOpen, Gauge, GitBranch, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { useGitStatus } from "../../hooks/use-git-status";
import { shortenPath } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useActiveTabKind } from "../../stores/tabs";
import { Badge, type BadgeVariant } from "../common";
import { loopLimitText, parseLoopLimit } from "../panels/ModesPanel";

/**
 * GUI status footer — the analog of the TUI status line, honoring
 * `statusLine.preset` (read live via get_settings, re-read on config_update).
 *
 * Rendered segment subset — only what the renderer stores honestly back:
 *   model (+ thinking level)  useModelStore.model / .thinkingLevel / .thinkingConfigured
 *   path (cwd)                useSessionStore.cwd
 *   git (branch + counts)     useGitStatus → get_git_status RPC (plan/20)
 *   context_pct               useSessionStore.contextUsage
 *   session_name              useSessionStore.sessionName
 *
 * Mode badges (计划/目标/循环/vibe/暂停) sit beside the segments whenever the
 * matching session-store mode is active — they are mode-state indicators, not
 * statusLine segments, so presets don't govern them (minimal still hides them
 * with the other optional segments). Tooltips carry detail: goal objective,
 * loop limit/args.
 *
 * TUI segments deliberately NOT rendered (no live GUI data source, and
 * faking them would lie): pi, mode, collab, pr, subagents, hostname,
 * session, token_in/out/total/rate, cache_read/write/hit, usage, cost,
 * time, time_spent, context_total. Cost exists only per-message (UsageRow)
 * — the messages store pages history, so summing it would under-report —
 * and active time is tracked inside the TUI's own status-line component.
 * Preset `segmentOptions` beyond visibility (path maxLength, git toggles,
 * time format, compactThinkingLevel) and `statusLine.separator` (powerline
 * glyphs are terminal chrome) are likewise not honored; segments here are
 * always joined by "·".
 */
type StatusLinePreset = "default" | "minimal" | "compact" | "full" | "nerd" | "ascii" | "custom";

const KNOWN_PRESETS: Record<string, true> = {
	default: true,
	minimal: true,
	compact: true,
	full: true,
	nerd: true,
	ascii: true,
	custom: true,
};

function Sep() {
	return (
		<span aria-hidden className="shrink-0 text-[var(--omp-dim)]">
			·
		</span>
	);
}

export function StatusFooter() {
	const t = useT();
	const model = useModelStore(s => s.model);
	const thinkingLevel = useModelStore(s => s.thinkingLevel);
	const thinkingConfigured = useModelStore(s => s.thinkingConfigured);
	const availableThinkingLevels = useModelStore(s => s.availableThinkingLevels);
	const sessionName = useSessionStore(s => s.sessionName);
	const cwd = useSessionStore(s => s.cwd);
	const contextUsage = useSessionStore(s => s.contextUsage);
	const planModeEnabled = useSessionStore(s => s.planModeEnabled);
	const goalActive = useSessionStore(s => s.goalState?.status === "active" || !!s.goal);
	const goalObjective = useSessionStore(s => s.goal?.objective ?? null);
	const loopMode = useSessionStore(s => s.loopMode);
	const vibeModeEnabled = useSessionStore(s => s.vibeModeEnabled);
	const agentsPaused = useSessionStore(s => s.agentsPaused);
	/** Chat tabs are tool-free: agent-mode badges can't be armed there. */
	const isChat = useActiveTabKind() === "chat";
	const { status: git, refresh: refreshGit } = useGitStatus();
	const [preset, setPreset] = useState<StatusLinePreset>("default");

	// Read the preset at mount, then re-read on every config_update push
	// (TUI settings selector, /set, another window) so changes apply live.
	useEffect(() => {
		let cancelled = false;
		const sync = async () => {
			const res = await window.omp.rpc.getSettings(["statusLine.preset"]);
			if (cancelled || !res.success) return;
			const values = (res.data as { values?: Record<string, unknown> } | undefined)?.values;
			const value = values?.["statusLine.preset"];
			if (typeof value === "string" && KNOWN_PRESETS[value]) setPreset(value as StatusLinePreset);
		};
		void sync();
		const unsubscribe = window.omp.events.onConfigUpdate(() => void sync());
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	// minimal: model + context only. compact hides the optional cost/time
	// segments, which this subset never renders, so it matches default here.
	const minimal = preset === "minimal";
	const icons = preset === "nerd";
	const ascii = preset === "ascii";

	// Thinking tail on the model segment (TUI `model.showThinkingLevel`):
	// only when the model reasons; "auto" mirrors the configured selector.
	const thinking =
		availableThinkingLevels.length > 0
			? thinkingConfigured === "auto"
				? "auto"
				: thinkingLevel && thinkingLevel !== "off"
					? thinkingLevel
					: ""
			: "";

	// Active session modes as small badges beside the model segment. Loop's
	// tooltip reuses the Modes window's limit/args formatting; paused is the
	// `set_agents_paused` gate (command palette "Pause All Agents").
	const loopActive = loopMode?.enabled === true;
	const loopLimit = loopMode ? parseLoopLimit(loopMode.limit) : null;
	const loopArgs = loopLimit ? loopLimitText(t, loopLimit) : t("modesPanel.loop.noLimit");
	const modeBadges: { key: string; label: string; tooltip: string; variant: BadgeVariant }[] = [];
	// Chat tabs are tool-free: agent-mode badges (plan/goal/loop/vibe) can't be
	// armed there. The paused gate is transport-level and stays.
	if (planModeEnabled && !isChat) {
		modeBadges.push({
			key: "plan",
			label: t("statusFooter.mode.plan"),
			tooltip: t("statusFooter.mode.planTooltip"),
			variant: "info",
		});
	}
	if (goalActive && !isChat) {
		modeBadges.push({
			key: "goal",
			label: t("statusFooter.mode.goal"),
			tooltip: goalObjective
				? t("statusFooter.mode.goalTooltipObjective", { objective: goalObjective })
				: t("statusFooter.mode.goalTooltip"),
			variant: "success",
		});
	}
	if (loopActive && !isChat) {
		modeBadges.push({
			key: "loop",
			label: t("statusFooter.mode.loop"),
			tooltip: t("statusFooter.mode.loopTooltip", { args: loopArgs }),
			variant: "info",
		});
	}
	if (vibeModeEnabled && !isChat) {
		modeBadges.push({
			key: "vibe",
			label: t("statusFooter.mode.vibe"),
			tooltip: t("statusFooter.mode.vibeTooltip"),
			variant: "default",
		});
	}
	if (agentsPaused) {
		modeBadges.push({
			key: "paused",
			label: t("statusFooter.mode.paused"),
			tooltip: t("statusFooter.mode.pausedTooltip"),
			variant: "warning",
		});
	}

	return (
		<footer className="flex h-7 shrink-0 items-center overflow-hidden border-t border-[var(--omp-border-muted)] px-3 whitespace-nowrap text-[11px] text-[var(--omp-muted)]">
			<div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
				<span
					className="flex min-w-0 shrink items-center gap-1"
					title={model ? t("statusFooter.modelTooltip", { model: `${model.provider}/${model.id}` }) : undefined}
				>
					{icons && <Cpu size={11} className="shrink-0" />}
					{ascii && <span className="shrink-0 text-[var(--omp-dim)]">{t("statusFooter.label.model")}</span>}
					<span className="truncate">{model?.id ?? t("statusFooter.noModel")}</span>
					{thinking && (
						<span
							className="flex shrink-0 items-center gap-0.5 text-[var(--omp-dim)]"
							title={t("statusFooter.thinkingTooltip", { level: thinking })}
						>
							<span aria-hidden>·</span>
							{icons && <Brain size={10} />}
							{thinking}
						</span>
					)}
				</span>

				{!minimal && modeBadges.length > 0 && (
					<>
						<Sep />
						<span className="flex shrink-0 items-center gap-1">
							{modeBadges.map(badge => (
								<span key={badge.key} title={badge.tooltip} className="flex shrink-0 cursor-default">
									<Badge variant={badge.variant}>{badge.label}</Badge>
								</span>
							))}
						</span>
					</>
				)}

				{!minimal && cwd && (
					<>
						<Sep />
						<span
							className="flex min-w-0 shrink items-center gap-1"
							title={t("statusFooter.cwdTooltip", { path: cwd })}
						>
							{icons && <FolderOpen size={11} className="shrink-0" />}
							{ascii && <span className="shrink-0 text-[var(--omp-dim)]">{t("statusFooter.label.cwd")}</span>}
							<span className="truncate">{shortenPath(cwd)}</span>
						</span>
					</>
				)}

				{!minimal && git?.isRepo && git.branch && (
					<>
						<Sep />
						<button
							className="flex min-w-0 shrink cursor-pointer items-center gap-1 hover:text-[var(--omp-text)]"
							title={t("statusFooter.gitTooltip", {
								branch: git.branch,
								staged: String(git.staged),
								unstaged: String(git.unstaged),
								untracked: String(git.untracked),
							})}
							onClick={refreshGit}
							type="button"
						>
							{icons && <GitBranch size={11} className="shrink-0" />}
							{ascii && <span className="shrink-0 text-[var(--omp-dim)]">{t("statusFooter.label.git")}</span>}
							<span className="max-w-40 truncate">{git.branch}</span>
							{git.unstaged > 0 && <span className="shrink-0 text-[var(--omp-warning)]">*{git.unstaged}</span>}
							{git.staged > 0 && <span className="shrink-0 text-[var(--omp-success)]">+{git.staged}</span>}
							{git.untracked > 0 && <span className="shrink-0 text-[var(--omp-dim)]">?{git.untracked}</span>}
						</button>
					</>
				)}

				{contextUsage && (
					<>
						<Sep />
						<span
							className="flex shrink-0 items-center gap-1.5"
							title={t("input.contextTooltip", { percent: Math.round(contextUsage.percent) })}
						>
							{icons && <Gauge size={11} className="shrink-0" />}
							{ascii && <span className="text-[var(--omp-dim)]">{t("statusFooter.label.context")}</span>}
							{/* Same meter as the composer's context readout (InputArea). */}
							<span className="block h-1.5 w-12 overflow-hidden rounded-full bg-[var(--omp-progress-bg)]">
								<span
									className="block h-full rounded-full bg-[var(--omp-status-context)]"
									style={{ width: `${Math.min(100, contextUsage.percent)}%` }}
								/>
							</span>
							<span className="tabular-nums">{Math.round(contextUsage.percent)}%</span>
						</span>
					</>
				)}
			</div>

			{!minimal && sessionName && (
				<span
					className="flex min-w-0 shrink items-center gap-1 ml-3 max-w-[45%]"
					title={t("statusFooter.sessionTooltip", { name: sessionName })}
				>
					{icons && <MessageSquare size={11} className="shrink-0" />}
					{ascii && <span className="shrink-0 text-[var(--omp-dim)]">{t("statusFooter.label.session")}</span>}
					<span className="truncate">{sessionName}</span>
				</span>
			)}
		</footer>
	);
}
