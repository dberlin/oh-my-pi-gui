import {
	type ComponentPropsWithoutRef,
	createContext,
	isValidElement,
	memo,
	type ReactNode,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
} from "react";
import ReactMarkdown, { type Components, defaultUrlTransform, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { LineNumberGutter } from "../components/chat/LineNumberGutter";
import { MermaidBlock } from "../components/chat/MermaidBlock";
import { useT } from "./i18n";

interface MarkdownRendererProps {
	content: string;
	/**
	 * Force the codeLineNumbers pref on/off. When undefined, code blocks follow
	 * the GUI pref (hydrated from prefs IPC, flips live on Settings changes).
	 * SSR/tests pass this — the pref store's server snapshot is always off.
	 */
	codeLineNumbers?: boolean;
}

// Hoisted to module scope: stable plugin arrays and component maps keep
// ReactMarkdown from treating the pipeline as changed on every render.
// remark-math must precede rehype-katex: it parses $...$/$$...$$ into math
// nodes that rehype-katex (rehype chain below) then renders.
const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm, remarkMath];

type SanitizeSchema = NonNullable<Parameters<typeof rehypeSanitize>[0]>;

// Model output is untrusted: allow only a formatting-oriented HTML subset.
// No script/iframe/object/embed/form/input, no on* handlers, no style — every
// attribute not listed here is dropped. hast-util-sanitize shallow-merges over
// the GitHub default schema, so every field that must differ from the default
// is set explicitly.
const SANITIZE_SCHEMA: SanitizeSchema = {
	tagNames: [
		// Raw-HTML subset (also covers inline markdown output).
		"a",
		"abbr",
		"b",
		"blockquote",
		"br",
		"code",
		"del",
		"details",
		"em",
		"hr",
		"i",
		"ins",
		"kbd",
		"li",
		"mark",
		"ol",
		"p",
		"pre",
		"s",
		"small",
		"span",
		"strong",
		"sub",
		"summary",
		"sup",
		"u",
		"ul",
		// Markdown/GFM block structure that must survive sanitation.
		"h1",
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"img",
		// GFM task-list checkboxes. rehype-raw runs BEFORE sanitize, so a raw
		// `<input>` in model output also survives — the attribute value pin below
		// is what keeps `type="password"/"file"/"text"` from becoming interactive.
		"input",
		"table",
		"thead",
		"tbody",
		"tr",
		"th",
		"td",
	],
	attributes: {
		a: ["href"],
		abbr: ["title"],
		// `language-*` on code feeds rehype-highlight's language detection.
		code: ["className"],
		span: ["className"],
		img: ["src", "alt", "title"],
		// Value-pinned: only type="checkbox" survives; any other type value is
		// dropped with the attribute. checked/disabled carry the GFM state.
		input: [["type", "checkbox"], "checked", "disabled"],
		ol: ["start"],
		td: ["align"],
		th: ["align"],
	},
	protocols: {
		href: ["http", "https", "mailto"],
		// data: keeps inline base64 images; file: is resolved to a workspace /
		// absolute read by the MarkdownImage component (protocol stripped).
		src: ["http", "https", "data", "file"],
	},
	// Unknown tags are replaced by their children; these hold code/resources,
	// not prose, so drop their contents too.
	strip: ["script", "style", "iframe", "object", "embed", "title", "textarea"],
};

// Order matters: rehype-raw parses embedded HTML into the tree, rehype-sanitize
// then filters the whole tree against the strict schema, and katex/highlight
// run last so their own generated markup (MathML, hljs classes) is not
// sanitized away. Code `language-*` classes survive sanitize for highlight.
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
	rehypeRaw,
	[rehypeSanitize, SANITIZE_SCHEMA],
	rehypeKatex,
	rehypeHighlight,
];

// react-markdown's defaultUrlTransform blanks data:/file: URLs even when the
// sanitize schema allows them. Images need both (inline base64, local files
// resolved via IPC), so let image-bearing protocols through for <img src> and
// defer to the default everywhere else.
const URL_TRANSFORM: NonNullable<Options["urlTransform"]> = (url, key, node) => {
	if (key === "src" && node?.tagName === "img" && /^(data|blob|file):/i.test(url)) return url;
	return defaultUrlTransform(url);
};

function ExternalLink({ href, children, ...props }: ComponentPropsWithoutRef<"a">) {
	return (
		<a
			{...props}
			href={href}
			onClick={e => {
				e.preventDefault();
				if (href) {
					window.omp.system.openExternal(href);
				}
			}}
			className="text-[var(--omp-md-link)] underline decoration-[var(--omp-md-link-url)] hover:decoration-[var(--omp-md-link)]"
		>
			{children}
		</a>
	);
}

function StyledTable({ children, ...props }: ComponentPropsWithoutRef<"table">) {
	return (
		<div className="overflow-x-auto my-2">
			<table {...props} className="w-full border-collapse text-sm">
				{children}
			</table>
		</div>
	);
}

// ── codeLineNumbers pref (GUI prefs file, NOT zustand) ─────────────────────
// Module snapshot hydrated lazily from window.omp.prefs when the first code
// block mounts; Settings writes go through setCodeLineNumbersPref, which
// flips every mounted block live without re-parsing markdown. SSR never runs
// subscriptions, so tests drive rendering via the MarkdownRenderer
// `codeLineNumbers` prop (the server snapshot below is always off).
let codeLineNumbersSnapshot = false;
let codeLineNumbersHydrated = false;
const codeLineNumbersListeners = new Set<() => void>();

function setCodeLineNumbersSnapshot(next: boolean): void {
	if (codeLineNumbersSnapshot === next) return;
	codeLineNumbersSnapshot = next;
	for (const listener of codeLineNumbersListeners) listener();
}

function subscribeCodeLineNumbers(listener: () => void): () => void {
	codeLineNumbersListeners.add(listener);
	if (!codeLineNumbersHydrated) {
		codeLineNumbersHydrated = true;
		try {
			void window.omp.prefs
				.get("codeLineNumbers")
				.then(value => {
					if (value === true) setCodeLineNumbersSnapshot(true);
				})
				.catch(() => {});
		} catch {
			// prefs IPC unavailable (tests, storybook) — default off.
		}
	}
	return () => {
		codeLineNumbersListeners.delete(listener);
	};
}

/** Settings GUI-tab write path: flip every mounted code block live + persist. */
export function setCodeLineNumbersPref(next: boolean): void {
	codeLineNumbersHydrated = true;
	setCodeLineNumbersSnapshot(next);
	try {
		void window.omp.prefs.set("codeLineNumbers", next);
	} catch {
		// prefs IPC unavailable (tests, storybook).
	}
}

/** MarkdownRenderer prop → Pre, threading around the static components map. */
const CodeLineNumbersOverride = createContext<boolean | undefined>(undefined);

function useCodeLineNumbers(): boolean {
	const override = useContext(CodeLineNumbersOverride);
	const pref = useSyncExternalStore(
		subscribeCodeLineNumbers,
		() => codeLineNumbersSnapshot,
		() => false,
	);
	return override ?? pref;
}

const MERMAID_CLASS = /(?:^|\s)language-mermaid(?:\s|$)/;

/** Plain-text content of a rendered node (mermaid fences are never highlighted). */
function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}

function isMermaidCodeElement(node: ReactNode): boolean {
	return (
		isValidElement<{ className?: unknown }>(node) &&
		typeof node.props.className === "string" &&
		MERMAID_CLASS.test(node.props.className)
	);
}

function CodeBlock({ className, children, ...props }: ComponentPropsWithoutRef<"code">) {
	// Mermaid fences render as diagrams; MermaidBlock falls back to source on error.
	if (typeof className === "string" && MERMAID_CLASS.test(className)) {
		return <MermaidBlock code={textOf(children)} />;
	}
	const isInline = !className;
	if (isInline) {
		return (
			<code
				{...props}
				className="px-1 py-0.5 rounded bg-[var(--omp-code-bg)] text-[var(--omp-md-code)] font-mono text-[0.9em]"
			>
				{children}
			</code>
		);
	}
	return (
		<code {...props} className={`${className ?? ""} font-mono text-[0.9em] leading-[1.3]`}>
			{children}
		</code>
	);
}

function H1({ children, ...props }: ComponentPropsWithoutRef<"h1">) {
	return (
		<h1 {...props} className="text-xl font-bold mt-4 mb-2 text-[var(--omp-md-heading)]">
			{children}
		</h1>
	);
}

function H2({ children, ...props }: ComponentPropsWithoutRef<"h2">) {
	return (
		<h2 {...props} className="text-lg font-bold mt-3 mb-2 text-[var(--omp-md-heading)]">
			{children}
		</h2>
	);
}

function H3({ children, ...props }: ComponentPropsWithoutRef<"h3">) {
	return (
		<h3 {...props} className="text-base font-semibold mt-3 mb-1 text-[var(--omp-md-heading)]">
			{children}
		</h3>
	);
}

function Blockquote({ children, ...props }: ComponentPropsWithoutRef<"blockquote">) {
	return (
		<blockquote
			{...props}
			className="border-l-2 border-[var(--omp-md-quote-border)] pl-3 text-[var(--omp-md-quote)] italic"
		>
			{children}
		</blockquote>
	);
}

function Hr(props: ComponentPropsWithoutRef<"hr">) {
	return <hr {...props} className="border-[var(--omp-md-hr)] my-4" />;
}

function Li({ children, ...props }: ComponentPropsWithoutRef<"li">) {
	return (
		<li {...props} className="ml-4 [&::marker]:text-[var(--omp-md-list-bullet)]">
			{children}
		</li>
	);
}

function Pre({ children, ...props }: ComponentPropsWithoutRef<"pre">) {
	const showLineNumbers = useCodeLineNumbers();
	// A mermaid fence swaps the whole block for a diagram with its own chrome —
	// skip the <pre> wrapper so the diagram is not boxed like code.
	if (isMermaidCodeElement(children)) return <>{children}</>;
	if (!showLineNumbers) {
		return (
			<pre
				{...props}
				className="p-3 rounded-md bg-[var(--omp-code-bg)] border border-[var(--omp-md-code-block-border)] overflow-x-auto my-2 text-[var(--omp-md-code-block)]"
			>
				{children}
			</pre>
		);
	}
	// Line-number mode mirrors the tool-renderers' CodeBlock: shared sticky
	// gutter + code pane. Gutter metrics (text size, leading, block padding)
	// match the code element's text-[0.9em] leading-[1.3] so numbers and lines
	// stay aligned; a fence's trailing newline never paints a visible line, so
	// it is stripped before counting.
	const text = textOf(children).replace(/\n$/, "");
	let lineCount = 1;
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineCount++;
	return (
		<div className="rounded-md bg-[var(--omp-code-bg)] border border-[var(--omp-md-code-block-border)] my-2 text-[var(--omp-md-code-block)]">
			<div className="flex">
				<LineNumberGutter lineCount={lineCount} className="py-3 pl-3 pr-2 text-[0.9em] leading-[1.3]" />
				<pre {...props} className="min-w-0 flex-1 overflow-x-auto p-3">
					{children}
				</pre>
			</div>
		</div>
	);
}

function TaskCheckbox(props: ComponentPropsWithoutRef<"input">) {
	// The checkbox state comes from model output — there is nowhere a click
	// could be stored. Force the readonly form regardless of what the input
	// carried (second layer on top of the sanitize value pin).
	return <input {...props} type="checkbox" disabled readOnly tabIndex={-1} />;
}

// ── Markdown images ─────────────────────────────────────────────────────────
// Model output references images three ways: remote URLs (loaded directly —
// CSP allows http/https), inline data: URLs, and local paths (screenshots,
// generated images) that the browser cannot resolve from the bundle origin.
// Local paths go through the fs:read-image IPC (sniffed mime + size cap) and
// come back as data URLs.

export type MarkdownImageSrc =
	| { kind: "direct"; src: string }
	| { kind: "local"; path: string }
	| { kind: "none" };

/** Classifies an <img> src after sanitize: direct-load URL, local path, or unusable. */
export function classifyImageSrc(src: string | undefined): MarkdownImageSrc {
	if (!src) return { kind: "none" };
	if (src.startsWith("data:") || src.startsWith("blob:")) return { kind: "direct", src };
	if (/^https?:\/\//i.test(src)) return { kind: "direct", src };
	if (src.startsWith("//")) return { kind: "direct", src: `https:${src}` };
	if (/^file:\/\//i.test(src)) {
		let raw = src.replace(/^file:\/\//i, "");
		try {
			raw = decodeURIComponent(raw);
		} catch {
			// Malformed escapes — resolve the raw string rather than failing the image.
		}
		return { kind: "local", path: raw };
	}
	// Bare paths — absolute (/…, ~\…, C:\…), relative (./…, ../…), or plain
	// filenames — all resolve through the workspace/absolute read.
	return { kind: "local", path: src };
}

const MARKDOWN_IMAGE_CLASS = "my-1 max-h-72 max-w-full rounded-md border border-[var(--omp-border-muted)] object-contain";

function MarkdownImageFallback({ alt, path }: { alt: string; path?: string }) {
	return (
		<span
			title={path}
			className="my-1 inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--omp-border-muted)] px-2 py-1 text-[12px] text-[var(--omp-dim)]"
		>
			<span className="truncate">{alt || path || "image"}</span>
			{alt && path && <span className="shrink-0 truncate font-mono text-[10px] opacity-70">{path}</span>}
		</span>
	);
}

function LocalMarkdownImage({ path, alt, title }: { path: string; alt: string; title?: string }) {
	const t = useT();
	const [resolved, setResolved] = useState<{ url: string } | { error: true } | null>(null);
	useEffect(() => {
		let cancelled = false;
		window.omp.fs
			.readImage(path)
			.then(result => {
				if (!cancelled) setResolved(result.ok && result.dataUrl ? { url: result.dataUrl } : { error: true });
			})
			.catch(() => {
				if (!cancelled) setResolved({ error: true });
			});
		return () => {
			cancelled = true;
		};
	}, [path]);
	if (!resolved) return <MarkdownImageFallback alt={alt} path={path} />;
	if ("error" in resolved) {
		return (
			<span title={t("markdown.imageFailed")}>
				<MarkdownImageFallback alt={alt} path={path} />
			</span>
		);
	}
	return <img src={resolved.url} alt={alt} title={title ?? alt} className={MARKDOWN_IMAGE_CLASS} />;
}

function MarkdownImage({ src, alt, title, ...props }: ComponentPropsWithoutRef<"img">) {
	const classified = classifyImageSrc(typeof src === "string" ? src : undefined);
	const altText = typeof alt === "string" ? alt : "";
	if (classified.kind === "none") return <MarkdownImageFallback alt={altText} />;
	if (classified.kind === "local") {
		return <LocalMarkdownImage path={classified.path} alt={altText} title={typeof title === "string" ? title : undefined} />;
	}
	return <img {...props} src={classified.src} alt={altText} title={title} className={MARKDOWN_IMAGE_CLASS} />;
}

const COMPONENTS: Components = {
	a: ExternalLink,
	table: StyledTable,
	code: CodeBlock,
	h1: H1,
	h2: H2,
	h3: H3,
	blockquote: Blockquote,
	hr: Hr,
	li: Li,
	pre: Pre,
	input: TaskCheckbox,
	img: MarkdownImage,
};

/**
 * Renders markdown content with GFM, a sanitized raw-HTML subset, KaTeX math,
 * and syntax highlighting. Memoized: re-parses only when `content` changes.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ content, codeLineNumbers }: MarkdownRendererProps) {
	return (
		<div className="markdown-body text-[1em] leading-[1.5]">
			<CodeLineNumbersOverride.Provider value={codeLineNumbers}>
				<ReactMarkdown
					remarkPlugins={REMARK_PLUGINS}
					rehypePlugins={REHYPE_PLUGINS}
					components={COMPONENTS}
					urlTransform={URL_TRANSFORM}
				>
					{content}
				</ReactMarkdown>
			</CodeLineNumbersOverride.Provider>
		</div>
	);
});
