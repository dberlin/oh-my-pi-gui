import { ArrowDown, ArrowUp, Clock, DollarSign, Zap } from "lucide-react";
import type { AgentMessage } from "../../../shared/rpc-types";
import { formatDuration, formatTokens } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useSettingsStore } from "../../stores/settings";

/** Below this the rate is nonsense (cached/instant responses yield absurd tok/s). */
const MIN_DURATION_MS = 100;

interface MessageUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costTotal: number | undefined;
}

/**
 * Narrow the pi-ai `usage` payload that rides on finalized assistant messages
 * (absent on other roles). Returns null when nothing billable was recorded —
 * aborted/errored turns carry an all-zero usage block not worth a row.
 */
function readUsage(message: AgentMessage): MessageUsage | null {
	const usage = message.usage;
	if (usage == null || typeof usage !== "object") return null;
	const record = usage as Record<string, unknown>;
	const read = (key: string): number => {
		const value = record[key];
		return typeof value === "number" && Number.isFinite(value) ? value : 0;
	};
	const input = read("input");
	const output = read("output");
	const cacheRead = read("cacheRead");
	const cacheWrite = read("cacheWrite");
	let costTotal: number | undefined;
	const cost = record.cost;
	if (cost != null && typeof cost === "object") {
		const total = (cost as Record<string, unknown>).total;
		if (typeof total === "number" && Number.isFinite(total) && total > 0) costTotal = total;
	}
	if (input + output + cacheRead + cacheWrite <= 0 && costTotal === undefined) return null;
	return { input, output, cacheRead, cacheWrite, costTotal };
}

function formatCost(total: number): string {
	return `$${total >= 1 ? total.toFixed(2) : total.toPrecision(2)}`;
}

/**
 * Compact usage/cost footer under completed assistant messages (TUI
 * usage-row.ts parity): model, in/out tokens, cache reads, cost, wall-clock
 * duration, and throughput — only the segments the message actually carries.
 */
export function UsageRow({ message }: { message: AgentMessage }) {
	const t = useT();
	// Honors the shared `display.showTokenUsage` setting (schema default off) —
	// previously the GUI ignored it and always rendered usage.
	const showTokenUsage = useSettingsStore(s => s.showTokenUsage);
	if (!showTokenUsage) return null;
	if (message.role !== "assistant") return null;
	const usage = readUsage(message);
	if (!usage) return null;

	const model = typeof message.model === "string" ? message.model : "";
	const durationMs = typeof message.duration === "number" && Number.isFinite(message.duration) ? message.duration : 0;
	const totalInput = usage.input + usage.cacheWrite;
	const tokPerSec = durationMs > MIN_DURATION_MS && usage.output > 0 ? (usage.output / durationMs) * 1000 : 0;

	return (
		<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] tabular-nums text-[var(--omp-dim)]">
			{model && <span className="font-mono">{model}</span>}
			<span
				className="flex items-center gap-1"
				title={t("chat.usage.inputTokens", { count: totalInput.toLocaleString() })}
			>
				<ArrowUp size={10} />
				{formatTokens(totalInput)}
			</span>
			<span
				className="flex items-center gap-1"
				title={t("chat.usage.outputTokens", { count: usage.output.toLocaleString() })}
			>
				<ArrowDown size={10} />
				{formatTokens(usage.output)}
			</span>
			{usage.cacheRead > 0 && (
				<span title={t("chat.usage.cachedTokens", { count: usage.cacheRead.toLocaleString() })}>
					{t("chat.usage.cached", { tokens: formatTokens(usage.cacheRead) })}
				</span>
			)}
			{usage.costTotal !== undefined && (
				<span className="flex items-center gap-1" title={t("chat.usage.cost")}>
					<DollarSign size={10} />
					{formatCost(usage.costTotal)}
				</span>
			)}
			{durationMs > 0 && (
				<span className="flex items-center gap-1" title={t("chat.usage.duration")}>
					<Clock size={10} />
					{formatDuration(durationMs)}
				</span>
			)}
			{tokPerSec > 0 && (
				<span className="flex items-center gap-1" title={t("chat.usage.throughput")}>
					<Zap size={10} />
					{tokPerSec.toFixed(1)}/s
				</span>
			)}
		</div>
	);
}
