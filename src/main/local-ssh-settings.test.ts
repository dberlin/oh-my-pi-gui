import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcSshHostsResult, RpcSshTestResult } from "../shared/rpc-types";
import type { LocalSshSettingsCommand } from "./ipc";
import { LocalSshSettingsService } from "./local-ssh-settings";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-local-ssh-"));
	tempDirs.push(dir);
	return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson(filePath: string): Promise<Record<string, unknown>> {
	return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("LocalSshSettingsService", () => {
	it("lists project and user SSH hosts without probing either host", async () => {
		const projectCwd = await tempDir();
		const home = await tempDir();
		await writeJson(path.join(projectCwd, ".omp", "ssh.json"), {
			hosts: {
				grill: { host: "grill.controls.dberlin.org", username: "dannyb", port: 22 },
			},
		});
		await writeJson(path.join(home, ".omp", "agent", "ssh.json"), {
			hosts: {
				backup: { host: "backup.example.com", keyPath: "~/.ssh/backup" },
			},
		});
		const resolveRuntime = vi.fn();
		const service = new LocalSshSettingsService({
			home,
			isOpenSshAvailable: () => Promise.resolve(true),
			resolveRuntime,
		});

		const response = await service.execute(projectCwd, { id: "hosts-1", type: "get_ssh_hosts" });

		expect(response.success).toBe(true);
		if (!response.success) throw new Error(response.error);
		const result = response.data as RpcSshHostsResult;
		expect(result.openSshAvailable).toBe(true);
		expect(result.hosts).toEqual([
			expect.objectContaining({
				name: "grill",
				host: "grill.controls.dberlin.org",
				username: "dannyb",
				port: 22,
				scope: "project",
				editable: true,
			}),
			expect.objectContaining({
				name: "backup",
				host: "backup.example.com",
				keyPath: "~/.ssh/backup",
				scope: "user",
				editable: true,
			}),
		]);
		expect(result.warnings).toEqual([]);
		expect(resolveRuntime).not.toHaveBeenCalled();
	});

	it("uses project precedence when the same alias exists in both scopes", async () => {
		const projectCwd = await tempDir();
		const home = await tempDir();
		await writeJson(path.join(projectCwd, ".omp", "ssh.json"), {
			hosts: { shared: { host: "project.example.com" } },
		});
		await writeJson(path.join(home, ".omp", "agent", "ssh.json"), {
			hosts: { shared: { host: "user.example.com" } },
		});
		const service = new LocalSshSettingsService({
			home,
			isOpenSshAvailable: () => Promise.resolve(true),
			resolveRuntime: vi.fn(),
		});

		const response = await service.execute(projectCwd, { type: "get_ssh_hosts" });

		expect(response.success).toBe(true);
		if (!response.success) throw new Error(response.error);
		const result = response.data as RpcSshHostsResult;
		expect(result.hosts).toEqual([
			expect.objectContaining({ name: "shared", host: "project.example.com", scope: "project" }),
		]);
		expect(result.warnings).toContain("Ignored user SSH host shadowed by project config: shared");
	});

	it("rejects malformed management actions without changing the config", async () => {
		const projectCwd = await tempDir();
		const home = await tempDir();
		const projectPath = path.join(projectCwd, ".omp", "ssh.json");
		const original = { hosts: { victim: { host: "victim.example.com" } } };
		await writeJson(projectPath, original);
		const service = new LocalSshSettingsService({
			home,
			isOpenSshAvailable: () => Promise.resolve(true),
			resolveRuntime: vi.fn(),
		});
		const malformed = {
			type: "ssh_manage",
			action: "bogus",
			scope: "project",
			name: "renamed",
			previousName: "victim",
			host: { host: "renamed.example.com" },
		} as unknown as LocalSshSettingsCommand;

		const response = await service.execute(projectCwd, malformed);

		expect(response.success).toBe(false);
		expect(await readJson(projectPath)).toEqual(original);
	});

	it("serializes concurrent host creation without dropping either update", async () => {
		const projectCwd = await tempDir();
		const home = await tempDir();
		const projectPath = path.join(projectCwd, ".omp", "ssh.json");
		await writeJson(projectPath, { hosts: {} });
		const service = new LocalSshSettingsService({
			home,
			isOpenSshAvailable: () => Promise.resolve(true),
			resolveRuntime: vi.fn(),
		});

		const responses = await Promise.all([
			service.execute(projectCwd, {
				type: "ssh_manage",
				action: "create",
				scope: "project",
				name: "alpha",
				host: { host: "alpha.example.com" },
			}),
			service.execute(projectCwd, {
				type: "ssh_manage",
				action: "create",
				scope: "project",
				name: "beta",
				host: { host: "beta.example.com" },
			}),
		]);

		expect(responses.every(response => response.success)).toBe(true);
		expect(await readJson(projectPath)).toEqual({
			hosts: {
				alpha: { host: "alpha.example.com" },
				beta: { host: "beta.example.com" },
			},
		});
	});

	it("moves an updated host between scopes without leaving the previous entry", async () => {
		const projectCwd = await tempDir();
		const home = await tempDir();
		const projectPath = path.join(projectCwd, ".omp", "ssh.json");
		const userPath = path.join(home, ".omp", "agent", "ssh.json");
		await writeJson(projectPath, {
			hosts: {
				grill: { host: "old.example.com", username: "dannyb" },
				keep: { host: "keep.example.com" },
			},
		});
		await writeJson(userPath, { hosts: { backup: { host: "backup.example.com" } } });
		const service = new LocalSshSettingsService({
			home,
			isOpenSshAvailable: () => Promise.resolve(true),
			resolveRuntime: vi.fn(),
		});

		const response = await service.execute(projectCwd, {
			id: "manage-1",
			type: "ssh_manage",
			action: "update",
			scope: "user",
			name: "smoker",
			previousName: "grill",
			previousScope: "project",
			host: { host: "smoker.example.com", username: "chef", port: 2222 },
		});

		expect(response.success).toBe(true);
		expect(await readJson(projectPath)).toEqual({ hosts: { keep: { host: "keep.example.com" } } });
		expect(await readJson(userPath)).toEqual({
			hosts: {
				backup: { host: "backup.example.com" },
				smoker: { host: "smoker.example.com", username: "chef", port: 2222 },
			},
		});
	});

	it("rolls back the destination when a cross-scope move cannot remove the source", async () => {
		const projectCwd = await tempDir();
		const home = await tempDir();
		const projectPath = path.join(projectCwd, ".omp", "ssh.json");
		const userPath = path.join(home, ".omp", "agent", "ssh.json");
		const projectConfig = { hosts: { grill: { host: "old.example.com" } } };
		const userConfig = { hosts: { backup: { host: "backup.example.com" } } };
		await writeJson(projectPath, projectConfig);
		await writeJson(userPath, userConfig);
		const service = new LocalSshSettingsService({
			home,
			isOpenSshAvailable: () => Promise.resolve(true),
			resolveRuntime: vi.fn(),
			writeConfig: async (filePath, config) => {
				if (filePath === projectPath) throw new Error("read-only project config");
				await writeJson(filePath, config);
			},
		});

		const response = await service.execute(projectCwd, {
			type: "ssh_manage",
			action: "update",
			scope: "user",
			name: "smoker",
			previousName: "grill",
			previousScope: "project",
			host: { host: "smoker.example.com" },
		});

		expect(response.success).toBe(false);
		expect(await readJson(projectPath)).toEqual(projectConfig);
		expect(await readJson(userPath)).toEqual(userConfig);
	});

	it("deletes only the selected managed host", async () => {
		const projectCwd = await tempDir();
		const home = await tempDir();
		const projectPath = path.join(projectCwd, ".omp", "ssh.json");
		await writeJson(projectPath, {
			hosts: {
				grill: { host: "grill.controls.dberlin.org" },
				keep: { host: "keep.example.com" },
			},
		});
		const service = new LocalSshSettingsService({
			home,
			isOpenSshAvailable: () => Promise.resolve(true),
			resolveRuntime: vi.fn(),
		});

		const response = await service.execute(projectCwd, {
			id: "manage-2",
			type: "ssh_manage",
			action: "delete",
			scope: "project",
			name: "grill",
		});

		expect(response.success).toBe(true);
		expect(await readJson(projectPath)).toEqual({ hosts: { keep: { host: "keep.example.com" } } });
	});

	it("probes a host only for an explicit connection test", async () => {
		const projectCwd = await tempDir();
		const home = await tempDir();
		const resolveRuntime = vi.fn(async target => ({
			ok: true as const,
			target,
			runtime: {
				home: "/home/dannyb",
				platform: "linux" as const,
				shell: "zsh",
				executable: "/home/dannyb/.bun/bin/omp",
				runtimePath: ["/home/dannyb/.bun/bin"],
			},
		}));
		const service = new LocalSshSettingsService({
			home,
			isOpenSshAvailable: () => Promise.resolve(true),
			resolveRuntime,
		});

		const response = await service.execute(projectCwd, {
			id: "test-1",
			type: "ssh_test",
			host: {
				name: "grill",
				host: "grill.controls.dberlin.org",
				username: "dannyb",
				port: 22,
			},
		});

		expect(response.success).toBe(true);
		if (!response.success) throw new Error(response.error);
		expect(response.data as RpcSshTestResult).toEqual(
			expect.objectContaining({
				name: "grill",
				ok: true,
				os: "linux",
				shell: "zsh",
			}),
		);
		expect(resolveRuntime).toHaveBeenCalledOnce();
		expect(resolveRuntime).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "ssh",
				hostAlias: "grill",
				host: expect.objectContaining({
					host: "grill.controls.dberlin.org",
					username: "dannyb",
					port: 22,
				}),
			}),
		);
	});
});
