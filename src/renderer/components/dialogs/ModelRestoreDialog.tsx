import { useCallback, useEffect, useMemo, useRef } from "react";
import { confirmModelRestore } from "../../hooks/use-session-switch";
import { useT } from "../../lib/i18n";
import { useModelRestoreStore } from "../../stores/model-restore";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { BLOCKING_UI_METHODS } from "../../../shared/rpc-types";
import { useTranscriptFocusStore } from "../../stores/transcript-focus";
import { Button, Modal } from "../common";

/** The only recovery choice is the explicitly named CURRENT origin model. */
export function ModelRestoreDialog() {
	const t = useT();
	const prompt = useModelRestoreStore(state => state.prompt);
	const busy = useModelRestoreStore(state => state.busy);
	const close = useModelRestoreStore(state => state.close);
	const restoringInteraction = useModelRestoreStore(state => state.interactions.length > 0);
	const workingInteraction = useExtensionUiStore(state =>
		state.pendingRequests.some(request => BLOCKING_UI_METHODS[request.method]),
	);
	const focusNonce = useMemo(() => {
		const target = useTranscriptFocusStore.getState().target;
		return target?.sessionPath === prompt?.session.path ? target?.nonce ?? null : null;
	}, [prompt]);
	const continuingPrompt = useRef<typeof prompt>(null);
	const retireFocus = useCallback(() => {
		if (focusNonce !== null) useTranscriptFocusStore.getState().settle(focusNonce);
	}, [focusNonce]);
	const dismiss = useCallback(() => {
		retireFocus();
		close();
	}, [close, retireFocus]);
	useEffect(
		() => () => {
			if (continuingPrompt.current !== prompt) retireFocus();
		},
		[prompt, retireFocus],
	);
	const restore = async () => {
		continuingPrompt.current = prompt;
		let restored = false;
		try {
			restored = await confirmModelRestore();
		} finally {
			if (!restored) {
				retireFocus();
				if (continuingPrompt.current === prompt) continuingPrompt.current = null;
			}
		}
	};

	useEffect(() => {
		if (!prompt || busy) return;
		const dismissStale = () => {
			if (!prompt.isCurrent() && useModelRestoreStore.getState().prompt === prompt) dismiss();
		};
		dismissStale();
		return prompt.subscribeOrigin(dismissStale);
	}, [prompt, busy, dismiss]);

	return (
		<Modal
			bodyClassName="p-4"
			onClose={() => {
				if (!busy) dismiss();
			}}
			open={prompt !== null && !(busy && (restoringInteraction || workingInteraction))}
			size="sm"
			title={t("modelRestore.title")}
		>
			<div className="space-y-2 text-omp-md leading-relaxed break-words text-(--omp-muted)">
				<p>{t("modelRestore.message", { model: prompt?.missingModel ?? "" })}</p>
				<p className="text-omp-sm">
					{prompt?.currentLabel
						? t("modelRestore.offer", { model: prompt.currentLabel })
						: t("modelRestore.noCurrent")}
				</p>
			</div>
			<div className="mt-4 flex items-center justify-end gap-2">
				<Button autoFocus disabled={busy} onClick={dismiss} size="sm" variant="ghost">
					{t("common.cancel")}
				</Button>
				{prompt?.currentLabel ? (
					<Button disabled={busy} loading={busy} onClick={() => void restore()} size="sm">
						{t("modelRestore.openWith", { model: prompt.currentLabel })}
					</Button>
				) : null}
			</div>
		</Modal>
	);
}
