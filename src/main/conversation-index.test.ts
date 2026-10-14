/** Conversation search over real, local saved-session files and its derived SQLite cache. */
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationIndex, MARK_CLOSE, MARK_OPEN, openConversationIndex } from "./conversation-index";

let root: string;
let sessionsDir: string;
let index: ConversationIndex;
let stamp = Date.now();

function header(id: string, cwd: string, title?: string): string {
	const lines = [];
	if (title) lines.push(JSON.stringify({ type: "title", title }));
	lines.push(JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-10-01T00:00:00.000Z" }));
	return `${lines.join("\n")}\n`;
}

function message(id: string, role: "user" | "assistant" | "toolResult", text: string, timestamp: number): string {
	const content = role === "user" ? text : [{ type: "text", text }];
	return `${JSON.stringify({ type: "message", id, parentId: null, timestamp: new Date(timestamp).toISOString(), message: { role, content, timestamp } })}\n`;
}

async function session(project: string, name: string, body: string): Promise<string> {
	const dir = join(sessionsDir, project);
	await mkdir(dir, { recursive: true });
	const file = join(dir, name);
	await writeFile(file, body);
	return file;
}

async function changed(file: string): Promise<void> {
	stamp += 1000;
	await utimes(file, stamp / 1000, stamp / 1000);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-conv-index-"));
	sessionsDir = join(root, "sessions");
	index = new ConversationIndex(join(root, "index.db"), sessionsDir);
});

afterEach(async () => {
	await index.close();
	await rm(root, { recursive: true, force: true });
});

describe("ConversationIndex", () => {
	it("finds spoken user and assistant text, never tool or hidden content, grouped by session", async () => {
		const file = await session(
			"-proj-a-", "a.jsonl",
			header("s1", "/proj/a", "Fix the release build") +
				message("u1", "user", "the codesign step fails on the notarize stage", 1000) +
				message("t1", "toolResult", "notarize tool output", 1500) +
				JSON.stringify({ type: "custom_message", id: "hidden", content: "notarize secret", display: false }) + "\n" +
				JSON.stringify({ type: "message", id: "hidden-message", message: { role: "user", hidden: true, content: "notarize secret" } }) + "\n" +
				JSON.stringify({ type: "message", id: "display-false", message: { role: "assistant", display: false, content: "notarize secret" } }) + "\n" +
				JSON.stringify({ type: "message", id: "a1", message: { role: "assistant", timestamp: 2000, content: [
					{ type: "thinking", thinking: "notarize secret reasoning" },
					{ type: "toolCall", name: "bash", arguments: { command: "notarize secret command" } },
					{ type: "text", text: "Notarize needs the hardened runtime flag." },
				] } }) + "\n",
		);
		await index.refresh();
		const response = index.search("notarize");
		expect(response.indexed).toBe(1);
		expect(response.results).toHaveLength(1);
		expect(response.results[0]).toMatchObject({ path: file, sessionId: "s1", cwd: "/proj/a", title: "Fix the release build", more: 0 });
		expect(response.results[0]?.hits.map(hit => [hit.entryId, hit.role])).toEqual([["u1", "user"], ["a1", "assistant"]]);
		expect(response.results[0]?.hits[1]?.snippet).toBe(`${MARK_OPEN}Notarize${MARK_CLOSE} needs the hardened runtime flag.`);
		expect(index.search("secret").results).toEqual([]);
	});

	it("requires every term, including short CJK terms, and treats SQL and FTS syntax literally", async () => {
		await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") +
			message("u1", "user", "把缓存清掉以后 UI 恢复了", 1000) +
			message("u2", "user", "the cache layer is fine", 2000) +
			message("u3", "user", 'literal 50% a_b "quoted" markers', 3000));
		await index.refresh();
		expect(index.search("缓存").results[0]?.hits.map(hit => hit.entryId)).toEqual(["u1"]);
		expect(index.search("ui 缓存").results[0]?.hits.map(hit => hit.entryId)).toEqual(["u1"]);
		expect(index.search("cache 缓存").results).toEqual([]);
		expect(index.search('50% a_b "quoted"').results[0]?.hits.map(hit => hit.entryId)).toEqual(["u3"]);
		expect(index.search("%_").results).toEqual([]);
		expect(index.search(" ").results).toEqual([]);
	});

	it("scopes local files to one project and orders sessions by their latest matching message", async () => {
		await session("-proj-a-", "a.jsonl", header("sa", "/proj/a") + message("u1", "user", "deploy the worker", 1000));
		await session("-proj-b-", "b.jsonl", header("sb", "/proj/b") + message("u1", "user", "deploy the site", 2000));
		await index.refresh();
		expect(index.search("deploy").results.map(result => result.sessionId)).toEqual(["sb", "sa"]);
		expect(index.search("deploy", { cwd: "/proj/a" }).results.map(result => result.sessionId)).toEqual(["sa"]);
	});

	it("catches up local files for a fresh query without a separate refresh call", async () => {
		await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") + message("u1", "user", "newly saved memo", 1000));
		const response = await index.searchFresh("memo", { cwd: "/proj/a" });
		expect(response.results[0]?.hits.map(hit => hit.entryId)).toEqual(["u1"]);
		expect(response.indexing).toBeNull();
	});

	it("shows the latest three matching messages in conversation order and counts further hits", async () => {
		await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") +
			[1, 2, 3, 4, 5].map(n => message(`u${n}`, "user", "release issue", n * 1000)).join(""));
		await index.refresh();
		expect(index.search("release").results[0]?.hits.map(hit => hit.entryId)).toEqual(["u3", "u4", "u5"]);
		expect(index.search("release").results[0]?.more).toBe(2);
	});

	it("picks up appended messages once, and a half-written line only when complete", async () => {
		const file = await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") + message("u1", "user", "alpha topic", 1000));
		await index.refresh();
		const next = message("a1", "assistant", "alpha answer with bravo", 2000);
		await appendFile(file, next.slice(0, 40));
		await changed(file);
		await index.refresh();
		expect(index.search("bravo").results).toEqual([]);
		await appendFile(file, next.slice(40));
		await changed(file);
		await index.refresh();
		expect(index.search("bravo").results[0]?.hits.map(hit => hit.entryId)).toEqual(["a1"]);
		expect(index.search("alpha").results[0]?.hits.map(hit => hit.entryId)).toEqual(["u1", "a1"]);
	});

	it("forgets text after rewrites, truncation, and removal", async () => {
		const file = await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") + message("u1", "user", "original wording here", 1000));
		const other = await session("-proj-a-", "b.jsonl", header("s2", "/proj/a") + message("u1", "user", "gone soon", 1000));
		await index.refresh();
		await writeFile(file, header("s1", "/proj/a") + message("u1", "user", "replaced wording here, longer", 1000));
		await changed(file);
		await rm(other);
		await index.refresh();
		expect(index.search("original").results).toEqual([]);
		expect(index.search("replaced").results[0]?.hits).toHaveLength(1);
		expect(index.search("gone").results).toEqual([]);
		expect(index.search("wording").indexed).toBe(1);
		await writeFile(file, header("s1", "/proj/a"));
		await changed(file);
		await index.refresh();
		expect(index.search("wording").results).toEqual([]);
	});

	it("replaces same-size rewritten messages even when the file tail is unchanged", async () => {
		const ending = message("a1", "assistant", "unchanged trailing response ".repeat(12), 2000);
		const original = header("s1", "/proj/a") + message("u1", "user", "obsolete keyword", 1000) + ending;
		const replacement = header("s1", "/proj/a") + message("u1", "user", "modified keyword", 1000) + ending;
		expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
		const file = await session("-proj-a-", "a.jsonl", original);
		await index.refresh();
		expect(index.search("obsolete").results[0]?.hits[0]?.entryId).toBe("u1");
		await writeFile(file, replacement);
		await changed(file);
		await index.refresh();
		expect(index.search("obsolete").results).toEqual([]);
		expect(index.search("modified").results[0]?.hits.map(hit => hit.entryId)).toEqual(["u1"]);
	});

	it("reads fixed title slots, legacy header titles, and JSON whitespace without changing source files", async () => {
		const slot = (title: string) => {
			const value = JSON.stringify({ type: "title", v: 1, title, updatedAt: "2026-10-01T00:00:00Z", pad: "" });
			return value.replace('"pad":""', `"pad":"${" ".repeat(255 - Buffer.byteLength(value))}"`) + "\n";
		};
		const file = await session("-proj-a-", "a.jsonl", slot("Current title") +
			JSON.stringify({ type: "session", id: "s1", cwd: "/proj/a", title: "Old header title" }) + "\n" +
			'{ "type": "message", "id": "u1", "message": { "role": "user", "content": [{ "type": "text", "text": "human question" }], "timestamp": 1000 } }\n' +
			message("a1", "assistant", "human reply", 2000));
		await session("-proj-b-", "b.jsonl", JSON.stringify({ type: "session", id: "s2", cwd: "/proj/b", title: "Legacy title" }) + "\n" + message("u1", "user", "human legacy", 3000));
		const before = await readFile(file, "utf8");
		await index.refresh();
		expect(index.search("human").results.map(result => result.title)).toEqual(["Legacy title", "Current title"]);
		expect(await readFile(file, "utf8")).toBe(before);
		await writeFile(file, slot("Renamed title") + before.slice(256));
		await changed(file);
		await index.refresh();
		expect(index.search("question").results[0]?.title).toBe("Renamed title");
		expect(index.search("human", { cwd: "/proj/a" }).results[0]?.hits).toHaveLength(2);
		await writeFile(file, slot("") + before.slice(256));
		await changed(file);
		await index.refresh();
		expect(index.search("question").results[0]?.title).toBeNull();
	});

	it("preserves UTF-8 characters when a message crosses a read chunk boundary", async () => {
		const prefix = header("s1", "/proj/a");
		const start = '{"type":"message","id":"u1","message":{"role":"user","content":"';
		const padding = " ".repeat(2 * 1024 * 1024 - Buffer.byteLength(prefix + start) - 1);
		await session("-proj-a-", "a.jsonl", prefix + start + padding + '缓存恢复","timestamp":1000}}\n');
		await index.refresh();
		expect(index.search("缓存").results[0]?.hits[0]?.snippet).toBe(`${MARK_OPEN}缓存${MARK_CLOSE}恢复`);
	});

	it("keeps its index across restarts", async () => {
		await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") + message("u1", "user", "persistent memo", 1000));
		await index.refresh();
		await index.close();
		index = new ConversationIndex(join(root, "index.db"), sessionsDir);
		expect(index.search("memo").results.map(result => result.sessionId)).toEqual(["s1"]);
	});

	it("rebuilds an unreadable derived cache without modifying saved sessions", async () => {
		const file = await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") + message("u1", "user", "recoverable memo", 1000));
		const before = await readFile(file, "utf8");
		await index.close();
		await writeFile(join(root, "index.db"), "not sqlite");
		const errors: unknown[] = [];
		const reopened = openConversationIndex(join(root, "index.db"), sessionsDir, error => errors.push(error));
		expect(reopened).not.toBeNull();
		index = reopened!;
		await index.refresh();
		expect(index.search("memo").results[0]?.sessionId).toBe("s1");
		expect(errors.length).toBeGreaterThan(0);
		expect(await readFile(file, "utf8")).toBe(before);
	});

	it("reports an unavailable cache when its database cannot be opened", () => {
		const errors: unknown[] = [];
		expect(openConversationIndex(join(root, "missing", "index.db"), sessionsDir, error => errors.push(error))).toBeNull();
		expect(errors.length).toBeGreaterThan(0);
	});

	it("closes safely during a directory scan and while a fresh search is waiting", async () => {
		await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") + message("u1", "user", "memo", 1000));
		const refresh = index.refresh();
		const search = index.searchFresh("memo");
		const closing = index.close();
		await expect(refresh).resolves.toBeUndefined();
		await expect(closing).resolves.toBeUndefined();
		await expect(search).resolves.toEqual({ results: [], indexed: 0, indexing: null, unavailable: true });
		expect(index.search("memo").unavailable).toBe(true);
		await expect(index.refresh()).resolves.toBeUndefined();
	});

	it("drains a chunked file refresh before closing the database", async () => {
		await session("-proj-a-", "a.jsonl", header("s1", "/proj/a") + message("u1", "user", "memo ".repeat(500_000), 1000));
		const refresh = index.refresh();
		let finished = false;
		void refresh.then(() => { finished = true; }, () => { finished = true; });
		while (!finished && !index.search("").indexing?.total) await nextTick();
		expect(index.search("").indexing).toEqual({ done: 0, total: 1 });
		await index.close();
		await expect(refresh).resolves.toBeUndefined();
		expect(index.search("memo").unavailable).toBe(true);
	});
});
