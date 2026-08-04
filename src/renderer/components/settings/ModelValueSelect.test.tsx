/**
 * Tests for the model/provider-referencing setting dropdown: path
 * classification (which string settings become dropdowns) and the
 * closed-state trigger contract (current value shown, unset placeholder,
 * listbox semantics). Open-state SSR assertions are not viable for the same
 * portal reason documented in SettingsWindow.test.tsx.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { ModelValueSelect, settingRefKind } from "./ModelValueSelect";

describe("settingRefKind", () => {
	it("classifies the string-typed model settings from the real schema", () => {
		expect(settingRefKind("providers.webSearchGeminiModel")).toBe("model");
		expect(settingRefKind("mnemopi.llmModel")).toBe("model");
		expect(settingRefKind("mnemopi.embeddingModel")).toBe("model");
	});

	it("matches a bare .model suffix", () => {
		expect(settingRefKind("services.image.model")).toBe("model");
	});

	it("classifies provider id settings", () => {
		expect(settingRefKind("services.searchProvider")).toBe("provider");
	});

	it("leaves unrelated strings and namespaces alone", () => {
		// Plain strings that merely live near models/providers.
		expect(settingRefKind("theme.dark")).toBeNull();
		expect(settingRefKind("stt.language")).toBeNull();
		expect(settingRefKind("searxng.endpoint")).toBeNull();
		expect(settingRefKind("hindsight.bankId")).toBeNull();
		// Plural/nested segments must not match (model.loopGuard.* is a namespace).
		expect(settingRefKind("images.describeForTextModels")).toBeNull();
		expect(settingRefKind("model.loopGuard.enabled")).toBeNull();
		expect(settingRefKind("providers.maxInFlightRequests")).toBeNull();
		// "modelName" ends in Name, not Model.
		expect(settingRefKind("stt.modelName")).toBeNull();
	});
});

describe("ModelValueSelect", () => {
	it("renders the current value on a listbox trigger, not a text input", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModelValueSelect kind="model" onCommit={() => {}} value="google/gemini-2.5-flash" />
			</I18nProvider>,
		);
		expect(html).toContain("google/gemini-2.5-flash");
		expect(html).toContain('aria-haspopup="listbox"');
		expect(html).not.toContain("<input");
	});

	it("renders an unset placeholder when the value is empty", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModelValueSelect kind="provider" onCommit={() => {}} value="" />
			</I18nProvider>,
		);
		expect(html).toContain("(unset)");
	});

	it("renders the dropdown closed without touching window.omp", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<ModelValueSelect kind="model" onCommit={() => {}} value="" />
			</I18nProvider>,
		);
		expect(html).not.toContain('role="listbox"');
	});
});
