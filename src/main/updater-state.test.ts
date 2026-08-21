import { describe, expect, it } from "vitest";
import { hasStableMacSigningIdentity, selectMacInstaller, settleIncompleteUpdateCheck } from "./updater-state";

describe("update check terminal state", () => {
	it("does not leave a completed manual check spinning forever", () => {
		expect(settleIncompleteUpdateCheck({ state: "checking" }, true)).toEqual({
			state: "error",
			message: "Update check completed without a result.",
		});
	});

	it("keeps real updater terminal states intact and makes background misses silent", () => {
		const available = { state: "available", version: "0.7.2", mode: "automatic" } as const;
		expect(settleIncompleteUpdateCheck(available, true)).toBe(available);
		expect(settleIncompleteUpdateCheck({ state: "checking" }, false)).toEqual({ state: "idle" });
	});
});

describe("manual macOS installer selection", () => {
	const files = [
		{ url: "omp-0.8.4-arm64-mac.zip", sha512: "arm-zip" },
		{ url: "omp-0.8.4-arm64.dmg", sha512: "arm-dmg", size: 120 },
		{ url: "https://example.test/omp-0.8.4-mac.zip", sha512: "x64-zip" },
		{ url: "https://example.test/omp-0.8.4.dmg", sha512: "x64-dmg", size: 140 },
	];

	it("selects the exact DMG for each supported architecture", () => {
		expect(selectMacInstaller(files, "0.8.4", "arm64")).toEqual({
			name: "omp-0.8.4-arm64.dmg",
			sha512: "arm-dmg",
			size: 120,
		});
		expect(selectMacInstaller(files, "0.8.4", "x64")).toEqual({
			name: "omp-0.8.4.dmg",
			sha512: "x64-dmg",
			size: 140,
		});
	});

	it("rejects ZIPs and installers for a different release", () => {
		expect(selectMacInstaller(files, "0.8.5", "arm64")).toBeUndefined();
		expect(
			selectMacInstaller(
				files.filter(file => file.url.endsWith(".zip")),
				"0.8.4",
				"x64",
			),
		).toBeUndefined();
	});
});

describe("macOS signing identity", () => {
	it("keeps Squirrel only for a certificate-backed stable identity", () => {
		expect(
			hasStableMacSigningIdentity(
				"Authority=Developer ID Application: Example Corp (TEAM123456)\nTeamIdentifier=TEAM123456",
			),
		).toBe(true);
		expect(hasStableMacSigningIdentity("Signature=adhoc\nTeamIdentifier=not set")).toBe(false);
		expect(hasStableMacSigningIdentity("TeamIdentifier=TEAM123456")).toBe(false);
	});
});
