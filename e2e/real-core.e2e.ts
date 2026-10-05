import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { RpcSessionState } from "../src/shared/rpc-types";

test("real vanilla bundled sidecar persists settings and sessions, serves stats, and reports unsupported commands", async () => {
	test.setTimeout(180_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-real-core-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const home = path.join(profile, "home");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(home)]);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			launchProfiles: {
				[project]: { noExtensions: true, noSkills: true, noRules: true },
			},
		}),
	);
	await fs.writeFile(path.join(project, "README.md"), "# Local ARM audit\n");
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: ".omp",
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_BUNDLED_OMP: path.resolve("resources/omp"),
	};
	// An accidental prompt must not spend real credentials or read the user's
	// auth/SSH catalogs. This smoke exercises local commands, never inference.
	for (const name of Object.keys(env)) {
		if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) Reflect.deleteProperty(env, name);
	}
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	Reflect.deleteProperty(env, "OMP_SIDECAR");
	const executablePath = process.env.OMP_GUI_TEST_APP;
	if (executablePath) Reflect.deleteProperty(env, "OMP_BUNDLED_OMP");
	const app = await electron.launch({
		...(executablePath ? { executablePath } : {}),
		args: [...(executablePath ? [] : [path.resolve("out/main/index.js")]), project, `--user-data-dir=${desktop}`],
		env,
	});
	const mainOutput: string[] = [];
	app.process().stdout?.on("data", (chunk: Buffer) => mainOutput.push(chunk.toString()));
	app.process().stderr?.on("data", (chunk: Buffer) => mainOutput.push(chunk.toString()));
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	const closeWelcomeIfPresent = async (title: string, closeLabel: string) => {
		const welcome = page.getByRole("dialog", { name: title, exact: true });
		if ((await welcome.count()) === 0) return;
		await expect(welcome).toBeVisible();
		await welcome.getByRole("button", { name: closeLabel, exact: true }).click();
		await expect(welcome).toHaveCount(0);
	};
	try {
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const runtime = await app.evaluate(({ app }) => ({
			isPackaged: app.isPackaged,
			appPath: app.getAppPath(),
			executable: process.execPath,
			resourcesPath: process.resourcesPath,
			pid: process.pid,
			sidecarMode: process.env.OMP_SIDECAR ?? null,
			sidecarOverride: process.env.OMP_BUNDLED_OMP ?? null,
		}));
		if (executablePath) {
			expect(runtime.isPackaged).toBe(true);
			expect(runtime.sidecarOverride).toBeNull();
		}
		await fs.writeFile("test-results/runtime-selection.json", JSON.stringify(runtime, null, 2));
		const evidence = await page.evaluate(
			async exportPath => {
				const rpc = window.omp.rpc;
				// A boot session's allocated path need not exist yet: bash-only
				// history is lazy-persisted. new_session materializes its header.
				const created = await rpc.newSession();
				if (!created.success) throw new Error(created.error);
				if (
					created.data &&
					typeof created.data === "object" &&
					"cancelled" in created.data &&
					created.data.cancelled === true
				) {
					throw new Error("Audit session creation cancelled");
				}
				const before = await rpc.getState();
				const settings = await rpc.getSettings();
				const schema = await rpc.getSettingsSchema();
				const changed = await rpc.setSetting("compaction.enabled", false);
				const persistedSettings = await rpc.getSettings(["compaction.enabled"]);
				const shell = await rpc.bash("printf 'arm audit ok'");
				const saved = await rpc.getState();
				const sessionPath = saved.success && (saved.data as RpcSessionState).sessionFile;
				if (!sessionPath) throw new Error("Audit session has no restorable path");
				const savedTranscript = await rpc.getMessages();
				const fresh = await rpc.newSession();
				const freshState = await rpc.getState();
				const restored = await rpc.switchSession(sessionPath);
				const restoredState = await rpc.getState();
				const transcript = await rpc.getMessages();
				const sessionStats = await rpc.getSessionStats();
				const exported = await rpc.exportHtml(exportPath);
				return {
					created,
					before,
					settings,
					schema,
					changed,
					persistedSettings,
					shell,
					saved,
					savedTranscript,
					fresh,
					freshState,
					restored,
					restoredState,
					transcript,
					sessionStats,
					exported,
				};
			},
			path.join(profile, "audit-export.html"),
		);
		for (const response of Object.values(evidence)) expect(response.success, JSON.stringify(response)).toBe(true);
		expect(evidence.settings.data).toMatchObject({ values: { "compaction.enabled": true } });
		expect(evidence.schema.data).toMatchObject({
			entries: expect.arrayContaining([expect.objectContaining({ path: "compaction.enabled", type: "boolean" })]),
		});
		expect(evidence.changed.data).toMatchObject({ path: "compaction.enabled", value: false });
		expect(evidence.persistedSettings.data).toMatchObject({ values: { "compaction.enabled": false } });
		// The config CLI persists out of process; the live sidecar reloads through a debounced file watcher.
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getState()), { timeout: 30_000 })
			.toMatchObject({ success: true, data: { autoCompactionEnabled: false } });
		const effective = await page.evaluate(() => window.omp.rpc.getState());
		expect(effective).toMatchObject({ success: true, data: { autoCompactionEnabled: false } });
		expect(evidence.shell.data).toMatchObject({ output: "arm audit ok", exitCode: 0, cancelled: false });
		expect(evidence.created.data).toMatchObject({ cancelled: false });
		const original = evidence.saved.data as RpcSessionState;
		expect(evidence.fresh.data).toMatchObject({ cancelled: false });
		expect((evidence.freshState.data as RpcSessionState).sessionId).not.toBe(
			(evidence.saved.data as RpcSessionState).sessionId,
		);
		expect(evidence.restored.data).toMatchObject({ cancelled: false });
		expect(evidence.restoredState.data).toMatchObject({
			sessionId: (evidence.saved.data as RpcSessionState).sessionId,
			sessionFile: (evidence.saved.data as RpcSessionState).sessionFile,
		});
		expect((evidence.saved.data as RpcSessionState).messageCount).toBeGreaterThan(0);
		// A missing-path switch may succeed by creating an empty session at the
		// requested path. Prove a real load, not merely a successful switch ACK.
		expect(evidence.transcript.data).toEqual(evidence.savedTranscript.data);
		const persistedSession = await fs.readFile(original.sessionFile!, "utf8");
		expect(
			persistedSession
				.trim()
				.split("\n")
				.map(line => JSON.parse(line)),
		).toContainEqual(expect.objectContaining({ type: "session", id: original.sessionId }));
		expect(persistedSession).toContain("arm audit ok");
		expect(evidence.sessionStats.data).toMatchObject({
			sessionId: (evidence.saved.data as RpcSessionState).sessionId,
			totalMessages: (evidence.saved.data as RpcSessionState).messageCount,
		});
		const unsupported = await page.evaluate(async () => {
			return {
				get_git_changes: await window.omp.rpc.getGitChanges().then(
					response => ({ kind: "response" as const, response }),
					error => ({ kind: "rejection" as const, error: error instanceof Error ? error.message : String(error) }),
				),
				get_jobs: await window.omp.rpc.getJobs().then(
					response => ({ kind: "response" as const, response }),
					error => ({ kind: "rejection" as const, error: error instanceof Error ? error.message : String(error) }),
				),
			};
		});
		for (const [command, result] of Object.entries(unsupported)) {
			if (result.kind === "response") {
				expect(result.response).toMatchObject({ command, success: false });
				if (result.response.success) throw new Error(`${command} unexpectedly succeeded`);
				expect(result.response.error).toContain(`Unknown command: ${command}`);
			} else {
				expect(result.error).toContain(`Unknown command: ${command}`);
			}
		}
		await fs.writeFile(
			"test-results/real-core-contract.json",
			JSON.stringify({ ...evidence, effective, unsupported }, null, 2),
		);
		expect(JSON.stringify(evidence.transcript.data)).toContain("arm audit ok");
		expect(evidence.exported.data).toMatchObject({ path: path.join(profile, "audit-export.html") });
		const exportWindow = app.waitForEvent("window");
		await app.evaluate(
			({ BrowserWindow }, url) => {
				const win = new BrowserWindow({ width: 1100, height: 800 });
				void win.loadURL(url);
			},
			pathToFileURL(path.join(profile, "audit-export.html")).href,
		);
		const exportPage = await exportWindow;
		await expect(exportPage.locator("#messages")).toContainText("arm audit ok");
		await exportPage.screenshot({ path: "test-results/exported-session.png", scale: "css", animations: "disabled" });
		await exportPage.close();
		await page.reload();
		await expect(page.locator("[data-transcript-kind]")).toContainText(["arm audit ok"]);
		await expect(page.getByText("The originating session was replaced or closed.", { exact: false })).toHaveCount(0);
		await page.screenshot({ path: "test-results/04-real-core.png", scale: "css", animations: "disabled" });
		await closeWelcomeIfPresent("Welcome to omp", "Close");
		await page.locator("textarea").first().fill("/queue");
		await page.getByRole("button", { name: "Send (Enter)", exact: true }).click();
		await expect(page.locator("textarea").first()).toHaveValue("-> ");
		const fastOff = await page.evaluate(() => window.omp.rpc.prompt("/fast off"));
		expect(fastOff).toMatchObject({ success: true, data: { agentInvoked: false } });
		expect(await page.evaluate(() => window.omp.rpc.getState())).toMatchObject({
			success: true,
			data: { sessionId: original.sessionId, fastModeEnabled: false, isStreaming: false },
		});
		await page.locator("textarea").first().fill("/new");
		await page.getByRole("button", { name: "Send (Enter)", exact: true }).click();
		await expect
			.poll(async () => {
				const state = await page.evaluate(() => window.omp.rpc.getState());
				return state.success ? (state.data as RpcSessionState).sessionId : original.sessionId;
			})
			.not.toBe(original.sessionId);
		await expect(page.getByText("The originating session was replaced or closed.", { exact: false })).toHaveCount(0);
		await page.evaluate(async sessionPath => {
			const result = await window.omp.rpc.switchSession(sessionPath);
			if (!result.success) throw new Error(result.error);
		}, original.sessionFile!);
		await page.reload();
		await expect(page.locator("[data-transcript-kind]")).toContainText(["arm audit ok"]);
		expect(await page.evaluate(() => window.omp.rpc.getState())).toMatchObject({
			success: true,
			data: {
				sessionId: original.sessionId,
				sessionFile: original.sessionFile,
				messageCount: original.messageCount,
			},
		});
		await expect(page.getByText("The originating session was replaced or closed.", { exact: false })).toHaveCount(0);
		await closeWelcomeIfPresent("Welcome to omp", "Close");
		await page.getByRole("button", { name: "Session stats", exact: true }).click();
		const stats = page.getByRole("dialog");
		await expect(stats).toBeVisible();
		await stats.getByRole("button", { name: "Sync", exact: true }).click();
		await expect(stats.getByRole("button", { name: "Sync", exact: true })).toBeEnabled();
		await expect(page.getByText("Sync failed", { exact: true })).toHaveCount(0);
		for (const label of [
			"Overview",
			"Models",
			"Providers",
			"Tools",
			"Costs",
			"Errors",
			"Frustration",
			"Gain",
			"Projects",
			"Requests",
		]) {
			await stats.locator("nav").getByRole("button", { name: label, exact: true }).click();
			await expect(stats.getByText("Loading stats…", { exact: true })).toHaveCount(0, { timeout: 30000 });
			await expect(stats).not.toContainText("Stats unavailable", { timeout: 15000 });
			await page.screenshot({ path: `test-results/stats-${label}.png`, scale: "css", animations: "disabled" });
		}
		await page.keyboard.press("Escape");
		await page.evaluate(async () => {
			await window.omp.prefs.set("language", "zh");
		});
		await page.reload();
		await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
		await closeWelcomeIfPresent("欢迎使用 omp", "关闭");
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await expect(page.getByRole("dialog")).toContainText("权限与安全");
		const settingsPages: Array<{ group: string; page: string; text: string }> = [];
		const groupCount = await page.getByRole("dialog").locator(".settings-nav-group-label").count();
		for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
			const settings = page.getByRole("dialog");
			const group = settings.locator(".settings-nav-group-label").nth(groupIndex);
			const groupName = await group.innerText();
			await group.click();
			const pages = settings.locator(".settings-nav-item");
			const count = await pages.count();
			for (let pageIndex = 0; pageIndex < count; pageIndex++) {
				const target = pages.nth(pageIndex);
				const pageName = await target.innerText();
				await target.click();
				await expect(settings.locator(".settings-content .animate-spin")).toHaveCount(0, { timeout: 30_000 });
				const content = settings.locator(".settings-content");
				await expect(content).not.toContainText("Something went wrong");
				settingsPages.push({ group: groupName, page: pageName, text: await content.innerText() });
				await page.screenshot({
					path: `test-results/settings-${groupIndex}-${pageIndex}.png`,
					scale: "css",
					animations: "disabled",
				});
			}
		}
		await fs.writeFile("test-results/settings-pages.json", JSON.stringify(settingsPages, null, 2));
		const settingsSearch = page.getByRole("dialog").getByPlaceholder("搜索设置和管理资源…");
		await settingsSearch.fill("bash.patterns");
		await page.getByRole("button", { name: /Bash 审批模式 bash.patterns/ }).click();
		const rules = page.locator('[title="bash.patterns"]').locator("..").locator("..");
		await expect(rules.locator("textarea")).toHaveValue("[]");
		const rule = { match: "echo audit-blocked", approval: "deny" };
		await rules.locator("textarea").fill(JSON.stringify([rule]));
		await rules.getByRole("button", { name: "应用", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["bash.patterns"])))
			.toMatchObject({ success: true, data: { values: { "bash.patterns": [rule] } } });
		await rules.locator("textarea").fill("[]");
		await rules.getByRole("button", { name: "应用", exact: true }).click();
		await expect
			.poll(() => page.evaluate(() => window.omp.rpc.getSettings(["bash.patterns"])))
			.toMatchObject({ success: true, data: { values: { "bash.patterns": [] } } });
		await page.getByRole("dialog").getByRole("button", { name: "外观与使用", exact: true }).click();
		await expect(page.getByRole("dialog")).toContainText("选择 GUI 主题");
		await page.screenshot({ path: "test-results/05-packaged-zh.png", scale: "css", animations: "disabled" });
		await page.keyboard.press("Escape");
		const backgrounds: string[] = [];
		for (const theme of ["瓷白", "石墨"]) {
			await page.getByRole("button", { name: "选择主题", exact: true }).click();
			const picker = page.getByRole("dialog", { name: "选择主题", exact: true });
			await picker.getByPlaceholder("搜索主题…").fill(theme);
			await picker.locator("button[aria-pressed]").filter({ hasText: theme }).click();
			await expect(picker).toHaveCount(0);
			backgrounds.push(
				await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary")),
			);
			await page.screenshot({
				path: `test-results/packaged-theme-${theme}.png`,
				scale: "css",
				animations: "disabled",
			});
		}
		expect(backgrounds[0]).not.toBe(backgrounds[1]);
		// Delay the real IPC boot snapshot while the user makes a newer choice.
		const bootPrefs = await page.evaluate(async () => {
			await window.omp.prefs.set("fontSize", 18);
			return window.omp.prefs.get();
		});
		await app.evaluate(({ ipcMain }, prefs) => {
			const pending = Promise.withResolvers<void>();
			Reflect.set(globalThis, "releaseAuditPrefs", pending.resolve);
			ipcMain.removeHandler("prefs:get");
			ipcMain.handle("prefs:get", async (_event, payload: { key?: string }) => {
				if (payload.key) return (prefs as Record<string, unknown>)[payload.key];
				Reflect.set(globalThis, "auditPrefsRequested", true);
				await pending.promise;
				return prefs;
			});
		}, bootPrefs);
		await page.reload();
		await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, "auditPrefsRequested"))).toBe(true);
		await expect(page.getByRole("button", { name: "选择主题", exact: true })).toBeVisible();
		await closeWelcomeIfPresent("欢迎使用 omp", "关闭");
		await page.getByRole("button", { name: "选择主题", exact: true }).click();
		const freshPicker = page.getByRole("dialog", { name: "选择主题", exact: true });
		await freshPicker.getByPlaceholder("搜索主题…").fill("瓷白");
		await freshPicker.locator("button[aria-pressed]").filter({ hasText: "瓷白" }).click();
		await expect(freshPicker).toHaveCount(0);
		const chosenBackground = await page.evaluate(() =>
			getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary"),
		);
		await page.getByRole("button", { name: "设置", exact: true }).click();
		await page.getByRole("dialog").getByRole("button", { name: "外观与使用", exact: true }).click();
		const font = page.locator('#setting-gui-fontSize input[type="number"]');
		const chosenFont = await font.inputValue();
		for (const value of [String(Number(chosenFont) + 1), chosenFont]) {
			await font.fill(value);
			await font.press("Enter");
			await expect
				.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--gui-font-size")))
				.toBe(`${value}px`);
		}
		await page.keyboard.press("Escape");
		await app.evaluate(() => Reflect.get(globalThis, "releaseAuditPrefs")());
		await page.evaluate(async () => {
			await window.omp.prefs.get();
			const { promise, resolve } = Promise.withResolvers<void>();
			requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			await promise;
		});
		expect(
			await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--omp-bg-primary")),
		).toBe(chosenBackground);
		expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--gui-font-size"))).toBe(
			`${chosenFont}px`,
		);
		expect(errors).toEqual([]);
	} finally {
		await fs.writeFile("test-results/main-process.log", mainOutput.join(""));
		// This scenario never starts an LLM run. Approve the idle quit normally
		// so production teardown drains the agent and stats subprocesses.
		await app.close();
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
});
