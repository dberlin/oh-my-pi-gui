/**
 * Sidecar lifecycle manager: spawns omp --mode rpc-ui, handles restart,
 * routes frames to RpcClient and EventBatcher.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Store from "electron-store";
import { parseLaunchProfile, profileToFlags, stripDenylistedFlags } from "../renderer/lib/launch-profile";
import type {
	AgentSessionEvent,
	CommandOutputFrame,
	ConfigUpdateFrame,
	ExtensionErrorFrame,
	ExtensionUIRequest,
	HostToolCallRequest,
	HostUriRequest,
	ModelCatalogUpdateFrame,
	OutboundFrame,
	PromptResultFrame,
	RpcLiveUpdateFrame,
	RpcReadyFrame,
	RpcResponse,
	SessionInfoUpdateFrame,
	SidecarStatus,
	SubagentFrame,
} from "../shared/rpc-types";
import { EventBatcher } from "./event-batcher";
import { RpcClient } from "./rpc-client";

import { PassThrough, type Readable } from "node:stream";
import type { SessionTarget, SshSessionTarget } from "../shared/ipc-types";
import type { RemoteHostCatalog } from "./remote-host-catalog";
import type { RemoteChildHandle, RemoteSshService } from "./remote-ssh";

import { sameSessionTarget } from "../shared/session-target";
import { attachNdjsonParser, RPC_MAX_FRAME_BYTES, supportsRpcProtocolV2 } from "./rpc-bridge";

/**
 * routes frames to RpcClient and EventBatcher.
 */

/**
 * routes frames to RpcClient and EventBatcher.
 */

const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS = [1000, 2000, 4000];
const REMOTE_STDERR_CAP_BYTES = 16_384;
export const REMOTE_STDOUT_RATE_WINDOW_MS = 1_000;
export const REMOTE_STDOUT_UTF8_BYTE_BUDGET = 16 * 1024 * 1024;
export const REMOTE_STDOUT_FRAME_BUDGET = 4_096;
const REMOTE_HOST_TOOL_AUTHORITY_MAX_LENGTH = 128;
const REMOTE_HOST_TOOL_DENIAL = "Host tools are unavailable for remote SSH sessions";
const INVALID_REMOTE_HOST_TOOL_REQUEST = "Invalid remote host-tool request";

function isBoundedAuthorityString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= REMOTE_HOST_TOOL_AUTHORITY_MAX_LENGTH;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function isValidRemoteHostToolRequest(value: Record<string, unknown>): boolean {
	return (
		isBoundedAuthorityString(value.id) &&
		isBoundedAuthorityString(value.toolCallId) &&
		isBoundedAuthorityString(value.toolName) &&
		isPlainObject(value.arguments)
	);
}
/** Event types routed to the EventBatcher. Hoisted: one lookup table for the
 * process, not one allocation per frame. */
const AGENT_EVENT_TYPES: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	retry_fallback_applied: true,
	retry_fallback_succeeded: true,
	model_changed: true,
	ttsr_triggered: true,
	todo_reminder: true,
	todo_auto_clear: true,
	irc_message: true,
	notice: true,
	thinking_level_changed: true,
	goal_updated: true,
	loop_mode_update: true,
	plan_proposal: true,
	queue_update: true,
};

export interface SidecarOptions {
	binaryPath: string;
	cwd: string;
	extraFlags?: string[];
	/** Fresh GUI tabs must not inherit the CLI's persistent autoResume setting. */
	fresh?: boolean;
	/** Session kind: "agent" (default) or "chat" (tool-free conversation). Immutable per sidecar. */
	kind?: "agent" | "chat";
	/** When set, spawn the workspace source CLI via bun instead of the installed binary. */
	sourceCli?: string;
	/**
	 * Resolves proxy env vars (PI_PROXY / HTTPS_PROXY / …) injected at spawn —
	 * the GUI proxy pref or the macOS system proxy. Finder-launched apps have
	 * no shell env, so without this a proxy-only network (e.g. codex's
	 * chatgpt.com backend behind a firewall) hangs every provider request.
	 * Called on every start()/restart(); crash-loop respawns reuse the last
	 * result. Resolution failure degrades to no proxy env, never a spawn block.
	 */
	proxyEnv?: () => Promise<Record<string, string>>;
	/**
	 * Resolves the login-shell PATH overlay injected at spawn. Finder-launched
	 * apps inherit launchd's bare PATH, so agent-spawned tools configured by
	 * bare name (MCP servers, CLI helpers) die with ENOENT while the terminal
	 * TUI works. Same point-of-use pattern as proxyEnv: called on every
	 * start()/restart(), failure degrades to the inherited PATH.
	 */
	shellEnv?: () => Promise<Record<string, string>>;
	/** Normalized immutable session target supplied by SidecarPool. Absent only for direct legacy/local construction. */
	target?: SessionTarget;
	/** Remote session identity used by SSH `--resume`; never a local session path. */
	resumeSessionId?: string;
	/** App-lifetime SSH dependencies are composed once in main. */
	remoteSsh?: RemoteSshService;
	remoteHostCatalog?: RemoteHostCatalog;
}

/**
 * Load the workspace's launch profile from GUI prefs (`launchProfiles.<cwd>`)
 * and map it to agent CLI flags. Prefs access mirrors the 0.3.1 proxy-env
 * pattern (point-of-use electron-store read); any failure — prefs unreadable,
 * non-electron test env, malformed JSON — degrades to no flags, never a
 * spawn block. Profile changes require a sidecar restart: flags are
 * spawn-time argv, there is no live apply.
 */
function loadLaunchProfileFlags(cwd: string): string[] {
	try {
		// projectName is only a fallback for electron-less environments (tests):
		// with the app present, electron-store's own userData cwd wins and the
		// store matches index.ts/ipc.ts exactly. A pre-typed variable sidesteps
		// the excess-property check — electron-store's Options type hides
		// projectName, but its constructor passes it through to conf.
		const storeOptions = { name: "prefs", projectName: "omp-gui" };
		const profiles = new Store<{ launchProfiles?: Record<string, unknown> }>(storeOptions).get("launchProfiles");
		if (typeof profiles !== "object" || profiles === null) return [];
		return profileToFlags(parseLaunchProfile(profiles[cwd]));
	} catch {
		return [];
	}
}

/** Resolve the bun executable for source-sidecar spawns (PATH fallback last). */
function resolveBunExe(): string {
	if (process.env.OMP_BUN) return process.env.OMP_BUN;
	for (const candidate of [join(homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]) {
		if (existsSync(candidate)) return candidate;
	}
	return "bun";
}

export interface SidecarEvents {
	status: (payload: { status: SidecarStatus; message?: string; cwd: string }) => void;
	events: (events: AgentSessionEvent[]) => void;
	extensionUi: (request: ExtensionUIRequest) => void;
	hostToolCall: (request: HostToolCallRequest) => void;
	hostUriRequest: (request: HostUriRequest) => void;
	subagentFrame: (frame: SubagentFrame) => void;
	liveUpdate: (frame: RpcLiveUpdateFrame) => void;
	modelCatalogUpdate: (frame: ModelCatalogUpdateFrame) => void;
	commandsUpdate: (commands: unknown[]) => void;
	frame: (frame: OutboundFrame) => void;
}

interface RemoteStdoutGuard {
	stream: Readable;
	detach: () => void;
}

export function createRemoteStdoutGuard(
	stdout: Readable,
	onFailure: (reason: string) => void,
	validated = new PassThrough(),
): RemoteStdoutGuard {
	const decoder = new TextDecoder();
	let pending = "";
	let failed = false;
	let blocked = false;
	let ended = false;
	let windowStartedAt = Date.now();
	let windowBytes = 0;
	let windowFrames = 0;

	const detach = (): void => {
		stdout.off("data", onData);
		stdout.off("end", onEnd);
		validated.off("drain", onDrain);
		validated.destroy();
	};
	const reject = (reason: string): void => {
		if (failed) return;
		failed = true;
		detach();
		onFailure(reason);
	};
	const validateLine = (line: string): boolean => {
		// Measure the complete decoded line in UTF-8 before trimming, parsing,
		// or letting the downstream readline parser route it. String.length
		// counts UTF-16 code units and undercounts multibyte protocol bytes.
		if (Buffer.byteLength(line, "utf8") > RPC_MAX_FRAME_BYTES) return false;
		const trimmed = line.trim();
		if (!trimmed) return true;
		try {
			const frame: unknown = JSON.parse(trimmed);
			return typeof frame === "object" && frame !== null && !Array.isArray(frame);
		} catch {
			return false;
		}
	};
	const consumeBudget = (lineBytes: number): boolean => {
		const now = Date.now();
		if (now - windowStartedAt >= REMOTE_STDOUT_RATE_WINDOW_MS) {
			windowStartedAt = now;
			windowBytes = 0;
			windowFrames = 0;
		}
		if (windowBytes + lineBytes > REMOTE_STDOUT_UTF8_BYTE_BUDGET || windowFrames + 1 > REMOTE_STDOUT_FRAME_BUDGET) {
			return false;
		}
		windowBytes += lineBytes;
		windowFrames++;
		return true;
	};
	const drainPending = (): void => {
		let newline = pending.indexOf("\n");
		while (newline >= 0 && !failed) {
			const line = pending.slice(0, newline);
			const lineBytes = Buffer.byteLength(line, "utf8") + 1;
			if (!consumeBudget(lineBytes)) {
				reject("Remote stdout rate limit exceeded");
				return;
			}
			if (!validateLine(line)) {
				reject("Invalid NDJSON on remote stdout");
				return;
			}
			pending = pending.slice(newline + 1);
			if (!validated.write(`${line}\n`)) {
				blocked = true;
				stdout.pause();
				validated.once("drain", onDrain);
				return;
			}
			newline = pending.indexOf("\n");
		}
		if (!failed && Buffer.byteLength(pending, "utf8") > RPC_MAX_FRAME_BYTES) {
			reject("Invalid NDJSON on remote stdout");
			return;
		}
		if (ended && !failed) {
			if (pending.trim()) {
				reject("Invalid NDJSON on remote stdout");
				return;
			}
			validated.end();
		}
	};
	function onDrain(): void {
		if (failed || !blocked) return;
		blocked = false;
		drainPending();
		if (!failed && !blocked && !ended) stdout.resume();
	}
	function onData(chunk: Buffer): void {
		if (failed) return;
		pending += decoder.decode(chunk, { stream: true });
		drainPending();
	}
	function onEnd(): void {
		if (failed) return;
		pending += decoder.decode();
		ended = true;
		if (!blocked) drainPending();
	}

	stdout.on("data", onData);
	stdout.on("end", onEnd);
	return { stream: validated, detach };
}
export class SidecarManager extends EventEmitter {
	#child: ChildProcess | null = null;
	#rpcClient: RpcClient | null = null;
	#batcher: EventBatcher | null = null;
	#detachParser: (() => void) | null = null;
	#restartCount = 0;
	#restartTimer: NodeJS.Timeout | null = null;
	#status: SidecarStatus = "starting";
	#options: SidecarOptions;
	#proxyEnvVars: Record<string, string> = {};
	#shellEnvVars: Record<string, string> = {};
	#resumeSessionPath: string | null = null;
	#remoteChildHandle: RemoteChildHandle | null = null;
	#remoteAbortController: AbortController | null = null;
	#remoteStartPromise: Promise<void> | null = null;
	#remoteTerminationPromise: Promise<void> | null = null;
	#remoteRestartPromise: Promise<void> | null = null;
	#remoteRestartGeneration = 0;
	#remoteStderrTail: Buffer = Buffer.alloc(0);
	#remotePreparingChild: ChildProcess | null = null;
	#localPreparingChild: ChildProcess | null = null;
	#remoteLaunchResumed = false;
	#latestRemoteSessionId: string | null;
	#disposePromise: Promise<void> | null = null;
	#freshLaunchPending: boolean;
	#disposed = false;

	constructor(options: SidecarOptions) {
		super();
		this.#options = options;
		this.#freshLaunchPending = options.fresh === true;
		this.#latestRemoteSessionId = options.resumeSessionId ?? null;
	}

	get status(): SidecarStatus {
		return this.#status;
	}

	get cwd(): string {
		return this.#options.cwd;
	}

	get rpcClient(): RpcClient | null {
		return this.#rpcClient;
	}

	start(): void {
		if (this.#disposed) return;
		const target = this.#options.target;
		if (target?.type === "ssh") {
			const pending = this.#startRemote(target);
			this.#remoteStartPromise = pending;
			void pending.finally(() => {
				if (this.#remoteStartPromise === pending) this.#remoteStartPromise = null;
			});
			return;
		}
		// Closed loop: only the bundled binary (or an explicit source override)
		// may run. Missing it is an actionable error, never an external fallback.
		if (!this.#options.binaryPath && !this.#options.sourceCli) {
			this.#setStatus(
				"error",
				"Built-in omp not found. Build it with `bun --cwd=packages/gui run build:omp`, then relaunch.",
			);
			return;
		}
		this.#setStatus("starting");
		const resolveProxyEnv = this.#options.proxyEnv;
		const resolveShellEnv = this.#options.shellEnv;
		if (!resolveProxyEnv && !resolveShellEnv) {
			this.#spawn();
			return;
		}
		const fallback = () => ({}) as Record<string, string>;
		void Promise.all([
			resolveProxyEnv ? resolveProxyEnv().catch(fallback) : Promise.resolve({}),
			resolveShellEnv ? resolveShellEnv().catch(fallback) : Promise.resolve({}),
		]).then(([proxyEnv, shellEnv]) => {
			if (this.#disposed) return;
			this.#proxyEnvVars = proxyEnv;
			this.#shellEnvVars = shellEnv;
			this.#spawn();
		});
	}

	async #startRemote(target: SshSessionTarget): Promise<void> {
		const remoteSsh = this.#options.remoteSsh;
		const remoteHostCatalog = this.#options.remoteHostCatalog;
		if (!remoteSsh || !remoteHostCatalog) {
			this.#setStatus("error", this.#remoteError("SSH services are unavailable"));
			return;
		}
		const controller = new AbortController();
		this.#remoteAbortController = controller;
		this.#remoteStderrTail = Buffer.alloc(0);
		this.#setStatus("starting", `Resolving SSH host ${target.hostAlias}`);
		this.#setStatus("starting", `Authenticating SSH host ${target.hostAlias}`);
		this.#setStatus("starting", `Probing remote runtime on ${target.hostAlias}`);
		try {
			const resolution = await remoteSsh.resolveRuntime(target, controller.signal);
			if (this.#disposed || this.#remoteAbortController !== controller) return;
			if (!resolution.ok) {
				this.#remoteAbortController = null;
				this.#attemptRestart(this.#remoteError(resolution.error));
				return;
			}

			const canonicalOrigin = remoteHostCatalog.target(resolution.target.hostAlias, resolution.target.originCwd);
			const canonicalTarget = canonicalOrigin ? { ...canonicalOrigin, cwd: resolution.target.cwd } : null;
			if (!canonicalTarget || !sameSessionTarget(resolution.target, canonicalTarget)) {
				this.#remoteAbortController = null;
				this.#setStatus("error", this.#remoteError("Stale or altered SSH target"));
				return;
			}

			const args = ["--mode", "rpc-ui", "--cwd", resolution.target.cwd];
			const resumeSessionId = this.#latestRemoteSessionId;
			this.#remoteLaunchResumed = resumeSessionId !== null;
			if (resumeSessionId) args.push("--resume", resumeSessionId);
			const isChat = this.#options.kind === "chat";
			if (isChat) args.push("--no-tools");
			const userFlags = [...(this.#options.extraFlags ?? []), ...loadLaunchProfileFlags(resolution.target.cwd)];
			args.push(...stripDenylistedFlags(userFlags, isChat));

			this.#setStatus("starting", `Launching remote omp on ${target.hostAlias}`);
			const handle = remoteSsh.spawnRpc(resolution.target, resolution.runtime, args);
			if (this.#disposed || this.#remoteAbortController !== controller) {
				await handle.terminate();
				return;
			}
			this.#remoteAbortController = null;
			this.#remoteChildHandle = handle;
			this.#attachChild(handle.child, true);
		} catch (error) {
			if (this.#disposed || this.#remoteAbortController !== controller) return;
			this.#remoteAbortController = null;
			this.#attemptRestart(this.#remoteError(error instanceof Error ? error.message : String(error)));
		}
	}

	#spawn(): void {
		const { binaryPath, sourceCli, cwd, extraFlags } = this.#options;

		const args = ["--mode", "rpc-ui"];
		if (this.#resumeSessionPath) args.push("--session", this.#resumeSessionPath);
		const isChat = this.#options.kind === "chat";
		if (isChat) args.push("--no-tools");
		// User-controllable flags ride the extraFlags seam + the launch profile.
		// Strip the code-controlled-flag denylist (pair-aware) over BOTH, then
		// append: neither can override the code-controlled argv above. Chat
		// launches also strip tool selections so --no-tools remains authoritative.
		const userFlags = [...(extraFlags ?? []), ...loadLaunchProfileFlags(cwd)];
		args.push(...stripDenylistedFlags(userFlags, isChat));

		// Source sidecar (monorepo dev): run the workspace coding-agent from
		// source via bun so in-repo RPC fixes are live in the running GUI.
		// Falls back to the installed binary when no workspace source exists.
		const command = sourceCli ? resolveBunExe() : binaryPath;
		const spawnArgs = sourceCli ? [sourceCli, ...args] : args;
		console.log(`[sidecar] spawning ${sourceCli ? "source" : "bundled"} omp (${args.length} args, cwd: ${cwd})`);

		let child: ChildProcess;
		try {
			child = spawn(command, spawnArgs, {
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					// Login-shell PATH first so the GUI proxy pref (and inherited
					// proxy env) keeps precedence over rc-file proxy exports.
					...this.#shellEnvVars,
					...this.#proxyEnvVars,
					PI_RPC_EMIT_TITLE: "1",
					PI_NO_PTY: "1",
					PI_NOTIFICATIONS: "off",
				},
				cwd,
			});
		} catch (err) {
			// spawn() throws synchronously (EBADF/ENOENT) — surface it as a
			// sidecar failure + retry, never an uncaught main-process exception.
			this.#attemptRestart(err instanceof Error ? err.message : String(err));
			return;
		}

		this.#attachChild(child, false);
	}

	#attachChild(child: ChildProcess, remote: boolean): void {
		this.#child = child;

		// Set up RPC client with stdin writer
		const send = (frame: object) => {
			if (child.stdin?.writable) {
				child.stdin.write(`${JSON.stringify(frame)}\n`);
			}
		};
		this.#rpcClient = new RpcClient(send);

		// Set up event batcher
		this.#batcher = new EventBatcher(events => {
			this.emit("events", events);
		});

		if (child.stdout) {
			const guard = remote ? this.#attachRemoteStdoutGuard(child) : null;
			const parserStream = guard?.stream ?? child.stdout;
			const detachParser = attachNdjsonParser(parserStream, frame => this.#routeFrame(frame));
			this.#detachParser = () => {
				guard?.detach();
				detachParser();
			};
		}

		child.stderr?.on("data", (chunk: Buffer) => {
			if (remote) this.#appendRemoteStderr(chunk);
			const text = chunk.toString("utf-8").trim();
			if (text) {
				console.error(`[sidecar stderr] ${text}`);
				this.emit("stderr", text);
			}
		});

		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#cleanup();
			if (this.#disposed) return;

			if (code === 0) {
				this.#setStatus("exited", "Normal shutdown");
			} else {
				const reason = `Exit code ${code}${signal ? ` (signal: ${signal})` : ""}`;
				this.#attemptRestart(remote ? this.#remoteError(reason) : reason);
			}
		});

		child.on("error", error => {
			if (this.#child !== child) return;
			this.#cleanup();
			if (this.#disposed) return;
			this.#attemptRestart(remote ? this.#remoteError(error.message) : error.message);
		});
	}

	#attachRemoteStdoutGuard(child: ChildProcess): RemoteStdoutGuard {
		const stdout = child.stdout;
		if (!stdout) return { stream: new PassThrough(), detach: () => {} };
		return createRemoteStdoutGuard(stdout, reason => {
			if (this.#child === child) this.#failRemote(reason);
		});
	}

	#appendRemoteStderr(chunk: Buffer): void {
		if (chunk.length >= REMOTE_STDERR_CAP_BYTES) {
			this.#remoteStderrTail = chunk.subarray(chunk.length - REMOTE_STDERR_CAP_BYTES);
			return;
		}
		const overflow = this.#remoteStderrTail.length + chunk.length - REMOTE_STDERR_CAP_BYTES;
		const retained = overflow > 0 ? this.#remoteStderrTail.subarray(overflow) : this.#remoteStderrTail;
		this.#remoteStderrTail = Buffer.concat([retained, chunk], retained.length + chunk.length);
	}

	#routeFrame(frame: unknown): void {
		if (typeof frame !== "object" || frame === null) return;
		const obj = frame as Record<string, unknown>;

		// Ready frame
		if (obj.type === "ready") {
			this.#handleReady(obj as unknown as RpcReadyFrame);
			return;
		}

		// Response frame → route to RPC client
		if (obj.type === "response") {
			const handled = this.#rpcClient?.onResponse(obj as unknown as RpcResponse);
			if (handled) return;
		}

		// Extension UI request
		if (obj.type === "extension_ui_request") {
			this.emit("extensionUi", obj as ExtensionUIRequest);
			this.emit("frame", obj);
			return;
		}

		// Host tool/URI requests
		if (obj.type === "host_tool_call") {
			if (this.denyRemoteHostTool(obj)) return;
			this.emit("hostToolCall", obj as unknown as HostToolCallRequest);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "host_uri_request") {
			this.emit("hostUriRequest", obj as unknown as HostUriRequest);
			this.emit("frame", obj);
			return;
		}

		// Subagent frames
		if (obj.type === "subagent_lifecycle" || obj.type === "subagent_progress" || obj.type === "subagent_event") {
			this.emit("subagentFrame", obj as unknown as SubagentFrame);
			this.emit("frame", obj);
			return;
		}

		// Available commands update
		if (obj.type === "available_commands_update") {
			this.emit("commandsUpdate", (obj as { commands: unknown[] }).commands);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "model_catalog_update") {
			this.emit("modelCatalogUpdate", obj as unknown as ModelCatalogUpdateFrame);
			this.emit("frame", obj);
			return;
		}

		// Config update (set_setting, slash-command config edits)
		if (obj.type === "config_update") {
			this.emit("configUpdate", obj as unknown as ConfigUpdateFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "prompt_result") {
			this.emit("promptResult", obj as unknown as PromptResultFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "command_output") {
			this.emit("commandOutput", obj as unknown as CommandOutputFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "session_info_update") {
			const frame = obj as unknown as SessionInfoUpdateFrame;
			if (
				this.#options.target?.type === "ssh" &&
				typeof frame.sessionId === "string" &&
				frame.sessionId.length > 0
			) {
				this.#latestRemoteSessionId = frame.sessionId;
			}
			this.emit("sessionInfoUpdate", frame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "extension_error") {
			this.emit("extensionError", obj as unknown as ExtensionErrorFrame);
			this.emit("frame", obj);
			return;
		}
		if (obj.type === "live_update") {
			this.emit("liveUpdate", obj as unknown as RpcLiveUpdateFrame);
			this.emit("frame", obj);
			return;
		}

		// Agent session events → batcher
		if (AGENT_EVENT_TYPES[obj.type as string] === true) {
			this.#batcher?.push(obj as AgentSessionEvent);
			this.emit("frame", obj);
			return;
		}

		// Other extension/host frames not consumed directly by the renderer.
		this.emit("frame", obj);
	}

	#handleReady(ready: RpcReadyFrame): void {
		if (this.#options.target?.type === "ssh") {
			void this.#prepareRemote(ready);
			return;
		}
		void this.#prepareLocal(ready);
	}

	async #prepareLocal(ready: RpcReadyFrame): Promise<void> {
		const child = this.#child;
		const client = this.#rpcClient;
		if (!child || !client || this.#localPreparingChild === child) return;
		this.#localPreparingChild = child;
		try {
			// Stay on v1 when an older/malformed sidecar omits the negotiation
			// fields or rejects v2. Negotiation failure preserves the existing
			// v1 fallback; session preparation still runs over the active client.
			if (supportsRpcProtocolV2(ready)) {
				await client.command({ type: "negotiate_protocol", protocolVersion: 2 }).catch(() => undefined);
			}
			if (this.#child !== child || this.#disposed) return;

			if (this.#freshLaunchPending) {
				const created = await client.command({ type: "new_session" });
				if (!created.success) throw new Error(created.error ?? "Fresh session creation failed");
				if ((created.data as { cancelled?: unknown } | undefined)?.cancelled === true) {
					throw new Error("Fresh session creation was cancelled");
				}
			}
			if (this.#child !== child || this.#disposed) return;

			this.#resumeSessionPath = null;
			// Freshness is a creation contract, not a restart policy. Once the
			// tab has created its new session, later restarts may auto-resume it.
			this.#freshLaunchPending = false;
			this.#setStatus("ready");
			this.#restartCount = 0;
		} catch (error) {
			if (this.#child !== child || this.#disposed) return;
			this.#setStatus("error", error instanceof Error ? error.message : String(error));
		} finally {
			if (this.#localPreparingChild === child) this.#localPreparingChild = null;
		}
	}

	async #prepareRemote(ready: RpcReadyFrame): Promise<void> {
		const child = this.#child;
		const client = this.#rpcClient;
		const target = this.#options.target;
		if (!child || !client || target?.type !== "ssh" || this.#remotePreparingChild === child) return;
		this.#remotePreparingChild = child;
		try {
			this.#setStatus("starting", `Negotiating RPC protocol with ${target.hostAlias}`);
			if (supportsRpcProtocolV2(ready)) {
				const negotiated = await client.command({ type: "negotiate_protocol", protocolVersion: 2 });
				if (!negotiated.success) throw new Error(negotiated.error ?? "RPC protocol negotiation failed");
			}
			if (this.#child !== child || this.#disposed) return;

			this.#setStatus("starting", `Preparing remote session on ${target.hostAlias}`);
			if (!this.#remoteLaunchResumed) {
				const created = await client.command({ type: "new_session" });
				if (!created.success) throw new Error(created.error ?? "Remote session creation failed");
			}
			const state = await client.command({ type: "get_state" });
			if (!state.success) throw new Error(state.error ?? "Remote session hydration failed");
			if (this.#child !== child || this.#disposed) return;

			this.#freshLaunchPending = false;
			this.#setStatus("ready");
			this.#restartCount = 0;
		} catch (error) {
			if (this.#child !== child || this.#disposed) return;
			this.#failRemote(error instanceof Error ? error.message : String(error));
		} finally {
			if (this.#remotePreparingChild === child) this.#remotePreparingChild = null;
		}
	}

	#remoteError(reason: string): string {
		const alias = this.#options.target?.type === "ssh" ? this.#options.target.hostAlias : "unknown";
		const stderr = this.#remoteStderrTail.toString("utf8").trim();
		return stderr ? `SSH host ${alias}: ${reason}: ${stderr}` : `SSH host ${alias}: ${reason}`;
	}

	#failRemote(reason: string): void {
		const handle = this.#remoteChildHandle;
		this.#cleanup();
		this.#setStatus("error", this.#remoteError(reason));
		if (!handle) return;
		const terminated = handle.terminate().catch(error => {
			if (!this.#disposed) {
				this.#setStatus(
					"error",
					this.#remoteError(
						`Remote process termination failed: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
		});
		const tracked = terminated.finally(() => {
			if (this.#remoteTerminationPromise === tracked) this.#remoteTerminationPromise = null;
		});
		this.#remoteTerminationPromise = tracked;
	}

	#attemptRestart(reason: string): void {
		if (this.#restartCount >= MAX_RESTART_ATTEMPTS) {
			this.#setStatus("error", `Failed after ${MAX_RESTART_ATTEMPTS} attempts: ${reason}`);
			return;
		}

		const delay = RESTART_DELAYS[this.#restartCount] ?? 4000;
		this.#restartCount++;
		this.#setStatus(
			"restarting",
			`Restarting in ${delay}ms (attempt ${this.#restartCount}/${MAX_RESTART_ATTEMPTS}): ${reason}`,
		);

		this.#restartTimer = setTimeout(() => {
			this.#restartTimer = null;
			if (!this.#disposed) {
				if (this.#options.target?.type === "ssh") this.start();
				else this.#spawn();
			}
		}, delay);
	}

	#setStatus(status: SidecarStatus, message?: string): void {
		this.#status = status;
		this.emit("status", { status, message, cwd: this.#options.cwd });
	}

	#cleanup(): void {
		this.#detachParser?.();
		this.#detachParser = null;
		this.#batcher?.flushNow();
		this.#batcher?.dispose();
		this.#batcher = null;
		this.#rpcClient?.rejectAll("Sidecar disconnected");
		this.#rpcClient = null;
		this.#child = null;
		this.#localPreparingChild = null;
		this.#remoteChildHandle = null;
		this.#remotePreparingChild = null;
	}

	/**
	 * Enforce the immutable session target at the host-tool trust boundary.
	 * Remote tools are never executed or renderer-forwarded. Invalid authority
	 * values terminate the remote stream because no request id is safe to echo.
	 */
	denyRemoteHostTool(frame: unknown): boolean {
		if (this.#options.target?.type !== "ssh") return false;
		if (!isPlainObject(frame) || !isValidRemoteHostToolRequest(frame)) {
			this.#failRemote(INVALID_REMOTE_HOST_TOOL_REQUEST);
			return true;
		}
		this.sendSideChannel({ type: "host_tool_result", id: frame.id, error: REMOTE_HOST_TOOL_DENIAL });
		return true;
	}

	/** Send a side-channel frame (bypasses command queue). */
	sendSideChannel(frame: object): void {
		if (this.#child?.stdin?.writable) {
			this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
		}
	}

	/** Mark the sidecar as unhealthy (e.g. health check failed after ready). */
	markUnhealthy(reason: string): void {
		this.#setStatus("error", reason);
	}

	/**
	 * Atomically adopt a new logical cwd and replace the session target snapshot.
	 * Remote reconnects must follow the live cwd without changing the immutable
	 * host, origin cwd, or executable override captured when the tab opened.
	 * The returned target is a new frozen snapshot for SidecarPool to publish.
	 */
	adoptTargetCwd(cwd: string): SessionTarget | null {
		if (cwd === this.#options.cwd) return null;
		const previous = this.#options.target;
		const target: SessionTarget =
			previous?.type === "ssh" ? Object.freeze({ ...previous, cwd }) : Object.freeze({ type: "local" });
		this.#options = { ...this.#options, cwd, target };
		return target;
	}
	restart(cwd?: string, resumeSessionPath?: string): void {
		this.#restartCount = 0;
		if (this.#options.target?.type === "ssh") {
			this.#remoteRestartGeneration++;
			if (!this.#remoteRestartPromise) {
				const transition = this.#restartRemote();
				this.#remoteRestartPromise = transition;
				void transition.then(
					() => {
						if (this.#remoteRestartPromise === transition) this.#remoteRestartPromise = null;
					},
					error => {
						if (this.#remoteRestartPromise === transition) this.#remoteRestartPromise = null;
						if (!this.#disposed) {
							this.#setStatus(
								"error",
								this.#remoteError(
									`Remote restart failed: ${error instanceof Error ? error.message : String(error)}`,
								),
							);
						}
					},
				);
			}
			return;
		}
		if (cwd) this.#options = { ...this.#options, cwd };
		void this.kill();
		this.#resumeSessionPath = resumeSessionPath ?? null;
		this.start();
	}

	async #restartRemote(): Promise<void> {
		while (!this.#disposed) {
			const generation = this.#remoteRestartGeneration;
			await this.kill();
			if (this.#disposed) return;
			if (generation !== this.#remoteRestartGeneration) continue;
			this.start();
			return;
		}
	}

	kill(): Promise<void> {
		if (this.#restartTimer) {
			clearTimeout(this.#restartTimer);
			this.#restartTimer = null;
		}
		const pendingStart = this.#remoteStartPromise;
		const pendingTermination = this.#remoteTerminationPromise;
		this.#remoteAbortController?.abort();
		this.#remoteAbortController = null;
		const child = this.#child;
		const remoteHandle = this.#remoteChildHandle;
		this.#cleanup();
		if (!remoteHandle) child?.kill("SIGTERM");
		const waits: Promise<void>[] = [];
		if (pendingStart) waits.push(pendingStart);
		if (pendingTermination) waits.push(pendingTermination);
		if (remoteHandle) waits.push(remoteHandle.terminate());
		return waits.length > 0 ? Promise.all(waits).then(() => undefined) : Promise.resolve();
	}

	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		this.#disposed = true;
		const restart = this.#remoteRestartPromise;
		const killed = this.kill();
		this.#disposePromise = (restart ? Promise.all([restart, killed]).then(() => undefined) : killed).finally(() => {
			this.removeAllListeners();
		});
		return this.#disposePromise;
	}
}
