/**
 * Contract tests for the GUI keybinding remap layer (B3 — plan/15 §3.5,
 * plan/17 §6.3): chord parse/serialize round-trips and alias acceptance,
 * replace-not-union compilation, both conflict classes (user-user error,
 * default-shadow warning), and override sanitization that ignores unknown
 * actions on hydration. GUI-local only — nothing here touches the TUI's
 * keybindings.yml.
 */

import { describe, expect, it } from "vitest";
import {
	chordFromEvent,
	compileKeymap,
	detectConflicts,
	KEYMAP_ACTIONS,
	parseChord,
	sanitizeOverrides,
	serializeChord,
} from "./keymap";

/** Canonical form of an input chord; throws when the chord does not parse. */
function canonical(input: string): string {
	const parsed = parseChord(input);
	if (!parsed) throw new Error(`"${input}" does not parse`);
	return serializeChord(parsed);
}

const NO_MODS = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

describe("parseChord/serializeChord", () => {
	it("round-trips every default chord in the action table", () => {
		for (const action of KEYMAP_ACTIONS) {
			for (const chord of action.defaults) {
				expect(canonical(chord), `${action.id} default "${chord}"`).toBe(chord);
			}
		}
	});

	it("accepts textual modifier aliases and normalizes order + case", () => {
		expect(canonical("ctrl+shift+p")).toBe("⇧⌃P");
		expect(canonical("Control-Shift-P")).toBe("⇧⌃P");
		expect(canonical("shift+ctrl+P")).toBe("⇧⌃P");
		expect(canonical("alt+r")).toBe("⌥R");
		expect(canonical("option+r")).toBe("⌥R");
		expect(canonical("alt+shift+p")).toBe("⌥⇧P");
		expect(canonical("cmd+k")).toBe("⌘K");
		expect(canonical("command+k")).toBe("⌘K");
		expect(canonical("meta+k")).toBe("⌘K");
		expect(canonical("super+k")).toBe("⌘K");
		expect(canonical("ctrl+alt+shift+meta+o")).toBe("⌥⇧⌃⌘O");
	});

	it("parses arrow, punctuation, and bare-plus/minus base keys", () => {
		expect(canonical("alt+up")).toBe("⌥↑");
		expect(canonical("ctrl+arrowup")).toBe("⌃↑");
		expect(canonical("cmd+,")).toBe("⌘,");
		expect(canonical("cmd+/")).toBe("⌘/");
		expect(canonical("ctrl+-")).toBe("⌃-");
		expect(canonical("ctrl++")).toBe("⌃+");
	});

	it("rejects chords without a real modifier or a base key", () => {
		expect(parseChord("p")).toBeNull();
		expect(parseChord("P")).toBeNull();
		expect(parseChord("shift+p")).toBeNull();
		expect(parseChord("⇧P")).toBeNull();
		expect(parseChord("")).toBeNull();
		expect(parseChord("ctrl+")).toBeNull();
		expect(parseChord("ctrl+shift")).toBeNull();
	});

	it("is stable through a second parse/serialize round-trip", () => {
		expect(canonical(canonical("Control-Shift-P"))).toBe("⇧⌃P");
		expect(canonical(canonical("alt+up"))).toBe("⌥↑");
	});
});

describe("chordFromEvent", () => {
	it("serializes keydown events to canonical chords", () => {
		expect(chordFromEvent({ key: "p", code: "KeyP", ...NO_MODS, ctrlKey: true })).toBe("⌃P");
		expect(chordFromEvent({ key: "P", code: "KeyP", ...NO_MODS, ctrlKey: true, shiftKey: true })).toBe("⇧⌃P");
		expect(chordFromEvent({ key: "ArrowUp", code: "ArrowUp", ...NO_MODS, altKey: true })).toBe("⌥↑");
		expect(chordFromEvent({ key: ",", code: "Comma", ...NO_MODS, metaKey: true })).toBe("⌘,");
		expect(chordFromEvent({ key: "/", code: "Slash", ...NO_MODS, metaKey: true })).toBe("⌘/");
	});

	it("prefers the physical code over ⌥-composed event.key characters", () => {
		// macOS reports ⌥R as key "®" — the pre-B3 hardcoded chains were code-based
		// for exactly this reason.
		expect(chordFromEvent({ key: "®", code: "KeyR", ...NO_MODS, altKey: true })).toBe("⌥R");
		expect(chordFromEvent({ key: "∏", code: "KeyP", ...NO_MODS, altKey: true, shiftKey: true })).toBe("⌥⇧P");
	});

	it("never forms chords from bare, shift-only, or pure-modifier keys", () => {
		expect(chordFromEvent({ key: "p", code: "KeyP", ...NO_MODS })).toBeNull();
		expect(chordFromEvent({ key: "P", code: "KeyP", ...NO_MODS, shiftKey: true })).toBeNull();
		expect(chordFromEvent({ key: "Control", code: "ControlLeft", ...NO_MODS, ctrlKey: true })).toBeNull();
	});
});

describe("compileKeymap", () => {
	it("maps every default chord to its action when there are no overrides", () => {
		const map = compileKeymap(KEYMAP_ACTIONS, {});
		expect(map.get("⌃O")).toBe("tools.expand");
		expect(map.get("⇧⌃P")).toBe("model.cycleBackward");
		expect(map.get("⌥↑")).toBe("dequeue");
		expect(map.get("⌘K")).toBe("palette");
		expect(map.get("⌃K")).toBe("palette");
		expect(map.get("⌥W")).toBe("tab.close");
		expect(map.get("⌘W")).toBe("tab.close");
		expect(map.get("⌃W")).toBe("tab.close");
		expect(map.get("⌘[")).toBe("tab.previous");
		expect(map.get("⌘]")).toBe("tab.next");
	});

	it("replaces an action's defaults with its override — never a union", () => {
		const map = compileKeymap(KEYMAP_ACTIONS, { "tools.expand": ["ctrl+shift+o"] });
		expect(map.get("⇧⌃O")).toBe("tools.expand");
		// The old default chord is dead…
		expect(map.has("⌃O")).toBe(false);
		// …while untouched actions keep their defaults.
		expect(map.get("⌃T")).toBe("thinking.toggle");
	});

	it("lets an explicit user chord win a shadowed default slot", () => {
		const map = compileKeymap(KEYMAP_ACTIONS, { retry: ["ctrl+o"] });
		expect(map.get("⌃O")).toBe("retry");
	});
});

describe("detectConflicts", () => {
	it("ships a conflict-free default table", () => {
		expect(detectConflicts(KEYMAP_ACTIONS, {})).toEqual([]);
	});

	it("flags one chord claimed by two user bindings as an error", () => {
		const conflicts = detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃⇧R"], dequeue: ["ctrl+shift+r"] });
		expect(conflicts).toEqual([{ kind: "error", chord: "⇧⌃R", actionIds: ["retry", "dequeue"] }]);
	});

	it("warns when a user chord shadows another action's live default", () => {
		const conflicts = detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃O"] });
		expect(conflicts).toEqual([{ kind: "warning", chord: "⌃O", actionIds: ["retry", "tools.expand"] }]);
	});

	it("drops the shadow warning once the shadowed action is itself remapped", () => {
		const conflicts = detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃O"], "tools.expand": ["ctrl+shift+o"] });
		expect(conflicts).toEqual([]);
	});

	it("ignores a user chord equal to its own action's default or listed twice", () => {
		expect(detectConflicts(KEYMAP_ACTIONS, { retry: ["⌥R"] })).toEqual([]);
		expect(detectConflicts(KEYMAP_ACTIONS, { retry: ["⌃⇧R", "ctrl+shift+r"] })).toEqual([]);
	});
});

describe("sanitizeOverrides", () => {
	it("drops unknown actions, non-arrays, unparsable and duplicate chords", () => {
		const raw = {
			"bogus.action": ["ctrl+q"],
			retry: ["alt+shift+r", "⌥⇧R", "not a chord", 42],
			"tools.expand": "ctrl+o",
			dequeue: [],
		};
		expect(sanitizeOverrides(KEYMAP_ACTIONS, raw)).toEqual({ retry: ["⌥⇧R"] });
	});

	it("returns an empty table for non-object payloads", () => {
		expect(sanitizeOverrides(KEYMAP_ACTIONS, null)).toEqual({});
		expect(sanitizeOverrides(KEYMAP_ACTIONS, ["ctrl+o"])).toEqual({});
		expect(sanitizeOverrides(KEYMAP_ACTIONS, "ctrl+o")).toEqual({});
	});
});
