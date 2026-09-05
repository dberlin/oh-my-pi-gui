import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AfterPackContext, Configuration, Hook } from "app-builder-lib";
import { getConfig } from "app-builder-lib/out/util/config/config";
import { type PlistObject, parsePlistFile, savePlistFile } from "app-builder-lib/out/util/plist";
import { resolveFunction } from "app-builder-lib/out/util/resolve";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.join(__dirname, "..", "..");

async function macConfigs(): Promise<{ file: string; config: Configuration }[]> {
	const configs = await Promise.all(
		fs
			.readdirSync(PACKAGE_ROOT)
			.filter(name => /^electron-builder.*\.yml$/.test(name))
			.map(async file => ({
				file,
				config: await getConfig(PACKAGE_ROOT, file, undefined),
			})),
	);
	return configs.filter(entry => entry.config.mac?.target != null);
}

describe("mac bundle configs", () => {
	it("registers the omp:// scheme that src/main/deep-link.ts handles", async () => {
		for (const { file, config } of await macConfigs()) {
			const protocols =
				config.protocols == null ? [] : Array.isArray(config.protocols) ? config.protocols : [config.protocols];
			const schemes = protocols.flatMap(protocol => protocol.schemes);
			expect(schemes, `${file} ships no URL scheme`).toContain("omp");
		}
	});

	it("restores ATS in the completed bundle after electron-builder enables arbitrary loads", async () => {
		const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-bundle-policy-"));
		const plistPath = path.join(directory, "omp.app", "Contents", "Info.plist");
		const loopback = { NSExceptionAllowsInsecureHTTPLoads: true };
		const original: PlistObject = {
			CFBundleIdentifier: "sh.omp.gui",
			CFBundleURLTypes: [{ CFBundleURLSchemes: ["omp"] }],
			NSAppTransportSecurity: {
				NSAllowsArbitraryLoads: true,
				NSAllowsLocalNetworking: true,
				NSExceptionDomains: { localhost: loopback, "127.0.0.1": loopback },
			},
		};
		try {
			await fs.promises.mkdir(path.dirname(plistPath), { recursive: true });
			for (const { file, config } of await macConfigs()) {
				await savePlistFile(plistPath, original);
				if (!config.afterPack) throw new Error(`${file} declares no afterPack policy hook`);
				const afterPack = await resolveFunction<Hook<AfterPackContext, void>>(
					undefined,
					config.afterPack,
					"afterPack",
					PACKAGE_ROOT,
				);
				await afterPack({ electronPlatformName: "darwin", appOutDir: directory } as AfterPackContext);
				expect(await parsePlistFile(plistPath), `${file} leaves arbitrary loads enabled in the bundle`).toEqual({
					...original,
					NSAppTransportSecurity: {
						NSAllowsArbitraryLoads: false,
						NSAllowsLocalNetworking: true,
						NSExceptionDomains: { localhost: loopback, "127.0.0.1": loopback },
					},
				});
			}
		} finally {
			await fs.promises.rm(directory, { recursive: true, force: true });
		}
	});
});

describe("Windows package config", () => {
	it("ships a Windows sidecar and both x64 installer targets", async () => {
		const file = "electron-builder.win.yml";
		const config = await getConfig(PACKAGE_ROOT, file, undefined);
		const protocols =
			config.protocols == null ? [] : Array.isArray(config.protocols) ? config.protocols : [config.protocols];
		expect(protocols.flatMap(protocol => protocol.schemes), `${file} ships no URL scheme`).toContain("omp");
		expect(config.extraResources).toContainEqual({ from: "resources/omp.exe", to: "omp.exe" });
		expect(config.win?.target).toEqual([
			{ target: "nsis", arch: ["x64"] },
			{ target: "portable", arch: ["x64"] },
		]);
	});
});

/**
 * The shipped CSP is the only thing between model output and an outbound
 * request, and nothing in the renderer enforces it — so it is read back off the
 * HTML head that actually ships.
 */
describe("renderer content security policy", () => {
	function sources(directive: string): string[] {
		const html = fs.readFileSync(path.join(PACKAGE_ROOT, "src/renderer/index.html"), "utf8");
		const content = /http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/.exec(html)?.[1];
		if (!content) throw new Error("index.html declares no Content-Security-Policy");
		const entry = content
			.split(";")
			.map(part => part.trim())
			.find(part => part.split(" ")[0] === directive);
		if (!entry) throw new Error(`CSP declares no ${directive}`);
		return entry.split(" ").slice(1);
	}

	it("cannot fetch a remote image for markdown a model wrote", () => {
		// Explicit, not inherited: without img-src the policy falls back to
		// default-src, and a later relaxation there would silently re-open this.
		expect(sources("img-src")).toEqual(["'self'", "data:", "blob:"]);
	});

	it("keeps script execution and network calls inside the app", () => {
		expect(sources("script-src")).toEqual(["'self'"]);
		expect(sources("connect-src")).toEqual(["'self'"]);
	});
});
