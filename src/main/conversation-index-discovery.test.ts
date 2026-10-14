import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ConversationIndex } from "./conversation-index";

const discovery = vi.hoisted(() => ({ path: "", wait: null as Promise<void> | null }));
vi.mock("node:fs/promises", async importOriginal => {
	const real = await importOriginal<typeof FsPromises>();
	return {
		...real,
		readdir: async (...args: Parameters<typeof real.readdir>) => {
			if (args[0] === discovery.path && discovery.wait) await discovery.wait;
			return real.readdir(...args);
		},
	};
});

it("keeps a fresh search polling while directory discovery exceeds its wait budget", async () => {
	const root = await mkdtemp(join(tmpdir(), "omp-conv-discovery-"));
	const sessions = join(root, "sessions");
	await mkdir(join(sessions, "project"), { recursive: true });
	await writeFile(join(sessions, "project", "a.jsonl"),
		'{"type":"session","id":"s1","cwd":"/project"}\n' +
		'{"type":"message","id":"u1","message":{"role":"user","content":"delayed discovery memo","timestamp":1000}}\n');
	const index = new ConversationIndex(join(root, "index.db"), sessions);
	const gate = Promise.withResolvers<void>();
	discovery.path = sessions;
	discovery.wait = gate.promise;
	try {
		const response = await index.searchFresh("memo");
		expect(response.results).toEqual([]);
		expect(response.indexing).not.toBeNull();
		gate.resolve();
		discovery.wait = null;
		await index.refresh();
		expect(index.search("memo").results[0]?.hits.map(hit => hit.entryId)).toEqual(["u1"]);
		expect(index.search("memo").indexing).toBeNull();
	} finally {
		gate.resolve();
		discovery.wait = null;
		await index.close();
		await rm(root, { recursive: true, force: true });
	}
});
