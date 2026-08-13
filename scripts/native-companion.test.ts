import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyNativeCompanions } from "./native-companion.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("copyNativeCompanions", () => {
	it("copies every target native addon beside the compiled sidecar", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-companion-"));
		temporaryDirectories.push(root);
		const nativeDir = path.join(root, "native");
		const output = path.join(root, "resources", "omp.x64");
		await fs.mkdir(nativeDir, { recursive: true });
		await fs.writeFile(path.join(nativeDir, "pi_natives.darwin-x64-modern.node"), "modern");
		await fs.writeFile(path.join(nativeDir, "pi_natives.darwin-x64-baseline.node"), "baseline");

		const copied = await copyNativeCompanions({
			nativeDir,
			output,
			filenames: ["pi_natives.darwin-x64-modern.node", "pi_natives.darwin-x64-baseline.node"],
		});

		expect(copied).toEqual([
			path.join(root, "resources", "pi_natives.darwin-x64-modern.node"),
			path.join(root, "resources", "pi_natives.darwin-x64-baseline.node"),
		]);
		expect(await fs.readFile(copied[0], "utf8")).toBe("modern");
		expect(await fs.readFile(copied[1], "utf8")).toBe("baseline");
	});

	it("skips unavailable CPU variants when the package publishes only one", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-companion-"));
		temporaryDirectories.push(root);
		const nativeDir = path.join(root, "native");
		const output = path.join(root, "resources", "omp.x64");
		await fs.mkdir(nativeDir, { recursive: true });
		await fs.writeFile(path.join(nativeDir, "pi_natives.darwin-x64-baseline.node"), "baseline");

		const copied = await copyNativeCompanions({
			nativeDir,
			output,
			filenames: ["pi_natives.darwin-x64-modern.node", "pi_natives.darwin-x64-baseline.node"],
		});

		expect(copied).toEqual([path.join(root, "resources", "pi_natives.darwin-x64-baseline.node")]);
	});
});
