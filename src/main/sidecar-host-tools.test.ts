import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { SshSessionTarget } from "../shared/ipc-types";
import type { HostToolCallRequest, SidecarStatus } from "../shared/rpc-types";
import type { RemoteHostCatalog } from "./remote-host-catalog";
import type { RemoteSshService } from "./remote-ssh";
import { SidecarManager } from "./sidecar";

const REMOTE_TARGET: SshSessionTarget = {
	type: "ssh",
	hostAlias: "host-tool-test",
	host: {
		host: "remote.example.test",
		username: "tester",
		port: 22,
		sourceId: "test",
		sourceLevel: "project",
		os: "linux",
		shell: "bash",
	},
	originCwd: "/srv/project",
	cwd: "/srv/project",
};

const HOST_TOOL_NAMES = ["gui_clipboard_read", "gui_open_url", "gui_notify", "unregistered_host_tool"];

interface RemoteHarness {
	sidecar: SidecarManager;
	stdout: PassThrough;
	stderr: PassThrough;
	writes: Array<Record<string, unknown>>;
	termination: { count: number };
}

function hostToolRequest(toolName: string, id = `request-${toolName}`): HostToolCallRequest {
	return {
		type: "host_tool_call",
		id,
		toolCallId: `call-${toolName}`,
		toolName,
		arguments: {},
	};
}

async function createRemoteHarness(): Promise<RemoteHarness> {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const writes: Array<Record<string, unknown>> = [];
	const termination = { count: 0 };
	const spawned = Promise.withResolvers<void>();
	const child = new EventEmitter() as unknown as ChildProcess;
	Object.assign(child, {
		stdin: {
			writable: true,
			write: (chunk: string | Uint8Array): boolean => {
				const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
				for (const line of text.split("\n")) {
					if (!line) continue;
					const parsed: unknown = JSON.parse(line);
					if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
						writes.push(parsed as Record<string, unknown>);
					}
				}
				return true;
			},
		},
		stdout,
		stderr,
		exitCode: null,
		signalCode: null,
		kill: () => true,
	});
	const remoteSsh = {
		async resolveRuntime(target: SshSessionTarget) {
			return {
				ok: true as const,
				target,
				runtime: {
					home: "/home/tester",
					platform: "linux" as const,
					shell: "/bin/bash",
					executable: "/usr/local/bin/omp",
					runtimePath: ["/usr/local/bin", "/usr/bin"],
				},
			};
		},
		spawnRpc() {
			spawned.resolve();
			return {
				child,
				terminate: async () => {
					termination.count++;
				},
			};
		},
	} as unknown as RemoteSshService;
	const sidecar = new SidecarManager({
		binaryPath: "",
		cwd: REMOTE_TARGET.cwd,
		target: REMOTE_TARGET,
		remoteSsh,
		remoteHostCatalog: {
			target: () => ({ ...REMOTE_TARGET, host: { ...REMOTE_TARGET.host } }),
		} as unknown as RemoteHostCatalog,
	});
	sidecar.start();
	await spawned.promise;
	return { sidecar, stdout, stderr, writes, termination };
}

async function disposeRemoteHarness(harness: RemoteHarness): Promise<void> {
	await harness.sidecar.dispose();
	harness.stdout.destroy();
	harness.stderr.destroy();
}

describe("SidecarManager remote host-tool boundary", () => {
	it.each(HOST_TOOL_NAMES)("answers remote %s with one bounded denial and never forwards it", async toolName => {
		const harness = await createRemoteHarness();
		const forwarded: HostToolCallRequest[] = [];
		harness.sidecar.on("hostToolCall", request => forwarded.push(request as HostToolCallRequest));
		try {
			const request = hostToolRequest(toolName);
			harness.stdout.write(`${JSON.stringify(request)}\n`);

			expect(forwarded).toEqual([]);
			expect(harness.writes).toHaveLength(1);
			expect(harness.writes[0]).toMatchObject({ type: "host_tool_result", id: request.id });
			const error = harness.writes[0]?.error;
			expect(typeof error).toBe("string");
			expect((error as string).length).toBeLessThanOrEqual(128);
		} finally {
			await disposeRemoteHarness(harness);
		}
	});

	it.each([
		["non-string id", { id: 7 }],
		["oversized id", { id: "x".repeat(129) }],
		["empty tool-call id", { toolCallId: "" }],
		["oversized tool name", { toolName: "x".repeat(129) }],
		["array arguments", { arguments: [] }],
		["null arguments", { arguments: null }],
	])("terminates a malformed remote request with %s before forwarding", async (_name, override) => {
		const harness = await createRemoteHarness();
		let forwarded = 0;
		const statuses: SidecarStatus[] = [];
		harness.sidecar.on("hostToolCall", () => forwarded++);
		harness.sidecar.on("status", ({ status }: { status: SidecarStatus }) => statuses.push(status));
		try {
			const malformed = { ...hostToolRequest("gui_open_url"), ...override };
			harness.stdout.write(`${JSON.stringify(malformed)}\n`);

			expect(forwarded).toBe(0);
			expect(harness.writes).toEqual([]);
			expect(statuses.at(-1)).toBe("error");
			expect(harness.termination.count).toBe(1);
		} finally {
			await disposeRemoteHarness(harness);
		}
	});
});

describe("SidecarManager local host-tool compatibility", () => {
	it("keeps local host-tool requests on the existing forwarding path", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-local-host-tools-"));
		const binaryPath = path.join(tempDir, "fake-sidecar.ts");
		const requests = HOST_TOOL_NAMES.map(toolName => hostToolRequest(toolName));
		await fs.writeFile(
			binaryPath,
			`#!/usr/bin/env bun\nfor (const frame of ${JSON.stringify(requests)}) process.stdout.write(JSON.stringify(frame) + "\\n");\nprocess.stdin.resume();\n`,
		);
		await fs.chmod(binaryPath, 0o755);
		const sidecar = new SidecarManager({ binaryPath, cwd: tempDir });
		const forwarded: HostToolCallRequest[] = [];
		const complete = Promise.withResolvers<void>();
		sidecar.on("hostToolCall", request => {
			forwarded.push(request as HostToolCallRequest);
			if (forwarded.length === requests.length) complete.resolve();
		});
		try {
			sidecar.start();
			await complete.promise;
			expect(forwarded).toEqual(requests);
		} finally {
			await sidecar.dispose();
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
