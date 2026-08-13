import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Mock } from "vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SshSessionTarget } from "../shared/ipc-types";
import { RemoteAcpClient } from "./remote-acp";
import type { RemoteChildHandle, RemoteRuntimeInfo, RemoteSshService } from "./remote-ssh";

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params: Record<string, unknown>;
}

type RequestHandler = (request: JsonRpcRequest, child: FakeAcpChild) => void;
type ResolveRuntime = (
	target: SshSessionTarget,
	signal?: AbortSignal,
) => Promise<{ ok: true; target: SshSessionTarget; runtime: RemoteRuntimeInfo } | { ok: false; error: string }>;

interface TestHarness {
	client: RemoteAcpClient;
	child: FakeAcpChild;
	terminate: Mock<() => Promise<void>>;
	spawnAcp: Mock<() => RemoteChildHandle>;
}

const target: SshSessionTarget = {
	type: "ssh",
	hostAlias: "buildbox",
	host: {
		host: "build.example.com",
		username: "dev",
		sourceId: "ssh-config",
		sourceLevel: "user",
	},
	originCwd: "/home/dev",
	cwd: "/home/dev",
};
const finalAuthorization = (): SshSessionTarget => target;

const runtime: RemoteRuntimeInfo = {
	home: "/home/dev",
	platform: "linux",
	shell: "/bin/bash",
	executable: "/home/dev/.local/bin/omp",
	runtimePath: ["/home/dev/.local/bin", "/usr/bin"],
};

class FakeAcpChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly sent: JsonRpcRequest[] = [];
	#input = "";

	constructor(handler: RequestHandler) {
		super();
		this.stdin.setEncoding("utf8");
		this.stdin.on("data", (chunk: string) => {
			this.#input += chunk;
			for (;;) {
				const newline = this.#input.indexOf("\n");
				if (newline < 0) break;
				const line = this.#input.slice(0, newline);
				this.#input = this.#input.slice(newline + 1);
				const request = JSON.parse(line) as JsonRpcRequest;
				this.sent.push(request);
				queueMicrotask(() => handler(request, this));
			}
		});
	}

	respond(frame: Record<string, unknown>): void {
		this.stdout.write(`${JSON.stringify(frame)}\n`);
	}

	writeRaw(value: string): void {
		this.stdout.write(value);
	}

	disconnect(): void {
		this.stdout.end();
		this.stderr.end();
		this.emit("close", 1, null);
	}
}

function initializeResult(
	request: JsonRpcRequest,
	capabilities: Record<string, unknown> = { list: {} },
): Record<string, unknown> {
	return {
		jsonrpc: "2.0",
		id: request.id,
		result: {
			protocolVersion: 1,
			agentCapabilities: {
				sessionCapabilities: capabilities,
			},
		},
	};
}

function pageResult(
	request: JsonRpcRequest,
	sessions: Record<string, unknown>[],
	nextCursor?: string | null,
): Record<string, unknown> {
	return {
		jsonrpc: "2.0",
		id: request.id,
		result: {
			sessions,
			...(nextCursor === undefined ? {} : { nextCursor }),
		},
	};
}

function harness(
	handler: RequestHandler,
	options: {
		timeoutMs?: number;
		resolveRuntime?: ResolveRuntime;
	} = {},
): TestHarness {
	const child = new FakeAcpChild(handler);
	const terminate = vi.fn(async () => {
		child.stdout.end();
		child.stderr.end();
		child.emit("close", 0, null);
	});
	const handle: RemoteChildHandle = {
		child: child as unknown as ChildProcess,
		terminate,
	};
	const resolveRuntime = vi.fn(options.resolveRuntime ?? (async () => ({ ok: true as const, target, runtime })));
	const spawnAcp = vi.fn(() => handle);
	const ssh = { resolveRuntime, spawnAcp } as unknown as Pick<RemoteSshService, "resolveRuntime" | "spawnAcp">;
	return {
		client: new RemoteAcpClient(ssh, { timeoutMs: options.timeoutMs ?? 1_000 }),
		child,
		spawnAcp,
		terminate,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("RemoteAcpClient", () => {
	it("rejects a deleted target after runtime resolution without spawning an ACP child", async () => {
		let canonical: SshSessionTarget | null = target;
		const test = harness(
			(request, child) => {
				child.respond(request.method === "initialize" ? initializeResult(request) : pageResult(request, []));
			},
			{
				resolveRuntime: async () => {
					canonical = null;
					return { ok: true, target, runtime };
				},
			},
		);

		const result = await test.client.listSessions(target, () => canonical);

		expect(result).toEqual({ ok: false, error: "Stale or altered SSH target" });
		expect(test.spawnAcp).not.toHaveBeenCalled();
	});

	it("initializes with no client capabilities and lists every page sequentially", async () => {
		const test = harness((request, child) => {
			if (request.method === "initialize") {
				child.respond(initializeResult(request));
				return;
			}
			const cursor = request.params.cursor;
			if (cursor === undefined) {
				child.respond(
					pageResult(
						request,
						[
							{
								sessionId: "s-1",
								cwd: "/srv/app",
								title: "Fix build",
								updatedAt: "2026-08-11T15:00:00Z",
								_meta: { branch: "main" },
							},
						],
						"opaque:page/2",
					),
				);
				return;
			}
			child.respond(pageResult(request, [{ sessionId: "s-2", cwd: "/srv/other", title: "Review" }], null));
		});

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(test.child.sent.map(frame => frame.method)).toEqual(["initialize", "session/list", "session/list"]);
		expect(test.child.sent[0]).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: 1, clientCapabilities: {} },
		});
		expect(test.child.sent[1]?.params).toEqual({});
		expect(test.child.sent[2]?.params).toEqual({ cursor: "opaque:page/2" });
		expect(result).toEqual({
			ok: true,
			sessions: [
				{
					target: { ...target, originCwd: "/srv/app", cwd: "/srv/app" },
					sessionId: "s-1",
					cwd: "/srv/app",
					title: "Fix build",
					updatedAt: "2026-08-11T15:00:00Z",
					meta: { branch: "main" },
				},
				{
					target: { ...target, originCwd: "/srv/other", cwd: "/srv/other" },
					sessionId: "s-2",
					cwd: "/srv/other",
					title: "Review",
					updatedAt: null,
				},
			],
		});
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("returns unsupported without attempting session/list when the capability is absent", async () => {
		const test = harness((request, child) => child.respond(initializeResult(request, {})));

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({
			ok: false,
			unsupported: true,
			error: "Remote agent does not support session history",
		});
		expect(test.child.sent.map(frame => frame.method)).toEqual(["initialize"]);
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("maps missing optional session fields to null without synthesizing values", async () => {
		const test = harness((request, child) => {
			child.respond(
				request.method === "initialize"
					? initializeResult(request)
					: pageResult(request, [{ sessionId: "minimal", cwd: "/absolute" }]),
			);
		});

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({
			ok: true,
			sessions: [
				{
					target: { ...target, originCwd: "/absolute", cwd: "/absolute" },
					sessionId: "minimal",
					cwd: "/absolute",
					title: null,
					updatedAt: null,
				},
			],
		});
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it.each([
		["malformed JSON", (child: FakeAcpChild) => child.writeRaw("{not json}\n")],
		["an oversized frame", (child: FakeAcpChild) => child.writeRaw("x".repeat(1024 * 1024 + 1))],
	])("rejects %s and cleans up", async (_name, sendInvalid) => {
		const test = harness((_request, child) => sendInvalid(child));

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({ ok: false, error: expect.stringContaining("ACP") });
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("rejects a JSON-RPC response with a mismatched id", async () => {
		const test = harness((request, child) => child.respond({ ...initializeResult(request), id: request.id + 1 }));

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({ ok: false, error: "ACP response id did not match the request" });
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("validates JSON-RPC error envelopes and reports remote errors", async () => {
		const test = harness((request, child) => {
			child.respond({ jsonrpc: "2.0", id: request.id, error: { code: -32_000, message: "denied" } });
		});

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({ ok: false, error: "Remote ACP error -32000: denied" });
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("rejects cyclic pagination cursors", async () => {
		const test = harness((request, child) => {
			child.respond(
				request.method === "initialize" ? initializeResult(request) : pageResult(request, [], "same-cursor"),
			);
		});

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({ ok: false, error: "ACP session pagination cursor repeated" });
		expect(test.child.sent.map(frame => frame.method)).toEqual(["initialize", "session/list", "session/list"]);
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("rejects missing session ids and non-absolute remote working directories", async () => {
		let page = 0;
		const test = harness((request, child) => {
			if (request.method === "initialize") child.respond(initializeResult(request));
			else {
				page += 1;
				child.respond(
					pageResult(request, [page === 1 ? { cwd: "/srv/app" } : { sessionId: "s", cwd: "relative" }]),
				);
			}
		});

		const first = await test.client.listSessions(target, finalAuthorization);

		expect(first).toEqual({ ok: false, error: "ACP session is missing a valid sessionId" });
		expect(test.terminate).toHaveBeenCalledOnce();

		const secondTest = harness((request, child) => {
			child.respond(
				request.method === "initialize"
					? initializeResult(request)
					: pageResult(request, [{ sessionId: "s", cwd: "relative" }]),
			);
		});
		expect(await secondTest.client.listSessions(target, finalAuthorization)).toEqual({
			ok: false,
			error: "ACP session cwd must be absolute",
		});
		expect(secondTest.terminate).toHaveBeenCalledOnce();
	});
	it.each([
		["backslash UNC", String.raw`\\server\share\project`],
		["forward-slash UNC", "//server/share/project"],
	])("accepts a Windows %s cwd", async (_name, cwd) => {
		const windowsRuntime: RemoteRuntimeInfo = { ...runtime, platform: "windows" };
		const test = harness(
			(request, child) => {
				child.respond(
					request.method === "initialize"
						? initializeResult(request)
						: pageResult(request, [{ sessionId: "windows-session", cwd }]),
				);
			},
			{
				resolveRuntime: async () => ({ ok: true, target, runtime: windowsRuntime }),
			},
		);

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({
			ok: true,
			sessions: [
				{
					target: { ...target, originCwd: cwd, cwd },
					sessionId: "windows-session",
					cwd,
					title: null,
					updatedAt: null,
				},
			],
		});
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("accepts a double-slash absolute cwd when the remote platform is POSIX", async () => {
		const cwd = "//server/share/project";
		const test = harness((request, child) => {
			child.respond(
				request.method === "initialize"
					? initializeResult(request)
					: pageResult(request, [{ sessionId: "posix-session", cwd }]),
			);
		});

		expect(await test.client.listSessions(target, finalAuthorization)).toEqual({
			ok: true,
			sessions: [
				{
					target: { ...target, originCwd: cwd, cwd },
					sessionId: "posix-session",
					cwd,
					title: null,
					updatedAt: null,
				},
			],
		});
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it.each([
		["forward-slash missing share", "//server/"],
		["forward-slash empty share", "//server//"],
		["backslash missing share", "\\\\server\\"],
		["backslash empty share", "\\\\server\\\\"],
	])("rejects a Windows UNC cwd with a %s", async (_name, cwd) => {
		const windowsRuntime: RemoteRuntimeInfo = { ...runtime, platform: "windows" };
		const test = harness(
			(request, child) => {
				child.respond(
					request.method === "initialize"
						? initializeResult(request)
						: pageResult(request, [{ sessionId: "windows-session", cwd }]),
				);
			},
			{
				resolveRuntime: async () => ({ ok: true, target, runtime: windowsRuntime }),
			},
		);

		expect(await test.client.listSessions(target, finalAuthorization)).toEqual({
			ok: false,
			error: "ACP session cwd must be absolute",
		});
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("bounds pagination pages", async () => {
		const test = harness((request, child) => {
			child.respond(
				request.method === "initialize"
					? initializeResult(request)
					: pageResult(request, [], `cursor-${request.id}`),
			);
		});

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({ ok: false, error: "ACP session listing exceeded 100 pages" });
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("bounds the total number of returned sessions", async () => {
		const tooMany = Array.from({ length: 10_001 }, (_, index) => ({ sessionId: `s-${index}`, cwd: "/srv" }));
		const test = harness((request, child) => {
			child.respond(request.method === "initialize" ? initializeResult(request) : pageResult(request, tooMany));
		});

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({ ok: false, error: "ACP session listing exceeded 10000 sessions" });
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("returns an error and cleans up when the child disconnects", async () => {
		const test = harness((_request, child) => child.disconnect());

		const result = await test.client.listSessions(target, finalAuthorization);

		expect(result).toEqual({ ok: false, error: "ACP process disconnected" });
		expect(test.terminate).toHaveBeenCalledOnce();
	});

	it("uses one timeout across runtime resolution and every ACP page", async () => {
		vi.useFakeTimers();
		const test = harness(
			(request, child) => {
				setTimeout(() => {
					child.respond(
						request.method === "initialize" ? initializeResult(request) : pageResult(request, [], "another-page"),
					);
				}, 15);
			},
			{
				timeoutMs: 50,
				resolveRuntime: async () => {
					const deferred = Promise.withResolvers<{
						ok: true;
						target: SshSessionTarget;
						runtime: RemoteRuntimeInfo;
					}>();
					setTimeout(() => deferred.resolve({ ok: true, target, runtime }), 30);
					return deferred.promise;
				},
			},
		);

		const pending = test.client.listSessions(target, finalAuthorization);
		await vi.advanceTimersByTimeAsync(50);
		const result = await pending;

		expect(result).toEqual({ ok: false, error: "Remote history request timed out" });
		expect(test.terminate).toHaveBeenCalledOnce();
	});
});
