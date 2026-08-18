import { memo, useMemo } from "react";

/**
 * ANSI escape-sequence renderer for captured subprocess output.
 *
 * The bash/eval tools capture stdout+stderr from a pipe, so what arrives here
 * is not a live terminal stream — it is a static byte string that may still
 * carry SGR color codes (vitest, cargo, npm --color, …), cursor-control CSI
 * sequences, OSC 8 hyperlinks, and carriage-return progress updates. Rendering
 * that raw string verbatim prints `←[32m` garbage; this module parses it into
 * styled React segments instead:
 *
 * - SGR: 8/16 base colors (theme-aware CSS vars), 256-color cube and 24-bit
 *   truecolor (inline rgb), bold/dim/italic/underline/strikethrough/inverse.
 * - OSC 8 hyperlinks become clickable links routed through `openExternal`.
 * - All other CSI/OSC/charset escapes are stripped.
 * - `\r\n` collapses to `\n`; a bare `\r` replays terminal overwrite semantics
 *   positionally, so spinner/progress lines keep only their final frame.
 *
 * Everything emitted is React text/elements — no innerHTML, no sanitization
 * surface.
 */

export interface AnsiSegment {
	text: string;
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	inverse?: boolean;
	href?: string;
}

interface AnsiStyle {
	fg?: string;
	bg?: string;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	inverse?: boolean;
}

const COLOR_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

function baseColor(index: number): string {
	return `var(--omp-ansi-${COLOR_NAMES[index]})`;
}

function brightColor(index: number): string {
	return `var(--omp-ansi-bright-${COLOR_NAMES[index]})`;
}

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** xterm 256-color palette index → CSS color. 0-15 delegate to theme vars. */
function palette256(index: number): string {
	if (index < 8) return baseColor(index);
	if (index < 16) return brightColor(index - 8);
	if (index >= 232) {
		const level = 8 + (index - 232) * 10;
		return `rgb(${level} ${level} ${level})`;
	}
	const n = index - 16;
	const r = CUBE_LEVELS[Math.floor(n / 36) % 6];
	const g = CUBE_LEVELS[Math.floor(n / 6) % 6];
	const b = CUBE_LEVELS[n % 6];
	return `rgb(${r} ${g} ${b})`;
}

/** Apply one SGR parameter list to the running style (mutates). */
function applySgr(style: AnsiStyle, rawParams: string): void {
	// Colon sub-parameter form (38:5:n) is normalized to the semicolon form.
	const params = rawParams
		.replace(/:/g, ";")
		.split(";")
		.map(p => (p === "" ? 0 : Number(p)));
	if (params.length === 0) params.push(0);
	for (let i = 0; i < params.length; i++) {
		const p = params[i];
		if (!Number.isFinite(p)) continue;
		if (p === 0) {
			for (const key of Object.keys(style) as Array<keyof AnsiStyle>) delete style[key];
		} else if (p === 1) style.bold = true;
		else if (p === 2) style.dim = true;
		else if (p === 3) style.italic = true;
		else if (p === 4) style.underline = true;
		else if (p === 7) style.inverse = true;
		else if (p === 9) style.strikethrough = true;
		else if (p === 22) {
			delete style.bold;
			delete style.dim;
		} else if (p === 23) delete style.italic;
		else if (p === 24) delete style.underline;
		else if (p === 27) delete style.inverse;
		else if (p === 29) delete style.strikethrough;
		else if (p >= 30 && p <= 37) style.fg = baseColor(p - 30);
		else if (p === 39) delete style.fg;
		else if (p >= 40 && p <= 47) style.bg = baseColor(p - 40);
		else if (p === 49) delete style.bg;
		else if (p >= 90 && p <= 97) style.fg = brightColor(p - 90);
		else if (p >= 100 && p <= 107) style.bg = brightColor(p - 100);
		else if (p === 38 || p === 48) {
			const isFg = p === 38;
			const mode = params[i + 1];
			if (mode === 5 && typeof params[i + 2] === "number") {
				const color = palette256(params[i + 2]);
				if (isFg) style.fg = color;
				else style.bg = color;
				i += 2;
			} else if (mode === 2 && typeof params[i + 2] === "number") {
				const color = `rgb(${params[i + 2]} ${params[i + 3]} ${params[i + 4]})`;
				if (isFg) style.fg = color;
				else style.bg = color;
				i += 4;
			}
		}
	}
}

// One tokenizer pass over the raw string. Alternation order matters: SGR is
// captured with its params, OSC with its body (for OSC 8), generic CSI and
// two-byte escapes match nothing and are dropped.
const TOKEN_RE =
	/\x1b\[([0-9;:]*)m|\x1b\[([0-9;:?!<>]*)[@-~]|\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b[\x20-\x2f]*[\x30-\x7e]/g;

/** Carriage-return overwrite semantics per line, so progress spinners keep only their final frame. */
function collapseCarriageReturns(input: string): string {
	const normalized = input.replace(/\r\n/g, "\n");
	if (!normalized.includes("\r")) return normalized;
	return normalized
		.split("\n")
		.map(line => {
			if (!line.includes("\r")) return line;
			const buf: string[] = [];
			let pos = 0;
			for (const ch of line) {
				if (ch === "\r") {
					pos = 0;
					continue;
				}
				if (pos < buf.length) buf[pos] = ch;
				else buf.push(ch);
				pos++;
			}
			return buf.join("");
		})
		.join("\n");
}

// C0 controls other than tab/newline (already past the \r pass) serve no
// display purpose in captured output.
const STRAY_CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** OSC 8 body: `8;params;uri`. An empty uri closes the active hyperlink. */
function osc8Uri(body: string): string | null {
	if (!body.startsWith("8;")) return null;
	const secondSemi = body.indexOf(";", 2);
	if (secondSemi === -1) return null;
	return body.slice(secondSemi + 1);
}

/** Parse captured terminal output into styled segments. */
export function parseAnsi(input: string): AnsiSegment[] {
	const text = collapseCarriageReturns(input);
	const segments: AnsiSegment[] = [];
	const style: AnsiStyle = {};
	let href: string | undefined;
	let last = 0;

	const push = (chunk: string) => {
		if (!chunk) return;
		const cleaned = chunk.replace(STRAY_CONTROL_RE, "");
		if (!cleaned) return;
		const prev = segments[segments.length - 1];
		const styled = Object.keys(style).length > 0 || href != null;
		if (!styled) {
			// Merge into a trailing plain segment so unstyled output stays one span.
			if (prev && Object.keys(prev).length === 1) {
				prev.text += cleaned;
				return;
			}
			segments.push({ text: cleaned });
			return;
		}
		segments.push({ text: cleaned, ...style, href });
	};

	TOKEN_RE.lastIndex = 0;
	for (;;) {
		const match = TOKEN_RE.exec(text);
		if (match === null) break;
		push(text.slice(last, match.index));
		last = TOKEN_RE.lastIndex;
		if (match[1] !== undefined) {
			applySgr(style, match[1]);
		} else if (match[3] !== undefined) {
			const uri = osc8Uri(match[3]);
			if (uri !== null) href = uri === "" ? undefined : uri;
		}
		// Generic CSI / escape tokens carry no displayable content.
	}
	push(text.slice(last));
	return segments;
}

/** Fast pre-check so renderers can keep a plain-text fast path. Any ESC —
 * not just CSI — counts: OSC-only output (window titles, hyperlinks) and
 * stray C0 controls also need the parser to strip them. */
const HAS_ANSI_RE = /\x1b/;

export function hasAnsi(text: string): boolean {
	return HAS_ANSI_RE.test(text);
}

function segmentStyle(seg: AnsiSegment): React.CSSProperties {
	const style: React.CSSProperties = {};
	const fg = seg.inverse ? seg.bg : seg.fg;
	const bg = seg.inverse ? seg.fg : seg.bg;
	if (fg) style.color = fg;
	if (bg) style.backgroundColor = bg;
	if (seg.bold) style.fontWeight = 600;
	if (seg.dim) style.opacity = 0.65;
	if (seg.italic) style.fontStyle = "italic";
	const decorations: string[] = [];
	if (seg.underline) decorations.push("underline");
	if (seg.strikethrough) decorations.push("line-through");
	if (decorations.length > 0) style.textDecoration = decorations.join(" ");
	return style;
}

/** Styled rendering of captured terminal output. Plain input renders as-is. */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
	const segments = useMemo(() => parseAnsi(text), [text]);
	if (segments.length === 1 && Object.keys(segments[0]).length === 1) {
		return <>{segments[0].text}</>;
	}
	return (
		<>
			{segments.map((seg, i) =>
				seg.href ? (
					<a
						key={i}
						href={seg.href}
						onClick={e => {
							e.preventDefault();
							window.omp.system.openExternal(seg.href as string);
						}}
						style={{ ...segmentStyle(seg), textDecoration: "underline" }}
					>
						{seg.text}
					</a>
				) : (
					<span key={i} style={segmentStyle(seg)}>
						{seg.text}
					</span>
				),
			)}
		</>
	);
});
