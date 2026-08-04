/**
 * Toast store: push/dismiss with auto-expiry. Rendered by
 * components/common/Toast.tsx (ToastStack).
 */

import { create } from "zustand";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface Toast {
	id: number;
	variant: ToastVariant;
	title?: string;
	message: string;
	expiresAt: number;
}

export interface ToastInput {
	variant?: ToastVariant;
	title?: string;
	message: string;
	/** Auto-dismiss delay in ms (default 5000). */
	durationMs?: number;
}

interface ToastStore {
	toasts: Toast[];
	/** Push a toast; returns its id. */
	push: (toast: ToastInput) => number;
	dismiss: (id: number) => void;
	/** Drop every toast whose expiry has passed. */
	pruneExpired: () => void;
}

let nextId = 1;

export const useToastStore = create<ToastStore>()(set => ({
	toasts: [],
	push: toast => {
		const id = nextId++;
		const entry: Toast = {
			id,
			variant: toast.variant ?? "info",
			title: toast.title,
			message: toast.message,
			expiresAt: Date.now() + (toast.durationMs ?? 5000),
		};
		set(state => ({ toasts: [...state.toasts, entry].slice(-8) }));
		return id;
	},
	dismiss: id => set(state => ({ toasts: state.toasts.filter(toast => toast.id !== id) })),
	pruneExpired: () => {
		const now = Date.now();
		set(state => {
			const kept = state.toasts.filter(toast => toast.expiresAt > now);
			return kept.length === state.toasts.length ? state : { toasts: kept };
		});
	},
}));

/** Convenience helper for fire-and-forget call sites. */
export function toast(input: ToastInput): number {
	return useToastStore.getState().push(input);
}
