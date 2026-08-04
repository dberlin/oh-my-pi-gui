/**
 * Connects to the omp daemon broker via Unix socket.
 * Reads token from broker.token, speaks JSON-line protocol.
 * Optional — GUI works without it.
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const CONNECT_TIMEOUT_MS = 3000;
const REQUEST_TIMEOUT_MS = 10_000;

type BrokerOperation = "list" | "logs" | "send" | "stop" | "describe";

interface BrokerRequest {
	id: number;
	auth: string;
	operation: BrokerOperation;
	[key: string]: unknown;
}

interface PendingBrokerRequest {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class BrokerClient {
	#socket: Socket | null = null;
	#token = "";
	#nextId = 0;
	#pending = new Map<number, PendingBrokerRequest>();
	#buffer = "";
	#connected = false;

	get connected(): boolean {
		return this.#connected;
	}

	/**
	 * Connect to the broker for a given project directory.
	 * Resolves the daemon hash directory and reads the token.
	 */
	async connect(projectDir: string): Promise<boolean> {
		try {
			const daemonDir = join(homedir(), ".omp", "daemon");
			const hash = createHash("sha256").update(projectDir).digest("hex").slice(0, 16);

			// Try to find the matching daemon directory
			let sockPath: string | null = null;
			let tokenPath: string | null = null;

			try {
				const entries = await readdir(daemonDir);
				const match = entries.find(e => e.startsWith(hash));
				if (match) {
					sockPath = join(daemonDir, match, "broker.sock");
					tokenPath = join(daemonDir, match, "broker.token");
				}
			} catch {
				return false;
			}

			if (!sockPath || !tokenPath) return false;

			// Read auth token
			try {
				this.#token = (await readFile(tokenPath, "utf-8")).trim();
			} catch {
				return false;
			}

			// Connect to Unix socket
			const { promise, resolve, reject } = Promise.withResolvers<boolean>();

			const socket = createConnection({ path: sockPath }, () => {
				this.#connected = true;
				resolve(true);
			});

			socket.setEncoding("utf-8");
			socket.setTimeout(CONNECT_TIMEOUT_MS);

			socket.on("data", (chunk: string) => {
				this.#onData(chunk);
			});

			socket.on("close", () => {
				this.#connected = false;
				this.#rejectAll("Broker connection closed");
			});

			socket.on("error", err => {
				if (!this.#connected) {
					reject(err);
				}
				this.#connected = false;
			});

			socket.on("timeout", () => {
				socket.destroy();
				reject(new Error("Broker connection timeout"));
			});

			this.#socket = socket;
			return await promise;
		} catch {
			return false;
		}
	}

	/**
	 * Send a request to the broker.
	 */
	async request(operation: BrokerOperation, extra?: Record<string, unknown>): Promise<unknown> {
		if (!this.#socket || !this.#connected) {
			throw new Error("Not connected to broker");
		}

		const id = ++this.#nextId;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();

		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`Broker request timeout: ${operation}`));
		}, REQUEST_TIMEOUT_MS);

		this.#pending.set(id, { resolve, reject, timer });

		const msg: BrokerRequest = {
			id,
			auth: this.#token,
			operation,
			...extra,
		};

		this.#socket.write(`${JSON.stringify(msg)}\n`);
		return promise;
	}

	disconnect(): void {
		this.#rejectAll("Client disconnecting");
		this.#socket?.destroy();
		this.#socket = null;
		this.#connected = false;
	}

	#onData(chunk: string): void {
		this.#buffer += chunk;
		const lines = this.#buffer.split("\n");
		this.#buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line) as { id?: number; error?: string; [key: string]: unknown };
				if (msg.id != null) {
					const pending = this.#pending.get(msg.id);
					if (pending) {
						clearTimeout(pending.timer);
						this.#pending.delete(msg.id);
						if (msg.error) {
							pending.reject(new Error(msg.error));
						} else {
							pending.resolve(msg);
						}
					}
				}
			} catch {
				// Skip malformed lines
			}
		}
	}

	#rejectAll(reason: string): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}
		this.#pending.clear();
	}
}
