import type { SessionTarget, SshConnectionSnapshot, SshSessionTarget } from "./ipc-types";

const HOST_KEYS = [
	"host",
	"username",
	"port",
	"keyPath",
	"compat",
	"os",
	"shell",
	"transferShell",
	"sourceId",
	"sourceLevel",
] as const;
const TARGET_KEYS = ["type", "hostAlias", "host", "originCwd", "cwd", "executableOverride"] as const;

function sameRecordKeys(value: object, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = keys.filter(key => Object.hasOwn(value, key)).sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sameSshConnection(left: SshConnectionSnapshot, right: SshConnectionSnapshot): boolean {
	if (!sameRecordKeys(left, HOST_KEYS) || !sameRecordKeys(right, HOST_KEYS)) return false;
	return HOST_KEYS.every(key => left[key] === right[key]);
}

export function sameSessionTarget(left: SessionTarget, right: SessionTarget): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "local" || right.type === "local") {
		return (
			left.type === "local" &&
			right.type === "local" &&
			Object.keys(left).length === 1 &&
			Object.keys(right).length === 1
		);
	}
	if (!sameRecordKeys(left, TARGET_KEYS) || !sameRecordKeys(right, TARGET_KEYS)) return false;
	return (
		left.hostAlias === right.hostAlias &&
		left.originCwd === right.originCwd &&
		left.cwd === right.cwd &&
		left.executableOverride === right.executableOverride &&
		sameSshConnection(left.host, right.host)
	);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isSshConnectionSnapshot(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const host = value as Partial<SshSessionTarget["host"]>;
	if (typeof host.host !== "string" || typeof host.sourceId !== "string") return false;
	if (host.sourceLevel !== "user" && host.sourceLevel !== "project" && host.sourceLevel !== "native") return false;
	if (!isOptionalString(host.username) || !isOptionalString(host.keyPath)) return false;
	if (host.port !== undefined && typeof host.port !== "number") return false;
	if (host.compat !== undefined && typeof host.compat !== "boolean") return false;
	if (
		host.os !== undefined &&
		host.os !== "windows" &&
		host.os !== "linux" &&
		host.os !== "macos" &&
		host.os !== "unknown"
	) {
		return false;
	}
	if (
		host.shell !== undefined &&
		host.shell !== "cmd" &&
		host.shell !== "powershell" &&
		host.shell !== "bash" &&
		host.shell !== "zsh" &&
		host.shell !== "sh" &&
		host.shell !== "unknown"
	) {
		return false;
	}
	return (
		host.transferShell === undefined ||
		host.transferShell === "sh" ||
		host.transferShell === "bash" ||
		host.transferShell === "zsh"
	);
}

export function normalizeSessionTarget(target: unknown): SessionTarget {
	if (target === undefined) return { type: "local" };
	if (
		typeof target === "object" &&
		target !== null &&
		!Array.isArray(target) &&
		"type" in target &&
		target.type === "local"
	) {
		return target as SessionTarget;
	}
	if (isSshSessionTarget(target)) return target;
	throw new TypeError("Invalid session target");
}

export function isSshSessionTarget(target: unknown): target is SshSessionTarget {
	if (typeof target !== "object" || target === null || Array.isArray(target)) return false;
	const candidate = target as Partial<SshSessionTarget>;
	return (
		candidate.type === "ssh" &&
		typeof candidate.hostAlias === "string" &&
		isSshConnectionSnapshot(candidate.host) &&
		typeof candidate.originCwd === "string" &&
		typeof candidate.cwd === "string" &&
		isOptionalString(candidate.executableOverride)
	);
}
