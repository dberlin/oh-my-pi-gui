// Resolves the macOS signing identity for electron-builder, per build machine.
//
// This used to be a hardcoded `mac.identity: "-"` in electron-builder.base.yml so that a
// machine with no Developer ID certificate still produced an ad-hoc *sealed* bundle — macOS
// then offers its user-override flow instead of reporting the app as damaged.
//
// The cost was that machines that DO hold a certificate were forced to ad-hoc as well: any
// non-null `mac.identity` becomes the search qualifier in MacTargetHelper#findSigningIdentity,
// and "-" matches no keychain line, so auto-discovery and the Mac Developer fallback both miss
// and signing drops to ad-hoc.
//
// So decide per machine instead: leave `identity` unset when the keychain holds a real Apple
// signing identity — auto-discovery and CSC_NAME then behave normally — and fall back to the
// ad-hoc seal only when it holds none.

const { execFileSync } = require("node:child_process");

// The prefixes electron-builder will actually sign with: a Developer ID for distribution, or a
// Mac Developer cert via its development fallback. `-v` already limits output to valid ones.
const SIGNING_IDENTITY = /"(?:Developer ID Application|Mac Developer):/;

let cached;

function hasKeychainIdentity() {
	if (cached !== undefined) {
		return cached;
	}
	cached = probeKeychain();
	return cached;
}

function probeKeychain() {
	if (process.platform !== "darwin") {
		return false;
	}
	try {
		const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return SIGNING_IDENTITY.test(identities);
	} catch {
		// `security` unavailable or failing (locked keychain, sandboxed CI) — assume no identity.
		return false;
	}
}

// Exported as a function, not an object: electron-builder merges parent configs by mutating them
// in place, and the module cache would otherwise share one object across every config load.
module.exports = () => ({
	mac: hasKeychainIdentity() ? {} : { identity: "-" },
});
