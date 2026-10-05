/**
 * Composer message submission policy. Text-mode slash commands execute
 * server-side through the prompt RPC. Builtins that require an interactive
 * surface are resolved through the same GUI affordance registry as the
 * command palette, so they can never leak into model context as literal text.
 * Session-replacing commands are blocked while a turn runs. Local-only
 * mutations rehydrate after settlement, except commands whose output exists
 * only in the live event stream.
 */

import type { AvailableCommand, ImageContent, RpcResponse } from "../../shared/rpc-types";
import { hydrateSession } from "../hooks/use-rpc-events";
import { toast } from "../stores/toast";
import { buildCurrentCommandMenu, type CommandAffordance, type CommandMenuItem } from "./command-registry";
import { translate } from "./i18n";
import type { TabRpc } from "./tab-rpc";

export type ComposerSendMode = "prompt" | "steer" | "followUp";

/** Builtin slash commands that replace the session server-side. */
const SESSION_REPLACING_COMMANDS: Record<string, true> = { new: true, clear: true };
// The desktop requires a visible preview/start step even when Core exposes a
// directly executable text command, or command discovery has not completed.
// `drop` is a GUI alias for `delete`, no longer advertised by Core.
const GUI_CONFIRMATION_COMMANDS = new Set(["share", "live", "btw", "delete", "drop"]);

export type ComposerSubmit =
	/** Session-replacing command while busy — draft stays, warning toasted. */
	| { kind: "blocked" }
	/** Exact `/clear` — native clear_context RPC path (lib/messages.clearSessionContext). */
	| { kind: "clear" }
	/** A GUI-native command opened/executed its affordance synchronously. */
	| { kind: "handled" }
	/** Dispatch this lazy request; on success call {@link settleComposerResponse}. */
	| { kind: "send"; request: () => Promise<RpcResponse> };

function runGuiAffordance(affordance: CommandAffordance, args?: string, beforeRun?: () => void): boolean {
	const reportFailure = (cause: unknown): void => {
		toast({ variant: "error", title: translate("palette.failed"), message: String(cause) });
	};
	switch (affordance.kind) {
		case "action":
			beforeRun?.();
			void Promise.resolve(affordance.run(args)).catch(reportFailure);
			return true;
		case "toggle":
			beforeRun?.();
			void Promise.resolve(affordance.set(!affordance.get())).catch(reportFailure);
			return true;
		case "picker":
		case "window":
			beforeRun?.();
			affordance.open();
			return true;
		case "unavailable":
			toast({ variant: "warning", message: affordance.reason || translate("unavailable.tuiOnly") });
			return false;
		case "prompt":
		case "submenu":
			toast({ variant: "warning", message: translate("unavailable.tuiOnly") });
			return false;
	}
}

function findGuiOnlyBuiltin(message: string, commands: AvailableCommand[]): CommandMenuItem | undefined {
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(message.trim());
	const name = match?.[1]?.toLowerCase();
	if (!name) return undefined;
	const command = commands.find(
		command => command.name.toLowerCase() === name || command.aliases?.some(alias => alias.toLowerCase() === name),
	);
	// Advertised vanilla builtins have text handlers; TUI-only builtins are
	// omitted. Explicit extension/template ownership and executable overrides
	// retain dispatch, while absent GUI commands use their native affordances.
	if (command && command.source !== "builtin") return undefined;
	const needsConfirmation = GUI_CONFIRMATION_COMMANDS.has(name);
	if (!needsConfirmation && command && command.textModeExecutable !== false) return undefined;
	const primaryName = command?.name.toLowerCase() ?? name;
	const item = buildCurrentCommandMenu(commands).find(
		candidate =>
			candidate.name.toLowerCase() === primaryName || candidate.aliases?.some(alias => alias.toLowerCase() === name),
	);
	if (!item) return undefined;
	if (needsConfirmation || command?.textModeExecutable === false) return item;
	switch (item.affordance.kind) {
		case "action":
		case "toggle":
		case "picker":
		case "window":
		case "unavailable":
			if (match?.[2]?.trim()) {
				return {
					...item,
					affordance: { kind: "unavailable", reason: translate("unavailable.commandArguments") },
				};
			}
			return item;
		default:
			return undefined;
	}
}

export function isGuiOnlyBuiltinCommand(message: string, commands: AvailableCommand[]): boolean {
	return findGuiOnlyBuiltin(message, commands) !== undefined;
}

function runGuiOnlyBuiltin(message: string, commands: AvailableCommand[], beforeRun?: () => void): boolean | undefined {
	const item = findGuiOnlyBuiltin(message, commands);
	if (!item) return undefined;
	const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(message.trim());
	const args = match?.[2]?.trim() || undefined;
	return runGuiAffordance(item.affordance, args, beforeRun);
}

export function planComposerSubmit(input: {
	message: string;
	images: ImageContent[];
	isStreaming: boolean;
	mode: ComposerSendMode;
	commands: AvailableCommand[];
	rpc?: Pick<TabRpc, "compact" | "followUp" | "prompt" | "steer">;
	/** Clear the submitted draft before a native action can supply a replacement. */
	beforeGuiCommand?: () => void;
}): ComposerSubmit {
	const { message, images, isStreaming, mode, commands, rpc = window.omp.rpc } = input;
	const isSlashCommand = message.startsWith("/");
	const slash = isSlashCommand ? /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(message.trim()) : null;
	const commandName = slash?.[1]?.toLowerCase();
	const args = slash?.[2]?.trim() || undefined;
	const advertised = commandName
		? commands.find(
				command =>
					command.name.toLowerCase() === commandName ||
					command.aliases?.some(alias => alias.toLowerCase() === commandName),
			)
		: undefined;
	const nativeBuiltin = !advertised || advertised.source === "builtin";
	if (nativeBuiltin && isStreaming && commandName !== undefined && SESSION_REPLACING_COMMANDS[commandName]) {
		toast({ variant: "warning", message: translate("sessionSwitch.busyBlocked") });
		return { kind: "blocked" };
	}
	// Typed `/clear` (no args) takes the native clear_context RPC — forwarding it
	// as prompt text would fall through the TUI-only builtin and reach the model
	// as a literal user message.
	if (nativeBuiltin && commandName === "clear" && args === undefined) {
		return { kind: "clear" };
	}
	// Manual compaction can spend minutes in provider summarization. Route the
	// parameterized command through its dedicated RPC so instructions survive
	// and it gets the compact timeout instead of the short prompt timeout.
	if (nativeBuiltin && commandName === "compact") {
		return { kind: "send", request: () => rpc.compact(args) };
	}
	const guiHandled = isSlashCommand ? runGuiOnlyBuiltin(message, commands, input.beforeGuiCommand) : undefined;
	if (guiHandled !== undefined) return { kind: guiHandled ? "handled" : "blocked" };
	// The sidecar owns the authoritative run state. Passing the intended queue
	// lane through prompt closes the turn-end race: idle starts immediately,
	// while a genuinely active turn queues the same text as steer/follow-up.
	if (!isSlashCommand) {
		const streamingBehavior = mode === "followUp" ? "followUp" : "steer";
		return {
			kind: "send",
			request: () => rpc.prompt(message, images, streamingBehavior),
		};
	}
	return { kind: "send", request: () => rpc.prompt(message, images) };
}

/** Post-success settle: rehydrate local mutations, except live-only command output. */
export async function settleComposerResponse(
	response: RpcResponse,
	message?: string,
	hydrate: () => Promise<unknown> = hydrateSession,
): Promise<void> {
	if (!response.success) return;
	const data: unknown = response.data;
	const liveOnlyUsage = /^\/usage(?:\s|$)/i.test(message ?? "");
	if (
		response.command === "compact" ||
		(!liveOnlyUsage &&
			data !== null &&
			typeof data === "object" &&
			"agentInvoked" in data &&
			data.agentInvoked === false)
	) {
		await hydrate();
	}
}
