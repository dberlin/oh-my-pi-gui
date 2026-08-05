import { type ComponentPropsWithoutRef, isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { MermaidBlock } from "../components/chat/MermaidBlock";

interface MarkdownRendererProps {
	content: string;
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
		ol: ["start"],
		td: ["align"],
		th: ["align"],
	},
	protocols: {
		href: ["http", "https", "mailto"],
		src: ["http", "https"],
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
	// A mermaid fence swaps the whole block for a diagram with its own chrome —
	// skip the <pre> wrapper so the diagram is not boxed like code.
	if (isMermaidCodeElement(children)) return <>{children}</>;
	return (
		<pre
			{...props}
			className="p-3 rounded-md bg-[var(--omp-code-bg)] border border-[var(--omp-md-code-block-border)] overflow-x-auto my-2 text-[var(--omp-md-code-block)]"
		>
			{children}
		</pre>
	);
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
};

/**
 * Renders markdown content with GFM, a sanitized raw-HTML subset, KaTeX math,
 * and syntax highlighting. Memoized: re-parses only when `content` changes.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: MarkdownRendererProps) {
	return (
		<div className="markdown-body text-[1em] leading-[1.5]">
			<ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
				{content}
			</ReactMarkdown>
		</div>
	);
});
