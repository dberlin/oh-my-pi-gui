import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** GUI-owned workspace for Work mode. It runs the full agent, never --chat. */
export function ensureDefaultWorkspace(): string {
	const cwd = path.join(os.homedir(), ".omp", "work");
	fs.mkdirSync(cwd, { recursive: true });
	return cwd;
}
