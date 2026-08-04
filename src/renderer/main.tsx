import { createRoot } from "react-dom/client";
import { App } from "./App";
import { I18nProvider } from "./lib/i18n";
import "./styles/global.css";
import "./styles/theme-dark.css";
import "./styles/theme-light.css";
import "./styles/components.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("Root container #root not found");
}

createRoot(container).render(
	<I18nProvider>
		<App />
	</I18nProvider>,
);
