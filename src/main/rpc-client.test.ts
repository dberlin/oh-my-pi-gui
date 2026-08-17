import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { RpcClient } from "./rpc-client";

function unknownCommand(command: string, id?: string): RpcResponse {
	return {
		...(id ? { id } : {}),
		type: "response",
		command,
		success: false,
		error: `Unknown command: ${command}`,
	};
}

function unsupportedCommand(type: string): RpcCommand {
	return { type } as RpcCommand;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("RpcClient", () => {
	it("rejects an id-less unknown-command response immediately", async () => {
		vi.useFakeTimers();
		const client = new RpcClient(() => {}, 8_000);
		const response = client.command(unsupportedCommand("get_usage"));

		expect(client.onResponse(unknownCommand("get_usage"))).toBe(true);
		await expect(response).rejects.toThrow(
			'RPC command "get_usage" is not supported by the connected coding agent (Unknown command: get_usage)',
		);
		expect(client.pendingCount).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects only pending requests for the unsupported command", async () => {
		vi.useFakeTimers();
		const sent: RpcCommand[] = [];
		const client = new RpcClient(frame => sent.push(frame as RpcCommand), 8_000);
		const usage = client.command(unsupportedCommand("get_usage"));
		const state = client.command({ type: "get_state" });
		const usageRejection = usage.catch(error => error);

		expect(client.onResponse(unknownCommand("get_usage"))).toBe(true);
		expect(await usageRejection).toMatchObject({
			message: expect.stringContaining('RPC command "get_usage" is not supported'),
		});
		expect(client.pendingCount).toBe(1);

		const stateId = sent[1]?.id;
		expect(stateId).toBeTruthy();
		expect(
			client.onResponse({ id: stateId, type: "response", command: "get_state", success: true, data: { ok: true } }),
		).toBe(true);
		await expect(state).resolves.toMatchObject({ success: true, data: { ok: true } });
		expect(client.pendingCount).toBe(0);
	});

	it("never falls back by command when an unknown response carries an id", async () => {
		vi.useFakeTimers();
		const client = new RpcClient(() => {}, 10);
		const response = client.command(unsupportedCommand("get_usage"));
		const timedOut = expect(response).rejects.toThrow("RPC timeout (10ms): get_usage");

		expect(client.onResponse(unknownCommand("get_usage", "stale-id"))).toBe(false);
		expect(client.pendingCount).toBe(1);
		await vi.advanceTimersByTimeAsync(10);
		await timedOut;
	});

	it("ignores other id-less response errors", async () => {
		vi.useFakeTimers();
		const client = new RpcClient(() => {}, 10);
		const response = client.command(unsupportedCommand("get_usage"));
		const timedOut = expect(response).rejects.toThrow("RPC timeout (10ms): get_usage");

		expect(
			client.onResponse({ type: "response", command: "get_usage", success: false, error: "Provider unavailable" }),
		).toBe(false);
		expect(client.pendingCount).toBe(1);
		await vi.advanceTimersByTimeAsync(10);
		await timedOut;
	});
});
