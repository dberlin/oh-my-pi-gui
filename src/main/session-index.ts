/**
 * Watches ~/.omp/agent/sessions/ for .jsonl session files.
 * Parses title, session header, first message, and tail status.
 * LRU cache keyed by mtime:size avoids re-parsing unchanged files.
 */
import { open, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { SessionInfo } from "../shared/ipc-types";

const TITLE_SLOT_BYTES = 256;
const TAIL_BYTES = 32 * 1024;
const HEAD_BYTES = 32 * 1024;
const MAX_CACHE_SIZE = 4096;
const POLL_INTERVAL_MS = 10_000;
/** Per-file cap for full-content search reads; larger sessions match on this prefix. */
const SEARCH_READ_BYTES = 8 * 1024 * 1024;
/** LRU cap on cached lowercased file text (full-content search). */
const SEARCH_CACHE_SIZE = 128;
/** Files read concurrently during a content search (bounds FD pressure). */
const SEARCH_BATCH = 16;

type SessionStatus = SessionInfo["status"];

interface CacheEntry {
	info: SessionInfo;
}

export class SessionIndex {
	#watcher: FSWatcher | null = null;
	#cache = new Map<string, CacheEntry>();
	#searchCache = new Map<string, { signature: string; text: string }>();
	#sessionsDir: string;
	#cwd: string;
	#pollTimer: NodeJS.Timeout | null = null;
	#lastSignature = "";

	onChange: (() => void) | null = null;

	constructor(sessionsDir?: string, cwd = process.cwd()) {
		this.#sessionsDir = sessionsDir ?? join(homedir(), ".omp", "agent", "sessions");
		this.#cwd = resolve(cwd);
	}

	/** Sessions root watched by this index (plan files live in per-session artifact dirs beneath it). */
	get sessionsDir(): string {
		return this.#sessionsDir;
	}

	start(): void {
		this.#watcher = watch(this.#sessionsDir, {
			persistent: true,
			ignoreInitial: false,
			depth: 2,
			awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
		});

		this.#watcher.on("add", path => this.#onFileChange(path));
		this.#watcher.on("change", path => this.#onFileChange(path));
		this.#watcher.on("unlink", path => this.#onFileRemove(path));

		// Poll fallback for platforms where chokidar is unreliable. Gated on a
		// directory signature so it only notifies when something changed.
		void this.#computeSignature().then(signature => {
			this.#lastSignature = signature;
		});
		this.#pollTimer = setInterval(() => this.#pollScan(), POLL_INTERVAL_MS);
	}

	stop(): void {
		this.#watcher?.close();
		this.#watcher = null;
		if (this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = null;
		}
		this.#cache.clear();
		this.#searchCache.clear();
	}

	/**
	 * @param scope "local" filters to sessions whose cwd matches `cwd`.
	 * @param cwd The calling window's cwd for "local" filtering. Defaults to the
	 *   index's own cwd (single-window behavior); multi-window callers pass their
	 *   own so each window sees only its project's sessions.
	 */
	async list(scope: "local" | "global", cwd?: string): Promise<SessionInfo[]> {
		const entries = await this.#scanDir();
		const parsed = await Promise.all(entries.map(entry => this.#parseSessionFile(entry.path)));
		const localCwd = cwd !== undefined ? resolve(cwd) : this.#cwd;
		const infos = parsed.filter((info): info is SessionInfo => {
			if (!info) return false;
			return scope === "global" || (info.cwd != null && resolve(info.cwd) === localCwd);
		});

		// Sort by modified descending
		infos.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());

		// Dedupe by session id: the agent migrates sessions between legacy and
		// current cwd-directory encodings (e.g. `-AiProject-x` → `home-x-<hash>`),
		// and during that window the same session id can exist as a file in both
		// directories. After the modified-desc sort, the first occurrence of each
		// id is the newest copy — keep it and drop the stale duplicates so one
		// session never renders as two sidebar rows.
		const seen = new Set<string>();
		return infos.filter(info => {
			if (!info.id || seen.has(info.id)) return false;
			seen.add(info.id);
			return true;
		});
	}

	async deleteSession(sessionPath: string): Promise<void> {
		const target = resolve(sessionPath);
		const root = `${resolve(this.#sessionsDir)}${sep}`;
		if (!target.startsWith(root) || !target.endsWith(".jsonl")) throw new Error("Invalid session path");
		await rm(target, { force: true });
		for (const key of this.#cache.keys()) {
			if (key.endsWith(`:${target}`)) this.#cache.delete(key);
		}
		this.#searchCache.delete(target);
		this.#notifyChange();
	}

	/**
	 * Full-content search: paths of the given session files whose raw JSONL
	 * text contains every query token (case-insensitive). Deliberately a raw
	 * grep — no JSON parsing — because tokens are matched individually, so
	 * JSON escaping rarely breaks them. Lowercased file text is cached by
	 * mtime:size so debounced keystrokes only re-read files that changed.
	 */
	async searchContent(query: string, candidatePaths: string[]): Promise<string[]> {
		const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
		if (tokens.length === 0 || candidatePaths.length === 0) return [];
		const matches: string[] = [];
		for (let i = 0; i < candidatePaths.length; i += SEARCH_BATCH) {
			const batch = await Promise.all(
				candidatePaths.slice(i, i + SEARCH_BATCH).map(async path => {
					const text = await this.#searchText(path);
					if (text === null) return null;
					for (const token of tokens) {
						if (!text.includes(token)) return null;
					}
					return path;
				}),
			);
			for (const hit of batch) {
				if (hit !== null) matches.push(hit);
			}
		}
		return matches;
	}

	/** Lowercased session-file text (capped at SEARCH_READ_BYTES), LRU-cached by mtime:size. */
	async #searchText(filePath: string): Promise<string | null> {
		try {
			const fileStat = await stat(filePath);
			const signature = `${fileStat.mtimeMs}:${fileStat.size}`;
			const cached = this.#searchCache.get(filePath);
			if (cached && cached.signature === signature) {
				// Move to end (most recently used)
				this.#searchCache.delete(filePath);
				this.#searchCache.set(filePath, cached);
				return cached.text;
			}
			const fh = await open(filePath, "r");
			try {
				const length = Math.min(fileStat.size, SEARCH_READ_BYTES);
				const buffer = Buffer.alloc(length);
				await fh.read(buffer, 0, length, 0);
				const text = buffer.toString("utf-8").toLowerCase();
				if (this.#searchCache.size >= SEARCH_CACHE_SIZE) {
					const oldest = this.#searchCache.keys().next().value;
					if (oldest) this.#searchCache.delete(oldest);
				}
				this.#searchCache.set(filePath, { signature, text });
				return text;
			} finally {
				await fh.close();
			}
		} catch {
			return null;
		}
	}

	async #scanDir(): Promise<{ path: string }[]> {
		try {
			const projectDirs = (await readdir(this.#sessionsDir, { withFileTypes: true })).filter(entry =>
				entry.isDirectory(),
			);
			const projectFiles = await Promise.all(
				projectDirs.map(async projectDir => {
					const projectPath = join(this.#sessionsDir, projectDir.name);
					const entries = await readdir(projectPath, { withFileTypes: true });
					return entries
						.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
						.map(entry => ({ path: join(projectPath, entry.name) }));
				}),
			);
			return projectFiles.flat();
		} catch {
			return [];
		}
	}

	#onFileChange(path: string): void {
		if (!path.endsWith(".jsonl")) return;
		// Invalidate cache for this path
		for (const key of this.#cache.keys()) {
			if (key.endsWith(`:${path}`)) {
				this.#cache.delete(key);
			}
		}
		// Keep the signature in sync with the event so the next poll stays silent.
		void this.#computeSignature().then(signature => {
			this.#lastSignature = signature;
			this.#notifyChange();
		});
	}

	#onFileRemove(path: string): void {
		if (!path.endsWith(".jsonl")) return;
		for (const key of this.#cache.keys()) {
			if (key.endsWith(`:${path}`)) {
				this.#cache.delete(key);
			}
		}
		void this.#computeSignature().then(signature => {
			this.#lastSignature = signature;
			this.#notifyChange();
		});
	}

	async #pollScan(): Promise<void> {
		// Notify only when the directory fingerprint changed; the actual
		// re-parse still happens lazily (and cache-cheaply) in list().
		const signature = await this.#computeSignature();
		if (signature === this.#lastSignature) return;
		this.#lastSignature = signature;
		this.#notifyChange();
	}

	/** mtime:size fingerprint of every session file, for change detection. */
	async #computeSignature(): Promise<string> {
		const entries = await this.#scanDir();
		const parts = await Promise.all(
			entries.map(async entry => {
				try {
					const fileStat = await stat(entry.path);
					return `${entry.path}:${fileStat.mtimeMs}:${fileStat.size}`;
				} catch {
					return null;
				}
			}),
		);
		return parts
			.filter(part => part !== null)
			.sort()
			.join("\n");
	}

	async #parseSessionFile(filePath: string): Promise<SessionInfo | null> {
		try {
			const fileStat = await stat(filePath);
			const cacheKey = `${fileStat.mtimeMs}:${fileStat.size}:${filePath}`;

			// LRU check
			const cached = this.#cache.get(cacheKey);
			if (cached) {
				// Move to end (most recently used)
				this.#cache.delete(cacheKey);
				this.#cache.set(cacheKey, cached);
				return cached.info;
			}

			const info = await this.#doParse(filePath, fileStat);
			if (!info) return null;

			// Evict oldest if over capacity
			if (this.#cache.size >= MAX_CACHE_SIZE) {
				const oldest = this.#cache.keys().next().value;
				if (oldest) this.#cache.delete(oldest);
			}

			this.#cache.set(cacheKey, { info });
			return info;
		} catch {
			return null;
		}
	}

	async #doParse(
		filePath: string,
		fileStat: { size: number; mtimeMs: number; birthtimeMs: number },
	): Promise<SessionInfo | null> {
		const size = fileStat.size;
		if (size === 0) return null;

		const fh = await open(filePath, "r");
		try {
			// Read enough of the head to parse the title, header, and first user message.
			const headBuf = Buffer.alloc(Math.min(HEAD_BYTES, size));
			await fh.read(headBuf, 0, headBuf.length, 0);
			const titleBuf = headBuf.subarray(0, Math.min(TITLE_SLOT_BYTES, headBuf.length));
			const title = this.#parseTitleSlot(titleBuf);

			// Read header line (second line, after first newline)
			const headerStart = headBuf.indexOf(0x0a);
			let header: { id?: string; title?: string; timestamp?: string; cwd?: string; parentSession?: string } | null =
				null;

			if (headerStart !== -1) {
				// Read up to 4KB for the header line
				const headerBuf = Buffer.alloc(Math.min(4096, size - headerStart - 1));
				await fh.read(headerBuf, 0, headerBuf.length, headerStart + 1);
				const headerLine = headerBuf.toString("utf-8").split("\n")[0];
				try {
					header = JSON.parse(headerLine);
				} catch {
					// Header parse failure is non-fatal
				}
			}

			// Read tail 32KB for status derivation
			const tailStart = Math.max(0, size - TAIL_BYTES);
			const tailBuf = Buffer.alloc(size - tailStart);
			await fh.read(tailBuf, 0, tailBuf.length, tailStart);
			const { status, messageCount } = this.#parseTail(tailBuf.toString("utf-8"));
			const firstMessage = this.#parseFirstMessage(headBuf.toString("utf-8"));

			const id = header?.id ?? filePath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";

			const info: SessionInfo = {
				path: filePath,
				id,
				title: title ?? header?.title ?? null,
				cwd: header?.cwd ?? "",
				created: header?.timestamp ?? new Date(fileStat.birthtimeMs).toISOString(),
				modified: new Date(fileStat.mtimeMs).toISOString(),
				messageCount,
				size,
				status,
				parentSessionPath: header?.parentSession,
				firstMessage,
			};

			return info;
		} finally {
			await fh.close();
		}
	}

	#parseTitleSlot(buf: Buffer): string | null {
		try {
			const firstLine = buf.toString("utf-8").split("\n", 1)[0]?.trimEnd();
			if (!firstLine) return null;
			const parsed = JSON.parse(firstLine) as { type?: string; title?: string };
			return parsed.type === "title" && parsed.title ? parsed.title : null;
		} catch {
			return null;
		}
	}

	#parseFirstMessage(head: string): string {
		for (const line of head.split("\n")) {
			try {
				const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
				if (entry.type !== "message" || entry.message?.role !== "user") continue;
				const content = entry.message.content;
				if (typeof content === "string") return content.slice(0, 200);
				if (Array.isArray(content)) {
					const textPart = (content as Array<{ type?: string; text?: string }>).find(part => part.type === "text");
					if (textPart?.text) return textPart.text.slice(0, 200);
				}
			} catch {
				// The final head chunk may contain a partial JSON line.
			}
		}
		return "";
	}

	#parseTail(tail: string): { status: SessionStatus; messageCount: number } {
		const lines = tail.split("\n").filter(line => line.trim().length > 0);
		let messageCount = 0;
		let status: SessionStatus = "unknown";
		let lastEntry: Record<string, unknown> | null = null;

		for (const line of lines) {
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				lastEntry = entry;
				if (entry.type === "message") messageCount++;
			} catch {
				// Tail reads can begin or end in the middle of a JSON line.
			}
		}

		if (lastEntry) {
			const lastType = lastEntry.type;
			if (lastType === "agent_end" || lastType === "turn_end") {
				status = "complete";
			} else if (lastType === "error") {
				status = "error";
			} else if (lastType === "aborted") {
				status = "aborted";
			} else if (lastType === "interrupted") {
				status = "interrupted";
			} else if (lastType === "message_start" || lastType === "tool_execution_start") {
				status = "pending";
			} else if (lastType === "message") {
				const message = lastEntry.message as { role?: string } | undefined;
				status = message?.role === "assistant" ? "complete" : "pending";
			}
		}

		return { status, messageCount };
	}

	#notifyChange(): void {
		this.onChange?.();
	}
}
