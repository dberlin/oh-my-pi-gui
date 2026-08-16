import type { ComponentType } from "react";
import { AskRenderer } from "./AskRenderer";
import { AstEditRenderer } from "./AstEditRenderer";
import { AstGrepRenderer } from "./AstGrepRenderer";
import { BashRenderer } from "./BashRenderer";
import { BrowserRenderer } from "./BrowserRenderer";
import { ComputerRenderer } from "./ComputerRenderer";
import { DebugRenderer } from "./DebugRenderer";
import { EditRenderer } from "./EditRenderer";
import { EvalRenderer } from "./EvalRenderer";
import { GenericRenderer } from "./GenericRenderer";
import { GithubRenderer } from "./GithubRenderer";
import { GlobRenderer } from "./GlobRenderer";
import { GoalRenderer } from "./GoalRenderer";
import { GrepRenderer } from "./GrepRenderer";
import { HelpRenderer } from "./HelpRenderer";
import { HubRenderer } from "./HubRenderer";
import { ImageRenderer } from "./ImageRenderer";
import { LspRenderer } from "./LspRenderer";
import { McpRenderer } from "./McpRenderer";
import { MemoryRenderer } from "./MemoryRenderer";
import { ReadRenderer } from "./ReadRenderer";
import { ResolveRenderer } from "./ResolveRenderer";
import { TaskRenderer } from "./TaskRenderer";
import { ThinkRenderer } from "./ThinkRenderer";
import { TodoRenderer } from "./TodoRenderer";
import type { ToolRendererProps } from "./ToolCard";
import type { EffectiveToolInvocation } from "./tool-presentation";
import {
	VibeKillRenderer,
	VibeListRenderer,
	VibeSendRenderer,
	VibeSpawnRenderer,
	VibeWaitRenderer,
} from "./VibeRenderer";
import { WebSearchRenderer } from "./WebSearchRenderer";
import { WriteRenderer } from "./WriteRenderer";

export type { ToolRendererProps };

export type ToolShell = "compact" | "framed" | "domain";
export type ToolRendererView = "preview" | "expanded";

export interface ToolRendererDefinition {
	component: ComponentType<ToolRendererProps>;
	shell: ToolShell;
}

const REGISTRY: Record<string, ToolRendererDefinition> = {
	read: { component: ReadRenderer, shell: "compact" },
	grep: { component: GrepRenderer, shell: "compact" },
	glob: { component: GlobRenderer, shell: "compact" },
	lsp: { component: LspRenderer, shell: "compact" },
	ast_grep: { component: AstGrepRenderer, shell: "compact" },
	web_search: { component: WebSearchRenderer, shell: "compact" },
	write: { component: WriteRenderer, shell: "framed" },
	edit: { component: EditRenderer, shell: "framed" },
	apply_patch: { component: EditRenderer, shell: "framed" },
	ast_edit: { component: AstEditRenderer, shell: "framed" },
	resolve: { component: ResolveRenderer, shell: "framed" },
	// A pending reject carries only a reason — the wrapper pins the operation
	// so the card never renders as "Resolving".
	reject: {
		component: (props: ToolRendererProps) => <ResolveRenderer {...props} operation="reject" />,
		shell: "framed",
	},
	bash: { component: BashRenderer, shell: "framed" },
	eval: { component: EvalRenderer, shell: "framed" },
	browser: { component: BrowserRenderer, shell: "framed" },
	computer: { component: ComputerRenderer, shell: "framed" },
	debug: { component: DebugRenderer, shell: "framed" },
	image: { component: ImageRenderer, shell: "framed" },
	image_gen: { component: ImageRenderer, shell: "framed" },
	inspect_image: { component: ImageRenderer, shell: "framed" },
	task: { component: TaskRenderer, shell: "domain" },
	todo: { component: TodoRenderer, shell: "domain" },
	todowrite: { component: TodoRenderer, shell: "domain" },
	todo_write: { component: TodoRenderer, shell: "domain" },
	set_todos: { component: TodoRenderer, shell: "domain" },
	goal: { component: GoalRenderer, shell: "domain" },
	hub: { component: HubRenderer, shell: "domain" },
	ask: { component: AskRenderer, shell: "domain" },
	github: { component: GithubRenderer, shell: "domain" },
	gh: { component: GithubRenderer, shell: "domain" },
	retain: { component: MemoryRenderer, shell: "domain" },
	recall: {
		component: (props: ToolRendererProps) => <MemoryRenderer {...props} operation="recall" />,
		shell: "domain",
	},
	reflect: {
		component: (props: ToolRendererProps) => <MemoryRenderer {...props} operation="reflect" />,
		shell: "domain",
	},
	memory_edit: { component: MemoryRenderer, shell: "domain" },
	vibe_spawn: { component: VibeSpawnRenderer, shell: "domain" },
	vibe_send: { component: VibeSendRenderer, shell: "domain" },
	vibe_wait: { component: VibeWaitRenderer, shell: "domain" },
	vibe_kill: { component: VibeKillRenderer, shell: "domain" },
	vibe_list: { component: VibeListRenderer, shell: "domain" },
	think: { component: ThinkRenderer, shell: "domain" },
};

const GENERIC_RENDERER: ToolRendererDefinition = {
	component: GenericRenderer,
	shell: "framed",
};

const HELP_RENDERER: ToolRendererDefinition = {
	component: HelpRenderer,
	shell: "framed",
};

const MCP_RENDERER: ToolRendererDefinition = {
	component: McpRenderer,
	shell: "framed",
};

export function getToolRenderer(invocation: EffectiveToolInvocation): ToolRendererDefinition {
	if (invocation.mode === "help") return HELP_RENDERER;
	if (invocation.mcp) return MCP_RENDERER;
	return REGISTRY[invocation.name] ?? GENERIC_RENDERER;
}
