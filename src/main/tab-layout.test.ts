import { describe, expect, it } from "vitest";
import { MAX_PERSISTED_TABS, sanitizePersistedTabLayout, type TabLayoutPathChecks } from "./tab-layout";

function pathChecks(directories: string[], files: string[], contentFiles: string[] = files): TabLayoutPathChecks {
	return {
		directoryExists: path => directories.includes(path),
		fileExists: path => files.includes(path),
		sessionHasContent: path => contentFiles.includes(path),
	};
}

describe("persisted tab layout", () => {
	it("preserves valid order, active selection, session kind, and worktree metadata", () => {
		const value = {
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{
					cwd: "/b",
					kind: "chat",
					worktree: { name: "feature", branch: "omp/gui/feature", baseCwd: "/repo" },
				},
			],
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/a", "/b"], ["/sessions/a.jsonl"]))).toEqual(value);
	});

	it("drops missing workspaces and selects the nearest surviving tab", () => {
		const value = {
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/before", kind: "agent" },
				{ cwd: "/deleted", kind: "agent" },
				{ cwd: "/after", kind: "chat" },
			],
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/before", "/after"], []))).toEqual({
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/before", kind: "agent" },
				{ cwd: "/after", kind: "chat" },
			],
		});
	});

	it("turns a deleted transcript into a fresh tab and removes duplicate session attachments", () => {
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/deleted.jsonl" },
				{ cwd: "/b", kind: "agent", sessionPath: "/sessions/live.jsonl" },
				{ cwd: "/c", kind: "agent", sessionPath: "/sessions/live.jsonl" },
			],
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/a", "/b", "/c"], ["/sessions/live.jsonl"]))).toEqual({
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/a", kind: "agent" },
				{ cwd: "/b", kind: "agent", sessionPath: "/sessions/live.jsonl" },
			],
		});
	});

	it("drops the disposable startup placeholder once an explicit tab exists", () => {
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/neutral", kind: "chat", placeholder: true },
				{ cwd: "/work", kind: "agent", sessionPath: "/sessions/work.jsonl" },
			],
		};

		expect(sanitizePersistedTabLayout(value, pathChecks(["/neutral", "/work"], ["/sessions/work.jsonl"]))).toEqual({
			version: 1,
			activeIndex: 0,
			tabs: [{ cwd: "/work", kind: "agent", sessionPath: "/sessions/work.jsonl" }],
		});
	});

	it("migrates an empty first chat from layouts saved before placeholder metadata existed", () => {
		const value = {
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/neutral", kind: "chat", sessionPath: "/sessions/empty.jsonl" },
				{ cwd: "/work", kind: "agent", sessionPath: "/sessions/work.jsonl" },
			],
		};

		expect(
			sanitizePersistedTabLayout(
				value,
				pathChecks(
					["/neutral", "/work"],
					["/sessions/empty.jsonl", "/sessions/work.jsonl"],
					["/sessions/work.jsonl"],
				),
			),
		).toEqual({
			version: 1,
			activeIndex: 0,
			tabs: [{ cwd: "/work", kind: "agent", sessionPath: "/sessions/work.jsonl" }],
		});

		// A real first chat is never inferred to be a disposable placeholder.
		expect(
			sanitizePersistedTabLayout(
				value,
				pathChecks(
					["/neutral", "/work"],
					["/sessions/empty.jsonl", "/sessions/work.jsonl"],
					["/sessions/empty.jsonl", "/sessions/work.jsonl"],
				),
			),
		).toEqual(value);
	});

	it("rejects malformed or empty snapshots and enforces the sidecar cap", () => {
		expect(sanitizePersistedTabLayout(null, pathChecks([], []))).toBeNull();
		expect(sanitizePersistedTabLayout({ version: 2, tabs: [] }, pathChecks([], []))).toBeNull();
		expect(sanitizePersistedTabLayout({ version: 1, activeIndex: 0, tabs: [] }, pathChecks([], []))).toBeNull();

		const tabs = Array.from({ length: MAX_PERSISTED_TABS + 2 }, (_, index) => ({
			cwd: `/workspace-${index}`,
			kind: "agent",
		}));
		const directories = tabs.map(tab => tab.cwd);
		expect(
			sanitizePersistedTabLayout({ version: 1, activeIndex: 11, tabs }, pathChecks(directories, []))?.tabs,
		).toHaveLength(MAX_PERSISTED_TABS);
	});
});
