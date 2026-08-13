import { type ChildProcess, type SpawnOptionsWithoutStdio, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { SshSessionTarget } from "../shared/ipc-types";
import { type RemoteProcessRunner, type RemoteRuntimeInfo, RemoteSshService } from "./remote-ssh";

interface SpawnCall {
	command: string;
	args: string[];
	options: SpawnOptionsWithoutStdio;
	child: FakeChild;
}

type SpawnPlan = (call: SpawnCall) => void;

class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdio = [this.stdin, this.stdout, this.stderr, null, null] as const;
	readonly pid: number;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killed = false;
	killCloses = true;

	constructor(pid: number) {
		super();
		this.pid = pid;
	}

	finish(stdout: string | Uint8Array = "", stderr: string | Uint8Array = "", code = 0): void {
		if (stdout instanceof Uint8Array) this.stdout.write(stdout);
		else this.stdout.write(stdout, "utf8");
		if (stderr instanceof Uint8Array) this.stderr.write(stderr);
		else this.stderr.write(stderr, "utf8");
		this.stdout.end();
		this.stderr.end();
		this.exitCode = code;
		this.emit("close", code, null);
	}

	finishSignal(signal: NodeJS.Signals): void {
		this.stdout.end();
		this.stderr.end();
		this.signalCode = signal;
		this.emit("close", null, signal);
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		this.killed = true;
		if (this.killCloses) this.finishSignal(signal);
		return true;
	}
}

class FakeRunner implements RemoteProcessRunner {
	readonly calls: SpawnCall[] = [];
	readonly plans: SpawnPlan[] = [];
	#nextPid = 4100;

	queue(plan: SpawnPlan): void {
		this.plans.push(plan);
	}

	respond(stdout: string | Uint8Array, stderr: string | Uint8Array = "", code = 0): void {
		this.queue(call => queueMicrotask(() => call.child.finish(stdout, stderr, code)));
	}

	spawn(command: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcess {
		const child = new FakeChild(this.#nextPid++);
		const call = { command, args: [...args], options: { ...options }, child };
		this.calls.push(call);
		this.plans.shift()?.(call);
		return child as unknown as ChildProcess;
	}
}

function executeRemoteCommandLocally(call: SpawnCall): void {
	const command = call.args.at(-1) ?? "";
	const local = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
	local.stdout.on("data", chunk => call.child.stdout.write(chunk));
	local.stderr.on("data", chunk => call.child.stderr.write(chunk));
	local.once("error", error => call.child.finish("", error.message, 1));
	local.once("close", code => call.child.finish("", "", code ?? 1));
}

const MARKER = "__OMP_REMOTE_0123456789abcdef__";

function sshTarget(overrides: Partial<SshSessionTarget> = {}): SshSessionTarget {
	return {
		type: "ssh",
		hostAlias: "build",
		host: {
			host: "build.example",
			username: "danny",
			port: 2222,
			keyPath: "/Users/danny/.ssh/id_ed25519",
			sourceId: "ssh-config",
			sourceLevel: "user",
			os: "linux",
		},
		originCwd: "/work/repo",
		cwd: "/work/repo",
		...overrides,
	};
}

function b64(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

function probeOutput(
	overrides: Partial<{
		home: string;
		platform: "windows" | "linux" | "macos";
		shell: string;
		executable: string;
		path: string;
		fileHelper: string;
	}> = {},
): string {
	const values = {
		home: "/home/danny",
		platform: "linux" as const,
		shell: "/bin/zsh",
		executable: "/home/danny/.bun/bin/omp",
		path: "/home/danny/.local/share/mise/shims:/home/danny/.bun/bin:/usr/bin",
		...overrides,
	};
	const fileHelper =
		values.fileHelper ??
		(values.platform === "windows"
			? "windows"
			: values.platform === "macos"
				? `python:${b64("/usr/bin/python3")}`
				: `linux:${b64("/usr/bin/readlink")}:${b64("/usr/bin/stat")}:${b64("/bin/dd")}:${b64("/usr/bin/base64")}`);
	return [
		"welcome from noisy rc",
		MARKER,
		`home=${b64(values.home)}`,
		`platform=${values.platform}`,
		`shell=${b64(values.shell)}`,
		`executable=${b64(values.executable)}`,
		`path=${b64(values.path)}`,
		`filehelper=${b64(fileHelper)}`,
		MARKER,
		"rc cleanup chatter",
	].join("\n");
}

function runtime(overrides: Partial<RemoteRuntimeInfo> = {}): RemoteRuntimeInfo {
	return {
		home: "/home/danny",
		platform: "linux",
		shell: "/bin/zsh",
		executable: "/home/danny/.bun/bin/omp",
		runtimePath: ["/home/danny/.local/share/mise/shims", "/home/danny/.bun/bin", "/usr/bin"],
		...overrides,
	};
}

function service(
	runner: FakeRunner,
	options: ConstructorParameters<typeof RemoteSshService>[1] = {},
): RemoteSshService {
	return new RemoteSshService(runner, { markerFactory: () => MARKER, terminationGraceMs: 5, ...options });
}

describe("RemoteSshService SSH process ownership", () => {
	it("builds exact non-interactive SSH connection arguments", () => {
		const ssh = service(new FakeRunner(), { connectTimeoutSeconds: 10 });
		expect(ssh.connectionArgs(sshTarget().host)).toEqual([
			"-o",
			"BatchMode=yes",
			"-o",
			"StrictHostKeyChecking=accept-new",
			"-o",
			"ConnectTimeout=10",
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=2",
			"-T",
			"-p",
			"2222",
			"-i",
			"/Users/danny/.ssh/id_ed25519",
			"--",
			"danny@build.example",
		]);
	});

	it.each([
		[{ ...sshTarget().host, host: "-oProxyCommand=attacker" }, "host"],
		[{ ...sshTarget().host, host: "build.example\n-oProxyCommand=attacker" }, "host"],
		[{ ...sshTarget().host, username: "-oProxyCommand=attacker" }, "username"],
		[{ ...sshTarget().host, username: "user@attacker" }, "username"],
		[{ ...sshTarget().host, host: "build.example\u2028-oProxyCommand=attacker" }, "host"],
	])("rejects unsafe SSH %s values before process construction", (host, _field) => {
		expect(() => service(new FakeRunner()).connectionArgs(host)).toThrow("Invalid SSH connection");
	});

	it("parses exactly one marker region while ignoring noisy login output", async () => {
		const runner = new FakeRunner();
		runner.respond(probeOutput());

		const result = await service(runner).resolveRuntime(sshTarget());

		expect(result).toEqual({ ok: true, target: sshTarget(), runtime: runtime() });
		expect(runner.calls[0]?.command).toBe("ssh");
		expect(runner.calls[0]?.args.at(-1)).toContain(".local/share/mise/shims");
		expect(runner.calls[0]?.args.at(-1)).toContain(".bun/bin");
	});

	it("encodes a direct executable override and returns the exact discovered executable and PATH", async () => {
		const runner = new FakeRunner();
		const override = "/opt/OMP Trusted/bin/omp";
		runner.respond(
			probeOutput({
				executable: override,
				path: "/opt/mise/shims:/opt/OMP Trusted/bin:/usr/bin",
			}),
		);
		const target = sshTarget({ executableOverride: override });

		const result = await service(runner).resolveRuntime(target);

		expect(result).toEqual({
			ok: true,
			target,
			runtime: runtime({
				executable: override,
				runtimePath: ["/opt/mise/shims", "/opt/OMP Trusted/bin", "/usr/bin"],
			}),
		});
		const command = runner.calls[0]?.args.at(-1) ?? "";
		expect(command).not.toContain(override);
		expect(command).toContain(b64(override));
	});

	it.each([
		["missing", "noise only"],
		["duplicate", `${probeOutput()}\n${MARKER}`],
		[
			"malformed",
			[
				MARKER,
				`home=${b64("/home/danny")}`,
				"platform=linux",
				`shell=${b64("/bin/sh")}`,
				"executable=%%%",
				`path=${b64("/usr/bin")}`,
				MARKER,
			].join("\n"),
		],
	])("rejects %s marker output", async (_name, output) => {
		const runner = new FakeRunner();
		runner.respond(output);
		expect(await service(runner).resolveRuntime(sshTarget())).toMatchObject({ ok: false });
	});

	it("uses an encoded non-interactive PowerShell probe without Unix executable mode checks", async () => {
		const runner = new FakeRunner();
		runner.respond(
			probeOutput({
				home: "C:\\Users\\Danny",
				platform: "windows",
				shell: "powershell.exe",
				executable: "C:\\bin\\omp.exe",
				path: "C:\\bin;C:\\Windows",
			}),
		);
		const target = sshTarget({ host: { ...sshTarget().host, os: "windows" } });

		const result = await service(runner, { platform: "win32" }).resolveRuntime(target);

		expect(result).toMatchObject({ ok: true, runtime: { platform: "windows", executable: "C:\\bin\\omp.exe" } });
		const remoteCommand = runner.calls[0]?.args.at(-1) ?? "";
		expect(remoteCommand).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
		const encoded = remoteCommand.split(" ").at(-1) ?? "";
		const script = Buffer.from(encoded, "base64").toString("utf16le");
		expect(script).toContain("Test-Path -LiteralPath $executable -PathType Leaf");
		expect(script).not.toContain("[ -x");
	});

	it("launches exact long-lived RPC executable with explicit PATH and no login or interactive shell", async () => {
		const runner = new FakeRunner();
		const signals: NodeJS.Signals[] = [];
		const launched: FakeChild[] = [];
		runner.queue(call => {
			launched.push(call.child);
		});
		const ssh = service(runner, {
			killProcessGroup: (_pid, signal) => {
				signals.push(signal);
				queueMicrotask(() => launched[0]?.finishSignal(signal));
			},
		});

		const handle = ssh.spawnRpc(sshTarget(), runtime(), ["--mode", "rpc-ui", "--no-auto-resume"]);
		const command = runner.calls[0]?.args.at(-1) ?? "";
		expect(runner.calls[0]?.options.detached).toBe(true);
		expect(runner.calls[0]?.options.shell).toBeUndefined();
		expect(command).toContain("/home/danny/.bun/bin/omp");
		expect(command).toContain("PATH=");
		expect(command).not.toContain(" -l");
		expect(command).not.toContain(" -i");
		await Promise.all([handle.terminate(), handle.terminate()]);
		expect(signals).toEqual(["SIGTERM"]);
	});

	it("escalates POSIX process-group termination from SIGTERM to SIGKILL", async () => {
		const runner = new FakeRunner();
		const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		const launched: FakeChild[] = [];
		runner.queue(call => {
			launched.push(call.child);
		});
		const ssh = service(runner, {
			terminationGraceMs: 1,
			killProcessGroup: (pid, signal) => {
				signals.push({ pid, signal });
				if (signal === "SIGKILL") queueMicrotask(() => launched[0]?.finishSignal(signal));
			},
		});

		await ssh.spawnAcp(sshTarget(), runtime()).terminate();

		expect(signals).toEqual([
			{ pid: -4100, signal: "SIGTERM" },
			{ pid: -4100, signal: "SIGKILL" },
		]);
	});

	it("rejects POSIX termination when neither process-group signal closes the SSH child", async () => {
		const runner = new FakeRunner();
		const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		const launched: FakeChild[] = [];
		runner.queue(call => launched.push(call.child));
		const ssh = service(runner, {
			terminationGraceMs: 1,
			killProcessGroup: (pid, signal) => {
				signals.push({ pid, signal });
				const child = launched[0];
				if (signal === "SIGKILL" && child) child.signalCode = signal;
			},
		});
		const handle = ssh.spawnAcp(sshTarget(), runtime());

		const termination = handle.terminate();

		expect(handle.terminate()).toBe(termination);
		await expect(termination).rejects.toThrow("Unable to confirm SSH process-tree termination");
		expect(signals).toEqual([
			{ pid: -4100, signal: "SIGTERM" },
			{ pid: -4100, signal: "SIGKILL" },
		]);
	});

	it("rejects POSIX termination without a pid when hard-kill does not close the SSH child", async () => {
		const runner = new FakeRunner();
		runner.queue(call => {
			Object.defineProperty(call.child, "pid", { value: undefined });
			call.child.killCloses = false;
		});
		const handle = service(runner, { terminationGraceMs: 1 }).spawnAcp(sshTarget(), runtime());

		await expect(handle.terminate()).rejects.toThrow("Unable to confirm SSH process-tree termination");

		expect(runner.calls[0]?.child.killed).toBe(true);
	});

	it("uses argument-vector taskkill for a Windows process tree", async () => {
		const runner = new FakeRunner();
		const launched: FakeChild[] = [];
		runner.queue(call => {
			launched.push(call.child);
		});
		runner.queue(call => {
			queueMicrotask(() => {
				call.child.finish();
				launched[0]?.finishSignal("SIGKILL");
			});
		});
		const ssh = service(runner, { platform: "win32" });

		const handle = ssh.spawnAcp(sshTarget(), runtime({ platform: "windows" }));
		await handle.terminate();
		await handle.terminate();

		expect(runner.calls[1]).toMatchObject({
			command: "taskkill",
			args: ["/PID", "4100", "/T", "/F"],
		});
		expect(runner.calls[1]?.options.shell).toBeUndefined();
		expect(runner.calls).toHaveLength(2);
	});

	it("falls back to hard-killing the SSH child when taskkill fails", async () => {
		const runner = new FakeRunner();
		const launched: FakeChild[] = [];
		runner.queue(call => {
			launched.push(call.child);
		});
		runner.queue(call => queueMicrotask(() => call.child.finish("", "not found", 1)));
		const handle = service(runner, { platform: "win32" }).spawnAcp(sshTarget(), runtime({ platform: "windows" }));

		await handle.terminate();

		expect(launched[0]?.killed).toBe(true);
		expect(launched[0]?.signalCode).toBe("SIGKILL");
	});

	it("rejects Windows termination when neither taskkill nor hard-kill closes the SSH child", async () => {
		const runner = new FakeRunner();
		runner.queue(call => {
			call.child.killCloses = false;
		});
		runner.queue(call => queueMicrotask(() => call.child.finish("", "access denied", 1)));
		const handle = service(runner, { platform: "win32", terminationGraceMs: 1 }).spawnAcp(
			sshTarget(),
			runtime({ platform: "windows" }),
		);

		await expect(handle.terminate()).rejects.toThrow("Unable to confirm SSH process-tree termination");
	});

	it("waits for every active termination before dispose reports a failure", async () => {
		vi.useFakeTimers();
		try {
			const runner = new FakeRunner();
			const launched: FakeChild[] = [];
			runner.queue(call => {
				call.child.killCloses = false;
				launched.push(call.child);
			});
			runner.queue(call => {
				launched.push(call.child);
			});
			runner.queue(call => queueMicrotask(() => call.child.finish("", "access denied", 1)));
			runner.queue(call => {
				setTimeout(() => call.child.finish(), 2);
				setTimeout(() => launched[1]?.finishSignal("SIGTERM"), 15);
			});
			const ssh = service(runner, { platform: "win32", terminationGraceMs: 10 });
			ssh.spawnAcp(sshTarget(), runtime({ platform: "windows" }));
			ssh.spawnAcp(sshTarget(), runtime({ platform: "windows" }));

			let settled = false;
			const disposal = ssh
				.dispose()
				.then(
					() => null,
					error => error,
				)
				.finally(() => {
					settled = true;
				});
			await vi.advanceTimersByTimeAsync(11);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(9);
			const error = await disposal;
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toEqual([
				new Error("Unable to confirm SSH process-tree termination"),
			]);
			expect(launched[1]?.signalCode).toBe("SIGTERM");
		} finally {
			vi.useRealTimers();
		}
	});

	it("app shutdown terminates every long-lived SSH child and leaves none running", async () => {
		const runner = new FakeRunner();
		const launched: FakeChild[] = [];
		runner.queue(call => launched.push(call.child));
		runner.queue(call => launched.push(call.child));
		const ssh = service(runner, {
			killProcessGroup: (_pid, signal) => {
				for (const child of launched) {
					if (child.exitCode === null && child.signalCode === null) child.finishSignal(signal);
				}
			},
		});
		ssh.spawnRpc(sshTarget(), runtime(), []);
		ssh.spawnAcp(sshTarget(), runtime());

		await ssh.dispose();
		await ssh.dispose();

		expect(launched.map(child => child.signalCode)).toEqual(["SIGTERM", "SIGTERM"]);
		expect(launched.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
	});
});

describe("RemoteSshService bounded helpers", () => {
	it("rechecks authorization immediately before a preflight probe child starts", async () => {
		const runner = new FakeRunner();
		runner.respond(probeOutput());
		let canonical: SshSessionTarget | null = sshTarget();

		canonical = null;
		const result = await service(runner).preflight(sshTarget(), undefined, () => canonical);

		expect(result).toEqual({ ok: false, error: "Stale or altered SSH target" });
		expect(runner.calls).toHaveLength(0);
	});

	it("rejects a deleted target after the runtime probe without spawning a directory-list child", async () => {
		const runner = new FakeRunner();
		let canonical: SshSessionTarget | null = sshTarget();
		runner.queue(call =>
			queueMicrotask(() => {
				call.child.finish(probeOutput());
				canonical = null;
			}),
		);
		runner.respond(`H\t${b64("/work/repo")}\t${b64("/work")}\0`);

		const result = await service(runner).listDirectories(
			sshTarget(),
			"/work/repo",
			false,
			undefined,
			() => canonical,
		);

		expect(result).toEqual({ ok: false, error: "Stale or altered SSH target" });
		expect(runner.calls).toHaveLength(1);
	});

	it("rejects a changed target after the runtime probe without spawning a directory-validation child", async () => {
		const runner = new FakeRunner();
		let canonical: SshSessionTarget | null = sshTarget();
		runner.queue(call =>
			queueMicrotask(() => {
				call.child.finish(probeOutput());
				canonical = null;
			}),
		);
		runner.respond(`P\t${b64("/srv/work/repo")}\0`);

		const result = await service(runner).validateDirectory(
			sshTarget(),
			"/srv/work/../work/repo",
			undefined,
			() => canonical,
		);

		expect(result).toEqual({ ok: false, error: "Stale or altered SSH target" });
		expect(runner.calls).toHaveLength(1);
	});

	it("parses POSIX NUL directory records and filters hidden names", async () => {
		const runner = new FakeRunner();
		runner.respond(probeOutput());
		runner.respond(
			[
				`H\t${b64("/work/repo")}\t${b64("/work")}`,
				`E\tdirectory\t0\t${b64("src")}\t${b64("/work/repo/src")}`,
				`E\tsymlink-directory\t1\t${b64(".cache")}\t${b64("/work/repo/.cache")}`,
				"",
			].join("\0"),
		);

		const result = await service(runner).listDirectories(sshTarget(), "/work/repo", false, undefined, () =>
			sshTarget(),
		);

		expect(result).toEqual({
			ok: true,
			path: "/work/repo",
			parent: "/work",
			entries: [{ name: "src", path: "/work/repo/src", kind: "directory", hidden: false }],
		});
		const helper = runner.calls[1]?.args.at(-1) ?? "";
		expect(helper).not.toContain("/work/repo");
		expect(helper).toContain(b64("/work/repo"));
	});

	it("parses compact Windows JSON directory records", async () => {
		const runner = new FakeRunner();
		runner.respond(
			probeOutput({
				home: "C:\\Users\\Danny",
				platform: "windows",
				shell: "powershell.exe",
				executable: "C:\\bin\\omp.exe",
				path: "C:\\bin;C:\\Windows",
			}),
		);
		runner.respond(
			[
				JSON.stringify({ type: "header", path: "C:\\work", parent: "C:\\" }),
				JSON.stringify({ type: "entry", name: "src", path: "C:\\work\\src", kind: "directory", hidden: false }),
			].join("\n"),
		);
		const target = sshTarget({
			host: { ...sshTarget().host, os: "windows" },
			cwd: "C:\\work",
			originCwd: "C:\\work",
		});

		expect(
			await service(runner, { platform: "win32" }).listDirectories(
				target,
				"C:\\work",
				true,
				undefined,
				() => target,
			),
		).toEqual({
			ok: true,
			path: "C:\\work",
			parent: "C:\\",
			entries: [{ name: "src", path: "C:\\work\\src", kind: "directory", hidden: false }],
		});
		const remoteCommand = runner.calls[1]?.args.at(-1) ?? "";
		expect(remoteCommand).toContain("-EncodedCommand");
		expect(remoteCommand).not.toContain("C:\\work");
		const script = Buffer.from(remoteCommand.split(" ").at(-1) ?? "", "base64").toString("utf16le");
		expect(script).toContain("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)");
	});

	it("rejects directory records above the configured entry cap before JSON parsing", async () => {
		const runner = new FakeRunner();
		runner.respond(probeOutput({ platform: "windows" }));
		runner.respond(
			[
				JSON.stringify({ type: "header", path: "C:\\work", parent: "C:\\" }),
				JSON.stringify({ type: "entry", name: "one", path: "C:\\work\\one", kind: "directory", hidden: false }),
				"{malformed-json-that-must-not-be-parsed}",
			].join("\n"),
		);
		const target = sshTarget({
			host: { ...sshTarget().host, os: "windows" },
			cwd: "C:\\work",
			originCwd: "C:\\work",
		});

		const result = await service(runner, { platform: "win32", maxDirectoryEntries: 1 }).listDirectories(
			target,
			"C:\\work",
			true,
			undefined,
			() => target,
		);

		expect(result).toEqual({ ok: false, error: "Remote directory returned too many records" });
	});
	it("validates and returns a remotely canonical directory", async () => {
		const runner = new FakeRunner();
		runner.respond(probeOutput());
		runner.respond(`P\t${b64("/srv/work/repo")}\0`);

		expect(
			await service(runner).validateDirectory(sshTarget(), "/srv/work/../work/repo", undefined, () => sshTarget()),
		).toEqual({
			ok: true,
			path: "/srv/work/repo",
		});
	});

	it("lists a bounded POSIX workspace tree with files and directories under trusted physical roots", async () => {
		const runner = new FakeRunner();
		runner.respond(probeOutput());
		runner.respond(
			[
				`E\t0\tdir\t${b64("src")}\t${b64("src")}`,
				`E\t1\tfile\t${b64("index.ts")}\t${b64("src/index.ts")}`,
				`E\t0\tfile\t${b64("README.md")}\t${b64("README.md")}`,
				"",
			].join("\0"),
		);

		expect(await service(runner).listWorkspace(sshTarget(), "/work/repo", ["/work/repo", "/shared"], 4, 100)).toEqual(
			{
				ok: true,
				entries: [
					{
						name: "src",
						path: "src",
						kind: "dir",
						children: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
					},
					{ name: "README.md", path: "README.md", kind: "file" },
				],
				truncated: false,
			},
		);
		const helper = runner.calls[1]?.args.at(-1) ?? "";
		expect(helper).not.toContain("/work/repo");
		expect(helper).not.toContain("/shared");
		expect(helper).toContain(b64("/work/repo"));
		expect(helper).toContain(b64("/shared"));
		expect(helper).toContain("-L");
		expect(helper).toContain("readlink");
	});

	it("rejects workspace output above the entry cap before parsing malformed records", async () => {
		const runner = new FakeRunner();
		runner.respond(probeOutput());
		runner.respond(
			[
				`E\t0\tfile\t${b64("one")}\t${b64("one")}`,
				`E\t0\tfile\t${b64("two")}\t${b64("two")}`,
				"malformed-record-that-must-not-be-parsed",
				"",
			].join("\0"),
		);

		expect(await service(runner).listWorkspace(sshTarget(), "/work/repo", [], 2, 2)).toEqual({
			ok: false,
			error: "Remote workspace returned too many records",
		});
	});

	it("lists Windows workspaces without following reparse points and encodes every renderer path", async () => {
		const runner = new FakeRunner();
		runner.respond(
			probeOutput({
				home: "C:\\Users\\Danny",
				platform: "windows",
				shell: "powershell.exe",
				executable: "C:\\bin\\omp.exe",
				path: "C:\\bin;C:\\Windows",
			}),
		);
		runner.respond(
			[
				JSON.stringify({ type: "entry", depth: 0, kind: "dir", name: "src", path: "src" }),
				JSON.stringify({ type: "entry", depth: 1, kind: "file", name: "main.ts", path: "src/main.ts" }),
			].join("\n"),
		);
		const target = sshTarget({
			host: { ...sshTarget().host, os: "windows" },
			originCwd: "C:\\work",
			cwd: "C:\\work",
		});

		expect(
			await service(runner, { platform: "win32" }).listWorkspace(target, "C:\\work", ["D:\\shared"], 3, 20),
		).toEqual({
			ok: true,
			entries: [
				{
					name: "src",
					path: "src",
					kind: "dir",
					children: [{ name: "main.ts", path: "src/main.ts", kind: "file" }],
				},
			],
			truncated: false,
		});
		const command = runner.calls[1]?.args.at(-1) ?? "";
		expect(command).not.toContain("C:\\work");
		expect(command).not.toContain("D:\\shared");
		const script = Buffer.from(command.split(" ").at(-1) ?? "", "base64").toString("utf16le");
		expect(script).toContain("ReparsePoint");
		expect(script).not.toContain("Resolve-Path");
		expect(script).toContain("GetFinalPathNameByHandle");
		expect(script).toContain("OpenDirectory");
		expect(script).toContain("$requestedPhysical");
		expect(script).toContain("FilesystemPath");
	});

	it.runIf(process.platform === "linux" || (process.platform === "darwin" && existsSync("/usr/bin/python3")))(
		"executes the workspace helper without following a symlink outside its trusted root",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-list-"));
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-outside-"));
			try {
				await fs.mkdir(path.join(root, "src"));
				await fs.writeFile(path.join(root, "src", "index.ts"), "export {};");
				await fs.writeFile(path.join(root, "README.md"), "read me");
				await fs.writeFile(path.join(outside, "secret.txt"), "secret");
				await fs.symlink(outside, path.join(root, "outside-link"));
				const platform = process.platform === "darwin" ? "macos" : "linux";
				const runner = new FakeRunner();
				runner.queue(executeRemoteCommandLocally);
				runner.queue(executeRemoteCommandLocally);
				const target = sshTarget({
					host: { ...sshTarget().host, os: platform },
					originCwd: root,
					cwd: root,
					executableOverride: "/bin/sh",
				});

				expect(await service(runner).listWorkspace(target, root, [], 2, 20)).toEqual({
					ok: true,
					entries: [
						{
							name: "src",
							path: "src",
							kind: "dir",
							children: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
						},
						{ name: "README.md", path: "README.md", kind: "file" },
					],
					truncated: false,
				});
			} finally {
				await fs.rm(root, { recursive: true, force: true });
				await fs.rm(outside, { recursive: true, force: true });
			}
		},
	);

	it("authorizes a POSIX filesystem-root target without a double-slash mismatch", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-root-"));
		try {
			await fs.writeFile(path.join(root, "root-file.txt"), "root");
			const runner = new FakeRunner();
			runner.respond(probeOutput());
			runner.queue(executeRemoteCommandLocally);
			const target = sshTarget({
				host: { ...sshTarget().host, os: "linux" },
				originCwd: "/",
				cwd: "/",
				executableOverride: "/bin/sh",
			});
			const prefix = (await fs.realpath(root)).replace(/^\/+/u, "");

			expect(await service(runner).listWorkspace(target, root, [], 1, 10)).toEqual({
				ok: true,
				entries: [{ name: "root-file.txt", path: `${prefix}/root-file.txt`, kind: "file" }],
				truncated: false,
			});
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("allows encoded roots outside target cwd and truncates file bytes to the pre-parse cap", async () => {
		const runner = new FakeRunner();
		runner.respond(probeOutput());
		const bytes = Buffer.concat([Buffer.from("11\0", "utf8"), Buffer.from("hello world", "utf8")]);
		runner.respond(bytes);

		const result = await service(runner).readFile(sshTarget(), "/sessions/archive/log.txt", ["/sessions/archive"], 5);

		expect(result).toEqual({ ok: true, data: new Uint8Array(Buffer.from("hello")), size: 11, truncated: true });
		const helper = runner.calls[1]?.args.at(-1) ?? "";
		expect(helper).not.toContain("/sessions/archive/log.txt");
		expect(helper).toContain(b64("/sessions/archive/log.txt"));
		expect(helper).toContain(b64("/work/repo"));
		expect(helper).toContain(b64("/sessions/archive"));
		expect(helper).toContain("exec 3<");
		expect(helper).toContain("/proc/$$/fd/3");
		expect(helper).toContain("<&3");
		expect(helper).not.toContain("python3");
	});

	it("fails closed before reading when preflight found no handle-safe POSIX helper", async () => {
		const runner = new FakeRunner();
		runner.respond(probeOutput({ fileHelper: "unavailable" }));

		expect(await service(runner).readFile(sshTarget(), "/work/repo/file.txt", [], 10)).toEqual({
			ok: false,
			error: "Remote host has no handle-safe file helper",
		});
		expect(runner.calls).toHaveLength(1);
	});

	it("uses the exact macOS helper proven by preflight for handle-based reads", async () => {
		const runner = new FakeRunner();
		runner.respond(
			probeOutput({
				platform: "macos",
				fileHelper: `python:${b64("/opt/homebrew/bin/python3")}`,
			}),
		);
		runner.respond(Buffer.concat([Buffer.from("4\0"), Buffer.from("data")]));
		const target = sshTarget({ host: { ...sshTarget().host, os: "macos" } });

		expect(await service(runner).readFile(target, "/work/repo/file.txt", [], 4)).toMatchObject({ ok: true });
		const helper = runner.calls[1]?.args.at(-1) ?? "";
		expect(helper).toContain("/opt/homebrew/bin/python3");
		expect(helper).toContain("F_GETPATH");
		expect(helper).toContain("os.read(fd");
	});
	it.runIf(process.platform === "linux" || (process.platform === "darwin" && existsSync("/usr/bin/python3")))(
		"executes the discovered POSIX handle helper against a real file descriptor",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-read-"));
			try {
				const file = path.join(root, "quoted ' file.txt");
				await fs.writeFile(file, "hello world");
				const platform = process.platform === "darwin" ? "macos" : "linux";
				const runner = new FakeRunner();
				runner.queue(executeRemoteCommandLocally);
				runner.queue(executeRemoteCommandLocally);
				const target = sshTarget({
					host: { ...sshTarget().host, os: platform },
					originCwd: root,
					cwd: root,
					executableOverride: "/bin/sh",
				});

				expect(await service(runner).readFile(target, file, [], 5)).toEqual({
					ok: true,
					data: new Uint8Array(Buffer.from("hello")),
					size: 11,
					truncated: true,
				});
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	);

	it.runIf(process.platform === "linux" || (process.platform === "darwin" && existsSync("/usr/bin/python3")))(
		"rejects a same-named file outside every remote trusted root before transferring bytes",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-read-root-"));
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-read-outside-"));
			try {
				await fs.writeFile(path.join(root, "same-name.txt"), "authorized remote bytes");
				const outsidePath = path.join(outside, "same-name.txt");
				await fs.writeFile(outsidePath, "must never transfer");
				const platform = process.platform === "darwin" ? "macos" : "linux";
				const runner = new FakeRunner();
				runner.queue(executeRemoteCommandLocally);
				runner.queue(executeRemoteCommandLocally);
				const target = sshTarget({
					host: { ...sshTarget().host, os: platform },
					originCwd: root,
					cwd: root,
					executableOverride: "/bin/sh",
				});

				expect(await service(runner).readFile(target, outsidePath, [], 100)).toMatchObject({ ok: false });
				expect(runner.calls).toHaveLength(2);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
				await fs.rm(outside, { recursive: true, force: true });
			}
		},
	);

	it("streams only the bounded Windows file prefix instead of loading the whole remote file", async () => {
		const runner = new FakeRunner();
		runner.respond(
			probeOutput({
				home: "C:\\Users\\Danny",
				platform: "windows",
				shell: "powershell.exe",
				executable: "C:\\bin\\omp.exe",
				path: "C:\\bin;C:\\Windows",
			}),
		);
		runner.respond(Buffer.concat([Buffer.from("4\0"), Buffer.from("data")]));
		const target = sshTarget({
			host: { ...sshTarget().host, os: "windows" },
			originCwd: "C:\\work",
			cwd: "C:\\work",
		});

		expect(await service(runner, { platform: "win32" }).readFile(target, "C:\\work\\large.log", [], 4)).toEqual({
			ok: true,
			data: new Uint8Array(Buffer.from("data")),
			size: 4,
			truncated: false,
		});
		const command = runner.calls[1]?.args.at(-1) ?? "";
		const script = Buffer.from(command.split(" ").at(-1) ?? "", "base64").toString("utf16le");
		expect(script).toContain("CreateFile");
		expect(script).toContain("GetFinalPathNameByHandle");
		expect(script).toContain("[IO.FileStream]::new($handle");
		expect(script).not.toContain("Resolve-Path");
		expect(script).not.toContain("Get-Item");
		expect(script).not.toContain("OpenRead");
		expect(script).not.toContain("ReadAllBytes");
	});

	it("aborts timed-out operations, terminates the process group, and bounds retained stderr", async () => {
		const runner = new FakeRunner();
		const launched: FakeChild[] = [];
		runner.queue(call => {
			launched.push(call.child);
			queueMicrotask(() => call.child.stderr.write("0123456789abcdefghijklmnopqrstuvwxyz"));
		});
		const signals: NodeJS.Signals[] = [];
		const ssh = service(runner, {
			operationTimeoutMs: 2,
			stderrCapBytes: 8,
			killProcessGroup: (_pid, signal) => {
				signals.push(signal);
				queueMicrotask(() => launched[0]?.finishSignal(signal));
			},
		});

		const result = await ssh.resolveRuntime(sshTarget());

		expect(result).toEqual({ ok: false, error: "Remote operation timed out: stuvwxyz" });
		expect(signals).toEqual(["SIGTERM"]);
	});

	it("cancelling a one-shot dialog operation terminates its SSH child exactly once", async () => {
		const runner = new FakeRunner();
		const launched: FakeChild[] = [];
		const signals: NodeJS.Signals[] = [];
		runner.queue(call => {
			launched.push(call.child);
		});
		const controller = new AbortController();
		const ssh = service(runner, {
			killProcessGroup: (_pid, signal) => {
				signals.push(signal);
				queueMicrotask(() => launched[0]?.finishSignal(signal));
			},
		});
		const pending = ssh.resolveRuntime(sshTarget(), controller.signal);
		controller.abort();

		expect(await pending).toEqual({ ok: false, error: "Remote operation aborted" });
		expect(signals).toEqual(["SIGTERM"]);
		expect(launched[0]?.signalCode).toBe("SIGTERM");
	});

	it("does not lose an abort fired synchronously while spawning", async () => {
		vi.useFakeTimers();
		try {
			const runner = new FakeRunner();
			const controller = new AbortController();
			const launched: FakeChild[] = [];
			runner.queue(call => {
				launched.push(call.child);
				controller.abort();
			});
			const ssh = service(runner, {
				operationTimeoutMs: 50,
				killProcessGroup: (_pid, signal) => queueMicrotask(() => launched[0]?.finishSignal(signal)),
			});

			const result = ssh.resolveRuntime(sshTarget(), controller.signal);
			await vi.advanceTimersByTimeAsync(50);

			expect(await result).toEqual({ ok: false, error: "Remote operation aborted" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles a timed-out operation when Windows tree termination rejects", async () => {
		vi.useFakeTimers();
		try {
			const runner = new FakeRunner();
			runner.queue(call => {
				call.child.killCloses = false;
			});
			runner.queue(call => queueMicrotask(() => call.child.finish("", "access denied", 1)));
			const ssh = service(runner, { platform: "win32", operationTimeoutMs: 1, terminationGraceMs: 1 });

			const result = ssh.resolveRuntime(sshTarget({ host: { ...sshTarget().host, os: "windows" } }));
			await vi.advanceTimersByTimeAsync(5);

			expect(await result).toEqual({
				ok: false,
				error: "Remote operation timed out; process-tree termination failed: Unable to confirm SSH process-tree termination",
			});
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("RemoteSshService remote input bounds", () => {
	it.each([
		["host alias", { hostAlias: "é".repeat(129) }],
		["cwd", { cwd: `/${"💥".repeat(4_096)}` }],
		["executable override", { executableOverride: `/${"💥".repeat(4_096)}` }],
	] satisfies Array<[string, Partial<SshSessionTarget>]>)(
		"rejects an oversized multibyte %s before runtime encoding or spawn",
		async (_name, overrides) => {
			const runner = new FakeRunner();
			const target = sshTarget(overrides);
			const encode = vi.spyOn(Buffer, "from");
			try {
				expect(await service(runner).resolveRuntime(target)).toEqual({
					ok: false,
					error: "Invalid SSH session target",
				});
				expect(encode).not.toHaveBeenCalled();
				expect(runner.calls).toHaveLength(0);
			} finally {
				encode.mockRestore();
			}
		},
	);

	it("rejects oversized multibyte directory paths before runtime resolution", async () => {
		const runner = new FakeRunner();
		const ssh = service(runner);
		const target = sshTarget();
		const oversizedPath = `/${"💥".repeat(4_096)}`;

		expect(await ssh.listDirectories(target, oversizedPath, false, undefined, () => target)).toEqual({
			ok: false,
			error: "Invalid remote directory path",
		});
		expect(await ssh.validateDirectory(target, oversizedPath, undefined, () => target)).toEqual({
			ok: false,
			error: "Invalid remote directory path",
		});
		expect(runner.calls).toHaveLength(0);
	});

	it("rejects oversized workspace paths, roots, and root counts before copying or runtime resolution", async () => {
		const runner = new FakeRunner();
		const ssh = service(runner);
		const oversizedPath = `/${"💥".repeat(4_096)}`;
		const excessiveRoots = Array.from({ length: 129 }, (_, index) => `/shared/${index}`);

		expect(await ssh.listWorkspace(sshTarget(), oversizedPath, [], 4, 100)).toEqual({
			ok: false,
			error: "Invalid remote workspace request",
		});
		expect(await ssh.listWorkspace(sshTarget(), "/work/repo", [oversizedPath], 4, 100)).toEqual({
			ok: false,
			error: "Invalid remote workspace request",
		});
		expect(await ssh.listWorkspace(sshTarget(), "/work/repo", excessiveRoots, 4, 100)).toEqual({
			ok: false,
			error: "Invalid remote workspace request",
		});
		expect(await ssh.readFile(sshTarget(), "/work/repo/file", [oversizedPath], 100)).toEqual({
			ok: false,
			error: "Invalid remote file request",
		});
		expect(await ssh.readFile(sshTarget(), "/work/repo/file", excessiveRoots, 100)).toEqual({
			ok: false,
			error: "Invalid remote file request",
		});
		expect(runner.calls).toHaveLength(0);
	});

	it("rejects an oversized remote resume id before PowerShell encoding or spawn", () => {
		const runner = new FakeRunner();
		const target = sshTarget({
			host: { ...sshTarget().host, os: "windows" },
			originCwd: "C:\\work",
			cwd: "C:\\work",
		});
		const remoteRuntime = runtime({ platform: "windows" });
		const encode = vi.spyOn(Buffer, "from");
		try {
			expect(() =>
				service(runner, { platform: "win32" }).spawnRpc(target, remoteRuntime, ["--resume", "💥".repeat(1_025)]),
			).toThrow("Invalid remote launch request");
			expect(encode).not.toHaveBeenCalled();
			expect(runner.calls).toHaveLength(0);
		} finally {
			encode.mockRestore();
		}
	});
});
