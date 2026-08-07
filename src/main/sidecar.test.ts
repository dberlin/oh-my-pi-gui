import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import Store from "electron-store";
import { describe, expect, it } from "vitest";
import type { CommandOutputFrame, PromptResultFrame, SidecarStatus } from "../shared/rpc-types";
import { SidecarManager } from "./sidecar";

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

	it("adoptCwd re-roots the reported cwd and plain restarts spawn there", async () => {
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
			expect(sidecar.adoptCwd(tempDir)).toBe(false);
			expect(sidecar.adoptCwd(adoptedCwd)).toBe(true);
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
