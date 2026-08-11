import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CustomProviderView } from "../../../shared/ipc-types";
import type { ProviderInfo } from "../../../shared/rpc-types";
import { ProviderRow, resolveProviderEditAction } from "./ProvidersWindow";

function provider(id: string, loginAvailable: boolean, authenticated = true): ProviderInfo {
	return {
		id,
		name: id,
		authenticated,
		loginAvailable,
		disabled: false,
		modelCount: 0,
	};
}

function config(id: string, builtin = false): CustomProviderView {
	return {
		id,
		api: "openai-completions",
		baseUrl: `https://${id}.example/v1`,
		hasApiKey: true,
		models: [],
		builtin,
	};
}

const t = (key: string) => key;

describe("resolveProviderEditAction", () => {
	it("updates credentials for registered Tavily and built-in DeepSeek providers", () => {
		expect(resolveProviderEditAction(provider("tavily", true), [])).toEqual({ kind: "login" });
		expect(resolveProviderEditAction(provider("deepseek", true), [config("deepseek", true)])).toEqual({
			kind: "login",
		});
	});

	it("opens the exact editable models.yml entry for a custom model provider", () => {
		const custom = config("infronai");
		expect(resolveProviderEditAction(provider("infronai", false), [custom])).toEqual({
			kind: "config",
			provider: custom,
		});
	});

	it("does not invent an editor when neither a custom config nor credential flow exists", () => {
		expect(resolveProviderEditAction(provider("catalog-only", false), [])).toBeNull();
	});
});

describe("ProviderRow", () => {
	const noop = () => {};

	it("shows a login button for an unauthenticated provider with a login flow", () => {
		const html = renderToStaticMarkup(
			<ProviderRow
				busy={false}
				customConfigs={[]}
				onEdit={noop}
				onLogin={noop}
				onLogout={noop}
				provider={provider("tavily", true, false)}
				t={t}
			/>,
		);
		expect(html).toContain("providers.login");
		expect(html).not.toContain("providers.edit");
	});

	it("shows credential editing for an authenticated provider with a login flow", () => {
		const html = renderToStaticMarkup(
			<ProviderRow
				busy={false}
				customConfigs={[]}
				onEdit={noop}
				onLogin={noop}
				onLogout={noop}
				provider={provider("tavily", true)}
				t={t}
			/>,
		);
		expect(html).toContain("providers.updateCredentials");
		expect(html).not.toContain(">providers.login<");
	});

	it("shows an edit button for a custom provider config and no login button for an authenticated provider", () => {
		const custom = config("infronai");
		const html = renderToStaticMarkup(
			<ProviderRow
				busy={false}
				customConfigs={[custom]}
				onEdit={noop}
				onLogin={noop}
				onLogout={noop}
				provider={provider("infronai", false)}
				t={t}
			/>,
		);
		expect(html).toContain("providers.edit");
		expect(html).not.toContain("providers.login");
	});

	it("renders neither edit nor login for a provider with no config and no login flow", () => {
		const html = renderToStaticMarkup(
			<ProviderRow
				busy={false}
				customConfigs={[]}
				onEdit={noop}
				onLogin={noop}
				onLogout={noop}
				provider={provider("catalog-only", false, false)}
				t={t}
			/>,
		);
		expect(html).not.toContain("providers.edit");
		expect(html).not.toContain("providers.login");
	});
});
