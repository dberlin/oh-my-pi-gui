/**
 * Message-level search of LOCAL saved conversations, never tool output.
 * SQLite is a disposable, GUI-owned cache; saved JSONL is opened read-only.
 * Changed files are re-read in full: a matching tail cannot prove that earlier
 * text was not rewritten. Chunked reads yield between chunks.
 */
import { rmSync } from "node:fs";
import { type FileHandle, open, readdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { setImmediate as nextTick, setTimeout as sleep } from "node:timers/promises";
import type {
	ConversationHit,
	ConversationSearchResponse,
	ConversationSearchResult,
	SessionKind,
} from "../shared/ipc-types";

const requireBuiltin = createRequire(import.meta.url);
const SCHEMA_VERSION = "2";
const CHUNK_BYTES = 2 * 1024 * 1024;
const HEAD_BYTES = 8 * 1024;
const MAX_BODY_CHARS = 20_000;
const MAX_ROWS = 400;
const HITS_PER_SESSION = 3;
const MAX_SESSIONS = 60;
const SNIPPET_CONTEXT = 60;
const FRESH_WAIT_MS = 400;
const FRESH_MAX_AGE_MS = 2000;
/** Snippet delimiters rendered as highlights, not HTML. */
export const MARK_OPEN = "\u0001";
export const MARK_CLOSE = "\u0002";

interface FileRow {
	path: string;
	signature: string;
}

interface SessionHead {
	sessionId: string | null;
	cwd: string | null;
	title: string | null;
	kind: SessionKind | null;
}

interface ParsedMessage {
	entryId: string;
	role: "user" | "assistant";
	body: string;
	timestamp: number;
}

/** Keep spoken text blocks only; reasoning, tool calls/results and custom entries stay private. */
export function parseMessageLine(line: string): ParsedMessage | null {
	if (!line.includes('"message"')) return null;
	let row: unknown;
	try {
		row = JSON.parse(line);
	} catch {
		return null;
	}
	if (
		!row || typeof row !== "object" ||
		!("type" in row) || row.type !== "message" ||
		!("id" in row) || typeof row.id !== "string" ||
		!("message" in row)
	) return null;
	const message = row.message;
	if (!message || typeof message !== "object" || !("content" in message) || !("role" in message)) return null;
	if (("hidden" in message && message.hidden === true) || ("display" in message && message.display === false)) return null;
	const role = message.role;
	if (role !== "user" && role !== "assistant") return null;
	let body: string;
	if (typeof message.content === "string") body = message.content;
	else if (Array.isArray(message.content)) {
		body = message.content
			.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
			.map(part => part.text)
			.join("\n");
	} else return null;
	body = body.trim();
	if (!body) return null;
	const timestamp =
		"timestamp" in message && typeof message.timestamp === "number"
			? message.timestamp
			: "timestamp" in row && typeof row.timestamp === "string"
				? Date.parse(row.timestamp) || 0
				: 0;
	return { entryId: row.id, role, body: body.slice(0, MAX_BODY_CHARS), timestamp };
}

/** Current title slots take precedence over legacy header titles, including an explicit empty title. */
export function parseSessionHead(head: string): SessionHead {
	const result: SessionHead = { sessionId: null, cwd: null, title: null, kind: null };
	let hasTitleSlot = false;
	for (const line of head.split("\n").slice(0, 3)) {
		let row: unknown;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (!row || typeof row !== "object" || !("type" in row)) continue;
		if (row.type === "title" && "title" in row && typeof row.title === "string") {
			hasTitleSlot = true;
			result.title = row.title.trim() || null;
		}
		if (row.type === "session") {
			if ("id" in row && typeof row.id === "string") result.sessionId = row.id;
			if ("cwd" in row && typeof row.cwd === "string") result.cwd = row.cwd;
			if (!hasTitleSlot && "title" in row && typeof row.title === "string") result.title = row.title.trim() || null;
			if ("kind" in row && row.kind === "chat") result.kind = "chat";
			break;
		}
	}
	return result;
}

export function searchTerms(query: string): string[] {
	return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
}

/** A bounded, single-line window around the first matching term. */
export function buildSnippet(body: string, terms: readonly string[]): string {
	const flat = body.replace(/\s+/g, " ").trim();
	const lower = flat.toLowerCase();
	let first = -1;
	for (const term of terms) {
		const at = lower.indexOf(term);
		if (at !== -1 && (first === -1 || at < first)) first = at;
	}
	const start = first <= SNIPPET_CONTEXT ? 0 : first - SNIPPET_CONTEXT;
	const end = Math.min(flat.length, Math.max(first, 0) + SNIPPET_CONTEXT * 2 + 40);
	const window = flat.slice(start, end);
	const windowLower = window.toLowerCase();
	const marks: Array<[number, number]> = [];
	for (const term of [...terms].sort((a, b) => b.length - a.length)) {
		if (!term) continue;
		let from = 0;
		for (;;) {
			const at = windowLower.indexOf(term, from);
			if (at === -1) break;
			const stop = at + term.length;
			if (!marks.some(([a, b]) => at < b && stop > a)) marks.push([at, stop]);
			from = stop;
		}
	}
	marks.sort((a, b) => a[0] - b[0]);
	let out = "";
	let cursor = 0;
	for (const [a, b] of marks) {
		out += window.slice(cursor, a) + MARK_OPEN + window.slice(a, b) + MARK_CLOSE;
		cursor = b;
	}
	out += window.slice(cursor);
	return `${start > 0 ? "…" : ""}${out}${end < flat.length ? "…" : ""}`;
}

function unavailable(): ConversationSearchResponse {
	return { results: [], indexed: 0, indexing: null, unavailable: true };
}

export class ConversationIndex {
	readonly #db: DatabaseSync;
	readonly #sessionsDir: string;
	#refreshing: Promise<void> | null = null;
	#closing: Promise<void> | null = null;
	#lastRefresh = 0;
	#progress: { done: number; total: number } | null = null;
	#closed = false;

	constructor(dbPath: string, sessionsDir: string) {
		this.#sessionsDir = sessionsDir;
		// Lazy builtin loading lets the GUI report unavailable on runtimes without SQLite.
		const { DatabaseSync: Database } = requireBuiltin("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
		this.#db = new Database(dbPath);
		try {
			this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
			this.#db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
			const version = this.#db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined;
			if (version?.value !== SCHEMA_VERSION) {
				this.#db.exec("DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS entries;");
				this.#db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
			}
			this.#db.exec(`
CREATE TABLE IF NOT EXISTS files (
	path TEXT PRIMARY KEY,
	signature TEXT NOT NULL,
	session_id TEXT,
	cwd TEXT,
	title TEXT,
	kind TEXT,
	modified INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
	body,
	path UNINDEXED,
	entry_id UNINDEXED,
	role UNINDEXED,
	ts UNINDEXED,
	tokenize = 'trigram'
);`);
		} catch (error) {
			this.#db.close();
			throw error;
		}
	}

	/** Stop accepting work immediately, then drain reads before releasing SQLite. */
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#closing = (async () => {
			// Refresh failures belong to their callers; shutdown only drains the pass.
			await this.#refreshing?.catch(() => undefined);
			this.#db.close();
		})();
		return this.#closing;
	}

	async searchFresh(query: string, scope: { cwd?: string | null } = {}): Promise<ConversationSearchResponse> {
		if (this.#closed) return unavailable();
		const pass = this.refresh({ maxAgeMs: FRESH_MAX_AGE_MS }).catch(() => undefined);
		const timeout = new AbortController();
		try {
			await Promise.race([pass, sleep(FRESH_WAIT_MS, undefined, { signal: timeout.signal })]);
		} finally {
			timeout.abort();
		}
		return this.search(query, scope);
	}

	/** Concurrent callers share one pass. A failed pass never counts as fresh. */
	refresh(options: { maxAgeMs?: number } = {}): Promise<void> {
		if (this.#closed) return Promise.resolve();
		if (this.#refreshing) return this.#refreshing;
		if (options.maxAgeMs !== undefined && Date.now() - this.#lastRefresh < options.maxAgeMs) return Promise.resolve();
		// Discovery is work too: a bounded search must tell its caller to poll
		// even before the first filesystem scan has finished.
		this.#progress = { done: 0, total: 0 };
		this.#refreshing = this.#refresh().then(() => {
			this.#lastRefresh = Date.now();
		}).finally(() => {
			this.#refreshing = null;
			this.#progress = null;
		});
		return this.#refreshing;
	}

	search(query: string, scope: { cwd?: string | null } = {}): ConversationSearchResponse {
		if (this.#closed) return unavailable();
		const count = this.#db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number };
		const indexed = count.n;
		const terms = searchTerms(query);
		const status = { indexed, indexing: this.#progress ? { ...this.#progress } : null };
		if (terms.length === 0) return { results: [], ...status };
		const long = terms.filter(term => [...term].length >= 3);
		const short = terms.filter(term => [...term].length < 3);
		const where: string[] = [];
		const params: Array<string | number> = [];
		if (long.length > 0) {
			where.push("entries MATCH ?");
			// FTS quoted phrases: doubled inner quotes keep operators literal.
			params.push(long.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND "));
		}
		for (const term of short) {
			where.push("body LIKE ? ESCAPE '\\'");
			params.push(`%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`);
		}
		if (scope.cwd) {
			where.push("path IN (SELECT path FROM files WHERE cwd = ?)");
			params.push(scope.cwd);
		}
		params.push(MAX_ROWS);
		const rows = this.#db.prepare(
			`SELECT body, path, entry_id, role, ts FROM entries WHERE ${where.join(" AND ")} ORDER BY CAST(ts AS INTEGER) DESC LIMIT ?`,
		).all(...params) as Array<{ body: string; path: string; entry_id: string; role: string; ts: number | string }>;
		const byPath = new Map<string, ConversationHit[]>();
		for (const row of rows) {
			const hits = byPath.get(row.path) ?? [];
			hits.push({
				entryId: row.entry_id,
				role: row.role === "assistant" ? "assistant" : "user",
				snippet: buildSnippet(row.body, terms),
				timestamp: Number(row.ts) || 0,
			});
			byPath.set(row.path, hits);
		}
		const fileQuery = this.#db.prepare("SELECT session_id, cwd, title, kind, modified FROM files WHERE path = ?");
		const results: ConversationSearchResult[] = [];
		for (const [path, hits] of byPath) {
			if (results.length >= MAX_SESSIONS) break;
			const file = fileQuery.get(path) as
				| {
						session_id: string | null;
						cwd: string | null;
						title: string | null;
						kind: string | null;
						modified: number;
				  }
				| undefined;
			if (!file) continue;
			const shown = hits.slice(0, HITS_PER_SESSION).sort((a, b) => a.timestamp - b.timestamp);
			results.push({
				path,
				sessionId: file.session_id ?? "",
				cwd: file.cwd ?? "",
				title: file.title,
				kind: file.kind === "chat" ? "chat" : undefined,
				modified: file.modified,
				hits: shown,
				more: hits.length - shown.length,
			});
		}
		return { results, ...status };
	}

	async #refresh(): Promise<void> {
		const files = await this.#scan();
		if (this.#closed) return;
		const known = new Map(
			(this.#db.prepare("SELECT path, signature FROM files").all() as unknown as FileRow[]).map(
				row => [row.path, row],
			),
		);
		const removeEntries = this.#db.prepare("DELETE FROM entries WHERE path = ?");
		const removeFile = this.#db.prepare("DELETE FROM files WHERE path = ?");
		for (const path of known.keys()) {
			if (files.has(path)) continue;
			removeEntries.run(path);
			removeFile.run(path);
		}
		const stale = [...files].filter(([path, info]) => known.get(path)?.signature !== info.signature);
		if (stale.length === 0) return;
		this.#progress = { done: 0, total: stale.length };
		for (const [path, info] of stale) {
			if (this.#closed) return;
			await this.#indexFile(path, info);
			if (this.#progress) this.#progress.done += 1;
		}
	}

	async #scan(): Promise<Map<string, { signature: string; size: number; mtimeMs: number }>> {
		const found = new Map<string, { signature: string; size: number; mtimeMs: number }>();
		let projects: string[];
		try {
			projects = (await readdir(this.#sessionsDir, { withFileTypes: true }))
				.filter(entry => entry.isDirectory())
				.map(entry => join(this.#sessionsDir, entry.name));
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return found;
			throw error;
		}
		for (const project of projects) {
			if (this.#closed) break;
			let names: string[];
			try {
				names = (await readdir(project, { withFileTypes: true }))
					.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
					.map(entry => entry.name);
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
			for (const name of names) {
				if (this.#closed) break;
				const path = join(project, name);
				try {
					const info = await stat(path);
					found.set(path, { signature: `${info.mtimeMs}:${info.size}`, size: info.size, mtimeMs: info.mtimeMs });
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				}
			}
		}
		return found;
	}

	async #indexFile(
		path: string,
		info: { signature: string; size: number; mtimeMs: number },
	): Promise<void> {
		let handle: FileHandle;
		try {
			handle = await open(path, "r");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
		try {
			if (this.#closed) return;
			const headBuffer = Buffer.alloc(Math.min(HEAD_BYTES, info.size));
			await handle.read(headBuffer, 0, headBuffer.length, 0);
			const head = parseSessionHead(headBuffer.toString("utf8"));
			let offset = 0;
			const parsed: ParsedMessage[] = [];
			const decoder = new StringDecoder("utf8");
			let carry = "";
			while (offset < info.size) {
				if (this.#closed) return;
				const length = Math.min(CHUNK_BYTES, info.size - offset);
				const buffer = Buffer.alloc(length);
				const { bytesRead } = await handle.read(buffer, 0, length, offset);
				if (bytesRead === 0) break;
				const chunk = buffer.subarray(0, bytesRead);
				const text = carry + decoder.write(chunk);
				const lastNewline = text.lastIndexOf("\n");
				if (lastNewline !== -1) {
					for (const line of text.slice(0, lastNewline).split("\n")) {
						const message = parseMessageLine(line);
						if (message) parsed.push(message);
					}
				}
				carry = lastNewline === -1 ? text : text.slice(lastNewline + 1);
				offset += bytesRead;
				await nextTick();
			}
			if (this.#closed) return;
			this.#db.exec("BEGIN");
			try {
				this.#db.prepare("DELETE FROM entries WHERE path = ?").run(path);
				const insert = this.#db.prepare("INSERT INTO entries (body, path, entry_id, role, ts) VALUES (?, ?, ?, ?, ?)");
				for (const message of parsed) insert.run(message.body, path, message.entryId, message.role, message.timestamp);
				this.#db
					.prepare(
						`INSERT OR REPLACE INTO files (path, signature, session_id, cwd, title, kind, modified)
VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						path,
						info.signature,
						head.sessionId,
						head.cwd,
						head.title,
						head.kind,
						Math.round(info.mtimeMs),
					);
				this.#db.exec("COMMIT");
			} catch (error) {
				this.#db.exec("ROLLBACK");
				throw error;
			}
		} finally {
			await handle.close();
		}
	}
}

/** Recover a corrupt disposable cache once; no SQLite/FTS5 means search is explicitly unavailable. */
export function openConversationIndex(
	dbPath: string,
	sessionsDir: string,
	onError: (error: unknown) => void,
): ConversationIndex | null {
	try {
		return new ConversationIndex(dbPath, sessionsDir);
	} catch (error) {
		onError(error);
	}
	try {
		for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
		return new ConversationIndex(dbPath, sessionsDir);
	} catch (error) {
		onError(error);
		return null;
	}
}
