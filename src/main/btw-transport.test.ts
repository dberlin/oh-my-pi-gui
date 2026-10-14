import { describe, expect, it } from "vitest";
import { parseBtwFrame, unsupportedBtwBranchResponse } from "./btw-transport";

const record = {
	id: "topic",
	leafId: "leaf",
	question: "Question",
	answer: "Partial",
	status: "running",
	createdAt: 1,
	updatedAt: 2,
};
describe("vanilla BTW transport", () => {
	it("preserves only genuine delta and complete record frames including follow-ups", () => {
		const delta = { type: "btw_delta", recordId: "topic", delta: "**real delta**" };
		expect(parseBtwFrame(delta)).toEqual(delta);
		const snapshot = {
			type: "btw_record",
			record: {
				...record,
				followUps: [{ question: "Follow-up", answer: "Latest", status: "cancelled", createdAt: 3, updatedAt: 4 }],
			},
		};
		expect(parseBtwFrame(snapshot)).toEqual(snapshot);
		expect(
			parseBtwFrame({ type: "response", command: "btw", success: true, data: { replyText: "not a frame" } }),
		).toBeNull();
	});
	it.each([
		{ type: "btw_delta", recordId: 3, delta: "bad" },
		{ type: "btw_record", record: { ...record, status: "invented" } },
		{ type: "btw_record", record: { ...record, followUps: [{ question: "bad" }] } },
		{ type: "btw_record", record: { ...record, leafId: 8 } },
	])("rejects malformed side-question payloads", frame => {
		expect(parseBtwFrame(frame)).toBeNull();
	});
	it("explicitly refuses unsupported BTW promotion without suggesting a successful branch", () => {
		expect(unsupportedBtwBranchResponse({ type: "btw_branch" })).toMatchObject({
			type: "response",
			command: "btw_branch",
			success: false,
			code: "unsupported_capability",
		});
		expect(unsupportedBtwBranchResponse({ type: "btw", question: "Question" })).toBeNull();
	});
});
