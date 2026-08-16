import { parseHTML } from "linkedom";
import { act, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { I18nProvider, type Lang, useLang } from "../../lib/i18n";
import { StructuredDataView } from "./StructuredDataView";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const storedValues = new Map<string, string>();
const localStorage = {
	getItem: (key: string) => storedValues.get(key) ?? null,
	setItem: (key: string, value: string) => storedValues.set(key, value),
	removeItem: (key: string) => storedValues.delete(key),
	clear: () => storedValues.clear(),
};
const installedGlobals = {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	localStorage,
	IS_REACT_ACT_ENVIRONMENT: true,
};
const priorGlobals = new Map<string, PropertyDescriptor | undefined>();
const mounts: Array<{ container: HTMLElement; root: Root }> = [];

beforeAll(() => {
	for (const [key, value] of Object.entries(installedGlobals)) {
		priorGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
});

afterAll(() => {
	for (const [key, descriptor] of priorGlobals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function SetLanguage({ lang }: { lang: Lang }) {
	const { setLang } = useLang();
	useEffect(() => setLang(lang), [lang, setLang]);
	return null;
}

async function mount(node: ReactNode, lang: Lang = "en"): Promise<HTMLElement> {
	const container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	const root = createRoot(container as unknown as Element);
	mounts.push({ container, root });
	await act(async () => {
		root.render(
			<I18nProvider>
				<SetLanguage lang={lang} />
				{node}
			</I18nProvider>,
		);
	});
	return container;
}

function disclosureFor(container: HTMLElement, key: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button[aria-expanded]")).find(candidate =>
		candidate.textContent?.includes(key),
	);
	if (!button) throw new Error(`Disclosure for ${key} did not render`);
	return button as unknown as HTMLButtonElement;
}

async function click(button: HTMLButtonElement): Promise<void> {
	await act(async () => {
		button.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
}

function marker(container: HTMLElement, kind: "cycle" | "depth-limit" | "omitted" | "budget"): HTMLElement {
	const element = container.querySelector(`[data-structured-marker="${kind}"]`) as HTMLElement | null;
	if (!element) throw new Error(`${kind} marker did not render`);
	return element;
}

function expectLocalizedText(element: HTMLElement): string {
	const text = element.textContent?.trim() ?? "";
	expect(text).not.toBe("");
	expect(text).not.toMatch(/^tools\./);
	return text;
}

afterEach(async () => {
	for (const mounted of mounts.splice(0).reverse()) {
		await act(async () => mounted.root.unmount());
		mounted.container.remove();
	}
	storedValues.clear();
});

describe("StructuredDataView", () => {
	it("shows object keys and scalar values", async () => {
		const container = await mount(
			<StructuredDataView value={{ title: "STRUCTURED_TITLE", enabled: true, attempts: 7, empty: null }} />,
		);

		const text = container.textContent ?? "";
		expect(text).toContain("title");
		expect(text).toContain("STRUCTURED_TITLE");
		expect(text).toContain("enabled");
		expect(text).toContain("true");
		expect(text).toContain("attempts");
		expect(text).toContain("7");
		expect(text).toContain("empty");
		expect(text).toContain("null");
	});

	it("uses nested object disclosure buttons with interactive aria-expanded state", async () => {
		const container = await mount(
			<StructuredDataView
				defaultExpandedDepth={1}
				value={{ objectNode: { innerObject: { objectLeaf: "OBJECT_LEAF_VALUE" } } }}
			/>,
		);
		const objectButton = disclosureFor(container, "objectNode");

		expect(objectButton.tagName).toBe("BUTTON");
		expect(objectButton.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("OBJECT_LEAF_VALUE");

		await click(objectButton);
		expect(objectButton.getAttribute("aria-expanded")).toBe("true");
		const innerButton = disclosureFor(container, "innerObject");
		expect(innerButton.getAttribute("aria-expanded")).toBe("false");
		expect(objectButton.querySelector("button")).toBeNull();

		await click(innerButton);
		expect(innerButton.getAttribute("aria-expanded")).toBe("true");
		expect(container.textContent).toContain("OBJECT_LEAF_VALUE");
	});

	it("uses array disclosure buttons with interactive aria-expanded state", async () => {
		const container = await mount(
			<StructuredDataView defaultExpandedDepth={1} value={{ arrayNode: ["ARRAY_LEAF_VALUE"] }} />,
		);
		const arrayButton = disclosureFor(container, "arrayNode");

		expect(arrayButton.tagName).toBe("BUTTON");
		expect(arrayButton.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("ARRAY_LEAF_VALUE");

		await click(arrayButton);
		expect(arrayButton.getAttribute("aria-expanded")).toBe("true");
		expect(container.textContent).toContain("ARRAY_LEAF_VALUE");

		await click(arrayButton);
		expect(arrayButton.getAttribute("aria-expanded")).toBe("false");
		expect(container.textContent).not.toContain("ARRAY_LEAF_VALUE");
	});

	it("marks string, boolean, number, and null scalars with distinct semantic value types", async () => {
		const container = await mount(
			<StructuredDataView value={{ stringValue: "typed", booleanValue: false, numberValue: 42, nullValue: null }} />,
		);

		expect(container.querySelector('[data-value-type="string"]')?.textContent).toContain("typed");
		expect(container.querySelector('[data-value-type="boolean"]')?.textContent).toContain("false");
		expect(container.querySelector('[data-value-type="number"]')?.textContent).toContain("42");
		expect(container.querySelector('[data-value-type="null"]')?.textContent).toContain("null");
		expect(container.querySelectorAll("[data-value-type]")).toHaveLength(4);
	});

	it("stops at configured depth six with a localized bound marker and no deeper content", async () => {
		const value = {
			depth1: {
				depth2: {
					depth3: {
						depth4: {
							depth5: {
								depth6: { depth7: "CONTENT_BEYOND_MAX_DEPTH" },
							},
						},
					},
				},
			},
		};
		const container = await mount(<StructuredDataView defaultExpandedDepth={10} maxDepth={6} value={value} />, "zh");

		const bounded = marker(container, "depth-limit");
		const text = expectLocalizedText(bounded);
		expect(text).toMatch(/[\u3400-\u9fff]/u);
		expect(container.textContent).toContain("depth6");
		expect(container.textContent).not.toContain("depth7");
		expect(container.textContent).not.toContain("CONTENT_BEYOND_MAX_DEPTH");
	});

	it("shows only the first configured 100 children and a localized omitted count", async () => {
		const value = Object.fromEntries(
			Array.from({ length: 101 }, (_, index) => [`child-${String(index).padStart(3, "0")}`, index]),
		);
		const container = await mount(
			<StructuredDataView defaultExpandedDepth={1} maxChildren={100} value={value} />,
			"zh",
		);

		expect(container.querySelectorAll('[data-value-type="number"]')).toHaveLength(100);
		expect(container.textContent).toContain("child-000");
		expect(container.textContent).toContain("child-099");
		expect(container.textContent).not.toContain("child-100");
		const omitted = marker(container, "omitted");
		const text = expectLocalizedText(omitted);
		expect(text).toContain("1");
		expect(text).toMatch(/[\u3400-\u9fff]/u);
	});

	it("bounds a broad initially expanded tree globally while preserving a complete small sibling", async () => {
		const broad = Object.fromEntries(
			Array.from({ length: 8 }, (_, branch) => [
				`branch-${branch}`,
				Object.fromEntries(
					Array.from({ length: 8 }, (_, group) => [
						`group-${branch}-${group}`,
						Object.fromEntries(
							Array.from({ length: 8 }, (_, leaf) => [
								`leaf-${branch}-${group}-${leaf}`,
								`BROAD_LEAF_${branch}_${group}_${leaf}`,
							]),
						),
					]),
				),
			]),
		);
		const maxNodes = 64;
		const container = await mount(
			<StructuredDataView
				defaultExpandedDepth={10}
				maxDepth={6}
				maxChildren={9}
				maxNodes={maxNodes}
				value={{
					broad,
					smallSibling: {
						first: "SMALL_SIBLING_FIRST",
						second: "SMALL_SIBLING_SECOND",
					},
				}}
			/>,
			"zh",
		);

		const visibleStructuredNodes = container.querySelectorAll(
			'button[aria-expanded], [data-value-type], [data-structured-marker="budget"]',
		);
		expect(visibleStructuredNodes.length).toBeLessThanOrEqual(maxNodes);
		expect(container.textContent).toContain("BROAD_LEAF_0_0_0");
		expect(container.textContent).not.toContain("BROAD_LEAF_7_7_7");
		expect(disclosureFor(container, "smallSibling").getAttribute("aria-expanded")).toBe("true");
		expect(container.textContent).toContain("SMALL_SIBLING_FIRST");
		expect(container.textContent).toContain("SMALL_SIBLING_SECOND");
		expect(container.querySelectorAll('[data-structured-marker="budget"]')).toHaveLength(1);
		expect(container.querySelector('[data-structured-marker="omitted"]')).toBeNull();
		const text = expectLocalizedText(marker(container, "budget"));
		expect(text).toMatch(/[\u3400-\u9fff]/u);
	});

	it("renders cyclic objects with a finite cycle marker", async () => {
		const value: Record<string, unknown> = { label: "CYCLIC_ROOT" };
		value.self = value;

		const container = await mount(<StructuredDataView defaultExpandedDepth={10} maxDepth={6} value={value} />);

		expect(container.textContent).toContain("CYCLIC_ROOT");
		expectLocalizedText(marker(container, "cycle"));
		expect(container.querySelectorAll("*").length).toBeLessThan(100);
	});
});
