/**
 * Typed RPC client with id correlation and timeout.
 * Commands are serialized (queued) except bash which is fire-and-forget.
 */
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";

const DEFAULT_TIMEOUT_MS = 8_000;

interface PendingRequest {
	command: RpcCommand["type"];
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export class RpcClient {
	#pending = new Map<string, PendingRequest>();
	#nextId = 0;
	#send: (frame: object) => void;
	#timeout: number;

	constructor(send: (frame: object) => void, timeout = DEFAULT_TIMEOUT_MS) {
		this.#send = send;
		this.#timeout = timeout;
	}

	/** Send a command and await its correlated response. Optional per-call timeout. */
	async command(cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> {
		const id = `gui-${++this.#nextId}`;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		const timeout = timeoutMs ?? this.#timeout;

		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`RPC timeout (${timeout}ms): ${(cmd as { type: string }).type}`));
		}, timeout);

		this.#pending.set(id, { command: cmd.type, resolve, reject, timer });
		this.#send({ ...cmd, id });
		return promise;
	}

	/** Fire a command without waiting for response (for bash background dispatch). */
	fire(cmd: RpcCommand): string {
		const id = `gui-${++this.#nextId}`;
		this.#send({ ...cmd, id });
		return id;
	}

	/** Route an inbound response frame to its waiting promise. */
	onResponse(frame: RpcResponse): boolean {
		const id = frame.id;
		if (!id) {
			if (frame.success || frame.error !== `Unknown command: ${frame.command}`) return false;
			let handled = false;
			for (const [pendingId, entry] of this.#pending) {
				if (entry.command !== frame.command) continue;
				clearTimeout(entry.timer);
				this.#pending.delete(pendingId);
				entry.reject(
					new Error(
						`RPC command "${frame.command}" is not supported by the connected coding agent (${frame.error})`,
					),
				);
				handled = true;
			}
			return handled;
		}

		const entry = this.#pending.get(id);
		if (!entry) return false;

		clearTimeout(entry.timer);
		this.#pending.delete(id);
		entry.resolve(frame);
		return true;
	}

	/** Reject all pending requests (sidecar died). */
	rejectAll(reason: string): void {
		for (const entry of this.#pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new Error(reason));
		}
		this.#pending.clear();
	}

	get pendingCount(): number {
		return this.#pending.size;
	}
}
