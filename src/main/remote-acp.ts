import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { RemoteHistoryResult, RemoteHistorySession, SshSessionTarget } from "../shared/ipc-types";
import type {
	FinalRemoteTargetAuthorization,
	RemoteChildHandle,
	RemoteRuntimeInfo,
	RemoteSshService,
} from "./remote-ssh";

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_FRAMES = 256;
const MAX_PAGES = 100;
const MAX_SESSIONS = 10_000;
const MAX_ERROR_MESSAGE_LENGTH = 512;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface RemoteAcpClientOptions {
	timeoutMs?: number;
}

interface PendingRequest {
	id: number;
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface JsonRpcError {
	code: number;
	message: string;
}

interface SessionPage {
	sessions: unknown[];
	nextCursor: string | null | undefined;
}

class AcpProtocolError extends Error {}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
	if (!isPlainRecord(value)) throw new AcpProtocolError(message);
	return value;
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error && error.message ? error.message : "Remote session history failed";
	return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Remote history request was cancelled");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal));
	const result = Promise.withResolvers<T>();
	const onAbort = () => result.reject(abortError(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	promise.then(
		value => {
			signal.removeEventListener("abort", onAbort);
			result.resolve(value);
		},
		error => {
			signal.removeEventListener("abort", onAbort);
			result.reject(error);
		},
	);
	return result.promise;
}

function parseJsonRpcResponse(frame: unknown, expectedId: number): unknown {
	const envelope = requireRecord(frame, "ACP response must be a JSON object");
	if (envelope.jsonrpc !== "2.0") throw new AcpProtocolError("ACP response has an invalid JSON-RPC version");
	if (envelope.id !== expectedId) throw new AcpProtocolError("ACP response id did not match the request");

	const hasResult = Object.hasOwn(envelope, "result");
	const hasError = Object.hasOwn(envelope, "error");
	if (hasResult === hasError) throw new AcpProtocolError("ACP response must contain exactly one result or error");
	if (hasResult) return envelope.result;

	const rpcError = requireRecord(envelope.error, "ACP response contains an invalid JSON-RPC error");
	if (!Number.isInteger(rpcError.code) || typeof rpcError.message !== "string") {
		throw new AcpProtocolError("ACP response contains an invalid JSON-RPC error");
	}
	const error: JsonRpcError = { code: rpcError.code as number, message: rpcError.message };
	throw new AcpProtocolError(`Remote ACP error ${error.code}: ${error.message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}`);
}

class StrictAcpTransport {
	readonly #child: ChildProcess;
	readonly #stdin: Writable;
	readonly #stdout: Readable;
	readonly #signal: AbortSignal;
	#tail: Buffer[] = [];
	#tailBytes = 0;
	#frameCount = 0;
	#nextId = 1;
	#pending: PendingRequest | undefined;
	#failure: Error | undefined;
	#disposed = false;

	constructor(child: ChildProcess, signal: AbortSignal) {
		const stdin = child.stdin;
		const stdout = child.stdout;
		if (!stdin || !stdout) throw new AcpProtocolError("ACP process did not provide stdin and stdout");
		this.#child = child;
		this.#stdin = stdin;
		this.#stdout = stdout;
		this.#signal = signal;
		stdout.on("data", this.#onData);
		stdout.on("end", this.#onDisconnect);
		stdout.on("error", this.#onStreamError);
		child.on("error", this.#onStreamError);
		child.on("close", this.#onDisconnect);
		signal.addEventListener("abort", this.#onAbort, { once: true });
	}

	request(method: string, params: Record<string, unknown>): Promise<unknown> {
		if (this.#failure) return Promise.reject(this.#failure);
		if (this.#disposed) return Promise.reject(new AcpProtocolError("ACP transport is closed"));
		if (this.#pending) return Promise.reject(new AcpProtocolError("ACP client attempted concurrent requests"));
		if (this.#signal.aborted) return Promise.reject(abortError(this.#signal));

		const id = this.#nextId++;
		const pending = Promise.withResolvers<unknown>();
		this.#pending = { id, resolve: pending.resolve, reject: pending.reject };
		const frame = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
		try {
			this.#stdin.write(frame, error => {
				if (error) this.#fail(new AcpProtocolError("Failed to write to the ACP process"));
			});
		} catch {
			this.#fail(new AcpProtocolError("Failed to write to the ACP process"));
		}
		return pending.promise;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#stdout.off("data", this.#onData);
		this.#stdout.off("end", this.#onDisconnect);
		this.#stdout.off("error", this.#onStreamError);
		this.#child.off("error", this.#onStreamError);
		this.#child.off("close", this.#onDisconnect);
		this.#signal.removeEventListener("abort", this.#onAbort);
		if (this.#pending) {
			this.#pending.reject(new AcpProtocolError("ACP transport is closed"));
			this.#pending = undefined;
		}
	}

	readonly #onData = (value: Buffer | string): void => {
		if (this.#failure || this.#disposed) return;
		const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
		let start = 0;
		for (;;) {
			const newline = chunk.indexOf(0x0a, start);
			if (newline < 0) break;
			const piece = chunk.subarray(start, newline);
			const frameBytes = this.#tailBytes + piece.length;
			if (frameBytes > MAX_FRAME_BYTES) {
				this.#fail(new AcpProtocolError("ACP frame exceeded the maximum size"));
				return;
			}
			let frame: Buffer;
			if (this.#tail.length === 0) {
				frame = piece;
			} else {
				if (piece.length > 0) this.#tail.push(piece);
				frame = Buffer.concat(this.#tail, frameBytes);
				this.#tail = [];
				this.#tailBytes = 0;
			}
			if (frame.length > 0 && frame[frame.length - 1] === 0x0d) frame = frame.subarray(0, -1);
			this.#acceptFrame(frame);
			if (this.#failure) return;
			start = newline + 1;
		}
		const remaining = chunk.length - start;
		if (this.#tailBytes + remaining > MAX_FRAME_BYTES) {
			this.#fail(new AcpProtocolError("ACP frame exceeded the maximum size"));
			return;
		}
		if (remaining > 0) {
			const retained = Buffer.from(chunk.subarray(start));
			this.#tail.push(retained);
			this.#tailBytes += retained.length;
		}
	};

	readonly #onDisconnect = (): void => {
		this.#fail(new AcpProtocolError("ACP process disconnected"));
	};

	readonly #onStreamError = (): void => {
		this.#fail(new AcpProtocolError("ACP process disconnected"));
	};

	readonly #onAbort = (): void => {
		this.#fail(abortError(this.#signal));
	};

	#acceptFrame(bytes: Buffer): void {
		this.#frameCount += 1;
		if (this.#frameCount > MAX_FRAMES) {
			this.#fail(new AcpProtocolError("ACP response exceeded the maximum frame count"));
			return;
		}
		let frame: unknown;
		try {
			frame = JSON.parse(UTF8_DECODER.decode(bytes));
		} catch {
			this.#fail(new AcpProtocolError("ACP response contained malformed JSON"));
			return;
		}
		const pending = this.#pending;
		if (!pending) {
			this.#fail(new AcpProtocolError("ACP process sent an unexpected frame"));
			return;
		}
		try {
			const result = parseJsonRpcResponse(frame, pending.id);
			this.#pending = undefined;
			pending.resolve(result);
		} catch (error) {
			this.#fail(error instanceof Error ? error : new AcpProtocolError("ACP response was invalid"));
		}
	}

	#fail(error: Error): void {
		if (this.#failure || this.#disposed) return;
		this.#failure = error;
		if (this.#pending) {
			this.#pending.reject(error);
			this.#pending = undefined;
		}
	}
}

function supportsSessionList(result: unknown): boolean {
	const initialize = requireRecord(result, "ACP initialize result must be an object");
	if (initialize.protocolVersion !== ACP_PROTOCOL_VERSION) {
		throw new AcpProtocolError("Remote agent selected an unsupported ACP protocol version");
	}
	const capabilities = requireRecord(
		initialize.agentCapabilities,
		"ACP initialize result is missing agent capabilities",
	);
	if (capabilities.sessionCapabilities === undefined || capabilities.sessionCapabilities === null) return false;
	const sessionCapabilities = requireRecord(
		capabilities.sessionCapabilities,
		"ACP initialize result contains invalid session capabilities",
	);
	if (!Object.hasOwn(sessionCapabilities, "list") || sessionCapabilities.list === null) return false;
	requireRecord(sessionCapabilities.list, "ACP initialize result contains an invalid session list capability");
	return true;
}

function parseSessionPage(result: unknown): SessionPage {
	const page = requireRecord(result, "ACP session/list result must be an object");
	if (!Array.isArray(page.sessions)) throw new AcpProtocolError("ACP session/list result is missing sessions");
	const nextCursor = page.nextCursor;
	if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
		throw new AcpProtocolError("ACP session/list returned an invalid pagination cursor");
	}
	return { sessions: page.sessions, nextCursor };
}

function isAbsoluteRemotePath(cwd: string, platform: RemoteRuntimeInfo["platform"]): boolean {
	if (platform !== "windows") return cwd.startsWith("/");
	if (/^[A-Za-z]:[\\/]/.test(cwd)) return true;
	const uncPath = cwd.startsWith("\\\\") || cwd.startsWith("//");
	if (!uncPath) return false;
	const [server, share] = cwd.slice(2).split(/[\\/]/);
	return server.length > 0 && share !== undefined && share.length > 0;
}

function mapSession(
	value: unknown,
	target: SshSessionTarget,
	platform: RemoteRuntimeInfo["platform"],
): RemoteHistorySession {
	const session = requireRecord(value, "ACP session must be an object");
	if (typeof session.sessionId !== "string" || session.sessionId.length === 0) {
		throw new AcpProtocolError("ACP session is missing a valid sessionId");
	}
	if (typeof session.cwd !== "string" || !isAbsoluteRemotePath(session.cwd, platform)) {
		throw new AcpProtocolError("ACP session cwd must be absolute");
	}
	if (session.title !== undefined && typeof session.title !== "string") {
		throw new AcpProtocolError("ACP session title must be a string");
	}
	if (session.updatedAt !== undefined && typeof session.updatedAt !== "string") {
		throw new AcpProtocolError("ACP session updatedAt must be a string");
	}
	let meta: Record<string, unknown> | undefined;
	if (session._meta !== undefined) {
		meta = { ...requireRecord(session._meta, "ACP session metadata must be an object") };
	}
	return {
		target: {
			...target,
			host: { ...target.host },
			originCwd: session.cwd,
			cwd: session.cwd,
		},
		sessionId: session.sessionId,
		cwd: session.cwd,
		title: typeof session.title === "string" ? session.title : null,
		updatedAt: typeof session.updatedAt === "string" ? session.updatedAt : null,
		...(meta === undefined ? {} : { meta }),
	};
}

async function listAllSessions(
	transport: StrictAcpTransport,
	target: SshSessionTarget,
	runtime: RemoteRuntimeInfo,
): Promise<RemoteHistoryResult> {
	const initialize = await transport.request("initialize", {
		protocolVersion: ACP_PROTOCOL_VERSION,
		clientCapabilities: {},
	});
	if (!supportsSessionList(initialize)) {
		return {
			ok: false,
			unsupported: true,
			error: "Remote agent does not support session history",
		};
	}

	const sessions: RemoteHistorySession[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	let pageCount = 0;
	for (;;) {
		const page = parseSessionPage(await transport.request("session/list", cursor === undefined ? {} : { cursor }));
		pageCount += 1;
		if (sessions.length + page.sessions.length > MAX_SESSIONS) {
			throw new AcpProtocolError(`ACP session listing exceeded ${MAX_SESSIONS} sessions`);
		}
		for (const session of page.sessions) sessions.push(mapSession(session, target, runtime.platform));

		if (page.nextCursor === undefined || page.nextCursor === null) return { ok: true, sessions };
		if (cursors.has(page.nextCursor)) throw new AcpProtocolError("ACP session pagination cursor repeated");
		cursors.add(page.nextCursor);
		cursor = page.nextCursor;
		if (pageCount >= MAX_PAGES) {
			throw new AcpProtocolError(`ACP session listing exceeded ${MAX_PAGES} pages`);
		}
	}
}

export class RemoteAcpClient {
	readonly #ssh: Pick<RemoteSshService, "resolveRuntime" | "spawnAcp">;
	readonly #timeoutMs: number;

	constructor(ssh: Pick<RemoteSshService, "resolveRuntime" | "spawnAcp">, options: RemoteAcpClientOptions = {}) {
		this.#ssh = ssh;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async listSessions(
		target: SshSessionTarget,
		finalAuthorization: FinalRemoteTargetAuthorization,
	): Promise<RemoteHistoryResult> {
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(new Error("Remote history request timed out")), this.#timeoutMs);
		let handle: RemoteChildHandle | undefined;
		let transport: StrictAcpTransport | undefined;
		let result: RemoteHistoryResult;
		try {
			const resolution = await raceWithAbort(this.#ssh.resolveRuntime(target, deadline.signal), deadline.signal);
			if (!resolution.ok) {
				result = { ok: false, error: resolution.error };
			} else {
				const freshTarget = finalAuthorization();
				if (!freshTarget) {
					result = { ok: false, error: "Stale or altered SSH target" };
				} else {
					handle = this.#ssh.spawnAcp(freshTarget, resolution.runtime);
					transport = new StrictAcpTransport(handle.child, deadline.signal);
					result = await listAllSessions(transport, freshTarget, resolution.runtime);
				}
			}
		} catch (error) {
			result = { ok: false, error: errorMessage(error) };
		} finally {
			clearTimeout(timer);
			transport?.dispose();
			if (handle) {
				try {
					await handle.terminate();
				} catch (error) {
					result = { ok: false, error: `Failed to close remote ACP process: ${errorMessage(error)}` };
				}
			}
		}
		return result;
	}
}
