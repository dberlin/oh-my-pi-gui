import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { $, Glob } from "bun";
import { POST_PATHS, VALID_PATHS } from "../src/main/stats-client";
import { checkStatsRoutes, parseStatsRoutes, rendererStatsPaths } from "./protocol/stats-routes";

const root = path.resolve(import.meta.dir, "../../..");
const protocolDir = path.join(import.meta.dir, "protocol");
const coreRpc = path.join(root, "packages/coding-agent/src/modes/rpc/rpc-types.ts");
const statsTypes = path.join(root, "packages/stats/src/types.ts");
if (!(await Bun.file(coreRpc).exists())) {
	throw new Error(
		"Protocol verification requires the adjacent vanilla coding-agent source used to build the bundled sidecar.",
	);
}

interface PackageManifest {
	name: string;
	types?: string;
	main?: string;
	exports?: string | Record<string, unknown>;
}

/** Follow the package's real type export, including nested conditional exports. */
function typeExport(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return undefined;
	for (const condition of ["types", "import", "default", "bun"]) {
		if (condition in value) {
			const target = typeExport((value as Record<string, unknown>)[condition]);
			if (target) return target;
		}
	}
	return undefined;
}

const stage = await mkdtemp(path.join(tmpdir(), "omp-gui-protocol-"));
let contractExitCode = 1;
try {
	await symlink(path.join(root, "node_modules"), path.join(stage, "node_modules"), "dir");
	const declarations = path.join(stage, "declarations");
	const compiler = path.join(root, "node_modules/.bin/tsgo");
	const emitConfig = path.join(stage, "emit.json");
	// Emit the actual producer declarations, not replacement types. Checking its
	// unrelated CLI implementation is the upstream project's responsibility.
	// noCheck applies ONLY to this declaration emission; GUI contracts below are strict.
	await Bun.write(
		emitConfig,
		JSON.stringify({
			extends: path.join(root, "tsconfig.base.json"),
			compilerOptions: {
				noEmit: false,
				noCheck: true,
				declaration: true,
				emitDeclarationOnly: true,
				rootDir: root,
				outDir: declarations,
			},
			files: [coreRpc, statsTypes],
		}),
	);
	const emitted = await $`${compiler} -p ${emitConfig}`.nothrow();
	if (emitted.exitCode === 0) {
		const declarationPath = (source: string) =>
			path.join(declarations, path.relative(root, source)).replace(/\.(?:[cm]?ts|tsx)$/, ".d.ts");
		const paths: Record<string, string[]> = {
			"omp-core-rpc": [declarationPath(coreRpc)],
			"omp-stats": [declarationPath(statsTypes)],
		};
		// Upstream declarations retain workspace package imports. Resolve those to
		// the emitted declarations too, never back to unchecked implementation bodies.
		for await (const file of new Glob("packages/*/package.json").scan(root)) {
			const manifest = (await Bun.file(path.join(root, file)).json()) as PackageManifest;
			const packageDir = path.dirname(path.join(root, file));
			const exports =
				typeof manifest.exports === "object"
					? manifest.exports
					: { ".": manifest.exports ?? manifest.types ?? manifest.main };
			for (const [subpath, value] of Object.entries(exports)) {
				const target = typeExport(value);
				if (!target || !subpath.startsWith(".")) continue;
				const key = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
				paths[key] = [declarationPath(path.resolve(packageDir, target))];
			}
		}
		const checkConfig = path.join(stage, "check.json");
		await Bun.write(
			checkConfig,
			JSON.stringify({
				extends: path.join(protocolDir, "tsconfig.json"),
				compilerOptions: { noCheck: false, noEmit: true, paths },
				files: ["contract.ts", "stats-contract.ts", "contract.test-types.ts"].map(file =>
					path.join(protocolDir, file),
				),
			}),
		);
		const checked = await $`${compiler} -p ${checkConfig} --noEmit`.nothrow();
		contractExitCode = checked.exitCode;
	} else {
		contractExitCode = emitted.exitCode;
	}
} finally {
	await rm(stage, { recursive: true, force: true });
}

const rendererDir = path.join(import.meta.dir, "../src/renderer");
const rendererPaths: string[] = [];
for await (const file of new Glob("**/*.{ts,tsx}").scan(rendererDir)) {
	if (/\.test\.tsx?$/.test(file)) continue;
	rendererPaths.push(...rendererStatsPaths(await Bun.file(path.join(rendererDir, file)).text()));
}
const routeErrors = checkStatsRoutes(
	parseStatsRoutes(await Bun.file(path.join(root, "packages/stats/src/server.ts")).text()),
	{ validPaths: Object.keys(VALID_PATHS), postPaths: Object.keys(POST_PATHS), rendererPaths },
);
for (const error of routeErrors) console.error(`stats contract: ${error}`);

process.exitCode = contractExitCode || (routeErrors.length > 0 ? 1 : 0);
