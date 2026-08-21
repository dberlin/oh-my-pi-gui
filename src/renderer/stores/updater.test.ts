import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUpdaterStore } from "./updater";

/**
 * Updater store contract: the banner's dismissal is version-scoped — snoozing
 * v0.4.1 must not hide v0.4.2 — and status replaces wholesale (the main
 * process owns the machine).
 */

describe("useUpdaterStore", () => {
	beforeEach(() => {
		useUpdaterStore.setState({ status: { state: "idle" }, dismissedVersion: undefined });
	});

	afterEach(() => {
		useUpdaterStore.setState({ status: { state: "idle" }, dismissedVersion: undefined });
	});

	it("replaces status wholesale as the main-process machine advances", () => {
		const { setStatus } = useUpdaterStore.getState();
		setStatus({ state: "available", version: "0.4.1", mode: "automatic" });
		expect(useUpdaterStore.getState().status).toEqual({
			state: "available",
			version: "0.4.1",
			mode: "automatic",
		});
		setStatus({
			state: "downloading",
			version: "0.4.1",
			mode: "automatic",
			percent: 42,
			bytesPerSecond: 1,
			transferred: 42,
			total: 100,
		});
		expect(useUpdaterStore.getState().status.state).toBe("downloading");
		setStatus({ state: "downloaded", version: "0.4.1", mode: "automatic" });
		expect(useUpdaterStore.getState().status).toEqual({
			state: "downloaded",
			version: "0.4.1",
			mode: "automatic",
		});
	});

	it("dismisses per version: a newer version is not covered by an older dismissal", () => {
		const { dismiss } = useUpdaterStore.getState();
		dismiss("0.4.1");
		expect(useUpdaterStore.getState().dismissedVersion).toBe("0.4.1");
		// The banner hides only when dismissedVersion === status.version; a
		// newer available version must compare unequal.
		useUpdaterStore.getState().setStatus({ state: "available", version: "0.4.2", mode: "manual" });
		expect(useUpdaterStore.getState().dismissedVersion).not.toBe("0.4.2");
	});

	it("clearDismissed re-arms the banner for the same version", () => {
		const { dismiss, clearDismissed } = useUpdaterStore.getState();
		dismiss("0.4.1");
		clearDismissed();
		expect(useUpdaterStore.getState().dismissedVersion).toBeUndefined();
	});
});
