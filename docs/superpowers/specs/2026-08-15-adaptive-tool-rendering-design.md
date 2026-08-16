# Adaptive Tool Rendering Design

## Summary

The GUI must present tool activity with the same useful, tool-specific hierarchy that the TUI provides. Today, the GUI has several specialized React renderer bodies, but users normally do not see them:

1. The default `compact` transcript mode folds completed reasoning and tool work into a generic `ExecutionGroup` summary such as “N steps complete.”
2. Discoverable tools commonly execute through `write xd://<tool>`. The TUI unwraps that transport and delegates to the effective tool renderer; the GUI currently selects `WriteRenderer` from the outer tool name.
3. MCP and unknown dynamic tools have no equivalent rich GUI presentation and fall through the Write or Generic path.

The approved direction is **Adaptive Hybrid**:

- lookup-oriented tools render as compact, first-class transcript rows;
- command-, output-, diff-, and visual-oriented tools render as framed cards;
- every entry is independently expandable;
- existing Grep, LSP, and Bash body designs are retained;
- MCP and dynamic-tool presentation is added or improved;
- no tool is hidden behind a generic completed-process card by default.

All product changes stay inside `packages/gui` and use the existing RPC/session payloads. No sidecar or enclosing-monorepo change is part of this feature.

## Goals

- Make every built-in tool for which the TUI has custom presentation reachable through a corresponding GUI presentation.
- Preserve the effective tool identity across direct calls and `xd://` device dispatch.
- Make useful tool summaries visible in the default compact transcript without requiring users to discover Full transcript mode.
- Allow each tool entry to expand in place to all available detail.
- Give MCP calls a dedicated server/tool, arguments, result, error, and truncation presentation.
- Use one rendering path for live Main events, hydrated Main history, and read-only subagent transcripts.
- Fail locally and visibly when payloads are incomplete or malformed; never break the transcript.

## Non-goals

- Exact pixel replication of terminal glyphs, borders, or ANSI output.
- Changes to tool execution, approval, MCP transport, RPC commands, or session persistence.
- A new sidecar protocol for serializing arbitrary third-party TUI renderer callbacks.
- Persisting an individual card’s expanded state across application restarts.
- Adding navigation actions such as opening source files from Grep or LSP rows unless an existing GUI action already provides that behavior.
- Rewriting existing specialized bodies that already communicate the result well. Grep, LSP, and Bash are explicitly retained.

## Current behavior and root causes

### Compact transcript grouping

`ExecutionGroup` currently owns an entire reasoning/tool phase. It opens while work is active and automatically collapses when execution settles. `buildHistoryRows` uses that group for the default `compact` transcript detail. The result is a generic process/task disclosure in place of visible tool-specific activity.

The specialized child renderer may exist and still be functionally absent from the default experience. This feature therefore treats live visibility through the real transcript path—not registry membership—as the parity contract.

### Device dispatch

The sidecar represents a mounted-device invocation as an outer Write call:

```text
write {
  path: "xd://lsp",
  content: "{...inner arguments...}"
}
```

Result details carry the authoritative dispatch envelope:

```text
details.xdev = {
  tool,
  mode,
  args,
  inner
}
```

The TUI uses this envelope to select the underlying renderer. The GUI currently selects from the outer name `write`, so the label, summary, and body may all describe a file write instead of LSP, Browser, Debug, MCP, or another mounted tool.

### Dynamic tools

MCP tools carry structured details including `serverName`, `mcpToolName`, `isError`, `rawContent`, `mcpMeta`, and output metadata. The GUI has no dedicated MCP renderer. Unknown extension and host tools use a generic body, but device dispatch can prevent even the correct dynamic tool name and inner arguments from reaching it.

## User experience

### Default compact transcript

Compact mode becomes Adaptive Hybrid rather than “fold all work.”

- Tool calls are first-class transcript entries.
- Reasoning may remain in its own disclosure.
- A generic `ExecutionGroup` must not replace completed tool entries.
- Related reads may continue using the existing read-group presentation.
- Tool-specific entries remain visible after execution completes.

Full mode continues to show every reasoning and tool step without process folding. Individual tool bodies still obey the shared disclosure state. Both modes use the same effective invocation resolver and specialized renderer registry.

### Disclosure contract

Every visible tool entry supports the same disclosure behavior:

- The collapsed state shows tool identity, status, a meaningful operation summary, duration when available, result count or outcome when available, and a bounded preview when that improves comprehension.
- Clicking the row/card header or its chevron expands the entry inline.
- Keyboard activation uses the native button interaction and exposes `aria-expanded`.
- The expanded state shows all detail available in the received result, subject only to explicit viewport scrolling and upstream output truncation.
- Clicking again collapses the entry.
- The existing expand/collapse-all control remains authoritative for all tool entries.
- An entry may be expanded while running; partial updates reconcile inside the open entry without resetting its state.
- Errors use the same disclosure and keep the error summary visible when collapsed.

“Four Grep matches” therefore means the collapsed row shows the count and a bounded preview, while expansion reveals all four received matches with their file, line, context, and highlight treatment.

### Adaptive shells

The shell controls density and chrome; the specialized renderer controls the body.

#### Compact lookup rows

Use the compact shell for:

- `read` and grouped reads
- `grep`
- `glob`
- `lsp`
- `ast_grep`
- `web_search`

These show a lightweight status rail/row with operation-specific counts and a bounded result preview. Expansion reveals the full existing specialized body.

#### Framed cards

Use the framed shell for:

- `write`
- `edit` and `apply_patch`
- `ast_edit`
- `resolve` and `reject`
- `bash`
- `eval`
- `browser`
- `computer`
- `debug`
- image generation and inspection
- MCP tools
- unknown dynamic, host, and extension tools

These need stronger boundaries because they contain terminal output, diffs, code, screenshots, JSON trees, or mixed structured results.

#### Domain activity cards

Retain the existing domain-specific layouts for:

- `task`
- `todo`
- `goal`
- `hub`
- `ask`
- `github`
- memory tools
- vibe tools

They still participate in the shared disclosure, status, duration, and expand-all contract. Their internal rows are not redesigned unless required to satisfy that contract.

## Presentation architecture

### Effective invocation model

Introduce a pure GUI presentation resolver with an output conceptually equivalent to:

```ts
interface EffectiveToolInvocation {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  partialResult: unknown;
  isError: boolean;
  transport: "direct" | "xdev";
  mode: "execute" | "help";
}
```

The exact type name may follow local conventions, but the boundary is required: transcript and card components must not independently decode `xd://` payloads.

The resolver receives the original tool-call name and arguments plus the occurrence-specific `ToolEntry`. It produces the effective identity and inner payload before summary generation, shell selection, or renderer selection.

### Direct calls

Direct calls pass through unchanged. The resolver preserves the original name, arguments, result, partial result, and error state.

### Device calls while arguments stream

When the outer tool is `write` and the path is a settled `xd://<tool>` URL:

- the effective name is the device name;
- the effective arguments are decoded from the outer `content` JSON;
- partial JSON is tolerated for display and must not throw;
- the GUI shows nothing misleading while the path could still become another value;
- resolution devices keep their dedicated semantics;
- `mode: help` renders documentation output rather than pretending the wrapped tool executed.

The existing outer args remain available only as fallback evidence; they are not presented as a file write.

### Device partial and final results

For partial or final results with `details.xdev`:

- `xdev.tool` is the authoritative effective name;
- `xdev.args` is the authoritative effective arguments when present;
- `xdev.inner` becomes the details payload seen by the specialized renderer;
- the original content blocks and `isError` remain the effective result body and error state;
- the outer Write metadata is not dumped into the specialized body.

This normalization happens identically for live events and hydrated history.

### Summary ownership

Summary generation moves behind effective invocation resolution. A header must never say Write while the body says LSP or Browser.

Summaries remain operation-specific, for example:

- Grep: pattern and scope
- LSP: action, symbol, file, and result count
- Bash: command
- Browser: action and URL/tab target
- MCP: `serverName/mcpToolName`
- Generic dynamic tool: effective tool name plus intent or primary argument

### Registry metadata

The renderer registry becomes the single runtime source for:

- component;
- adaptive shell kind;
- summary behavior when specialized;
- aliases.

The registry must cover the TUI’s current built-in custom-renderer names, including aliases and `think`. Unknown names resolve to the structured generic framed presentation.

This is a runtime registry contract, not a source-text parity test.

## MCP and dynamic tools

### MCP identification

A call is treated as MCP when any authoritative signal is present:

- final or partial inner details contain valid `serverName` and `mcpToolName` strings;
- the active/effective tool name follows the sidecar’s MCP naming convention during the pending phase.

Result details take precedence over name parsing as soon as they arrive.

### MCP collapsed presentation

Show:

- MCP icon/status;
- `serverName/mcpToolName` when known, otherwise the effective tool name;
- a concise inline argument preview;
- duration and error state;
- a short result summary or first output lines after completion.

### MCP expanded presentation

Show:

- structured arguments as a bounded JSON tree;
- parseable JSON results as a JSON tree;
- non-JSON text through the sanitized Markdown renderer when the existing MCP rendering preference enables Markdown;
- plain text otherwise;
- inline images/resources when the existing safe renderer can represent them;
- errors without losing the server/tool identity;
- explicit truncation metadata and artifact references supplied by the sidecar.

The GUI must not use `dangerouslySetInnerHTML` for MCP/model output. Markdown goes through the existing sanitized `MarkdownRenderer`.

### Unknown extension and host tools

Unknown tools receive:

- their effective tool name, not `write`;
- structured argument display;
- text, JSON, image, and error result treatment where recognizable;
- explicit details and truncation metadata;
- the framed adaptive shell.

Arbitrary third-party TUI renderer callbacks cannot cross the current RPC boundary. This fallback is the complete GUI-only behavior for such tools unless their wire payload matches a supported structured renderer.

## Existing specialized bodies

The approved design retains the current Grep, LSP, and Bash body structures:

- Grep keeps grouped files, line numbers, context lines, highlighted matches, counts, scope, and truncation indicators.
- LSP keeps operation badges and typed hover, diagnostics, references, and symbols results.
- Bash keeps command, terminal output, exit status, wall/timeout/artifact stats, and truncation notices.

They move into the appropriate Adaptive Hybrid shell and become reachable through the default transcript and `xd://` paths.

Browser keeps its existing safe screenshot/text behavior as a baseline, but its header and result treatment must work through device dispatch. MCP receives the new dedicated body described above.

## State and data flow

1. The transcript projection resolves an occurrence-specific `ToolEntry` as it does today.
2. `ToolCard` or a dedicated presentation boundary passes the original call plus that entry to the effective invocation resolver.
3. The resolver unwraps direct or device transport.
4. The registry selects renderer metadata from the effective name and result shape.
5. The adaptive shell renders the collapsed summary and disclosure state.
6. The specialized body receives only effective args/result/partial/error props.
7. Store updates replace the occurrence-specific entry; local disclosure state remains stable.

No second tool-result store is introduced. Main and subagent projections remain isolated and authoritative.

## Error handling and resilience

- An absent, malformed, or incomplete `xd://` path does not throw.
- Invalid inner JSON produces a bounded raw preview while streaming and a clear Generic/Write fallback when final.
- Missing `xdev.args` falls back to safely parsed outer content, then `{}`.
- Missing `xdev.inner` leaves renderer details absent; body text still renders.
- Unknown device names use the effective-name Generic renderer.
- A local renderer error is caught at the tool-entry boundary and replaced by the Generic renderer for that invocation only.
- Renderer failure details go through the existing logger rather than console output.
- Raw tool output remains sanitized, tab-safe, path-safe, bounded, and scrollable using existing GUI utilities.

## Accessibility

- Every disclosure uses a semantic button with `aria-expanded`.
- Status is not communicated by color alone; icon and text remain present.
- Live status changes use the existing restrained announcement behavior and avoid announcing every streamed line.
- Keyboard focus remains on the disclosure after expansion or collapse.
- Nested interactive controls, if any, are outside the disclosure button to avoid invalid nested buttons.

## Testing strategy

Tests defend observable transcript behavior rather than registry text.

### Effective invocation tests

- A direct LSP call resolves to LSP unchanged.
- A pending `write xd://lsp` call resolves to LSP and decodes inner arguments.
- A final device result uses `xdev.tool`, `xdev.args`, and `xdev.inner`.
- Partial device results preserve specialized live rendering.
- `mode: help` renders documentation rather than an execution result.
- Malformed inner JSON and missing metadata fall back without throwing.
- A dynamic MCP device resolves to its effective identity and MCP details.

### Transcript behavior tests

- Default compact history visibly renders completed Grep/LSP/Bash entries instead of only “N steps complete.”
- Live tool entries remain visible after settling.
- Reasoning can remain collapsed without swallowing sibling tool entries.
- Main and subagent projections render the same effective invocation without sharing store state.
- Hydrated device calls and live device calls produce equivalent labels and bodies.

### Disclosure tests

- Collapsed Grep shows its pattern/count and a bounded preview.
- Clicking expands all four received matches in the representative fixture.
- Clicking again collapses them.
- Expand/collapse-all updates compact and framed entries.
- A running expanded entry accepts partial updates without collapsing.
- Error summaries remain visible and error details remain expandable.

### MCP tests

- Collapsed MCP displays server/tool identity and arguments.
- Expanded JSON output uses structured rendering.
- Expanded non-JSON output uses sanitized Markdown or plain text according to the existing preference.
- Error and truncation metadata remain visible.
- Unknown dynamic tools use the effective name and structured Generic body.

### Visual verification

Run the real GUI and exercise representative calls through the bundled sidecar:

- direct Grep;
- `xd://` LSP;
- Bash with output and exit metadata;
- Browser action with text or screenshot output;
- MCP with JSON output;
- MCP with Markdown output;
- one malformed/unknown dynamic tool fallback.

Verify both the default compact transcript and Full mode, then reload the session to confirm hydrated parity. Capture the final Adaptive Hybrid surface for comparison with the approved mockup.

## Acceptance criteria

- The default transcript no longer replaces completed tool activity with only a generic task/process summary.
- Grep, LSP, Bash, Browser, MCP, and other supported tools are visibly distinct without opening an outer Process card.
- `write xd://<tool>` displays the underlying tool’s name, summary, arguments, result, and specialized renderer.
- A collapsed Grep entry with four matches can be clicked to show all four received matches.
- Existing Grep, LSP, and Bash bodies appear inside the Adaptive Hybrid shells without behavioral regression.
- MCP calls have dedicated, structured, expandable presentation.
- Unknown dynamic tools show their effective identity and useful structured details.
- Live, hydrated, Main, and subagent transcript paths agree.
- Renderer failures degrade locally to Generic output.
- All implementation changes remain within `packages/gui`.
