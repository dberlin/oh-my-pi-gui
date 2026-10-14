import { mkdtemp, rm } from "node:fs/promises";
import type * as NodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openConversationIndex } from "./conversation-index";

const runtime = vi.hoisted(() => ({ sqliteMissing: false, ftsMissing: false, closed: 0 }));

// These optional runtime capabilities cannot be removed from the real test runner.
// Keep real SQLite when testing a build whose SQLite lacks the FTS5 extension.
vi.mock("node:module", async importOriginal => {
	const original = await importOriginal<typeof NodeModule>();
	return {
		...original,
		createRequire: (...args: Parameters<typeof original.createRequire>) => {
			const require = original.createRequire(...args);
			return (id: string) => {
				if (id !== "node:sqlite") return require(id);
				if (runtime.sqliteMissing) throw new Error("No such built-in module: node:sqlite");
				const sqlite = require(id) as { DatabaseSync: typeof DatabaseSync };
				if (!runtime.ftsMissing) return sqlite;
				return {
					DatabaseSync: class extends sqlite.DatabaseSync {
						override exec(sql: string): void {
							if (sql.includes("CREATE VIRTUAL TABLE")) throw new Error("no such module: fts5");
							super.exec(sql);
						}
						override close(): void {
							runtime.closed += 1;
							super.close();
						}
					},
				};
			};
		},
	};
});

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "omp-conv-unavailable-"));
	runtime.sqliteMissing = false;
	runtime.ftsMissing = false;
	runtime.closed = 0;
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("keeps the GUI loadable and disables search when the runtime has no SQLite builtin", () => {
	runtime.sqliteMissing = true;
	const errors: unknown[] = [];
	expect(openConversationIndex(join(root, "index.db"), join(root, "sessions"), error => errors.push(error))).toBeNull();
	expect(errors.every(error => error instanceof Error && error.message.includes("node:sqlite"))).toBe(true);
	expect(errors.length).toBeGreaterThan(0);
});

it("disables search and releases partially opened databases when SQLite has no FTS5", () => {
	runtime.ftsMissing = true;
	const errors: unknown[] = [];
	expect(openConversationIndex(join(root, "index.db"), join(root, "sessions"), error => errors.push(error))).toBeNull();
	expect(errors.every(error => error instanceof Error && error.message.includes("fts5"))).toBe(true);
	expect(runtime.closed).toBe(2);
});
