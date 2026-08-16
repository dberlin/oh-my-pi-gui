import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createStatsOpenerShim, statsServerArgs, statsServerEnv, statsServerPort } from "./stats-server";

describe("statsServerArgs", () => {
	it("uses supported stats flags", () => {
		expect(statsServerArgs(3847)).toEqual(["stats", "--port", "3847"]);
	});
});

describe("statsServerEnv", () => {
	it("shadows the platform opener without hiding other PATH executables", () => {
		const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gui-stats-opener-test-"));
		try {
			const inheritedPath = process.env.PATH ?? "";
			const env = statsServerEnv({ ...process.env, PATH: inheritedPath }, createStatsOpenerShim(shimDir));
			const opener =
				process.platform === "win32" ? "powershell.exe" : process.platform === "darwin" ? "open" : "xdg-open";

			expect(env.PATH).toBe(`${shimDir}${path.delimiter}${inheritedPath}`);
			if (process.platform !== "win32") {
				const result = spawnSync(opener, ["https://example.invalid"], { env, encoding: "utf8" });
				expect(result.status).toBe(0);
				expect(result.stdout).toContain("OMP_GUI_NO_BROWSER");
			}
			const shell =
				process.platform === "win32"
					? spawnSync("cmd.exe", ["/c", "exit 0"], { env })
					: spawnSync("sh", ["-c", "exit 0"], { env });
			expect(shell.status).toBe(0);
		} finally {
			fs.rmSync(shimDir, { recursive: true, force: true });
		}
	});

	it("redirects the Windows absolute PowerShell opener without shadowing PATH PowerShell", () => {
		const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-gui-stats-windows-opener-test-"));
		try {
			const env = statsServerEnv(
				{
					PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
					SystemRoot: "C:\\Windows",
					SYSTEMROOT: "C:\\Windows",
				},
				createStatsOpenerShim(shimDir, "win32"),
				"win32",
			);

			expect(env.SystemRoot).toBe(shimDir);
			expect(env.SYSTEMROOT).toBe(shimDir);
			expect(env.PATH).toBe(`${shimDir};C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0`);
			expect(fs.existsSync(path.join(shimDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))).toBe(
				true,
			);
			expect(fs.existsSync(path.join(shimDir, "powershell.exe"))).toBe(false);
		} finally {
			fs.rmSync(shimDir, { recursive: true, force: true });
		}
	});
});

describe("statsServerPort", () => {
	it("accepts the IPv4 loopback URL emitted by the bundled stats command", () => {
		expect(statsServerPort("Dashboard available at: http://127.0.0.1:3847")).toBe(3847);
	});
});
