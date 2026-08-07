import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionIndex } from "./session-index";

const tempDirs: string[] = [];

async function makeIndex(): Promise<{ index: SessionIndex; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-session-index-"));
	tempDirs.push(dir);
	return { index: new SessionIndex(dir, dir), dir };
}

/** Minimal on-disk session: title-slot line, then the header line (the layout SessionIndex parses). */
async function writeSession(dir: string, id: string, kind?: "chat"): Promise<string> {
	// #scanDir only collects <sessionsDir>/<projectDir>/*.jsonl.
	const projectDir = path.join(dir, "project-x");
	await fs.mkdir(projectDir, { recursive: true });
	const file = path.join(projectDir, `${id}.jsonl`);
	const slot = `${JSON.stringify({ updatedAt: new Date().toISOString() })}\n`;
	const header = {
		type: "session",
		version: 3,
		id,
		timestamp: new Date().toISOString(),
		cwd: dir,
		...(kind ? { kind } : {}),
	};
	await fs.writeFile(file, `${slot}${JSON.stringify(header)}\n`);
	return file;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("SessionIndex session kind", () => {
	it("reads kind from the session header into SessionInfo, absent on legacy files", async () => {
		const { index, dir } = await makeIndex();
		await writeSession(dir, "chat-one", "chat");
		await writeSession(dir, "agent-one");

		const infos = await index.list("global");
		expect(infos.find(info => info.id === "chat-one")?.kind).toBe("chat");
		expect(infos.find(info => info.id === "agent-one")?.kind).toBeUndefined();
	});

	it("kindFor cold-reads a single file and degrades unreadable files to agent", async () => {
		const { index, dir } = await makeIndex();
		const chatFile = await writeSession(dir, "chat-two", "chat");
		const agentFile = await writeSession(dir, "agent-two");

		expect(await index.kindFor(chatFile)).toBe("chat");
		expect(await index.kindFor(agentFile)).toBe("agent");
		expect(await index.kindFor(path.join(dir, "missing.jsonl"))).toBe("agent");
	});
});
