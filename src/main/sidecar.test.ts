import { type ChildProcess, spawn as spawnChild } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import Store from "electron-store";
import { describe, expect, it, vi } from "vitest";
import { useComposerStore } from "../renderer/stores/composer";
import type { SshSessionTarget } from "../shared/ipc-types";
import type { CommandOutputFrame, PromptResultFrame, SidecarStatus } from "../shared/rpc-types";
import type { RemoteHostCatalog } from "./remote-host-catalog";
import { type RemoteProcessRunner, RemoteSshService } from "./remote-ssh";
import {
	createRemoteStdoutGuard,
	REMOTE_STDOUT_FRAME_BUDGET,
	REMOTE_STDOUT_RATE_WINDOW_MS,
	REMOTE_STDOUT_UTF8_BYTE_BUDGET,
	SidecarManager,
} from "./sidecar";

async function waitForReady(sidecar: SidecarManager): Promise<void> {
	const ready = Promise.withResolvers<void>();
	const onStatus = ({ status }: { status: SidecarStatus }) => {
		if (status === "ready") ready.resolve();
	};
	sidecar.on("status", onStatus);
	try {
		await ready.promise;
	} finally {
		sidecar.off("status", onStatus);
	}
}

interface StatusEvent {
	status: SidecarStatus;
	message?: string;
	cwd: string;
}

interface FakeRemoteLog {
	type: "launch" | "command" | "terminated";
	pid: number;
	args?: string[];
	sshArgs?: string[];
	command?: Record<string, unknown>;
}

const REMOTE_MARKER = "__OMP_REMOTE_TEST__";

const REMOTE_TARGET: SshSessionTarget = {
	type: "ssh",
	hostAlias: "dev-box",
	host: {
		host: "dev.example.test",
		username: "danny",
		port: 2222,
		keyPath: "/keys/dev_ed25519",
		sourceId: "test",
		sourceLevel: "project",
		os: "linux",
		shell: "bash",
	},
	originCwd: "/srv/project",
	cwd: "/srv/project",
	executableOverride: "/remote/bin/omp",
};

const REMOTE_NOTICE_LINE = `${JSON.stringify({ type: "notice", message: "bounded remote output" })}\n`;

async function waitForStatus(sidecar: SidecarManager, wanted: SidecarStatus): Promise<StatusEvent> {
	const settled = Promise.withResolvers<StatusEvent>();
	const listener = (event: StatusEvent): void => {
		if (event.status === wanted) {
			settled.resolve(event);
		} else if (wanted === "ready" && (event.status === "error" || event.status === "exited")) {
			settled.reject(new Error(event.message ?? `Sidecar entered ${event.status}`));
		}
	};
	sidecar.on("status", listener);
	try {
		return await settled.promise;
	} finally {
		sidecar.off("status", listener);
	}
}

async function readRemoteLog(logPath: string): Promise<FakeRemoteLog[]> {
	try {
		const text = await fs.readFile(logPath, "utf8");
		return text
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as FakeRemoteLog);
	} catch {
		return [];
	}
}

async function createFakeSsh(
	tempDir: string,
	env: Record<string, string> = {},
): Promise<{ remoteSsh: RemoteSshService; logPath: string }> {
	const binaryPath = path.join(tempDir, "fake-ssh.ts");
	const logPath = path.join(tempDir, "remote.ndjson");
	const encoded = (value: string): string => Buffer.from(value, "utf8").toString("base64");
	await fs.writeFile(
		binaryPath,
		`#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import { createInterface } from "node:readline";

const logPath = process.env.FAKE_SSH_LOG;
if (!logPath) throw new Error("FAKE_SSH_LOG missing");
const dropPromptOnce = process.env.FAKE_SSH_DROP_PROMPT_ONCE;
const append = async row => {
	await fs.appendFile(logPath, JSON.stringify({ ...row, pid: process.pid }) + "\\n");
};
const remoteCommand = process.argv.at(-1) ?? "";
if (remoteCommand.includes(${JSON.stringify(REMOTE_MARKER)})) {
	process.stdout.write([
		${JSON.stringify(REMOTE_MARKER)},
		"home=${encoded("/home/danny")}",
		"platform=linux",
		"shell=${encoded("/bin/bash")}",
		"executable=${encoded("/remote/bin/omp")}",
		"path=${encoded("/remote/bin:/usr/bin")}",
		"filehelper=${encoded("unavailable")}",
		${JSON.stringify(REMOTE_MARKER)},
		"",
	].join("\\n"));
} else {
	const args = [...remoteCommand.matchAll(/'([^']*)'/g)].map(match => match[1]);
	await append({ type: "launch", args, sshArgs: process.argv.slice(2, -1) });
	process.on("SIGTERM", () => {
		void append({ type: "terminated" }).finally(() => process.exit(0));
	});
	if (process.env.FAKE_SSH_CONTAMINATE === "1") {
		process.stderr.write("HEAD" + "x".repeat(20_000) + "TAIL", () => {
			process.stdout.write("not-ndjson\\n");
		});
	} else {
		process.stdout.write(JSON.stringify({
			type: "ready",
			protocolVersion: 2,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: 1_048_576,
			maxReassembledFrameBytes: 67_108_864,
		}) + "\\n");
		const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
		lines.on("line", async line => {
			const command = JSON.parse(line);
			await append({ type: "command", command });
			if (command.type === "prompt" && dropPromptOnce) {
				try {
					await fs.access(dropPromptOnce);
				} catch {
					await fs.writeFile(dropPromptOnce, "dropped");
					process.stderr.write("prompt transport lost", () => process.exit(255));
					return;
				}
			}
			process.stdout.write(JSON.stringify({
				type: "response",
				id: command.id,
				command: command.type,
				success: true,
				data: command.type === "get_state" ? { cwd: ${JSON.stringify(REMOTE_TARGET.cwd)} } : {},
			}) + "\\n");
			if (command.type === "new_session") {
				process.stdout.write(JSON.stringify({
					type: "session_info_update",
					sessionId: "remote-session-7",
					title: null,
				}) + "\\n");
			}
		});
	}
}
`,
	);
	await fs.chmod(binaryPath, 0o755);
	const runner: RemoteProcessRunner = {
		spawn(_command, args, options) {
			return spawnChild(binaryPath, args, {
				...options,
				env: { ...process.env, ...env, FAKE_SSH_LOG: logPath },
			});
		},
	};
	return {
		remoteSsh: new RemoteSshService(runner, {
			markerFactory: () => REMOTE_MARKER,
			operationTimeoutMs: 2_000,
			terminationGraceMs: 250,
		}),
		logPath,
	};
}

function inMemoryChild(): ChildProcess {
	const child = new EventEmitter() as unknown as ChildProcess;
	Object.assign(child, {
		stdin: { writable: true, write: () => true },
		stdout: null,
		stderr: null,
		exitCode: null,
		signalCode: null,
		kill: () => true,
	});
	return child;
}

function streamingChild(stdout: PassThrough, stderr: PassThrough): ChildProcess {
	const child = inMemoryChild();
	Object.assign(child, { stdout, stderr });
	return child;
}

function catalogForTarget(target: SshSessionTarget): RemoteHostCatalog {
	return {
		target(hostAlias: string, originCwd: string) {
			if (hostAlias !== target.hostAlias || originCwd !== target.originCwd) return null;
			return { ...target, host: { ...target.host }, cwd: originCwd };
		},
	} as unknown as RemoteHostCatalog;
}

function createStreamingRemoteSidecar(
	stdout: PassThrough,
	stderr: PassThrough,
	terminate: () => Promise<void>,
): { sidecar: SidecarManager; spawned: Promise<void> } {
	const spawned = Promise.withResolvers<void>();
	const remoteSsh = {
		async resolveRuntime(target: SshSessionTarget) {
			return {
				ok: true as const,
				target,
				runtime: {
					home: "/home/danny",
					platform: "linux" as const,
					shell: "/bin/bash",
					executable: "/remote/bin/omp",
					runtimePath: ["/remote/bin", "/usr/bin"],
				},
			};
		},
		spawnRpc() {
			spawned.resolve();
			return { child: streamingChild(stdout, stderr), terminate };
		},
	} as unknown as RemoteSshService;
	return {
		sidecar: new SidecarManager({
			binaryPath: "",
			cwd: REMOTE_TARGET.cwd,
			target: REMOTE_TARGET,
			remoteSsh,
			remoteHostCatalog: catalogForTarget(REMOTE_TARGET),
		}),
		spawned: spawned.promise,
	};
}

describe("SidecarManager", () => {
	it("passes the active session path on a manual restart", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-"));
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		const sessionPath = path.join(tempDir, "session.jsonl");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		try {
			const firstReady = waitForReady(sidecar);
			sidecar.start();
			await firstReady;

			const restarted = waitForReady(sidecar);
			sidecar.restart(undefined, sessionPath);
			await restarted;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--session", sessionPath]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("spawns a chat sidecar with --chat in the code-controlled argv", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-chat-"));
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir, kind: "chat" });
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--chat"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("forces a freshly created tab to bypass the CLI auto-resume setting", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-fresh-"));
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir, fresh: true });
		try {
			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual(["--mode", "rpc-ui", "--no-auto-resume"]);

			const restarted = waitForReady(sidecar);
			sidecar.restart();
			await restarted;
			const restartLaunch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(restartLaunch).toEqual(["--mode", "rpc-ui"]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("routes prompt results and text-mode command output as dedicated frames", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-output-"));
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "prompt_result", id: "local-command", agentInvoked: false }) + "\\n");\nprocess.stdout.write(JSON.stringify({ type: "command_output", text: "Enabled models" }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		const received = Promise.withResolvers<CommandOutputFrame>();
		sidecar.once("commandOutput", frame => received.resolve(frame as CommandOutputFrame));
		const promptResult = Promise.withResolvers<PromptResultFrame>();
		sidecar.once("promptResult", frame => promptResult.resolve(frame as PromptResultFrame));
		try {
			sidecar.start();
			expect(await Promise.all([promptResult.promise, received.promise])).toEqual([
				{ type: "prompt_result", id: "local-command", agentInvoked: false },
				{ type: "command_output", text: "Enabled models" },
			]);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("appends the workspace launch profile flags at spawn, denylist-proof", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-profile-"));
		const fakeHome = path.join(tempDir, "home");
		const workspaceCwd = path.join(tempDir, "workspace");
		await fs.mkdir(fakeHome, { recursive: true });
		await fs.mkdir(workspaceCwd, { recursive: true });
		const logPath = path.join(tempDir, "argv.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		// electron-store/conf resolves its prefs path from os.homedir() per
		// construction, so a redirected HOME lands the store inside tempDir.
		// Discover the exact path through the same stack rather than hardcoding
		// conf internals, then seed the workspace profile into it.
		const originalHome = process.env.HOME;
		process.env.HOME = fakeHome;
		const sidecar = new SidecarManager({ binaryPath, cwd: workspaceCwd });
		try {
			// Same options as the loader; a variable sidesteps the excess-property
			// check on electron-store's Options type (projectName reaches conf).
			const storeOptions = { name: "prefs", projectName: "omp-gui" };
			const probe = new Store(storeOptions);
			await fs.mkdir(path.dirname(probe.path), { recursive: true });
			await fs.writeFile(
				probe.path,
				JSON.stringify({
					launchProfiles: {
						[workspaceCwd]: {
							appendSystemPrompt: "GUI injected",
							noRules: true,
							addDirs: ["/data/extra"],
							tools: ["read", "bash"],
							// Smuggled keys that could reach code-controlled flags —
							// parseLaunchProfile drops them before the mapping.
							"--session": "hijack",
							session: "hijack",
						},
					},
				}),
			);

			const ready = waitForReady(sidecar);
			sidecar.start();
			await ready;

			const launch: unknown = JSON.parse(await fs.readFile(logPath, "utf8"));
			expect(launch).toEqual([
				"--mode",
				"rpc-ui",
				"--append-system-prompt",
				"GUI injected",
				"--no-rules",
				"--add-dir",
				"/data/extra",
				"--tools",
				"read,bash",
			]);
		} finally {
			process.env.HOME = originalHome;
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("adoptTargetCwd re-roots the reported cwd and plain restarts spawn there", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-adopt-"));
		// realpath: the spawned process's process.cwd() resolves /var symlinks.
		const adoptedCwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-sidecar-adopted-")));
		const logPath = path.join(tempDir, "spawn.json");
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nimport * as fs from "node:fs/promises";\nawait fs.writeFile(${JSON.stringify(logPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);

		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		try {
			// Same-cwd adoption is a no-op; a new cwd moves the reported cwd.
			expect(sidecar.adoptTargetCwd(tempDir)).toBeNull();
			expect(sidecar.adoptTargetCwd(adoptedCwd)).toEqual({ type: "local" });
			expect(sidecar.cwd).toBe(adoptedCwd);

			// A plain restart (crash recovery, manual session resume) respawns in
			// the ADOPTED cwd — the session's workspace, not the stale spawn cwd.
			const ready = waitForReady(sidecar);
			sidecar.restart();
			await ready;

			const spawn = JSON.parse(await fs.readFile(logPath, "utf8")) as { cwd: string };
			expect(spawn.cwd).toBe(adoptedCwd);
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
			await fs.rm(adoptedCwd, { recursive: true, force: true });
		}
	});
});

describe("SidecarManager remote SSH lifecycle", () => {
	it("negotiates and prepares a fresh remote session before reporting ready", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-sidecar-"));
		const { remoteSsh, logPath } = await createFakeSsh(tempDir);
		const statuses: StatusEvent[] = [];
		const sidecar = new SidecarManager({
			binaryPath: "",
			cwd: REMOTE_TARGET.cwd,
			fresh: true,
			target: REMOTE_TARGET,
			remoteSsh,
			remoteHostCatalog: catalogForTarget(REMOTE_TARGET),
		});
		sidecar.on("status", event => statuses.push(event as StatusEvent));
		try {
			const ready = waitForStatus(sidecar, "ready");
			sidecar.start();
			await ready;

			const rows = await readRemoteLog(logPath);
			const launch = rows.find(row => row.type === "launch");
			const commands = rows
				.filter(row => row.type === "command")
				.map(row => row.command)
				.filter((command): command is Record<string, unknown> => command !== undefined);
			expect(launch?.args).toContain("--mode");
			expect(launch?.args).toContain("rpc-ui");
			expect(launch?.args).toContain("--cwd");
			expect(launch?.args).toContain(REMOTE_TARGET.cwd);
			expect(launch?.args).not.toContain("--no-auto-resume");
			expect(commands.slice(0, 2).map(command => command.type)).toEqual(["negotiate_protocol", "new_session"]);
			expect(commands.map(command => command.type)).toEqual(["negotiate_protocol", "new_session", "get_state"]);
			expect(statuses.at(-1)?.status).toBe("ready");
			expect(statuses.map(status => status.message).filter(Boolean)).toEqual([
				"Resolving SSH host dev-box",
				"Authenticating SSH host dev-box",
				"Probing remote runtime on dev-box",
				"Launching remote omp on dev-box",
				"Negotiating RPC protocol with dev-box",
				"Preparing remote session on dev-box",
			]);

			await sidecar.dispose();
			expect((await readRemoteLog(logPath)).some(row => row.type === "terminated")).toBe(true);
		} finally {
			await sidecar.dispose();
			await remoteSsh.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("passes a remote resume id without local auto-resume flags", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-resume-"));
		const { remoteSsh, logPath } = await createFakeSsh(tempDir);
		const sidecar = new SidecarManager({
			binaryPath: "",
			cwd: REMOTE_TARGET.cwd,
			target: REMOTE_TARGET,
			resumeSessionId: "remote-session-7",
			remoteSsh,
			remoteHostCatalog: catalogForTarget(REMOTE_TARGET),
		});
		try {
			const ready = waitForStatus(sidecar, "ready");
			sidecar.start();
			await ready;

			const rows = await readRemoteLog(logPath);
			const launch = rows.find(row => row.type === "launch");
			const commands = rows.filter(row => row.type === "command").map(row => row.command?.type);
			expect(launch?.args).toContain("--resume");
			expect(launch?.args).toContain("remote-session-7");
			expect(launch?.args).not.toContain("--session");
			expect(launch?.args).not.toContain("--no-auto-resume");
			expect(commands).toEqual(["negotiate_protocol", "get_state"]);
		} finally {
			await sidecar.dispose();
			await remoteSsh.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("reconnects an adopted remote cwd without changing the connection origin or override", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-reconnect-"));
		const { remoteSsh, logPath } = await createFakeSsh(tempDir);
		const originalTarget: SshSessionTarget = {
			...REMOTE_TARGET,
			host: { ...REMOTE_TARGET.host },
			executableOverride: "/opt/remote/omp",
		};
		const sidecar = new SidecarManager({
			binaryPath: "",
			cwd: originalTarget.cwd,
			fresh: true,
			target: originalTarget,
			remoteSsh,
			remoteHostCatalog: catalogForTarget(originalTarget),
		});
		try {
			const initialReady = waitForStatus(sidecar, "ready");
			sidecar.start();
			await initialReady;

			const movedTarget = sidecar.adoptTargetCwd("/srv/moved");
			expect(movedTarget).toEqual({
				...originalTarget,
				host: { ...originalTarget.host },
				cwd: "/srv/moved",
			});
			expect(movedTarget).not.toBe(originalTarget);
			expect(originalTarget.cwd).toBe(REMOTE_TARGET.cwd);

			const reconnected = waitForStatus(sidecar, "ready");
			sidecar.restart("/local/workspace/must-not-cross", "/local/sessions/must-not-cross.jsonl");
			expect(sidecar.cwd).toBe("/srv/moved");
			await reconnected;

			const rows = await readRemoteLog(logPath);
			const launches = rows.filter(row => row.type === "launch");
			expect(launches).toHaveLength(2);
			expect(launches[1]?.args).toContain("--resume");
			expect(launches[1]?.args).toContain("remote-session-7");
			expect(launches[1]?.args).not.toContain("/local/sessions/must-not-cross.jsonl");
			expect(launches[1]?.args).toContain("/srv/moved");
			expect(launches[1]?.args).not.toContain(REMOTE_TARGET.cwd);
			const reconnectPid = launches[1]?.pid;
			expect(
				rows.filter(row => row.type === "command" && row.pid === reconnectPid).map(row => row.command?.type),
			).toEqual(["negotiate_protocol", "get_state"]);
		} finally {
			await sidecar.dispose();
			await remoteSsh.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("disconnecting during a prompt preserves the draft and reconnects without replay on the original host", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-prompt-drop-"));
		const dropMarker = path.join(tempDir, "prompt-dropped");
		const { remoteSsh, logPath } = await createFakeSsh(tempDir, {
			FAKE_SSH_DROP_PROMPT_ONCE: dropMarker,
		});
		const sidecar = new SidecarManager({
			binaryPath: "",
			cwd: REMOTE_TARGET.cwd,
			fresh: true,
			target: REMOTE_TARGET,
			remoteSsh,
			remoteHostCatalog: catalogForTarget(REMOTE_TARGET),
		});
		useComposerStore.getState().setDraft("unsent composer draft");
		try {
			const initialReady = waitForStatus(sidecar, "ready");
			sidecar.start();
			await initialReady;
			const client = sidecar.rpcClient;
			if (!client) throw new Error("Remote RPC client missing after ready");

			const disconnected = waitForStatus(sidecar, "restarting");
			const inFlightPrompt = client.command({ type: "prompt", message: "submitted before transport loss" });
			await expect(inFlightPrompt).rejects.toThrow("Sidecar disconnected");
			await disconnected;
			expect(useComposerStore.getState().draft).toBe("unsent composer draft");

			const reconnected = waitForStatus(sidecar, "ready");
			sidecar.restart();
			await reconnected;

			const rows = await readRemoteLog(logPath);
			const launches = rows.filter(row => row.type === "launch");
			expect(launches).toHaveLength(2);
			expect(launches[1]?.sshArgs).toEqual(launches[0]?.sshArgs);
			expect(launches[1]?.args).toContain("--resume");
			expect(launches[1]?.args).toContain("remote-session-7");
			const reconnectPid = launches[1]?.pid;
			expect(
				rows.filter(row => row.type === "command" && row.pid === reconnectPid).map(row => row.command?.type),
			).toEqual(["negotiate_protocol", "get_state"]);
			expect(useComposerStore.getState().draft).toBe("unsent composer draft");
		} finally {
			useComposerStore.getState().reset();
			await sidecar.dispose();
			await remoteSsh.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("enters a host-qualified stderr error after exhausting bounded reconnect attempts", async () => {
		vi.useFakeTimers();
		const attemptedTargets: SshSessionTarget[] = [];
		const remoteSsh = {
			async resolveRuntime(target: SshSessionTarget) {
				attemptedTargets.push({ ...target, host: { ...target.host } });
				return { ok: false as const, error: "ssh stderr: permission denied (publickey)" };
			},
		} as unknown as RemoteSshService;
		const sidecar = new SidecarManager({
			binaryPath: "",
			cwd: REMOTE_TARGET.cwd,
			target: REMOTE_TARGET,
			remoteSsh,
			remoteHostCatalog: catalogForTarget(REMOTE_TARGET),
		});
		const statuses: StatusEvent[] = [];
		sidecar.on("status", event => statuses.push(event as StatusEvent));
		try {
			sidecar.start();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(2_000);
			await vi.advanceTimersByTimeAsync(4_000);

			expect(attemptedTargets).toEqual([REMOTE_TARGET, REMOTE_TARGET, REMOTE_TARGET, REMOTE_TARGET]);
			expect(statuses.at(-1)).toMatchObject({
				status: "error",
				message: "Failed after 3 attempts: SSH host dev-box: ssh stderr: permission denied (publickey)",
			});
		} finally {
			await sidecar.dispose();
			vi.useRealTimers();
		}
	});

	it("rejects contaminated remote stdout with bounded aliased stderr", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-remote-contamination-"));
		const { remoteSsh } = await createFakeSsh(tempDir, { FAKE_SSH_CONTAMINATE: "1" });
		const sidecar = new SidecarManager({
			binaryPath: "",
			cwd: REMOTE_TARGET.cwd,
			target: REMOTE_TARGET,
			remoteSsh,
			remoteHostCatalog: catalogForTarget(REMOTE_TARGET),
		});
		try {
			const errored = waitForStatus(sidecar, "error");
			sidecar.start();
			const status = await errored;
			expect(status.message).toContain("dev-box");
			expect(status.message).toContain("Invalid NDJSON");
			expect(status.message).toContain("TAIL");
			expect(status.message).not.toContain("HEAD");
			expect(status.message?.length).toBeLessThan(17_000);
		} finally {
			await sidecar.dispose();
			await remoteSsh.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects a valid oversized complete remote NDJSON frame before routing it", async () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const spawned = Promise.withResolvers<void>();
		const remoteSsh = {
			async resolveRuntime(target: SshSessionTarget) {
				return {
					ok: true as const,
					target,
					runtime: {
						home: "/home/danny",
						platform: "linux" as const,
						shell: "/bin/bash",
						executable: "/remote/bin/omp",
						runtimePath: ["/remote/bin", "/usr/bin"],
					},
				};
			},
			spawnRpc() {
				spawned.resolve();
				return { child: streamingChild(stdout, stderr), terminate: async () => {} };
			},
		} as unknown as RemoteSshService;
		const sidecar = new SidecarManager({
			binaryPath: "",
			cwd: REMOTE_TARGET.cwd,
			target: REMOTE_TARGET,
			remoteSsh,
			remoteHostCatalog: catalogForTarget(REMOTE_TARGET),
		});
		let routed = false;
		sidecar.on("frame", () => {
			routed = true;
		});
		const statuses: StatusEvent[] = [];
		sidecar.on("status", event => statuses.push(event as StatusEvent));
		try {
			sidecar.start();
			await spawned.promise;
			stderr.write("oversized-frame-tail");
			const completeLine = Buffer.from(
				`${JSON.stringify({ type: "notice", message: "界".repeat(400_000) })}\n`,
				"utf8",
			);
			expect(completeLine.length).toBeGreaterThan(1_048_576);
			stdout.write(completeLine);

			expect(statuses.at(-1)?.status).toBe("error");
			expect(statuses.at(-1)?.message).toContain("dev-box");
			expect(statuses.at(-1)?.message).toContain("Invalid NDJSON");
			expect(statuses.at(-1)?.message).toContain("oversized-frame-tail");
			expect(routed).toBe(false);
		} finally {
			await sidecar.dispose();
			stdout.destroy();
			stderr.destroy();
		}
	});

	it("pauses validated remote stdout on backpressure and drains the current chunk in order before resuming", async () => {
		const stdout = new PassThrough();
		const validated = new PassThrough({ highWaterMark: 1 });
		const failures: string[] = [];
		const guard = createRemoteStdoutGuard(stdout, reason => failures.push(reason), validated);
		try {
			stdout.write(`${REMOTE_NOTICE_LINE}${REMOTE_NOTICE_LINE}`);

			expect(stdout.isPaused()).toBe(true);
			expect(validated.read()?.toString()).toBe(REMOTE_NOTICE_LINE);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(stdout.isPaused()).toBe(true);
			expect(validated.read()?.toString()).toBe(REMOTE_NOTICE_LINE);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(stdout.isPaused()).toBe(false);
			expect(failures).toEqual([]);
		} finally {
			guard.detach();
			stdout.destroy();
		}
	});

	it("terminates a remote child once when one window exceeds the UTF-8 byte budget", async () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const terminate = vi.fn(async () => {});
		const { sidecar, spawned } = createStreamingRemoteSidecar(stdout, stderr, terminate);
		const payloadBytes = 512 * 1024;
		const line = `${JSON.stringify({ type: "notice", message: "界".repeat(Math.floor(payloadBytes / 3)) })}\n`;
		const lineBytes = Buffer.byteLength(line, "utf8");
		const count = Math.floor(REMOTE_STDOUT_UTF8_BYTE_BUDGET / lineBytes) + 1;
		try {
			sidecar.start();
			await spawned;
			stdout.write(line.repeat(count));

			expect(lineBytes).toBeLessThan(1_048_576);
			expect(lineBytes * count).toBeGreaterThan(REMOTE_STDOUT_UTF8_BYTE_BUDGET);
			expect(terminate).toHaveBeenCalledTimes(1);
			expect(sidecar.status).toBe("error");
		} finally {
			await sidecar.dispose();
			stdout.destroy();
			stderr.destroy();
		}
	});

	it("terminates a remote child once when one window exceeds the frame budget", async () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const terminate = vi.fn(async () => {});
		const { sidecar, spawned } = createStreamingRemoteSidecar(stdout, stderr, terminate);
		try {
			sidecar.start();
			await spawned;
			stdout.write(REMOTE_NOTICE_LINE.repeat(REMOTE_STDOUT_FRAME_BUDGET + 1));

			expect(terminate).toHaveBeenCalledTimes(1);
			expect(sidecar.status).toBe("error");
		} finally {
			await sidecar.dispose();
			stdout.destroy();
			stderr.destroy();
		}
	});

	it("resets remote stdout frame and UTF-8 byte budgets after the fixed window", async () => {
		vi.useFakeTimers();
		const stdout = new PassThrough();
		const validated = new PassThrough();
		validated.resume();
		const failures: string[] = [];
		const guard = createRemoteStdoutGuard(stdout, reason => failures.push(reason), validated);
		const framesPerWindow = Math.floor(REMOTE_STDOUT_FRAME_BUDGET / 2) + 1;
		try {
			stdout.write(REMOTE_NOTICE_LINE.repeat(framesPerWindow));
			await vi.advanceTimersByTimeAsync(REMOTE_STDOUT_RATE_WINDOW_MS);
			stdout.write(REMOTE_NOTICE_LINE.repeat(framesPerWindow));

			expect(framesPerWindow * 2).toBeGreaterThan(REMOTE_STDOUT_FRAME_BUDGET);
			expect(failures).toEqual([]);
		} finally {
			guard.detach();
			stdout.destroy();
			vi.useRealTimers();
		}
	});

	it("does not apply remote stdout budgets to a local sidecar", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-local-output-budget-"));
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nprocess.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");\nfor (let frame = 0; frame <= ${REMOTE_STDOUT_FRAME_BUDGET}; frame++) process.stdout.write(${JSON.stringify(REMOTE_NOTICE_LINE)});\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);
		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		let frames = 0;
		const received = Promise.withResolvers<void>();
		sidecar.on("frame", () => {
			frames++;
			if (frames === REMOTE_STDOUT_FRAME_BUDGET + 1) received.resolve();
		});
		try {
			sidecar.start();
			await received.promise;
			expect(frames).toBe(REMOTE_STDOUT_FRAME_BUDGET + 1);
			expect(sidecar.status).toBe("ready");
		} finally {
			await sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("reauthorizes the exact SSH target after runtime discovery before spawning RPC", async () => {
		const spawnRpc = vi.fn(() => ({
			child: inMemoryChild(),
			terminate: async () => {},
		}));
		const remoteSsh = {
			async resolveRuntime(target: SshSessionTarget) {
				return {
					ok: true as const,
					target,
					runtime: {
						home: "/home/danny",
						platform: "linux" as const,
						shell: "/bin/bash",
						executable: "/remote/bin/omp",
						runtimePath: ["/remote/bin", "/usr/bin"],
					},
				};
			},
			spawnRpc,
		} as unknown as RemoteSshService;
		const remoteHostCatalog = {
			target: vi.fn(() => ({
				...REMOTE_TARGET,
				host: { ...REMOTE_TARGET.host, keyPath: "/keys/replaced" },
			})),
		};
		const sidecar = new SidecarManager({
			binaryPath: "",
			cwd: REMOTE_TARGET.cwd,
			target: REMOTE_TARGET,
			remoteSsh,
			remoteHostCatalog: remoteHostCatalog as unknown as RemoteHostCatalog,
		});

		try {
			sidecar.start();
			await vi.waitFor(() => expect(sidecar.status).toBe("error"));

			expect(remoteHostCatalog.target).toHaveBeenCalledWith(REMOTE_TARGET.hostAlias, REMOTE_TARGET.originCwd);
			expect(spawnRpc).not.toHaveBeenCalled();
		} finally {
			await sidecar.dispose();
		}
	});

	it("coalesces concurrent remote restarts before spawning one replacement", async () => {
		const firstTerminated = Promise.withResolvers<void>();
		const firstSpawned = Promise.withResolvers<void>();
		const replacementSpawned = Promise.withResolvers<void>();
		let spawnCount = 0;
		const remoteSsh = {
			async resolveRuntime(target: SshSessionTarget) {
				return {
					ok: true as const,
					target,
					runtime: {
						home: "/home/danny",
						platform: "linux" as const,
						shell: "/bin/bash",
						executable: "/remote/bin/omp",
						runtimePath: ["/remote/bin", "/usr/bin"],
					},
				};
			},
			spawnRpc() {
				spawnCount++;
				if (spawnCount === 1) firstSpawned.resolve();
				if (spawnCount === 2) replacementSpawned.resolve();
				return {
					child: inMemoryChild(),
					terminate: () => (spawnCount === 1 ? firstTerminated.promise : Promise.resolve()),
				};
			},
		} as unknown as RemoteSshService;
		const sidecar = new SidecarManager({
			binaryPath: "",
			cwd: REMOTE_TARGET.cwd,
			target: REMOTE_TARGET,
			remoteSsh,
			remoteHostCatalog: catalogForTarget(REMOTE_TARGET),
		});
		try {
			sidecar.start();
			await firstSpawned.promise;

			sidecar.restart();
			sidecar.restart();
			for (let flush = 0; flush < 10; flush++) await Promise.resolve();
			firstTerminated.resolve();
			await replacementSpawned.promise;
			for (let flush = 0; flush < 10; flush++) await Promise.resolve();

			expect(spawnCount).toBe(2);
		} finally {
			await sidecar.dispose();
		}
	});
});
