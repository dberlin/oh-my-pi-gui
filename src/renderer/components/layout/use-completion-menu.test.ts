/**
 * applyCompletion contract: the shared completion-apply helper used by the
 * composer's model-delegation (`^selector`) menu among others. It must replace
 * ONLY the provider's [rangeStart, rangeEnd) prefix, never consume text after
 * the live caret, place the caret right after the inserted value, and refuse to
 * apply a stale menu once the caret has moved away from rangeEnd.
 */
import { parseHTML } from "linkedom";
import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionKind } from "../../../shared/ipc-types";
import type { AvailableCommand } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { applyCompletion, type CompletionItem, type CompletionMenu, useCompletionMenu } from "./use-completion-menu";

function menu(rangeStart: number, rangeEnd: number): CompletionMenu {
	return { source: "model", rangeStart, rangeEnd, items: [], index: 0 };
}

const item: CompletionItem = { value: "^anthropic/claude ", label: "^anthropic/claude" };

describe("applyCompletion", () => {
	it("replaces the ^prefix with the selector and lands the caret after it", () => {
		const result = applyCompletion("review ^cl", 10, menu(7, 10), item);
		expect(result).toEqual({ text: "review ^anthropic/claude ", caret: 7 + item.value.length });
	});

	it("preserves text after the caret instead of consuming it", () => {
		const result = applyCompletion("^cl please", 3, menu(0, 3), { value: "^x ", label: "^x" });
		expect(result).toEqual({ text: "^x  please", caret: 3 });
	});

	it("refuses to apply a stale menu once the caret moved off rangeEnd", () => {
		expect(applyCompletion("review ^cl", 9, menu(7, 10), item)).toBeNull();
	});
});

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, { omp: { rpc: {} } });

const commands: AvailableCommand[] = [
	{ name: "skill:p4-case-rename", source: "skill" },
	{ name: "p4", aliases: ["p4-alias"], subcommands: [{ name: "change" }], allowArgs: true },
	{ name: "skill:p4-args", subcommands: [{ name: "choose" }], allowArgs: true },
	{ name: "skill:p4-noargs", allowArgs: false },
	{ name: "plan" },
];

let root: Root | undefined;
let container: HTMLElement | undefined;

async function complete(text: string, cursor = text.length, selectionEnd = cursor, tabKind: SessionKind = "agent") {
	const textarea = document.createElement("textarea") as unknown as HTMLTextAreaElement;
	Object.assign(textarea, { value: text, selectionStart: cursor, selectionEnd });
	const textareaRef: RefObject<HTMLTextAreaElement | null> = { current: textarea };
	let result: CompletionMenu | null = null;
	const setMenu = (next: CompletionMenu | null) => {
		result = next;
	};
	function Probe() {
		useCompletionMenu({
			text,
			filePaths: [],
			commands,
			emojiAutocomplete: false,
			tabKind,
			textareaRef,
			setMenu,
		});
		return null;
	}
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root!.render(createElement(I18nProvider, null, createElement(Probe)));
	});
	return result as CompletionMenu | null;
}

afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	container?.remove();
	root = undefined;
	container = undefined;
});

describe("slash completion through the composer hook", () => {
	it.each([
		{ text: "/p4", label: "/skill:p4-case-rename", start: 0 },
		{ text: "/skill:p4-case", label: "/skill:p4-case-rename", start: 0 },
		{ text: "/SKILL:P4-CASE", label: "/skill:p4-case-rename", start: 0 },
		{ text: "run /p4", label: "/skill:p4-case-rename", start: 4 },
		{ text: "run\t/p4", label: "/skill:p4-case-rename", start: 4 },
		{ text: "run\n/p4", label: "/skill:p4-case-rename", start: 4 },
		{ text: "/", label: "/skill:p4-case-rename", start: 0 },
	])("offers $label for '$text' at its slash boundary", async ({ text, label, start }) => {
		const result = await complete(text);
		expect(result?.source).toBe("command");
		expect(result?.rangeStart).toBe(start);
		expect(result?.rangeEnd).toBe(text.length);
		expect(result?.items.map(candidate => candidate.label)).toContain(label);
	});

	it("applies a digit query without consuming text beyond the caret", async () => {
		const result = await complete("run /p4 keep", 7);
		expect(result).not.toBeNull();
		const candidate = result!.items.find(entry => entry.label === "/skill:p4-case-rename");
		expect(candidate).toBeDefined();
		expect(applyCompletion("run /p4 keep", 7, result!, candidate!)).toEqual({
			text: "run /skill:p4-case-rename  keep",
			caret: 26,
		});
	});

	it.each([
		{ text: "/p4 ch", value: "change ", start: 4 },
		{ text: "/skill:p4-args ch", value: "choose ", start: 15 },
		{ text: "/p4-alias ch", value: "change ", start: 10 },
		{ text: "/P4\tch", value: "change ", start: 4 },
	])("completes the argument in '$text'", async ({ text, value, start }) => {
		const result = await complete(text);
		expect(result?.source).toBe("slash-arg");
		expect(result?.rangeStart).toBe(start);
		expect(result?.items.map(candidate => candidate.value)).toEqual([value]);
		expect(applyCompletion(text, text.length, result!, result!.items[0]!)).toEqual({
			text: text.slice(0, start) + value,
			caret: start + value.length,
		});
	});

	it.each(["a/p4", "/skill:p4-case/path", "run /p4 ch", "/p4 ", "/skill:p4-noargs ch"])(
		"keeps completion closed across the '%s' boundary",
		async text => {
			expect(await complete(text)).toBeNull();
		},
	);

	it("does not complete while a digit query has a text selection", async () => {
		expect(await complete("/p4 keep", 3, 8)).toBeNull();
	});

	it("retains chat-tab command availability filtering", async () => {
		const result = await complete("/", 1, 1, "chat");
		expect(result?.items.map(candidate => candidate.label)).toContain("/skill:p4-case-rename");
		expect(result?.items.map(candidate => candidate.label)).not.toContain("/plan");
	});
});
