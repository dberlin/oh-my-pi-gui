import { describe, expect, test } from "vitest";
import { defaultProviderDiscovery, providerRequiresManualModels } from "./ProviderConfigDialog";

describe("custom provider discovery defaults", () => {
	test("enables upstream model lists for OpenAI and Anthropic Messages protocols", () => {
		expect(defaultProviderDiscovery("openai-completions")).toBe("openai-models-list");
		expect(defaultProviderDiscovery("openai-responses")).toBe("openai-models-list");
		expect(defaultProviderDiscovery("anthropic-messages")).toBe("openai-models-list");
		expect(defaultProviderDiscovery("google-generative-ai")).toBeUndefined();
	});

	test("allows a discovery-only provider without a hand-written model row", () => {
		expect(providerRequiresManualModels("openai-models-list")).toBe(false);
		expect(providerRequiresManualModels(undefined)).toBe(true);
	});
});
