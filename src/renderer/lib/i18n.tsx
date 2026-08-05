import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { en } from "../locales/en";
import { zh } from "../locales/zh";

export type Locale = Record<string, string>;
export type Lang = "en" | "zh";

const LOCALES: Record<Lang, Locale> = { en, zh };
const LANG_KEY = "omp.lang";

function getInitialLang(): Lang {
	try {
		const stored = localStorage.getItem(LANG_KEY);
		if (stored === "zh" || stored === "en") return stored;
	} catch {
		/* ignore */
	}
	const nav = typeof navigator !== "undefined" ? (navigator.language ?? "en") : "en";
	return nav.startsWith("zh") ? "zh" : "en";
}

function translateForLang(lang: Lang, key: string, params?: Record<string, string | number>): string {
	const locale = LOCALES[lang];
	let str = locale[key] ?? en[key] ?? key;
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			str = str.replace(`{${k}}`, String(v));
		}
	}
	return str;
}

/**
 * Non-React translation for services/watchers (voice, notifications) that
 * cannot call the `useT` hook. Re-reads the persisted lang on every call so
 * runtime language switches apply without a subscription.
 */
export function translate(key: string, params?: Record<string, string | number>): string {
	return translateForLang(getInitialLang(), key, params);
}

interface I18nContextValue {
	lang: Lang;
	setLang: (lang: Lang) => void;
	t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
	const [lang, setLangState] = useState<Lang>(getInitialLang);

	const setLang = useCallback((next: Lang) => {
		setLangState(next);
		try {
			localStorage.setItem(LANG_KEY, next);
		} catch {
			/* ignore */
		}
	}, []);

	const t = useCallback(
		(key: string, params?: Record<string, string | number>): string => translateForLang(lang, key, params),
		[lang],
	);

	const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): (key: string, params?: Record<string, string | number>) => string {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useT must be used within I18nProvider");
	return ctx.t;
}

export function useLang(): { lang: Lang; setLang: (lang: Lang) => void } {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useLang must be used within I18nProvider");
	return { lang: ctx.lang, setLang: ctx.setLang };
}
