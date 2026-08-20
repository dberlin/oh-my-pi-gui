import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSpawnTabResult, SessionKind, SshSessionTarget } from "../shared/ipc-types";
import { RemoteResumeGrantRegistry } from "./remote-ipc";
import type { SidecarManager } from "./sidecar";
import type { SidecarPool } from "./sidecar-pool";
import { type SpawnTabDeps, spawnTabForWindow } from "./tab-spawn";

/** Minimal BrowserWindow stand-in (only the identity fields the guard touches). */
function fakeWindow(): BrowserWindow {
	return {
		webContents: { id: 1 },
		isDestroyed: () => false,
		once: () => new EventEmitter(),
	} as unknown as BrowserWindow;
}

type RemoteSpawnSink = (target: SshSessionTarget) => IpcSpawnTabResult | null;
type RemoteSpawnAuthorizer = (
	target: SshSessionTarget,
	cwd: unknown,
	sink: RemoteSpawnSink,
) => IpcSpawnTabResult | null;
type RemoteResumeAuthorizer = (target: SshSessionTarget, cwd: string, sessionId: string) => boolean;

interface Harness {
	deps: SpawnTabDeps;
	acquire: Mock<(...args: unknown[]) => SidecarManager>;
	kindFor: Mock<(path: string) => Promise<SessionKind>>;
	authorizeRemoteTarget: Mock<RemoteSpawnAuthorizer>;
	authorizeRemoteResume: Mock<RemoteResumeAuthorizer>;
	sessionOwner: Mock<() => { tabId: string; winId: number } | null>;
}

function harness(options: { atCap?: boolean } = {}): Harness {
	const acquire = vi.fn(() => ({}) as SidecarManager);
	const kindFor = vi.fn(async (_path: string): Promise<SessionKind> => "agent");
	const sessionOwner = vi.fn(() => null);
	const authorizeRemoteTarget = vi.fn(
		(target: SshSessionTarget, _cwd: unknown, sink: RemoteSpawnSink): IpcSpawnTabResult | null =>
			sink({ ...target, host: { ...target.host } }),
	);
	const authorizeRemoteResume = vi.fn((_target: SshSessionTarget, _cwd: string, _sessionId: string) => true);
	return {
		acquire,
		kindFor,
		sessionOwner,
		authorizeRemoteTarget,
		authorizeRemoteResume,
		deps: {
			sidecarPool: {
				sessionOwner,
				atCap: options.atCap ?? false,
				acquire,
			} as unknown as Pick<SidecarPool, "sessionOwner" | "atCap" | "acquire">,
			sessionIndex: { kindFor },
			fallbackCwd: () => "/fallback",
			defaultWorkspace: () => "/default-workspace",
			authorizeRemoteTarget,
			authorizeRemoteResume,
		},
	};
}

describe("spawnTabForWindow refusal contracts", () => {
	it("refuses an explicit chat payload against an agent file (I3: reject, never degrade)", async () => {
		const { deps, acquire, kindFor } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/agent.jsonl", kind: "chat" });

		expect(result).toEqual({ tabId: null, refusal: "kind-mismatch" });
		expect(acquire).not.toHaveBeenCalled();
		expect(kindFor).toHaveBeenCalledWith("/s/agent.jsonl");
	});

	it("refuses an explicit agent payload against a chat file", async () => {
		const { deps, acquire, kindFor } = harness();
		kindFor.mockResolvedValue("chat");
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/chat.jsonl", kind: "agent" });

		expect(result).toEqual({ tabId: null, refusal: "kind-mismatch" });
		expect(acquire).not.toHaveBeenCalled();
	});

	it("spawns with the file's kind when the payload omits it (file is authoritative)", async () => {
		const { deps, acquire, kindFor } = harness();
		kindFor.mockResolvedValue("chat");
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/chat.jsonl" });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenCalledWith({
			cwd: "/fallback",
			win: expect.anything(),
			tabId: expect.any(String),
			sessionPath: "/s/chat.jsonl",
			resumeSessionId: undefined,
			kind: "chat",
			worktree: undefined,
			fresh: false,
			target: undefined,
		});
	});

	it("acquires with the requested kind when it matches the file", async () => {
		const { deps, acquire, kindFor } = harness();
		kindFor.mockResolvedValue("chat");
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/chat.jsonl", kind: "chat" });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenCalledWith({
			cwd: "/fallback",
			win: expect.anything(),
			tabId: expect.any(String),
			sessionPath: "/s/chat.jsonl",
			resumeSessionId: undefined,
			kind: "chat",
			worktree: undefined,
			fresh: false,
			target: undefined,
		});
	});

	it("owner wins over kind resolution (F-OWN checked first, kindFor not consulted)", async () => {
		const { deps, acquire, kindFor, sessionOwner } = harness();
		sessionOwner.mockReturnValue({ tabId: "t-owner", winId: 7 });
		const result: IpcSpawnTabResult | null = await spawnTabForWindow(deps, fakeWindow(), {
			sessionPath: "/s/owned.jsonl",
			kind: "chat",
		});

		expect(result).toEqual({ tabId: null, ownerTabId: "t-owner", ownerWinId: 7, refusal: "owned" });
		expect(kindFor).not.toHaveBeenCalled();
		expect(acquire).not.toHaveBeenCalled();
	});

	it("returns null at the pool cap", async () => {
		const { deps, acquire } = harness({ atCap: true });
		const result = await spawnTabForWindow(deps, fakeWindow(), {});

		expect(result).toBeNull();
		expect(acquire).not.toHaveBeenCalled();
	});

	it("fresh tabs bypass auto-resume, spawn agent by default, and never consult kindFor", async () => {
		const { deps, acquire, kindFor } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { cwd: "/work" });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenCalledWith({
			cwd: "/work",
			win: expect.anything(),
			tabId: expect.any(String),
			sessionPath: undefined,
			resumeSessionId: undefined,
			kind: "agent",
			worktree: undefined,
			fresh: true,
			target: undefined,
		});
		expect(kindFor).not.toHaveBeenCalled();
	});

	it("spawns Work as a full agent in the GUI default workspace", async () => {
		const { deps, acquire, kindFor } = harness();
		const result = await spawnTabForWindow(deps, fakeWindow(), { defaultWorkspace: true });

		expect(result).toEqual({ tabId: expect.any(String), cwd: "/default-workspace" });
		expect(acquire).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/default-workspace",
				fresh: true,
				kind: "agent",
				sessionPath: undefined,
				target: undefined,
				worktree: undefined,
			}),
		);
		expect(kindFor).not.toHaveBeenCalled();
	});

	it("passes a worktree binding through to acquire (plan/20)", async () => {
		const { deps, acquire } = harness();
		const worktree = { name: "fix-login", branch: "omp/gui/fix-login", baseCwd: "/repo" };
		const result = await spawnTabForWindow(deps, fakeWindow(), { cwd: "/wt/gui-fix-login-deadbeef", worktree });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenCalledWith({
			cwd: "/wt/gui-fix-login-deadbeef",
			win: expect.anything(),
			tabId: expect.any(String),
			sessionPath: undefined,
			resumeSessionId: undefined,
			kind: "agent",
			worktree,
			fresh: true,
			target: undefined,
		});
	});
});

describe("spawnTabForWindow remote targets", () => {
	it("refuses an unauthorized remote target before pool acquisition", async () => {
		const { deps, acquire, authorizeRemoteTarget } = harness();
		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: "dev-box",
			host: {
				host: "attacker.example.test",
				sourceId: "renderer",
				sourceLevel: "project",
				os: "linux",
			},
			originCwd: "/srv/project",
			cwd: "/srv/project",
		};
		authorizeRemoteTarget.mockReturnValue(null);

		expect(
			await spawnTabForWindow(deps, fakeWindow(), {
				target,
				cwd: target.cwd,
				resumeSessionId: "must-not-launch",
			}),
		).toBeNull();
		expect(authorizeRemoteTarget).toHaveBeenCalledWith(target, target.cwd, expect.any(Function));
		expect(acquire).not.toHaveBeenCalled();
	});

	it("refuses an arbitrary remote resume id before pool acquisition", async () => {
		const { deps, acquire, authorizeRemoteResume } = harness();
		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: "dev-box",
			host: {
				host: "dev.example.test",
				sourceId: "test",
				sourceLevel: "project",
				os: "linux",
			},
			originCwd: "/srv/project",
			cwd: "/srv/project",
		};
		authorizeRemoteResume.mockReturnValue(false);

		expect(
			await spawnTabForWindow(deps, fakeWindow(), {
				target,
				cwd: target.cwd,
				resumeSessionId: "renderer-chosen-session",
			}),
		).toBeNull();
		expect(authorizeRemoteResume).toHaveBeenCalledWith(target, target.cwd, "renderer-chosen-session");
		expect(acquire).not.toHaveBeenCalled();
	});

	it("refuses a remote resume id paired with a local target instead of spawning a fresh local tab", async () => {
		const { deps, acquire, authorizeRemoteTarget, authorizeRemoteResume } = harness();

		expect(
			await spawnTabForWindow(deps, fakeWindow(), {
				target: { type: "local" },
				resumeSessionId: "remote-session-without-ssh-target",
			}),
		).toBeNull();
		expect(authorizeRemoteTarget).not.toHaveBeenCalled();
		expect(authorizeRemoteResume).not.toHaveBeenCalled();
		expect(acquire).not.toHaveBeenCalled();
	});

	it("uses an exact main-issued grant without consulting local ownership or SessionIndex", async () => {
		const { deps, acquire, authorizeRemoteTarget, authorizeRemoteResume, kindFor, sessionOwner } = harness();
		const win = fakeWindow();
		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: "dev-box",
			host: {
				host: "dev.example.test",
				sourceId: "test",
				sourceLevel: "project",
				os: "linux",
			},
			originCwd: "/srv/project",
			cwd: "/srv/project",
		};
		const grants = new RemoteResumeGrantRegistry();
		grants.record(win.webContents.id, target, target.cwd, "remote-session-7");
		authorizeRemoteResume.mockImplementation((candidate, cwd, sessionId) =>
			grants.allows(win.webContents.id, candidate, cwd, sessionId),
		);
		const result = await spawnTabForWindow(deps, win, {
			sessionPath: "/local/path/must-not-be-read.jsonl",
			cwd: target.cwd,
			resumeSessionId: "remote-session-7",
			target,
		});

		expect(result?.tabId).toEqual(expect.any(String));
		expect(sessionOwner).not.toHaveBeenCalled();
		expect(kindFor).not.toHaveBeenCalled();
		expect(authorizeRemoteTarget).toHaveBeenCalledWith(target, target.cwd, expect.any(Function));
		expect(authorizeRemoteResume).toHaveBeenCalledWith(target, target.cwd, "remote-session-7");
		expect(acquire).toHaveBeenCalledWith({
			cwd: target.cwd,
			win,
			tabId: result?.tabId,
			sessionPath: undefined,
			resumeSessionId: "remote-session-7",
			kind: "agent",
			worktree: undefined,
			fresh: false,
			target,
		});
	});

	it("uses the immutable target cwd when a plain SSH tab omits the redundant top-level cwd", async () => {
		const { deps, acquire, authorizeRemoteTarget, authorizeRemoteResume } = harness();
		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: "dev-box",
			host: {
				host: "dev.example.test",
				sourceId: "test",
				sourceLevel: "project",
				os: "linux",
			},
			originCwd: "/srv/project",
			cwd: "/srv/project",
		};

		const result = await spawnTabForWindow(deps, fakeWindow(), { target });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(authorizeRemoteTarget).toHaveBeenCalledWith(target, target.cwd, expect.any(Function));
		expect(authorizeRemoteResume).not.toHaveBeenCalled();
		expect(acquire).toHaveBeenCalledTimes(1);
	});

	it("acquires synchronously inside the final remote authorization call stack", async () => {
		const { deps, acquire, authorizeRemoteTarget, authorizeRemoteResume } = harness();
		const target: SshSessionTarget = {
			type: "ssh",
			hostAlias: "dev-box",
			host: {
				host: "dev.example.test",
				sourceId: "test",
				sourceLevel: "project",
				os: "linux",
			},
			originCwd: "/srv/project",
			cwd: "/srv/project",
		};
		let catalogReplaced = false;
		authorizeRemoteTarget.mockImplementation(
			(canonical: SshSessionTarget, _cwd: unknown, sink: RemoteSpawnSink): IpcSpawnTabResult | null => {
				queueMicrotask(() => {
					catalogReplaced = true;
				});
				const result = sink(canonical);
				expect(catalogReplaced).toBe(false);
				return result;
			},
		);

		const result = await spawnTabForWindow(deps, fakeWindow(), { target, cwd: target.cwd });
		expect(result?.tabId).toEqual(expect.any(String));
		expect(authorizeRemoteResume).not.toHaveBeenCalled();
		expect(acquire).toHaveBeenCalledTimes(1);
		expect(catalogReplaced).toBe(true);
	});
});
