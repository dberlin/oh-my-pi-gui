import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RpcLiveState } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { acceptsActiveTabEvents } from "../../lib/tab-routing";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Modal, Spinner } from "../common";

const INITIAL_STATE: RpcLiveState = {
	active: false,
	phase: "connecting",
	muted: false,
	inputLevel: 0,
	outputLevel: 0,
};

export function LiveVoiceDialog() {
	const t = useT();
	const open = useUiStore(state => state.liveOpen);
	const closeStore = useUiStore(state => state.closeLive);
	const [state, setState] = useState<RpcLiveState>(INITIAL_STATE);
	const [starting, setStarting] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setState(INITIAL_STATE);
		const unsubscribe = window.omp.events.onLiveUpdate(frame => {
			if (!cancelled && acceptsActiveTabEvents()) setState(frame.state);
		});
		setStarting(true);
		void window.omp.rpc
			.getLiveState()
			.then(async response => {
				if (cancelled) return;
				if (!response.success) throw new Error(response.error);
				const current = response.data as RpcLiveState;
				setState(current);
				if (current.active) return;
				const started = await window.omp.rpc.liveStart();
				if (!started.success) throw new Error(started.error);
				if (!cancelled) setState(started.data as RpcLiveState);
			})
			.catch(cause => {
				if (!cancelled) setState(current => ({ ...current, active: false, phase: "error", error: String(cause) }));
			})
			.finally(() => {
				if (!cancelled) setStarting(false);
			});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [open]);

	const close = useCallback(async () => {
		closeStore();
		const response = await window.omp.rpc.liveStop();
		if (!response.success) toast({ variant: "error", message: response.error });
	}, [closeStore]);

	const toggleMute = async () => {
		const response = await window.omp.rpc.liveToggleMute();
		if (!response.success) {
			toast({ variant: "error", message: response.error });
			return;
		}
		setState(response.data as RpcLiveState);
	};

	const phaseLabel = t(`live.phase.${state.phase}`);
	return (
		<Modal onClose={() => void close()} open={open} size="md" title={t("live.title")}>
			<div className="space-y-4">
				<div className="flex items-center justify-center gap-2 py-2 text-sm font-medium text-(--omp-text)">
					{starting && !state.active ? <Spinner size="sm" /> : null}
					<span>{phaseLabel}</span>
				</div>
				<div className="space-y-3 rounded-lg border border-(--omp-border-muted) bg-transparent p-4">
					<Level label={t("live.input")} value={state.inputLevel} />
					<Level label={t("live.output")} value={state.outputLevel} />
				</div>
				<div className="min-h-24 rounded-lg border border-(--omp-border-muted) bg-transparent p-3 text-sm">
					{state.transcript ? (
						<>
							<div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-(--omp-dim)">
								{state.transcript.role === "user" ? t("live.you") : t("live.assistant")}
							</div>
							<div className="whitespace-pre-wrap text-(--omp-text)">{state.transcript.text}</div>
						</>
					) : (
						<div className="text-(--omp-dim)">{t("live.waiting")}</div>
					)}
				</div>
				{state.error ? <div className="text-sm text-(--omp-error)">{state.error}</div> : null}
				<div className="flex justify-end gap-2">
					<Button disabled={!state.active} onClick={() => void toggleMute()} variant="secondary">
						{state.muted ? <Mic size={14} /> : <MicOff size={14} />}
						{state.muted ? t("live.unmute") : t("live.mute")}
					</Button>
					<Button onClick={() => void close()} variant="danger">
						<PhoneOff size={14} /> {t("live.end")}
					</Button>
				</div>
			</div>
		</Modal>
	);
}

function Level({ label, value }: { label: string; value: number }) {
	const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
	return (
		<div className="grid grid-cols-[5rem_1fr_2.5rem] items-center gap-2 text-xs">
			<span className="text-(--omp-dim)">{label}</span>
			<div className="h-2 overflow-hidden rounded-full bg-(--omp-bg-primary)">
				<div className="h-full bg-(--omp-accent) transition-[width] duration-75" style={{ width: `${percent}%` }} />
			</div>
			<span className="text-right tabular-nums text-(--omp-dim)">{percent}%</span>
		</div>
	);
}
