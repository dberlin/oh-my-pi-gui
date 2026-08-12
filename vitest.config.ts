import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		dedupe: ["react", "react-dom"],
	},
	ssr: {
		resolve: {
			mainFields: ["module", "main"],
		},
	},
	test: {
		server: {
			deps: {
				inline: ["react", "react-dom", "zustand", /^@dnd-kit\//],
			},
		},
	},
});
