#!/usr/bin/env bun
/**
 * Build the GUI's bundled (built-in) omp sidecar binary.
 *
 * Produces a self-contained `resources/omp` executable from the omp monorepo's
 * coding-agent source via compileCodingAgent (Bun.build --compile). The native
 * addon archive is embedded as an asset, so the binary needs no external omp,
 * no node_modules, and no bun runtime — the GUI spawns it as its dedicated
 * sidecar. The packaged GUI NEVER falls back to a system-installed omp
 * (src/main/index.ts resolveBundledOmp).
 *
 * REQUIRES the omp monorepo: this file resolves `../../coding-agent` and
 * `../../natives` relative to packages/gui, so the GUI repo must sit at
 * `packages/gui/` inside a monorepo checkout (the nested-layout contract in
 * AGENTS.md). A standalone GUI clone can package only by dropping a prebuilt
 * sidecar into resources/ — see README → Build from source.
 *
 * What it does:
 *   1. Verifies the monorepo neighbors exist (fails with setup instructions).
 *   2. Ensures the native addon (.node) for the TARGET arch is staged in
 *      packages/natives/native/ — downloads the published leaf package
 *      (@oh-my-pi/pi-natives-<tag>@<version>) on a cache miss.
 *   3. Re-embeds the addon (natives gen:native) for the target arch.
 *   4. Compiles the coding-agent entrypoint into a single executable.
 *   5. Restores embedded-addon.js to the stub (tracked file stays clean).
 *
 * Usage (from packages/gui):
 *   bun run build:omp                                             # host arch → resources/omp
 *   bun run build:omp --target bun-darwin-x64 --out resources/omp.x64   # Intel cross-build
 *
 * After upgrading the monorepo (upstream sync), run scripts/sync-upstream.sh
 * instead — it re-provisions natives and rebuilds end-to-end.
 */
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import { compileCodingAgent } from "../../coding-agent/scripts/compile-binary";

const guiRoot = path.join(import.meta.dir, "..");
const repoRoot = path.join(guiRoot, "..", "..");
const nativesDir = path.join(repoRoot, "packages", "natives");
const nativesNativeDir = path.join(nativesDir, "native");

// ---------------------------------------------------------------------------
// Target arch → sidecar output + native addon provisioning
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
	const i = args.indexOf(flag);
	return i >= 0 ? args[i + 1] : undefined;
};

interface SidecarTarget {
	/** Bun --compile target (undefined = host). */
	readonly target?: Bun.Build.CompileTarget;
	/** pi-natives platform tag, e.g. darwin-arm64. */
	readonly platformTag: string;
	/** Default output path under packages/gui/resources/. */
	readonly out: string;
	/** Addon filenames the embed step looks for, in preference order. */
	readonly addonFilenames: readonly string[];
}

function resolveTarget(): SidecarTarget {
	const targetFlag = argValue("--target");
	if (!targetFlag || targetFlag === `bun-${process.platform}-${process.arch}`) {
		const platformTag = `${process.platform}-${process.arch}`;
		return {
			platformTag,
			out: path.join(guiRoot, "resources", "omp"),
			addonFilenames:
				process.arch === "x64"
					? [`pi_natives.${platformTag}-modern.node`, `pi_natives.${platformTag}-baseline.node`]
					: [`pi_natives.${platformTag}.node`],
		};
	}
	const match = /^bun-(darwin|linux|win32)-(arm64|x64)(?:-.*)?$/.exec(targetFlag);
	if (!match) {
		throw new Error(`Unsupported --target '${targetFlag}'. Expected bun-<os>-<arch> (e.g. bun-darwin-x64).`);
	}
	const platformTag = `${match[1]}-${match[2]}`;
	const arch = match[2];
	return {
		target: targetFlag as Bun.Build.CompileTarget,
		platformTag,
		out: path.join(guiRoot, "resources", `omp.${arch}`),
		addonFilenames:
			arch === "x64"
				? [`pi_natives.${platformTag}-modern.node`, `pi_natives.${platformTag}-baseline.node`]
				: [`pi_natives.${platformTag}.node`],
	};
}

// ---------------------------------------------------------------------------
// Prerequisite checks — fail with an actionable message, not an import error
// ---------------------------------------------------------------------------

async function assertMonorepo(): Promise<void> {
	const missing: string[] = [];
	for (const rel of ["packages/coding-agent/src/cli.ts", "packages/natives/scripts/embed-native.ts"]) {
		if (!(await Bun.file(path.join(repoRoot, rel)).exists())) missing.push(rel);
	}
	if (missing.length === 0) return;
	throw new Error(
		[
			"build-bundled-omp must run inside the omp monorepo (GUI repo at packages/gui/).",
			`Missing: ${missing.join(", ")}`,
			"",
			"Set up the nested checkout:",
			"  git clone https://github.com/can1357/oh-my-pi.git omp-monorepo",
			"  cd omp-monorepo/packages && git clone https://github.com/nornzach/oh-my-pi-gui.git gui",
			"  cd gui && bun install",
			"",
			"Or, to package without the monorepo, copy a prebuilt sidecar into resources/omp",
			"(and resources/omp.x64 for Intel) and skip this script — see README → Build from source.",
		].join("\n"),
	);
}

// ---------------------------------------------------------------------------
// Native addon provisioning (embed step needs the .node file staged locally)
// ---------------------------------------------------------------------------

const nativesPkg = (await Bun.file(path.join(nativesDir, "package.json")).json()) as { version: string };

/** Filenames we staged that did NOT exist before — removed after the build so the monorepo tree stays clean. */
const addedByUs: string[] = [];
/** Pre-existing files we overwrote with the matching-version addon — restored after the build. */
const replacedByUs = new Map<string, Uint8Array>();

/**
 * The loader rejects a .node whose exported version sentinel doesn't match the
 * package version, so a stale addon from an older release must be replaced
 * rather than reused. The sentinel string (`__piNativesV<underscored>`) is
 * emitted by the napi build into the binary.
 */
async function addonMatchesVersion(filePath: string): Promise<boolean> {
	const sentinel = `__piNativesV${nativesPkg.version.replace(/\./g, "_")}`;
	const buffer = Buffer.from(await Bun.file(filePath).arrayBuffer());
	return buffer.includes(sentinel);
}

async function stageNativeAddon(target: SidecarTarget): Promise<void> {
	for (const filename of target.addonFilenames) {
		const local = path.join(nativesNativeDir, filename);
		if ((await Bun.file(local).exists()) && (await addonMatchesVersion(local))) return;
	}
	// Stale or missing: snapshot any pre-existing files so they can be restored,
	// then fall through to provisioning the matching version.
	for (const filename of target.addonFilenames) {
		const local = path.join(nativesNativeDir, filename);
		if (await Bun.file(local).exists()) {
			replacedByUs.set(filename, Buffer.from(await Bun.file(local).arrayBuffer()));
			console.log(`[build:omp] replacing stale addon ${filename} (version sentinel ≠ ${nativesPkg.version})`);
		}
	}
	const leafPackage = `@oh-my-pi/pi-natives-${target.platformTag}`;
	console.log(`[build:omp] staging ${leafPackage}@${nativesPkg.version} (target ${target.platformTag})`);
	const cacheDir = path.join(osTmp(), `omp-natives-${target.platformTag}-${nativesPkg.version}`);
	const installDir = path.join(cacheDir, "node_modules", "@oh-my-pi", `pi-natives-${target.platformTag}`);
	if (!(await Bun.file(path.join(installDir, "package.json")).exists())) {
		await fs.mkdir(cacheDir, { recursive: true });
		await Bun.write(
			path.join(cacheDir, "package.json"),
			JSON.stringify({ name: "omp-natives-cache", private: true }),
		);
		// Pin the official registry: bun's platform-specific leaf packages do not
		// materialize from every mirror, and an empty install here would silently
		// produce a sidecar with no native addon. Cross-arch staging must also
		// simulate the target platform or bun skips the foreign-cpu tarball.
		const [targetOs, targetCpu] = target.platformTag.split("-");
		const proc = Bun.spawn(
			[
				process.execPath,
				"add",
				"--no-cache",
				"--registry=https://registry.npmjs.org",
				`--os=${targetOs}`,
				`--cpu=${targetCpu}`,
				`${leafPackage}@${nativesPkg.version}`,
			],
			{ cwd: cacheDir, stdout: "inherit", stderr: "inherit" },
		);
		const exit = await proc.exited;
		if (exit !== 0) {
			throw new Error(
				[
					`Failed to download ${leafPackage}@${nativesPkg.version} (exit ${exit}).`,
					"Either publish/avail that natives version, or build the addon from source:",
					"  bun --cwd=packages/natives run build   # requires the Rust toolchain",
					`then re-run this script (expects ${target.addonFilenames.join(" / ")} in packages/natives/native/).`,
				].join("\n"),
			);
		}
	}
	let stagedCount = 0;
	for (const filename of target.addonFilenames) {
		const src = path.join(installDir, filename);
		if (await Bun.file(src).exists()) {
			if (!replacedByUs.has(filename)) addedByUs.push(filename);
			await Bun.write(path.join(nativesNativeDir, filename), Bun.file(src));
			stagedCount++;
		}
	}
	if (stagedCount === 0) {
		throw new Error(
			`${leafPackage}@${nativesPkg.version} installed but contains none of: ${target.addonFilenames.join(", ")}`,
		);
	}
}

function osTmp(): string {
	return process.env.TMPDIR ?? "/tmp";
}

/** Undo the staging writes: remove files we added, restore files we overwrote. */
async function restoreStagedAddons(): Promise<void> {
	for (const filename of addedByUs) {
		await fs.rm(path.join(nativesNativeDir, filename), { force: true });
	}
	for (const [filename, original] of replacedByUs) {
		await Bun.write(path.join(nativesNativeDir, filename), original);
	}
}

// ---------------------------------------------------------------------------
// Embed → compile → restore stub
// ---------------------------------------------------------------------------

async function embedNativeForTarget(target: SidecarTarget): Promise<void> {
	const env =
		target.platformTag === `${process.platform}-${process.arch}`
			? undefined
			: { TARGET_PLATFORM: target.platformTag.split("-")[0]!, TARGET_ARCH: target.platformTag.split("-")[1]! };
	const proc = Bun.spawn([process.execPath, "run", "gen:native"], {
		cwd: nativesDir,
		stdout: "inherit",
		stderr: "inherit",
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
	if ((await proc.exited) !== 0) throw new Error("natives gen:native failed");
}

async function restoreEmbeddedStub(): Promise<void> {
	const proc = Bun.spawn([process.execPath, "run", "gen:native:reset"], {
		cwd: nativesDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await proc.exited) !== 0) throw new Error("natives gen:native:reset failed");
}

// ---------------------------------------------------------------------------

await assertMonorepo();
const target = resolveTarget();
const out = argValue("--out") ?? target.out;

const require = createRequire(import.meta.url);
const transformersVersion = (require("@huggingface/transformers/package.json") as { version?: string }).version;
if (!transformersVersion) throw new Error("@huggingface/transformers package.json has no version");

await stageNativeAddon(target);
await embedNativeForTarget(target);
try {
	await compileCodingAgent({
		repoRoot,
		entrypoint: path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts"),
		outfile: out,
		transformersVersion,
		...(target.target ? { target: target.target } : {}),
	});
} finally {
	// embedded-addon.js is tracked; leave the checkout in the stub state so the
	// archive never shows up as a monorepo diff. Staged .node files are
	// untracked artifacts too — remove the ones we copied in.
	await restoreEmbeddedStub();
	await restoreStagedAddons();
}

console.log(`built bundled omp → ${out}${target.target ? ` (target ${target.target})` : ""}`);
