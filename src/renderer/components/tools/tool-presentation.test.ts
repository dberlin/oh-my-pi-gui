import { describe, expect, it } from "vitest";
import { resolveToolPresentation, toolPresentationSummary } from "./tool-presentation";

describe("resolveToolPresentation", () => {
	it("passes a direct Bash invocation through unchanged", () => {
		const result = {
			content: [{ type: "text", text: "boom" }],
			details: { exitCode: 1, stderr: "boom" },
		};
		const partialResult = {
			content: [{ type: "text", text: "running" }],
			details: { pid: 42 },
		};

		expect(
			resolveToolPresentation({
				name: "bash",
				args: { command: "false", timeout: 5 },
				result,
				partialResult,
				isError: true,
			}),
		).toEqual({
			name: "bash",
			args: { command: "false", timeout: 5 },
			result,
			partialResult,
			isError: true,
			transport: "direct",
			mode: "execute",
		});
	});

	it("unwraps a completed xd device into the effective tool contract", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://lsp",
				content: '{"action":"references","file":"src/a.ts"}',
			},
			result: {
				content: [{ type: "text", text: "Found 2 reference(s)" }],
				details: {
					xdev: {
						tool: "lsp",
						mode: "execute",
						args: { action: "references", file: "src/a.ts" },
						inner: { action: "references", success: true },
					},
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(invocation).toEqual({
			name: "lsp",
			args: { action: "references", file: "src/a.ts" },
			result: {
				content: [{ type: "text", text: "Found 2 reference(s)" }],
				details: { action: "references", success: true },
			},
			partialResult: null,
			isError: false,
			transport: "xdev",
			mode: "execute",
		});
	});

	it("recognizes a pending xd write and decodes its complete inner JSON", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://browser",
				content: '{"action":"open","name":"main","url":"https://example.com"}',
			},
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation).toEqual({
			name: "browser",
			args: { action: "open", name: "main", url: "https://example.com" },
			result: null,
			partialResult: null,
			isError: false,
			transport: "xdev",
			mode: "execute",
		});
	});

	it("decodes a complete xd invocation from streaming outer arguments", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {},
			streamingArgs:
				'{"path":"xd://browser","content":"{\\"action\\":\\"open\\",\\"name\\":\\"stream\\",\\"url\\":\\"https://example.com/stream\\"}"}',
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation).toMatchObject({
			name: "browser",
			args: {
				action: "open",
				name: "stream",
				url: "https://example.com/stream",
			},
			transport: "xdev",
			mode: "execute",
		});
	});

	it("labels incomplete inner JSON instead of throwing", () => {
		const raw = '{"action":"open","url":"https://example.com"';
		const invocation = resolveToolPresentation({
			name: "write",
			args: { path: "xd://browser", content: raw },
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation).toMatchObject({
			name: "browser",
			args: { __partialJson: raw },
			transport: "xdev",
			mode: "execute",
		});
	});

	it("normalizes authoritative xd details from a partial result", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: { path: "xd://debug", content: '{"action":"stack_trace"}' },
			result: null,
			partialResult: {
				content: [{ type: "text", text: "frame 1" }],
				details: {
					xdev: {
						tool: "debug",
						mode: "execute",
						args: { action: "stack_trace" },
						inner: { frames: [{ name: "main", line: 12 }] },
					},
				},
			},
			isError: false,
		});

		expect(invocation).toEqual({
			name: "debug",
			args: { action: "stack_trace" },
			result: null,
			partialResult: {
				content: [{ type: "text", text: "frame 1" }],
				details: { frames: [{ name: "main", line: 12 }] },
			},
			isError: false,
			transport: "xdev",
			mode: "execute",
		});
	});

	it("prefers settled result xd details over stale partial and outer arguments", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: { path: "xd://browser", content: '{"action":"open"}' },
			result: {
				content: [{ type: "text", text: "settled result" }],
				details: {
					xdev: {
						tool: "mcp",
						mode: "help",
						args: { query: "current" },
						inner: {
							serverName: "docs",
							mcpToolName: "search",
							success: true,
						},
					},
				},
			},
			partialResult: {
				content: [{ type: "text", text: "stale partial" }],
				details: {
					xdev: {
						tool: "debug",
						mode: "execute",
						args: { action: "threads" },
						inner: { threads: [{ id: 1, name: "main" }] },
					},
				},
			},
			isError: false,
		});

		expect(invocation).toMatchObject({
			name: "mcp",
			args: { query: "current" },
			result: {
				content: [{ type: "text", text: "settled result" }],
				details: {
					serverName: "docs",
					mcpToolName: "search",
					success: true,
				},
			},
			transport: "xdev",
			mode: "help",
			mcp: { serverName: "docs", toolName: "search" },
		});
	});

	it("uses authoritative xd arguments instead of decoded outer content", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://browser",
				content: '{"action":"open","name":"outer"}',
			},
			result: {
				content: [{ type: "text", text: "Found 1 reference(s)" }],
				details: {
					xdev: {
						tool: "lsp",
						mode: "execute",
						args: { action: "references", file: "src/authoritative.ts" },
						inner: { action: "references", success: true },
					},
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(invocation).toMatchObject({
			name: "lsp",
			args: { action: "references", file: "src/authoritative.ts" },
			transport: "xdev",
		});
	});

	it("keeps an xd help invocation in documentation mode", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: { path: "xd://browser", content: "{}" },
			result: {
				content: [{ type: "text", text: "Browser device help" }],
				details: {
					xdev: {
						tool: "browser",
						mode: "help",
						args: {},
						inner: { usage: "write browser arguments to xd://browser" },
					},
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(invocation).toMatchObject({
			name: "browser",
			args: {},
			mode: "help",
			transport: "xdev",
			result: {
				content: [{ type: "text", text: "Browser device help" }],
				details: { usage: "write browser arguments to xd://browser" },
			},
		});
	});

	it("derives missing settled xd help arguments from outer JSON content", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://lsp",
				content: '{"action":"references","file":"src/from-outer.ts"}',
			},
			result: {
				content: [{ type: "text", text: "LSP device help" }],
				details: {
					xdev: {
						tool: "lsp",
						mode: "help",
						inner: { usage: "write LSP arguments to xd://lsp" },
					},
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(invocation).toMatchObject({
			name: "lsp",
			args: { action: "references", file: "src/from-outer.ts" },
			mode: "help",
			transport: "xdev",
			result: {
				details: { usage: "write LSP arguments to xd://lsp" },
			},
		});
	});

	it("uses empty arguments for settled xd help details when outer content is absent", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: { path: "xd://lsp" },
			result: {
				content: [{ type: "text", text: "LSP device help" }],
				details: {
					xdev: {
						tool: "lsp",
						mode: "help",
						inner: { usage: "write LSP arguments to xd://lsp" },
					},
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(invocation).toMatchObject({
			name: "lsp",
			args: {},
			mode: "help",
			transport: "xdev",
		});
	});

	it("keeps a malformed non-device write as a direct invocation", () => {
		const result = {
			content: [{ type: "text", text: "Wrote src/config.json" }],
			details: { bytes: 1 },
		};
		const args = { path: "src/config.json", content: "{" };

		expect(
			resolveToolPresentation({
				name: "write",
				args,
				result,
				partialResult: null,
				isError: false,
			}),
		).toEqual({
			name: "write",
			args,
			result,
			partialResult: null,
			isError: false,
			transport: "direct",
			mode: "execute",
		});
	});

	it("recognizes MCP identity from selected direct result details", () => {
		const invocation = resolveToolPresentation({
			name: "mcp__context_mode_ctx_execute",
			args: { code: "return 1" },
			result: {
				content: [{ type: "text", text: "completed" }],
				details: {
					serverName: "context-mode",
					mcpToolName: "ctx_execute",
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "context-mode",
			toolName: "ctx_execute",
		});
	});

	it("normalizes pending direct MCP identity with the sidecar name parser", () => {
		const invocation = resolveToolPresentation({
			name: "mcp__context_mode_ctx_execute",
			args: { code: "return 1" },
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "context",
			toolName: "mode_ctx_execute",
		});
	});

	it("matches the sidecar parser for an empty pending direct MCP server segment", () => {
		const invocation = resolveToolPresentation({
			name: "mcp___tool",
			args: { input: "pending" },
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "",
			toolName: "tool",
		});
	});

	it("matches the sidecar parser for an empty pending direct MCP tool segment", () => {
		const invocation = resolveToolPresentation({
			name: "mcp__server_",
			args: { input: "pending" },
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "server",
			toolName: "",
		});
	});

	it("normalizes pending xd MCP identity with the sidecar name parser", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://mcp__context_mode_ctx_execute",
				content: '{"code":"return 1"}',
			},
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation).toMatchObject({
			name: "mcp__context_mode_ctx_execute",
			transport: "xdev",
			mcp: {
				serverName: "context",
				toolName: "mode_ctx_execute",
			},
		});
	});

	it("matches the sidecar parser for an empty pending xd MCP server segment", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://mcp___tool",
				content: '{"input":"pending"}',
			},
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "",
			toolName: "tool",
		});
	});

	it("matches the sidecar parser for an empty pending xd MCP tool segment", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://mcp__server_",
				content: '{"input":"pending"}',
			},
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "server",
			toolName: "",
		});
	});

	it("prefers authoritative partial MCP details over normalized name identity", () => {
		const invocation = resolveToolPresentation({
			name: "mcp__context_mode_ctx_execute",
			args: { code: "return 1" },
			result: null,
			partialResult: {
				content: [{ type: "text", text: "running" }],
				details: {
					serverName: "context-mode",
					mcpToolName: "ctx_execute",
				},
			},
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "context-mode",
			toolName: "ctx_execute",
		});
	});

	it("prefers settled MCP details over stale partial details and normalized name identity", () => {
		const invocation = resolveToolPresentation({
			name: "mcp__context_mode_ctx_execute",
			args: { code: "return 1" },
			result: {
				content: [{ type: "text", text: "completed" }],
				details: {
					serverName: "context-mode",
					mcpToolName: "ctx_execute",
				},
			},
			partialResult: {
				content: [{ type: "text", text: "running" }],
				details: {
					serverName: "stale-server",
					mcpToolName: "stale_tool",
				},
			},
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "context-mode",
			toolName: "ctx_execute",
		});
	});

	it("does not let stale partial MCP details override a settled result", () => {
		const invocation = resolveToolPresentation({
			name: "mcp__context_mode_ctx_execute",
			args: { code: "return 1" },
			result: {
				content: [{ type: "text", text: "completed" }],
				details: { success: true },
			},
			partialResult: {
				content: [{ type: "text", text: "running" }],
				details: {
					serverName: "stale-server",
					mcpToolName: "stale_tool",
				},
			},
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "context",
			toolName: "mode_ctx_execute",
		});
	});

	it("prefers authoritative partial Xdev MCP details over a parseable tool name", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://mcp__outer_name",
				content: '{"query":"outer"}',
			},
			result: null,
			partialResult: {
				content: [{ type: "text", text: "running" }],
				details: {
					xdev: {
						tool: "mcp__parsed_partial",
						mode: "execute",
						args: { query: "authoritative partial" },
						inner: {
							serverName: "partial-authority",
							mcpToolName: "selected_partial",
							progress: 0.5,
						},
					},
				},
			},
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "partial-authority",
			toolName: "selected_partial",
		});
	});

	it("prefers authoritative final Xdev MCP details over a parseable tool name and stale partial", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://mcp__outer_name",
				content: '{"query":"outer"}',
			},
			result: {
				content: [{ type: "text", text: "completed" }],
				details: {
					xdev: {
						tool: "mcp__parsed_final",
						mode: "execute",
						args: { query: "authoritative final" },
						inner: {
							serverName: "final-authority",
							mcpToolName: "selected_final",
							success: true,
						},
					},
				},
			},
			partialResult: {
				content: [{ type: "text", text: "running" }],
				details: {
					xdev: {
						tool: "mcp__partial_name",
						mode: "execute",
						args: { query: "stale partial" },
						inner: {
							serverName: "stale-server",
							mcpToolName: "stale_tool",
							progress: 0.5,
						},
					},
				},
			},
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "final-authority",
			toolName: "selected_final",
		});
	});

	it("drops stale partial Xdev MCP details and falls back to the settled parseable tool name", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://mcp__outer_name",
				content: '{"query":"outer"}',
			},
			result: {
				content: [{ type: "text", text: "completed" }],
				details: {
					xdev: {
						tool: "mcp__settled_tool",
						mode: "execute",
						args: { query: "settled" },
						inner: { success: true },
					},
				},
			},
			partialResult: {
				content: [{ type: "text", text: "running" }],
				details: {
					xdev: {
						tool: "mcp__partial_name",
						mode: "execute",
						args: { query: "stale partial" },
						inner: {
							serverName: "stale-server",
							mcpToolName: "stale_tool",
							progress: 0.5,
						},
					},
				},
			},
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "settled",
			toolName: "tool",
		});
	});

	it("does not classify a non-MCP name from structured details or arbitrary body text", () => {
		const invocation = resolveToolPresentation({
			name: "bash",
			args: { command: "printf done" },
			result: {
				content: [{ type: "text", text: "serverName=context-mode mcpToolName=ctx_execute" }],
				details: {
					serverName: "context-mode",
					mcpToolName: "ctx_execute",
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(invocation.mcp).toBeUndefined();
	});

	it("recognizes MCP identity only from authoritative effective details", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: { path: "xd://mcp", content: '{"path":"README.md"}' },
			result: {
				content: [{ type: "text", text: "README contents" }],
				details: {
					xdev: {
						tool: "mcp",
						mode: "execute",
						args: { path: "README.md" },
						inner: {
							serverName: "filesystem",
							mcpToolName: "read_file",
							success: true,
						},
					},
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(invocation.mcp).toEqual({
			serverName: "filesystem",
			toolName: "read_file",
		});
		expect(invocation.result).toEqual({
			content: [{ type: "text", text: "README contents" }],
			details: {
				serverName: "filesystem",
				mcpToolName: "read_file",
				success: true,
			},
		});
	});

	it("does not infer MCP identity from arbitrary output text", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: { path: "xd://mcp", content: "{}" },
			result: {
				content: [{ type: "text", text: "serverName=filesystem mcpToolName=read_file" }],
				details: {
					xdev: {
						tool: "mcp",
						mode: "execute",
						args: {},
						inner: { success: true },
					},
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(invocation.mcp).toBeUndefined();
	});

	it("preserves an unknown effective device name", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: { path: "xd://future_device", content: '{"i":"Inspect state"}' },
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(invocation).toMatchObject({
			name: "future_device",
			args: { i: "Inspect state" },
			transport: "xdev",
		});
	});
});

describe("toolPresentationSummary", () => {
	it("summarizes a direct invocation from its effective arguments", () => {
		const invocation = resolveToolPresentation({
			name: "bash",
			args: { command: "bun run check:types" },
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(toolPresentationSummary(invocation)).toBe("bun run check:types");
	});

	it("summarizes an invocation by its authoritative MCP identity", () => {
		const invocation = {
			name: "mcp__context_mode_ctx_execute",
			args: { i: "Run context operation" },
			result: null,
			partialResult: null,
			isError: false,
			transport: "direct" as const,
			mode: "execute" as const,
			mcp: {
				serverName: "context-mode",
				toolName: "ctx_execute",
			},
		};

		expect(toolPresentationSummary(invocation)).toBe("context-mode/ctx_execute");
	});

	it("summarizes an xd invocation by the effective LSP name rather than outer Write", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://lsp",
				content: '{"action":"references","file":"src/a.ts"}',
			},
			result: {
				content: [{ type: "text", text: "Found 2 reference(s)" }],
				details: {
					xdev: {
						tool: "lsp",
						mode: "execute",
						args: { action: "references", file: "src/a.ts" },
						inner: { action: "references", success: true },
					},
				},
			},
			partialResult: null,
			isError: false,
		});

		expect(toolPresentationSummary(invocation)).toBe("references");
	});

	it("bounds a direct Browser summary while retaining its action and URL prefix", () => {
		const url = `https://example.test/${"path-segment/".repeat(20)}`;
		const invocation = resolveToolPresentation({
			name: "browser",
			args: { action: "open", url },
			result: null,
			partialResult: null,
			isError: false,
		});

		const summary = toolPresentationSummary(invocation);
		expect(summary).toBe(`${`open ${url}`.slice(0, 159)}…`);
		expect(summary.length).toBe(160);
	});

	it("bounds an xd Browser summary while retaining its action and URL prefix", () => {
		const url = `https://example.test/${"path-segment/".repeat(20)}`;
		const invocation = resolveToolPresentation({
			name: "write",
			args: {
				path: "xd://browser",
				content: JSON.stringify({ action: "open", url }),
			},
			result: {
				content: [{ type: "text", text: `Opened ${url}` }],
				details: {
					xdev: {
						tool: "browser",
						mode: "execute",
						args: { action: "open", url },
						inner: { url },
					},
				},
			},
			partialResult: null,
			isError: false,
		});

		const summary = toolPresentationSummary(invocation);
		expect(summary).toBe(`${`open ${url}`.slice(0, 159)}…`);
		expect(summary.length).toBe(160);
	});

	it("uses the generic argument summary for an unknown effective name", () => {
		const invocation = resolveToolPresentation({
			name: "write",
			args: { path: "xd://future_device", content: '{"i":"Inspect state"}' },
			result: null,
			partialResult: null,
			isError: false,
		});

		expect(toolPresentationSummary(invocation)).toBe("Inspect state");
	});
});
