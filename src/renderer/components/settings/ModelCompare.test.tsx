/**
 * Tests for the model comparison window: closed-state rendering plus the pure
 * row-derivation (buildModelRows) and cost-formatting contracts that drive the
 * matrix. Mounted assertions cover what a row is allowed to commit, which needs
 * a real DOM: react-dom/server renders createPortal children as empty in this
 * repo's test environment.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ModelInfo,
	ModelRoleEntry,
	ProviderInfo,
	RpcCommand,
	RpcResponse,
} from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { buildModelRows, formatCost, ModelCompare } from "./ModelCompare";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

function model(partial: ModelInfo): ModelInfo {
	return { ...partial };
}

function provider(partial: Partial<ProviderInfo> & { id: string }): ProviderInfo {
	return { name: partial.id, authenticated: true, loginAvailable: false, disabled: false, modelCount: 1, ...partial };
}

function role(partial: Partial<ModelRoleEntry> & { id: string }): ModelRoleEntry {
	return {
		name: partial.id,
		tag: partial.id.toUpperCase(),
		color: "default",
		source: "settings",
		section: "chat",
		candidates: [],
		...partial,
	};
}

describe("formatCost", () => {
	it("formats per-million costs and trims insignificant zeros without eating integer zeros", () => {
		expect(formatCost(0)).toBe("$0");
		expect(formatCost(0.15)).toBe("$0.15");
		expect(formatCost(0.075)).toBe("$0.075");
		expect(formatCost(2.5)).toBe("$2.5");
		expect(formatCost(3)).toBe("$3");
		expect(formatCost(10)).toBe("$10");
		expect(formatCost(100)).toBe("$100");
		expect(formatCost(250)).toBe("$250");
	});
});

describe("buildModelRows", () => {
	it("joins provider auth metadata and falls back to the provider id for the name", () => {
		const rows = buildModelRows({
			models: [model({ provider: "anthropic", id: "claude-opus" }), model({ provider: "local", id: "llama" })],
			providers: [provider({ id: "anthropic", name: "Anthropic", authenticated: true, authKind: "oauth" })],
			roles: [],
		});
		expect(rows[0]).toMatchObject({
			providerName: "Anthropic",
			authKnown: true,
			authenticated: true,
			authKind: "oauth",
		});
		// Provider absent from get_providers: auth unknown, name falls back to id.
		expect(rows[1]).toMatchObject({ providerName: "local", authKnown: false, authenticated: false });
	});

	it("marks auth unknown for every row when the catalog generation carried no provider rows", () => {
		const rows = buildModelRows({
			models: [model({ provider: "openai", id: "gpt-5" })],
			providers: [],
			roles: null,
		});
		expect(rows[0].authKnown).toBe(false);
		expect(rows[0].roles).toEqual([]);
	});

	it("matches role assignments by exact provider/id key only", () => {
		const rows = buildModelRows({
			models: [
				model({ provider: "anthropic", id: "claude-opus" }),
				model({ provider: "openai", id: "claude-opus" }),
			],
			providers: [],
			roles: [
				role({ id: "default", model: "anthropic/claude-opus" }),
				role({ id: "smol", model: "claude-opus" }), // bare id — must not match
			],
		});
		expect(rows[0].roles.map(r => r.id)).toEqual(["default"]);
		expect(rows[1].roles).toEqual([]);
	});

	it("reads optional wire metadata defensively: missing cost/context become null, name equal to id is dropped", () => {
		const rows = buildModelRows({
			models: [
				model({
					provider: "p",
					id: "rich",
					name: "Rich Model",
					contextWindow: 200_000,
					cost: { input: 3, output: 15 },
				}),
				model({ provider: "p", id: "bare", name: "bare", contextWindow: null }),
			],
			providers: [],
			roles: null,
		});
		expect(rows[0]).toMatchObject({ name: "Rich Model", contextWindow: 200_000, costIn: 3, costOut: 15 });
		expect(rows[1]).toMatchObject({ name: null, contextWindow: null, costIn: null, costOut: null });
	});
});

describe("ModelCompare", () => {
	it("renders nothing when closed", () => {
		expect(
			renderToStaticMarkup(
				<I18nProvider>
					<ModelCompare onClose={() => {}} open={false} />
				</I18nProvider>,
			),
		).toBe("");
	});
});

// ---------------------------------------------------------------------------
// What a row may commit. The matrix sets the session model with a single click
// anywhere on the row, so a provider that cannot serve — switched off, or
// known to hold no credential — must not be selectable, while a row whose auth
// merely failed to load stays usable: a degraded read is not evidence of no
// access.
// ---------------------------------------------------------------------------

function providerInfo(id: string, overrides: Partial<ProviderInfo> = {}): ProviderInfo {
	return { id, name: id, authenticated: true, loginAvailable: false, disabled: false, modelCount: 1, ...overrides };
}

function ok(command: string, data?: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

const command = vi.fn(
	async (req: RpcCommand): Promise<RpcResponse> =>
		ok(
			req.type,
			req.type === "get_providers"
				? {
						providers: [
							providerInfo("serving"),
							providerInfo("noauth", { authenticated: false }),
							providerInfo("off", { disabled: true }),
						],
						// "unlisted" is deliberately absent from the provider rows above.
						models: [
							{ provider: "serving", id: "serving-model" },
							{ provider: "noauth", id: "noauth-model" },
							{ provider: "off", id: "off-model" },
							{ provider: "unlisted", id: "unlisted-model" },
						],
						discoveryStates: [],
						refreshPending: false,
						generation: 1,
					}
				: undefined,
		),
);

const setModel = vi.fn(async (): Promise<RpcResponse> => ok("set_model"));

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: {
			command,
			setModel,
			setModelRole: vi.fn(async (): Promise<RpcResponse> => ok("set_model_role")),
			getModelRoles: vi.fn(async (): Promise<RpcResponse> => ok("get_model_roles", { roles: [] })),
			getModelRoleMetadata: vi.fn(async (): Promise<RpcResponse> => ok("get_model_role_metadata", { roles: [] })),
		},
	},
});

const roots: Root[] = [];

async function mountMatrix(): Promise<void> {
	useSessionStore.setState({ status: "ready" });
	const root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ModelCompare onClose={() => {}} open />
			</I18nProvider>,
		);
	});
	roots.push(root);
}

function rowFor(modelId: string): HTMLElement | undefined {
	return Array.from(document.body.querySelectorAll("tr")).find(tr => (tr.textContent ?? "").includes(modelId)) as
		| HTMLElement
		| undefined;
}

function buttonOfRow(row: HTMLElement): HTMLButtonElement | undefined {
	return Array.from(row.querySelectorAll("button")).find(
		button => (button.textContent ?? "").trim() === translate("modelCompare.use"),
	) as HTMLButtonElement | undefined;
}

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	command.mockClear();
	setModel.mockClear();
});

describe("ModelCompare row availability", () => {
	it("keeps a newer pushed catalog when the opening read finishes late", async () => {
		command.mockImplementationOnce(async req => {
			useModelStore.getState().applyCatalogUpdate({
				type: "model_catalog_update",
				providers: [providerInfo("new")],
				models: [{ provider: "new", id: "new-model" }],
				discoveryStates: [],
				refreshPending: false,
				generation: 2,
			});
			return ok(req.type, {
				providers: [providerInfo("old")],
				models: [{ provider: "old", id: "old-model" }],
				discoveryStates: [],
				refreshPending: false,
				generation: 1,
			});
		});

		await mountMatrix();

		expect(rowFor("new-model")?.textContent).toContain("new-model");
		expect(rowFor("old-model")).toBeUndefined();
		expect(useModelStore.getState().providers.map(item => item.id)).toEqual(["new"]);
	});

	it("will not point the session at a provider that is off or signed out", async () => {
		await mountMatrix();

		for (const [modelId, reason] of [
			["noauth-model", "modelCompare.blockedNoAuth"],
			["off-model", "modelCompare.blockedDisabled"],
		] as const) {
			const row = rowFor(modelId);
			if (!row) throw new Error(`no row for ${modelId}`);
			expect(buttonOfRow(row)?.hasAttribute("disabled"), `${modelId} Use`).toBe(true);
			expect(row.getAttribute("title")).toBe(translate(reason));
			await act(async () => {
				row.click();
			});
		}

		expect(setModel).not.toHaveBeenCalled();
	});

	it("switches the session model when the row itself is clicked", async () => {
		await mountMatrix();
		const row = rowFor("serving-model");
		if (!row) throw new Error("no row for serving-model");

		await act(async () => {
			row.click();
		});

		expect(row.getAttribute("title")).toBe(translate("modelCompare.useHint"));
		expect(setModel).toHaveBeenCalledWith("serving", "serving-model");
	});

	it("keeps a row usable when the provider list simply did not describe it", async () => {
		await mountMatrix();
		const row = rowFor("unlisted-model");
		if (!row) throw new Error("no row for unlisted-model");

		expect(buttonOfRow(row)?.hasAttribute("disabled")).toBe(false);
		await act(async () => {
			row.click();
		});

		expect(setModel).toHaveBeenCalledWith("unlisted", "unlisted-model");
	});
});
