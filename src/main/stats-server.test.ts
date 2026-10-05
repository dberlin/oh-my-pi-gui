import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import { StatsClient } from "./stats-client";
import { StatsServerManager, statsServerPort } from "./stats-server";

const bundledBinary = path.resolve("resources", process.platform === "win32" ? "omp.exe" : "omp");

afterEach(() => vi.restoreAllMocks());

test("a live listener is never respawned by a demand-driven revive", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-revive-"));
	const binary = path.join(directory, "stats-live.ts");
	await fs.writeFile(
		binary,
		`#!/usr/bin/env bun
process.stdout.write("Dashboard available at: http://127.0.0.1:55123\\n");
await Bun.sleep(5000);
`,
	);
	await fs.chmod(binary, 0o755);
	const server = new StatsServerManager(binary);
	try {
		server.start();
		await expect.poll(() => server.port, { timeout: 5000 }).toBe(55123);
		// Every open dashboard polls; a revive that ignored the live child would
		// stack listeners and hand the client a port nobody owns after the first exit.
		expect(server.ensureRunning()).toBe("already-pending");
		expect(server.port).toBe(55123);
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("stats does not contact an unrelated default server before its own listener is ready", async () => {
	const fetch = vi.spyOn(globalThis, "fetch");
	const client = new StatsClient();
	expect(await client.probe()).toBe(false);
	await expect(client.fetch("/api/stats/requests")).rejects.toThrow("not ready");
	expect(fetch).not.toHaveBeenCalled();
});

test("split numeric loopback readiness selects the bundled listener and resets after exit", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stats-ready-"));
	const binary = path.join(directory, "stats.ts");
	await fs.writeFile(
		binary,
		`#!/usr/bin/env bun
process.stdout.write("\\x1b[32mDashboard available at: http://127.0.0.1:54");
await Bun.sleep(30);
process.stdout.write("321\\x1b[39m\\n");
await Bun.sleep(100);
process.exit(1);
`,
	);
	await fs.chmod(binary, 0o755);
	const server = new StatsServerManager(binary);
	const ports: number[] = [];
	const exits: number[] = [];
	server.on("ready", port => ports.push(port));
	server.on("exit", () => exits.push(server.port));
	try {
		server.start();
		await expect.poll(() => ports, { timeout: 5000 }).toEqual([54321]);
		await expect.poll(() => exits, { timeout: 5000 }).toEqual([0]);
	} finally {
		server.kill();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("fetch sends POST for /api/sync, which 405s a plain GET", async () => {
	const methods: string[] = [];
	const server = http.createServer((req, res) => {
		methods.push(`${req.method} ${req.url}`);
		if (req.url === "/api/sync" && req.method !== "POST") {
			res.writeHead(405).end(JSON.stringify({ error: "POST required" }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" }).end("{}");
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	try {
		const client = new StatsClient((server.address() as AddressInfo).port);
		await expect(client.fetch("/api/sync")).resolves.toEqual({});
		await client.fetch("/api/stats/models");
		await client.fetch("/api/status");
		await client.fetch("/api/stats/providers");
		await client.fetch("/api/stats/provider-windows");
		await expect(client.fetch("/api/stats/behavior")).rejects.toThrow("Invalid stats path");
		expect(methods).toEqual([
			"POST /api/sync",
			"GET /api/stats/models",
			"GET /api/status",
			"GET /api/stats/providers",
			"GET /api/stats/provider-windows",
		]);
	} finally {
		server.close();
	}
});

test.skipIf(!existsSync(bundledBinary))(
	"the built GUI entry owns a private stats listener, syncs sessions, and exposes its judge without opening a browser (requires build:omp)",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-embedded-stats-"));
		const binary = path.join(directory, "omp");
		const browserLog = path.join(directory, "browser-launches");
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		const sessions = path.join(directory, "agent", "sessions", "fixture");
		await fs.mkdir(sessions, { recursive: true });
		const timestamp = new Date().toISOString();
		await fs.writeFile(
			path.join(sessions, "fixture.jsonl"),
			[
				{ type: "session", version: 3, id: "gui-stats-fixture", timestamp, cwd: directory },
				{
					type: "message",
					id: "user-1",
					timestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: "Explain this fixture." }],
						timestamp: Date.now(),
					},
				},
				{
					type: "message",
					id: "assistant-1",
					parentId: "user-1",
					timestamp,
					message: {
						role: "assistant",
						content: [{ type: "text", text: "This is the embedded stats fixture." }],
						provider: "openai",
						model: "gpt-4o",
						api: "openai-responses",
						usage: {
							input: 12,
							output: 8,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 20,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				},
			]
				.map(row => JSON.stringify(row))
				.join("\n") + "\n",
		);
		for (const opener of ["open", "xdg-open", "wslview"]) {
			const openerPath = path.join(directory, opener);
			await fs.writeFile(openerPath, `#!/bin/sh\nprintf launched >> ${quote(browserLog)}\n`);
			await fs.chmod(openerPath, 0o755);
		}
		await fs.writeFile(
			binary,
			`#!/bin/sh
unset PI_PROFILE PI_COMPILED
export HOME=${quote(directory)}
export PI_CODING_AGENT_DIR=${quote(path.join(directory, "agent"))}
export OMP_PROFILE=''
export PATH=${quote(directory)}:"$PATH"
exec ${quote(bundledBinary)} "$@"
`,
		);
		await fs.chmod(binary, 0o755);
		const first = new StatsServerManager(binary);
		const second = new StatsServerManager(binary);
		try {
			first.start();
			second.start();
			await expect.poll(() => first.port, { timeout: 15_000 }).toBeGreaterThan(0);
			await expect.poll(() => second.port, { timeout: 15_000 }).toBeGreaterThan(0);
			expect(first.port).not.toBe(second.port);
			const origin = `http://127.0.0.1:${first.port}`;
			const dashboard = await fetch(origin);
			expect(dashboard.headers.get("X-Omp-Stats-Hostname")).toBe("127.0.0.1");
			expect(await dashboard.text()).toContain('<div id="root"></div>');
			const sync = await fetch(`${origin}/api/sync`, { method: "POST" });
			expect(sync.status).toBe(202);
			await expect
				.poll(
					async () => {
						const response = await fetch(`${origin}/api/stats/models`);
						const models = (await response.json()) as { model: string; totalRequests: number }[];
						return models.find(model => model.model === "gpt-4o")?.totalRequests;
					},
					{ timeout: 15_000 },
				)
				.toBe(1);
			const frustration = await fetch(`${origin}/api/stats/frustration`);
			expect(await frustration.json()).toMatchObject({ judgeAvailable: true });
			// Cancellation exercises the upstream action route without a paid provider call.
			const cancel = await fetch(`${origin}/api/frustration/cancel`, {
				method: "POST",
				headers: { "X-Omp-Stats-Action": "1" },
			});
			expect(cancel.status).toBe(200);
			first.kill();
			await expect
				.poll(
					async () =>
						fetch(origin).then(
							() => false,
							() => true,
						),
					{ timeout: 5000 },
				)
				.toBe(true);
			expect((await fetch(`http://127.0.0.1:${second.port}/api/status`)).ok).toBe(true);
			await expect(fs.access(browserLog)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			first.kill();
			second.kill();
			try {
				await Promise.all(
					[first.port, second.port].map(port =>
						expect
							.poll(
								async () =>
									fetch(`http://127.0.0.1:${port}`).then(
										() => false,
										() => true,
									),
								{ timeout: 5000 },
							)
							.toBe(true),
					),
				);
			} finally {
				await fs.rm(directory, { recursive: true, force: true });
			}
		}
	},
	45_000,
);

describe("statsServerPort", () => {
	it.each([
		["http://127.0.0.1:3847", 3847],
		["http://localhost:54321", 54321],
		["http://[::1]:49152", 49152],
	])("accepts a complete loopback readiness line for %s", (url, port) => {
		expect(statsServerPort(`Dashboard available at: ${url}\n`)).toBe(port);
	});

	it.each([
		"Dashboard available at: http://127.0.0.1:54",
		"Dashboard available at: http://127.0.0.1:54321",
		"Dashboard available at: http://127.0.0.1:0\n",
		"Dashboard available at: http://example.com:3847\n",
	])("does not announce readiness from an incomplete or unusable listener: %s", output => {
		expect(statsServerPort(output)).toBeNull();
	});
});
