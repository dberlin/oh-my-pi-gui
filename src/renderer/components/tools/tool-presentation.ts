import { sanitizeToolText } from "../../lib/format";
import { editArgumentSummary } from "./edit-args";

export type ToolPresentationMode = "execute" | "help";

export interface ToolPresentationInput {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	partialResult: unknown;
	isError: boolean;
	streamingArgs?: string;
}

export interface McpIdentity {
	serverName: string;
	toolName: string;
}

export interface EffectiveToolInvocation {
	name: string;
	args: Record<string, unknown>;
	result: unknown;
	partialResult: unknown;
	isError: boolean;
	transport: "direct" | "xdev";
	/** Only dispatched device calls have a specialized result to render. */
	dispatched?: boolean;
	mode: ToolPresentationMode;
	mcp?: McpIdentity;
}

interface XdevDetails {
	tool: string;
	mode: ToolPresentationMode;
	args: Record<string, unknown> | undefined;
	inner: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function deviceName(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	const match = /^xd:\/\/([^/?#]+)\/?$/.exec(path);
	return match?.[1];
}

function decodeRecordJson(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(value);
		return asRecord(parsed);
	} catch {
		return undefined;
	}
}

function decodeInnerArgs(content: unknown): Record<string, unknown> {
	if (typeof content !== "string" || content.length === 0) return {};
	try {
		const parsed: unknown = JSON.parse(content);
		return asRecord(parsed) ?? { __partialJson: content };
	} catch {
		return { __partialJson: content };
	}
}

function replaceDetails(result: unknown, details: unknown): unknown {
	const envelope = asRecord(result);
	return envelope ? { ...envelope, details: details ?? null } : result;
}

function xdevDetails(value: unknown): XdevDetails | undefined {
	const envelope = asRecord(value);
	const details = asRecord(envelope?.details);
	const xdev = asRecord(details?.xdev);
	if (!xdev) return undefined;
	const tool = xdev.tool;
	const mode = xdev.mode;
	if (typeof tool !== "string" || tool.length === 0 || (mode !== "execute" && mode !== "help")) {
		return undefined;
	}
	return {
		tool,
		mode,
		args: asRecord(xdev.args),
		inner: xdev.inner,
	};
}

function mcpIdentity(details: unknown): McpIdentity | undefined {
	const record = asRecord(details);
	const serverName = record?.serverName;
	const toolName = record?.mcpToolName;
	if (
		typeof serverName !== "string" ||
		serverName.length === 0 ||
		typeof toolName !== "string" ||
		toolName.length === 0
	) {
		return undefined;
	}
	return { serverName, toolName };
}

function mcpIdentityFromName(name: string): McpIdentity | undefined {
	if (!name.startsWith("mcp__")) return undefined;
	const rest = name.slice(5);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx < 0) return undefined;
	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}

function directInvocation(input: ToolPresentationInput): EffectiveToolInvocation {
	const nameMcp = mcpIdentityFromName(input.name);
	const selectedResult = input.result == null ? input.partialResult : input.result;
	const detailsMcp = nameMcp ? mcpIdentity(asRecord(selectedResult)?.details) : undefined;
	const mcp = detailsMcp ?? nameMcp;
	return {
		name: input.name,
		args: input.args,
		result: input.result,
		partialResult: input.partialResult,
		isError: input.isError,
		transport: "direct",
		mode: "execute",
		...(mcp ? { mcp } : {}),
	};
}

export function resolveToolPresentation(input: ToolPresentationInput): EffectiveToolInvocation {
	const partialXdev = xdevDetails(input.partialResult);
	const resultXdev = xdevDetails(input.result);
	const authoritative = input.result == null ? partialXdev : resultXdev;

	if (authoritative) {
		const mcp = mcpIdentity(authoritative.inner) ?? mcpIdentityFromName(authoritative.tool);
		const outerArgs = input.name === "write" ? decodeRecordJson(input.args.content) : undefined;
		return {
			name: authoritative.tool,
			args: authoritative.args ?? outerArgs ?? {},
			result: resultXdev ? replaceDetails(input.result, resultXdev.inner) : input.result,
			partialResult: partialXdev ? replaceDetails(input.partialResult, partialXdev.inner) : input.partialResult,
			isError: input.isError,
			transport: "xdev",
			dispatched: true,
			mode: authoritative.mode,
			...(mcp ? { mcp } : {}),
		};
	}

	if (input.name !== "write") return directInvocation(input);

	const streamedArgs = decodeRecordJson(input.streamingArgs);
	const outerArgs = deviceName(input.args.path) ? input.args : streamedArgs;
	const tool = deviceName(outerArgs?.path);
	if (!outerArgs || !tool) return directInvocation(input);
	const mcp = mcpIdentityFromName(tool);

	return {
		name: tool,
		args: decodeInnerArgs(outerArgs.content),
		result: input.result,
		partialResult: input.partialResult,
		isError: input.isError,
		transport: "xdev",
		dispatched: false,
		mode: "execute",
		...(mcp ? { mcp } : {}),
	};
}

function pickString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function boundedSummary(value: string): string {
	const summary = sanitizeToolText(value.split("\n", 1)[0] ?? "");
	if (summary.length <= 160) return summary;
	let prefix = summary.slice(0, 159);
	const trailingCodeUnit = prefix.charCodeAt(prefix.length - 1);
	if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) {
		prefix = prefix.slice(0, -1);
	}
	return `${prefix}…`;
}

export function toolPresentationSummary(invocation: EffectiveToolInvocation): string {
	return boundedSummary(invocationSummary(invocation));
}

function invocationSummary(invocation: EffectiveToolInvocation): string {
	if (invocation.mcp) return `${invocation.mcp.serverName}/${invocation.mcp.toolName}`;
	const args = invocation.args;
	switch (invocation.name) {
		case "browser": {
			const action = pickString(args, "action");
			const target = pickString(args, "url", "tab", "name");
			return action && target ? `${action} ${target}` : (action ?? target ?? "");
		}
		case "read":
		case "write":
			return pickString(args, "path", "file") ?? "";
		case "edit":
		case "apply_patch":
			return editArgumentSummary(args);
		case "bash":
			return pickString(args, "command", "cmd") ?? "";
		case "grep":
			return pickString(args, "pattern") ?? "";
		case "find":
			return pickString(args, "query") ?? "";
		case "ast_grep":
			return pickString(args, "pat", "pattern", "query") ?? "";
		case "ast_edit":
			return pickString(args, "pat", "pattern") ?? "";
		case "glob":
			return pickString(args, "path", "pattern") ?? "";
		case "task":
			return pickString(args, "i", "name", "description") ?? "";
		case "eval":
			return pickString(args, "title", "language") ?? "";
		case "goal":
			return pickString(args, "objective", "op") ?? "";
		case "resolve":
		case "reject":
			return pickString(args, "reason", "label") ?? "";
		case "web_search":
			return pickString(args, "query", "i") ?? "";
		case "lsp":
		case "debug":
			return [pickString(args, "action"), pickString(args, "symbol", "file", "path", "program")]
				.filter(Boolean)
				.join(" ");
		case "todo":
		case "todowrite":
		case "todo_write":
		case "set_todos":
			return [pickString(args, "op"), pickString(args, "task", "reason")].filter(Boolean).join(" ");
		case "github":
		case "gh":
			return pickString(args, "action", "repo", "url") ?? "";
		case "hub":
			return pickString(args, "op", "agent") ?? "";
		case "ask":
			return pickString(args, "question", "i") ?? "";
		case "checkpoint":
			return pickString(args, "goal") ?? "";
		case "rewind":
			return pickString(args, "report") ?? "";
		case "security_scan":
			return pickString(args, "action", "target_kind") ?? "";
		case "context_notes":
		case "tts":
			return pickString(args, "text") ?? "";
		case "learn":
			return pickString(args, "memory") ?? "";
		case "manage_skill":
			return [pickString(args, "action"), pickString(args, "name")].filter(Boolean).join(" ");
		case "memory_edit":
			return [pickString(args, "op"), pickString(args, "id")].filter(Boolean).join(" ");
		case "retain": {
			const first = Array.isArray(args.items) ? args.items[0] : undefined;
			return typeof first === "string"
				? first
				: (pickString(asRecord(first) ?? {}, "content", "text") ?? pickString(args, "text", "memory") ?? "");
		}
		case "recall":
			return pickString(args, "query", "text") ?? "";
		case "reflect":
			return pickString(args, "topic", "query") ?? "";
		case "generate_image":
			return pickString(args, "subject", "prompt") ?? "";
		default:
			return pickString(args, "path", "file", "name", "pattern", "query", "command", "action", "i", "text") ?? "";
	}
}
