import type { BtwHistoryRecord, BtwHistoryTurn, RpcBtwFrame } from "../../shared/rpc-types";
import type { TabCommand } from "../stores/session-runtime-context";

export interface BtwConversationState {
	record: BtwHistoryRecord | null;
	answer: string;
	loading: boolean;
	cancelling: boolean;
	error: string | null;
}
export function latestBtwTurn(record: BtwHistoryRecord): BtwHistoryTurn {
	return record.followUps?.at(-1) ?? record;
}

/** One dialog generation owns one side question, never the focused tab's later session. */
export class BtwConversation {
	state: BtwConversationState = { record: null, answer: "", loading: false, cancelling: false, error: null };
	#closed = false;
	#terminal = false;
	#buffer: RpcBtwFrame[] = [];
	constructor(
		private readonly command: TabCommand,
		private readonly isCurrent: () => boolean,
		private readonly changed: (state: BtwConversationState) => void,
	) {}

	#publish(patch: Partial<BtwConversationState>): void {
		this.state = { ...this.state, ...patch };
		this.changed(this.state);
	}

	#record(record: BtwHistoryRecord): void {
		const latest = latestBtwTurn(record);
		this.#terminal = latest.status !== "running";
		this.#publish({ record, answer: latest.answer, cancelling: false });
	}

	frame(frame: RpcBtwFrame): void {
		if (this.#closed || !this.isCurrent()) return;
		// The running checkpoint precedes the response. Retain real frames until
		// that response establishes the record id; never infer an id from a question.
		if (this.state.loading) {
			this.#buffer.push(frame);
			return;
		}
		const record = this.state.record;
		if (!record || this.#terminal) return;
		if (frame.type === "btw_delta") {
			if (frame.recordId === record.id) this.#publish({ answer: this.state.answer + frame.delta });
			return;
		}
		if (frame.record.id !== record.id || (frame.record.followUps?.length ?? 0) !== (record.followUps?.length ?? 0))
			return;
		if (latestBtwTurn(frame.record).createdAt !== latestBtwTurn(record).createdAt) return;
		this.#record(frame.record);
	}

	async ask(question: string): Promise<void> {
		if (
			this.#closed ||
			!this.isCurrent() ||
			this.state.loading ||
			this.state.cancelling ||
			(this.state.record && latestBtwTurn(this.state.record).status === "running") ||
			!question.trim()
		)
			return;
		this.#buffer = [];
		this.#publish({ loading: true, error: null });
		try {
			const recordId = this.state.record?.id;
			const response = await this.command(
				{ type: "btw", question: question.trim(), ...(recordId ? { recordId } : {}) },
				120_000,
			);
			if (this.#closed || !this.isCurrent()) return;
			if (!response.success) throw new Error(response.error);
			const data = response.data as { record?: BtwHistoryRecord } | undefined;
			if (!data?.record || typeof data.record.id !== "string" || typeof data.record.answer !== "string") {
				throw new Error(
					"This vanilla omp runtime does not provide the streaming side-question record contract. Update vanilla omp.",
				);
			}
			this.#record(data.record);
			this.#publish({ loading: false });
			const buffered = this.#buffer;
			this.#buffer = [];
			for (const frame of buffered) this.frame(frame);
		} catch (cause) {
			if (!this.#closed && this.isCurrent())
				this.#publish({ loading: false, cancelling: false, error: String(cause) });
			this.#buffer = [];
		}
	}

	async cancel(): Promise<void> {
		if (
			this.#closed ||
			!this.isCurrent() ||
			this.state.cancelling ||
			(!this.state.loading && (!this.state.record || latestBtwTurn(this.state.record).status !== "running"))
		)
			return;
		this.#publish({ cancelling: true, error: null });
		try {
			const recordId = this.state.record?.id;
			const response = await this.command({ type: "btw_cancel", ...(recordId ? { recordId } : {}) });
			if (!response.success) throw new Error(response.error);
			// Cancellation is authoritative only in the server's terminal record.
			if (!this.#closed && this.isCurrent()) this.#publish({ cancelling: false });
		} catch (cause) {
			if (!this.#closed && this.isCurrent()) this.#publish({ cancelling: false, error: String(cause) });
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffer = [];
		if (
			!this.isCurrent() ||
			(!this.state.loading && (!this.state.record || latestBtwTurn(this.state.record).status !== "running"))
		)
			return;
		const recordId = this.state.record?.id;
		const response = await this.command({ type: "btw_cancel", ...(recordId ? { recordId } : {}) });
		if (!response.success) throw new Error(response.error);
	}
}
