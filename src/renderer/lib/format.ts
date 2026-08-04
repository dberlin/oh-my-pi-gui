/**
 * Formatting + small value-extraction utilities shared by renderer components.
 * No runtime dependencies.
 */

/** Join class names, dropping falsy parts. */
export function cx(...parts: Array<string | false | null | undefined>): string {
	return parts.filter(Boolean).join(" ");
}

/** "just now" / "8m" / "3h" / "2d" / "Aug 2" */
export function formatTimeAgo(iso: string | undefined | null): string {
	if (!iso) return "";
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, (Date.now() - then) / 1000);
	if (seconds < 45) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`;
	return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Full clock string for tooltips. */
export function formatClock(value: number | string | undefined | null): string {
	const timestamp = toMs(value);
	return timestamp == null ? "" : new Date(timestamp).toLocaleString();
}

/** Accepts epoch ms (number) or ISO strings. */
function toMs(value: number | string | undefined | null): number | null {
	if (value == null) return null;
	if (typeof value === "number") return value;
	const t = Date.parse(value);
	return Number.isNaN(t) ? null : t;
}

/** Human duration from a start/end pair (epoch ms or ISO). */
export function durationBetween(
	start: number | string | undefined | null,
	end: number | string | undefined | null,
): string | null {
	const s = toMs(start);
	const e = toMs(end);
	if (s == null) return null;
	const ms = Math.max(0, (e ?? Date.now()) - s);
	return formatDuration(ms);
}

/** 824 → "824ms", 12400 → "12.4s", 185000 → "3m 5s" */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m ${s}s`;
}

const EXT_LANG: Record<string, string> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	pl: "perl",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	fish: "bash",
	ps1: "powershell",
	json: "json",
	jsonc: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "ini",
	xml: "xml",
	html: "xml",
	htm: "xml",
	vue: "xml",
	svg: "xml",
	css: "css",
	scss: "scss",
	less: "less",
	sql: "sql",
	md: "markdown",
	markdown: "markdown",
	graphql: "graphql",
	gql: "graphql",
	proto: "protobuf",
	lua: "lua",
	r: "r",
	dart: "dart",
	ex: "elixir",
	exs: "elixir",
	hs: "haskell",
	zig: "zig",
};

/** Guess a highlight.js language from a file path's extension. */
export function languageFromPath(path: string | null | undefined): string {
	if (!path) return "plaintext";
	const dot = path.lastIndexOf(".");
	if (dot < 0) return "plaintext";
	return EXT_LANG[path.slice(dot + 1).toLowerCase()] ?? "plaintext";
}

/** 950 → "950", 12_300 → "12.3k", 1_500_000 → "1.5M" */
export function formatTokens(n: number | null | undefined): string {
	if (n == null) return "–";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(Math.round(n));
}

export function formatBytes(n: number): string {
	if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function basename(path: string | null | undefined): string {
	if (!path) return "";
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] ?? path;
}

export function dirname(path: string | null | undefined): string {
	if (!path) return "";
	const parts = path.split(/[\\/]/);
	parts.pop();
	return parts.join("/") || "/";
}

/** Collapse a home-dir prefix to "~" and middle-truncate long paths. */
export function shortenPath(path: string): string {
	const home = /^\/(Users|home)\/[^/]+/.exec(path);
	let display = home ? `~${path.slice(home[0].length)}` : path;
	const MAX = 56;
	if (display.length > MAX) {
		const keep = Math.floor((MAX - 1) / 2);
		display = `${display.slice(0, keep)}…${display.slice(-keep)}`;
	}
	return display;
}

/** First N lines of a text block, plus the count of omitted lines. */
export function headLines(text: string, max: number): { head: string; omitted: number } {
	const lines = text.split("\n");
	if (lines.length <= max) return { head: text, omitted: 0 };
	return { head: lines.slice(0, max).join("\n"), omitted: lines.length - max };
}

/**
 * Best-effort plain-text extraction from an unknown tool result payload.
 * Unwraps the live `AgentToolResult` envelope (`{ content, details }`) so a
 * renderer never sees the raw JSON of the envelope itself.
 */
export function resultText(result: unknown): string {
	if (result == null) return "";
	if (typeof result === "string") return result;
	if (typeof result === "number" || typeof result === "boolean") return String(result);
	if (Array.isArray(result)) return result.map(resultText).filter(Boolean).join("\n");
	if (typeof result === "object") {
		const r = result as Record<string, unknown>;
		// Non-text content block (image/toolUse/…): no text to extract.
		if (typeof r.type === "string" && r.type !== "text" && typeof r.text !== "string") return "";
		if (typeof r.content === "string") return r.content;
		// Live/hydrated envelope: content is an array of blocks — recurse into it
		// (text blocks yield their text; image/other blocks yield nothing).
		if (Array.isArray(r.content)) return resultText(r.content);
		if (typeof r.text === "string") return r.text;
		if (typeof r.output === "string") return r.output;
		if (typeof r.stdout === "string") {
			const err = typeof r.stderr === "string" && r.stderr ? `\n${r.stderr}` : "";
			return `${r.stdout}${err}`;
		}
		if (typeof r.message === "string") return r.message;
		try {
			return JSON.stringify(result, null, 2);
		} catch {
			return String(result);
		}
	}
	return String(result);
}

/** Structured `details` payload of a live AgentToolResult envelope, when present. */
export function resultDetails(result: unknown): Record<string, unknown> | undefined {
	if (result == null || typeof result !== "object" || Array.isArray(result)) return undefined;
	const details = (result as Record<string, unknown>).details;
	if (details != null && typeof details === "object" && !Array.isArray(details)) {
		return details as Record<string, unknown>;
	}
	return undefined;
}

/** Best-effort plain text of a result, unwrapping the `{ content, details }` envelope first. */
export function resultBodyText(result: unknown): string {
	return resultText(result);
}

/**
 * Find an inline-renderable image (data: URL) inside an unknown tool result.
 * Remote URLs are not returned — the renderer CSP only allows 'self', data:, blob:.
 */
export function extractImageDataUrl(value: unknown, depth = 0): string | null {
	if (value == null || depth > 4) return null;
	if (typeof value === "string") {
		return value.startsWith("data:image/") ? value : null;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const hit = extractImageDataUrl(item, depth + 1);
			if (hit) return hit;
		}
		return null;
	}
	if (typeof value === "object") {
		const r = value as Record<string, unknown>;
		if (r.type === "image" && typeof r.data === "string") {
			const media = typeof r.mimeType === "string" ? r.mimeType : "image/png";
			return `data:${media};base64,${r.data}`;
		}
		if (r.type === "image" && r.source && typeof r.source === "object") {
			const src = r.source as Record<string, unknown>;
			if (src.type === "base64" && typeof src.data === "string") {
				const media = typeof src.media_type === "string" ? src.media_type : "image/png";
				return `data:${media};base64,${src.data}`;
			}
			if (src.type === "url" && typeof src.url === "string" && src.url.startsWith("data:image/")) {
				return src.url;
			}
		}
		for (const key of ["image", "screenshot", "dataUrl", "data_url", "content"]) {
			const hit = extractImageDataUrl(r[key], depth + 1);
			if (hit) return hit;
		}
	}
	return null;
}

/** Copy text to the clipboard (Chromium renderer). Resolves true on success. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
