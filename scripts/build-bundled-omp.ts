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
 * REQUIRES vanilla can1357/oh-my-pi source: this file resolves the sibling
 * `packages/coding-agent` and `packages/natives` from the monorepo root, so
 * the GUI repo must sit at `packages/gui/` (the nested-layout contract in
 * AGENTS.md). A standalone GUI clone can package only by dropping a prebuilt
 * sidecar into resources/ — see README → Build from source. The compile-binary
 * import is dynamic precisely so this prerequisite failure prints setup
 * instructions instead of a bare module-not-found.
 *
 * What it does:
 *   1. Verifies the monorepo neighbors exist (fails with setup instructions).
 *   2. Ensures the native addon (.node) for the TARGET arch is staged in
 *      packages/natives/native/ — reuses matching local or installed addons,
 *      otherwise downloads the official published leaf package
 *      (@oh-my-pi/pi-natives-<tag>@<version>). Accepts current and legacy stamps.
 *   3. Generates the stats dashboard archive, collab tool views, and native
 *      addon assets required by a self-contained compiled binary.
 *   4. Compiles the GUI entry (vanilla CLI plus private embedded stats selector).
 *   5. Restores temporary generated assets and addon staging, so the monorepo
 *      tree is left in its normal development state.
 *
 * Usage (from packages/gui):
 *   bun run build:omp                                       # host arch → resources/omp
 *   bun run build:omp:x64                                   # Intel cross-build → resources/omp.x64
 *   bun scripts/build-bundled-omp.ts --target bun-darwin-x64 --out custom/path
 *   bun scripts/build-bundled-omp.ts --target bun-windows-x64-baseline # → resources/omp.exe
 *
 * After upgrading vanilla upstream source, re-run this script.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { copyNativeCompanions } from "./native-companion";

const guiRoot = path.join(import.meta.dir, "..");
const repoRoot = path.join(guiRoot, "..", "..");
const codingAgentDir = path.join(repoRoot, "packages", "coding-agent");
const statsDir = path.join(repoRoot, "packages", "stats");
const collabWebDir = path.join(repoRoot, "packages", "collab-web");
const nativesDir = path.join(repoRoot, "packages", "natives");
const nativesNativeDir = path.join(nativesDir, "native");
const compileBinaryModulePath = path.join(codingAgentDir, "scripts", "compile-binary.ts");

// ---------------------------------------------------------------------------
// Prerequisite — actionable failure, not a module-resolution stack trace
// ---------------------------------------------------------------------------

if (!existsSync(compileBinaryModulePath) || !existsSync(path.join(nativesDir, "scripts", "embed-native.ts"))) {
	console.error(
		[
			"",
			"  build:omp cannot find the omp monorepo next to this checkout.",
			"",
			"  This script compiles the GUI's bundled agent sidecar from monorepo source,",
			"  so the GUI repo must sit at packages/gui/ inside a monorepo clone:",
			"",
			"    git clone https://github.com/can1357/oh-my-pi.git omp-monorepo",
			"    cd omp-monorepo && bun install",
			"    cd packages && git clone https://github.com/nornzach/oh-my-pi-gui.git gui",
			"    cd gui && bun install",
			"",
			"  To package WITHOUT the monorepo, copy a prebuilt sidecar into resources/omp",
			"  (and resources/omp.x64 for Intel) and skip this script — see README → Build from source.",
			"",
		].join("\n"),
	);
	process.exit(1);
}

const monorepoPackage = (await Bun.file(path.join(repoRoot, "package.json")).json()) as { packageManager: string };
const bunRequirement = monorepoPackage.packageManager.replace(/^bun@/, "");
if (!Bun.semver.satisfies(Bun.version, bunRequirement)) {
	throw new Error(`Building the bundled agent requires Bun ${bunRequirement}; running ${Bun.version}.`);
}

await runPackageScript(guiRoot, "check:protocol");

// Runtime-selected module: only resolvable inside the monorepo layout proven
// above, so a static import would crash standalone clones before the guidance.
const { compileCodingAgent } = await import(compileBinaryModulePath);
// Like compile-binary, this sibling module is absent in standalone GUI clones;
// load it only after the monorepo prerequisite has printed actionable guidance.
const { containsVersionStamp, containsLegacyVersionSentinel } = await import(
	path.join(nativesNativeDir, "version-sentinel.js")
);

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

function addonFilenamesFor(platformTag: string): readonly string[] {
	return platformTag.endsWith("-x64")
		? [`pi_natives.${platformTag}-modern.node`, `pi_natives.${platformTag}-baseline.node`]
		: [`pi_natives.${platformTag}.node`];
}

function sidecarOutName(osName: string, arch: string): string {
	if (osName === "win32" || osName === "windows") return "omp.exe";
	return arch === "x64" ? `omp.${arch}` : "omp";
}

function resolveTarget(): SidecarTarget {
	const targetFlag = argValue("--target");
	if (!targetFlag || targetFlag === `bun-${process.platform}-${process.arch}`) {
		const platformTag = `${process.platform}-${process.arch}`;
		return {
			platformTag,
			out: path.join(guiRoot, "resources", process.platform === "win32" ? "omp.exe" : "omp"),
			addonFilenames: addonFilenamesFor(platformTag),
		};
	}
	const match = /^bun-(darwin|linux|win32|windows)-(arm64|x64)(?:-.*)?$/.exec(targetFlag);
	if (!match) {
		throw new Error(
			`Unsupported --target '${targetFlag}'. Expected bun-<os>-<arch> (e.g. bun-windows-x64-baseline).`,
		);
	}
	const osName = match[1] === "windows" ? "win32" : match[1]!;
	const arch = match[2]!;
	const platformTag = `${osName}-${arch}`;
	const bunTarget = targetFlag.replace("bun-win32-", "bun-windows-") as Bun.Build.CompileTarget;
	return {
		target: bunTarget,
		platformTag,
		out: path.join(guiRoot, "resources", sidecarOutName(osName, arch)),
		addonFilenames: addonFilenamesFor(platformTag),
	};
}

// ---------------------------------------------------------------------------
// Native addon provisioning (embed step needs the .node file staged locally)
// ---------------------------------------------------------------------------

const nativesPkg = (await Bun.file(path.join(nativesDir, "package.json")).json()) as { version: string };

/** Filenames we staged that did NOT exist before — removed after the build so the monorepo tree stays clean. */
const addedByUs: string[] = [];
/** Pre-existing files we overwrote with the matching-version addon — restored after the build. */
const replacedByUs: Record<string, Uint8Array> = {};

/** Match the release identity checks used by vanilla's native embed pipeline. */
async function addonMatchesVersion(filePath: string): Promise<boolean> {
	const bytes = await Bun.file(filePath).bytes();
	return containsVersionStamp(bytes, nativesPkg.version) || containsLegacyVersionSentinel(bytes, nativesPkg.version);
}

async function stageNativeAddon(target: SidecarTarget): Promise<void> {
	let matchingLocalCount = 0;
	for (const filename of target.addonFilenames) {
		const local = path.join(nativesNativeDir, filename);
		if (!(await Bun.file(local).exists())) continue;
		if (await addonMatchesVersion(local)) {
			matchingLocalCount++;
		} else {
			replacedByUs[filename] = await Bun.file(local).bytes();
			console.log(`[build:omp] removing stale addon ${filename} (release identity ≠ ${nativesPkg.version})`);
			// Every present variant is validated by gen:native. A valid baseline
			// must not leave a stale modern sibling in the embedding candidates.
			await fs.rm(local);
		}
	}
	if (matchingLocalCount > 0) return;

	const leafPackage = `@oh-my-pi/pi-natives-${target.platformTag}`;
	const require = createRequire(path.join(nativesDir, "package.json"));
	let installedDir: string | undefined;
	try {
		installedDir = path.dirname(require.resolve(`${leafPackage}/package.json`));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "MODULE_NOT_FOUND")) throw error;
	}
	if (installedDir && (await stageNativeFiles(installedDir, target)) > 0) return;
	console.log(`[build:omp] staging ${leafPackage}@${nativesPkg.version} (target ${target.platformTag})`);
	const cacheDir = path.join(process.env.TMPDIR ?? "/tmp", `omp-natives-${target.platformTag}-${nativesPkg.version}`);
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
					"Either make that official natives release available, or build the addon from vanilla source:",
					"  bun --cwd=packages/natives run build   # requires the upstream Bazel/Rust toolchain",
					`then re-run this script (expects ${target.addonFilenames.join(" / ")} in packages/natives/native/).`,
				].join("\n"),
			);
		}
	}
	if ((await stageNativeFiles(installDir, target)) === 0) {
		throw new Error(
			`${leafPackage}@${nativesPkg.version} installed but contains no matching-release addon among: ${target.addonFilenames.join(", ")}`,
		);
	}
}

async function stageNativeFiles(directory: string, target: SidecarTarget): Promise<number> {
	let stagedCount = 0;
	for (const filename of target.addonFilenames) {
		const src = path.join(directory, filename);
		if ((await Bun.file(src).exists()) && (await addonMatchesVersion(src))) {
			if (!(filename in replacedByUs)) addedByUs.push(filename);
			await Bun.write(path.join(nativesNativeDir, filename), Bun.file(src));
			stagedCount++;
		}
	}
	return stagedCount;
}

/** Undo the staging writes: remove files we added, restore files we overwrote. */
async function restoreStagedAddons(): Promise<void> {
	const results = await Promise.allSettled([
		...addedByUs.map(filename => fs.rm(path.join(nativesNativeDir, filename), { force: true })),
		...Object.entries(replacedByUs).map(([filename, original]) =>
			Bun.write(path.join(nativesNativeDir, filename), original),
		),
	]);
	const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
	if (errors.length > 0) throw new AggregateError(errors, "Native addon staging restoration failed");
}

// ---------------------------------------------------------------------------
// Embed → compile → restore originals
// ---------------------------------------------------------------------------

async function runPackageScript(cwd: string, script: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const proc = Bun.spawn([process.execPath, "run", script], {
		cwd,
		env,
		stdout: "inherit",
		stderr: "inherit",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`${script} failed with exit code ${exitCode}`);
}

async function signMacBinary(filePath: string): Promise<void> {
	const proc = Bun.spawn(
		[
			"/usr/bin/codesign",
			"--force",
			"--sign",
			"-",
			"--entitlements",
			path.join(repoRoot, "scripts", "macos-entitlements.plist"),
			filePath,
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error(`codesign failed with exit code ${exitCode}`);
}

async function embedNativeForTarget(target: SidecarTarget): Promise<void> {
	const env = {
		...process.env,
		TARGET_PLATFORM: target.platformTag.split("-")[0]!,
		TARGET_ARCH: target.platformTag.split("-")[1]!,
	};
	await runPackageScript(nativesDir, "gen:native", env);
}

/**
 * Preserve the caller's generated state, not just upstream's empty stubs.
 * The stats build also replaces dist/client; tool-view generation has no reset.
 */
async function snapshotGeneratedAssets(target: SidecarTarget): Promise<() => Promise<void>> {
	const paths = [
		path.join(nativesNativeDir, "embedded-addon.js"),
		path.join(nativesNativeDir, `embedded-addons.${target.platformTag}.tar.gz`),
		path.join(statsDir, "src", "embedded-client.generated.txt"),
		path.join(statsDir, "dist", "client"),
		path.join(codingAgentDir, "src", "export", "html", "tool-views.generated.js"),
	];
	const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-build-assets-"));
	const snapshots: { original: string; backup?: string }[] = [];
	try {
		for (const [index, original] of paths.entries()) {
			try {
				await fs.lstat(original);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				snapshots.push({ original });
				continue;
			}
			const backup = path.join(backupDir, String(index));
			await fs.cp(original, backup, { recursive: true });
			snapshots.push({ original, backup });
		}
	} catch (error) {
		await fs.rm(backupDir, { recursive: true, force: true });
		throw error;
	}
	return async () => {
		const results = await Promise.allSettled(
			snapshots.map(async ({ original, backup }) => {
				await fs.rm(original, { recursive: true, force: true });
				if (backup) await fs.cp(backup, original, { recursive: true });
			}),
		);
		const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
		if (errors.length > 0) {
			throw new AggregateError(errors, `Generated asset restoration failed; originals remain in ${backupDir}`);
		}
		await fs.rm(backupDir, { recursive: true, force: true });
	};
}

// ---------------------------------------------------------------------------

const target = resolveTarget();
const out = path.resolve(argValue("--out") ?? target.out);
const shouldAdhocSign = process.platform === "darwin" && (!target.target || target.platformTag.startsWith("darwin-"));

const require = createRequire(path.join(codingAgentDir, "package.json"));
const transformersVersion = (require("@huggingface/transformers/package.json") as { version?: string }).version;
if (!transformersVersion) throw new Error("@huggingface/transformers package.json has no version");

const restoreGeneratedAssets = await snapshotGeneratedAssets(target);
try {
	try {
		await stageNativeAddon(target);
		await fs.mkdir(path.dirname(out), { recursive: true });
		await runPackageScript(statsDir, "gen:stats");
		await runPackageScript(collabWebDir, "gen:tool-views");
		await embedNativeForTarget(target);
		await compileCodingAgent({
			repoRoot,
			entrypoint: path.join(guiRoot, "scripts", "bundled-omp-entry.ts"),
			outfile: out,
			transformersVersion,
			...(target.target ? { target: target.target } : {}),
			skipBuiltinCodesign: shouldAdhocSign,
		});
		if (shouldAdhocSign) await signMacBinary(out);
		const companions = await copyNativeCompanions({
			nativeDir: nativesNativeDir,
			output: out,
			filenames: target.addonFilenames,
		});
		console.log(`[build:omp] staged native companion${companions.length === 1 ? "" : "s"}: ${companions.join(", ")}`);
	} finally {
		// Restore every generated family, including pre-existing content, even
		// when staging, generation, compilation, signing, or copying fails.
		await restoreGeneratedAssets();
	}
} finally {
	// Staged .node files are untracked artifacts: remove files we added and
	// restore any local matching-path addon that predated this build.
	await restoreStagedAddons();
}

console.log(`built bundled omp → ${out}${target.target ? ` (target ${target.target})` : ""}`);
