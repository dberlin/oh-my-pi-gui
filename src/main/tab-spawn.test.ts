import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, it, type Mock, vi } from "vitest";
import type { IpcSpawnTabPayload, IpcSpawnTabResult, SessionKind, SshSessionTarget } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse, SidecarStatus } from "../shared/rpc-types";
import { RpcClient } from "./rpc-client";
import { RemoteResumeGrantRegistry } from "./remote-ipc";
import type { SidecarManager } from "./sidecar";
import { type SidecarAcquireOptions, SidecarPool } from "./sidecar-pool";
import { type SpawnTabDeps, spawnTabForWindow } from "./tab-spawn";

/** Minimal BrowserWindow stand-in (only the identity fields the guard touches). */
function fakeWindow(id = 1): BrowserWindow {
	const events = new EventEmitter();
	return {
		webContents: { id, send: () => {} },
		isDestroyed: () => false,
		once: events.once.bind(events),
		removeListener: events.removeListener.bind(events),
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
	acquire: Mock<(options: SidecarAcquireOptions) => SidecarManager>;
	kindFor: Mock<(path: string) => Promise<SessionKind>>;
	authorizeRemoteTarget: Mock<RemoteSpawnAuthorizer>;
	authorizeRemoteResume: Mock<RemoteResumeAuthorizer>;
	sessionOwner: Mock<() => { tabId: string; winId: number } | null>;
}

function harness(options: { atCap?: boolean } = {}): Harness {
	const sidecars = new Map<string, SidecarManager>();
	const acquire = vi.fn((args: SidecarAcquireOptions) => {
		const client = new RpcClient(frame => {
			const command = frame as RpcCommand;
			queueMicrotask(() =>
				client.onResponse({
					type: "response",
					command: command.type,
					id: command.id,
					success: true,
					data:
						command.type === "get_state"
							? {
									sessionId: args.resumeSessionId ?? "saved",
									sessionFile: args.restoreSessionPath ?? args.sessionPath ?? null,
									model: { provider: "openai", id: "current" },
								}
							: { cancelled: false },
				}),
			);
		});
		const sidecar = Object.assign(new EventEmitter(), {
			status: "ready",
			rpcClient: client,
		}) as unknown as SidecarManager;
		if (args.tabId) sidecars.set(args.tabId, sidecar);
		return sidecar;
	});
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
				waitForSessionRestore: async () => {},
				finishSessionRestore: () => true,
				releaseTab: () => true,
				sidecarForTab: (_win: BrowserWindow, id: string) => sidecars.get(id) ?? null,
				noteSessionFile: () => {},
				beginSessionRestoreRequest: () => new AbortController().signal,
				finishSessionRestoreRequest: () => {},
				cancelSessionRestoreRequest: () => true,
				tabsForWindow: () => [],
				beginSessionRestore: async () => null,
				failSessionRestore: async () => false,
			} as SpawnTabDeps["sidecarPool"],
			sessionIndex: { kindFor },
			fallbackCwd: () => "/fallback",
			defaultWorkspace: () => "/default-workspace",
			authorizeRemoteTarget,
			authorizeRemoteResume,
			prepareModelOrigin: async () => ({ check: async () => true }),
			watchModelOrigin: () => () => {},
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
		expect(acquire).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/fallback",
				win: expect.anything(),
				tabId: expect.any(String),
				sessionPath: undefined,
				restoreSessionPath: "/s/chat.jsonl",
				restoringSession: true,
				resumeSessionId: undefined,
				kind: "chat",
				worktree: undefined,
				fresh: true,
				target: undefined,
			}),
		);
	});

	it("acquires with the requested kind when it matches the file", async () => {
		const { deps, acquire, kindFor } = harness();
		kindFor.mockResolvedValue("chat");
		const result = await spawnTabForWindow(deps, fakeWindow(), { sessionPath: "/s/chat.jsonl", kind: "chat" });

		expect(result?.tabId).toEqual(expect.any(String));
		expect(acquire).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/fallback",
				win: expect.anything(),
				tabId: expect.any(String),
				sessionPath: undefined,
				restoreSessionPath: "/s/chat.jsonl",
				restoringSession: true,
				resumeSessionId: undefined,
				kind: "chat",
				worktree: undefined,
				fresh: true,
				target: undefined,
			}),
		);
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
		expect(acquire).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/work",
				win: expect.anything(),
				tabId: expect.any(String),
				sessionPath: undefined,
				resumeSessionId: undefined,
				kind: "agent",
				worktree: undefined,
				fresh: true,
				target: undefined,
			}),
		);
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
		expect(acquire).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: "/wt/gui-fix-login-deadbeef",
				win: expect.anything(),
				tabId: expect.any(String),
				sessionPath: undefined,
				resumeSessionId: undefined,
				kind: "agent",
				worktree,
				fresh: true,
				target: undefined,
			}),
		);
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
		expect(acquire).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: target.cwd,
				win,
				tabId: result?.tabId,
				sessionPath: undefined,
				resumeSessionId: "remote-session-7",
				kind: "agent",
				worktree: undefined,
				fresh: false,
				restoringSession: true,
				target,
			}),
		);
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

describe("saved-session background restore transaction", () => {
	function nativeHarness(reply: (command: RpcCommand) => Promise<RpcResponse> | RpcResponse) {
		const { deps, acquire } = harness();
		const requests: RpcCommand[] = [];
		const released: string[] = [];
		let committed = false;
		let isOriginCurrent = true;
		const client = new RpcClient(frame => {
			const command = frame as RpcCommand;
			requests.push(command);
			void Promise.resolve(reply(command)).then(response => client.onResponse({ ...response, id: command.id }));
		});
		const sidecar = Object.assign(new EventEmitter(), { status: "ready", rpcClient: client });
		acquire.mockReturnValue(sidecar as unknown as SidecarManager);
		Object.assign(deps.sidecarPool, {
			waitForSessionRestore: async () => {},
			sidecarForTab: () => sidecar,
			releaseTab: (id: string) => {
				released.push(id);
				return true;
			},
			finishSessionRestore: () => {
				committed = true;
				return true;
			},
			noteSessionFile: () => {},
		});
		Object.assign(deps, {
			prepareModelOrigin: async (_payload: IpcSpawnTabPayload) => ({ check: async () => isOriginCurrent }),
		});
		return {
			deps,
			acquire,
			requests,
			released,
			isCommitted: () => committed,
			retireOrigin: () => {
				isOriginCurrent = false;
			},
		};
	}

	it("restores native target history in a fresh background sidecar before returning a focusable tab", async () => {
		const switched = Promise.withResolvers<RpcResponse>();
		const sent = Promise.withResolvers<void>();
		const h = nativeHarness(command => {
			if (command.type === "switch_session") {
				sent.resolve();
				return switched.promise;
			}
			return {
				type: "response",
				command: command.type,
				success: true,
				data: {
					sessionId: "saved",
					sessionFile: "/sessions/saved.jsonl",
					model: { provider: "openai", id: "current" },
				},
			};
		});
		const opening = spawnTabForWindow(h.deps, fakeWindow(), { cwd: "/saved", sessionPath: "/sessions/saved.jsonl" });
		expect(await Promise.race([sent.promise.then(() => true), opening.then(() => false)])).toBe(true);
		expect(h.isCommitted()).toBe(false);
		expect(h.acquire).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionPath: undefined,
				restoreSessionPath: "/sessions/saved.jsonl",
				fresh: true,
				restoringSession: true,
			}),
		);
		switched.resolve({ type: "response", command: "switch_session", success: true, data: { cancelled: false } });
		expect((await opening)?.tabId).toEqual(expect.any(String));
		expect(h.isCommitted()).toBe(true);
		expect(h.released).toEqual([]);
	});

	it("returns a real missing-model refusal and releases the temporary sidecar without committing it", async () => {
		const h = nativeHarness(command => ({
			type: "response",
			command: command.type,
			success: false,
			error: "Could not restore model removed/old",
		}));
		const result = await spawnTabForWindow(h.deps, fakeWindow(), {
			cwd: "/saved",
			sessionPath: "/sessions/saved.jsonl",
		});
		expect(result).toMatchObject({ tabId: null, refusal: "model-restore", missingModel: "removed/old" });
		expect(h.released).toEqual([result?.failedTabId]);
		expect(h.isCommitted()).toBe(false);
	});

	it("verifies the explicitly approved model instead of accepting an older server that ignores the override", async () => {
		const h = nativeHarness(command => ({
			type: "response",
			command: command.type,
			success: true,
			data:
				command.type === "get_state"
					? {
							sessionId: "saved",
							sessionFile: "/sessions/saved.jsonl",
							model: { provider: "openai", id: "different" },
						}
					: { cancelled: false },
		}));
		const result = await spawnTabForWindow(h.deps, fakeWindow(), {
			cwd: "/saved",
			sessionPath: "/sessions/saved.jsonl",
			model: { provider: "openai", modelId: "current" },
			modelOrigin: { tabId: "origin", sessionId: "working" },
		});
		expect(
			h.requests.some(
				command =>
					command.type === "switch_session" && command.provider === "openai" && command.modelId === "current",
			),
		).toBe(true);
		expect(result).toMatchObject({ tabId: null, refusal: "restore-failed" });
		expect(h.released).toEqual([result?.failedTabId]);
		expect(h.isCommitted()).toBe(false);
	});

	it("does not commit a successful restore whose working origin changed while the target was loading", async () => {
		const h = nativeHarness(command => {
			if (command.type === "switch_session") h.retireOrigin();
			return {
				type: "response",
				command: command.type,
				success: true,
				data:
					command.type === "get_state"
						? {
								sessionId: "saved",
								sessionFile: "/sessions/saved.jsonl",
								model: { provider: "openai", id: "current" },
							}
						: { cancelled: false },
			};
		});
		const result = await spawnTabForWindow(h.deps, fakeWindow(), {
			cwd: "/saved",
			sessionPath: "/sessions/saved.jsonl",
			model: { provider: "openai", modelId: "current" },
			modelOrigin: { tabId: "origin", sessionId: "working" },
		});
		expect(result).toMatchObject({ tabId: null, refusal: "restore-failed" });
		expect(h.released).toEqual([result?.failedTabId]);
		expect(h.isCommitted()).toBe(false);
	});
});

it("keeps extension-hook cancellation noncommitting and releases the fresh restore tab", async () => {
	const { deps, acquire } = harness();
	const released: string[] = [];
	const client = new RpcClient(frame => {
		const command = frame as RpcCommand;
		client.onResponse({
			type: "response",
			command: command.type,
			id: command.id,
			success: true,
			data: { cancelled: true },
		});
	});
	const sidecar = Object.assign(new EventEmitter(), {
		status: "ready",
		rpcClient: client,
	}) as unknown as SidecarManager;
	acquire.mockReturnValue(sidecar);
	Object.assign(deps.sidecarPool, {
		sidecarForTab: () => sidecar,
		releaseTab: (id: string) => {
			released.push(id);
			return true;
		},
	});
	const result = await spawnTabForWindow(deps, fakeWindow(), { cwd: "/saved", sessionPath: "/sessions/saved.jsonl" });
	expect(result).toMatchObject({ tabId: null, refusal: "restore-failed" });
	expect(released).toEqual([result?.failedTabId]);
});

it("refuses an SSH sidecar that ignored the authorized resume identity even when its model matches", async () => {
	const { deps } = harness();
	const sidecar = deps.sidecarPool;
	const target: SshSessionTarget = {
		type: "ssh",
		hostAlias: "dev-box",
		host: { host: "dev.example.test", sourceId: "test", sourceLevel: "project", os: "linux" },
		originCwd: "/srv/project",
		cwd: "/srv/project",
	};
	const requests: RpcCommand[] = [];
	const client = new RpcClient(frame => {
		const command = frame as RpcCommand;
		requests.push(command);
		client.onResponse({
			type: "response",
			command: command.type,
			id: command.id,
			success: true,
			data: { sessionId: "wrong-history", model: { provider: "openai", id: "current" } },
		});
	});
	const native = Object.assign(new EventEmitter(), {
		status: "ready",
		rpcClient: client,
	}) as unknown as SidecarManager;
	const released: string[] = [];
	Object.assign(sidecar, {
		acquire: () => native,
		sidecarForTab: () => native,
		releaseTab: (id: string) => {
			released.push(id);
			return true;
		},
	});
	const result = await spawnTabForWindow(deps, fakeWindow(), {
		target,
		cwd: target.cwd,
		resumeSessionId: "authorized-history",
		model: { provider: "openai", modelId: "current" },
		modelOrigin: { tabId: "origin", sessionId: "working" },
	});
	expect(result).toMatchObject({ tabId: null, refusal: "restore-failed" });
	expect(released).toEqual([result?.failedTabId]);
	expect(requests.map(command => command.type)).toEqual(["get_state"]);
});

it("holds one actual pool reservation across windows until native restore commits before owner routing", async () => {
	const switched = Promise.withResolvers<RpcResponse>();
	const started = Promise.withResolvers<void>();
	const sidecars: SidecarManager[] = [];
	const pool = new SidecarPool(options => {
		class NativeSidecar extends EventEmitter {
			status: SidecarStatus = "asleep";
			cwd = options.cwd;
			sessionFile: string | null = null;
			rpcClient = new RpcClient(frame => {
				const command = frame as RpcCommand;
				if (command.type === "switch_session") {
					started.resolve();
					void switched.promise.then(response => {
						this.sessionFile = command.sessionPath;
						this.emit("sessionInfoUpdate", { type: "session_info_update", sessionId: "saved" });
						this.rpcClient.onResponse({ ...response, id: command.id });
					});
				} else {
					this.rpcClient.onResponse({
						type: "response",
						command: command.type,
						id: command.id,
						success: true,
						data: { sessionId: "saved", sessionFile: this.sessionFile },
					});
				}
			});
			start() {
				this.status = "ready";
				this.emit("sessionInfoUpdate", { type: "session_info_update", sessionId: "fresh" });
				this.emit("status", { status: "ready", cwd: this.cwd });
			}
			restart() {
				this.start();
			}
			dispose() {
				this.removeAllListeners();
				return Promise.resolve();
			}
		}
		const sidecar = new NativeSidecar() as unknown as SidecarManager;
		sidecars.push(sidecar);
		return sidecar;
	});
	const { deps } = harness();
	deps.sidecarPool = pool;
	const firstWindow = fakeWindow(1);
	const secondWindow = fakeWindow(2);
	pool.acquire({ cwd: "/working", win: firstWindow, tabId: "working" });
	const first = spawnTabForWindow(deps, firstWindow, { cwd: "/saved", sessionPath: "/sessions/saved.jsonl" });
	await started.promise;
	let secondSettled = false;
	const second = spawnTabForWindow(deps, secondWindow, { cwd: "/saved", sessionPath: "/sessions/saved.jsonl" }).then(
		result => {
			secondSettled = true;
			return result;
		},
	);
	await Promise.resolve();
	expect(secondSettled).toBe(false);
	expect(sidecars).toHaveLength(2);
	expect(pool.tabsForWindow(firstWindow).map(tab => tab.tabId)).toEqual(["working"]);
	switched.resolve({ type: "response", command: "switch_session", success: true, data: { cancelled: false } });
	const firstResult = await first;
	expect(await second).toMatchObject({ tabId: null, refusal: "owned", ownerTabId: firstResult?.tabId, ownerWinId: 1 });
	expect(sidecars).toHaveLength(2);
	if (firstResult?.tabId) pool.releaseTab(firstResult.tabId);
	pool.releaseTab("working");
});
