import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpdateStatus } from "../../shared/ipc-types";
import { loadDismissal, useUpdaterStore } from "./updater";

const globals = globalThis as Record<string, unknown>;
let storage: Record<string, string>;

beforeEach(() => {
	storage = {};
	globals.localStorage = {
		getItem: (key: string) => storage[key] ?? null,
		setItem: (key: string, value: string) => {
			storage[key] = value;
		},
	};
	useUpdaterStore.setState({ status: { state: "idle" }, dismissed: {} });
});

afterEach(() => {
	delete globals.localStorage;
	useUpdaterStore.setState({ status: { state: "idle" }, dismissed: {} });
});

describe("updater dismissal persistence", () => {
	it("preserves both independent dismissals when either notice is dismissed again", () => {
		const { dismiss, dismissError } = useUpdaterStore.getState();
		dismiss("0.4.1");
		dismissError();
		useUpdaterStore.setState({ dismissed: loadDismissal() });
		dismiss("0.4.2");
		expect(loadDismissal()).toEqual({ version: "0.4.2", error: true });
		dismissError();
		expect(loadDismissal()).toEqual({ version: "0.4.2", error: true });
	});

	it.each<UpdateStatus>([
		{ state: "checking" },
		{ state: "idle" },
		{ state: "error", message: "Feed offline", showInBanner: true },
		{ state: "error", message: "Another poll failed", showInBanner: false },
		{
			state: "downloading",
			version: "0.4.1",
			mode: "manual",
			percent: 42,
			bytesPerSecond: 1,
			transferred: 42,
			total: 100,
		},
	])("does not re-arm a persisted failure on $state", status => {
		const { dismissError, setStatus } = useUpdaterStore.getState();
		dismissError();
		setStatus(status);
		expect(loadDismissal()).toEqual({ error: true });
	});

	it.each<UpdateStatus>([
		{ state: "available", version: "0.4.2", mode: "manual" },
		{ state: "not-available", version: "0.4.1" },
		{ state: "downloaded", version: "0.4.2", mode: "automatic" },
	])("persists recovery on $state without forgetting the declined release", status => {
		const { dismiss, dismissError, setStatus } = useUpdaterStore.getState();
		dismiss("0.4.1");
		dismissError();
		setStatus(status);
		expect(loadDismissal()).toEqual({ version: "0.4.1" });
	});

	it.each(["{ not json", "null", "42", JSON.stringify({ version: 42, error: "yes" })])(
		"ignores an invalid persisted dismissal: %s",
		raw => {
			storage["omp.update.dismissed"] = raw;
			expect(loadDismissal()).toEqual({});
		},
	);

	it("retains a session dismissal when persistent storage is unavailable", () => {
		globals.localStorage = {
			getItem: () => {
				throw new Error("Storage unavailable");
			},
			setItem: () => {
				throw new Error("Storage unavailable");
			},
		};
		const { dismiss, dismissError } = useUpdaterStore.getState();
		dismiss("0.4.1");
		dismissError();
		expect(useUpdaterStore.getState().dismissed).toEqual({ version: "0.4.1", error: true });
		expect(loadDismissal()).toEqual({});
	});
});
