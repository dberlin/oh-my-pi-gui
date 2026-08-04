import { create } from "zustand";
import type { ExtensionUIRequest } from "../../shared/rpc-types";

interface ExtensionUiStore {
	pendingRequests: ExtensionUIRequest[];
	statusWidgets: Record<string, string>;
	widgetPanels: Record<string, string[]>;
	pushRequest: (request: ExtensionUIRequest) => void;
	removeRequest: (id: string) => void;
	setStatus: (key: string, text: string | undefined) => void;
	setWidget: (key: string, lines: string[] | undefined) => void;
	clearAll: () => void;
}

export const useExtensionUiStore = create<ExtensionUiStore>()((set, get) => ({
	pendingRequests: [],
	statusWidgets: {},
	widgetPanels: {},
	pushRequest: request => {
		if (request.method === "setStatus") {
			const next = { ...get().statusWidgets };
			if (request.statusText) {
				next[request.statusKey] = request.statusText;
			} else {
				delete next[request.statusKey];
			}
			set({ statusWidgets: next });
			return;
		}
		if (request.method === "setWidget") {
			const next = { ...get().widgetPanels };
			if (request.widgetLines && request.widgetLines.length > 0) {
				next[request.widgetKey] = request.widgetLines;
			} else {
				delete next[request.widgetKey];
			}
			set({ widgetPanels: next });
			return;
		}
		if (request.method === "cancel") {
			set({ pendingRequests: get().pendingRequests.filter(r => r.id !== request.targetId) });
			return;
		}
		set({ pendingRequests: [...get().pendingRequests, request] });
	},
	removeRequest: id => set({ pendingRequests: get().pendingRequests.filter(r => r.id !== id) }),
	setStatus: (key, text) => {
		const next = { ...get().statusWidgets };
		if (text) {
			next[key] = text;
		} else {
			delete next[key];
		}
		set({ statusWidgets: next });
	},
	setWidget: (key, lines) => {
		const next = { ...get().widgetPanels };
		if (lines && lines.length > 0) {
			next[key] = lines;
		} else {
			delete next[key];
		}
		set({ widgetPanels: next });
	},
	clearAll: () => set({ pendingRequests: [], statusWidgets: {}, widgetPanels: {} }),
}));
