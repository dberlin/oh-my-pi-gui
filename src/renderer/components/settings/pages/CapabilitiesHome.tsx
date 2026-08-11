/**
 * Capabilities home page: the OMP Capabilities tab in settings that showcases
 * differentiating workflows with discovery cards and direct actions.
 */

import { Bot, BrainCircuit, Database, Network, Route, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../../lib/i18n";
import { Button } from "../../common";

interface CapabilitiesHomeProps {
	ready: boolean;
	ttsrEnabled: boolean;
	advisorEnabled: boolean;
	advisorActive: boolean | undefined;
	memoryBackend: string;
	onConfigureTtsr: () => void;
	onOpenAgents: () => void;
	onOpenModelRoles: () => void;
	onConfigureAdvisor: () => void;
	onOpenGoal: () => void;
	onOpenLoop: () => void;
	onOpenMemory: () => void;
	onOpenTools: () => void;
}

function CapabilityCard({
	icon,
	title,
	description,
	status,
	statusActive = false,
	featured = false,
	children,
}: {
	icon: ReactNode;
	title: string;
	description: string;
	status?: string;
	statusActive?: boolean;
	featured?: boolean;
	children: ReactNode;
}) {
	return (
		<section
			className={`rounded-xl border bg-transparent p-4 ${
				featured
					? "settings-capability-featured border-[color-mix(in_srgb,var(--omp-accent)_45%,var(--omp-border-muted))]"
					: "border-(--omp-border-muted)"
			}`}
		>
			<div className="flex items-start gap-3">
				<div
					className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center ${featured ? "text-(--omp-accent)" : "text-(--omp-muted)"}`}
				>
					{icon}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="text-omp-lg font-semibold text-(--omp-text)">{title}</h3>
						{status && (
							<span
								className={`rounded-full border px-1.5 py-0.5 text-omp-xxs font-medium ${
									statusActive
										? "border-[color-mix(in_srgb,var(--omp-success)_35%,transparent)] bg-transparent text-(--omp-success)"
										: "border-(--omp-border-muted) text-(--omp-dim)"
								}`}
							>
								{status}
							</span>
						)}
					</div>
					<p className="mt-1 text-omp-sm leading-relaxed text-(--omp-muted)">{description}</p>
				</div>
			</div>
			<div className="mt-3 flex flex-wrap items-center gap-2">{children}</div>
		</section>
	);
}

export function CapabilitiesHome({
	ready,
	ttsrEnabled,
	advisorEnabled,
	advisorActive,
	memoryBackend,
	onConfigureTtsr,
	onOpenAgents,
	onOpenModelRoles,
	onConfigureAdvisor,
	onOpenGoal,
	onOpenLoop,
	onOpenMemory,
	onOpenTools,
}: CapabilitiesHomeProps) {
	const t = useT();
	const stateLabel = (enabled: boolean) =>
		ready
			? t(enabled ? "settings.capabilities.enabled" : "settings.capabilities.disabled")
			: t("settings.capabilities.loading");

	return (
		<div>
			<header className="mb-6 max-w-2xl">
				<div className="mb-2 flex items-center gap-1.5 text-omp-xs font-semibold tracking-[0.14em] text-(--omp-accent) uppercase">
					<Sparkles size={12} />
					{t("settings.capabilities.eyebrow")}
				</div>
				<h2 className="text-xl font-semibold tracking-tight text-(--omp-text)">
					{t("settings.capabilities.title")}
				</h2>
				<p className="mt-2 text-omp-md leading-relaxed text-(--omp-muted)">
					{t("settings.capabilities.description")}
				</p>
			</header>

			<div className="settings-capability-grid">
				<CapabilityCard
					description={t("settings.capabilities.ttsrDesc")}
					featured
					icon={<ShieldCheck size={17} />}
					status={stateLabel(ttsrEnabled)}
					statusActive={ready && ttsrEnabled}
					title={t("settings.capabilities.ttsr")}
				>
					{/* Toggle lives in Context › Rules (schema owns the value); this card
					    is discovery + navigation only. */}
					<Button onClick={onConfigureTtsr} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureRules")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.agentsDesc")}
					icon={<Network size={16} />}
					title={t("settings.capabilities.agents")}
				>
					<Button onClick={onOpenAgents} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.openAgentHub")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.modelRolesDesc")}
					icon={<Bot size={16} />}
					title={t("settings.capabilities.modelRoles")}
				>
					<Button onClick={onOpenModelRoles} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureModelRoles")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.advisorDesc")}
					icon={<BrainCircuit size={16} />}
					status={
						ready && advisorEnabled && advisorActive === false
							? t("settings.capabilities.advisorInactive")
							: stateLabel(advisorEnabled)
					}
					statusActive={ready && advisorEnabled && advisorActive !== false}
					title={t("settings.capabilities.advisor")}
				>
					{/* Toggle lives in Model › Advisor (schema owns the value). */}
					<Button onClick={onConfigureAdvisor} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureAdvisor")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.modesDesc")}
					icon={<Route size={16} />}
					title={t("settings.capabilities.modes")}
				>
					<Button onClick={onOpenGoal} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.goalMode")}
					</Button>
					<Button onClick={onOpenLoop} size="sm" type="button" variant="ghost">
						{t("settings.capabilities.loopMode")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.memoryDesc")}
					icon={<Database size={16} />}
					status={
						ready
							? t("settings.capabilities.memoryBackend", {
									backend: memoryBackend || t("settings.capabilities.unconfigured"),
								})
							: t("settings.capabilities.loading")
					}
					statusActive={ready && memoryBackend !== "" && memoryBackend !== "off"}
					title={t("settings.capabilities.memory")}
				>
					<Button onClick={onOpenMemory} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureMemory")}
					</Button>
				</CapabilityCard>

				<CapabilityCard
					description={t("settings.capabilities.toolsDesc")}
					icon={<Wrench size={16} />}
					title={t("settings.capabilities.tools")}
				>
					<Button onClick={onOpenTools} size="sm" type="button" variant="secondary">
						{t("settings.capabilities.configureTools")}
					</Button>
				</CapabilityCard>
			</div>
		</div>
	);
}
