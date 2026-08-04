/**
 * NDJSON framing and v2 chunk reassembly for the RPC sidecar stdout stream.
 */
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { RpcChunkFrame } from "../shared/rpc-types";

const MAX_REASSEMBLED_BYTES = 67_108_864; // 64MB

/**
 * Reassembles v2 chunked frames. Validates ordering, count, and byte length.
 */
export class ChunkReassembler {
	#pending = new Map<string, { chunks: Buffer[]; count: number; byteLength: number }>();

	feed(frame: RpcChunkFrame): Buffer | null {
		const entry = this.#pending.get(frame.chunkId) ?? {
			chunks: [],
			count: frame.count,
			byteLength: frame.byteLength,
		};

		if (frame.index !== entry.chunks.length) {
			this.#pending.delete(frame.chunkId);
			throw new Error(`Out-of-order chunk: expected index ${entry.chunks.length}, got ${frame.index}`);
		}

		entry.chunks.push(Buffer.from(frame.data, "base64"));

		if (entry.chunks.length === entry.count) {
			this.#pending.delete(frame.chunkId);
			const full = Buffer.concat(entry.chunks);
			if (full.byteLength !== entry.byteLength) {
				throw new Error(`Byte length mismatch: expected ${entry.byteLength}, got ${full.byteLength}`);
			}
			if (full.byteLength > MAX_REASSEMBLED_BYTES) {
				throw new Error(`Exceeds maxReassembledFrameBytes (${MAX_REASSEMBLED_BYTES})`);
			}
			return full;
		}

		this.#pending.set(frame.chunkId, entry);
		return null;
	}

	clear(): void {
		this.#pending.clear();
	}
}

export type FrameHandler = (frame: unknown) => void;

/**
 * Attaches a readline-based NDJSON parser to a readable stream.
 * Handles v2 chunk reassembly transparently.
 */
export function attachNdjsonParser(stream: Readable, onFrame: FrameHandler): () => void {
	const reassembler = new ChunkReassembler();
	const rl = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

	const handleLine = (line: string) => {
		const trimmed = line.trim();
		if (!trimmed) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return; // Skip malformed lines
		}

		if (typeof parsed !== "object" || parsed === null) return;

		const obj = parsed as Record<string, unknown>;

		// Handle v2 chunks
		if (obj.type === "rpc_chunk") {
			try {
				const full = reassembler.feed(obj as unknown as RpcChunkFrame);
				if (full) {
					const reassembled = JSON.parse(full.toString("utf-8"));
					onFrame(reassembled);
				}
			} catch {
				// Chunk reassembly error — skip
			}
			return;
		}

		onFrame(parsed);
	};

	rl.on("line", handleLine);

	return () => {
		rl.close();
		reassembler.clear();
	};
}
