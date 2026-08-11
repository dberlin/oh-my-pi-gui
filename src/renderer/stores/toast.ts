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
	count: number;
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
		const now = Date.now();
		const variant = toast.variant ?? "info";
		const expiresAt = now + (toast.durationMs ?? 5000);
		let resultId = 0;
		set(state => {
			const duplicateIndex = state.toasts.findIndex(
				entry =>
					entry.expiresAt > now &&
					entry.variant === variant &&
					entry.title === toast.title &&
					entry.message === toast.message,
			);
			if (duplicateIndex >= 0) {
				const duplicate = state.toasts[duplicateIndex];
				resultId = duplicate.id;
				const merged: Toast = { ...duplicate, count: duplicate.count + 1, expiresAt };
				return {
					toasts: [...state.toasts.slice(0, duplicateIndex), ...state.toasts.slice(duplicateIndex + 1), merged],
				};
			}
			const entry: Toast = {
				id: nextId++,
				variant,
				title: toast.title,
				message: toast.message,
				expiresAt,
				count: 1,
			};
			resultId = entry.id;
			return { toasts: [...state.toasts, entry].slice(-8) };
		});
		return resultId;
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
