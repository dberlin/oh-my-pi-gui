import { z } from "zod";
import type { BtwHistoryRecord, RpcBtwFrame, RpcCommand, RpcResponse } from "../shared/rpc-types";

const BtwTurnSchema = z.object({
	question: z.string(),
	answer: z.string(),
	status: z.enum(["running", "complete", "cancelled", "error", "interrupted"]),
	createdAt: z.number().finite(),
	updatedAt: z.number().finite(),
	error: z.string().optional(),
});
const BtwRecordSchema: z.ZodType<BtwHistoryRecord> = BtwTurnSchema.extend({
	id: z.string().min(1),
	leafId: z.string().nullable(),
	followUps: z.array(BtwTurnSchema).optional(),
});
const BtwFrameSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("btw_delta"), recordId: z.string().min(1), delta: z.string() }),
	z.object({ type: z.literal("btw_record"), record: BtwRecordSchema }),
]);

/** Validate genuine vanilla notifications before they cross the renderer bridge. */
export function parseBtwFrame(value: unknown): RpcBtwFrame | null {
	if (
		typeof value !== "object" ||
		value === null ||
		!("type" in value) ||
		(value.type !== "btw_delta" && value.type !== "btw_record")
	)
		return null;
	const parsed = BtwFrameSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** Vanilla can fork the transcript, but has no RPC to promote a BTW answer. */
export function unsupportedBtwBranchResponse(command: RpcCommand): RpcResponse | null {
	if (command.type !== "btw_branch") return null;
	return {
		id: command.id,
		type: "response",
		command: "btw_branch",
		success: false,
		code: "unsupported_capability",
		error: "This vanilla omp runtime does not support branching a side-question answer into the conversation.",
	};
}
